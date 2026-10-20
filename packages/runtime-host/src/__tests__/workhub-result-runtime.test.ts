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
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubReplacementIntentRetired,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationReplacementRequestedMessage,
  type WorkHubDelegationReplacementAbortedMessage,
} from '@maka/core/session';
import { SessionNotFoundError } from '@maka/storage/session-store';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { createWorkHubResultRuntime } from '../server/workhub-result-runtime.js';
import { createWorkHubReadTool } from '../server/workhub-read-tool.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';

type Options = Parameters<typeof createWorkHubResultRuntime>[0];

test('indexed task projection only preserves a retired intent bound to its original assignment', async () => {
  for (const wrongSource of [false, true]) {
    const f = fixture();
    const source = f.assignment;
    const request: WorkHubDelegationReplacementRequestedMessage = {
      type: 'workhub_coordination',
      kind: 'delegation_replacement_requested',
      schemaVersion: 2,
      id: 'legacy-intent',
      turnId: 'legacy-turn',
      coordinationTurnId: 'legacy-turn',
      ts: 1,
      actionId: 'legacy-action',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      targetSessionId: 'unused-target',
      targetSessionName: 'Unused target',
      disposition: 'delegate_existing',
      userText: 'Legacy replacement intent',
      replacesActionId: source.actionId,
      replacesDelegationId: source.delegationId,
      replacedTargetSessionId: source.targetSessionId,
      replacedTargetMessageId: wrongSource ? 'foreign-message' : source.targetMessageId,
    };
    f.setReplacement(request, {
      type: 'workhub_coordination',
      kind: 'delegation_replacement_aborted',
      schemaVersion: 2,
      id: 'legacy-abort',
      turnId: request.turnId,
      coordinationTurnId: request.coordinationTurnId,
      ts: 2,
      actionId: request.actionId,
      actionFingerprint: request.actionFingerprint,
      abortedActionId: source.actionId,
      abortedDelegationId: source.delegationId,
      targetSessionId: request.targetSessionId,
      reason: 'legacy_protocol_retirement',
    });
    const task = await f.projectTask();
    if (wrongSource) assert.equal(task, undefined);
    else {
      assert.equal(task?.task.workId, source.actionId);
      assert.equal(task?.task.status, 'waiting_for_user');
      assert.equal(task?.task.targetMessageId, source.targetMessageId);
    }
    assert.equal(f.forwarded.length + f.closedRelays.length, 0);
    assert.equal(f.questions.length, 1, 'the original unanswered question remains intact');
  }
});

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
  f.setDependency({
    turnId: 'evidence-turn',
    runId: 'evidence-run',
    sharedTurn: false,
    eventKey: 'legacy-retirement',
    status: 'cancelled',
    result: 'Legacy wait retired by Host',
    details: { requestId: 'request', origin: 'legacy_protocol_retirement' },
  });
  const retired = await query();
  assert.equal(retired.status, 'cancelled');
  assert.equal(retired.dependency, undefined, 'a retired wait is not an active dependency');
  f.setDependency({
    turnId: 'evidence-turn',
    runId: 'evidence-run',
    sharedTurn: false,
    eventKey: 'legacy-wait',
    status: 'waiting_for_dependency',
    result: 'Legacy wait awaits Host retirement',
    details: { requestId: 'request', origin: 'legacy_wait' },
  });
  assert.equal((await query()).dependency?.question, 'Legacy wait awaits Host retirement');
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
  let replacement: WorkHubDelegationReplacementRequestedMessage | undefined;
  let replacementAbort: WorkHubDelegationReplacementAbortedMessage | undefined;
  let requests = true;
  let childOwned = true;
  let status = 'waiting_for_user';
  let disposition: 'owned_root' | 'cancelled' | 'shared_turn' | 'pending' = 'owned_root';
  let resultReads = 0;
  let resultText = '😀'.repeat(16001);
  let targetMissing = false;
  let onReadResult = () => {};
  let onReadAssignment = () => {};
  let waitReason: 'concurrency' | 'workspace' | undefined;
  let tip = { sessionId: 'target', turnId: 'target-turn', runId: 'target-run' };
  let dependency:
    | import('../server/workhub-result-coordinator.js').WorkHubResultObservation
    | undefined;
  const closedRelays: unknown[] = [];
  const coordinatorPending: import('@maka/storage/interaction-store').StoredInteractionRequest[] =
    [];
  const relayEvents: import('@maka/core/runtime-event').RuntimeEvent[] = [];
  const context: MakaToolContext = {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 'coordinator-turn',
    runId: 'coordinator-run',
    invocationId: 'coordinator-invocation',
    toolCallId: 'read-call',
    cwd: '/workspace',
    emitOutput() {},
    abortSignal: new AbortController().signal,
  };
  const coordinatorRun = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    runId: context.runId!,
    invocationId: context.invocationId!,
    opening: { source: { kind: 'fresh' }, root: { kind: 'user' } },
  };
  const coordinatorAdmission = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    runId: context.runId!,
    execution: { kind: 'workhub_coordination' },
  };
  const coordinatorRoot = {
    kind: 'active',
    sessionId: context.sessionId,
    turnId: context.turnId,
    runId: context.runId!,
  };
  const assignment: WorkHubDelegationAssignedMessage = {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 1,
    id: 'assignment',
    turnId: 'coordinator-turn',
    coordinationTurnId: 'coordinator-turn',
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    disposition: 'delegate_existing',
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
        readWorkHubAssignment: async (actionId: string) => {
          onReadAssignment();
          return actionId === assignment.actionId ? assignment : undefined;
        },
        readLatestWorkHubAssignment: async (workId: string) => {
          latestLookups.push(workId);
          return workId === assignment.actionId ? assignment : undefined;
        },
        readWorkHubAssignmentsPage: async () =>
          assert.fail('Exact task lookup must not scan global assignment history'),
        readHeaderSnapshot: async (id: string) => {
          if (id === 'target' && targetMissing) throw new SessionNotFoundError(id);
          return id === 'child'
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
            : { id: 'target', name: 'Release', isArchived: false };
        },
        readActiveWorkHubAssignmentsByTarget: async () => (active ? [assignment] : []),
        readWorkHubReplacement: async (_id: string, pendingOnly?: true) =>
          pendingOnly &&
          replacement &&
          isWorkHubReplacementIntentRetired(replacement, replacementAbort)
            ? undefined
            : replacement,
        readWorkHubReplacementAbort: async () => replacementAbort,
        readWorkHubSupersession: async () => undefined,
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
        readRunInvocation: async (sessionId: string, runId: string) =>
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? runId === coordinatorRun.runId
              ? coordinatorRun
              : undefined
            : {
                sessionId,
                runId,
                turnId: sessionId === 'child' ? 'child-turn' : 'target-turn',
                invocationId: 'inv-' + runId,
                opening: { source: { kind: 'fresh' } },
              },
        readImmutableRuntimeEvents: async (sessionId: string, runId: string) =>
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? relayEvents.filter((event) => event.runId === runId)
            : [],
      },
      agentRunStore: {
        readRootTurnAdmission: async (sessionId: string, turnId: string) =>
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? turnId === coordinatorAdmission.turnId
              ? coordinatorAdmission
              : undefined
            : {
                sessionId,
                turnId,
                runId: 'child-run',
                execution: { kind: childOwned ? 'linked_child_initial' : 'external_message' },
              },
      },
    } as unknown as Options['stores'],
    executions: {
      readRootState: (sessionId: string) =>
        sessionId === WORKHUB_COORDINATION_SESSION_ID ? coordinatorRoot : { kind: 'idle' },
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
      onReadResult();
      return resultText;
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
    context,
    coordinatorRun,
    coordinatorAdmission,
    coordinatorRoot,
    assignment,
    projectTask: () => runtime.projectTask(assignment),
    setReplacement: (
      request: WorkHubDelegationReplacementRequestedMessage,
      abort: WorkHubDelegationReplacementAbortedMessage,
    ) => {
      replacement = request;
      replacementAbort = abort;
    },
    readResult: (input: Parameters<typeof runtime.readResult>[0], ctx = context) =>
      runtime.readResult(input, ctx),
    forbidWake: () => {
      runtime.coordinator.notify = () => assert.fail('Result reads must not wake the coordinator');
    },
    setResultText: (text: string) => {
      resultText = text;
    },
    setTargetMissing: () => {
      targetMissing = true;
    },
    onReadResult: (hook: () => void) => {
      onReadResult = hook;
    },
    onReadAssignment: (hook: () => void) => {
      onReadAssignment = hook;
    },
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

test('pure result reads return complete Unicode pages and an exact full-result execution key without waking work', async () => {
  const f = fixture();
  f.forbidWake();
  f.hideFromOverview();
  f.setCompleted();
  const first = await f.readResult({ actionId: 'action' });
  assert.ok(first.status === 'completed');
  assert.deepEqual(
    [first.targetSessionId, first.turnId, first.runId, first.eventKey, first.sharedTurn],
    ['target', 'target-turn', 'target-run', 'terminal', false],
  );
  assert.equal(Array.from(first.result).length, 16000);
  assert.ok(Buffer.byteLength(first.result) > 16 * 1024, 'Full results are not task-card excerpts');
  assert.equal(first.nextOffset, 16000);
  const last = await f.readResult({ actionId: 'action', offset: first.nextOffset });
  assert.ok(last.status === 'completed');
  assert.equal(last.result, '😀');
  assert.equal(last.nextOffset, null);
  assert.equal(first.result + last.result, '😀'.repeat(16001));
  const end = await f.readResult({ actionId: 'action', offset: 16001 });
  assert.ok(end.status === 'completed');
  assert.equal(end.result, '');
  assert.equal(end.nextOffset, null);
  await assert.rejects(
    f.readResult({ actionId: 'action', offset: 16002 }),
    /offset is out of bounds/u,
  );
  for (const raw of [
    { actionId: 'action', offset: -1 },
    { actionId: 'action', offset: 0.5 },
    { actionId: 'action', offset: Number.NaN },
    { actionId: 'action', offset: Number.POSITIVE_INFINITY },
    { actionId: 'action', offset: Number.MAX_SAFE_INTEGER + 1 },
    { actionId: 'action', operation: 'read' },
    { actionId: 'action', answer: { kind: 'permission', decision: 'allow' } },
  ])
    await assert.rejects(f.readResult(raw));
  f.setResultText('');
  const empty = await f.readResult({ actionId: 'action' });
  assert.ok(empty.status === 'completed');
  assert.equal(empty.result, '');
  assert.equal(empty.nextOffset, null);
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.forwarded, []);
  assert.deepEqual(f.closedRelays, []);
});

test('unified read wraps pure full-result pages and refuses crossing a changed execution', async () => {
  const f = fixture();
  f.forbidWake();
  f.setCompleted();
  const source = f.assignment as unknown as WorkHubDelegationAssignedMessage;
  const unexpected = async () =>
    assert.fail('Full result reads must not use another read envelope');
  const tool = createWorkHubReadTool({
    sessions: {
      readWorkHubAssignment: async () => source,
      readLatestWorkHubAssignment: async () => source,
      readHeaderSnapshot: async () => ({ labels: [] }) as never,
      readWorkHubTaskFactsPage: unexpected,
    },
    admission: new SessionAdmissionGate(),
    authorize: async () => undefined,
    status: unexpected,
    result: f.readResult,
    evidence: unexpected,
    catalog: unexpected,
    history: unexpected,
    inspect: unexpected,
  });
  const first = (await tool.impl({ taskId: 'action', view: 'result' }, f.context)) as {
    targetSessionId: string;
    result: string;
    nextCursor: string;
  };
  assert.equal(first.targetSessionId, 'target');
  assert.equal(Array.from(first.result).length, 16000);
  assert.equal(typeof first.nextCursor, 'string');
  const next = (await tool.impl(
    { taskId: 'action', view: 'result', cursor: first.nextCursor },
    f.context,
  )) as {
    result: string;
    nextCursor: null;
  };
  assert.equal(next.result, '😀');
  assert.equal(next.nextCursor, null);
  f.setTip({ sessionId: 'target', turnId: 'new-turn', runId: 'new-run' });
  await assert.rejects(
    Promise.resolve().then(() =>
      tool.impl(
        {
          taskId: 'action',
          view: 'result',
          cursor: first.nextCursor,
        },
        f.context,
      ),
    ),
    /Task result execution changed/u,
  );
  assert.deepEqual(f.notifications, []);
});

test('pure result reads retain terminal status, continuation identity and shared-Turn metadata', async () => {
  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    const f = fixture();
    f.forbidWake();
    f.setStatus(status);
    f.setTip({ sessionId: 'target', turnId: 'continued-turn', runId: 'continued-run' });
    f.setResultText('Exact committed result');
    f.setLatestInput('Keep the later correction');
    const result = await f.readResult({ actionId: 'action', offset: 0 });
    assert.ok('nextOffset' in result);
    assert.equal(result.status, status);
    assert.equal(result.targetSessionId, 'target');
    assert.equal(result.turnId, 'continued-turn');
    assert.equal(result.runId, 'continued-run');
    assert.equal(result.eventKey, 'terminal');
    assert.equal(result.result, 'Exact committed result');
    assert.equal(result.latestUserInput, 'Keep the later correction');
    assert.deepEqual(
      result.details,
      status === 'failed'
        ? { failureClass: null, message: null }
        : status === 'cancelled'
          ? { abortSource: null }
          : null,
    );
    assert.equal(result.nextOffset, null);
    assert.deepEqual(f.notifications, []);
  }
  const shared = fixture();
  shared.setCompleted();
  shared.setDisposition('shared_turn');
  const result = await shared.readResult({ actionId: 'action' });
  assert.ok('sharedTurn' in result);
  assert.equal(result.sharedTurn, true);
  assert.equal(shared.inputReads(), 0);
});

test('pure result reads preserve pending, obsolete, missing and no-result-opt-in behavior without dispatch', async () => {
  for (const setup of [
    (f: ReturnType<typeof fixture>) => f.setDisposition('pending'),
    (f: ReturnType<typeof fixture>) => f.setRunning(),
    (f: ReturnType<typeof fixture>) => {
      f.record.runId = 'previous-run';
    },
  ]) {
    const f = fixture();
    f.forbidWake();
    setup(f);
    assert.deepEqual(await f.readResult({ actionId: 'action' }), {
      status: 'pending',
      targetSessionId: 'target',
      message:
        'No result is ready yet. The Host will automatically notify WorkHub when a result or user question is available. Acknowledge the delegation and end this response; do not poll tools to wait.',
    });
    assert.equal(f.resultReads(), 0);
    assert.deepEqual(f.notifications, []);
  }
  for (const setup of [
    (f: ReturnType<typeof fixture>) => f.setActive(false),
    (f: ReturnType<typeof fixture>) => f.setStopped(),
    (f: ReturnType<typeof fixture>) => f.setTargetMissing(),
  ]) {
    const f = fixture();
    f.forbidWake();
    setup(f);
    assert.deepEqual(await f.readResult({ actionId: 'action' }), {
      status: 'obsolete',
      targetSessionId: 'target',
    });
    assert.equal(f.resultReads(), 0);
    assert.deepEqual(f.notifications, []);
  }
  const f = fixture();
  await assert.rejects(f.readResult({ actionId: 'missing' }), /Unknown WorkHub result assignment/u);
  delete f.assignment.returnResults;
  await assert.rejects(f.readResult({ actionId: 'action' }), /Unknown WorkHub result assignment/u);
  assert.equal(f.resultReads(), 0);
  const cancelled = fixture();
  cancelled.setDisposition('cancelled');
  const result = await cancelled.readResult({ actionId: 'action' });
  assert.ok(result.status === 'cancelled');
  assert.equal(result.eventKey, 'message_cancelled_before_execution');
  assert.equal(result.runId, 'message:message');
  assert.equal(cancelled.resultReads(), 0);
});

test('reading a pending question or approval keeps the original request and never asks, answers or grants', async () => {
  for (const kind of ['question', 'form', 'permission', 'sandbox_boundary', 'client_capability']) {
    const f = fixture();
    f.forbidWake();
    f.record.request.kind = kind;
    const original = structuredClone(f.record);
    const result = await f.readResult(
      { actionId: 'action' },
      {
        ...f.context,
        askUserQuestion: async () => assert.fail('A read cannot forward a question or approval'),
      },
    );
    assert.ok(result.status === 'waiting_for_user');
    assert.deepEqual(result.details, [{ interactionId: 'question', kind }]);
    assert(!result.result.includes(f.questions[0]!.question));
    assert.deepEqual(f.record, original);
    assert.equal(f.resultReads(), 0);
    assert.deepEqual(f.forwarded, []);
    assert.deepEqual(f.closedRelays, []);
    assert.deepEqual(f.notifications, []);
  }
});

test('pure result reader rejects foreign, stale, non-WorkHub and terminated coordinator invocations', async () => {
  for (const patch of [
    { sessionId: 'worker' },
    { turnId: 'old-turn' },
    { runId: 'old-run' },
    { invocationId: 'old-invocation' },
    { runId: undefined },
    { invocationId: undefined },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.readResult({ actionId: 'action' }, { ...f.context, ...patch }),
      /coordination|root invocation/u,
    );
    assert.equal(f.resultReads(), 0);
  }
  for (const retire of [
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorAdmission.execution.kind = 'external_message';
    },
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorAdmission.runId = 'old-run';
    },
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorRoot.kind = 'idle';
    },
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorRoot.turnId = 'another-turn';
    },
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorRoot.runId = 'another-run';
    },
    (f: ReturnType<typeof fixture>) => {
      f.coordinatorRun.opening.root.kind = 'agent';
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.coordinatorRun, { terminalEvent: {} });
    },
  ]) {
    const f = fixture();
    retire(f);
    await assert.rejects(f.readResult({ actionId: 'action' }), /coordination|root invocation/u);
    assert.equal(f.resultReads(), 0);
  }
  const stale = fixture();
  stale.onReadAssignment(() => {
    stale.coordinatorRoot.kind = 'idle';
  });
  await assert.rejects(stale.readResult({ actionId: 'action' }), /coordination authority/u);
  assert.equal(stale.resultReads(), 0);
});

test('pure result reader observes cancellation before and during a full read without side effects', async () => {
  for (const duringRead of [false, true]) {
    const f = fixture();
    f.setCompleted();
    f.forbidWake();
    const abort = new AbortController();
    const cancel = () => abort.abort(new Error('Result read cancelled'));
    if (duringRead) f.onReadResult(cancel);
    else cancel();
    await assert.rejects(
      f.readResult({ actionId: 'action' }, { ...f.context, abortSignal: abort.signal }),
      /Result read cancelled/u,
    );
    assert.equal(f.resultReads(), duringRead ? 1 : 0);
    assert.deepEqual(f.notifications, []);
    assert.deepEqual(f.forwarded, []);
  }
});

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
