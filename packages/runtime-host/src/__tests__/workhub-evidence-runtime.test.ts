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
import { z } from 'zod';
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
  type WorkHubEvidenceOrigin,
  type WorkHubPeerQuestionMessage,
  type WorkHubPeerSettlementMessage,
} from '@maka/core/workhub-evidence';
import { isDeepStrictEqual } from 'node:util';
import { normalizeRootTurnAdmissionPayload } from '@maka/storage/agent-run-store';
import { SessionNotFoundError } from '@maka/storage/session-store';
import {
  createWorkHubEvidenceRuntime,
  workHubEvidenceRequestId,
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
    } as unknown as Options['stores'],
    executions: {
      readLatestRootTurnLineage: async (identity: object) => identity,
      read: async (ref: { runId: string }) => ({
        ...runs.get(ref.runId),
        status: runs.get(ref.runId)?.terminalEvent?.status ?? 'running',
      }),
      startWorkHubEvidence: async (
        sid: string,
        origin: WorkHubEvidenceOrigin,
        source: string | undefined,
        prepare: Parameters<Options['executions']['startWorkHubEvidence']>[3],
      ) =>
        lane.runMany(
          [WORKHUB_COORDINATION_SESSION_ID, sid, ...(source ? [source] : [])],
          async (lease) => {
            const tid = workHubEvidenceTurnId(origin.requestId);
            if (roots.has(tid)) return 'delivered';
            const content = await prepare(lease);
            if (!content) return 'obsolete';
            roots.set(tid, {
              sessionId: sid,
              turnId: tid,
              runId: 'run-' + tid,
              execution: { kind: 'external_message', origin },
            });
            runs.set(
              'run-' + tid,
              testInvocationRecord({ sessionId: sid, turnId: tid, runId: 'run-' + tid }),
            );
            deliveries.push({ sessionId: sid, text: content.text });
            return 'delivered';
          },
        ),
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
    acquireResidency: () => ({ release() {} }),
    onError: (error) => {
      throw error;
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
    const read = () => f.runtime.tool.impl({ operation: 'read', sourceActionId: 'b' }, f.caller());
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
    const list = (await f.runtime.tool.impl({ operation: 'list' }, f.caller())) as {
      tasks: { actionId: string }[];
    };
    assert.equal(
      list.tasks.some((task) => task.actionId === 'b'),
      modern,
    );
  });

test('WorkHubEvidence advertises an object schema without losing any operation fields', () => {
  const f = fixture();
  const parameters = f.runtime.tool.parameters as z.ZodType;
  const schema = z.toJSONSchema(parameters, { io: 'input', target: 'draft-7' });
  assert.equal(schema.type, 'object');
  assert.equal(schema.oneOf, undefined);
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['operation']);
  const source = { workId: 'a', generationId: 'a', actionId: 'a', delegationId: 'delegation-a' };
  const correlation = { requesterSessionId: 'a', questionId: `whpq_${'a'.repeat(48)}` };
  const calls = [
    { operation: 'list', query: 'checksum', limit: 16, cursor: 'cursor' },
    { operation: 'read', sourceActionId: 'a', source, cursor: 'cursor' },
    {
      operation: 'read',
      sourceActionId: 'a',
      view: 'task_history',
      kinds: ['user', 'tool_result'],
    },
    { operation: 'ask', source, question: 'Which checksum?' },
    { operation: 'inbox', limit: 8, cursor: 'cursor' },
    { operation: 'result', ...correlation },
    { operation: 'reply', ...correlation, answer: 'abc123' },
    { operation: 'cancel', ...correlation },
    { operation: 'wait', ...correlation },
    { operation: 'request', question: 'Which checksum?', sourceActionId: 'a' },
    { operation: 'resolve', requesterActionId: 'a', requestId: 'request-a', sourceActionId: null },
  ];
  const operation = schema.properties?.operation;
  assert.ok(operation && typeof operation === 'object');
  assert.deepEqual(new Set(operation.enum), new Set(calls.map((call) => call.operation)));
  for (const call of calls) {
    assert.ok(parameters.safeParse(call).success, JSON.stringify(call));
    for (const field of Object.keys(call)) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, field), `${call.operation}.${field}`);
    }
  }
});

test('WorkHubEvidence keeps operation-specific argument validation at the tool boundary', () => {
  const parameters = fixture().runtime.tool.parameters as z.ZodType;
  for (const call of [
    { operation: 'list', answer: 'not a list argument' },
    { operation: 'read', sourceActionId: null },
    { operation: 'inbox', limit: 9 },
    { operation: 'request' },
    { operation: 'resolve', requesterActionId: 'a', requestId: 'request-a' },
    { operation: 'reply', requesterSessionId: 'a', questionId: 'invalid', answer: 'abc123' },
    {
      operation: 'reply',
      requesterSessionId: 'a',
      questionId: `whpq_${'a'.repeat(48)}`,
      answer: '',
    },
    { operation: 'list', unrelated: true },
  ]) {
    assert.equal(parameters.safeParse(call).success, false, JSON.stringify(call));
  }
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
    const result = (await f.runtime.tool.impl(
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
    assert.deepEqual(await f.runtime.tool.impl(request, f.caller(sid)), { status: 'unavailable' });
  const ordinary = await f.runtime.tool.impl(
    { operation: 'read', sourceActionId: 'a' },
    f.caller('c'),
  );
  assert.match(JSON.stringify(ordinary), /Changed/);
  assert.doesNotMatch(JSON.stringify(ordinary), /Correction: use cookies|Actual assertion failure/);
  f.headerOverrides.set('c', { backend: 'plugin-executor' });
  assert.deepEqual(await f.runtime.tool.impl(request, f.caller('c')), { status: 'unavailable' });
  assert.deepEqual(f.deliveries, []);
  assert.equal(f.runs.size, 4);
  assert.equal(f.records.size, 0);
});

test('only the current same-work generation or coordinator can explicitly read retired-generation evidence', async () => {
  const f = fixture();
  f.terminal('a');
  const old = f.assignments[0]!;
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
    f.runtime.tool.impl({ operation: 'read', sourceActionId: 'a' }, f.caller(sid));
  const result = await read('c');
  assert.match(JSON.stringify(result), /SELECTED_OLD_EVIDENCE/);
  assert.equal((result as { evidence: { historical?: boolean } }).evidence.historical, true);
  assert.match(
    JSON.stringify(await read(WORKHUB_COORDINATION_SESSION_ID)),
    /SELECTED_OLD_EVIDENCE/,
  );
  assert.deepEqual(await read('b'), { status: 'unavailable' });
  await assert.rejects(read('a'), /current root invocation/);
  assert.deepEqual(
    await f.runtime.tool.impl(
      {
        operation: 'ask',
        source: {
          workId: 'a',
          generationId: 'a',
          actionId: old.actionId,
          delegationId: old.delegationId,
        },
        question: 'Do not wake old work',
      },
      f.caller('c'),
    ),
    { status: 'unavailable' },
  );
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

const peerSource = (a: WorkHubDelegationAssignedMessage) => ({
  workId: a.work?.id ?? a.actionId,
  generationId: a.work?.generationId ?? a.actionId,
  actionId: a.actionId,
  delegationId: a.delegationId,
});
type PeerReceipt = { questionId: string; requesterSessionId: string; status: string };
const askPeer = async (f: ReturnType<typeof fixture>, ctx = f.caller()) =>
  (await f.runtime.tool.impl(
    { operation: 'ask', source: peerSource(f.assignments[1]!), question: 'Which checksum?' },
    ctx,
  )) as PeerReceipt;

test('peer ask is nonblocking, native-work scoped and answers only its immutable correlation', async () => {
  const f = fixture();
  const q = await askPeer(f);
  assert.equal(q.status, 'accepted');
  assert.deepEqual(await askPeer(f), q);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.runs.get('run-a')?.terminalEvent, undefined, 'ask does not suspend A');
  const contexts = await f.runtime.peerContexts(f.caller('b'));
  assert.match(contexts[0]!.text, new RegExp(q.questionId));
  assert.deepEqual(await f.runtime.peerContexts({ ...f.caller('b'), invocationId: 'wrong' }), []);
  assert.deepEqual(
    await f.runtime.peerContexts({ sessionId: 'b', turnId: 'turn-b', cwd: '/unused' }),
    [],
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'ask', source: peerSource(f.assignments[1]!), question: 'Different' },
        f.caller(),
      ),
    /identity conflict/,
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'result', requesterSessionId: 'a', questionId: q.questionId },
        f.caller('c'),
      ),
    /another work/,
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'ask', source: peerSource(f.assignments[0]!), question: 'Self' },
        { ...f.caller(), toolCallId: 'self' },
      ),
    /cycle|same Session/,
  );
  const answer = (await f.runtime.tool.impl(
    { operation: 'reply', requesterSessionId: 'a', questionId: q.questionId, answer: 'abc123' },
    f.caller('b'),
  )) as { status: string; reply: { answer: string; invocationId: string } };
  assert.equal(answer.status, 'reply_committed');
  assert.equal(answer.reply.answer, 'abc123');
  assert.equal(answer.reply.invocationId, 'run-b');
  assert.deepEqual(
    await f.runtime.tool.impl(
      { operation: 'result', requesterSessionId: 'a', questionId: q.questionId },
      f.caller(),
    ),
    answer,
  );
  await f.runtime.reconcile();
  assert.equal(f.deliveries.length, 0, 'a reply does not insert a new root into nonwaiting A');
  assert.deepEqual(await f.runtime.peerContexts(f.caller('b')), []);
  assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= READ_PAGE_MAX_BYTES);
  for (const fact of f.records.values())
    assert.equal(
      projectSharedSessionTranscriptMessage(fact, 'a'),
      null,
      'operational facts stay out of UI transcript',
    );
  f.terminal('b');
  assert.deepEqual(
    await askPeer(f),
    q,
    'exact uncertain-outcome replay retains acceptance after B ends',
  );
});

test('an explicit correlated wait alone releases A, bypasses coordinator wake and resumes once after restart', async () => {
  const f = fixture();
  const q = await askPeer(f);
  f.resources.add('a');
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'wait', requesterSessionId: 'a', questionId: q.questionId },
        f.caller(),
      ),
    /resources.*Goal/,
  );
  f.resources.clear();
  f.options.hasBlockingGoal = () => true;
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'wait', requesterSessionId: 'a', questionId: q.questionId },
        f.caller(),
      ),
    /active Goal/,
  );
  f.options.hasBlockingGoal = () => false;
  const waiting = await f.runtime.tool.impl(
    { operation: 'wait', requesterSessionId: 'a', questionId: q.questionId },
    f.caller(),
  );
  assert.deepEqual(waiting, {
    kind: 'workhub_evidence_waiting',
    requestId: workHubEvidenceRequestId('turn-a'),
  });
  f.terminal('a', true);
  const observation = await f.runtime.waitingObservation(f.assignments[0]!, {
    sessionId: 'a',
    turnId: 'turn-a',
    runId: 'run-a',
  });
  assert.equal(observation?.notifyCoordinator, false);
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'ask', source: peerSource(f.assignments[0]!), question: 'Cyclic' },
        f.caller('b'),
      ),
    /cycle/,
  );
  await f.runtime.tool.impl(
    { operation: 'reply', requesterSessionId: 'a', questionId: q.questionId, answer: 'abc123' },
    f.caller('b'),
  );
  const restarted = f.restart();
  await restarted.reconcile();
  await restarted.reconcile();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0]!.sessionId, 'a');
  assert.match(f.deliveries[0]!.text, /reply_committed.*abc123/);
  assert.match(f.deliveries[0]!.text, /not.*permission grant/);
});

test('deleting a requester does not break another worker next-step inbox sampling', async () => {
  const f = fixture();
  await askPeer(f);
  f.deleted.add('a');
  assert.deepEqual(await f.runtime.peerContexts(f.caller('b')), []);
  const page = (await f.runtime.tool.impl({ operation: 'inbox' }, f.caller('b'))) as {
    questions: unknown[];
  };
  assert.deepEqual(page.questions, []);
});

test('a queued B inbox cannot be observed or answered by unrelated C in the same Session', async () => {
  const f = fixture();
  const b = f.assignments[1]!;
  const c = {
    ...b,
    actionId: 'unrelated-c',
    delegationId: 'delegation-unrelated-c',
    targetMessageId: 'message-unrelated-c',
    targetTurnId: 'turn-b-c',
  };
  f.assignments.push(c);
  f.active.add(c.actionId);
  f.dispositions.set(b.targetMessageId, { kind: 'pending' });
  f.dispositions.set(c.targetMessageId, {
    kind: 'owned_root',
    turnId: 'turn-b-c',
    runId: 'run-b-c',
  });
  f.runs.set(
    'run-b-c',
    testInvocationRecord({ sessionId: 'b', turnId: 'turn-b-c', runId: 'run-b-c' }),
  );
  const q = await askPeer(f);
  const unrelated = {
    ...f.caller('b'),
    turnId: 'turn-b-c',
    runId: 'run-b-c',
    invocationId: 'run-b-c',
  };
  assert.deepEqual(await f.runtime.peerContexts(unrelated), []);
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'reply', requesterSessionId: 'a', questionId: q.questionId, answer: 'wrong' },
        unrelated,
      ),
    /another work/,
  );
  f.dispositions.delete(b.targetMessageId);
  const inbox = (await f.runtime.tool.impl({ operation: 'inbox' }, f.caller('b'))) as {
    questions: { questionId: string }[];
  };
  assert.equal(inbox.questions[0]!.questionId, q.questionId);
});

for (const change of ['expired', 'cancelled', 'retired', 'cold', 'plugin'] as const)
  test(
    'peer communication reports ' + change + ' without source wake or revived authority',
    async () => {
      const f = fixture();
      if (change === 'cold') f.terminal('b');
      if (change === 'plugin') f.headerOverrides.set('b', { backend: 'plugin-executor' });
      const q = await askPeer(f);
      if (change === 'cold' || change === 'plugin') {
        assert.equal(q.status, 'unavailable');
        assert.equal(f.records.size, 0);
        return;
      }
      if (change === 'cancelled')
        await f.runtime.tool.impl(
          { operation: 'cancel', requesterSessionId: 'a', questionId: q.questionId },
          f.caller(),
        );
      if (change === 'expired') f.expire();
      if (change === 'retired') f.stopped.add('delegation-a');
      const late = (await f.runtime.tool.impl(
        { operation: 'reply', requesterSessionId: 'a', questionId: q.questionId, answer: 'late' },
        f.caller('b'),
      )) as { status: string };
      assert.equal(late.status, change === 'retired' ? 'source_retired' : change);
      await f.runtime.reconcile();
      assert.equal(f.deliveries.length, 0);
      assert.equal(
        f.records.has('b/' + workHubPeerSettlementId(q.questionId)),
        change === 'cancelled',
      );
    },
  );

test('peer inbox encoded pagination retains its snapshot and rejects changed readers/restarts', async () => {
  const f = fixture();
  const expected = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const value = (await f.runtime.tool.impl(
      {
        operation: 'ask',
        source: peerSource(f.assignments[1]!),
        question: '\u0000'.repeat(300) + '😀',
      },
      { ...f.caller(), toolCallId: `escaped-${i}` },
    )) as PeerReceipt;
    expected.add(value.questionId);
  }
  type Page = { questions: { questionId: string }[]; nextCursor: string | null };
  const first = (await f.runtime.tool.impl(
    { operation: 'inbox', limit: 8 },
    f.caller('b'),
  )) as Page;
  assert.ok(first.nextCursor);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= READ_PAGE_MAX_BYTES);
  await assert.rejects(
    async () =>
      f.runtime.tool.impl({ operation: 'inbox', cursor: first.nextCursor! }, f.caller('c')),
    /another work/,
  );
  await assert.rejects(
    async () =>
      f.restart().tool.impl({ operation: 'inbox', cursor: first.nextCursor! }, f.caller('b')),
    /Invalid or expired/,
  );
  const later = (await f.runtime.tool.impl(
    { operation: 'ask', source: peerSource(f.assignments[1]!), question: 'Later snapshot' },
    f.caller('c'),
  )) as PeerReceipt;
  const seen = new Set(first.questions.map((q) => q.questionId));
  let cursor: string | null = first.nextCursor;
  for (let i = 0; cursor; i++) {
    assert.ok(i < 8);
    const page = (await f.runtime.tool.impl(
      { operation: 'inbox', cursor, limit: 8 },
      f.caller('b'),
    )) as Page;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES);
    for (const q of page.questions) {
      assert.equal(seen.has(q.questionId), false);
      seen.add(q.questionId);
    }
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, expected);
  assert.equal(seen.has(later.questionId), false);
  const hold = f.runtime.holdForHandoff()!;
  await assert.rejects(
    async () => askPeer(f, { ...f.caller(), toolCallId: 'during-hold' }),
    /handoff/,
  );
  assert.deepEqual(await f.runtime.peerContexts(f.caller('b')), []);
  hold.release();
  f.runtime.beginDrain();
  await assert.rejects(
    async () => askPeer(f, { ...f.caller(), toolCallId: 'during-drain' }),
    /drain/,
  );
});

test('a sparse full inbox page does not hide older eligible questions', async () => {
  const f = fixture();
  const original = await askPeer(f);
  for (let i = 0; i < 64; i++) {
    const sid = `retired-${i}`;
    const a = {
      ...f.assignments[2]!,
      actionId: sid,
      delegationId: `delegation-${sid}`,
      targetSessionId: sid,
      targetMessageId: `message-${sid}`,
      targetTurnId: `turn-${sid}`,
    };
    f.assignments.push(a);
    f.active.add(sid);
    f.runs.set(
      'run-' + sid,
      testInvocationRecord({ sessionId: sid, turnId: 'turn-' + sid, runId: 'run-' + sid }),
    );
    await askPeer(f, f.caller(sid));
    f.active.delete(sid);
  }
  type Page = { questions: { questionId: string }[]; nextCursor: string | null };
  const sparse = (await f.runtime.tool.impl({ operation: 'inbox' }, f.caller('b'))) as Page;
  assert.deepEqual(sparse.questions, []);
  assert.ok(sparse.nextCursor);
  const older = (await f.runtime.tool.impl(
    { operation: 'inbox', cursor: sparse.nextCursor! },
    f.caller('b'),
  )) as Page;
  assert.equal(older.questions[0]!.questionId, original.questionId);
});

for (const change of ['expired', 'unavailable', 'source_retired'] as const)
  test('a genuine peer dependency wait resumes with explicit ' + change, async () => {
    const f = fixture();
    const q = await askPeer(f);
    await f.runtime.tool.impl(
      { operation: 'wait', requesterSessionId: 'a', questionId: q.questionId },
      f.caller(),
    );
    f.terminal('a', true);
    if (change === 'expired') f.expire();
    if (change === 'unavailable') f.terminal('b');
    if (change === 'source_retired') f.active.delete('b');
    const restart = f.restart();
    await restart.reconcile();
    await restart.reconcile();
    assert.equal(f.deliveries.length, 1);
    assert.match(f.deliveries[0]!.text, new RegExp(change));
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
    (await runtime.tool.impl({ operation: 'list', ...input } as never, f.caller())) as Page;
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
    async () => f.runtime.tool.impl({ operation: 'list', cursor: firstCursor }, f.caller('c')),
    /Invalid or expired/u,
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'read', sourceActionId: 'b', cursor: firstCursor },
        f.caller(),
      ),
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
    (await runtime.tool.impl(
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
    (await multipart.runtime.tool.impl(
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

test('evidence requests persist fixed sender identity and continue once from bounded source results after restart', async () => {
  const f = fixture();
  const call = { ...f.caller(), toolCallId: 'exec:nested:call' };
  assert.deepEqual(
    await f.runtime.tool.impl(
      { operation: 'request', question: 'Which checksum?', sourceActionId: 'b' },
      call,
    ),
    { kind: 'workhub_evidence_waiting', requestId: workHubEvidenceRequestId(call.turnId) },
  );
  await f.runtime.reconcile();
  assert.equal(
    f.deliveries.length,
    0,
    'a request without canonical tool/Turn settlement cannot resume',
  );
  f.terminal('a', true);
  await f.runtime.reconcile();
  assert.equal(f.deliveries.length, 0, 'a running source cannot be treated as evidence');
  f.outputs.set('b', [
    { type: 'user', id: 'hidden-user', turnId: 'turn-b', ts: 1, text: 'PRIVATE USER HISTORY' },
    {
      type: 'assistant',
      id: 'source-reply',
      turnId: 'turn-b',
      ts: 2,
      text: 'sha256=verified😀'.repeat(2000),
      modelId: 'test',
    },
    {
      type: 'assistant',
      id: 'unrelated-reply',
      turnId: 'other-turn',
      ts: 3,
      text: 'PRIVATE OTHER TASK',
      modelId: 'test',
    },
  ]);
  f.terminal('b');
  const recovered = f.restart();
  await recovered.reconcile();
  await recovered.reconcile();
  assert.equal(f.deliveries.length, 1);
  const delivery = f.deliveries[0]!.text;
  assert.match(delivery, /original delegated user task/u);
  assert.match(delivery, /source-reply/u);
  assert.match(delivery, /"sourceMessageId":"message-b"/u);
  assert.match(delivery, /"sourceRunId":"run-b"/u);
  assert.match(delivery, /"truncated":true/u);
  assert.doesNotMatch(delivery, /PRIVATE USER HISTORY|PRIVATE OTHER TASK/u);
  assert.ok(Buffer.byteLength(delivery) < 20000);
  const original = { sessionId: 'a', turnId: 'turn-a', runId: 'run-a' };
  const task = await recovered.taskExecution(f.assignments[0]!, original);
  assert.equal(task.turnId, workHubEvidenceTurnId(workHubEvidenceRequestId('turn-a')));
  assert.equal(task.round, 1);
  assert.deepEqual(
    await f.options.executions.readLatestRootTurnLineage(original),
    original,
    'task continuation must not mutate execution lineage used by task grants',
  );
});

test('escaped evidence and task text fit the real root admission encoding', async () => {
  const f = fixture();
  f.assignments[0] = { ...f.assignments[0]!, userText: '\u0000'.repeat(8000) };
  await f.runtime.tool.impl(
    { operation: 'request', question: '\u0000'.repeat(4000), sourceActionId: 'b' },
    f.caller(),
  );
  f.terminal('a', true);
  f.outputs.set(
    'b',
    Array.from({ length: 8 }, (_, index) => ({
      type: 'assistant',
      id: 'reply-' + index,
      turnId: 'turn-b',
      ts: index,
      text: '\u0000'.repeat(2000),
      modelId: 'test',
    })),
  );
  f.terminal('b');
  await f.runtime.reconcile();
  assert.equal(f.deliveries.length, 1);
  const content = { text: f.deliveries[0]!.text, displayText: 'Evidence response' };
  assert.deepEqual(normalizeRootTurnAdmissionPayload(content, []).normalizedInput, content);
  assert.match(content.text, /"originalTaskTruncated":true/u);
  assert.match(content.text, /"truncated":true/u);
  assert.match(content.text, /"sourceMessageId":"message-b"/u);
});

test('WorkHub relays an unbound evidence question without blocking and resolves only a visible source', async () => {
  const f = fixture();
  await f.runtime.tool.impl(
    { operation: 'request', question: 'Missing release evidence' },
    f.caller(),
  );
  f.terminal('a', true);
  const waiting = await f.runtime.waitingObservation(f.assignments[0]!, {
    sessionId: 'a',
    turnId: 'turn-a',
    runId: 'run-a',
  });
  assert.equal(waiting?.status, 'waiting_for_dependency');
  const requestId = workHubEvidenceRequestId('turn-a');
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'resolve', requesterActionId: 'a', requestId, sourceActionId: 'b' },
        f.caller('c'),
      ),
    /Only WorkHub/u,
  );
  assert.deepEqual(
    await f.runtime.tool.impl(
      {
        operation: 'resolve',
        requesterActionId: 'a',
        requestId,
        sourceActionId: 'foreign-host-action',
      },
      f.caller(WORKHUB_COORDINATION_SESSION_ID),
    ),
    { status: 'unavailable' },
  );
  assert.deepEqual(
    await f.runtime.tool.impl(
      { operation: 'resolve', requesterActionId: 'a', requestId, sourceActionId: 'b' },
      f.caller(WORKHUB_COORDINATION_SESSION_ID),
    ),
    { status: 'accepted', requestId },
  );
  assert.deepEqual(
    await f.runtime.tool.impl(
      { operation: 'resolve', requesterActionId: 'a', requestId, sourceActionId: 'b' },
      f.caller(WORKHUB_COORDINATION_SESSION_ID),
    ),
    { status: 'accepted', requestId },
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'resolve', requesterActionId: 'a', requestId, sourceActionId: 'c' },
        f.caller(WORKHUB_COORDINATION_SESSION_ID),
      ),
    /identity conflict/u,
  );
  f.terminal('b');
  await f.runtime.reconcile();
  assert.equal(f.deliveries.length, 1);
});

test('evidence fails closed on foreign fields, non-root or stale senders, hidden tasks, live resources and cycles', async () => {
  const f = fixture();
  await assert.rejects(async () =>
    f.runtime.tool.impl({ operation: 'list', hostId: 'foreign' } as never, f.caller()),
  );
  await assert.rejects(
    async () =>
      f.runtime.tool.impl({ operation: 'list' }, { ...f.caller(), invocationId: 'other' }),
    /current root/u,
  );
  await assert.rejects(
    async () => f.runtime.tool.impl({ operation: 'list' }, { ...f.caller(), sessionId: 'private' }),
    /root invocation/u,
  );
  f.archived.add('b');
  assert.deepEqual(
    await f.runtime.tool.impl({ operation: 'read', sourceActionId: 'b' }, f.caller()),
    { status: 'unavailable' },
  );
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
    assert.deepEqual(
      await f.runtime.tool.impl({ operation: 'read', sourceActionId: 'b' }, f.caller()),
      { status: 'unavailable' },
    );
    const result = (await f.runtime.tool.impl({ operation: 'list' }, f.caller())) as {
      tasks: { actionId: string }[];
    };
    assert.ok(result.tasks.every((task) => task.actionId !== 'b'));
  }
  f.headerOverrides.delete('b');
  f.resources.add('a');
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'request', question: 'Need B', sourceActionId: 'b' },
        f.caller(),
      ),
    /live background/u,
  );
  f.resources.clear();
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'request', question: 'Need myself', sourceActionId: 'a' },
        f.caller(),
      ),
    /cycle/u,
  );
  await f.runtime.tool.impl(
    { operation: 'request', question: 'Need B', sourceActionId: 'b' },
    f.caller(),
  );
  f.terminal('a', true);
  await assert.rejects(
    async () =>
      f.runtime.tool.impl(
        { operation: 'request', question: 'Need A', sourceActionId: 'a' },
        f.caller('b'),
      ),
    /cycle/u,
  );
  f.resources.add('a');
  await assert.rejects(
    () => f.runtime.assertSafeTerminal({ sessionId: 'a', turnId: 'turn-a', runId: 'run-a' }),
    /unsafe/u,
  );
});

for (const change of [
  'cancel',
  'archive',
  'replace',
  'source_retired',
  'source_cancelled',
  'expire',
  'unavailable',
] as const)
  test('evidence wait handles ' + change + ' without reviving retired task authority', async () => {
    const f = fixture();
    await f.runtime.tool.impl(
      {
        operation: 'request',
        question: 'Need B',
        ...(change === 'unavailable' ? {} : { sourceActionId: 'b' }),
      },
      f.caller(),
    );
    f.terminal('a', true);
    if (change === 'cancel') f.stopped.add('delegation-a');
    if (change === 'archive') f.archived.add('a');
    if (change === 'replace') f.replaced.add('delegation-a');
    if (change === 'source_retired') f.active.delete('b');
    if (change === 'source_cancelled') f.cancelledMessages.add('b');
    if (change === 'expire') f.expire();
    if (change === 'unavailable')
      await f.runtime.tool.impl(
        {
          operation: 'resolve',
          requesterActionId: 'a',
          requestId: workHubEvidenceRequestId('turn-a'),
          sourceActionId: null,
        },
        f.caller(WORKHUB_COORDINATION_SESSION_ID),
      );
    f.terminal('b');
    await f.restart().reconcile();
    const requesterRetired = change === 'cancel' || change === 'archive' || change === 'replace';
    assert.equal(f.deliveries.length, requesterRetired ? 0 : 1);
    if (requesterRetired)
      assert.equal(
        (
          await f.runtime.taskExecution(f.assignments[0]!, {
            sessionId: 'a',
            turnId: 'turn-a',
            runId: 'run-a',
          })
        ).request,
        undefined,
        'retirement cannot remain an active dependency after its fragment already settled',
      );
    if (f.deliveries.length)
      assert.match(
        f.deliveries[0]!.text,
        new RegExp(
          change.startsWith('source_') ? change : change === 'expire' ? 'expired' : 'unavailable',
        ),
      );
  });

test('actual persisted task lineage refuses a ninth evidence round', async () => {
  const f = fixture();
  let ctx = f.caller();
  for (let round = 1; round <= 8; round++) {
    const result = await f.runtime.tool.impl(
      { operation: 'request', question: 'Still missing evidence' },
      ctx,
    );
    assert.equal((result as { kind: string }).kind, 'workhub_evidence_waiting');
    f.terminal('a', true, ctx.runId);
    f.expire();
    await f.runtime.reconcile();
    const turnId = workHubEvidenceTurnId(workHubEvidenceRequestId(ctx.turnId));
    const root = f.roots.get(turnId)!;
    ctx = {
      ...ctx,
      turnId,
      runId: root.runId,
      invocationId: root.runId,
      toolCallId: 'call-round-' + round,
    };
  }
  assert.equal(f.deliveries.length, 8);
  await assert.rejects(
    async () => f.runtime.tool.impl({ operation: 'request', question: 'Round nine' }, ctx),
    /round limit/u,
  );
});

test('handoff fences polling, an old release cannot cancel a later hold, and drain cannot restart it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  await f.runtime.tool.impl({ operation: 'request', question: 'Missing evidence' }, f.caller());
  f.terminal('a', true);
  f.expire();
  f.runtime.start();
  const first = f.runtime.holdForHandoff()!;
  t.mock.timers.tick(1000);
  assert.equal(f.deliveries.length, 0);
  first.release();
  const second = f.runtime.holdForHandoff()!;
  first.release();
  t.mock.timers.tick(1000);
  assert.equal(f.deliveries.length, 0);
  second.release();
  t.mock.timers.tick(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const settling = f.runtime.holdForHandoff()!;
  await settling.settled();
  assert.equal(f.deliveries.length, 1);
  await f.runtime.close();
  settling.release();
  f.runtime.start();
  t.mock.timers.tick(6000);
  assert.equal(f.deliveries.length, 1);
});

test('one unavailable requester does not starve another evidence continuation', async (t) => {
  const f = fixture();
  await f.runtime.tool.impl(
    { operation: 'request', question: 'Need B', sourceActionId: 'b' },
    f.caller('c'),
  );
  f.terminal('c', true);
  f.terminal('b');
  const errors: unknown[] = [];
  f.options.onError = (error) => {
    errors.push(error);
  };
  const readHeader = f.options.stores.sessionStore.readHeaderSnapshot;
  t.mock.method(f.options.stores.sessionStore, 'readHeaderSnapshot', async (sid: string) => {
    if (sid === 'a') throw new Error('Unavailable requester');
    return readHeader(sid);
  });
  await f.restart().reconcile();
  assert.equal(errors.length, 1);
  assert.deepEqual(
    f.deliveries.map((value) => value.sessionId),
    ['c'],
  );
});
