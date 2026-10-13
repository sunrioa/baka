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
import type {
  StoredMessage,
  WorkHubDelegationAssignedMessage,
  SessionHeader,
} from '@maka/core/session';
import { WORKHUB_COORDINATION_SESSION_ID, decodeCanonicalMessage } from '@maka/core/session';
import { testInvocationRecord } from '@maka/runtime/test-only/invocation-fixture';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import type { WorkHubEvidenceOrigin } from '@maka/core/workhub-evidence';
import { normalizeRootTurnAdmissionPayload } from '@maka/storage/agent-run-store';
import {
  createWorkHubEvidenceRuntime,
  workHubEvidenceRequestId,
  workHubEvidenceTurnId,
} from '../server/workhub-evidence-runtime.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

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
  const headerOverrides = new Map<string, Partial<SessionHeader>>();
  const resources = new Set<string>();
  const stopped = new Set<string>();
  const replaced = new Set<string>();
  const outputs = new Map<string, StoredMessage[]>();
  const cancelledMessages = new Set<string>();
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
          labels: [],
          isArchived: archived.has(id),
          ...headerOverrides.get(id),
        }),
        readActiveWorkHubAssignmentsByTarget: async (ids: readonly string[]) =>
          assignments.filter((a) => ids.includes(a.targetSessionId) && active.has(a.actionId)),
        readWorkHubReplacement: async (id: string) => (replaced.has(id) ? {} : undefined),
        readWorkHubStopRequest: async (id: string) => (stopped.has(id) ? {} : undefined),
        readWorkHubStopResolution: async () => undefined,
        readWorkHubAssignment: async (id: string) => assignments.find((a) => a.actionId === id),
        readLatestWorkHubAssignment: async (id: string) =>
          [...assignments].reverse().find((a) => (a.work?.id ?? a.actionId) === id),
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
        readWorkHubTaskInputSuccessors: async () => [],
        readTranscriptHighWaterSnapshot: async () => 1,
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
      agentRunStore: { readRootTurnAdmission: async (_sid: string, tid: string) => roots.get(tid) },
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
      readMessageExecutionDispositionAdmitted: async (sid: string) =>
        cancelledMessages.has(sid)
          ? { kind: 'cancelled' }
          : {
              kind: 'owned_root',
              turnId: 'turn-' + sid,
              runId: 'run-' + sid,
            },
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
    headerOverrides,
    resources,
    stopped,
    replaced,
    outputs,
    records,
    roots,
    runs,
    assignments,
    deliveries,
    cancelledMessages,
    catalogReads,
    transcriptReads,
    expire() {
      timestamp += 3600001;
    },
  };
}

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
