/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import {
  messageContentDigest,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import { createSessionStore, type SessionAuthorityStore } from '@maka/storage/session-store';
import { OPERATIONAL_STATE_DATABASE_NAME } from '@maka/storage/operational-state-store';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import type { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import type { WorkHubTaskStartInput } from '../protocol/workhub-task-actions.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  SessionOperationFailure,
  WorkHubDefaultModelRequiredError,
} from '../server/session-catalog-coordinator.js';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  workHubCreatedSessionId,
  type WorkHubActionGateEffects,
} from '../server/workhub-coordination-action-gate.js';
import {
  HostWorkHubCoordinationCoordinator,
  type CoordinationCreateTarget,
  type HostWorkHubCoordinationCoordinatorOptions,
} from '../server/workhub-coordination-coordinator.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-test-epoch',
  connectionId: 'workhub-test-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('task-centric start and selection', () => {
  for (const mode of ['native', 'lost_authority', 'executor'] as const)
    test(`fresh uses the canonical task source and current authority directly (${mode})`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-task-fresh-')));
      const store = createSessionStore(root);
      try {
        let active = true;
        const authority = {
          runId: 'model-run',
          content: { text: '继续，保留刚才的纠正。' },
          origin: 'user' as const,
          sourceMessageId: 'fresh-user-message',
        };
        const worker = await store.create({
          cwd: root,
          name: 'Container name is not the task title',
          model: 'original-model',
          llmConnectionSlug: 'original-connection',
          permissionMode: 'ask',
          ...(mode === 'executor' ? { executorId: 'test-executor' } : {}),
        });
        const assigned: Parameters<WorkHubActionGateEffects['assign']>[0][] = [];
        const host = coordinator(
          root,
          store,
          undefined,
          undefined,
          {
            ...coordinationExecutions(new SessionAdmissionGate()).executions,
            readActiveWorkHubRoutingRequest: async () => (active ? authority : undefined),
          },
          undefined,
          {
            assign: async (input) => {
              if (mode === 'lost_authority') active = false;
              await input.validateFreshTarget?.();
              assigned.push(input);
              return { messageId: 'fresh-message' };
            },
          },
        );
        assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
        await persistTestAssignment(
          store,
          {
            actionId: 'original-task',
            work: { id: 'original-task', generationId: 'original-task' },
            actionFingerprint: `sha256:${'a'.repeat(64)}`,
            taskTitle: 'The actual task',
            targetSessionId: worker.id,
            targetSessionName: worker.name,
            disposition: 'delegate_existing',
            userText: 'Original user request',
          },
          'original-turn',
        );
        const before = await store.readHeaderSnapshot(worker.id);
        const continuation = host.continueTaskFresh(
          {
            turnId: 'model-turn',
            actionId: 'next-segment',
            taskId: 'original-task',
            text: 'Prepared worker input',
            container: 'fresh',
          },
          CONTEXT,
        );
        if (mode === 'native') {
          const result = await continuation;
          assert.equal(result.workId, 'original-task');
          assert.equal(result.targetSessionId, workHubCreatedSessionId('next-segment'));
          assert.equal(assigned.length, 1);
          assert.equal(assigned[0]!.taskTitle, 'The actual task');
          assert.equal(assigned[0]!.userText, authority.content.text);
          assert.equal(assigned[0]!.delegationText, 'Prepared worker input');
          assert.equal(assigned[0]!.freshSource?.assignment.targetSessionId, worker.id);
          assert.deepEqual(assigned[0]!.work, {
            id: 'original-task',
            generationId: 'next-segment',
            continuesActionId: 'original-task',
            sourceMessageId: 'fresh-user-message',
          });
        } else {
          await assert.rejects(continuation, (error: unknown) =>
            mode === 'executor'
              ? error instanceof WorkHubActionEffectFailure &&
                error.code === 'operation_unavailable' &&
                error.message.includes('no Host history-tool bridge')
              : error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
          );
          assert.equal(assigned.length, 0);
          assert.equal(await store.readWorkHubAssignment('next-segment'), undefined);
        }
        assert.deepEqual(await store.readHeaderSnapshot(worker.id), before);
      } finally {
        await store.close?.();
        await rm(root, { recursive: true, force: true });
      }
    });

  test('start separates task title and real user authority from the worker prompt and effective creation settings', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-task-start-')));
    const store = createSessionStore(root);
    try {
      const assigned: Parameters<WorkHubActionGateEffects['assign']>[0][] = [];
      const authority = {
        runId: 'root-run',
        content: { text: '用户原话和纠正' },
        origin: 'user' as const,
        sourceMessageId: 'root-message',
      };
      const host = coordinator(
        root,
        store,
        undefined,
        undefined,
        {
          ...coordinationExecutions(new SessionAdmissionGate()).executions,
          readActiveWorkHubRoutingRequest: async () => authority,
        },
        undefined,
        {
          assign: async (input) => {
            await input.validateFreshTarget?.();
            assigned.push(input);
            return { messageId: 'message' };
          },
        },
      );
      const defaults = {
        model: {
          llmConnectionId: 'selected',
          llmConnectionSlug: 'selected',
          model: 'selected-model',
        },
        permissionMode: 'ask' as const,
        thinkingLevel: 'high' as const,
      };
      const title = '完整任务标题'.repeat(20);
      const result = await host.handlers['workhub.tasks.start'](
        {
          turnId: 'root-turn',
          actionId: 'independent',
          title,
          text: 'Only the prepared worker prompt',
          create: { workspace: { kind: 'isolated' } },
          newWorkDefaults: defaults,
        },
        CONTEXT,
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(assigned.length, 1);
      const action = assigned[0]!;
      assert.equal(action.taskTitle, title);
      assert.equal(Array.from(action.create!.title).length, 64);
      assert.equal(action.userText, authority.content.text);
      assert.equal(action.delegationText, 'Only the prepared worker prompt');
      assert.equal(action.inputOrigin, 'user');
      assert.deepEqual(action.work, {
        id: 'independent',
        generationId: 'independent',
        sourceMessageId: 'root-message',
      });
      assert.deepEqual(action.create?.defaults, defaults);
      assert.deepEqual(action.create?.workspace, {
        kind: 'host_path',
        path: join(root, 'workhub-tasks', workHubCreatedSessionId('independent')),
      });
      assert.equal(
        action.taskInput,
        undefined,
        'new work is not steering or a replayed correction',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const lostAuthority of [false, true])
    test(
      'manual start outside recent candidates preserves configuration and validates its Root (lost=' +
        lostAuthority +
        ')',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'maka-task-manual-'));
        const store = createSessionStore(root);
        try {
          let active = true;
          const authority = {
            runId: 'active-root',
            content: { text: '接入这个已有会话，不改配置' },
            origin: 'feedback' as const,
          };
          const old = await store.create({
            cwd: root,
            name: 'Old manual name',
            model: 'manual-model',
            llmConnectionSlug: 'manual-connection',
            permissionMode: 'ask',
          });
          for (let index = 0; index < 40; index++)
            await store.create({
              cwd: root,
              name: 'Recent ' + index,
              model: 'other-model',
              llmConnectionSlug: 'other',
              permissionMode: 'bypass',
            });
          const actions: Parameters<WorkHubActionGateEffects['assign']>[0][] = [];
          const host = coordinator(
            root,
            store,
            undefined,
            undefined,
            {
              ...coordinationExecutions(new SessionAdmissionGate()).executions,
              readActiveWorkHubRoutingRequest: async () => (active ? authority : undefined),
            },
            undefined,
            {
              assign: async (input) => {
                if (lostAuthority) active = false;
                await input.validateFreshTarget?.();
                actions.push(input);
                return persistTestAssignment(store, input, 'target-turn');
              },
            },
          );
          assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
          const before = await store.readHeaderSnapshot(old.id);
          assert.equal((await store.listHeaders()).length, 42);
          const result = await host.handlers['workhub.tasks.start'](
            {
              turnId: 'root',
              actionId: 'manual-task',
              title: 'Independent title',
              text: 'Worker content',
              sessionRef: old.id,
            },
            CONTEXT,
          );
          assert.equal(result.ok, !lostAuthority, JSON.stringify(result));
          assert.deepEqual(
            await store.readHeaderSnapshot(old.id),
            before,
            'no persistent settings or permission rewrites',
          );
          assert.equal(actions.length, lostAuthority ? 0 : 1);
          if (!lostAuthority) {
            const fact = await store.readWorkHubAssignment('manual-task');
            assert.ok(fact);
            assert.equal(fact.taskTitle, 'Independent title');
            assert.equal(
              actions[0]!.inputOrigin,
              'feedback',
              'historical feedback is not promoted to user authority',
            );
            assert.equal(fact.work?.id, 'manual-task');
            assert.equal(fact.work?.continuesActionId, undefined);
            assert.equal(actions[0]!.create, undefined);
          } else {
            assert.equal(await store.readWorkHubAssignment('manual-task'), undefined);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

  for (const scenario of [
    'task',
    'session',
    'new',
    'cancel',
    'generation',
    'workspace',
    'run',
    'invalid',
    'outside',
    'claim',
    'observation',
    'unrelated',
  ] as const)
    test(
      'selection only returns an offered target or explicit new choice (' + scenario + ')',
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'maka-task-ask-'));
        const store = createSessionStore(root);
        try {
          let runId = 'root-run';
          const authority = () => ({
            runId,
            content: { text: '继续那个' },
            origin: 'user' as const,
          });
          const executions = {
            ...coordinationExecutions(new SessionAdmissionGate()).executions,
            readActiveWorkHubRoutingRequest: async () => authority(),
          };
          const manual = await store.create({
            cwd: root,
            name: 'A'.repeat(300),
            model: 'manual-model',
            llmConnectionSlug: 'test',
            permissionMode: 'ask',
          });
          let forms = 0,
            assignments = 0;
          const options: Pick<
            HostWorkHubCoordinationCoordinatorOptions,
            'requestForm' | 'readWorkContext'
          > = {
            requestForm: async (input) => {
              const form = await input.create();
              forms++;
              assert.equal(form.kind, 'form');
              const field = form.fields[0]!;
              assert.equal(field.kind, 'single_select');
              if (field.kind !== 'single_select') assert.fail('Expected selection');
              assert.equal(field.options.at(-1)!.value, 'new_task');
              assert.equal(
                new Set(field.options.map((option) => option.label)).size,
                field.options.length,
              );
              assert.ok(
                field.options.every((option) => Buffer.byteLength(option.label, 'utf8') <= 256),
              );
              let value =
                field.options[scenario === 'session' || scenario === 'workspace' ? 1 : 0]!.value;
              if (scenario === 'new') value = 'new_task';
              if (scenario === 'invalid') value = 'bad-json';
              if (scenario === 'outside') value = JSON.stringify(['task', 'not-offered', 'source']);
              if (scenario === 'generation')
                // Deliberately pause after an offered option, then advance
                // the canonical generation through an actual atomic create.
                await persistTestAssignment(
                  store,
                  {
                    actionId: 'next',
                    work: { id: 'source', generationId: 'next', continuesActionId: 'source' },
                    actionFingerprint: `sha256:${'8'.repeat(64)}`,
                    targetSessionId: 'next-session',
                    targetSessionName: 'Next',
                    disposition: 'create_new',
                    userText: 'Next generation',
                    create: { title: 'Next', workspace: { kind: 'host_path', path: root } },
                  },
                  'next-turn',
                  {
                    sessionId: 'next-session',
                    requestFingerprint: `sha256:${'8'.repeat(64)}`,
                    input: {
                      cwd: root,
                      name: 'Next',
                      model: 'manual-model',
                      llmConnectionSlug: 'test',
                      permissionMode: 'ask',
                    },
                  },
                );
              if (scenario === 'workspace')
                await store.updateHeader(manual.id, { cwd: join(root, 'moved') });
              if (scenario === 'run') runId = 'different-root';
              if (scenario === 'unrelated')
                await persistTestAssignment(
                  store,
                  {
                    actionId: 'independent-b',
                    actionFingerprint: `sha256:${'5'.repeat(64)}`,
                    targetSessionId: manual.id,
                    targetSessionName: manual.name,
                    disposition: 'delegate_existing',
                    userText: 'Unrelated B',
                  },
                  'b-turn',
                );
              return {
                createdAt: Date.now(),
                answer:
                  scenario === 'cancel'
                    ? { action: 'cancel' }
                    : { action: 'accept', values: { target: value } },
              };
            },
            readWorkContext:
              scenario === 'observation'
                ? async () => {
                    runId = 'changed-during-observation';
                    return {
                      currentModelId: 'manual-model',
                      currentConnectionId: null,
                      currentConnectionSlug: 'test',
                      configuredInputLimit: null,
                      lastRequest: { status: 'unknown', reason: 'not_observed' },
                    };
                  }
                : undefined,
          };
          const makeHost = () =>
            coordinator(
              root,
              store,
              undefined,
              undefined,
              executions,
              undefined,
              {
                assign: async () => {
                  assignments++;
                  return { messageId: 'should-not-be-sent' };
                },
              },
              options,
            );
          const host = makeHost();
          assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
          await persistTestAssignment(
            store,
            {
              actionId: 'source',
              actionFingerprint: `sha256:${'7'.repeat(64)}`,
              targetSessionId: manual.id,
              targetSessionName: manual.name,
              disposition: 'delegate_existing',
              userText: 'Initial',
              taskTitle: 'Task title independent of Session',
            },
            'source-turn',
          );
          if (scenario === 'claim')
            await store.claimWorkHubAction({
              actionId: 'select',
              operation: 'create_new',
              subject: manual.id,
              actionFingerprint: `sha256:${'6'.repeat(64)}`,
            });
          const input = {
            turnId: 'root-turn',
            actionId: 'select',
            question: '继续哪个？',
            choices: [
              { kind: 'task' as const, id: 'source' },
              { kind: 'session' as const, id: manual.id },
            ],
          };
          const result = await host.handlers['workhub.tasks.ask'](input, CONTEXT);
          assert.equal(assignments, 0, 'selection never delegates');
          assert.equal(await store.readWorkHubAssignment('select'), undefined);
          if (scenario === 'new' || scenario === 'cancel') {
            assert.deepEqual(result, {
              ok: true,
              result: { kind: scenario === 'new' ? 'new_task' : 'cancelled' },
            });
          } else if (scenario === 'task' || scenario === 'session' || scenario === 'unrelated') {
            assert.deepEqual(result, {
              ok: true,
              result: {
                kind: 'selected',
                target: input.choices[scenario === 'session' ? 1 : 0],
                ...(scenario === 'session' ? {} : { generationId: 'source' }),
              },
            });
          } else {
            assert.equal(result.ok, false, JSON.stringify(result));
            if (!result.ok)
              assert.equal(result.error.code, 'operation_conflict', JSON.stringify(result));
          }
          assert.equal(forms, scenario === 'claim' ? 0 : 1);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    );

  test('selection reuses the durable Form answer after coordinator reconstruction without rebuilding the offer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-task-selection-replay-'));
    const store = createSessionStore(root);
    try {
      const manual = await store.create({
        cwd: root,
        name: 'Manual',
        model: 'model',
        llmConnectionSlug: 'test',
        permissionMode: 'ask',
      });
      const executions = {
        ...coordinationExecutions(new SessionAdmissionGate()).executions,
        readActiveWorkHubRoutingRequest: async () => ({
          runId: 'run',
          content: { text: 'Choose' },
          origin: 'user' as const,
        }),
      };
      let value: string | undefined,
        requestId: string | undefined,
        offers = 0;
      const makeHost = () =>
        coordinator(root, store, undefined, undefined, executions, undefined, undefined, {
          requestForm: async (input) => {
            if (!value) {
              const form = await input.create();
              offers++;
              const field = form.fields[0]!;
              assert.equal(field.kind, 'single_select');
              if (field.kind !== 'single_select') assert.fail('Expected selection');
              value = field.options[0]!.value;
              requestId = input.requestId;
            } else assert.equal(input.requestId, requestId);
            return {
              createdAt: Date.now(),
              answer: { action: 'accept', values: { target: value } },
            };
          },
        });
      const input = {
        turnId: 'turn',
        actionId: 'selection',
        question: 'Which?',
        choices: [{ kind: 'session' as const, id: manual.id }],
      };
      const host = makeHost();
      assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
      const result = await host.handlers['workhub.tasks.ask'](input, CONTEXT);
      assert.ok(result.ok);
      assert.deepEqual(await makeHost().handlers['workhub.tasks.ask'](input, CONTEXT), result);
      assert.equal(offers, 1);
      const conflict = await makeHost().handlers['workhub.tasks.ask'](
        { ...input, question: 'Changed?' },
        CONTEXT,
      );
      assert.equal(conflict.ok, false);
      assert.equal(offers, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Host WorkHub Coordination coordinator', () => {
  test('binds native A/B/A input to the immutable task across restart and unrelated activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-objectives-'));
    let store = createSessionStore(root);
    const makeHost = () =>
      coordinator(root, store, undefined, undefined, undefined, undefined, {
        assign: persistTestAssignmentAction(store, (input) => 'turn-' + input.actionId),
      });
    try {
      let host = makeHost();
      assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
      const createTarget = () =>
        store.create({
          cwd: root,
          name: 'Same folder',
          llmConnectionSlug: 'test',
          model: 'worker-model',
          permissionMode: 'ask',
        });
      const old = await createTarget(),
        a = await createTarget(),
        b = await createTarget();
      for (const [actionId, sessionRef, userText] of [
        ['historical-a', old.id, 'Old task: inspect the skill file'],
        ['current-a', a.id, 'Current task: inspect the skill file'],
        ['unrelated-b', b.id, 'A completely unrelated question'],
      ]) {
        const result = await host.start(
          {
            actionId: actionId!,
            sessionRef: sessionRef!,
            title: 'Independent task',
            text: userText!,
            userText: userText!,
          },
          CONTEXT,
        );
        assert.ok(result.ok, JSON.stringify(result));
      }
      const original = await store.readWorkHubAssignment('current-a');
      assert.ok(original);
      for (let index = 0; index < 40; index++) await createTarget();
      const input = {
        inputId: 'current-input',
        text: 'Read the complete skill file now',
        workId: 'current-a',
        generationId: 'current-a',
        sourceActionId: original.actionId,
        sourceDelegationId: original.delegationId,
      };
      const continuation = () =>
        host.continueTaskInput(input, CONTEXT, {
          validateTaskInput: async () => {},
        });
      const result = await continuation();
      assert.equal(result.targetSessionId, a.id);
      assert.ok('workId' in result);
      assert.equal(result.workId, 'current-a');
      const followupId =
        'whtinput_' + createHash('sha256').update(input.inputId).digest('hex').slice(0, 48);
      assert.deepEqual((await store.readWorkHubAssignment(followupId))?.work, {
        id: 'current-a',
        generationId: 'current-a',
        continuesActionId: 'current-a',
      });
      assert.equal((await store.readWorkHubAssignment('unrelated-b'))?.work?.id, 'unrelated-b');
      await assert.rejects(
        host.continueTaskInput({ ...input, inputId: 'mismatch', workId: 'unrelated-b' }, CONTEXT),
        /selected work source changed/,
      );
      assert.equal(
        await store.readWorkHubAssignment(
          'whtinput_' + createHash('sha256').update('mismatch').digest('hex').slice(0, 48),
        ),
        undefined,
      );
      const before = await store.readHeaderSnapshot(a.id);
      assert.equal(before.model, 'worker-model');
      assert.equal(before.permissionMode, 'ask');
      assert.equal(before.cwd, root);
      await store.updateHeader(a.id, { cwd: join(root, 'moved-workspace') });
      assert.deepEqual(await continuation(), result);
      await store.close?.();
      store = createSessionStore(root);
      host = makeHost();
      assert.deepEqual(await continuation(), result);
      const assignments = (
        await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)
      ).filter(
        (message) =>
          message.type === 'workhub_coordination' && message.kind === 'delegation_assigned',
      );
      assert.equal(
        assignments.length,
        4,
        'a replay never adds a task or reactivates old same-topic work',
      );
      assert.equal((await store.readWorkHubAssignment('historical-a'))?.targetSessionId, old.id);
      assert.equal((await store.readWorkHubAssignment('current-a'))?.targetSessionId, a.id);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('isolated task creation rejects substituted directory roots before any assignment effect', async () => {
    for (const replaceRoot of [true, false]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-workhub-isolated-')));
      const store = createSessionStore(root);
      let assignments = 0;
      const host = coordinator(
        root,
        store,
        undefined,
        undefined,
        {
          readActiveWorkHubRoutingRequest: async () => ({
            origin: 'user',
            content: { text: 'Research an independent goal' },
            runId: 'active-run',
          }),
          startWorkHubCoordinationMessage: async () => ({
            ok: false,
            error: { code: 'operation_unavailable', message: 'Unused' },
          }),
          isSessionExecutionIdle: () => true,
        },
        undefined,
        {
          assign: async () => {
            assignments++;
            return { turnId: 'unused' };
          },
        },
      );
      try {
        assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
        const taskRoot = join(root, 'workhub-tasks');
        const outside = join(root, 'substituted-target');
        await mkdir(outside);
        if (!replaceRoot) await mkdir(taskRoot);
        await symlink(
          outside,
          replaceRoot ? taskRoot : join(taskRoot, workHubCreatedSessionId('isolated-action')),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
        const result = await host.handlers['workhub.tasks.start'](
          {
            turnId: 'active-turn',
            actionId: 'isolated-action',
            title: 'Research',
            text: 'Research an independent goal',
            create: { workspace: { kind: 'isolated' } },
            newWorkDefaults: {
              model: { llmConnectionId: 'test', llmConnectionSlug: 'test', model: 'test' },
              permissionMode: 'ask',
            },
          },
          CONTEXT,
        );
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.code, 'operation_conflict');
        assert.equal(assignments, 0);
        assert.deepEqual(
          await readdir(outside),
          [],
          'no child directory is created through the substituted root',
        );
      } finally {
        store.close?.();
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('native start uses only the active Turn user text and attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-active-authority-'));
    const store = createSessionStore(root);
    try {
      const admission = new SessionAdmissionGate();
      const { executions } = coordinationExecutions(admission);
      let canonical: MessageContent = {
        text: 'Continue Payments',
        attachments: [
          {
            kind: 'other',
            name: 'requirements.txt',
            mimeType: 'text/plain',
            bytes: 12,
            ref: {
              kind: 'session_file',
              sessionId: WORKHUB_COORDINATION_SESSION_ID,
              relativePath: 'source-file',
            },
          },
        ],
      };
      const assignments: Parameters<WorkHubActionGateEffects['assign']>[0][] = [];
      const workhub = coordinator(
        root,
        store,
        undefined,
        undefined,
        {
          ...executions,
          readActiveWorkHubRoutingRequest: async (turnId) =>
            turnId === 'active-turn'
              ? { content: canonical, runId: 'active-run', origin: 'user' }
              : undefined,
        },
        admission,
        {
          assign: async (input) => {
            assignments.push(input);
            return { turnId: 'delegated-turn' };
          },
        },
      );
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test',
        model: 'test',
        permissionMode: 'ask',
      });
      const input = {
        turnId: 'active-turn',
        actionId: 'model-delegate-call',
        title: 'Payment retry task',
        text: 'Fix payment retries',
        sessionRef: target.id,
      };
      const stale = await workhub.handlers['workhub.tasks.start'](
        { ...input, turnId: 'old-turn' },
        CONTEXT,
      );
      assert.equal(stale.ok, false);
      assert.equal(assignments.length, 0);
      assert.equal((await workhub.handlers['workhub.tasks.start'](input, CONTEXT)).ok, true);
      assert.equal(assignments[0]?.userText, canonical.text);
      assert.equal(assignments[0]?.delegationText, input.text);
      assert.deepEqual(assignments[0]?.attachments, canonical.attachments);

      canonical = {
        text: '请新建一个任务，名称为「发布检查」，让它不要调用工具，只回复三条发布前检查事项。',
      };
      const created = await workhub.handlers['workhub.tasks.start'](
        {
          turnId: 'active-turn',
          actionId: 'model-create-call',
          text: '不要调用工具，只回复三条发布前检查事项。',
          title: '发布检查',
          create: { workspace: { kind: 'host_path', path: root } },
          newWorkDefaults: {
            model: { llmConnectionId: 'test', llmConnectionSlug: 'test', model: 'test' },
            permissionMode: 'ask',
          },
        },
        CONTEXT,
      );
      assert.equal(created.ok, true, JSON.stringify(created));
      assert.equal(assignments.at(-1)?.userText, canonical.text);
      assert.equal(assignments.at(-1)?.delegationText, '不要调用工具，只回复三条发布前检查事项。');
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('concurrently creates once and reuses the durable Session after Host restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-resolve-'));
    let store = createSessionStore(root);
    try {
      const firstCoordinator = coordinator(root, store);
      const outcomes = await Promise.all(
        Array.from({ length: 16 }, () =>
          firstCoordinator.handlers['workhub.coordination.resolve']({}, CONTEXT),
        ),
      );
      assert.equal(
        outcomes.every((outcome) => outcome.ok),
        true,
      );
      assert.deepEqual(
        new Set(outcomes.flatMap((outcome) => (outcome.ok ? [outcome.result.sessionId] : []))),
        new Set([WORKHUB_COORDINATION_SESSION_ID]),
      );
      const header = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(header.role, WORKHUB_COORDINATION_SESSION_ROLE);
      assert.equal(header.toolProfile, 'workhub-coordination-v2');
      assert.equal(header.projectId, null);
      assert.equal(header.cwd, join(root, 'workhub-coordination'));
      assert.equal((await store.listHeaders()).length, 1);
      await assert.rejects(store.readCatalogRecord(WORKHUB_COORDINATION_SESSION_ID));
      const queried = await firstCoordinator.handlers['workhub.coordination.query']({}, CONTEXT);
      assert.equal(queried.ok, true, JSON.stringify(queried));
      if (queried.ok) {
        assert.equal(queried.result.id, header.id);
        assert.ok('model' in queried.result);
        assert.equal(queried.result.model, header.model);
        assert.equal(
          queried.result.revision,
          (await store.readHeaderRecordSnapshot(header.id)).revision,
        );
      }
    } finally {
      await store.close?.();
    }

    const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
    try {
      database
        .prepare(
          `UPDATE session_metadata
           SET payload_json = json_set(
             json_remove(payload_json, '$.toolProfile'),
             '$.permissionMode', 'ask',
             '$.collaborationMode', 'plan',
             '$.orchestrationMode', 'graph'
           )
           WHERE session_id = ?`,
        )
        .run(WORKHUB_COORDINATION_SESSION_ID);
    } finally {
      database.close();
    }

    store = createSessionStore(root);
    try {
      const restarted = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );
      assert.deepEqual(restarted, {
        ok: true,
        result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
      });
      assert.equal(
        (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).toolProfile,
        'workhub-coordination-v2',
      );
      const migrated = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(migrated.permissionMode, 'bypass');
      assert.equal(migrated.collaborationMode, 'agent');
      assert.equal(migrated.orchestrationMode, 'default');
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('upgrades an idle v1 Session but preserves an executing or recovering v1 ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-profile-upgrade-'));
    const store = createSessionStore(root);
    try {
      const admission = new SessionAdmissionGate();
      const { executions } = coordinationExecutions(admission);
      let idle = false;
      const workhub = coordinator(
        root,
        store,
        undefined,
        undefined,
        {
          ...executions,
          isSessionExecutionIdle: () => idle,
        },
        admission,
      );
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      await store.setExecutionBoundaryKind(WORKHUB_COORDINATION_SESSION_ID, 'managed', {
        permissionMode: 'explore',
      });
      const record = await store.readHeaderRecordSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      await store.updateHeaderVersioned(
        WORKHUB_COORDINATION_SESSION_ID,
        {
          toolProfile: 'workhub-coordination-v1',
          permissionMode: 'explore',
        },
        record.revision,
      );
      const legacy = await store.readHeaderRecordSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      assert.deepEqual(
        await store.readHeaderRecordSnapshot(WORKHUB_COORDINATION_SESSION_ID),
        legacy,
      );
      idle = true;
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      const upgraded = await store.readHeaderRecordSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(upgraded.header.toolProfile, 'workhub-coordination-v2');
      assert.equal(upgraded.header.permissionMode, 'bypass');
      assert.ok(upgraded.revision > legacy.revision);
      assert.equal(
        (await store.readExecutionBoundary(WORKHUB_COORDINATION_SESSION_ID)).kind,
        'bypass',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed on reserved-id collision without changing ordinary Sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-collision-'));
    const store = createSessionStore(root);
    try {
      await store.createStableSession({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        requestFingerprint: `sha256:${'c'.repeat(64)}`,
        input: {
          cwd: root,
          projectId: null,
          name: 'Ordinary collision',
          llmConnectionSlug: 'test-connection',
          model: 'test-model',
          permissionMode: 'ask',
          role: WORKHUB_COORDINATION_SESSION_ROLE,
        },
      });
      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_remove(payload_json, '$.role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      const outcome = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );

      assert.deepEqual(outcome, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub Coordination Session identity is unavailable',
        },
      });
      assert.deepEqual(await store.list(), []);
      const collision = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(collision.name, 'Ordinary collision');
      assert.equal(collision.role, undefined);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('reports corrupt durable state without replacing or losing ordinary Sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-corrupt-'));
    const store = createSessionStore(root);
    let drains = 0;
    try {
      const ordinary = await store.create({
        cwd: root,
        name: 'Keep me',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const initial = await coordinator(root, store).handlers['workhub.coordination.resolve'](
        {},
        CONTEXT,
      );
      assert.equal(initial.ok, true);

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_set(payload_json, '$.role', 'corrupt_role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      const outcome = await coordinator(root, store, () => {
        drains += 1;
      }).handlers['workhub.coordination.resolve']({}, CONTEXT);

      assert.deepEqual(outcome, {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub Coordination Session state is unavailable',
        },
      });
      assert.equal(drains, 1);
      assert.equal((await store.readHeaderSnapshot(ordinary.id)).name, 'Keep me');
      assert.deepEqual(
        (await store.list()).map((session) => session.id),
        [ordinary.id],
      );
      assert.deepEqual(
        (await store.listForRecovery()).map((session) => session.id),
        [ordinary.id],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('fails closed and quarantines a Coordination Session whose role is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-missing-role-'));
    const store = createSessionStore(root);
    try {
      const ordinary = await store.create({
        cwd: root,
        name: 'Keep me',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );

      const database = new DatabaseSync(join(root, OPERATIONAL_STATE_DATABASE_NAME));
      try {
        database
          .prepare(
            `UPDATE session_metadata
             SET payload_json = json_remove(payload_json, '$.role')
             WHERE session_id = ?`,
          )
          .run(WORKHUB_COORDINATION_SESSION_ID);
      } finally {
        database.close();
      }

      assert.deepEqual(
        await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'WorkHub Coordination Session identity is unavailable',
          },
        },
      );
      assert.deepEqual(
        (await store.list()).map((session) => session.id),
        [ordinary.id],
      );
      assert.deepEqual(
        (await store.listForRecovery()).map((session) => session.id),
        [ordinary.id],
      );
      assert.equal(
        (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).name,
        'WorkHub',
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('relocates the durable workspace when the Host state root moves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-relocate-'));
    const movedRoot = await mkdtemp(join(tmpdir(), 'maka-workhub-relocated-'));
    const store = createSessionStore(root);
    try {
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );

      // Same durable Session, same database, new absolute state-root path:
      // restoring the state directory elsewhere must not strand the identity
      // that no ordinary lifecycle operation is allowed to relocate.
      assert.deepEqual(
        await coordinator(movedRoot, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        { ok: true, result: { sessionId: WORKHUB_COORDINATION_SESSION_ID } },
      );
      const header = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(header.cwd, join(movedRoot, 'workhub-coordination'));
      assert.equal(header.role, WORKHUB_COORDINATION_SESSION_ROLE);
      assert.equal((await store.listHeaders()).length, 1);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
      await rm(movedRoot, { recursive: true, force: true });
    }
  });

  test('restores a Coordination workspace that was pruned after provisioning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-workspace-'));
    const store = createSessionStore(root);
    try {
      assert.equal(
        (await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT)).ok,
        true,
      );
      const coordinationCwd = join(root, 'workhub-coordination');
      await rm(coordinationCwd, { recursive: true, force: true });

      assert.deepEqual(
        await coordinator(root, store).handlers['workhub.coordination.resolve']({}, CONTEXT),
        { ok: true, result: { sessionId: WORKHUB_COORDINATION_SESSION_ID } },
      );
      assert.equal((await stat(coordinationCwd)).isDirectory(), true);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('separates an unreadable model authority from a missing default model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-model-authority-'));
    const store = createSessionStore(root);
    try {
      assert.deepEqual(
        await coordinator(
          root,
          store,
          () => undefined,
          async () => {
            throw new SessionOperationFailure(
              'persistence_failed',
              'Runtime policy is unavailable',
            );
          },
        ).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: { code: 'persistence_failed', message: 'Runtime policy is unavailable' },
        },
      );
      assert.deepEqual(
        await coordinator(
          root,
          store,
          () => undefined,
          async () => {
            throw new WorkHubDefaultModelRequiredError('No default Session model is configured');
          },
        ).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: {
            code: 'model_required',
            message: 'WorkHub Coordination Session requires an available default model',
          },
        },
      );
      assert.deepEqual(
        await coordinator(
          root,
          store,
          () => undefined,
          async () => {
            throw new SessionOperationFailure('operation_conflict', 'Concurrent target change');
          },
        ).handlers['workhub.coordination.resolve']({}, CONTEXT),
        {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'WorkHub Coordination Session target is unavailable',
          },
        },
      );
      assert.deepEqual(await store.listHeaders(), []);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('answers through the dedicated Coordination root without creating an ordinary Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-answer-'));
    const store = createSessionStore(root);
    const admission = new SessionAdmissionGate();
    const { executions, starts, prepared } = coordinationExecutions(admission);
    try {
      const workhub = coordinator(root, store, () => undefined, undefined, executions, admission);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);
      assert.deepEqual(
        await workhub.handlers['workhub.coordination.answer'](
          { turnId: 'answer-turn', text: 'What should we do next?' },
          CONTEXT,
        ),
        { ok: true, result: { turnId: 'answer-turn' } },
      );
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.sessionId, WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(starts[0]?.execution.kind, 'workhub_coordination');
      assert.deepEqual(prepared, [{ text: 'What should we do next?' }]);
      assert.deepEqual(
        (await store.listHeaders()).map(({ id, role }) => ({ id, role })),
        [{ id: WORKHUB_COORDINATION_SESSION_ID, role: WORKHUB_COORDINATION_SESSION_ROLE }],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('persists native start ownership and replays after SQLite reopen without another admission', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-delegation-'));
    let store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const input = {
        actionId: 'payments-action',
        userText: 'Continue payment work. '.repeat(900),
        title: 'Payment task',
        text: 'Prepared payment input',
        sessionRef: target.id,
      };
      const makeHost = () =>
        coordinator(root, store, undefined, undefined, undefined, undefined, {
          assign: persistTestAssignmentAction(store, 'payments-turn'),
        });
      const host = makeHost();
      assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
      const admitted = await host.start(input, CONTEXT);
      assert.deepEqual(admitted, {
        ok: true,
        result: {
          disposition: 'delegate_existing',
          targetSessionId: target.id,
          targetTurnId: 'payments-turn',
          workId: 'payments-action',
        },
      });
      const durable = await store.readWorkHubAssignment(input.actionId);
      assert.ok(durable);
      assert.equal(durable.taskTitle, input.title);
      assert.equal(durable.userText, input.userText);
      assert.equal(durable.delegationText, input.text);
      await store.updateHeader(target.id, { cwd: join(root, 'moved') });
      assert.deepEqual(await host.start(input, CONTEXT), admitted);
      await store.close?.();
      store = createSessionStore(root);
      const replay = makeHost();
      assert.deepEqual(await replay.start(input, CONTEXT), admitted);
      assert.deepEqual(await store.readWorkHubAssignment(input.actionId), durable);
      const records = (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).filter(
        (message) =>
          message.type === 'workhub_coordination' && message.kind === 'delegation_assigned',
      );
      assert.equal(records.length, 1);
      const conflict = await replay.start({ ...input, title: 'Changed title' }, CONTEXT);
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, 'operation_conflict');
      assert.deepEqual(await store.readWorkHubAssignment(input.actionId), durable);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('native start preserves unauthorized failures for the client and does not write an assignment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-unauthorized-'));
    const store = createSessionStore(root);
    try {
      const target = await store.create({
        cwd: root,
        name: 'Payments',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'ask',
      });
      const host = coordinator(root, store, undefined, undefined, undefined, undefined, {
        assign: async () => {
          throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
        },
      });
      assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
      assert.deepEqual(
        await host.start(
          {
            actionId: 'permission-rejected',
            title: 'Payment task',
            text: 'Prepared input',
            userText: 'Continue payments',
            sessionRef: target.id,
          },
          CONTEXT,
        ),
        {
          ok: false,
          error: { code: 'unauthorized', message: 'Target permission denied' },
        },
      );
      assert.equal(await store.readWorkHubAssignment('permission-rejected'), undefined);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('coordinator exposes only native task start/ask and original root query/answer/configuration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-native-handlers-'));
    const store = createSessionStore(root);
    try {
      assert.deepEqual(Object.keys(coordinator(root, store).handlers).sort(), [
        'workhub.coordination.answer',
        'workhub.coordination.configureModel',
        'workhub.coordination.query',
        'workhub.coordination.resolve',
        'workhub.tasks.ask',
        'workhub.tasks.start',
      ]);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('preserves historical summary identities when admitting a fresh answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-workhub-turn-identity-'));
    const store = createSessionStore(root);
    const admission = new SessionAdmissionGate();
    const { executions } = coordinationExecutions(admission);
    try {
      const workhub = coordinator(root, store, () => undefined, undefined, executions, admission);
      assert.equal((await workhub.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok, true);

      // Seed the old on-disk summary format; its writer no longer exists.
      await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
        {
          type: 'user',
          id: legacySummaryId('user'),
          turnId: 'recorded-turn',
          ts: 1,
          text: 'Continue payments',
        },
        {
          type: 'assistant',
          id: legacySummaryId('assistant'),
          turnId: 'recorded-turn',
          ts: 2,
          text: 'Sent to Payments',
          modelId: 'maka-workhub-coordination',
        },
        {
          type: 'turn_state',
          id: legacySummaryId('state'),
          turnId: 'recorded-turn',
          ts: 3,
          status: 'completed',
        },
      ]);
      function legacySummaryId(kind: string) {
        return (
          'workhub_' +
          createHash('sha256')
            .update('recorded-turn\0' + kind, 'utf8')
            .digest('hex')
            .slice(0, 48)
        );
      }
      const answerAfterRecord = await workhub.handlers['workhub.coordination.answer'](
        { turnId: 'recorded-turn', text: 'What is left on payments?' },
        CONTEXT,
      );
      assert.deepEqual(answerAfterRecord, {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub Coordination Turn identity belongs to a different operation',
        },
      });
      assert.deepEqual(
        (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).map(
          ({ type, turnId }) => ({ type, turnId }),
        ),
        [
          { type: 'user', turnId: 'recorded-turn' },
          { type: 'assistant', turnId: 'recorded-turn' },
          { type: 'turn_state', turnId: 'recorded-turn' },
        ],
      );
      assert.deepEqual(
        (await store.listTurnsSnapshot(WORKHUB_COORDINATION_SESSION_ID)).map(
          ({ turnId }) => turnId,
        ),
        ['recorded-turn'],
      );
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

type CoordinationExecutions = Pick<
  RootTurnCoordinator,
  'startWorkHubCoordinationMessage' | 'isSessionExecutionIdle' | 'readActiveWorkHubRoutingRequest'
>;
type WithoutTurn<T> = T extends unknown ? Omit<T, 'turnId'> : never;

for (const scenario of [
  'modern',
  'legacy-delivered',
  'legacy-terminal',
  'old-upgraded-noop',
  'unresolved-first',
  'scope-unowned',
  'legacy-unowned',
] as const)
  test(`task Stop fact writer requires coordinator and target leases and survives SQLite reopen (${scenario})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-task-stop-facts-'));
    let store = createSessionStore(root);
    const admission = new SessionAdmissionGate();
    try {
      const host = coordinator(
        root,
        store,
        undefined,
        undefined,
        undefined,
        admission,
        {},
        {
          readStopBinding: async () => 'exact-binding',
        },
      );
      assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
      const worker = await store.create({
        cwd: root,
        name: 'Task',
        model: 'model',
        llmConnectionSlug: 'test',
        permissionMode: 'ask',
      });
      const source: WorkHubDelegationAssignedMessage = {
        type: 'workhub_coordination',
        kind: 'delegation_assigned',
        schemaVersion: 4,
        id: 'wha_' + createHash('sha256').update('source-task').digest('hex').slice(0, 48),
        turnId: 'source-turn',
        ts: 1,
        coordinationTurnId: 'source-turn',
        actionId: 'source-task',
        actionFingerprint: `sha256:${'a'.repeat(64)}`,
        delegationId: 'delegation-task',
        disposition: 'delegate_existing',
        targetSessionId: worker.id,
        targetSessionName: 'Task',
        targetMessageId: 'message-task',
        targetTurnId: 'worker-turn',
        userText: 'Original requirement',
        work: { id: 'source-task', generationId: 'source-task' },
      };
      await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [source]);
      const target = {
        workId: 'source-task',
        generationId: 'source-task',
        sourceActionId: source.actionId,
        sourceDelegationId: source.delegationId,
        targetSessionId: worker.id,
        targetMessageId: source.targetMessageId,
        executionBinding: 'exact-binding',
      };
      const input = {
        source,
        target,
        actionId: 'stop-action',
        actionFingerprint: `sha256:${'b'.repeat(64)}` as const,
        coordinationTurnId: 'stop-turn',
        userText: 'Stop it',
        replay: false,
        stopSet: { actionId: 'stop-action', targets: [target] },
      };
      await store.claimWorkHubAction({
        actionId: input.actionId,
        operation: 'stop',
        actionFingerprint: input.actionFingerprint,
        subject: source.delegationId,
      });
      for (const ids of [[WORKHUB_COORDINATION_SESSION_ID], [worker.id]]) {
        await assert.rejects(admission.runMany(ids, (lease) => host.prepareTaskStop(input, lease)));
        assert.equal(
          await store.readWorkHubStopRequest(source.delegationId, input.actionId),
          undefined,
        );
      }
      const otherGate = new SessionAdmissionGate();
      await assert.rejects(
        otherGate.runMany([WORKHUB_COORDINATION_SESSION_ID, worker.id], (lease) =>
          host.prepareTaskStop(input, lease),
        ),
      );
      const prepare = () =>
        admission.runMany([WORKHUB_COORDINATION_SESSION_ID, worker.id], (lease) =>
          host.prepareTaskStop(input, lease),
        );
      if (scenario === 'unresolved-first') {
        const prior = {
          ...input,
          actionId: 'pending-stop',
          actionFingerprint: `sha256:${'d'.repeat(64)}` as const,
          stopSet: { actionId: 'pending-stop', targets: [target] },
        };
        await store.claimWorkHubAction({
          actionId: prior.actionId,
          operation: 'stop',
          actionFingerprint: prior.actionFingerprint,
          subject: source.delegationId,
        });
        await admission.runMany([WORKHUB_COORDINATION_SESSION_ID, worker.id], (lease) =>
          host.prepareTaskStop(prior, lease),
        );
      }
      const request = await prepare();
      assert.deepEqual(await prepare(), request);
      const resolved = await host.resolveTaskStop({
        request,
        outcome: 'already_terminal',
        targetTurnId: 'worker-turn',
      });
      assert.equal(
        (await store.readWorkHubStopResolution(source.delegationId))?.actionId,
        input.actionId,
        'the first modern no-op is readable without becoming a retirement aggregate',
      );
      if (scenario === 'old-upgraded-noop') {
        // Compatibility fixture for an older writer's immutable aggregate slot.
        await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
          {
            ...resolved,
            id:
              'whzt_' + createHash('sha256').update(source.delegationId).digest('hex').slice(0, 48),
          },
        ]);
      }
      await store.close?.();
      store = createSessionStore(root);
      assert.deepEqual(
        await store.readWorkHubStopRequest(source.delegationId, input.actionId),
        request,
      );
      assert.deepEqual(
        await store.readWorkHubStopResolution(source.delegationId, input.actionId),
        resolved,
      );
      const history = await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      const replay = history.find((message) => message.id === request.id);
      assert.deepEqual(
        replay,
        request,
        'native transcript round trip retains the new stop scope fields',
      );
      // This fixture writes coordination facts, not a worker Message admission.
      // Active-link projection with real pending admissions is covered in storage.
      const successor = coordinator(
        root,
        store,
        undefined,
        undefined,
        undefined,
        admission,
        {},
        {
          readStopBinding: async () => 'resumed-binding',
        },
      );
      const laterTarget = { ...target, executionBinding: 'resumed-binding' };
      const later = {
        ...input,
        target: laterTarget,
        actionId: 'stop-resumed',
        actionFingerprint: `sha256:${'c'.repeat(64)}` as const,
        stopSet: { actionId: 'stop-resumed', targets: [laterTarget] },
      };
      await store.claimWorkHubAction({
        actionId: later.actionId,
        operation: 'stop',
        actionFingerprint: later.actionFingerprint,
        subject: source.delegationId,
      });
      let laterRequest: typeof request;
      if (scenario.startsWith('legacy')) {
        const { taskStop: _marker, stopSet: _set, ...legacy } = request;
        laterRequest = {
          ...legacy,
          actionId: later.actionId,
          actionFingerprint: later.actionFingerprint,
          id:
            'whq_' +
            createHash('sha256')
              .update(JSON.stringify([source.delegationId, later.actionId]))
              .digest('hex')
              .slice(0, 48),
          executionBinding: laterTarget.executionBinding,
        };
        await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [laterRequest]);
      } else
        laterRequest = await admission.runMany(
          [WORKHUB_COORDINATION_SESSION_ID, worker.id],
          (lease) => successor.prepareTaskStop(later, lease),
        );
      const outcome = scenario === 'legacy-terminal' ? 'already_terminal' : 'stop_delivered';
      if (scenario === 'scope-unowned' || scenario === 'legacy-unowned') {
        const unowned = await successor.resolveTaskStop({
          request: laterRequest,
          outcome: 'not_owned',
        });
        assert.equal(
          unowned.targetTurnId,
          undefined,
          'do not invent a Turn for a scope that never owned one',
        );
        assert.equal(unowned.taskStop, true);
        await store.close?.();
        store = createSessionStore(root);
        assert.deepEqual(
          await store.readWorkHubStopResolution(source.delegationId, later.actionId),
          unowned,
        );
        return;
      }
      await successor.resolveTaskStop({
        request: laterRequest,
        outcome,
        targetTurnId: 'resumed-worker-turn',
      });
      await store.close?.();
      store = createSessionStore(root);
      assert.equal(
        (await store.readWorkHubStopResolution(source.delegationId))?.actionId,
        later.actionId,
        'the earlier modern no-op cannot mask actual retirement of a later owned Root',
      );
      assert.deepEqual(
        await store.readWorkHubStopResolution(source.delegationId, input.actionId),
        resolved,
        'the original per-action no-op receipt remains immutable',
      );
      assert.equal((await store.readWorkHubStopResolution(source.delegationId))?.outcome, outcome);
    } finally {
      await store.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

function coordinationExecutions(admission: SessionAdmissionGate) {
  const admitted = new Set<string>();
  const starts: Parameters<RootTurnCoordinator['startWorkHubCoordinationMessage']>[0][] = [];
  const prepared: MessageContent[] = [];
  const executions: CoordinationExecutions = {
    readActiveWorkHubRoutingRequest: async () => undefined,
    startWorkHubCoordinationMessage: async (request) => {
      starts.push(request);
      return admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
        const content = await request.prepareFreshContent(lease);
        if (content.kind === 'rejected') return content.outcome;
        prepared.push(content.content);
        admitted.add(request.turnId);
        return {
          ok: true,
          result: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            runId: `workhub-run-${request.turnId}`,
            status: 'running',
          },
        };
      });
    },
    isSessionExecutionIdle: () => true,
  };
  return { executions, starts, prepared };
}

function coordinator(
  root: string,
  store: SessionAuthorityStore,
  requestDrain: () => void = () => undefined,
  resolveCreateTarget: (() => Promise<CoordinationCreateTarget>) | undefined = undefined,
  executions: CoordinationExecutions = {
    readActiveWorkHubRoutingRequest: async () => undefined,
    startWorkHubCoordinationMessage: async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'WorkHub test execution is not configured',
      },
    }),
    isSessionExecutionIdle: () => true,
  },
  admission: SessionAdmissionGate = new SessionAdmissionGate(),
  sessionActions: Partial<HostWorkHubCoordinationCoordinatorOptions['sessionActions']> = {},
  options: Pick<
    HostWorkHubCoordinationCoordinatorOptions,
    'requestForm' | 'readStopBinding' | 'isStopBindingCurrent' | 'readWorkContext'
  > = {},
) {
  const assign =
    sessionActions.assign ??
    (async ({ targetSessionId }: Parameters<WorkHubActionGateEffects['assign']>[0]) => ({
      turnId: `turn-${targetSessionId}`,
    }));
  const activeRequests = new Map<string, MessageContent>();
  const host = new HostWorkHubCoordinationCoordinator({
    transitionConfiguration: async (input) =>
      store.updateSessionConfiguration(WORKHUB_COORDINATION_SESSION_ID, {
        expectedVersion: input.expectedRevision,
        configuration: {
          ...input.configuration,
          llmConnectionId: input.configuration.llmConnectionId!,
          labels: (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).labels,
        },
        lifecycle: { kind: 'preserve' },
      }),
    configureModel: async () => ({
      ok: false,
      error: {
        code: 'operation_unavailable',
        message: 'Not configured in this fixture',
      },
    }),
    stateRoot: root,
    stores: store,
    admission,
    continuity: { refreshCanonical: async () => undefined },
    executions: {
      ...executions,
      readActiveWorkHubRoutingRequest: async (turnId) => {
        const content = activeRequests.get(turnId);
        return content
          ? { content, runId: 'active-run', origin: 'user' }
          : executions.readActiveWorkHubRoutingRequest(turnId);
      },
    },
    sessionActions: { assign },
    resolveCreateTarget:
      resolveCreateTarget ??
      (async () => ({
        llmConnectionId: 'test-connection-id',
        llmConnectionSlug: 'test-connection',
        model: 'test-model',
        permissionMode: 'explore',
        collaborationMode: 'agent',
        orchestrationMode: 'default',
      })),
    requestDrain,
    ...options,
  });
  return {
    handlers: host.handlers,
    continueTaskFresh: host.continueTaskFresh.bind(host),
    continueTaskInput: host.continueTaskInput.bind(host),
    prepareTaskStop: host.prepareTaskStop.bind(host),
    resolveTaskStop: host.resolveTaskStop.bind(host),
    async start(
      input: WithoutTurn<WorkHubTaskStartInput> & {
        readonly turnId?: string;
        readonly userText: string;
        readonly attachments?: MessageContent['attachments'];
      },
      context: ConnectionContext,
    ) {
      const turnId =
        input.turnId ??
        'fixture_' + createHash('sha256').update(input.actionId).digest('hex').slice(0, 48);
      const { userText, attachments } = input;
      activeRequests.set(turnId, { text: userText, ...(attachments ? { attachments } : {}) });
      try {
        const base = { turnId, actionId: input.actionId, title: input.title, text: input.text };
        return await host.handlers['workhub.tasks.start'](
          input.sessionRef === undefined
            ? { ...base, create: input.create, newWorkDefaults: input.newWorkDefaults }
            : { ...base, sessionRef: input.sessionRef },
          context,
        );
      } finally {
        activeRequests.delete(turnId);
      }
    },
  };
}

async function persistTestAssignment(
  store: SessionAuthorityStore,
  input: Parameters<WorkHubActionGateEffects['assign']>[0],
  targetTurnId: string,
  create?: Parameters<SessionAuthorityStore['assignWorkHubMessage']>[0]['create'],
): Promise<{ readonly turnId: string }> {
  const suffix = createHash('sha256').update(input.actionId, 'utf8').digest('hex').slice(0, 48);
  const content = normalizeMessageContent({ text: input.delegationText ?? input.userText });
  const coordinationTurnId = input.coordinationTurnId ?? input.actionId;
  const result = await store.assignWorkHubMessage({
    ...(create ? { create } : {}),
    assignment: {
      type: 'workhub_coordination',
      id: `wha_${suffix}`,
      turnId: coordinationTurnId,
      ts: Date.now(),
      schemaVersion: input.work ? 4 : 1,
      kind: 'delegation_assigned',
      actionId: input.actionId,
      ...(input.work ? { work: input.work } : {}),
      ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle }),
      actionFingerprint: input.actionFingerprint,
      coordinationTurnId,
      targetSessionId: input.targetSessionId,
      targetSessionName: input.targetSessionName,
      targetTurnId,
      targetMessageId: `whm_${suffix}`,
      delegationId: `whd_${suffix}`,
      disposition: input.disposition,
      userText: input.userText,
      ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
      ...(input.create ? { create: input.create } : {}),
    },
    admission: {
      sessionId: input.targetSessionId,
      turnId: targetTurnId,
      runId: `whr_${suffix}`,
      messageId: `whm_${suffix}`,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn',
      placement: 'current_turn',
      disposition: 'steering',
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: Date.now(),
    },
  });
  return { turnId: result.assignment.targetTurnId };
}

function persistTestAssignmentAction(
  store: SessionAuthorityStore,
  targetTurnId: string | ((input: Parameters<WorkHubActionGateEffects['assign']>[0]) => string),
): HostWorkHubCoordinationCoordinatorOptions['sessionActions']['assign'] {
  return async (input) => {
    await input.validateFreshTarget?.();
    const result = await persistTestAssignment(
      store,
      input,
      typeof targetTurnId === 'string' ? targetTurnId : targetTurnId(input),
    );
    return { turnId: result.turnId };
  };
}

for (const scenario of ['complete', 'crash', 'not_owned'] as const)
  test(
    'concurrent native Stop receipts retain exact per-action evidence (' + scenario + ')',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-concurrent-stop-'));
      const store = createSessionStore(root);
      try {
        const worker = await store.create({
          cwd: root,
          name: 'Payments',
          llmConnectionSlug: 'test',
          model: 'test',
          permissionMode: 'ask',
        });
        const admission = new SessionAdmissionGate();
        const host = coordinator(
          root,
          store,
          undefined,
          undefined,
          undefined,
          admission,
          {
            assign: persistTestAssignmentAction(store, 'source-turn'),
          },
          { readStopBinding: async () => 'exact-binding' },
        );
        assert.ok((await host.handlers['workhub.coordination.resolve']({}, CONTEXT)).ok);
        assert.ok(
          (
            await host.start(
              {
                actionId: 'source',
                title: 'Payments',
                text: 'Fix payments',
                userText: 'Fix payments',
                sessionRef: worker.id,
              },
              CONTEXT,
            )
          ).ok,
        );
        const source = (await store.readWorkHubAssignment('source'))!;
        const target = {
          workId: source.work!.id,
          generationId: source.work!.generationId,
          sourceActionId: source.actionId,
          sourceDelegationId: source.delegationId,
          targetSessionId: worker.id,
          targetMessageId: source.targetMessageId,
          executionBinding: 'exact-binding',
        };
        const requests = await Promise.all(
          ['stop-one', 'stop-two'].map(async (actionId) => {
            const actionFingerprint = ('sha256:' +
              createHash('sha256').update(actionId).digest('hex')) as `sha256:${string}`;
            await store.claimWorkHubAction({
              actionId,
              operation: 'stop',
              actionFingerprint,
              subject: source.delegationId,
            });
            return admission.runMany([WORKHUB_COORDINATION_SESSION_ID, worker.id], (lease) =>
              host.prepareTaskStop(
                {
                  source,
                  target,
                  actionId,
                  actionFingerprint,
                  coordinationTurnId: actionId,
                  userText: 'Stop payments',
                  replay: false,
                  stopSet: { actionId, targets: [target] },
                },
                lease,
              ),
            );
          }),
        );
        if (scenario === 'crash') {
          const append = store.appendMessages.bind(store);
          let failed = false;
          store.appendMessages = async (sessionId, messages) => {
            if (
              !failed &&
              messages.some(
                (message) =>
                  message.type === 'workhub_coordination' &&
                  message.kind === 'delegation_stop_resolved',
              )
            ) {
              failed = true;
              throw new Error('crash before first native Stop resolution');
            }
            return append(sessionId, messages);
          };
        }
        const outcomes = await Promise.allSettled(
          requests.map((request, index) =>
            host.resolveTaskStop({
              request,
              outcome: scenario === 'not_owned' && index === 0 ? 'not_owned' : 'stop_delivered',
              ...(scenario === 'not_owned' && index === 0 ? {} : { targetTurnId: 'source-turn' }),
            }),
          ),
        );
        assert.equal(
          outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
          scenario === 'crash' ? 1 : 2,
        );
        if (scenario === 'crash') {
          const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
          assert.ok(rejected && rejected.status === 'rejected');
          assert.ok(rejected.reason instanceof WorkHubActionEffectFailure);
          assert.equal(rejected.reason.code, 'commit_outcome_unknown');
        }
        const durableRequests = await Promise.all(
          requests.map((request) =>
            store.readWorkHubStopRequest(source.delegationId, request.actionId),
          ),
        );
        assert.deepEqual(durableRequests, requests);
        assert.notEqual(requests[0]!.id, requests[1]!.id);
        const resolutions = await Promise.all(
          requests.map((request) =>
            store.readWorkHubStopResolution(source.delegationId, request.actionId),
          ),
        );
        assert.equal(
          (await store.readWorkHubStopResolution(source.delegationId))?.outcome,
          'stop_delivered',
        );
        if (scenario === 'not_owned')
          assert.deepEqual(
            resolutions.map((resolution) => resolution?.outcome),
            ['not_owned', 'stop_delivered'],
          );
        assert.equal((await store.readActiveWorkHubAssignmentsByTarget([worker.id])).length, 0);
      } finally {
        await store.close?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
