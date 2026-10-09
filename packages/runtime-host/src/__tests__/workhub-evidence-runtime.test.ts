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
import type { StoredMessage, WorkHubDelegationAssignedMessage } from '@maka/core/session';
import { WORKHUB_COORDINATION_SESSION_ID, decodeCanonicalMessage } from '@maka/core/session';
import { testInvocationRecord } from '@maka/runtime/test-only/invocation-fixture';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
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
  const assignments = ['a', 'b', 'c'].map((key) => ({
    actionId: key,
    delegationId: 'delegation-' + key,
    targetSessionId: key,
    targetMessageId: 'message-' + key,
    targetTurnId: 'turn-' + key,
    targetSessionName: key,
    returnResults: true,
    userText: 'Original user task ' + key,
  })) as WorkHubDelegationAssignedMessage[];
  const active = new Set(['a', 'b', 'c']);
  const archived = new Set<string>();
  const resources = new Set<string>();
  const stopped = new Set<string>();
  const replaced = new Set<string>();
  const outputs = new Map<string, StoredMessage[]>();
  const cancelledMessages = new Set<string>();
  const deliveries: Array<{ sessionId: string; text: string }> = [];
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
          ['a', 'b', 'c', 'private', WORKHUB_COORDINATION_SESSION_ID].map((id) => ({
            id,
            isArchived: archived.has(id),
            name: id,
          })),
        readHeaderSnapshot: async (id: string) => ({ id, isArchived: archived.has(id) }),
        readActiveWorkHubAssignmentsByTarget: async (ids: readonly string[]) =>
          assignments.filter((a) => ids.includes(a.targetSessionId) && active.has(a.actionId)),
        readWorkHubReplacement: async (id: string) => (replaced.has(id) ? {} : undefined),
        readWorkHubStopRequest: async (id: string) => (stopped.has(id) ? {} : undefined),
        readWorkHubStopResolution: async () => undefined,
        readWorkHubAssignment: async (id: string) => assignments.find((a) => a.actionId === id),
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
      readDurableHighWater: async () => 99,
      readDurableRecords: async (sid: string) => ({
        throughSequence: 99,
        records: (outputs.get(sid) ?? []).map((message, index) => ({ sequence: index, message })),
        nextPosition: null,
      }),
    },
    hasLiveResources: async (sid) => resources.has(sid),
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
    expire() {
      timestamp += 3600001;
    },
  };
}

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
