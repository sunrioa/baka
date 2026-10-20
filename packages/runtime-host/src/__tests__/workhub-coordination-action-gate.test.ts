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
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type {
  WorkHubActionClaim,
  WorkHubActionClaimOutcome,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
  type WorkHubActionGateSession,
  type WorkHubAdmittedAction,
  type WorkHubDelegationAssignmentInput,
} from '../server/workhub-coordination-action-gate.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import type { WorkHubTargetExecutionAuthority } from '../server/workhub-target-execution-authority.js';

const CONTEXT: ConnectionContext = {
  hostEpoch: 'workhub-action-gate-test',
  connectionId: 'workhub-action-gate-client',
  principal: 'local_os_user',
  acquireResidency: () => ({ release() {} }),
};

describe('WorkHub Coordination Action Gate', () => {
  test('independent task start uses exact old Session outside discovery without borrowing another task identity', async () => {
    for (const changed of [false, true]) {
      const effects = fakeEffects([
        session('old', { lastMessageAt: 1 }),
        ...Array.from({ length: 40 }, (_, index) =>
          session('recent-' + index, { lastMessageAt: 100 + index }),
        ),
      ]);
      const gate = new WorkHubCoordinationActionGate(effects);
      assert.equal(effects.sessions.length, 41);
      const target = await gate.nativeTaskCandidate('old');
      assert.ok(target);
      const original = effects.assign;
      effects.assign = async (input) => {
        if (changed) effects.sessions[0]!.cwd = '/moved';
        await input.validateFreshTarget?.();
        // Simulated durable effects persist only data, not ephemeral closures.
        const { validateFreshTarget: _validate, ...data } = input;
        return original.call(effects, data);
      };
      const operation = gate.act(
        {
          actionId: 'new-task',
          taskStart: { turnId: 'root', title: 'Title independent of Session name' },
          userText: 'Original user request',
          proposal: { disposition: 'delegate_existing' },
          delegationText: 'Prepared task',
          selectedTarget: {
            sessionId: 'old',
            workspaceDigest:
              'sha256:' +
              createHash('sha256').update(JSON.stringify(target.workspace)).digest('hex'),
          },
        },
        CONTEXT,
      );
      if (changed) {
        await assert.rejects(operation, /selected work changed/);
        assert.deepEqual(effects.assignments, []);
      } else {
        const receipt = await operation;
        assert.equal(receipt.disposition, 'delegate_existing');
        if (receipt.disposition !== 'delegate_existing')
          assert.fail('Expected independent assignment');
        assert.equal(receipt.workId, 'new-task');
        assert.deepEqual(effects.assignments[0]?.work, {
          id: 'new-task',
          generationId: 'new-task',
        });
        assert.equal(effects.assignments[0]?.taskTitle, 'Title independent of Session name');
        assert.equal(effects.assignments[0]?.taskInput, undefined);
        assert.equal(effects.assignmentRecords.size, 1);
      }
    }
  });

  test('modern start replays committed work after a workspace move but rejects changed title or target', async () => {
    const effects = fakeEffects([session('manual'), session('other')]);
    // This fixture deliberately calls the final validation, then strips only
    // ephemeral callbacks before storing its simulated durable assignment.
    const assign = effects.assign;
    effects.assign = async (input) => {
      await input.validateFreshTarget?.();
      const { validateFreshTarget: _validate, ...data } = input;
      return assign.call(effects, data);
    };
    const target = await new WorkHubCoordinationActionGate(effects).nativeTaskCandidate('manual');
    assert.ok(target);
    const input = {
      actionId: 'independent',
      taskStart: { turnId: 'root', title: 'Independent title' },
      userText: 'Original text',
      proposal: { disposition: 'delegate_existing' as const },
      selectedTarget: {
        sessionId: 'manual',
        workspaceDigest:
          'sha256:' + createHash('sha256').update(JSON.stringify(target.workspace)).digest('hex'),
      },
    };
    const gate = new WorkHubCoordinationActionGate(effects);
    const first = await gate.act(input, CONTEXT);
    effects.sessions[0]!.cwd = '/moved';
    const replay = {
      ...input,
      selectedTarget: { ...input.selectedTarget, workspaceDigest: 'changed-observation' },
    };
    assert.deepEqual(await gate.act(replay, CONTEXT), first);
    const restarted = new WorkHubCoordinationActionGate(effects);
    assert.deepEqual(await restarted.act(replay, CONTEXT), first);
    assert.equal(effects.assignmentRecords.size, 1);
    assert.equal(effects.assignmentRecords.get('independent')?.taskTitle, input.taskStart.title);
    await assert.rejects(
      restarted.act(
        { ...replay, taskStart: { ...input.taskStart, title: 'Changed title' } },
        CONTEXT,
      ),
      /different proposal/,
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...replay,
          taskStart: { ...input.taskStart, turnId: 'different-root' },
        },
        CONTEXT,
      ),
      /different proposal/,
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        {
          ...input,
          selectedTarget: {
            sessionId: 'other',
            workspaceDigest: input.selectedTarget.workspaceDigest,
          },
        },
        CONTEXT,
      ),
      /different proposal/,
    );
  });

  test('fresh continuation fixes its source and revalidates generation and workspace at final admission', async () => {
    for (const changed of ['none', 'workspace', 'generation'] as const) {
      const effects = fakeEffects([session('original')]);
      const source = assignmentRecord(
        {
          actionId: 'source',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'original',
          targetSessionName: 'Original',
          disposition: 'delegate_existing',
          userText: 'Original task',
        },
        'original-turn',
      );
      effects.assignmentRecords.set(source.actionId, source);
      const gate = new WorkHubCoordinationActionGate(effects);
      const target = await gate.nativeTaskCandidate(source.targetSessionId);
      assert.ok(target);
      const assign = effects.assign;
      effects.assign = async (input) => {
        if (changed === 'workspace') effects.sessions[0]!.cwd = '/moved-source';
        if (changed === 'generation')
          effects.assignmentRecords.set('changed-source', {
            ...source,
            actionId: 'changed-source',
            work: { id: source.actionId, generationId: 'changed-generation' },
          });
        await input.validateFreshTarget?.();
        return assign.call(effects, input);
      };
      const operation = gate.act(
        {
          actionId: 'fresh',
          userText: 'Continue this exact task',
          proposal: { disposition: 'create_new', title: 'Fresh task' },
          continuation: {
            workId: source.actionId,
            sourceActionId: source.actionId,
            container: 'fresh',
          },
          create: { workspace: { kind: 'host_path', path: target.workspace.hostCwd } },
          selectedTarget: {
            sessionId: source.targetSessionId,
            workspaceDigest: `sha256:${createHash('sha256').update(JSON.stringify(target.workspace)).digest('hex')}`,
            sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
          },
        },
        CONTEXT,
      );
      if (changed !== 'none') {
        await assert.rejects(operation, /workspace changed|task was retired/);
        assert.deepEqual(effects.assignments, []);
      } else {
        assert.notEqual((await operation).targetSessionId, source.targetSessionId);
        assert.deepEqual(effects.assignments[0]?.work, {
          id: 'source',
          generationId: 'fresh',
          continuesActionId: 'source',
        });
        assert.equal(effects.assignments[0]?.freshSource?.assignment.actionId, source.actionId);
        assert.equal(
          effects.assignmentRecords.size,
          2,
          'fresh continuation leaves the source intact',
        );
      }
    }
  });

  test('native continuation uses the exact task outside discovery and revalidates its source at admission', async () => {
    for (const retireBeforeAdmission of [false, true]) {
      const effects = fakeEffects([
        session('original', { name: 'Same name', lastMessageAt: 1 }),
        ...Array.from({ length: 40 }, (_, index) =>
          session(`other-${index}`, { name: 'Same name', lastMessageAt: 100 + index }),
        ),
      ]);
      const source = assignmentRecord(
        {
          actionId: 'source',
          actionFingerprint: `sha256:${'a'.repeat(64)}`,
          targetSessionId: 'original',
          targetSessionName: 'Same name',
          disposition: 'delegate_existing',
          userText: 'Original instruction',
        },
        'original-turn',
      );
      effects.assignmentRecords.set(source.actionId, source);
      const gate = new WorkHubCoordinationActionGate(effects);
      assert.equal(effects.sessions.length, 41);
      const target = await gate.nativeTaskCandidate('original');
      assert.ok(target);
      const originalAssign = effects.assign;
      effects.assign = async (input) => {
        if (retireBeforeAdmission) effects.assignmentRecords.delete(source.actionId);
        await input.validateFreshTarget?.();
        return originalAssign.call(effects, input);
      };
      const operation = gate.act(
        {
          actionId: 'native-continue',
          userText: 'Fresh user instruction',
          proposal: { disposition: 'delegate_existing' },
          selectedTarget: {
            sessionId: source.targetSessionId,
            workspaceDigest: `sha256:${createHash('sha256').update(JSON.stringify(target.workspace)).digest('hex')}`,
            sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
          },
        },
        CONTEXT,
      );
      if (retireBeforeAdmission) {
        await assert.rejects(operation, /task was retired/);
        assert.equal(effects.assignments.length, 0);
      } else {
        assert.equal((await operation).targetSessionId, 'original');
        assert.equal(effects.assignments.length, 1);
        assert.deepEqual(effects.assignments[0]?.work, {
          id: 'source',
          generationId: 'source',
          continuesActionId: 'source',
        });
      }
    }
  });
  test('claims before target repair and rechecks it at final admission', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    const calls: string[] = [];
    effects.targetExecution = {
      prepare: async () => {
        assert.equal(effects.actionClaims.size, 1);
        calls.push('prepare');
      },
      assertReady: async () => {
        calls.push('assert-ready');
      },
    };
    const assign = effects.assign;
    effects.assign = async (input) => {
      calls.push('assign');
      return assign.call(effects, input);
    };
    const input = {
      ...nativeStart(effects, 'payments', 'model-tool-call'),
      coordinationRunId: 'coordination-run',
    };
    await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT, 'coordination-turn');
    assert.deepEqual(calls, ['prepare', 'assign', 'assert-ready']);
  });

  test('permission denial never assigns and a retry preserves the same durable action', async () => {
    for (const deniedAt of ['prepare', 'assertReady'] as const) {
      const effects = fakeEffects([session('payments')]);
      effects.targetExecution = {
        prepare: async () => {
          if (deniedAt === 'prepare')
            throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
        },
        assertReady: async () => {
          if (deniedAt === 'assertReady')
            throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
        },
      };
      const gate = new WorkHubCoordinationActionGate(effects);
      const input = { ...nativeStart(effects, 'payments'), coordinationRunId: 'run' };
      await assert.rejects(gate.act(input, CONTEXT, 'root'), isUnauthorized);
      assert.equal(effects.assignmentRecords.size, 0);
      assert.equal(effects.actionClaims.size, 1);
      effects.targetExecution = { prepare: async () => {}, assertReady: async () => {} };
      assert.equal((await gate.act(input, CONTEXT, 'root')).targetSessionId, 'payments');
      assert.equal(effects.assignmentRecords.size, 1);
    }
  });

  test('delegation content remains separate from authorization and survives durable replay', async () => {
    const effects = fakeEffects([session('payments', { name: 'Payments' })]);
    const input = {
      ...nativeStart(effects, 'payments'),
      userText: 'Continue Payments and explain the result here',
      delegationText: 'Inspect and fix the payment retry state',
    };
    const result = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.equal(effects.assignments[0]?.userText, input.userText);
    assert.equal(effects.assignments[0]?.delegationText, input.delegationText);
    assert.equal(
      effects.assignmentRecords.get(input.actionId)?.delegationText,
      input.delegationText,
    );
    assert.deepEqual(await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT), result);
    assert.equal(effects.assignmentRecords.size, 1);
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, delegationText: 'Delete all payment work' },
        CONTEXT,
      ),
      isConflict,
    );
  });

  test('single-Session native eligibility excludes nonordinary targets without recency limits', async () => {
    const effects = fakeEffects([
      session('ordinary', { projectId: 'project' }),
      session('archived', { isArchived: true }),
      session('waiting', { status: 'waiting_for_user' }),
      session('side', { labels: ['mode:side_conversation'] }),
      session('child', {
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'ordinary',
          spawnedBy: { parentTurnId: 'turn', parentRunId: 'run', toolCallId: 'tool' },
          lifecycle: 'foreground',
        },
      }),
      session('maka_workhub_coordination', { role: 'workhub_coordination' }),
      session('role-only', { role: 'workhub_coordination' }),
    ]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const eligible: string[] = [];
    for (const target of effects.sessions)
      if (await gate.nativeTaskCandidate(target.id)) eligible.push(target.id);
    assert.deepEqual(eligible, ['ordinary', 'waiting']);
    assert.deepEqual((await gate.nativeTaskCandidate('ordinary'))?.workspace, {
      target: { kind: 'project', projectId: 'project' },
      hostCwd: '/workspace',
    });
    assert.equal(await gate.nativeTaskCandidate('missing'), undefined);
    assert.equal('candidates' in gate, false, 'there is no snapshot producer');
  });

  test('rejects a changed or unavailable exact workspace before assignment, then permits an explicit refresh', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const stale = nativeStart(effects, 'payments');
    effects.sessions[0]!.cwd = '/moved';
    await assert.rejects(gate.act(stale, CONTEXT), isStale);
    assert.equal(effects.assignments.length, 0);
    assert.equal(
      (await gate.act(nativeStart(effects, 'payments'), CONTEXT)).targetSessionId,
      'payments',
    );
    await assert.rejects(
      gate.act(
        {
          ...nativeStart(effects, 'payments', 'missing'),
          selectedTarget: { sessionId: 'missing', workspaceDigest: digest({}) },
        },
        CONTEXT,
      ),
      isStale,
    );
    assert.equal(effects.assignmentRecords.size, 1);
  });

  test('admits a new task to a waiting target without resuming or cancelling the current work', async () => {
    const effects = fakeEffects([session('waiting', { status: 'waiting_for_user' })]);
    const result = await new WorkHubCoordinationActionGate(effects).act(
      nativeStart(effects, 'waiting'),
      CONTEXT,
    );
    assert.deepEqual(result, {
      disposition: 'delegate_existing',
      targetSessionId: 'waiting',
      targetTurnId: 'turn-action',
      workId: 'action',
    });
    assert.equal(effects.assignments.length, 1);
    assert.equal(effects.stopRequests.size, 0);
    assert.equal(effects.stopResolutions.size, 0);
  });

  test('create_new carries creation context into the same assignment', async () => {
    const effects = fakeEffects([]);
    const gate = new WorkHubCoordinationActionGate(effects);
    await assert.rejects(
      gate.act(
        {
          actionId: 'missing-create-context',
          userText: 'Create an accessibility audit',
          proposal: { disposition: 'create_new', title: 'Accessibility audit' },
        },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    const input = {
      actionId: 'create',
      attachments: [
        {
          name: 'requirements.txt',
          kind: 'other' as const,
          mimeType: 'text/plain',
          bytes: 12,
          ref: {
            kind: 'session_file' as const,
            sessionId: 'maka_workhub_coordination',
            relativePath: 'artifact-1',
          },
        },
      ],
      newWorkDefaults: {
        model: { llmConnectionId: 'conn', llmConnectionSlug: 'test', model: 'chosen-model' },
        permissionMode: 'ask' as const,
      },
      userText: 'Create an accessibility audit',
      proposal: { disposition: 'create_new' as const, title: 'Accessibility audit' },
      create: { workspace: { kind: 'host_path' as const, path: '/workspace' } },
    };
    const first = await gate.act(input, CONTEXT);
    const replay = await gate.act(input, CONTEXT);
    assert.deepEqual(replay, first);
    assert.equal(effects.assignments.length, 1);
    const restartedReplay = await new WorkHubCoordinationActionGate(effects).act(input, CONTEXT);
    assert.deepEqual(restartedReplay, first);
    assert.equal(effects.assignments.length, 2);
    assert.deepEqual(effects.assignments[0], effects.assignments[1]);
    assert.deepEqual(effects.assignments[0]?.attachments, input.attachments);
    assert.match(effects.assignments[0]!.targetSessionId, /^whs_[a-f0-9]{48}$/u);
    assert.deepEqual(effects.assignments[0]!.create, {
      title: 'Accessibility audit',
      workspace: input.create.workspace,
      defaults: input.newWorkDefaults,
    });
    await assert.rejects(
      gate.act({ ...input, proposal: { disposition: 'create_new', title: 'Different' } }, CONTEXT),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(
        { ...input, newWorkDefaults: { ...input.newWorkDefaults, permissionMode: 'bypass' } },
        CONTEXT,
      ),
      (error) => error instanceof WorkHubActionGateFailure && error.code === 'action_conflict',
    );
    assert.equal(effects.assignments.length, 2);
  });

  test('one native action identity cannot change text, exact target, or operation', async () => {
    const effects = fakeEffects([session('payments'), session('login')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const input = nativeStart(effects, 'payments');
    await gate.act(input, CONTEXT);
    for (const changed of [
      { ...input, userText: 'Different work' },
      { ...nativeStart(effects, 'login'), userText: input.userText },
      {
        ...input,
        proposal: { disposition: 'create_new' as const, title: 'Other' },
        create: { workspace: { kind: 'host_path' as const, path: '/other' } },
      },
    ])
      await assert.rejects(gate.act(changed, CONTEXT), isConflict);
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(nativeStart(effects, 'login'), CONTEXT),
      isConflict,
    );
    assert.equal(effects.assignmentRecords.size, 1);
  });

  test('an assignment rejection releases the in-memory slot but not its durable action identity', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const input = nativeStart(effects, 'payments');
    const assign = effects.assign;
    effects.assign = async () => {
      throw new WorkHubActionEffectFailure('unauthorized', 'Target permission denied');
    };
    await assert.rejects(gate.act(input, CONTEXT), isUnauthorized);
    assert.equal(effects.actionClaims.size, 1);
    effects.assign = assign;
    assert.equal((await gate.act(input, CONTEXT)).disposition, 'delegate_existing');
    assert.equal(effects.assignmentRecords.size, 1);
  });

  test('same native action has one admission despite concurrency and a new execution identity', async () => {
    const effects = fakeEffects([session('payments')]);
    const gate = new WorkHubCoordinationActionGate(effects);
    const input = { ...nativeStart(effects, 'payments'), coordinationRunId: 'first-run' };
    const first = gate.act(input, CONTEXT, 'first-root');
    const replay = gate.act(
      { ...input, coordinationRunId: 'retried-run', sourceMessageId: 'retried-message' },
      CONTEXT,
      'retried-root',
    );
    assert.deepEqual(await replay, await first);
    assert.equal(effects.assignments.length, 1);
    assert.equal(effects.assignmentRecords.size, 1);
  });

  test('native assignment cannot reuse an action identity claimed by task Stop', async () => {
    const effects = fakeEffects([session('payments')]);
    effects.actionClaims.set('action', {
      actionId: 'action',
      operation: 'stop',
      actionFingerprint: digest('stop'),
      subject: 'delegation-source',
    });
    await assert.rejects(
      new WorkHubCoordinationActionGate(effects).act(nativeStart(effects, 'payments'), CONTEXT),
      isConflict,
    );
    assert.equal(effects.assignmentRecords.size, 0);
    assert.equal(effects.assignments.length, 0);
  });

  test('native start and same-task input preserve already-admitted fingerprint encoding', async () => {
    for (const mode of ['start', 'input'] as const) {
      const effects = fakeEffects([session('target')]);
      const input = nativeStart(effects, 'target');
      let action: WorkHubAdmittedAction = input;
      if (mode === 'input') {
        const { taskStart: _start, ...withoutStart } = input;
        action = {
          ...withoutStart,
          continuation: { workId: 'source', sourceActionId: 'source' },
          taskInput: {
            inputId: 'native-input',
            workId: 'source',
            generationId: 'source',
            sourceActionId: 'source',
            sourceDelegationId: 'delegation-source',
            text: 'Continue',
          },
        };
      }
      const common = {
        ...(action.taskInput ? { taskInput: action.taskInput } : {}),
        ...(action.taskStart ? { taskStart: action.taskStart } : {}),
        ...(action.continuation
          ? { continuation: action.continuation }
          : { selectedTarget: { sessionId: 'target' } }),
        userText: action.userText,
      };
      const expected = digest({
        ...common,
        disposition: 'delegate_existing',
        candidateRef: mode === 'start' ? 'target' : 'native_' + hash('target').slice(0, 48),
      });
      const record = assignmentRecord(
        {
          actionId: action.actionId,
          actionFingerprint: expected,
          targetSessionId: 'target',
          targetSessionName: 'target',
          disposition: 'delegate_existing',
          userText: action.userText,
          work: { id: action.actionId, generationId: action.actionId },
          ...(action.taskStart ? { taskTitle: action.taskStart.title } : {}),
        },
        'prior-turn',
      );
      effects.assignmentRecords.set(record.actionId, record);
      const result = await new WorkHubCoordinationActionGate(effects).act(action, CONTEXT);
      assert.equal(result.targetTurnId, 'prior-turn');
      assert.equal(effects.actionClaims.get(action.actionId)?.actionFingerprint, expected);
      assert.equal(effects.assignmentRecords.size, 1);
    }
  });

  test('historical replacement and pending Stop facts are read-only continuation guards', async () => {
    for (const blockedBy of ['replacement', 'stop'] as const) {
      const effects = fakeEffects([session('target')]);
      const source = assignmentRecord(
        {
          actionId: 'source',
          actionFingerprint: digest('source'),
          targetSessionId: 'target',
          targetSessionName: 'target',
          disposition: 'delegate_existing',
          userText: 'Original task',
        },
        'source-turn',
      );
      effects.assignmentRecords.set(source.actionId, source);
      if (blockedBy === 'replacement')
        effects.replacements.set(source.delegationId, {
          type: 'workhub_coordination',
          kind: 'delegation_replacement_requested',
          schemaVersion: 2,
          id: 'historical-replacement',
          turnId: 'historical',
          ts: 2,
          actionId: 'historical',
          actionFingerprint: digest('historical'),
          coordinationTurnId: 'historical',
          targetSessionId: 'other',
          targetSessionName: 'other',
          disposition: 'delegate_existing',
          userText: 'Historical correction',
          replacesActionId: source.actionId,
          replacesDelegationId: source.delegationId,
          replacedTargetSessionId: 'target',
          replacedTargetMessageId: source.targetMessageId,
        });
      else
        effects.stopRequests.set(source.delegationId, {
          type: 'workhub_coordination',
          kind: 'delegation_stop_requested',
          schemaVersion: 3,
          id: 'historical-stop',
          turnId: 'historical',
          ts: 2,
          actionId: 'historical',
          actionFingerprint: digest('historical'),
          coordinationTurnId: 'historical',
          stopsActionId: source.actionId,
          stopsDelegationId: source.delegationId,
          targetSessionId: source.targetSessionId,
          targetMessageId: source.targetMessageId,
          targetSessionName: source.targetSessionName,
          userText: 'Stop original work',
        });
      const action: WorkHubAdmittedAction = {
        ...nativeStart(effects, 'target'),
        continuation: { workId: 'source', sourceActionId: 'source' },
        selectedTarget: {
          ...nativeStart(effects, 'target').selectedTarget!,
          sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
        },
      };
      await assert.rejects(
        new WorkHubCoordinationActionGate(effects).act(action, CONTEXT),
        isConflict,
      );
      assert.equal(effects.assignmentRecords.size, 1);
      assert.equal(effects.assignments.length, 0);
      assert.equal(effects.replacements.size, blockedBy === 'replacement' ? 1 : 0);
      assert.equal(effects.stopRequests.size, blockedBy === 'stop' ? 1 : 0);
    }
  });
});

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex');
}
function digest(value: unknown): `sha256:${string}` {
  return ('sha256:' + hash(JSON.stringify(value))) as `sha256:${string}`;
}
const isConflict = (error: unknown) =>
  error instanceof WorkHubActionGateFailure && error.code === 'action_conflict';
const isStale = (error: unknown) =>
  error instanceof WorkHubActionGateFailure && error.code === 'candidate_set_stale';
const isUnauthorized = (error: unknown) =>
  error instanceof WorkHubActionEffectFailure && error.code === 'unauthorized';

function nativeStart(
  effects: ReturnType<typeof fakeEffects>,
  sessionId: string,
  actionId = 'action',
): WorkHubAdmittedAction {
  const target = effects.sessions.find((item) => item.id === sessionId);
  assert.ok(target);
  return {
    actionId,
    taskStart: { turnId: 'root', title: 'Independent title' },
    userText: 'Original instruction',
    proposal: { disposition: 'delegate_existing' },
    selectedTarget: {
      sessionId,
      workspaceDigest: digest({
        target:
          typeof target.projectId === 'string'
            ? { kind: 'project', projectId: target.projectId }
            : { kind: 'host_path', path: target.cwd },
        hostCwd: target.cwd,
      }),
    },
  };
}

function session(
  id: string,
  patch: Partial<WorkHubActionGateSession> = {},
): WorkHubActionGateSession {
  return {
    id,
    cwd: '/workspace',
    projectId: null,
    createdAt: 1,
    lastMessageAt: 2,
    name: id,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 2,
    ...patch,
  };
}

/** Offline persistence fixture, never a router or production execution authority. */
function fakeEffects(initialSessions: WorkHubActionGateSession[]) {
  const durable = new Map<
    string,
    { input: WorkHubDelegationAssignmentInput; result: { turnId: string } }
  >();
  const assignmentRecords = new Map<string, WorkHubDelegationAssignedMessage>();
  const actionClaims = new Map<string, WorkHubActionClaim>();
  const replacements = new Map<string, WorkHubDelegationReplacementRequestedMessage>();
  const stopRequests = new Map<string, WorkHubDelegationStopRequestedMessage>();
  const stopResolutions = new Map<string, WorkHubDelegationStopResolvedMessage>();
  return {
    sessions: [...initialSessions],
    targetExecution: undefined as WorkHubTargetExecutionAuthority | undefined,
    assignments: [] as WorkHubDelegationAssignmentInput[],
    actionClaims,
    assignmentRecords,
    replacements,
    stopRequests,
    stopResolutions,
    async listSessions() {
      return this.sessions;
    },
    async claimAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome> {
      const existing = actionClaims.get(claim.actionId);
      if (!existing) {
        actionClaims.set(claim.actionId, claim);
        return 'claimed';
      }
      return existing.operation === claim.operation &&
        existing.actionFingerprint === claim.actionFingerprint &&
        existing.subject === claim.subject
        ? 'same_claim'
        : 'conflict';
    },
    async readAssignment(actionId: string) {
      return assignmentRecords.get(actionId);
    },
    async readLatestWorkAssignment(workId: string) {
      return [...assignmentRecords.values()]
        .reverse()
        .find((assignment) => (assignment.work?.id ?? assignment.actionId) === workId);
    },
    async listActiveAssignments(targetSessionId: string) {
      return [...assignmentRecords.values()].filter(
        (assignment) => assignment.targetSessionId === targetSessionId,
      );
    },
    async readReplacement(delegationId: string) {
      return replacements.get(delegationId);
    },
    async readStopRequest(delegationId: string, actionId?: string, latest?: true) {
      if (latest)
        return [...stopRequests.values()]
          .reverse()
          .find((request) => request.stopsDelegationId === delegationId);
      const first = stopRequests.get(delegationId);
      return !actionId || first?.actionId === actionId
        ? first
        : stopRequests.get(JSON.stringify([delegationId, actionId]));
    },
    async readStopResolution(delegationId: string, actionId?: string) {
      return stopResolutions.get(
        actionId ? JSON.stringify([delegationId, actionId]) : delegationId,
      );
    },
    async assign(input: WorkHubDelegationAssignmentInput) {
      const existing = durable.get(input.actionId);
      const recorded = assignmentRecords.get(input.actionId);
      if (!existing && recorded) {
        assert.equal(recorded.actionFingerprint, input.actionFingerprint);
        return { turnId: recorded.targetTurnId! };
      }
      if (!existing) await input.validateFreshTarget?.();
      const {
        validateFreshTarget: _validate,
        freshSource: _freshSource,
        targetExecutionPreparation: _preparation,
        ...data
      } = input;
      this.assignments.push(input);
      if (existing) {
        assert.deepEqual(existing.input, data);
        return existing.result;
      }
      const result = { turnId: 'turn-' + input.actionId };
      durable.set(input.actionId, { input: data, result });
      assignmentRecords.set(input.actionId, assignmentRecord(data, result.turnId));
      return result;
    },
  } satisfies WorkHubActionGateEffects & {
    sessions: WorkHubActionGateSession[];
    assignments: WorkHubDelegationAssignmentInput[];
    actionClaims: Map<string, WorkHubActionClaim>;
    assignmentRecords: Map<string, WorkHubDelegationAssignedMessage>;
    replacements: Map<string, WorkHubDelegationReplacementRequestedMessage>;
    stopRequests: Map<string, WorkHubDelegationStopRequestedMessage>;
    stopResolutions: Map<string, WorkHubDelegationStopResolvedMessage>;
  };
}

function assignmentRecord(
  input: WorkHubDelegationAssignmentInput,
  targetTurnId: string,
): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    id: 'assignment-' + input.actionId,
    turnId: input.actionId,
    ts: 1,
    schemaVersion: input.work ? 4 : 1,
    kind: 'delegation_assigned',
    actionId: input.actionId,
    ...(input.work ? { work: input.work } : {}),
    ...(input.taskTitle === undefined ? {} : { taskTitle: input.taskTitle }),
    actionFingerprint: input.actionFingerprint,
    coordinationTurnId: input.actionId,
    targetSessionId: input.targetSessionId,
    targetSessionName: input.targetSessionName,
    targetTurnId,
    targetMessageId: 'message-' + input.actionId,
    delegationId: 'delegation-' + input.actionId,
    disposition: input.disposition,
    userText: input.userText,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
    ...(input.create ? { create: input.create } : {}),
  };
}
