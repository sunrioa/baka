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
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createWorkHubResultRuntime } from '../server/workhub-result-runtime.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';

type Options = Parameters<typeof createWorkHubResultRuntime>[0];

test('task-id detail lookup resolves old tasks outside the overview without scanning assignment history', async () => {
  const f = fixture();
  f.hideFromOverview();
  f.setOriginalAnswered();
  const overview = await f.handlers['workhub.tasks.query']({}, {} as never);
  assert.ok(overview.ok);
  assert.deepEqual(overview.result.tasks, []);
  const detail = await f.handlers['workhub.tasks.read']({ workId: 'action' }, {} as never);
  assert.ok(detail.ok);
  assert.equal(detail.result.task.actionId, 'action');
  assert.equal(detail.result.task.targetSessionId, 'target');
  assert.deepEqual(f.latestLookups, ['action']);
  const missing = await f.handlers['workhub.tasks.read']({ workId: 'missing' }, {} as never);
  assert.equal(missing.ok, false);
});

test('task overview follows the owned continuation and separates queue, resources, dependency and user waiting without reading delivery', async () => {
  const f = fixture();
  const query = async () => {
    const result = await f.handlers['workhub.tasks.query']({}, {} as never);
    assert.ok(result.ok);
    return result.result.tasks[0]!;
  };
  f.setDisposition('pending');
  assert.equal((await query()).status, 'queued');
  f.setDisposition('owned_root');
  f.setRunning();
  f.setWaitReason('workspace');
  assert.equal((await query()).waitReason, 'workspace');
  f.setWaitReason('concurrency');
  assert.equal((await query()).waitReason, 'concurrency');
  f.setWaitReason(undefined);
  assert.equal((await query()).status, 'running');
  f.setTip({ sessionId: 'target', turnId: 'evidence-turn', runId: 'evidence-run' });
  f.setDependency({
    turnId: 'evidence-turn',
    runId: 'evidence-run',
    sharedTurn: false,
    eventKey: 'request',
    status: 'waiting_for_dependency',
    result: '',
    details: { requestId: 'request', question: 'Need proof', sourceActionId: 'producer' },
  });
  assert.deepEqual((await query()).dependency, {
    requestId: 'request',
    question: 'Need proof',
    sourceActionId: 'producer',
  });
  f.setDependency(undefined);
  f.setCompleted();
  const ended = await query();
  assert.equal(ended.status, 'pending_acceptance');
  assert.equal(ended.execution!.turnId, 'evidence-turn');
  assert.equal(f.resultReads(), 0, 'overview never scans unrelated transcript or reads a delivery');
  const detail = await f.handlers['workhub.tasks.read'](
    { actionId: 'action', delegationId: 'delegation' },
    {} as never,
  );
  assert.ok(detail.ok);
  assert.equal(detail.result.task.execution!.runId, 'evidence-run');
  assert.ok(detail.result.delivery!.truncated);
  assert.ok(Buffer.byteLength(detail.result.delivery!.text) <= 16 * 1024);
});
test('task detail revalidates the delegation, retirement and shared-Turn ownership', async () => {
  const f = fixture();
  f.setOriginalAnswered();
  assert.equal(
    (
      await f.handlers['workhub.tasks.read'](
        { actionId: 'action', delegationId: 'foreign' },
        {} as never,
      )
    ).ok,
    false,
  );
  f.setDisposition('shared_turn');
  const shared = await f.handlers['workhub.tasks.read'](
    { actionId: 'action', delegationId: 'delegation' },
    {} as never,
  );
  assert.ok(shared.ok);
  assert.equal(shared.result.delivery, undefined);
  f.setDisposition('owned_root');
  f.setStopped();
  const stopped = await f.handlers['workhub.tasks.read'](
    { actionId: 'action', delegationId: 'delegation' },
    {} as never,
  );
  assert.ok(stopped.ok);
  assert.equal(stopped.result.task.status, 'stopping');
  assert.equal(stopped.result.delivery, undefined);
  f.setStopResolved();
  const resolved = await f.handlers['workhub.tasks.read'](
    { actionId: 'action', delegationId: 'delegation' },
    {} as never,
  );
  assert.ok(resolved.ok);
  assert.equal(resolved.result.task.status, 'stopped');
  assert.equal(resolved.result.delivery, undefined);
  f.setActive(false);
  assert.equal(
    (
      await f.handlers['workhub.tasks.read'](
        { actionId: 'action', delegationId: 'delegation' },
        {} as never,
      )
    ).ok,
    false,
  );
  assert.equal(f.resultReads(), 0);
});

test('task overview includes only a linked child question belonging to the exact owned root', async () => {
  const f = fixture(true);
  f.setStatus('running');
  const query = async () => {
    const result = await f.handlers['workhub.tasks.query']({}, {} as never);
    assert.ok(result.ok);
    return result.result.tasks[0]!;
  };
  assert.equal((await query()).status, 'waiting_for_user');
  f.setChildOwned(false);
  assert.equal((await query()).status, 'running');
  assert.equal(f.resultReads(), 0);
});

test('result notifications include the latest delivered user correction from the exact owned Turn, never a shared Turn', async () => {
  const f = fixture();
  f.setOriginalAnswered();
  f.setTip({ sessionId: 'target', turnId: 'continued-turn', runId: 'continued-run' });
  f.setLatestInput('Use the corrected output. Do not repeat the command.');
  await f.handlers['workhub.tasks.query']({}, {} as never);
  assert.equal(f.inputReads(), 0, 'overview does not read target history');
  await f.reconcile();
  const data = JSON.parse(f.notifications[0]!.split('\n\n').at(-1)!);
  assert.equal(data.targetTurnId, 'continued-turn');
  assert.equal(data.latestUserInput, 'Use the corrected output. Do not repeat the command.');
  assert.equal(data.latestUserInputTruncated, false);

  const shared = fixture();
  shared.setOriginalAnswered();
  shared.setDisposition('shared_turn');
  shared.setLatestInput('Unrelated manual work');
  await shared.reconcile();
  assert.equal(shared.inputReads(), 0);
  assert.equal(
    JSON.parse(shared.notifications[0]!.split('\n\n').at(-1)!).latestUserInput,
    undefined,
  );
});

for (const scenario of [
  'modern',
  'legacy',
  'mixed-modern',
  'mixed-legacy',
  'delivered',
  'later-pending',
] as const)
  test(
    'stop projection uses the matching request and preserves terminal no-op results (' +
      scenario +
      ')',
    async () => {
      const f = fixture();
      f.setOriginalAnswered();
      const request = (
        actionId: string,
        modern: boolean,
      ): import('@maka/core/session').WorkHubDelegationStopRequestedMessage => ({
        type: 'workhub_coordination',
        kind: 'delegation_stop_requested',
        schemaVersion: 3,
        id: 'request-' + actionId,
        turnId: 'coordinator-turn',
        coordinationTurnId: 'coordinator-turn',
        ts: 1,
        actionId,
        actionFingerprint: `sha256:${'d'.repeat(64)}`,
        stopsActionId: 'action',
        stopsDelegationId: 'delegation',
        targetSessionId: 'target',
        targetMessageId: 'message',
        targetSessionName: 'Release',
        userText: 'Stop the selected task',
        ...(modern ? { taskStop: true, workId: 'action', executionBinding: 'root-binding' } : {}),
      });
      const modern =
        scenario === 'modern' ||
        scenario === 'mixed-modern' ||
        scenario === 'delivered' ||
        scenario === 'later-pending';
      const pending = scenario === 'later-pending';
      const matched = request('matched-stop', modern);
      const mixed = scenario.startsWith('mixed-');
      const primary = mixed || pending ? request('earlier-stop', pending || !modern) : matched;
      const observed = pending ? primary : matched;
      const resolution: import('@maka/core/session').WorkHubDelegationStopResolvedMessage = {
        type: 'workhub_coordination',
        kind: 'delegation_stop_resolved',
        schemaVersion: 3,
        id: 'resolution',
        turnId: 'coordinator-turn',
        coordinationTurnId: 'coordinator-turn',
        ts: 2,
        actionId: observed.actionId,
        actionFingerprint: observed.actionFingerprint,
        stopsActionId: 'action',
        stopsDelegationId: 'delegation',
        targetSessionId: 'target',
        targetTurnId: 'target-turn',
        outcome: scenario === 'delivered' ? 'stop_delivered' : 'already_terminal',
      };
      if (scenario === 'delivered') f.setStatus('cancelled');
      f.setStopRecords(primary, resolution, mixed || pending ? matched : undefined);
      const result = await f.handlers['workhub.tasks.read'](
        { actionId: 'action', delegationId: 'delegation' },
        {} as never,
      );
      assert.ok(result.ok);
      const noop = modern && scenario !== 'delivered' && !pending;
      assert.equal(
        result.result.task.status,
        pending ? 'stopping' : noop ? 'pending_acceptance' : 'stopped',
      );
      assert.equal(result.result.delivery !== undefined, noop);
      await f.reconcile();
      assert.equal(f.notifications.length, noop ? 1 : 0);
    },
  );

function fixture(childRequest = false) {
  let overviewVisible = true;
  const latestLookups: string[] = [];
  let active = true,
    stopped = false;
  let stopResolved = false;
  let stopRequest: import('@maka/core/session').WorkHubDelegationStopRequestedMessage | undefined;
  let stopResolution: import('@maka/core/session').WorkHubDelegationStopResolvedMessage | undefined;
  let secondaryStopRequest: typeof stopRequest;
  let requests = true;
  let childOwned = true;
  let status = 'waiting_for_user';
  let disposition: 'owned_root' | 'cancelled' | 'shared_turn' | 'pending' = 'owned_root';
  let resultReads = 0;
  let waitReason: 'concurrency' | 'workspace' | undefined;
  let tip = { sessionId: 'target', turnId: 'target-turn', runId: 'target-run' };
  let dependency:
    | import('../server/workhub-result-coordinator.js').WorkHubResultObservation
    | undefined;
  const closedRelays: unknown[] = [];
  const coordinatorPending: import('@maka/storage/interaction-store').StoredInteractionRequest[] =
    [];
  const relayEvents: import('@maka/core/runtime-event').RuntimeEvent[] = [];
  const assignment = {
    ts: 1,
    userText: 'Release task',
    targetSessionName: 'Release',
    taskTitle: 'Shipping checklist',
    targetTurnId: 'target-turn',
    actionId: 'action',
    delegationId: 'delegation',
    targetSessionId: 'target',
    targetMessageId: 'message',
    returnResults: true,
  };
  let latestInput = assignment.userText;
  let inputReads = 0;
  const notifications: string[] = [];
  const questions = [
    {
      question: 'When should the release go out?',
      options: [{ label: 'Friday' }, { label: 'Monday' }],
    },
  ];
  const record = {
    requestId: 'question',
    sessionId: childRequest ? 'child' : 'target',
    turnId: childRequest ? 'child-turn' : 'target-turn',
    runId: childRequest ? 'child-run' : 'target-run',
    request: { kind: 'question', toolUseId: 'question-tool', questions },
    createdAt: 1,
  };
  const admission = new SessionAdmissionGate();
  const forwarded: unknown[] = [];
  const startWorkHubResult: Options['executions']['startWorkHubResult'] = async (
    _origin,
    prepare,
  ) => {
    const content = await prepare({} as SessionAdmissionLease);
    if (content) notifications.push(content.text);
    return 'delivered';
  };
  const runtime = createWorkHubResultRuntime({
    evidence: {
      taskExecution: async () => ({ ...tip, round: 0 }),
      waitingObservation: async () => dependency,
    },
    // Each stub is an external authority; use the real admission gate and tool.
    stores: {
      sessionStore: {
        listHeaders: async () =>
          overviewVisible
            ? [
                { id: 'target', isArchived: false, labels: [] },
                ...(childRequest
                  ? [
                      {
                        id: 'child',
                        isArchived: false,
                        labels: [],
                        subagentParent: { parentSessionId: 'target' },
                      },
                    ]
                  : []),
              ]
            : [],
        readWorkHubAssignment: async () => assignment,
        readLatestWorkHubAssignment: async (workId: string) => {
          latestLookups.push(workId);
          return workId === assignment.actionId ? assignment : undefined;
        },
        readWorkHubAssignmentsPage: async () =>
          assert.fail('Exact task lookup must not scan global assignment history'),
        readHeaderSnapshot: async (id: string) =>
          id === 'child'
            ? {
                id: 'child',
                name: 'Child',
                isArchived: false,
                subagentSpawn: {
                  schemaVersion: 1,
                  requestFingerprint: 'spawn',
                  initialTurnId: 'child-turn',
                  initialRunId: 'child-run',
                },
                subagentParent: {
                  kind: 'subagent',
                  parentSessionId: 'target',
                  spawnedBy: {
                    parentTurnId: 'target-turn',
                    parentRunId: 'target-run',
                    toolCallId: 'spawn',
                  },
                },
              }
            : { id: 'target', name: 'Release', isArchived: false },
        readActiveWorkHubAssignmentsByTarget: async () => (active ? [assignment] : []),
        readWorkHubReplacement: async () => undefined,
        readWorkHubStopRequest: async (_delegationId: string, actionId?: string, latest?: true) =>
          (latest && secondaryStopRequest) ||
          (actionId && secondaryStopRequest?.actionId === actionId)
            ? secondaryStopRequest
            : (stopRequest ?? (stopped ? {} : undefined)),
        readWorkHubStopResolution: async (_id: string, actionId?: string) =>
          actionId && stopResolution?.actionId !== actionId
            ? undefined
            : (stopResolution ?? (stopResolved ? { outcome: 'stop_delivered' } : undefined)),
        listPendingSandboxBoundaryRequests: async () => [],
      },
      interactionStore: {
        listSessionPending: async (sessionId: string) =>
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? coordinatorPending
            : requests && record.sessionId === sessionId
              ? [record]
              : [],
      },
      runtimeEventStore: {
        readRunInvocation: async (sessionId: string, runId: string) => ({
          sessionId,
          runId,
          turnId: sessionId === 'child' ? 'child-turn' : 'target-turn',
          invocationId: 'inv-' + runId,
          opening: { source: { kind: 'fresh' } },
        }),
        readImmutableRuntimeEvents: async (sessionId: string, runId: string) =>
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? relayEvents.filter((event) => event.runId === runId)
            : [],
      },
      agentRunStore: {
        readRootTurnAdmission: async (sessionId: string, turnId: string) => ({
          sessionId,
          turnId,
          runId: 'child-run',
          execution: { kind: childOwned ? 'linked_child_initial' : 'external_message' },
        }),
      },
    } as unknown as Options['stores'],
    executions: {
      readWorkHubDispatchWait: () => waitReason,
      startWorkHubResult,
      readLatestRootTurnLineage: async (identity: {
        sessionId: string;
        turnId: string;
        runId: string;
      }) => identity,
      read: async () => ({ status, terminalEventId: 'terminal' }),
    } as unknown as Options['executions'],
    messages: {
      readMessageExecutionDispositionAdmitted: async () =>
        disposition === 'cancelled'
          ? { kind: 'cancelled' }
          : { kind: disposition, turnId: 'target-turn', runId: 'target-run' },
    } as unknown as Options['messages'],
    interactions: {
      answerAdmitted: async (input, lease, ...extra) =>
        admission.runAdmitted(input.sessionId, lease, async () => {
          assert.equal(extra.length, 0, 'No task-level grant is created or attached');
          forwarded.push(input);
          if (input.answer.kind === 'permission')
            return {
              ok: false,
              error: { code: 'operation_conflict', message: 'No live permission continuation' },
            };
          requests = false;
          return { ok: true, result: { status: 'answered' } };
        }),
      closeLegacyWorkHubRelay: async (identity) => {
        closedRelays.push(identity);
        const index = coordinatorPending.findIndex(
          (request) =>
            request.requestId === identity.requestId &&
            request.sessionId === identity.sessionId &&
            request.turnId === identity.turnId &&
            request.runId === identity.runId &&
            request.request.kind === 'question' &&
            request.request.toolUseId === identity.toolUseId,
        );
        if (index < 0) return false;
        coordinatorPending.splice(index, 1);
        return true;
      },
    } as Options['interactions'],
    readTurnResult: async (sessionId, turnId) => {
      assert.equal(sessionId, 'target');
      assert.equal(turnId, tip.turnId);
      resultReads++;
      return '😀'.repeat(16001);
    },
    readTurnInput: async (sessionId, turnId) => {
      assert.equal(sessionId, 'target');
      assert.equal(turnId, tip.turnId);
      inputReads++;
      return latestInput;
    },
    admission,
    acquireResidency: () => ({ release() {} }),
    onError: (error) => {
      throw error;
    },
  });
  return {
    latestLookups,
    hideFromOverview: () => {
      overviewVisible = false;
    },
    setChildOwned: (value: boolean) => {
      childOwned = value;
    },
    setWaitReason: (value: typeof waitReason) => {
      waitReason = value;
    },
    setTip: (value: typeof tip) => {
      tip = value;
    },
    setDependency: (value: typeof dependency) => {
      dependency = value;
    },
    handlers: runtime.handlers,
    coordinatorPending,
    relayEvents,
    retireLegacy: runtime.retireLegacy,
    questions,
    forwarded,
    closedRelays,
    resultReads: () => resultReads,
    inputReads: () => inputReads,
    notifications,
    setLatestInput: (text: string) => {
      latestInput = text;
    },
    notify: runtime.notify,
    reconcile: () => runtime.coordinator.reconcile(),
    setOriginalAnswered: () => {
      requests = false;
      status = 'completed';
    },
    setDisposition: (value: typeof disposition) => {
      disposition = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setStopped: () => {
      stopped = true;
    },
    setStopResolved: () => {
      stopResolved = true;
    },
    setStopRecords: (
      primary: NonNullable<typeof stopRequest>,
      resolution: NonNullable<typeof stopResolution>,
      secondary?: typeof stopRequest,
    ) => {
      stopRequest = primary;
      stopResolution = resolution;
      secondaryStopRequest = secondary;
    },
    setRunning: () => {
      status = 'running';
      requests = false;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setCompleted: () => {
      status = 'completed';
    },
    record,
  };
}

test('delivered terminal events do not reread the target transcript on reconciliation', async () => {
  const f = fixture();
  f.setCompleted();
  await f.reconcile();
  await f.reconcile();
  assert.equal(f.resultReads(), 1);
});

test('a message cancelled before execution remains cancelled without reading a delivery', async () => {
  const f = fixture();
  f.setDisposition('cancelled');
  const result = await f.handlers['workhub.tasks.read']({ workId: 'action' }, {} as never);
  assert.ok(result.ok);
  assert.equal(result.result.task.status, 'cancelled');
  assert.equal(result.result.delivery, undefined);
  assert.equal(f.resultReads(), 0);
});
const inboxContext = {} as import('../server/operation-dispatcher.js').ConnectionContext;
const inboxAnswer = {
  actionId: 'action',
  interactionId: 'question',
  expectedTurnId: 'target-turn',
  expectedRunId: 'target-run',
  answer: { kind: 'question' as const, answers: ['Monday'] },
};
test('WorkHub inbox derives and answers the original request without a coordinator question', async () => {
  const f = fixture();
  const queried = await f.handlers['workhub.interactions.query']({}, inboxContext);
  assert.ok(queried.ok);
  assert.equal(queried.result.requests.length, 1);
  assert.equal(queried.result.requests[0]!.interaction.sessionId, 'target');
  assert.deepEqual(queried.result.requests[0]!.interaction.request, f.record.request);
  assert.ok((await f.handlers['workhub.interactions.answer'](inboxAnswer, inboxContext)).ok);
  assert.deepEqual(f.forwarded, [
    { sessionId: 'target', interactionId: 'question', answer: inboxAnswer.answer },
  ]);
  assert.equal(f.closedRelays.length, 0);
  assert.equal(
    (await f.handlers['workhub.interactions.answer'](inboxAnswer, inboxContext)).ok,
    false,
  );
  assert.equal(f.forwarded.length, 1);
});
test('WorkHub inbox rejects old Runs, unrelated Turns, unowned messages, Stop and replacement', async () => {
  for (const retire of [
    (f: ReturnType<typeof fixture>) => {
      f.record.runId = 'old-run';
    },
    (f: ReturnType<typeof fixture>) => {
      f.record.turnId = 'manual-turn';
    },
    (f: ReturnType<typeof fixture>) => f.setDisposition('shared_turn'),
    (f: ReturnType<typeof fixture>) => f.setDisposition('pending'),
    (f: ReturnType<typeof fixture>) => f.setDisposition('cancelled'),
    (f: ReturnType<typeof fixture>) => f.setActive(false),
    (f: ReturnType<typeof fixture>) => f.setStopped(),
    (f: ReturnType<typeof fixture>) => f.setCompleted(),
  ]) {
    const f = fixture();
    retire(f);
    const queried = await f.handlers['workhub.interactions.query']({}, inboxContext);
    assert.ok(queried.ok);
    assert.deepEqual(queried.result.requests, []);
    assert.equal(
      (await f.handlers['workhub.interactions.answer'](inboxAnswer, inboxContext)).ok,
      false,
    );
    assert.equal(f.forwarded.length, 0);
  }
});
test('WorkHub inbox rechecks the exact execution and kind instead of trusting a stale card', async () => {
  const f = fixture();
  assert.ok((await f.handlers['workhub.interactions.query']({}, inboxContext)).ok);
  for (const patch of [
    { expectedRunId: 'other-host-run' },
    { expectedTurnId: 'old-turn' },
    { interactionId: 'another-question' },
    { answer: { kind: 'sandbox_boundary' as const, decision: 'deny' as const } },
  ])
    assert.equal(
      (await f.handlers['workhub.interactions.answer']({ ...inboxAnswer, ...patch }, inboxContext))
        .ok,
      false,
    );
  f.setStopped();
  assert.equal(
    (await f.handlers['workhub.interactions.answer'](inboxAnswer, inboxContext)).ok,
    false,
  );
  assert.equal(f.forwarded.length, 0);
});
test('WorkHub inbox sends original sandbox and capability answers without supplemental grants', async () => {
  const answers: import('../protocol/interaction.js').InteractionAnswer[] = [
    { kind: 'sandbox_boundary', decision: 'allow' },
    { kind: 'sandbox_boundary', decision: 'deny' },
    { kind: 'client_capability', decision: 'allow' },
    { kind: 'client_capability', decision: 'deny' },
  ];
  for (const answer of answers) {
    const f = fixture();
    f.record.request.kind = answer.kind;
    const outcome = await f.handlers['workhub.interactions.answer'](
      { ...inboxAnswer, answer },
      inboxContext,
    );
    assert.ok(outcome.ok);
    assert.deepEqual(f.forwarded, [{ sessionId: 'target', interactionId: 'question', answer }]);
  }
});

test('historical permission payloads keep their options and propagate the original native conflict', async () => {
  const answers: import('../protocol/interaction.js').InteractionAnswer[] = [
    { kind: 'permission', decision: 'allow', rememberForTurn: false },
    { kind: 'permission', decision: 'allow', rememberForTurn: true },
    { kind: 'permission', decision: 'deny', rememberForTurn: false },
  ];
  for (const answer of answers) {
    const f = fixture();
    f.record.request.kind = answer.kind;
    const outcome = await f.handlers['workhub.interactions.answer'](
      { ...inboxAnswer, answer },
      inboxContext,
    );
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.error.code, 'operation_conflict');
    assert.deepEqual(f.forwarded, [{ sessionId: 'target', interactionId: 'question', answer }]);
    assert.equal(f.notifications.length, 0);
  }
});

test('linked-child inbox answers stay bound to the original child request and exact root ancestry', async () => {
  const f = fixture(true);
  const queried = await f.handlers['workhub.interactions.query']({}, inboxContext);
  assert.ok(queried.ok);
  assert.equal(queried.result.requests[0]!.interaction.sessionId, 'child');
  const answer = { ...inboxAnswer, expectedTurnId: 'child-turn', expectedRunId: 'child-run' };
  assert.ok((await f.handlers['workhub.interactions.answer'](answer, inboxContext)).ok);
  assert.deepEqual(f.forwarded, [
    { sessionId: 'child', interactionId: 'question', answer: answer.answer },
  ]);
  const manual = fixture(true);
  manual.setChildOwned(false);
  assert.equal(
    (await manual.handlers['workhub.interactions.answer'](answer, inboxContext)).ok,
    false,
  );
  assert.deepEqual(manual.forwarded, []);
});

test('canonical task title is independent of the target Session display name', async () => {
  const f = fixture();
  const result = await f.handlers['workhub.tasks.read']({ workId: 'action' }, inboxContext);
  assert.ok(result.ok);
  assert.equal(result.result.task.title, 'Shipping checklist');
  assert.equal(result.result.task.targetSessionName, 'Release');
});

test('waiting notifications identify originals without copying question or approval bodies', async () => {
  const f = fixture();
  await f.reconcile();
  assert.equal(f.notifications.length, 1);
  assert(!f.notifications[0]!.includes('When should the release go out?'));
  assert(!f.notifications[0]!.includes('Friday'));
  assert.deepEqual(f.forwarded, []);
});

function addLegacyRelay(f: ReturnType<typeof fixture>) {
  const pending: import('@maka/storage/interaction-store').StoredInteractionRequest = {
    requestId: 'relay-question',
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 'coordinator-turn',
    runId: 'coordinator-run',
    createdAt: 2,
    request: { kind: 'question', toolUseId: 'relay-tool', questions: f.questions },
  };
  const event: import('@maka/core/runtime-event').RuntimeEvent = {
    id: 'relay-call',
    invocationId: 'coordinator-invocation',
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: pending.turnId,
    runId: pending.runId,
    ts: 1,
    role: 'model',
    author: 'agent',
    partial: false,
    content: {
      kind: 'function_call',
      id: 'relay-tool',
      name: 'WorkHubResult',
      args: { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
    },
  };
  f.coordinatorPending.push(pending);
  f.relayEvents.push(event);
  return { pending, event };
}

test('relay retirement delegates only proven coordinator identities to the lifecycle closure, idempotently', async () => {
  const f = fixture();
  addLegacyRelay(f);
  f.coordinatorPending.push({
    ...f.coordinatorPending[0]!,
    requestId: 'ordinary-question',
    request: { kind: 'question', toolUseId: 'ordinary-question-tool', questions: f.questions },
  });
  assert.deepEqual(await f.retireLegacy(), { closed: 1 });
  assert.deepEqual(await f.retireLegacy(), { closed: 0 });
  assert.deepEqual(f.closedRelays, [
    {
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      turnId: 'coordinator-turn',
      runId: 'coordinator-run',
      requestId: 'relay-question',
      toolUseId: 'relay-tool',
    },
  ]);
  assert.equal(f.coordinatorPending[0]!.requestId, 'ordinary-question');
  const originals = await f.handlers['workhub.interactions.query']({}, inboxContext);
  assert.ok(originals.ok);
  assert.equal(originals.result.requests[0]!.interaction.interactionId, 'question');
  assert.deepEqual(f.forwarded, []);
});

test('relay retirement requires the exact persisted producer Session, Turn, Run, call and ask operation', async () => {
  const patches: Partial<import('@maka/core/runtime-event').RuntimeEvent>[] = [
    { sessionId: 'worker' },
    { turnId: 'another-turn' },
    { runId: 'another-run' },
    { partial: true },
    { role: 'tool' },
    {
      content: {
        kind: 'function_call',
        id: 'other-call',
        name: 'WorkHubResult',
        args: { operation: 'ask_question' },
      },
    },
    { content: { kind: 'function_call', id: 'relay-tool', name: 'AskUserQuestion', args: {} } },
    {
      content: {
        kind: 'function_call',
        id: 'relay-tool',
        name: 'WorkHubResult',
        args: { operation: 'read' },
      },
    },
  ];
  for (const patch of patches) {
    const f = fixture(),
      { event } = addLegacyRelay(f);
    Object.assign(event, patch);
    assert.deepEqual(await f.retireLegacy(), { closed: 0 });
    assert.deepEqual(f.closedRelays, []);
    assert.deepEqual(f.forwarded, []);
  }
});

test('ambiguous persisted legacy producers fail closed without answering or closing any request', async () => {
  const f = fixture();
  const { event } = addLegacyRelay(f);
  f.relayEvents.push({ ...event, id: 'duplicate-producer' });
  await assert.rejects(f.retireLegacy(), /Ambiguous legacy WorkHub question producer/);
  assert.deepEqual(f.closedRelays, []);
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.coordinatorPending.length, 1);
});
