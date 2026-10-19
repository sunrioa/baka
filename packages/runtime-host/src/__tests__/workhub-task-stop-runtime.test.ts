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
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { normalizeMessageContent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubActionClaim,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import { createWorkHubTaskStopRuntime } from '../server/workhub-task-stop-runtime.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  workHubPendingStopBinding,
  workHubStopBindingMatches,
  type WorkHubStopTarget,
} from '../server/workhub-stop-binding.js';
import { WORKHUB_TASK_STOP_OPERATION_SPECS } from '../protocol/workhub-task-stop.js';
import { WORKHUB_COORDINATION_TEXT_MAX_BYTES } from '../protocol/workhub-coordination.js';

type Options = Parameters<typeof createWorkHubTaskStopRuntime>[0];
const input = { turnId: 'coordinator-turn', actionId: 'stop-action', taskIds: ['a', 'b'] };
const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 48);

function fixture() {
  const admission = new SessionAdmissionGate();
  const f = {
    active: true,
    origin: 'user' as 'user' | 'feedback',
    answer: 'confirm',
    forms: 0,
    content: normalizeMessageContent({ text: 'Stop the selected tasks' }),
    claims: new Map<string, WorkHubActionClaim>(),
    requests: new Map<string, WorkHubDelegationStopRequestedMessage>(),
    resolutions: new Map<string, WorkHubDelegationStopResolvedMessage>(),
    sources: new Map<string, WorkHubDelegationAssignedMessage>(),
    latest: new Map<string, WorkHubDelegationAssignedMessage>(),
    pending: new Set<string>(),
    bindingRevision: new Map<string, number>(),
    effects: [] as string[],
    trace: [] as string[],
    failWork: undefined as string | undefined,
    beforeConfirm: undefined as (() => void) | undefined,
    beforeRetire: undefined as (() => void) | undefined,
  };
  for (const workId of ['a', 'b', 'c']) {
    const source: WorkHubDelegationAssignedMessage = {
      type: 'workhub_coordination',
      kind: 'delegation_assigned',
      schemaVersion: 4,
      id: 'assignment-' + workId,
      turnId: 'source-turn-' + workId,
      ts: 1,
      actionId: 'source-' + workId,
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      coordinationTurnId: 'source-turn-' + workId,
      disposition: 'delegate_existing',
      delegationId: 'delegation-' + workId,
      targetMessageId: 'message-' + workId,
      targetSessionId: 'worker-' + workId,
      targetSessionName: 'Task ' + workId,
      targetTurnId: 'original-' + workId,
      userText: 'Do task ' + workId,
      returnResults: true,
      work: { id: workId, generationId: 'generation-' + workId },
    };
    f.sources.set(source.actionId, source);
    f.latest.set(workId, source);
  }
  const authority = () => ({
    content:
      f.origin === 'feedback'
        ? normalizeMessageContent({ text: f.sources.get('source-a')!.userText })
        : f.content,
    runId: 'coordinator-run',
    origin: f.origin,
    ...(f.origin === 'user' ? { sourceMessageId: 'user-message' } : {}),
  });
  const target = (source: WorkHubDelegationAssignedMessage): WorkHubStopTarget => {
    const workId = source.work!.id;
    if (f.pending.has(workId)) return { binding: workHubPendingStopBinding(source) };
    const revision = f.bindingRevision.get(workId) ?? 0;
    const execution = {
      sessionId: source.targetSessionId,
      turnId: 'owned-' + workId + '-' + revision,
      runId: 'run-' + workId + '-' + revision,
    };
    const initialExecution = {
      sessionId: source.targetSessionId,
      turnId: 'owned-' + workId + '-0',
      runId: 'run-' + workId + '-0',
    };
    return { binding: 'owned-binding-' + workId + '-' + revision, execution, initialExecution };
  };
  // Mock external authorities, real admission leases and orchestration. Actual
  // SQLite/Root/provider composition is verified separately, not by this fixture.
  const runtime = createWorkHubTaskStopRuntime({
    admission,
    onError: () => {},
    stores: {
      sessionStore: {
        readWorkHubActionClaim: async (id: string) => f.claims.get(id),
        claimWorkHubAction: async (claim: WorkHubActionClaim) => {
          const old = f.claims.get(claim.actionId);
          if (old && JSON.stringify(old) !== JSON.stringify(claim)) return 'conflict';
          f.claims.set(claim.actionId, claim);
          return 'claimed';
        },
        readLatestWorkHubAssignment: async (id: string) => f.latest.get(id),
        readWorkHubAssignment: async (id: string) => f.sources.get(id),
        readHeaderSnapshot: async (id: string) => ({
          id,
          isArchived: false,
          permissionMode: 'bypass',
        }),
        probeSessionRemoval: async () => ({ kind: 'present' }),
        hasOtherWorkHubStopTarget: async (turnId: string, workId: string) =>
          [...f.requests.values()].some(
            (q) => q.coordinationTurnId === turnId && q.workId !== workId,
          ),
        readWorkHubStopRequest: async (delegation: string, actionId?: string) =>
          [...f.requests.values()].find(
            (q) => q.stopsDelegationId === delegation && (!actionId || q.actionId === actionId),
          ),
        readWorkHubStopResolution: async (delegation: string, actionId?: string) =>
          [...f.resolutions.values()].find(
            (r) => r.stopsDelegationId === delegation && (!actionId || r.actionId === actionId),
          ),
      },
      agentRunStore: {
        readRootTurnAdmission: async () => ({
          runId: 'coordinator-run',
          userMessageId: 'user-message',
          normalizedInput: authority().content,
          execution: {
            kind: 'workhub_coordination',
            ...(f.origin === 'feedback'
              ? {
                  feedback: {
                    actionId: 'source-a',
                    delegationId: 'delegation-a',
                    targetSessionId: 'worker-a',
                  },
                }
              : {}),
          },
        }),
      },
    } as unknown as Options['stores'],
    messages: {} as Options['messages'],
    executions: {
      readRootState: () => ({ kind: 'idle' }),
      readActiveWorkHubRoutingRequest: async () => (f.active ? authority() : undefined),
    } as unknown as Options['executions'],
    readStopTarget: async (source, lease) =>
      lease
        ? admission.runAdmitted(source.targetSessionId, lease, () => target(source))
        : target(source),
    coordination: {
      prepareTaskStop: async (value, lease) => {
        await admission.runAdmitted(WORKHUB_COORDINATION_SESSION_ID, lease, async () => {});
        await admission.runAdmitted(value.target.targetSessionId, lease, async () => {});
        const claim = f.claims.get(value.actionId);
        assert.equal(claim?.actionFingerprint, value.actionFingerprint);
        assert.equal(claim?.subject, value.source.delegationId);
        const request: WorkHubDelegationStopRequestedMessage = {
          type: 'workhub_coordination',
          kind: 'delegation_stop_requested',
          schemaVersion: 3,
          id: 'whq_' + hash(value.actionId),
          turnId: value.coordinationTurnId,
          ts: 1,
          actionId: value.actionId,
          actionFingerprint: value.actionFingerprint,
          coordinationTurnId: value.coordinationTurnId,
          stopsActionId: value.target.sourceActionId,
          stopsDelegationId: value.target.sourceDelegationId,
          targetSessionId: value.target.targetSessionId,
          targetMessageId: value.target.targetMessageId,
          targetSessionName: value.source.targetSessionName,
          userText: value.userText,
          workId: value.target.workId,
          executionBinding: value.target.executionBinding,
          taskStop: true,
          ...(value.stopSet ? { stopSet: value.stopSet } : {}),
        };
        const existing = f.requests.get(value.actionId);
        if (existing) assert.deepEqual(existing, request);
        else {
          f.requests.set(value.actionId, request);
          f.trace.push('prepare:' + request.workId);
        }
        return existing ?? request;
      },
      resolveTaskStop: async ({ request, outcome, targetTurnId }) => {
        const resolution: WorkHubDelegationStopResolvedMessage = {
          type: 'workhub_coordination',
          kind: 'delegation_stop_resolved',
          schemaVersion: 3,
          id: 'whz_' + hash(request.actionId),
          turnId: request.turnId,
          ts: 1,
          actionId: request.actionId,
          actionFingerprint: request.actionFingerprint,
          coordinationTurnId: request.coordinationTurnId,
          stopsActionId: request.stopsActionId,
          stopsDelegationId: request.stopsDelegationId,
          targetSessionId: request.targetSessionId,
          outcome,
          ...(targetTurnId ? { targetTurnId } : {}),
        };
        f.resolutions.set(request.actionId, resolution);
        return resolution;
      },
    },
    retireTaskStop: (source, request, validate) =>
      admission.run(source.targetSessionId, async (lease) => {
        f.beforeRetire?.();
        const current = target(source);
        if (
          !(await validate(lease)) ||
          !workHubStopBindingMatches(source, request.executionBinding!, current)
        )
          return { outcome: 'not_owned' };
        const workId = source.work!.id;
        if (f.failWork === workId) {
          f.failWork = undefined;
          throw new Error('injected effect failure');
        }
        f.effects.push(workId);
        f.trace.push('effect:' + workId);
        return current.execution
          ? { outcome: 'stop_delivered', targetTurnId: current.execution.turnId }
          : { outcome: 'cancelled_pending' };
      }),
    requestForm: async (form) => {
      const offered = await form.create();
      assert.equal(offered.kind, 'form');
      f.forms++;
      f.trace.push('confirm');
      f.beforeConfirm?.();
      return { createdAt: 1, answer: { action: 'accept', values: { stop: f.answer } } };
    },
  });
  return { ...f, state: f, runtime, admission, target };
}

async function stop(f: ReturnType<typeof fixture>, command = input) {
  const result = await f.runtime.stop(command);
  const spec = WORKHUB_TASK_STOP_OPERATION_SPECS['workhub.tasks.stop'];
  spec.assertOutputForInput!(spec.decodeInput(command), spec.decodeOutput(result));
  return result;
}

test('single user target stops directly; a second distinct target requires confirmation', async () => {
  const f = fixture();
  await stop(f, { ...input, taskIds: ['a'] });
  assert.equal(f.state.forms, 0);
  await stop(f, { ...input, actionId: 'second-action', taskIds: ['b'] });
  assert.equal(f.state.forms, 1);
  assert.deepEqual(f.effects, ['a', 'b']);
});

test('feedback cannot bypass confirmation, and cancellation has no committed stop or effect', async () => {
  const f = fixture();
  f.state.origin = 'feedback';
  f.state.answer = 'cancel';
  assert.equal((await stop(f, { ...input, taskIds: ['a'] })).kind, 'cancelled');
  assert.equal(f.state.forms, 1);
  assert.equal(f.requests.size, 0);
  assert.deepEqual(f.effects, []);
});

test('confirm the whole known set, prepare all facts, then cancel queued targets before active ones', async () => {
  const f = fixture();
  f.pending.add('b');
  const result = await stop(f);
  assert.deepEqual(f.trace, ['confirm', 'prepare:a', 'prepare:b', 'effect:b', 'effect:a']);
  assert.equal(result.kind, 'result');
  if (result.kind === 'result') {
    assert.deepEqual(
      result.targets.map((row) => [row.workId, row.outcome]),
      [
        ['a', 'stop_delivered'],
        ['b', 'cancelled_pending'],
      ],
    );
  }
});

test('a binding changed while confirmation is open rejects the whole set without effects', async () => {
  const f = fixture();
  f.state.beforeConfirm = () => f.bindingRevision.set('b', 1);
  await assert.rejects(stop(f), /confirmed task set changed/);
  assert.equal(f.requests.size, 0);
  assert.deepEqual(f.effects, []);
});

for (const change of ['generation', 'source', 'session', 'authority'] as const)
  test(`whole-set confirmation cannot authorize a changed ${change}`, async () => {
    const f = fixture();
    f.state.beforeConfirm = () => {
      const old = f.latest.get('b')!;
      if (change === 'authority') f.state.active = false;
      else
        f.latest.set('b', {
          ...old,
          ...(change === 'generation'
            ? { work: { ...old.work!, generationId: 'later-generation' } }
            : {}),
          ...(change === 'source'
            ? {
                actionId: 'later-source',
                delegationId: 'later-delegation',
                targetMessageId: 'later-message',
              }
            : {}),
          ...(change === 'session' ? { targetSessionId: 'other-session' } : {}),
        });
    };
    await assert.rejects(stop(f), /confirmed task set changed|previous coordinator/);
    assert.equal(f.requests.size, 0);
    assert.deepEqual(f.effects, []);
  });

test('new commands require active coordinator authority; committed replay is fixed and idempotent', async () => {
  const f = fixture();
  const first = await stop(f);
  f.state.active = false;
  assert.deepEqual(await stop(f), first);
  assert.equal(f.state.forms, 1);
  assert.deepEqual(f.effects, ['a', 'b']);
  await assert.rejects(stop(f, { ...input, actionId: 'new-action' }), /active coordinator/);
});

test('pending capture may become its first owned execution, never a later resumed execution', async () => {
  for (const revision of [0, 1]) {
    const f = fixture();
    f.pending.add('a');
    f.state.beforeRetire = () => {
      f.pending.delete('a');
      f.bindingRevision.set('a', revision);
    };
    const result = await stop(f, { ...input, taskIds: ['a'] });
    assert.equal(result.kind, 'result');
    if (result.kind === 'result')
      assert.equal(result.targets[0]?.outcome, revision ? 'not_owned' : 'stop_delivered');
    assert.deepEqual(f.effects, revision ? [] : ['a']);
  }
});

test('partial failure replays only original targets, not a new generation of the failed task', async () => {
  const f = fixture();
  f.state.failWork = 'b';
  await assert.rejects(stop(f), /injected effect failure/);
  assert.deepEqual(f.effects, ['a']);
  const old = f.latest.get('b')!;
  const next = {
    ...old,
    actionId: 'new-source-b',
    delegationId: 'new-delegation-b',
    targetMessageId: 'new-message-b',
    work: { id: 'b', generationId: 'new-generation-b' },
  };
  f.latest.set('b', next);
  f.sources.set(next.actionId, next);
  f.state.active = false;
  const result = await stop(f);
  assert.equal(result.kind, 'result');
  if (result.kind === 'result')
    assert.deepEqual(
      result.targets.map((row) => row.outcome),
      ['stop_delivered', 'not_owned'],
    );
  assert.equal(f.state.forms, 1);
  assert.deepEqual(f.effects, ['a']);
});

test('committed manifest cannot change order, binding, or masquerade as a legacy stop', async () => {
  const f = fixture();
  await stop(f);
  await assert.rejects(stop(f, { ...input, taskIds: ['b', 'a'] }), /committed task stop set/);
  const saved = f.requests.get(input.actionId)!;
  f.requests.set(input.actionId, {
    ...saved,
    stopSet: {
      ...saved.stopSet!,
      targets: saved.stopSet!.targets.map((target, index) =>
        index ? target : { ...target, executionBinding: 'forged-binding' },
      ),
    },
  });
  await assert.rejects(stop(f), /manifest changed/);
  const { taskStop: _marker, stopSet: _manifest, ...legacy } = saved;
  f.requests.set(input.actionId, legacy);
  await assert.rejects(stop(f), /committed task stop set/);
  assert.deepEqual(f.effects, ['a', 'b']);
});

test('claim without committed stop cannot retarget after cancellation and execution change', async () => {
  const f = fixture();
  f.state.answer = 'cancel';
  await stop(f);
  assert.equal(f.requests.size, 0);
  f.state.answer = 'confirm';
  f.bindingRevision.set('b', 1);
  await assert.rejects(stop(f), /different operation or stop set/);
  assert.deepEqual(f.effects, []);
});

test('bounded stop metadata is a verbatim excerpt, not a generated handoff summary', async () => {
  const f = fixture();
  f.state.content = normalizeMessageContent({
    text: '用户原文'.repeat(WORKHUB_COORDINATION_TEXT_MAX_BYTES),
  });
  await stop(f, { ...input, taskIds: ['a'] });
  const saved = f.requests.get(input.actionId)!;
  assert.ok(Buffer.byteLength(saved.userText) <= WORKHUB_COORDINATION_TEXT_MAX_BYTES);
  assert.ok(saved.userText.endsWith('…'));
  assert.ok(f.state.content.text.startsWith(saved.userText.slice(0, -1)));
  assert.ok(saved.stopSet);
});

test('handler reports partial failures as unknown, not all stopped or safe to retarget', async () => {
  const f = fixture();
  f.state.failWork = 'b';
  const result = await f.runtime.handlers['workhub.tasks.stop'](input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'commit_outcome_unknown');
  assert.deepEqual(f.effects, ['a']);
  const recovered = await f.runtime.handlers['workhub.tasks.stop'](input);
  assert.equal(recovered.ok, true);
  assert.deepEqual(f.effects, ['a', 'b']);
});
