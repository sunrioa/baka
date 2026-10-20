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
import { test } from 'node:test';
import type {
  StoredMessage,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
  SessionHeader,
} from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import { WORKHUB_COORDINATION_SESSION_ID, decodeCanonicalMessage } from '@maka/core/session';
import { testInvocationRecord } from '@maka/runtime/test-only/invocation-fixture';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import {
  workHubPeerInboxId,
  workHubPeerSettlementId,
  workHubPeerQuestionIdentity,
  type WorkHubEvidenceRequestMessage,
  type WorkHubEvidenceResolutionMessage,
  type WorkHubPeerQuestionMessage,
  type WorkHubPeerSettlementMessage,
} from '@maka/core/workhub-evidence';
import { isDeepStrictEqual } from 'node:util';
import { SessionNotFoundError } from '@maka/storage/session-store';
import {
  createWorkHubEvidenceRuntime,
  workHubEvidenceRequestId,
  workHubEvidenceResolutionId,
  workHubEvidenceRetirementId,
  workHubEvidenceTurnId,
} from '../server/workhub-evidence-runtime.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { projectSharedSessionTranscriptMessage } from '../server/shared-session-transcript.js';

type Options = Parameters<typeof createWorkHubEvidenceRuntime>[0];
function fixture() {
  const lane = new SessionAdmissionGate();
  const records = new Map<string, StoredMessage>();
  const roots = new Map<
    string,
    { sessionId: string; turnId: string; runId: string; execution: unknown }
  >();
  const runs = new Map<string, ReturnType<typeof testInvocationRecord>>();
  const assignments: WorkHubDelegationAssignedMessage[] = ['a', 'b', 'c'].map((key) => ({
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 4,
    id: 'assignment-' + key,
    turnId: 'coordination-' + key,
    coordinationTurnId: 'coordination-' + key,
    ts: 1,
    actionFingerprint: `sha256:${'0'.repeat(64)}`,
    disposition: 'delegate_existing',
    actionId: key,
    delegationId: 'delegation-' + key,
    targetSessionId: key,
    targetMessageId: 'message-' + key,
    targetTurnId: 'turn-' + key,
    targetSessionName: key,
    returnResults: true,
    userText: 'Original user task ' + key,
  }));
  const active = new Set(['a', 'b', 'c']);
  const archived = new Set<string>();
  const deleted = new Set<string>();
  const headerOverrides = new Map<string, Partial<SessionHeader>>();
  const resources = new Set<string>();
  const stopCalls: unknown[][] = [];
  const errors: unknown[] = [];
  const peerPending = new Set<string>();
  const queuedInputs: string[] = [];
  const stopped = new Set<string>();
  const stopRequests = new Map<string, WorkHubDelegationStopRequestedMessage>();
  const stopResolutions = new Map<string, WorkHubDelegationStopResolvedMessage>();
  const replaced = new Set<string>();
  const outputs = new Map<string, StoredMessage[]>();
  const cancelledMessages = new Set<string>();
  const dispositions = new Map<
    string,
    { kind: 'pending' } | { kind: 'owned_root'; turnId: string; runId: string }
  >();
  const deliveries: Array<{ sessionId: string; text: string }> = [];
  const catalogReads: Array<{
    beforeSequence?: number;
    maxMessages: number;
    maxStoredBytes: number;
  }> = [];
  const transcriptReads: Array<{
    sessionId: string;
    turnId?: string;
    maxMessages: number;
    maxStoredBytes: number;
  }> = [];
  let timestamp = 1000;
  for (const sessionId of ['a', 'b', 'c', WORKHUB_COORDINATION_SESSION_ID]) {
    const turnId = 'turn-' + sessionId,
      runId = 'run-' + sessionId;
    roots.set(turnId, {
      sessionId,
      turnId,
      runId,
      execution: {
        kind:
          sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? 'workhub_coordination'
            : 'external_message',
      },
    });
    runs.set(runId, testInvocationRecord({ sessionId, turnId, runId }));
  }
  const options: Options = {
    stores: {
      sessionStore: {
        listHeaders: async () =>
          [
            ...new Set([
              ...assignments.map((a) => a.targetSessionId),
              'private',
              WORKHUB_COORDINATION_SESSION_ID,
            ]),
          ].map((id) => ({
            id,
            isArchived: archived.has(id),
            name: id,
          })),
        readHeaderSnapshot: async (id: string) => ({
          id,
          backend: 'ai-sdk',
          labels: [],
          isArchived: archived.has(id),
          ...headerOverrides.get(id),
        }),
        readActiveWorkHubAssignmentsByTarget: async (ids: readonly string[]) =>
          assignments.filter((a) => ids.includes(a.targetSessionId) && active.has(a.actionId)),
        readWorkHubReplacement: async (id: string) => (replaced.has(id) ? {} : undefined),
        readWorkHubSupersession: async () => undefined,
        readWorkHubStopRequest: async (id: string, actionId?: string, latest?: true) =>
          (latest ? [...stopRequests.values()].reverse() : [...stopRequests.values()]).find(
            (q) => q.stopsDelegationId === id && (!actionId || q.actionId === actionId),
          ) ?? (stopped.has(id) ? {} : undefined),
        readWorkHubStopResolution: async (id: string, actionId?: string) =>
          actionId ? stopResolutions.get(actionId) : stopResolutions.get(id),
        readWorkHubAssignment: async (id: string) => assignments.find((a) => a.actionId === id),
        readLatestWorkHubAssignment: async (id: string) =>
          [...assignments].reverse().find((a) => (a.work?.id ?? a.actionId) === id),
        hasUnsettledWorkHubPeerCommunication: async ({ workId }: { workId: string }) =>
          peerPending.has(workId),
        readWorkHubAssignmentsPage: async (input: (typeof catalogReads)[number]) => {
          catalogReads.push(input);
          return {
            highWaterSequence: assignments.length - 1,
            records: assignments
              .map((message, sequence) => ({ sequence, message }))
              .filter((row) => row.sequence < (input.beforeSequence ?? Number.MAX_SAFE_INTEGER))
              .reverse()
              .slice(0, input.maxMessages),
          };
        },
        readMessagesAfter: async (
          sid: string,
          input: { beforeSequence?: number; maxMessages: number },
        ) => {
          const all = [...records.entries()]
            .filter(([key]) => key.startsWith(sid + '/'))
            .map(([, message], sequence) => ({ message, sequence }));
          return {
            highWaterSequence: all.at(-1)?.sequence ?? null,
            records: all
              .filter((row) => row.sequence < (input.beforeSequence ?? Infinity))
              .reverse()
              .slice(0, input.maxMessages),
          };
        },
        readWorkHubTaskFactsPage: async (input: (typeof catalogReads)[number]) => {
          catalogReads.push(input);
          const all = assignments.map((message, sequence) => ({ sequence, message }));
          return {
            highWaterSequence: all.at(-1)?.sequence ?? null,
            records: all
              .filter((row) => row.sequence < (input.beforeSequence ?? Number.MAX_SAFE_INTEGER))
              .reverse()
              .slice(0, input.maxMessages),
          };
        },
        readWorkHubTaskInput: async (id: string) =>
          [...records.values()].find(
            (message) =>
              message.type === 'workhub_coordination' &&
              message.kind === 'task_input' &&
              message.inputId === id,
          ),
        readWorkHubTaskInputSuccessors: async () => [],
        listMessageAdmissions: async () => queuedInputs.map((messageId) => ({ messageId })),
        listPendingSandboxBoundaryRequests: async () => [],
        readWorkHubTaskInputByMessage: async (id: string) =>
          [...records.values()].find(
            (message) =>
              message.type === 'workhub_coordination' &&
              message.kind === 'task_input' &&
              message.targetMessageId === id,
          ),
        commitWorkHubPeerQuestion: async (q: WorkHubPeerQuestionMessage) => {
          const old = records.get(q.sender.sessionId + '/' + q.id);
          if (old) {
            if (
              old.type !== 'workhub_peer_question' ||
              !isDeepStrictEqual(old, { ...q, ts: old.ts, expiresAt: old.expiresAt })
            )
              throw new Error('Peer question identity conflict');
            return old;
          }
          records.set(q.sender.sessionId + '/' + q.id, decodeCanonicalMessage(q));
          records.set(
            q.recipient.sessionId + '/' + workHubPeerInboxId(q.id),
            decodeCanonicalMessage({
              type: 'workhub_peer_inbox',
              schemaVersion: 1,
              id: workHubPeerInboxId(q.id),
              turnId: 'turn-' + q.recipient.sessionId,
              ts: q.ts,
              expiresAt: q.expiresAt,
              requesterSessionId: q.sender.sessionId,
              questionId: q.id,
              target: q.recipient,
            }),
          );
          return q;
        },
        commitWorkHubPeerSettlement: async (value: WorkHubPeerSettlementMessage) => {
          const q = records.get(
            value.requesterSessionId + '/' + value.questionId,
          ) as WorkHubPeerQuestionMessage;
          const key = q.recipient.sessionId + '/' + value.id;
          const old = records.get(key);
          if (old) {
            if (
              old.type !== 'workhub_peer_settlement' ||
              (old.outcome === value.outcome && old.answer !== value.answer)
            )
              throw new Error('Peer answer identity conflict');
            return old;
          }
          records.set(key, decodeCanonicalMessage(value));
          return value;
        },
        readWorkHubPeerInboxPage: async (
          sid: string,
          actionId: string,
          timestamp: number,
          input: { beforeSequence?: number; maxMessages: number },
        ) => {
          const all = [...records.entries()]
            .filter(([key]) => key.startsWith(sid + '/'))
            .map(([, message]) => message);
          return {
            highWaterSequence: all.length ? all.length - 1 : null,
            records: all
              .map((message, sequence) => ({ message, sequence }))
              .filter(
                ({ message, sequence }) =>
                  message.type === 'workhub_peer_inbox' &&
                  message.target.actionId === actionId &&
                  message.expiresAt > timestamp &&
                  !records.has(sid + '/' + workHubPeerSettlementId(message.questionId)) &&
                  sequence < (input.beforeSequence ?? Number.MAX_SAFE_INTEGER),
              )
              .reverse()
              .slice(0, input.maxMessages),
          };
        },
        readTranscriptHighWaterSnapshot: async (sid: string) => {
          if (deleted.has(sid)) throw new SessionNotFoundError(sid);
          return 1;
        },
        readTranscriptMessagesSnapshot: async (sid: string, input: { messageIds: string[] }) =>
          input.messageIds.map((id) => records.get(sid + '/' + id)).filter(Boolean),
        appendMessages: async (sid: string, values: StoredMessage[]) => {
          for (const value of values)
            records.set(sid + '/' + value.id, decodeCanonicalMessage(value));
        },
        appendMessage: async (sid: string, value: StoredMessage) => {
          records.set(sid + '/' + value.id, decodeCanonicalMessage(value));
        },
      },
      agentRunStore: {
        readRootTurnAdmission: async (_sid: string, tid: string) => roots.get(tid),
        readRootTurnContinuationAdmission: async () => undefined,
      },
      runtimeEventStore: { readRunInvocation: async (_sid: string, rid: string) => runs.get(rid) },
      interactionStore: { listSessionPending: async () => [] },
    } as unknown as Options['stores'],
    executions: {
      readLatestRootTurnLineage: async (identity: object) => identity,
      read: async (ref: { runId: string }) => ({
        ...runs.get(ref.runId),
        status: runs.get(ref.runId)?.terminalEvent?.status ?? 'running',
      }),
      stopRootPreservingFollowups: async (
        ...args: [{ sessionId: string; turnId: string; runId: string }]
      ) => {
        const [ref] = args;
        const run = runs.get(ref.runId);
        assert.equal(run?.turnId, ref.turnId);
        assert.equal(run?.terminalEvent?.actions?.stateDelta?.stopReason, 'dependency_wait');
        stopCalls.push(structuredClone(args));
        resources.delete(ref.sessionId);
      },
    } as unknown as Options['executions'],
    messages: {
      readMessageExecutionDispositionAdmitted: async (sid: string, messageId: string) =>
        dispositions.get(messageId) ??
        (cancelledMessages.has(sid)
          ? { kind: 'cancelled' }
          : {
              kind: 'owned_root',
              turnId: 'turn-' + sid,
              runId: 'run-' + sid,
            }),
    } as unknown as Options['messages'],
    admission: lane,
    reader: {
      readDurableHighWater: async (sid: string) => (outputs.get(sid)?.length ?? 1) - 1,
      readDurableRecords: async (sid, request, turnId?: string) => {
        transcriptReads.push({
          sessionId: sid,
          turnId,
          maxMessages: request.maxMessages,
          maxStoredBytes: request.maxStoredBytes,
        });
        const throughSequence = request.throughSequence ?? (outputs.get(sid)?.length ?? 1) - 1;
        const rows = (outputs.get(sid) ?? [])
          .map((message, sequence) => ({ sequence, message }))
          .filter(
            (row) =>
              row.sequence <= throughSequence &&
              row.sequence <= (request.position ?? throughSequence) &&
              (turnId === undefined || row.message.turnId === turnId),
          )
          .reverse();
        const records: typeof rows = [];
        let bytes = 0;
        for (const row of rows) {
          if (records.length >= request.maxMessages || bytes >= request.maxStoredBytes) break;
          records.push(row);
          bytes += Buffer.byteLength(JSON.stringify(row.message));
        }
        return { throughSequence, records, nextPosition: rows[records.length]?.sequence ?? null };
      },
    },
    hasLiveResources: async (sid) => resources.has(sid),
    hasBlockingGoal: () => false,
    onError: (error) => {
      errors.push(error);
    },
    now: () => timestamp,
  };
  function caller(sid = 'a'): MakaToolContext {
    return {
      sessionId: sid,
      turnId: 'turn-' + sid,
      runId: 'run-' + sid,
      invocationId: 'run-' + sid,
      toolCallId: 'call-' + sid,
      cwd: '/unused',
      abortSignal: new AbortController().signal,
      emitOutput() {},
    };
  }
  function terminal(sid: string, waiting = false, rid = 'run-' + sid) {
    const run = runs.get(rid)!;
    runs.set(rid, {
      ...run,
      terminalEvent: {
        id: 'end-' + sid,
        sessionId: sid,
        turnId: run.turnId,
        runId: rid,
        invocationId: run.invocationId,
        ts: timestamp,
        partial: false,
        role: 'system',
        author: 'system',
        status: 'completed',
        actions: {
          endInvocation: true,
          stateDelta: { stopReason: waiting ? 'dependency_wait' : 'end_turn' },
        },
      },
    });
  }
  return {
    runtime: createWorkHubEvidenceRuntime(options),
    restart: () => createWorkHubEvidenceRuntime(options),
    options,
    caller,
    terminal,
    active,
    archived,
    deleted,
    headerOverrides,
    resources,
    stopCalls,
    errors,
    peerPending,
    queuedInputs,
    stopped,
    stopRequests,
    stopResolutions,
    replaced,
    outputs,
    records,
    roots,
    runs,
    assignments,
    deliveries,
    cancelledMessages,
    dispositions,
    catalogReads,
    transcriptReads,
    expire() {
      timestamp += 3600001;
    },
  };
}

test('native read authorization uses the current owned Root and has no message effects', async () => {
  const f = fixture();
  assert.equal((await f.runtime.authorizeRead(f.caller()))?.actionId, 'a');
  assert.equal(await f.runtime.authorizeRead(f.caller(WORKHUB_COORDINATION_SESSION_ID)), undefined);
  for (const ctx of [
    { ...f.caller(), runId: undefined },
    { ...f.caller(), invocationId: 'forged' },
    { ...f.caller(), runId: 'run-b' },
    { ...f.caller(), turnId: 'another-turn' },
    f.caller('private'),
  ])
    await assert.rejects(f.runtime.authorizeRead(ctx));
  f.active.delete('a');
  await assert.rejects(f.runtime.authorizeRead(f.caller()), /outside an active/);
  f.roots.delete('turn-' + WORKHUB_COORDINATION_SESSION_ID);
  await assert.rejects(
    f.runtime.authorizeRead(f.caller(WORKHUB_COORDINATION_SESSION_ID)),
    /WorkHub authority/,
  );
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.records.size, 0);
});

test('native read authorization rejects a terminal or archived worker Root', async () => {
  const completed = fixture();
  completed.terminal('a');
  await assert.rejects(
    completed.runtime.authorizeRead(completed.caller()),
    /current root invocation/,
  );
  const archived = fixture();
  archived.archived.add('a');
  await assert.rejects(archived.runtime.authorizeRead(archived.caller()), /outside an active/);
});

for (const scenario of ['modern', 'legacy', 'mixed-modern', 'mixed-legacy'] as const)
  test(`already-terminal evidence uses its own stop request marker (${scenario})`, async () => {
    const f = fixture();
    f.terminal('b');
    f.outputs.set('b', [
      {
        type: 'assistant',
        id: 'completed-b',
        turnId: 'turn-b',
        ts: 1,
        text: 'Actual completed result',
        modelId: 'test',
      },
    ]);
    const read = () => f.runtime.read({ operation: 'read', sourceActionId: 'b' }, f.caller());
    assert.equal(((await read()) as { status: string }).status, 'ok');
    const modern = scenario === 'modern' || scenario === 'mixed-modern';
    const source = f.assignments.find((a) => a.actionId === 'b')!;
    const add = (actionId: string, marker: boolean, outcome: 'already_terminal' | 'not_owned') => {
      const request: WorkHubDelegationStopRequestedMessage = {
        type: 'workhub_coordination',
        kind: 'delegation_stop_requested',
        schemaVersion: 3,
        id: 'request-' + actionId,
        turnId: 'stop-turn',
        ts: 1,
        actionId,
        actionFingerprint: `sha256:${'b'.repeat(64)}`,
        coordinationTurnId: 'stop-turn',
        stopsActionId: source.actionId,
        stopsDelegationId: source.delegationId,
        targetSessionId: source.targetSessionId,
        targetMessageId: source.targetMessageId,
        targetSessionName: source.targetSessionName,
        userText: 'Stop',
        ...(marker ? { taskStop: true, workId: 'b', executionBinding: 'binding-b' } : {}),
      };
      const resolution: WorkHubDelegationStopResolvedMessage = {
        type: 'workhub_coordination',
        kind: 'delegation_stop_resolved',
        schemaVersion: 3,
        id: 'resolution-' + actionId,
        turnId: 'stop-turn',
        ts: 2,
        actionId,
        actionFingerprint: request.actionFingerprint,
        coordinationTurnId: 'stop-turn',
        stopsActionId: source.actionId,
        stopsDelegationId: source.delegationId,
        targetSessionId: source.targetSessionId,
        outcome,
        targetTurnId: 'turn-b',
      };
      f.stopRequests.set(actionId, request);
      f.stopResolutions.set(actionId, resolution);
      f.stopResolutions.set(source.delegationId, resolution);
    };
    if (scenario.startsWith('mixed')) add('earlier-stop', !modern, 'not_owned');
    add('matched-stop', modern, 'already_terminal');
    assert.equal(((await read()) as { status: string }).status, modern ? 'ok' : 'unavailable');
    const list = (await f.runtime.list({ operation: 'list' }, f.caller())) as {
      tasks: { actionId: string }[];
    };
    assert.equal(
      list.tasks.some((task) => task.actionId === 'b'),
      modern,
    );
  });

test('pure readers retain strict validation and do not expose retired producer or lifecycle APIs', async () => {
  const f = fixture();
  for (const key of [
    'tool',
    'request',
    'resolve',
    'ask',
    'inbox',
    'reply',
    'result',
    'cancel',
    'wait',
    'notify',
    'start',
    'reconcile',
    'peerContexts',
    'holdForHandoff',
  ]) {
    assert.equal(Object.hasOwn(f.runtime, key), false, key);
  }
  for (const operation of [
    'request',
    'resolve',
    'ask',
    'inbox',
    'reply',
    'result',
    'cancel',
    'wait',
  ]) {
    await assert.rejects(f.runtime.read({ operation } as never, f.caller()));
    await assert.rejects(f.runtime.list({ operation } as never, f.caller()));
  }
  for (const call of [
    { operation: 'list', answer: 'not a list argument' },
    { operation: 'list', unrelated: true },
    { operation: 'list', limit: 17 },
  ])
    await assert.rejects(f.runtime.list(call as never, f.caller()));
  for (const call of [
    { operation: 'read', sourceActionId: null },
    { operation: 'read', sourceActionId: 'a', unrelated: true },
    { operation: 'read', sourceActionId: 'a', kinds: ['user'] },
  ])
    await assert.rejects(f.runtime.read(call as never, f.caller()));
});

test('fresh container admission waits for every owned assignment and checks resources without reading history', async () => {
  const f = fixture();
  const source = f.assignments[0]!;
  const check = () =>
    f.options.admission.runMany([WORKHUB_COORDINATION_SESSION_ID, 'a'], (lease) =>
      f.runtime.assertFreshContainerSource(source, lease),
    );
  await assert.rejects(check(), /execution/);
  f.terminal('a');
  await check();
  const later = {
    ...source,
    id: 'assignment-later',
    actionId: 'later',
    delegationId: 'delegation-later',
    targetMessageId: 'message-later',
    work: { id: 'a', generationId: 'a', continuesActionId: 'a' },
  };
  f.assignments.push(later);
  f.active.add('later');
  f.dispositions.set(later.targetMessageId, { kind: 'pending' });
  await assert.rejects(check(), /queued/);
  f.assignments.pop();
  f.active.delete('later');
  f.resources.add('a');
  await assert.rejects(check(), /resources/);
  f.resources.clear();
  f.options.hasBlockingGoal = () => true;
  await assert.rejects(check(), /Goal/);
  f.options.hasBlockingGoal = () => false;
  const pendingInput: WorkHubTaskInputMessage = {
    type: 'workhub_coordination',
    kind: 'task_input',
    schemaVersion: 1,
    id: 'pending-input',
    turnId: source.coordinationTurnId,
    ts: 1000,
    inputId: 'pending-correction',
    workId: 'a',
    generationId: 'a',
    sourceActionId: source.actionId,
    sourceDelegationId: source.delegationId,
    text: 'Unconsumed direct correction',
    targetSessionId: 'a',
    targetMessageId: `whtm_${'a'.repeat(48)}`,
    targetContentDigest: `sha256:${'0'.repeat(64)}`,
    mode: 'steering',
    execution: { turnId: 'turn-a', runId: 'run-a' },
  };
  f.records.set('pending-input', pendingInput);
  f.queuedInputs.push(pendingInput.targetMessageId);
  await assert.rejects(check(), /queued direct input/);
  f.queuedInputs.length = 0;
  const unrelated = { ...f.assignments[1]!, targetSessionId: 'a' };
  f.assignments[1] = unrelated;
  const bInput: WorkHubTaskInputMessage = {
    ...pendingInput,
    id: 'b-input',
    turnId: unrelated.coordinationTurnId,
    workId: 'b',
    generationId: 'b',
    sourceActionId: unrelated.actionId,
    sourceDelegationId: unrelated.delegationId,
    targetMessageId: `whtm_${'b'.repeat(48)}`,
  };
  f.records.set('b-input', bInput);
  f.queuedInputs.push(bInput.targetMessageId);
  await check();
  f.queuedInputs.push(`whtm_${'c'.repeat(48)}`);
  await assert.rejects(check(), /unproven queued direct input/);
  f.queuedInputs.length = 0;
  f.peerPending.add('a');
  await assert.rejects(check(), /peer question/);
  f.peerPending.clear();
  f.active.delete('a');
  await assert.rejects(check(), /generation changed/);
  assert.deepEqual(f.transcriptReads, []);
  assert.deepEqual(f.deliveries, []);
});

test('task history extends only the current same-work native worker without broadening other-task evidence or coordinator access', async () => {
  const f = fixture();
  f.terminal('a');
  f.assignments[2] = {
    ...f.assignments[2]!,
    actionId: 'fresh-a',
    work: { id: 'a', generationId: 'fresh-a', continuesActionId: 'a' },
  };
  f.active.delete('a');
  f.active.delete('c');
  f.active.add('fresh-a');
  f.outputs.set('a', [
    {
      type: 'user',
      id: 'steer',
      turnId: 'turn-a',
      ts: 1,
      text: 'Correction: use cookies',
      steeringEventId: 'steer-event',
    },
    {
      type: 'tool_call',
      id: 'test-command',
      turnId: 'turn-a',
      ts: 2,
      toolName: 'Bash',
      args: { command: 'npm test' },
    },
    {
      type: 'tool_result',
      id: 'test-result',
      turnId: 'turn-a',
      ts: 3,
      toolUseId: 'test-command',
      isError: true,
      content: { kind: 'text', text: 'Actual assertion failure' },
    },
    { type: 'assistant', id: 'reply', turnId: 'turn-a', ts: 4, text: 'Changed', modelId: 'test' },
    {
      type: 'user',
      id: 'private',
      turnId: 'unrelated-turn',
      ts: 5,
      text: 'UNRELATED PRIVATE INPUT',
    },
  ]);
  const request = { operation: 'read', sourceActionId: 'a', view: 'task_history' } as const;
  let cursor: string | undefined,
    text = '';
  do {
    const result = (await f.runtime.read(
      { ...request, ...(cursor ? { cursor } : {}) },
      f.caller('c'),
    )) as {
      history: { records: unknown[]; nextCursor: string | null };
    };
    assert.ok(result.history, JSON.stringify(result));
    text += JSON.stringify(result.history.records);
    cursor = result.history.nextCursor ?? undefined;
  } while (cursor);
  for (const value of [
    'Original user task a',
    'Correction: use cookies',
    'npm test',
    'Actual assertion failure',
  ])
    assert.ok(text.includes(value), value);
  assert.ok(!text.includes('UNRELATED PRIVATE INPUT'));
  for (const sid of ['b', WORKHUB_COORDINATION_SESSION_ID])
    assert.deepEqual(await f.runtime.read(request, f.caller(sid)), { status: 'unavailable' });
  const ordinary = await f.runtime.read({ operation: 'read', sourceActionId: 'a' }, f.caller('c'));
  assert.match(JSON.stringify(ordinary), /Changed/);
  assert.doesNotMatch(JSON.stringify(ordinary), /Correction: use cookies|Actual assertion failure/);
  f.headerOverrides.set('c', { backend: 'plugin-executor' });
  const executorHistory = (await f.runtime.read(request, f.caller('c'))) as {
    history?: unknown;
  };
  assert.ok('history' in executorHistory);
  assert.match(JSON.stringify(executorHistory.history), /Correction: use cookies/);
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.runs.size, 4);
  assert.equal(f.records.size, 0);
});

test('only the current same-work generation or coordinator can explicitly read retired-generation evidence', async () => {
  const f = fixture();
  f.terminal('a');
  f.outputs.set('a', [
    {
      type: 'assistant',
      id: 'old-evidence',
      turnId: 'turn-a',
      ts: 1,
      text: 'SELECTED_OLD_EVIDENCE',
      modelId: 'test',
    },
  ]);
  const fresh = {
    ...f.assignments[2]!,
    actionId: 'fresh-a',
    work: { id: 'a', generationId: 'fresh-a', continuesActionId: 'a' },
  };
  f.assignments[2] = fresh;
  f.active.delete('a');
  f.active.delete('c');
  f.active.add('fresh-a');
  const read = async (sid: string) =>
    f.runtime.read({ operation: 'read', sourceActionId: 'a' }, f.caller(sid));
  const result = await read('c');
  assert.match(JSON.stringify(result), /SELECTED_OLD_EVIDENCE/);
  assert.equal((result as { evidence: { historical?: boolean } }).evidence.historical, true);
  assert.match(
    JSON.stringify(await read(WORKHUB_COORDINATION_SESSION_ID)),
    /SELECTED_OLD_EVIDENCE/,
  );
  assert.deepEqual(await read('b'), { status: 'unavailable' });
  await assert.rejects(read('a'), /current root invocation/);
  for (const overrides of [
    { labels: ['mode:side_conversation'] },
    { role: 'workhub_coordination' as const },
    {
      subagentParent: {
        kind: 'subagent' as const,
        parentSessionId: 'parent',
        spawnedBy: { parentRunId: 'parent-run', parentTurnId: 'parent-turn', toolCallId: 'spawn' },
        lifecycle: 'foreground' as const,
      },
    },
    { isArchived: true },
  ]) {
    f.headerOverrides.set('a', overrides);
    assert.deepEqual(await read('c'), { status: 'unavailable' });
  }
  f.headerOverrides.clear();
  f.active.delete('fresh-a');
  await assert.rejects(read('c'), /active WorkHub task/);
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.runs.size, 4, 'historical reads do not create an invocation');
});

test('evidence discovery pages the canonical work catalog beyond 32 sources without retargeting its snapshot', async () => {
  const f = fixture();
  for (let index = 0; index < 140; index++) {
    const key = `catalog-${index}`;
    f.assignments.push({
      ...f.assignments[1]!,
      id: `assignment-${key}`,
      actionId: key,
      delegationId: `delegation-${key}`,
      targetSessionId: key,
      targetMessageId: `message-${key}`,
      targetSessionName: index === 139 ? '\u0000'.repeat(256) : `Task ${index}`,
      userText:
        index === 139
          ? '\u0000'.repeat(1000)
          : index === 0
            ? 'needle😀 objective'
            : `Independent objective ${index}`,
      work: { id: key, generationId: key },
    });
    f.active.add(key);
  }
  type Page = {
    status: 'ok';
    tasks: Array<{
      actionId: string;
      workId: string;
      generationId: string;
      source: { actionId: string; delegationId: string };
    }>;
    nextCursor: string | null;
    truncated: boolean;
  };
  const read = async (input: object, runtime = f.runtime) =>
    (await runtime.list({ operation: 'list', ...input } as never, f.caller())) as Page;
  const first = await read({});
  assert.equal(first.status, 'ok');
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= READ_PAGE_MAX_BYTES);
  assert.ok(first.tasks.length <= 16);
  assert.equal(typeof first.nextCursor, 'string');
  const found = first.tasks.map((task) => task.actionId);
  const firstCursor = first.nextCursor!;
  f.assignments.push({
    ...f.assignments[1]!,
    actionId: 'after-snapshot',
    delegationId: 'after-delegation',
    targetSessionId: 'after',
  });

  f.active.add('after-snapshot');
  for (let cursor = first.nextCursor; cursor; ) {
    const page = await read({ cursor });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
    assert.equal(page.truncated, page.nextCursor !== null);
    for (const task of page.tasks) {
      assert.equal(task.source.actionId, task.actionId);
      assert.ok(task.workId && task.generationId && task.source.delegationId);
      found.push(task.actionId);
    }
    cursor = page.nextCursor;
  }
  assert.equal(found.length, 143);
  assert.equal(new Set(found).size, found.length);
  assert.ok(!found.includes('after-snapshot'));
  const sparse = await read({ query: 'needle😀' });
  assert.equal(sparse.tasks.length, 0);
  assert.ok(sparse.nextCursor, 'an empty bounded scan is not the end of discovery');
  const matches: string[] = [];
  for (let cursor: string | null = sparse.nextCursor; cursor; ) {
    const page = await read({ query: 'needle😀', cursor });
    matches.push(...page.tasks.map((task) => task.actionId));
    cursor = page.nextCursor;
  }
  assert.deepEqual(matches, ['catalog-0']);
  for (const [input, runtime] of [
    [{ cursor: firstCursor, query: 'changed' }, f.runtime],
    [{ cursor: firstCursor + 'bad' }, f.runtime],
    [{ cursor: firstCursor }, f.restart()],
  ] as const)
    await assert.rejects(() => read(input, runtime), /Invalid or expired/u);
  await assert.rejects(
    async () => f.runtime.list({ operation: 'list', cursor: firstCursor }, f.caller('c')),
    /Invalid or expired/u,
  );
  await assert.rejects(
    async () =>
      f.runtime.read({ operation: 'read', sourceActionId: 'b', cursor: firstCursor }, f.caller()),
    /Invalid or expired/u,
  );
  assert.ok(
    f.catalogReads.every(
      (input) => input.maxMessages === 64 && input.maxStoredBytes === 256 * 1024,
    ),
  );
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.records.size, 0);
});

test('direct evidence reads reconstruct oversized escaped Unicode from one owned execution without waking its Session', async () => {
  const f = fixture();
  const text = '\u0000😀\\"'.repeat(40000);
  f.outputs.set('b', [
    { type: 'user', id: 'hidden', turnId: 'turn-b', ts: 1, text: 'PRIVATE USER' },
    { type: 'assistant', id: 'reply', turnId: 'turn-b', ts: 2, text, modelId: 'test' },
    {
      type: 'assistant',
      id: 'unrelated',
      turnId: 'other-turn',
      ts: 3,
      text: 'PRIVATE OTHER TURN',
      modelId: 'test',
    },
  ]);
  f.terminal('b');
  type Page = {
    status: 'ok';
    evidence: {
      sourceRunId: string;
      sourceTurnId: string;
      throughSequence: number;
      messages: Array<{
        messageId: string;
        text: string;
        textOffset: number;
        totalTextChars: number;
      }>;
      nextCursor: string | null;
    };
  };
  const source = { workId: 'b', generationId: 'b', actionId: 'b', delegationId: 'delegation-b' };
  const read = async (input: object, runtime = f.runtime) =>
    (await runtime.read(
      { operation: 'read', sourceActionId: 'b', ...input } as never,
      f.caller(),
    )) as Page;
  let page = await read({ source });
  assert.equal(page.status, 'ok');
  assert.ok(page.evidence.nextCursor);
  const firstCursor = page.evidence.nextCursor!;
  const watermark = page.evidence.throughSequence;
  f.outputs.get('b')!.push({
    type: 'assistant',
    id: 'later',
    turnId: 'another-turn',
    ts: 4,
    text: 'LATER COMMIT',
    modelId: 'test',
  });
  let reconstructed = '';
  for (let count = 0; ; count++) {
    assert.ok(count < 200, 'every page makes progress without losing or repeating text');
    assert.equal(page.evidence.throughSequence, watermark);
    assert.equal(page.evidence.sourceRunId, 'run-b');
    assert.equal(page.evidence.sourceTurnId, 'turn-b');
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
    for (const message of page.evidence.messages) {
      assert.equal(message.messageId, 'reply');
      assert.equal(message.textOffset, reconstructed.length);
      assert.equal(message.totalTextChars, text.length);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(message.text));
      reconstructed += message.text;
    }
    if (!page.evidence.nextCursor) break;
    page = await read({ source, cursor: page.evidence.nextCursor });
  }
  assert.equal(reconstructed, text);
  assert.equal(
    (await read({})).evidence.sourceRunId,
    'run-b',
    'legacy exact action reads remain supported',
  );
  const multipart = fixture();
  multipart.outputs.set(
    'b',
    Array.from({ length: 25 }, (_, index) => ({
      type: 'assistant' as const,
      id: `fragment-${index}`,
      turnId: 'turn-b',
      ts: index,
      text: `Text ${index}:` + '\u0000😀'.repeat(400),
      modelId: 'test',
    })),
  );
  multipart.terminal('b');
  const readMultipart = async (cursor?: string) =>
    (await multipart.runtime.read(
      { operation: 'read', source, ...(cursor ? { cursor } : {}) },
      multipart.caller(),
    )) as Page;
  const fragments = new Map<string, string>();
  for (
    let value = await readMultipart();
    ;
    value = await readMultipart(value.evidence.nextCursor ?? undefined)
  ) {
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= READ_PAGE_MAX_BYTES);
    for (const message of value.evidence.messages) {
      const previous = fragments.get(message.messageId) ?? '';
      assert.equal(message.textOffset, previous.length);
      fragments.set(message.messageId, previous + message.text);
    }
    if (!value.evidence.nextCursor) break;
  }
  assert.equal(fragments.size, 25);
  for (const message of multipart.outputs.get('b')!) {
    assert.ok(message.type === 'assistant');
    assert.equal(fragments.get(message.id), message.text);
  }
  for (const [input, runtime] of [
    [{ source: { ...source, generationId: 'changed' }, cursor: firstCursor }, f.runtime],
    [{ source, cursor: firstCursor + 'bad' }, f.runtime],
    [{ source, cursor: firstCursor }, f.restart()],
  ] as const)
    await assert.rejects(() => read(input, runtime), /Invalid or expired|source.*changed/u);
  f.archived.add('b');
  assert.deepEqual(await read({ source, cursor: firstCursor }), { status: 'unavailable' });
  assert.ok(
    f.transcriptReads.every(
      (input) =>
        input.turnId === 'turn-b' &&
        input.maxMessages === 64 &&
        input.maxStoredBytes === 256 * 1024,
    ),
  );
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.records.size, 0);
});

test('read-only evidence rejects foreign fields, non-root senders and hidden tasks', async () => {
  const f = fixture();
  await assert.rejects(async () =>
    f.runtime.list({ operation: 'list', hostId: 'foreign' } as never, f.caller()),
  );
  await assert.rejects(
    async () => f.runtime.list({ operation: 'list' }, { ...f.caller(), invocationId: 'other' }),
    /current root/u,
  );
  await assert.rejects(
    async () => f.runtime.list({ operation: 'list' }, { ...f.caller(), sessionId: 'private' }),
    /root invocation/u,
  );
  f.archived.add('b');
  assert.deepEqual(await f.runtime.read({ operation: 'read', sourceActionId: 'b' }, f.caller()), {
    status: 'unavailable',
  });
  f.archived.delete('b');
  for (const hidden of [
    { role: 'workhub_coordination' },
    { labels: ['mode:side_conversation'] },
    {
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'a',
        spawnedBy: { parentRunId: 'run-a', parentTurnId: 'turn-a', toolCallId: 'spawn' },
        lifecycle: 'foreground',
      },
    },
  ] satisfies Partial<SessionHeader>[]) {
    f.headerOverrides.set('b', hidden);
    assert.deepEqual(await f.runtime.read({ operation: 'read', sourceActionId: 'b' }, f.caller()), {
      status: 'unavailable',
    });
    const result = (await f.runtime.list({ operation: 'list' }, f.caller())) as {
      tasks: { actionId: string }[];
    };
    assert.ok(result.tasks.every((task) => task.actionId !== 'b'));
  }
  f.headerOverrides.delete('b');
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.records.size, 0);
});

function legacyWait(f: ReturnType<typeof fixture>, sid = 'a', selectedSource = true) {
  const source = f.assignments.find((a) => a.targetSessionId === sid)!;
  const request: WorkHubEvidenceRequestMessage = {
    type: 'workhub_evidence',
    schemaVersion: 1,
    id: workHubEvidenceRequestId('turn-' + sid),
    turnId: 'turn-' + sid,
    ts: 1000,
    expiresAt: 3601000,
    senderSessionId: sid,
    senderRunId: 'run-' + sid,
    senderInvocationId: 'run-' + sid,
    toolCallId: 'call-' + sid,
    actionId: source.actionId,
    delegationId: source.delegationId,
    rootMessageId: source.targetMessageId,
    question: 'Old missing evidence',
    round: 1,
  };
  f.records.set(sid + '/' + request.id, decodeCanonicalMessage(request));
  if (selectedSource) {
    const resolution: WorkHubEvidenceResolutionMessage = {
      type: 'workhub_evidence_resolution',
      schemaVersion: 1,
      id: workHubEvidenceResolutionId(request.id),
      turnId: 'original-coordinator-turn',
      ts: 1001,
      requestId: request.id,
      requesterSessionId: sid,
      senderRunId: 'original-coordinator-run',
      senderInvocationId: 'original-coordinator-invocation',
      toolCallId: 'original-resolve',
      sourceActionId: 'b',
      sourceDelegationId: 'delegation-b',
      sourceSessionId: 'b',
      sourceMessageId: 'message-b',
    };
    f.records.set(sid + '/' + resolution.id, decodeCanonicalMessage(resolution));
  }
  f.terminal(sid, true);
  return request;
}
async function legacyQuestion(
  f: ReturnType<typeof fixture>,
  suffix = 'old-question',
  source = {
    turnId: 'turn-a',
    runId: 'run-a',
    invocationId: 'run-a',
  },
) {
  const ref = (a: WorkHubDelegationAssignedMessage) => ({
    workId: a.work?.id ?? a.actionId,
    generationId: a.work?.generationId ?? a.actionId,
    actionId: a.actionId,
    delegationId: a.delegationId,
    sessionId: a.targetSessionId,
    messageId: a.targetMessageId,
  });
  const question: WorkHubPeerQuestionMessage = {
    type: 'workhub_peer_question',
    schemaVersion: 1,
    id: '',
    turnId: source.turnId,
    ts: 1000,
    expiresAt: 3601000,
    sender: ref(f.assignments[0]!),
    recipient: ref(f.assignments[1]!),
    senderRunId: source.runId,
    senderInvocationId: source.invocationId,
    toolCallId: suffix,
    question: 'Old unanswered question',
    round: 1,
  };
  const fixed = {
    ...question,
    id:
      'whpq_' +
      createHash('sha256').update(workHubPeerQuestionIdentity(question)).digest('hex').slice(0, 48),
  };
  await f.options.stores.sessionStore.commitWorkHubPeerQuestion(fixed);
  return fixed;
}

test('startup retirement releases only the exact old wait and closes unanswered peers idempotently without new Turns', async () => {
  const f = fixture();
  const request = legacyWait(f);
  const question = await legacyQuestion(f);
  const selection = structuredClone(f.records.get('a/' + workHubEvidenceResolutionId(request.id)));
  f.resources.add('a');
  f.queuedInputs.push('unrelated-queued-first', 'unrelated-queued-second');
  const result = await f.runtime.retireLegacy();
  assert.deepEqual(result, { retiredWaits: 1, retiredQuestions: 1, unavailable: 0 });
  assert.deepEqual(
    f.stopCalls,
    [[{ sessionId: 'a', turnId: 'turn-a', runId: 'run-a' }]],
    'no user stop source is fabricated',
  );
  assert.equal(f.resources.has('a'), false);
  assert.deepEqual(f.queuedInputs, ['unrelated-queued-first', 'unrelated-queued-second']);
  assert.equal(
    f.runs.get('run-b')?.terminalEvent,
    undefined,
    'ordinary active task B is untouched',
  );
  const marker = f.records.get(
    'a/' + workHubEvidenceRetirementId(request.id),
  ) as WorkHubEvidenceResolutionMessage;
  assert.equal(marker.origin, 'legacy_protocol_retirement');
  assert.equal(marker.senderInvocationId, request.senderInvocationId);
  assert.equal(marker.turnId, request.turnId);
  assert.equal(marker.sourceActionId, null);
  assert.deepEqual(
    f.records.get('a/' + workHubEvidenceResolutionId(request.id)),
    selection,
    'keep the original source selection',
  );
  const settlement = f.records.get(
    'b/' + workHubPeerSettlementId(question.id),
  ) as WorkHubPeerSettlementMessage;
  assert.equal(settlement.origin, 'legacy_protocol_retirement');
  assert.equal(settlement.outcome, 'cancelled');
  assert.deepEqual(settlement.actor, question.sender);
  const ref = { sessionId: 'a', turnId: 'turn-a', runId: 'run-a' };
  assert.equal((await f.runtime.waitingObservation(f.assignments[0]!, ref))?.status, 'cancelled');
  assert.equal((await f.runtime.taskExecution(f.assignments[0]!, ref)).request, undefined);
  for (let restart = 0; restart < 3; restart++) {
    const runtime = f.restart();
    assert.deepEqual(await runtime.retireLegacy(), {
      retiredWaits: 0,
      retiredQuestions: 0,
      unavailable: 0,
    });
    assert.equal((await runtime.waitingObservation(f.assignments[0]!, ref))?.status, 'cancelled');
  }
  const reply: WorkHubPeerSettlementMessage = {
    ...settlement,
    origin: undefined,
    actor: question.recipient,
    outcome: 'reply',
    answer: 'Late old reply',
    turnId: 'turn-b',
    senderRunId: 'run-b',
    senderInvocationId: 'run-b',
    toolCallId: 'late-reply',
  };
  assert.deepEqual(
    await f.options.stores.sessionStore.commitWorkHubPeerSettlement(reply),
    settlement,
  );
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 0,
  });
  assert.equal(f.stopCalls.length, 1);
  assert.equal(f.roots.size, 4);
  assert.equal(f.runs.size, 4);
  assert.deepEqual(f.deliveries, []);
  assert.deepEqual(f.errors, []);
});

test('unanswered peer retirement alone never stops an ordinary active or pending task', async () => {
  const f = fixture();
  await legacyQuestion(f);
  f.dispositions.set('message-b', { kind: 'pending' });
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 1,
    unavailable: 0,
  });
  assert.equal(f.stopCalls.length, 0);
  assert.equal(f.runs.get('run-a')?.terminalEvent, undefined);
  assert.equal(f.runs.get('run-b')?.terminalEvent, undefined);
  assert.deepEqual(f.dispositions.get('message-b'), { kind: 'pending' });
});

test('retirement authenticates archived original ownership without reopening hidden history or stopping unrelated current work', async () => {
  const f = fixture();
  const request = legacyWait(f);
  await legacyQuestion(f);
  f.archived.add('a');
  f.archived.add('b');
  f.active.delete('a');
  f.active.delete('b');
  f.expire();
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 1,
    retiredQuestions: 1,
    unavailable: 0,
  });
  assert.equal(f.stopCalls.length, 1);
  assert.deepEqual(f.stopCalls[0], [{ sessionId: 'a', turnId: 'turn-a', runId: 'run-a' }]);
  assert.equal(
    (
      await f.runtime.waitingObservation(f.assignments[0]!, {
        sessionId: 'a',
        turnId: 'turn-a',
        runId: 'run-a',
      })
    )?.status,
    'cancelled',
  );
  assert.deepEqual(
    await f.runtime.read({ operation: 'read', sourceActionId: 'a' }, f.caller('c')),
    { status: 'unavailable' },
  );
  assert.equal(
    f.records.get('a/' + workHubEvidenceRetirementId(request.id))?.type,
    'workhub_evidence_resolution',
  );
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 0,
  });
});

test('already closed peer facts stay closed after original runtime ownership becomes unavailable', async () => {
  const f = fixture();
  const q = await legacyQuestion(f);
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 1,
    unavailable: 0,
  });
  const marker = f.records.get('b/' + workHubPeerSettlementId(q.id));
  f.roots.delete('turn-a');
  f.runs.delete('run-a');
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 0,
  });
  assert.deepEqual(f.records.get('b/' + workHubPeerSettlementId(q.id)), marker);
  assert.equal(f.stopCalls.length, 0);
  assert.deepEqual(f.deliveries, []);
});

test('a cleanup failure or remaining resources leaves the old wait open and a later restart retries only that exact source', async () => {
  const f = fixture();
  const request = legacyWait(f, 'a', false);
  const originalStop = f.options.executions.stopRootPreservingFollowups;
  f.options.executions.stopRootPreservingFollowups = async () => {
    throw new Error('cleanup failed');
  };
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 1,
  });
  assert.equal(f.records.has('a/' + workHubEvidenceRetirementId(request.id)), false);
  f.resources.add('a');
  f.options.executions.stopRootPreservingFollowups = async (...args) => {
    f.stopCalls.push(args);
  };
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 1,
  });
  assert.equal(f.records.has('a/' + workHubEvidenceRetirementId(request.id)), false);
  assert.equal(
    (
      await f.runtime.waitingObservation(f.assignments[0]!, {
        sessionId: 'a',
        turnId: 'turn-a',
        runId: 'run-a',
      })
    )?.status,
    'waiting_for_dependency',
  );
  f.options.executions.stopRootPreservingFollowups = originalStop;
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 1,
    retiredQuestions: 0,
    unavailable: 0,
  });
  assert.equal(f.roots.size, 4);
  assert.equal(f.errors.length, 1);
});

test('an already admitted old child remains authenticated lineage and is never stopped or recreated by retirement', async () => {
  const f = fixture();
  const request = legacyWait(f);
  const turnId = workHubEvidenceTurnId(request.id);
  const origin = {
    kind: 'workhub_evidence',
    requestId: request.id,
    delegationId: request.delegationId,
    sourceTurnId: request.turnId,
    sourceRunId: request.senderRunId,
  };
  const next = { sessionId: 'a', turnId, runId: 'old-child-run' };
  f.roots.set(turnId, { ...next, execution: { kind: 'external_message', origin } });
  f.runs.set(next.runId, testInvocationRecord({ ...next }));
  const childQuestion = await legacyQuestion(f, 'child-question', {
    turnId: next.turnId,
    runId: next.runId,
    invocationId: next.runId,
  });
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 1,
    unavailable: 0,
  });
  assert.deepEqual(
    (
      await f.runtime.readEvidenceContinuation(f.assignments[0]!, {
        sessionId: 'a',
        turnId: 'turn-a',
        runId: 'run-a',
      })
    )?.next,
    next,
  );
  assert.deepEqual(
    await f.runtime.taskExecution(f.assignments[0]!, {
      sessionId: 'a',
      turnId: 'turn-a',
      runId: 'run-a',
    }),
    { ...next, round: 1 },
  );
  assert.equal(f.stopCalls.length, 0);
  assert.equal(f.runs.size, 5);
  assert.equal(f.records.has('a/' + workHubEvidenceRetirementId(request.id)), false);
  const settlement = f.records.get(
    'b/' + workHubPeerSettlementId(childQuestion.id),
  ) as WorkHubPeerSettlementMessage;
  assert.equal(settlement.turnId, next.turnId);
  assert.equal(settlement.senderRunId, next.runId);
  assert.equal(settlement.outcome, 'cancelled');
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 0,
  });
});

test('startup pages old facts behind unrelated history and rejects a conflicting retirement marker without new authority', async () => {
  const f = fixture();
  const request = legacyWait(f);
  await legacyQuestion(f);
  for (let i = 0; i < 150; i++)
    f.records.set('a/unrelated-' + i, {
      type: 'assistant',
      id: 'unrelated-' + i,
      turnId: 'turn-a',
      ts: 1000,
      text: 'Existing history ' + i,
      modelId: 'test',
    });
  assert.deepEqual(await f.runtime.retireLegacy(), {
    retiredWaits: 1,
    retiredQuestions: 1,
    unavailable: 0,
  });
  assert.equal(f.stopCalls.length, 1);
  assert.equal(
    f.transcriptReads.length,
    0,
    'retirement scans existing operational facts, not model context',
  );
  const markerId = 'a/' + workHubEvidenceRetirementId(request.id);
  const marker = f.records.get(markerId)!;
  f.records.set(markerId, { ...marker, toolCallId: 'wrong-original-tool' } as StoredMessage);
  assert.deepEqual(await f.restart().retireLegacy(), {
    retiredWaits: 0,
    retiredQuestions: 0,
    unavailable: 1,
  });
  assert.equal(
    f.stopCalls.length,
    1,
    'a marker conflict cannot manufacture a second stop or new root',
  );
  assert.equal(f.roots.size, 4);
});

test('retirement refuses missing, shared or mismatched original ownership and cannot retarget another execution', async () => {
  for (const change of ['missing', 'shared', 'mismatch'] as const) {
    const f = fixture();
    const request = legacyWait(f);
    if (change === 'missing') f.roots.delete('turn-a');
    if (change === 'shared') f.dispositions.set('message-a', { kind: 'shared_turn' } as never);
    if (change === 'mismatch')
      f.records.set('a/' + request.id, { ...request, senderInvocationId: 'another-invocation' });
    assert.deepEqual(
      await f.runtime.retireLegacy(),
      { retiredWaits: 0, retiredQuestions: 0, unavailable: 1 },
      change,
    );
    assert.equal(f.stopCalls.length, 0);
    assert.equal(f.records.has('a/' + workHubEvidenceRetirementId(request.id)), false);
    assert.equal(f.runs.get('run-b')?.terminalEvent, undefined);
  }
});
