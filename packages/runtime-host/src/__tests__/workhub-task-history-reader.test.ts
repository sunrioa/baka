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
import { encodeDurableToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import { createWorkHubTaskHistoryReader } from '../server/workhub-task-history-reader.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';

type Options = Parameters<typeof createWorkHubTaskHistoryReader>[0];
type Input = Parameters<ReturnType<typeof createWorkHubTaskHistoryReader>>[0];
function assignment(id: string, work = 'work'): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 4,
    id: `row-${id}`,
    turnId: `coord-${id}`,
    coordinationTurnId: `coord-${id}`,
    ts: 1,
    actionFingerprint: `sha256:${'0'.repeat(64)}`,
    disposition: 'delegate_existing',
    actionId: id,
    delegationId: `delegation-${id}`,
    targetSessionId: 'old',
    targetSessionName: 'A',
    targetMessageId: `message-${id}`,
    targetTurnId: `turn-${id}`,
    userText: `User request ${id}`,
    delegationText: `Rewritten instruction ${id}`,
    returnResults: true,
    work: { id: work, generationId: 'old-generation' },
  };
}
function fixture() {
  const assignments = [
    assignment('work'),
    assignment('other', 'B'),
    assignment('followup'),
    assignment('fresh'),
  ];
  assignments[3] = {
    ...assignments[3]!,
    targetSessionId: 'new',
    work: { id: 'work', generationId: 'new-generation' },
  };
  const rows = new Map<string, StoredMessage[]>();
  const chains = new Map<string, string[]>([
    ['work', ['turn-work', 'turn-work-resumed']],
    ['followup', ['turn-followup']],
  ]);
  const denied = new Set<string>();
  const transcriptReads: Array<{ sessionId: string; turnId?: string }> = [];
  const reads: object[] = [];
  let onRead = () => {};
  const options: Options = {
    stores: {
      readWorkHubAssignment: async (id) => assignments.find((a) => a.actionId === id),
      readWorkHubAssignmentsPage: async (input) => {
        reads.push(input);
        return {
          highWaterSequence: assignments.length - 1,
          records: assignments
            .map((message, sequence) => ({ message, sequence }))
            .filter((row) => row.sequence < (input.beforeSequence ?? Number.MAX_SAFE_INTEGER))
            .reverse()
            .slice(0, input.maxMessages),
        };
      },
    },
    reader: {
      readDurableHighWater: async (sid) =>
        (rows.get(sid)?.length ?? 0) - 1 < 0 ? null : rows.get(sid)!.length - 1,
      readDurableRecords: async (sid, input, turnId) => {
        transcriptReads.push({ sessionId: sid, turnId });
        onRead();
        const all = (rows.get(sid) ?? [])
          .map((message, sequence) => ({ message, sequence }))
          .filter(
            (row) =>
              row.sequence <= (input.throughSequence ?? Infinity) &&
              row.sequence <= (input.position ?? Infinity) &&
              row.message.turnId === turnId,
          )
          .reverse();
        const records = all.slice(0, input.maxMessages);
        return {
          throughSequence: input.throughSequence ?? null,
          records,
          nextPosition: all[records.length]?.sequence ?? null,
        };
      },
    },
    history: {
      readExecutions: async (actionId, _delegationId, cursor, max) => {
        assert.equal(max, 1);
        const index = cursor ? Number(cursor) : 0,
          chain = chains.get(actionId) ?? [];
        const turnId = chain[index];
        return {
          actionId,
          delegationId: `delegation-${actionId}`,
          targetSessionId: 'old',
          executions: turnId
            ? [
                {
                  sessionId: 'old',
                  turnId,
                  runId: `run-${turnId}`,
                  status: 'completed',
                  terminalEventId: `end-${turnId}`,
                },
              ]
            : [],
          nextCursor: index + 1 < chain.length ? String(index + 1) : null,
        };
      },
    },
    admission: new SessionAdmissionGate(),
    authorize: async (a, ctx) =>
      ctx.sessionId === 'new' && a.work?.id === 'work' && !denied.has(a.actionId)
        ? assignments[3]
        : undefined,
  };
  const ctx = { sessionId: 'new', abortSignal: new AbortController().signal } as MakaToolContext;
  return {
    options,
    ctx,
    rows,
    chains,
    assignments,
    denied,
    transcriptReads,
    reads,
    restart: () => createWorkHubTaskHistoryReader(options),
    reader: createWorkHubTaskHistoryReader(options),
    onRead(fn: () => void) {
      onRead = fn;
    },
  };
}
type RecordRow = Record<string, unknown> & {
  messageId: string;
  text: string;
  textOffset: number;
  totalTextChars: number;
};
async function collect(f: ReturnType<typeof fixture>, input: Partial<Input> = {}) {
  const records: RecordRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 500; page++) {
    const result = await f.reader(
      {
        operation: 'read',
        view: 'task_history',
        sourceActionId: 'followup',
        ...input,
        ...(cursor ? { cursor } : {}),
      },
      f.ctx,
    );
    assert.ok('history' in result, JSON.stringify(result));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
    records.push(...(result.history.records as RecordRow[]));
    if (!result.history.nextCursor) return records;
    cursor = result.history.nextCursor;
  }
  throw new Error('History pagination did not terminate');
}

test('same-work history includes original requests, steering and tool facts across assignments and continuations, not intervening work', async () => {
  const f = fixture();
  f.rows.set('old', [
    { type: 'user', id: 'delegated', turnId: 'turn-work', ts: 2, text: 'Delegated instruction' },
    {
      type: 'tool_call',
      id: 'bash',
      turnId: 'turn-work',
      ts: 3,
      toolName: 'Bash',
      args: { command: 'npm test' },
    },
    {
      type: 'user',
      id: 'correction',
      turnId: 'turn-work',
      ts: 4,
      text: 'Use Cookie Session, not JWT',
      displayText: 'Correction',
      steeringEventId: 'steer',
    },
    {
      type: 'tool_result',
      id: 'bash-result',
      turnId: 'turn-work',
      ts: 5,
      toolUseId: 'bash',
      isError: true,
      content: { kind: 'text', text: 'AssertionError: cookie missing' },
    },
    {
      type: 'assistant',
      id: 'answer',
      turnId: 'turn-work',
      ts: 6,
      text: 'Changed',
      modelId: 'test',
      thinking: { text: 'PRIVATE THINKING', signature: 'PRIVATE SIGNATURE' },
    },
    { type: 'user', id: 'private-B', turnId: 'turn-B', ts: 7, text: 'PRIVATE B USER' },
    {
      type: 'tool_call',
      id: 'private-tool',
      turnId: 'turn-B',
      ts: 8,
      toolName: 'Bash',
      args: { command: 'PRIVATE B COMMAND' },
    },
    {
      type: 'user',
      id: 'resumed-correction',
      turnId: 'turn-work-resumed',
      ts: 9,
      text: 'Also set HttpOnly',
    },
    {
      type: 'assistant',
      id: 'followup-answer',
      turnId: 'turn-followup',
      ts: 10,
      text: 'Follow-up done',
      modelId: 'test',
    },
    {
      type: 'tool_call',
      id: 'hidden-tool',
      turnId: 'turn-work',
      ts: 11,
      toolName: 'internal',
      args: { hidden: 'PRIVATE HIDDEN' },
      modelVisibility: 'hidden',
    },
  ]);
  const result = await collect(f);
  const text = JSON.stringify(result);
  for (const wanted of [
    'User request work',
    'User request followup',
    'Use Cookie Session, not JWT',
    'Also set HttpOnly',
    'npm test',
    'AssertionError: cookie missing',
    'Follow-up done',
  ])
    assert.ok(text.includes(wanted), wanted);
  for (const excluded of [
    'PRIVATE',
    'User request fresh',
    'User request other',
    'Rewritten instruction',
  ])
    assert.ok(!text.includes(excluded), excluded);
  assert.equal(result.find((row) => row.messageId === 'correction')?.steeringEventId, 'steer');
  assert.ok(
    f.transcriptReads.every(
      (row) =>
        row.sessionId === 'old' &&
        ['turn-work', 'turn-work-resumed', 'turn-followup'].includes(row.turnId!),
    ),
  );
  assert.ok(f.reads.length > 0);
});

test('an original assignment reference still includes later user corrections before this fresh execution', async () => {
  const f = fixture();
  const rows = await collect(f, { sourceActionId: 'work', kinds: ['user'] });
  const text = JSON.stringify(rows);
  assert.ok(text.includes('User request followup'));
  assert.ok(text.includes('User request work'));
  assert.ok(!text.includes('User request fresh'));
  assert.ok(!text.includes('User request other'));
});

test('history filters and oversized escaped text/JSON paginate without loss, duplication or broken surrogate pairs', async () => {
  const f = fixture(),
    text = '\u0000😀\\"'.repeat(9000);
  const args = { command: text },
    output = { kind: 'text' as const, text };
  f.assignments[0]!.userText = text;
  f.rows.set('old', [
    { type: 'tool_call', id: 'long-call', turnId: 'turn-work', ts: 1, toolName: 'Bash', args },
    {
      type: 'tool_result',
      id: 'long-result',
      turnId: 'turn-work',
      ts: 2,
      toolUseId: 'long-call',
      isError: false,
      content: output,
    },
  ]);
  for (const [kinds, messageId, expected] of [
    [['user'], 'row-work', text],
    [['tool_call'], 'long-call', JSON.stringify(args)],
    [['tool_result'], 'long-result', JSON.stringify(output)],
  ] as const) {
    const rows = await collect(f, { kinds: [...kinds] });
    const fragments = rows.filter((row) => row.messageId === messageId);
    let restored = '';
    for (const fragment of fragments) {
      assert.equal(fragment.textOffset, restored.length);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(fragment.text));
      restored += fragment.text;
    }
    assert.equal(restored, expected);
    assert.ok(rows.every((row) => kinds.includes(row.kind as never)));
  }
});

test('history cursors bind reader/source/filter and expire after restart; later assignments do not enter the snapshot', async () => {
  const f = fixture();
  f.assignments[2]!.userText = 'x'.repeat(18000);
  const input = {
    operation: 'read',
    view: 'task_history',
    sourceActionId: 'followup',
    kinds: ['user'],
  } as const;
  const first = await f.reader({ ...input, kinds: [...input.kinds] }, f.ctx);
  assert.ok('history' in first && first.history.nextCursor);
  const cursor = first.history.nextCursor;
  assert.equal(cursor.length, 32);
  for (const changed of [
    { sourceActionId: 'work' },
    { kinds: ['assistant'] },
    { cursor: cursor + 'bad' },
  ])
    await assert.rejects(
      () => f.reader({ ...input, kinds: ['user'], cursor, ...changed } as Input, f.ctx),
      /cursor/,
    );
  await assert.rejects(() => f.restart()({ ...input, kinds: ['user'], cursor }, f.ctx), /cursor/);
  assert.deepEqual(
    await f.reader({ ...input, kinds: ['user'], cursor }, { ...f.ctx, sessionId: 'other-reader' }),
    { status: 'unavailable' },
  );
  f.assignments.push(assignment('late'));
  const rest = await collect(f, { ...input, kinds: ['user'], cursor });
  assert.ok(!JSON.stringify(rest).includes('User request late'));
  f.denied.add('followup');
  assert.deepEqual(await f.reader({ ...input, kinds: ['user'], cursor }, f.ctx), {
    status: 'unavailable',
  });
});

test('history cursor references are bounded, evicted explicitly and never carry history bodies', async () => {
  const f = fixture();
  f.assignments[2]!.userText = 'PRIVATE LARGE USER REQUIREMENT '.repeat(1000);
  const input = {
    operation: 'read',
    view: 'task_history',
    sourceActionId: 'work',
    kinds: ['user'],
  } as const;
  const first = await f.reader({ ...input, kinds: ['user'] }, f.ctx);
  assert.ok('history' in first && first.history.nextCursor);
  const cursor = first.history.nextCursor;
  for (let index = 0; index < 128; index++) await f.reader({ ...input, kinds: ['user'] }, f.ctx);
  await assert.rejects(() => f.reader({ ...input, kinds: ['user'], cursor }, f.ctx), /expired/);
});

test('history revalidates all touched sources before returning data', async () => {
  const f = fixture();
  f.rows.set('old', [
    {
      type: 'assistant',
      id: 'answer',
      turnId: 'turn-followup',
      ts: 1,
      text: 'Old result',
      modelId: 'test',
    },
  ]);
  f.onRead(() => f.denied.add('followup'));
  assert.deepEqual(
    await f.reader({ operation: 'read', view: 'task_history', sourceActionId: 'followup' }, f.ctx),
    { status: 'unavailable' },
  );
});

test('history recovers a matching ledger tool result but never follows a mismatched archive into another Turn', async () => {
  const f = fixture();
  f.rows.set('old', [
    {
      type: 'tool_result',
      id: 'archived',
      turnId: 'turn-work',
      ts: 1,
      toolUseId: 'call',
      isError: false,
      content: {
        kind: 'archived_tool_result',
        status: 'not_loaded',
        runtimeEventId: 'result-event',
        toolCallId: 'call',
        toolName: 'Bash',
        originalBytes: 30,
        originalEstimatedTokens: 10,
        rewriteVersion: 2,
        reason: 'tool_result_pruned',
      },
    },
  ]);
  let turnId = 'turn-work';
  f.options.archiveEvidence = {
    read: async () => ({
      ok: true,
      transitions: [],
      event: {
        id: 'result-event',
        sessionId: 'old',
        turnId,
        runId: 'run',
        invocationId: 'invocation',
        ts: 1,
        partial: false,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'call',
          name: 'Bash',
          result: null,
          modelProjection: encodeDurableToolResultOutput(
            { type: 'json', value: { stdout: 'Actual archived failure', exitCode: 1 } },
            'old',
          ),
        },
      },
    }),
  };
  const loaded = await collect(f, { kinds: ['tool_result'] });
  assert.ok(JSON.stringify(loaded).includes('Actual archived failure'));
  assert.equal(loaded[0]!.archiveStatus, 'loaded');
  turnId = 'turn-B';
  const mismatch = await collect(f, { kinds: ['tool_result'] });
  assert.equal(mismatch[0]!.archiveStatus, 'source_mismatch');
  assert.ok(!JSON.stringify(mismatch).includes('Actual archived failure'));
  f.options.archiveEvidence = undefined;
  const missing = await collect(f, { kinds: ['tool_result'] });
  assert.equal(missing[0]!.archiveStatus, 'unavailable');
});
