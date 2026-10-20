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
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withTimeout } from '@maka/core/test-only/async-primitives';
import { FAKE_HOLD_OPEN_PROMPT } from '@maka/runtime/test-only/fake-backend';
import type { AttachmentRef } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { PendingMessageAdmission } from '@maka/storage/execution-stores';
import {
  openStorageWriterComposition,
  type StorageWriterComposition,
} from '@maka/storage/storage-writer-composition';
import {
  resolveStorageRoot,
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { RuntimeHostOperationError, type RuntimeHostConnection } from '../client/index.js';
import type {
  WorkHubTaskFindResult,
  WorkHubTaskStartInput,
  WorkHubTaskStartResult,
} from '../protocol/index.js';
import { connectClient, waitForTerminalTurn } from './fixtures/execution-host-suite.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';
import { workHubDesktopCapabilityOffers } from './fixtures/workhub-capabilities.js';

type Notice =
  | { type: 'ready'; hostEpoch: string }
  | { type: 'assignment_failed' }
  | {
      type: 'assignment_committed';
      assignment: WorkHubDelegationAssignedMessage;
      admission: PendingMessageAdmission;
      targetCreated: boolean;
    }
  | {
      type: 'dispatch';
      sessionId: string;
      turnId: string;
      text: string;
      attachments: AttachmentRef[];
    };

const TIMEOUT = 15_000;
const ATTACHMENT_TEXT = 'Durable requirements: resume exactly this submitted message.';
const clientHosts = new WeakMap<RuntimeHostConnection, HostProcess>();
type NativeTaskStart = {
  readonly actionId: string;
  readonly title: string;
  readonly text: string;
  readonly attachments?: AttachmentRef[];
} & (
  | { readonly sessionRef: string; readonly create?: never }
  | { readonly sessionRef?: never; readonly create: NonNullable<WorkHubTaskStartInput['create']> }
);

for (const limit of [1, 3])
  test(`WorkHub concurrency ${limit} recovers same-workspace queued roots after process death without replaying a dispatched root`, {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-workhub-pool-crash-'));
    const root = join(base, 'root');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const children: HostProcess[] = [];
    const clients: RuntimeHostConnection[] = [];
    const turns: string[] = [];
    try {
      await withStores(capability, async (stores) => {
        await configureDefaultTarget(stores);
        const current = await stores.runtimePolicy.runtimePolicy.getSnapshot();
        const saved = await stores.runtimePolicy.runtimePolicy.mutate({
          expectedRevision: current.revision,
          operation: {
            kind: 'set_chat_defaults',
            value: { ...current.policy.chatDefaults, workHubMaxConcurrentSessions: limit },
          },
        });
        assert.equal(saved.kind, 'committed');
      });
      const first = new HostProcess(root, capability.rootId, 'recover');
      children.push(first);
      await first.wait('ready');
      const client = await connectFixtureClient(root, first);
      clients.push(client);
      await client.request('workhub.coordination.resolve', {});
      for (let index = 0; index < 3; index++) {
        const sessionId = `pool-target-${index}`;
        await client.request('session.create', {
          sessionId,
          name: sessionId,
          workspace: { kind: 'host_path', path: root },
          modelTarget: { kind: 'default' },
        });
        await assertDiscoverable(client, 'session', sessionId, sessionId);
        const result = await startTask(client, {
          actionId: `pool-action-${index}`,
          title: sessionId,
          text: FAKE_HOLD_OPEN_PROMPT,
          sessionRef: sessionId,
        });
        assert.equal(result.disposition, 'delegate_existing');
        if (result.disposition !== 'delegate_existing') throw new Error('Missing delegation');
        assert.ok(result.targetTurnId);
        turns.push(result.targetTurnId);
      }
      await first.wait('dispatch', (notice) => notice.sessionId === 'pool-target-0');
      assert.deepEqual(
        first.notices
          .filter((notice) => notice.type === 'dispatch')
          .map((notice) => notice.sessionId),
        ['pool-target-0'],
      );
      for (const index of [1, 2])
        assert.equal(
          (
            await client.request('turn.query', {
              sessionId: `pool-target-${index}`,
              turnId: turns[index]!,
            })
          ).status,
          'admitted',
        );
      await first.stop('SIGKILL');
      await client.close();
      await withStores(capability, async ({ execution }) => {
        for (const index of [1, 2]) {
          assert.ok(
            await execution.agentRunStore.readRootTurnAdmission(
              `pool-target-${index}`,
              turns[index]!,
            ),
          );
          assert.deepEqual(
            await execution.runtimeEventStore.listSessionInvocations(`pool-target-${index}`),
            [],
          );
        }
      });
      const second = new HostProcess(root, capability.rootId, 'recover');
      children.push(second);
      await second.wait('ready');
      const restored = await connectFixtureClient(root, second);
      clients.push(restored);
      await second.wait('dispatch', (notice) => notice.sessionId === 'pool-target-1');
      assert.deepEqual(
        second.notices
          .filter((notice) => notice.type === 'dispatch')
          .map((notice) => notice.sessionId),
        ['pool-target-1'],
      );
      assert.equal(
        (await restored.request('runtime.policy.query', {})).policy.chatDefaults
          .workHubMaxConcurrentSessions,
        limit,
      );
      // Strict startup recovery records the interrupted known Run as failed;
      // it must not silently dispatch that already-started work again.
      assert.equal(
        (await restored.request('turn.query', { sessionId: 'pool-target-0', turnId: turns[0]! }))
          .status,
        'failed',
      );
      assert.equal(
        (await restored.request('turn.query', { sessionId: 'pool-target-2', turnId: turns[2]! }))
          .status,
        'admitted',
      );
      const running = await restored.request('turn.query', {
        sessionId: 'pool-target-1',
        turnId: turns[1]!,
      });
      const stopped = await withNativeTaskTurn(
        restored,
        { text: 'Stop the first recovered task so the next queued task can run' },
        (turnId) =>
          restored.request('workhub.tasks.stop', {
            turnId,
            actionId: 'stop-recovered-task',
            taskIds: ['pool-action-1'],
          }),
      );
      assert.equal(stopped.kind, 'result');
      if (stopped.kind !== 'result') throw new Error('Task stop was not applied');
      assert.equal(stopped.targets.length, 1);
      assert.equal(stopped.targets[0]!.workId, 'pool-action-1');
      assert.equal(stopped.targets[0]!.targetSessionId, running.sessionId);
      assert.equal(stopped.targets[0]!.targetTurnId, running.turnId);
      assert.equal(stopped.targets[0]!.outcome, 'stop_delivered');
      await second.wait('dispatch', (notice) => notice.sessionId === 'pool-target-2');
      assert.deepEqual(
        second.notices
          .filter((notice) => notice.type === 'dispatch')
          .map((notice) => notice.sessionId),
        ['pool-target-1', 'pool-target-2'],
      );
      await restored.close();
      await second.stop();
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      for (const child of children) await child.stop('SIGKILL');
      await removePosixEndpointDirectories(capability.rootId);
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      });
      await rm(join(resolveRootOwnershipNamespace(), capability.rootId + '.lock'), { force: true });
      await rm(base, { recursive: true, force: true });
    }
  });

// This is a real process loss at a precise durable boundary, not a close/reopen
// simulation. A fresh Host acquires a fresh lease and runs production recovery.
for (const scenario of ['create_new', 'delegate_existing', 'busy_existing'] as const) {
  const disposition = scenario === 'busy_existing' ? 'delegate_existing' : scenario;
  const busy = scenario === 'busy_existing';
  for (const withAttachment of [false, true]) {
    test(`WorkHub ${scenario} survives commit-before-dispatch process death (attachment=${withAttachment})`, {
      timeout: 60_000,
    }, async () => {
      const base = await mkdtemp(join(tmpdir(), 'maka-workhub-crash-'));
      const root = join(base, 'root');
      const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const children: HostProcess[] = [];
      const clients: RuntimeHostConnection[] = [];
      try {
        await withStores(capability, configureDefaultTarget);
        const first = new HostProcess(root, capability.rootId, 'crash');
        children.push(first);
        const firstReady = await first.wait('ready');
        const client = await connectFixtureClient(root, first);
        clients.push(client);
        await client.request('workhub.coordination.resolve', {});
        const text =
          disposition === 'create_new'
            ? 'Create a new task to review the durable requirements'
            : 'Review the durable requirements';
        if (disposition === 'delegate_existing') {
          await client.request('session.create', {
            sessionId: 'existing-target',
            name: 'Requirements',
            workspace: { kind: 'host_path', path: root },
            modelTarget: { kind: 'default' },
          });
          if (busy) {
            await client.request('turn.start', {
              sessionId: 'existing-target',
              turnId: 'manual-before-crash',
              content: { text: FAKE_HOLD_OPEN_PROMPT },
            });
            await first.wait('dispatch');
          }
          await assertDiscoverable(client, 'session', 'existing-target', 'Requirements');
        }
        const action: NativeTaskStart = {
          actionId: 'durable-delegation',
          title: 'Requirements',
          text,
          ...(disposition === 'create_new'
            ? { create: { workspace: { kind: 'isolated' } } as const }
            : { sessionRef: 'existing-target' }),
          ...(withAttachment ? { attachments: [await uploadAttachment(client)] } : {}),
        };

        // Attach both fulfillment and rejection handlers immediately: the
        // original caller loses its response when we kill the owner.
        const request = startTask(client, action).then(() => {
          throw new Error('The trapped assignment unexpectedly returned to its caller');
        });
        const committed = await Promise.race([first.wait('assignment_committed'), request]);
        assert.equal(committed.targetCreated, disposition === 'create_new');
        assert.deepEqual(
          first.notices.filter((n) => n.type === 'dispatch').map((n) => n.text),
          busy ? [FAKE_HOLD_OPEN_PROMPT] : [],
        );
        await first.stop('SIGKILL');
        await assert.rejects(request);
        const { assignment, admission } = committed;
        if (disposition === 'create_new')
          assert.deepEqual(assignment.create?.workspace, {
            kind: 'host_path',
            path: join(capability.canonicalPath, 'workhub-tasks', assignment.targetSessionId),
          });
        assert.equal(admission.disposition, busy ? 'followup' : 'steering');
        assert.equal(admission.placement, busy ? 'next_turn' : 'current_turn');
        assert.equal(assignment.steered, undefined);

        // Open brand-new handles after death. These observations prove we hit
        // the intended window, before any Root admission or first dispatch.
        await withStores(capability, async ({ execution: stores }) => {
          if (disposition === 'create_new')
            assert.equal(
              (await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId)).cwd,
              join(capability.canonicalPath, 'workhub-tasks', assignment.targetSessionId),
            );
          assert.deepEqual(
            await stores.sessionStore.readWorkHubAssignment(action.actionId),
            assignment,
          );
          assert.deepEqual(
            await stores.sessionStore.listMessageAdmissions(assignment.targetSessionId),
            [admission],
          );
          const admittedRoot = await stores.agentRunStore.readRootTurnAdmission(
            assignment.targetSessionId,
            assignment.targetTurnId,
          );
          if (busy) {
            assert.ok(admittedRoot);
            assert.equal(
              admittedRoot.sourceMessages.some(
                (source) => source.messageId === assignment.targetMessageId,
              ),
              false,
            );
          } else assert.equal(admittedRoot, undefined);
          assert.equal(
            (await stores.runtimeEventStore.listSessionInvocations(assignment.targetSessionId))
              .length,
            busy ? 1 : 0,
          );
        });

        const recovered = new HostProcess(root, capability.rootId, 'recover');
        children.push(recovered);
        const ready = await recovered.wait('ready');
        assert.notEqual(ready.hostEpoch, firstReady.hostEpoch);
        const connection = await connectFixtureClient(root, recovered);
        clients.push(connection);
        const dispatch = await recovered.wait('dispatch');
        assert.equal(dispatch.sessionId, assignment.targetSessionId);
        if (busy) assert.notEqual(dispatch.turnId, assignment.targetTurnId);
        else assert.equal(dispatch.turnId, assignment.targetTurnId);
        assert.equal(dispatch.text, action.text);
        const terminal = await waitForTerminalTurn(
          connection,
          assignment.targetSessionId,
          dispatch.turnId,
        );
        assert.equal(terminal.status, 'completed');
        if (withAttachment) {
          assert.equal(dispatch.attachments.length, 1);
          const ref = dispatch.attachments[0]!.ref;
          assert.equal(ref.kind, 'session_file');
          if (ref.kind !== 'session_file') throw new Error('Expected target-owned attachment');
          assert.equal(ref.sessionId, assignment.targetSessionId);
          const payload = await connection.request('artifact.query', {
            kind: 'read_text',
            sessionId: ref.sessionId,
            artifactId: ref.relativePath,
          });
          assert.equal(payload.kind, 'text');
          if (payload.kind !== 'text') throw new Error('Expected text attachment');
          assert.deepEqual(payload.preview, { ok: true, text: ATTACHMENT_TEXT });
        }
        // Process recovery preserves accepted work, not a new model's authority
        // to reuse an old command identity. Reconcile from native read APIs.
        const detail = await connection.request('workhub.tasks.read', {
          workId: action.actionId,
        });
        assert.equal(detail.task.workId, action.actionId);
        assert.equal(detail.task.actionId, action.actionId);
        assert.equal(detail.task.delegationId, assignment.delegationId);
        assert.equal(detail.task.targetSessionId, assignment.targetSessionId);
        assert.equal(detail.task.targetMessageId, assignment.targetMessageId);
        assert.equal(detail.task.execution?.turnId, dispatch.turnId);
        const ownership = await connection.request('turn.message.execution.query', {
          sessionId: assignment.targetSessionId,
          messageIds: [assignment.targetMessageId],
        });
        assert.deepEqual(ownership.resolutions, [
          {
            messageId: assignment.targetMessageId,
            state: 'owned',
            turnId: dispatch.turnId,
            runId: terminal.runId,
          },
        ]);
        await assertDiscoverable(connection, 'task', action.actionId, action.title);
        assert.deepEqual(
          await connection.request('workhub.tasks.read', { workId: action.actionId }),
          detail,
        );
        for (const retry of [action, { ...action, text: 'A different task' }])
          await assert.rejects(
            startTask(connection, retry),
            (error: unknown) =>
              error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
          );
        await connection.close();
        await recovered.stop();
        assert.equal(recovered.notices.filter((n) => n.type === 'dispatch').length, 1);

        await withStores(capability, async ({ execution: stores }) => {
          const headers = await stores.sessionStore.listHeaders();
          assert.equal(headers.filter((h) => h.role !== 'workhub_coordination').length, 1);
          const messages = await stores.sessionStore.readMessagesSnapshot(
            WORKHUB_COORDINATION_SESSION_ID,
          );
          assert.deepEqual(
            messages.filter(
              (m) => m.type === 'workhub_coordination' && m.kind === 'delegation_assigned',
            ),
            [assignment],
          );
          assert.deepEqual(
            await stores.sessionStore.listMessageAdmissions(assignment.targetSessionId),
            [],
          );
          const rootAdmission = await stores.agentRunStore.readRootTurnAdmission(
            assignment.targetSessionId,
            dispatch.turnId,
          );
          assert.ok(rootAdmission);
          assert.equal(rootAdmission.userMessageId, assignment.targetMessageId);
          assert.deepEqual(
            rootAdmission.sourceMessages.map((message) => message.messageId),
            [assignment.targetMessageId],
          );
          assert.deepEqual(rootAdmission.normalizedInput, admission.content);
          const invocations = await stores.runtimeEventStore.listSessionInvocations(
            assignment.targetSessionId,
          );
          assert.equal(invocations.length, busy ? 2 : 1);
          assert.ok(invocations.some((run) => run.runId === rootAdmission.runId));
          const events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
            assignment.targetSessionId,
            rootAdmission.runId,
          );
          assert.equal(events.filter((e) => e.role === 'user').length, 1);
        });
      } finally {
        for (const client of clients) await client.close().catch(() => undefined);
        for (const child of children) await child.stop('SIGKILL');
        await removePosixEndpointDirectories(capability.rootId);
        await rm(join(resolveRootControlNamespace(), capability.rootId), {
          recursive: true,
          force: true,
        });
        await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), {
          force: true,
        });
        await rm(base, { recursive: true, force: true });
      }
    });
  }
}

for (const failAssignment of [false, true]) {
  test(`WorkHub native start and continuation reuse attachments and same-source retries (assignment failure=${failAssignment})`, {
    timeout: 60_000,
  }, async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-workhub-attachment-retry-'));
    const root = join(base, 'root');
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    let host: HostProcess | undefined;
    let client: RuntimeHostConnection | undefined;
    try {
      await withStores(capability, configureDefaultTarget);
      host = new HostProcess(
        root,
        capability.rootId,
        failAssignment ? 'fail-assignment-once' : 'recover',
      );
      await host.wait('ready');
      client = await connectFixtureClient(root, host);
      await client.request('workhub.coordination.resolve', {});
      const sessionId = 'attachment-target';
      await client.request('session.create', {
        sessionId,
        name: 'Requirements',
        workspace: { kind: 'host_path', path: root },
        modelTarget: { kind: 'default' },
      });
      const attachment = await uploadAttachment(client);
      const connection = client;
      const runningHost = host;
      await assertDiscoverable(connection, 'session', sessionId, 'Requirements');
      const turnIds: string[] = [];
      const sourceTurns: string[] = [];
      const text = 'Review the durable requirements';
      const first = await withNativeTaskTurn(
        connection,
        { text, attachments: [attachment] },
        async (turnId) => {
          sourceTurns.push(turnId);
          const command = await nativeStartInput(connection, turnId, {
            actionId: 'first-delegation',
            title: 'Requirements',
            text,
            sessionRef: sessionId,
          });
          if (failAssignment) {
            await assert.rejects(
              connection.request('workhub.tasks.start', command),
              (error: unknown) =>
                error instanceof RuntimeHostOperationError && error.code === 'persistence_failed',
            );
            await runningHost.wait('assignment_failed');
            assert.equal(runningHost.notices.filter((n) => n.type === 'dispatch').length, 0);
          }
          const assigned = await connection.request('workhub.tasks.start', command);
          assert.equal(assigned.disposition, 'delegate_existing');
          assert.equal(assigned.workId, command.actionId);
          assert.equal(assigned.targetSessionId, sessionId);
          assert.ok(assigned.targetTurnId);
          turnIds.push(assigned.targetTurnId);
          assert.equal(
            (await waitForTerminalTurn(connection, sessionId, assigned.targetTurnId)).status,
            'completed',
          );
          assert.deepEqual(await connection.request('workhub.tasks.start', command), assigned);
          await assert.rejects(
            connection.request('workhub.tasks.start', { ...command, text: 'Different input' }),
            isOperationConflict,
          );
          return assigned;
        },
      );
      assert.ok(first.workId);
      const workId = first.workId;
      const continued = await withNativeTaskTurn(
        connection,
        { text, attachments: [attachment] },
        async (turnId) => {
          sourceTurns.push(turnId);
          const command = {
            turnId,
            actionId: 'second-delegation',
            taskId: workId,
            text,
            container: 'reuse' as const,
          };
          const result = await connection.request('workhub.tasks.continue', command);
          assert.equal(result.container, 'reuse');
          if (result.container !== 'reuse') throw new Error('Task did not reuse its container');
          assert.equal(result.input.workId, workId);
          assert.equal(result.input.generationId, first.workId);
          assert.equal(result.input.targetSessionId, sessionId);
          assert.equal(result.input.mode, 'continuation');
          const dispatch = await runningHost.wait(
            'dispatch',
            (notice) => notice.sessionId === sessionId && notice.turnId !== turnIds[0],
          );
          turnIds.push(dispatch.turnId);
          assert.equal(
            (await waitForTerminalTurn(connection, sessionId, dispatch.turnId)).status,
            'completed',
          );
          const receipt = await connection.request('workhub.tasks.input.read', {
            workId,
            inputId: command.actionId,
          });
          assert.equal(receipt.targetMessageId, result.input.targetMessageId);
          assert.equal(receipt.delivery, 'delivered');
          assert.equal(receipt.execution?.turnId, dispatch.turnId);
          // Delivery proof can advance after acceptance; retries must retain the
          // exact accepted source and return its current immutable execution.
          assert.deepEqual(await connection.request('workhub.tasks.continue', command), {
            container: 'reuse',
            input: receipt,
          });
          await assert.rejects(
            connection.request('workhub.tasks.continue', { ...command, text: 'Different input' }),
            isOperationConflict,
          );
          return receipt;
        },
      );
      await withNativeTaskTurn(connection, { text, attachments: [attachment] }, async (turnId) => {
        await assert.rejects(
          connection.request('workhub.tasks.continue', {
            turnId,
            actionId: continued.inputId,
            taskId: workId,
            text,
            container: 'reuse',
          }),
          isOperationConflict,
        );
        assert.deepEqual(
          await connection.request('workhub.tasks.input.read', {
            workId,
            inputId: continued.inputId,
          }),
          continued,
        );
      });
      assert.notEqual(turnIds[0], turnIds[1]);
      await client.close();
      await host.stop();
      const dispatched = host.notices.filter((n) => n.type === 'dispatch');
      assert.equal(dispatched.length, 2);
      assert.deepEqual(
        dispatched.map((n) => n.turnId),
        turnIds,
      );
      assert.deepEqual(dispatched[0]!.attachments, dispatched[1]!.attachments);
      await withStores(capability, async ({ execution, artifacts }) => {
        const records = await artifacts.listPage(sessionId, { offset: 0, limit: 10 });
        assert.equal(records.total, 1);
        assert.deepEqual(dispatched[0]!.attachments, [
          {
            ...attachment,
            ref: { kind: 'session_file', sessionId, relativePath: records.records[0]!.id },
          },
        ]);
        assert.deepEqual(await artifacts.readTextInSession(sessionId, records.records[0]!.id), {
          ok: true,
          text: ATTACHMENT_TEXT,
        });
        assert.equal(
          (await artifacts.listPage(WORKHUB_COORDINATION_SESSION_ID, { offset: 0, limit: 10 }))
            .total,
          1,
        );
        assert.deepEqual(await execution.sessionStore.listMessageAdmissions(sessionId), []);
        const messages = await execution.sessionStore.readMessagesSnapshot(
          WORKHUB_COORDINATION_SESSION_ID,
        );
        const assignments = messages.filter(
          (m) => m.type === 'workhub_coordination' && m.kind === 'delegation_assigned',
        );
        assert.equal(assignments.length, 2);
        assert.ok(assignments.every((assignment) => assignment.work?.id === workId));
        const input = await execution.sessionStore.readWorkHubTaskInput(continued.inputId);
        assert.ok(input);
        assert.equal(input.workId, workId);
        assert.equal(input.generationId, continued.generationId);
        assert.equal(input.turnId, sourceTurns[0]);
        assert.equal(assignments[1]!.coordinationTurnId, sourceTurns[1]);
        const origin = await execution.agentRunStore.readRootTurnAdmission(
          WORKHUB_COORDINATION_SESSION_ID,
          sourceTurns[1]!,
        );
        assert.ok(origin);
        assert.equal(input.sourceMessageId, origin.userMessageId);
        assert.equal(input.originalUserText, text);
        assert.equal(input.inputOrigin, 'user');
        assert.equal(
          (await execution.runtimeEventStore.listSessionInvocations(sessionId)).length,
          2,
        );
      });
    } finally {
      await client?.close().catch(() => undefined);
      await host?.stop('SIGKILL');
      await removePosixEndpointDirectories(capability.rootId);
      await rm(join(resolveRootControlNamespace(), capability.rootId), {
        recursive: true,
        force: true,
      });
      await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true });
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('real Host uses the independent Memory provider for messages, history and WorkHub without SQLite execution fallback', {
  timeout: 60_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-memory-host-')),
    root = join(base, 'root');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  let host: HostProcess | undefined, client: RuntimeHostConnection | undefined;
  try {
    await withStores(capability, configureDefaultTarget);
    host = new HostProcess(root, capability.rootId, 'memory');
    const ready = await host.wait('ready');
    client = await connectFixtureClient(root, host);
    await client.request('session.create', {
      sessionId: 'memory-task',
      name: 'Memory task',
      workspace: { kind: 'host_path', path: root },
      modelTarget: { kind: 'default' },
    });
    const ordinary = await client.request('turn.message.submit', {
      originHostEpoch: ready.hostEpoch,
      sessionId: 'memory-task',
      messageId: 'ordinary-message',
      content: { text: 'Ordinary message through replacement persistence' },
      placement: 'current_turn',
    });
    assert.equal(ordinary.disposition, 'turn_started');
    if (ordinary.disposition !== 'turn_started') throw new Error('Ordinary Turn did not start');
    assert.equal(
      (await waitForTerminalTurn(client, 'memory-task', ordinary.turnId)).status,
      'completed',
    );
    const subscription = await client.openSessionSubscription(
      { sessionId: 'memory-task', transcript: { kind: 'tail', maxBytes: 16384 } },
      TIMEOUT,
    );
    await subscription.ready();
    try {
      const history = subscription.transcriptBootstrap;
      assert.ok(history);
      assert.ok(history.durable.fragments.length > 0);
      assert.match(
        history.durable.fragments
          .map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
          .join(''),
        /Ordinary message through replacement persistence/,
      );
    } finally {
      await subscription.close();
    }
    await client.request('workhub.coordination.resolve', {});
    const connection = client;
    // Discovery is an optional storage projection. Memory must fail explicitly
    // instead of consulting SQLite for candidate/task data.
    await assert.rejects(
      connection.request('workhub.tasks.find', { query: 'Memory task' }),
      (error: unknown) =>
        error instanceof RuntimeHostOperationError && error.code === 'operation_unavailable',
    );
    for (const action of [
      {
        actionId: 'memory-delegation',
        title: 'Memory payment task',
        text: 'Continue payment work',
        sessionRef: 'memory-task',
      },
      {
        actionId: 'memory-create',
        title: 'Transaction contract',
        text: 'Create a new task to inspect the transaction contract',
        create: { workspace: { kind: 'host_path', path: root } },
      },
    ] satisfies NativeTaskStart[]) {
      await withNativeTaskTurn(connection, action, async (turnId) => {
        const command = await nativeStartInput(connection, turnId, action);
        const assigned = await connection.request('workhub.tasks.start', command);
        assert.equal(assigned.disposition, action.sessionRef ? 'delegate_existing' : 'create_new');
        assert.equal(assigned.workId, action.actionId);
        assert.ok(assigned.targetTurnId);
        assert.equal(
          (await waitForTerminalTurn(connection, assigned.targetSessionId, assigned.targetTurnId))
            .status,
          'completed',
        );
        assert.deepEqual(await connection.request('workhub.tasks.start', command), assigned);
        const detail = await connection.request('workhub.tasks.read', {
          workId: action.actionId,
        });
        assert.equal(detail.task.workId, action.actionId);
        assert.equal(detail.task.targetSessionId, assigned.targetSessionId);
        assert.equal(detail.task.targetMessageId, assigned.targetMessageId);
        assert.equal(detail.task.execution?.turnId, assigned.targetTurnId);
      });
    }
    await client.close();
    await host.stop();
    assert.equal(host.notices.filter((n) => n.type === 'dispatch').length, 3);
    // The other storage domains still legitimately use Local. Execution facts
    // must not have escaped to it when the trusted composition selected Memory.
    await withStores(capability, async ({ execution }) => {
      assert.deepEqual(await execution.sessionStore.listHeaders(), []);
      assert.deepEqual(await execution.runtimeEventStore.listSessionInvocations('memory-task'), []);
      assert.equal(
        await execution.sessionStore.readWorkHubAssignment('memory-delegation'),
        undefined,
      );
      assert.deepEqual(await execution.sessionStore.listMessageAdmissions('memory-task'), []);
    });
  } finally {
    await client?.close().catch(() => undefined);
    await host?.stop('SIGKILL');
    await removePosixEndpointDirectories(capability.rootId);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(join(resolveRootOwnershipNamespace(), capability.rootId + '.lock'), { force: true });
    await rm(base, { recursive: true, force: true });
  }
});

async function connectFixtureClient(
  root: string,
  host: HostProcess,
): Promise<RuntimeHostConnection> {
  const client = await connectClient(root);
  try {
    await client.replaceClientCapabilities({
      offers: () => [...workHubDesktopCapabilityOffers()],
      call: async () => {
        throw new Error('The held fake model must not dispatch a Desktop WorkHub tool');
      },
    });
    clientHosts.set(client, host);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

// Each command belongs to an actual admitted coordination Turn. Multiple
// retries intentionally share that same source, unlike independent user turns.
// The fake primary model only stays open; all authority, capability binding,
// admission and execution ownership remain production code.
async function withNativeTaskTurn<T>(
  client: RuntimeHostConnection,
  input: { readonly text: string; readonly attachments?: AttachmentRef[] },
  run: (turnId: string) => Promise<T>,
): Promise<T> {
  const turnId = randomUUID();
  assert.ok(clientHosts.get(client));
  // A completed target may wake a held automatic feedback Turn before the next
  // independent request. End only those fixture-held feedback executions.
  for (;;) {
    try {
      await client.request('workhub.coordination.answer', {
        turnId,
        text: input.text,
        ...(input.attachments ? { attachments: input.attachments } : {}),
      });
      break;
    } catch (error) {
      if (
        !(error instanceof RuntimeHostOperationError) ||
        error.code !== 'session_busy' ||
        !(await stopHeldResultTurn(client))
      )
        throw error;
    }
  }
  try {
    return await run(turnId);
  } finally {
    const active = await client.request('turn.query', {
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId,
    });
    await client.request('turn.stop', {
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId,
      runId: active.runId,
    });
  }
}

async function nativeStartInput(
  client: RuntimeHostConnection,
  turnId: string,
  input: NativeTaskStart,
): Promise<WorkHubTaskStartInput> {
  const base = { turnId, actionId: input.actionId, title: input.title, text: input.text };
  if (input.sessionRef) return { ...base, sessionRef: input.sessionRef };
  const session = await client.request('workhub.coordination.query', {});
  assert.ok(!('kind' in session));
  if ('kind' in session) throw new Error('Shared WorkHub model is not representable');
  assert.ok(session.llmConnectionId);
  assert.ok(session.llmConnectionSlug);
  assert.ok(session.model);
  assert.ok(input.create);
  const policy = await client.request('runtime.policy.query', {});
  return {
    ...base,
    create: input.create,
    newWorkDefaults: {
      model: {
        llmConnectionId: session.llmConnectionId,
        llmConnectionSlug: session.llmConnectionSlug,
        model: session.model,
      },
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      permissionMode: policy.policy.chatDefaults.workHubPermissionMode ?? 'ask',
    },
  };
}

async function startTask(
  client: RuntimeHostConnection,
  input: NativeTaskStart,
): Promise<WorkHubTaskStartResult> {
  return withNativeTaskTurn(client, input, async (turnId) =>
    client.request('workhub.tasks.start', await nativeStartInput(client, turnId, input)),
  );
}

async function assertDiscoverable(
  client: RuntimeHostConnection,
  kind: 'task' | 'session',
  id: string,
  query: string,
): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: WorkHubTaskFindResult = await client.request('workhub.tasks.find', {
      query,
      ...(cursor ? { cursor } : {}),
    });
    if (page.items.some((item) => item.kind === kind && item.id === id && item.available)) return;
    cursor = page.nextCursor;
  } while (cursor);
  assert.fail(`Native discovery did not find ${kind} ${id}`);
}

function isOperationConflict(error: unknown): boolean {
  return error instanceof RuntimeHostOperationError && error.code === 'operation_conflict';
}

async function stopHeldResultTurn(client: RuntimeHostConnection): Promise<boolean> {
  const turns = await client.request('session.turns.query', {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    throughSequence: null,
    position: 0,
    maxContributions: 128,
  });
  let stopped = false;
  for (const contribution of turns.contributions) {
    if (!contribution.turnId.startsWith('whf_')) continue;
    const turn = await client.request('turn.query', {
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId: contribution.turnId,
    });
    if (turn.status !== 'running' && turn.status !== 'waiting_for_user') continue;
    await client.request('turn.stop', {
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId: turn.turnId,
      runId: turn.runId,
    });
    stopped = true;
  }
  return stopped;
}

async function uploadAttachment(client: RuntimeHostConnection): Promise<AttachmentRef> {
  const bytes = Buffer.from(ATTACHMENT_TEXT);
  const sessionId = WORKHUB_COORDINATION_SESSION_ID;
  const uploadId = 'requirements-upload';
  await client.request('artifact.ingest', {
    kind: 'begin',
    sessionId,
    uploadId,
    name: 'requirements.txt',
    mimeType: 'text/plain',
    totalBytes: bytes.length,
    contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  });
  await client.request('artifact.ingest', {
    kind: 'chunk',
    sessionId,
    uploadId,
    offset: 0,
    chunkBase64: bytes.toString('base64'),
  });
  const result = await client.request('artifact.ingest', { kind: 'commit', sessionId, uploadId });
  assert.equal(result.kind, 'committed');
  if (result.kind !== 'committed') throw new Error('Attachment was not committed');
  return result.attachment;
}

async function withStores(
  capability: StorageRootCapability<'interactive'>,
  run: (stores: StorageWriterComposition) => Promise<void>,
): Promise<void> {
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: StorageWriterComposition | undefined;
  try {
    stores = await openStorageWriterComposition(owner.lease);
    await run(stores);
  } finally {
    await stores?.close();
    await owner.close();
  }
}

async function configureDefaultTarget({
  runtimePolicy: policy,
}: StorageWriterComposition): Promise<void> {
  const created = await policy.connectionCatalog.create({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'fake',
      name: 'Fake',
      providerType: 'ollama',
      enabled: true,
      enabledModelIds: ['fake-model'],
    },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') throw new Error('Connection was not committed');
  const connection = created.snapshot.connections[0]!;
  const fetch = await policy.operations.beginModelFetch(connection.connectionId);
  assert.equal(fetch.kind, 'ready');
  if (fetch.kind !== 'ready') throw new Error('Model fetch was not opened');
  const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
    models: [{ id: 'fake-model' }],
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(fetched.kind, 'committed');
  if (fetched.kind !== 'committed') throw new Error('Model catalog was not committed');
  const selected = await policy.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: fetched.snapshot.revision,
    target: { connectionId: connection.connectionId, modelId: 'fake-model' },
  });
  assert.equal(selected.kind, 'committed');
}

class HostProcess {
  readonly child: ChildProcess;
  readonly notices: Notice[] = [];
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly listeners = new Set<() => void>();

  constructor(
    root: string,
    rootId: string,
    mode: 'crash' | 'recover' | 'fail-assignment-once' | 'memory',
  ) {
    this.child = fork(
      new URL('./fixtures/workhub-assignment-crash-host.js', import.meta.url),
      [root, rootId, mode],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.child.on('message', (notice: Notice) => {
      this.notices.push(notice);
      for (const listener of this.listeners) listener();
    });
  }

  async wait<T extends Notice['type']>(
    type: T,
    matches: (notice: Extract<Notice, { type: T }>) => boolean = () => true,
  ): Promise<Extract<Notice, { type: T }>> {
    let check!: () => void;
    const notice = new Promise<Extract<Notice, { type: T }>>((resolve) => {
      check = () => {
        const found = this.notices.find(
          (n): n is Extract<Notice, { type: T }> =>
            n.type === type && matches(n as Extract<Notice, { type: T }>),
        );
        if (found) resolve(found);
      };
      this.listeners.add(check);
      check();
    });
    try {
      return await withTimeout(
        Promise.race([
          notice,
          this.closed.then((exit) => {
            throw new Error(`Host exited before ${type}: ${JSON.stringify(exit)}`);
          }),
        ]),
        TIMEOUT,
        `Host did not report ${type}`,
      );
    } finally {
      this.listeners.delete(check);
    }
  }

  async stop(signal?: 'SIGKILL'): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (signal) this.child.kill(signal);
      else this.child.send({ type: 'shutdown' });
    }
    const exit = await withTimeout(this.closed, TIMEOUT, 'Host did not exit');
    if (!signal) assert.deepEqual(exit, { code: 0, signal: null });
  }
}
