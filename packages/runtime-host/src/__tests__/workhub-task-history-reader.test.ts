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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import { encodeDurableToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import { createWorkHubTaskHistoryReader } from '../server/workhub-task-history-reader.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { createSessionStore } from '@maka/storage/session-store';

type Options = Parameters<typeof createWorkHubTaskHistoryReader>[0];
type Input = Parameters<ReturnType<typeof createWorkHubTaskHistoryReader>>[0];
type AssignmentState = 'queued' | 'cancelled' | 'owned' | 'shared' | 'unavailable';
type ScanRequest = { beforeSequence?: number; maxMessages: number; maxStoredBytes: number };
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
function acceptedInput(
  source: WorkHubDelegationAssignedMessage,
  id: string,
  mode: WorkHubTaskInputMessage['mode'],
  raw: string,
): WorkHubTaskInputMessage {
  return {
    type: 'workhub_coordination',
    kind: 'task_input',
    schemaVersion: 1,
    id: `whti_${createHash('sha256').update(id).digest('hex').slice(0, 48)}`,
    turnId: source.coordinationTurnId,
    ts: 2,
    inputId: id,
    workId: source.work?.id ?? source.actionId,
    generationId: source.work?.generationId ?? source.actionId,
    sourceActionId: source.actionId,
    sourceDelegationId: source.delegationId,
    targetSessionId: source.targetSessionId,
    targetMessageId: `input-message-${id}`,
    text: `Prepared worker instruction ${id}`,
    originalUserText: raw,
    inputOrigin: 'user',
    sourceMessageId: `original-${id}`,
    targetContentDigest: `sha256:${'1'.repeat(64)}`,
    mode,
    ...(mode === 'steering'
      ? { execution: { turnId: source.targetTurnId, runId: `run-${source.targetTurnId}` } }
      : {}),
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
  const inputs: Array<{ sequence: number; message: WorkHubTaskInputMessage }> = [];
  const hiddenInputs = new Set<string>();
  const states = new Map<string, AssignmentState>();
  const transcriptReads: Array<{ sessionId: string; turnId?: string }> = [];
  const reads: object[] = [];
  let onRead = () => {};
  let onInputRead = () => {};
  const facts = () =>
    [...assignments.map((message, index) => ({ message, sequence: index * 100 })), ...inputs].sort(
      (a, b) => a.sequence - b.sequence,
    );
  const scan = async (input: ScanRequest, assignmentsOnly: boolean) => {
    reads.push(input);
    const all = facts();
    const selected = all
      .filter(
        (row) =>
          row.sequence < (input.beforeSequence ?? Number.MAX_SAFE_INTEGER) &&
          (!assignmentsOnly || row.message.kind === 'delegation_assigned'),
      )
      .reverse();
    const records = [];
    let bytes = 0;
    for (const row of selected.slice(0, input.maxMessages)) {
      const size = Buffer.byteLength(JSON.stringify(row.message));
      if (records.length && bytes + size > input.maxStoredBytes) break;
      records.push(row);
      bytes += size;
    }
    return { highWaterSequence: all.at(-1)?.sequence ?? null, records };
  };
  const options: Options = {
    stores: {
      readWorkHubAssignment: async (id) => assignments.find((a) => a.actionId === id),
      // Keep the released assignment-only seam available to the read-only
      // baseline comparison; both variants use the same canonical fact rows.
      ...{
        readWorkHubAssignmentsPage: (input: ScanRequest) => scan(input, true),
        readWorkHubTaskFactsPage: (input: ScanRequest) => scan(input, false),
        readWorkHubTaskInput: async (id: string) => {
          onInputRead();
          return hiddenInputs.has(id)
            ? undefined
            : inputs.find((row) => row.message.inputId === id)?.message;
        },
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
        if ((states.get(actionId) ?? 'owned') !== 'owned')
          throw new Error('This message has no exclusively owned execution');
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
      ...{
        readAssignmentState: async (actionId: string) => states.get(actionId) ?? 'owned',
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
    inputs,
    hiddenInputs,
    states,
    transcriptReads,
    reads,
    restart: () => createWorkHubTaskHistoryReader(options),
    reader: createWorkHubTaskHistoryReader(options),
    onRead(fn: () => void) {
      onRead = fn;
    },
    onInputRead(fn: () => void) {
      onInputRead = fn;
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

test('accepted task inputs expose raw requirements and distinguish feedback from consumption proof', async () => {
  const f = fixture();
  f.assignments[2]!.inputOrigin = 'feedback';
  const steering = acceptedInput(
    f.assignments[0]!,
    'steer',
    'steering',
    '用户原话：保留 Cookie，不要换成 JWT。',
  );
  const queued = acceptedInput(
    f.assignments[2]!,
    'queued',
    'queued_supplement',
    '排队时补充：编号不能丢精度。',
  );
  const feedback = {
    ...acceptedInput(f.assignments[0]!, 'feedback', 'steering', '自动结果背景，不是用户新指令。'),
    inputOrigin: 'feedback' as const,
  };
  const legacy = { ...acceptedInput(f.assignments[0]!, 'legacy', 'steering', 'unused') };
  delete legacy.originalUserText;
  delete legacy.inputOrigin;
  delete legacy.sourceMessageId;
  f.inputs.push(
    { sequence: 10, message: steering },
    { sequence: 20, message: feedback },
    { sequence: 30, message: legacy },
    { sequence: 210, message: queued },
  );
  const records = await collect(f, { kinds: ['user'] });
  for (const accepted of [steering, queued, feedback, legacy]) {
    const record = records.find((row) => row.messageId === accepted.id);
    assert.ok(record, accepted.inputId);
    assert.equal(record.text, accepted.originalUserText ?? accepted.text);
    assert.equal(record.inputOrigin, accepted.inputOrigin ?? 'user');
    assert.equal(record.acceptance, 'not_consumption_proof');
    assert.equal(record.mode, accepted.mode);
    assert.equal(record.targetMessageId, accepted.targetMessageId);
    assert.equal(record.sourceMessageId, accepted.sourceMessageId);
    assert.equal(record.recordSource, 'task_input');
  }
  assert.doesNotMatch(
    JSON.stringify(records),
    /Prepared worker instruction (steer|queued|feedback)/,
  );
  assert.equal(records.find((row) => row.messageId === 'row-followup')?.requestOrigin, 'feedback');
  assert.equal(records.find((row) => row.messageId === 'row-work')?.requestOrigin, 'unknown');
});

test('accepted input pages preserve escaped raw text, filters and UTF-16 offsets without loss', async () => {
  const f = fixture();
  const raw = '\u0000😀\\"'.repeat(5000);
  const input = acceptedInput(f.assignments[0]!, 'large', 'queued_supplement', raw);
  f.inputs.push({ sequence: 10, message: input });
  const rows = (await collect(f, { kinds: ['user'] })).filter((row) => row.messageId === input.id);
  let restored = '';
  for (const row of rows) {
    assert.equal(row.textOffset, restored.length);
    assert.equal(row.totalTextChars, raw.length);
    assert.ok(!/[\uD800-\uDBFF]$/u.test(row.text));
    restored += row.text;
  }
  assert.equal(restored, raw);
  assert.ok(rows.length > 1);
  assert.ok((await collect(f, { kinds: ['assistant'] })).every((row) => row.kind === 'assistant'));
});

test('accepted input snapshots exclude other work, the actor live generation and future facts', async () => {
  const f = fixture();
  const old = acceptedInput(
    f.assignments[0]!,
    'old-large',
    'steering',
    'KNOWN_OLD_INPUT '.repeat(2000),
  );
  f.inputs.push(
    { sequence: 10, message: old },
    {
      sequence: 110,
      message: acceptedInput(f.assignments[1]!, 'other', 'steering', 'PRIVATE_OTHER_INPUT'),
    },
    {
      sequence: 350,
      message: acceptedInput(f.assignments[3]!, 'live', 'steering', 'PRIVATE_LIVE_INPUT'),
    },
  );
  const first = await f.reader(
    { operation: 'read', view: 'task_history', sourceActionId: 'work', kinds: ['user'] },
    f.ctx,
  );
  assert.ok('history' in first && first.history.nextCursor);
  f.inputs.push({
    sequence: 400,
    message: acceptedInput(f.assignments[0]!, 'future', 'steering', 'PRIVATE_FUTURE_INPUT'),
  });
  const rest = await collect(f, {
    sourceActionId: 'work',
    kinds: ['user'],
    cursor: first.history.nextCursor,
  });
  const records = [...first.history.records, ...rest] as RecordRow[];
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_/);
  assert.equal(
    records
      .filter((row) => row.messageId === old.id)
      .map((row) => row.text)
      .join(''),
    old.originalUserText,
  );
});

test('accepted input provenance and missing canonical bodies fail closed', async () => {
  for (const change of [
    'generation',
    'delegation',
    'session',
    'coordination',
    'missing',
  ] as const) {
    const f = fixture();
    const input = {
      ...acceptedInput(f.assignments[0]!, `mixed-${change}`, 'steering', 'PRIVATE_MIXED_INPUT'),
    };
    if (change === 'generation') input.generationId = 'foreign-generation';
    if (change === 'delegation') input.sourceDelegationId = 'foreign-delegation';
    if (change === 'session') input.targetSessionId = 'foreign-session';
    if (change === 'coordination') input.turnId = 'foreign-coordination';
    if (change === 'missing') f.hiddenInputs.add(input.inputId);
    f.inputs.push({ sequence: 10, message: input });
    const result = await f.reader(
      { operation: 'read', view: 'task_history', sourceActionId: 'work', kinds: ['user'] },
      f.ctx,
    );
    assert.deepEqual(result, { status: 'unavailable' }, change);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MIXED_INPUT/);
  }
});

test('accepted input reads revalidate source access after loading the canonical body', async () => {
  const f = fixture();
  f.inputs.push({
    sequence: 10,
    message: acceptedInput(f.assignments[0]!, 'revoked', 'steering', 'PRIVATE_REVOKED_INPUT'),
  });
  f.onInputRead(() => f.denied.add('work'));
  assert.deepEqual(
    await f.reader(
      { operation: 'read', view: 'task_history', sourceActionId: 'work', kinds: ['user'] },
      f.ctx,
    ),
    { status: 'unavailable' },
  );
});

test('bounded empty fact pages retain a cursor past unrelated accepted inputs', async () => {
  const f = fixture();
  for (let sequence = 101; sequence < 200; sequence++) {
    f.inputs.push({
      sequence,
      message: acceptedInput(
        f.assignments[1]!,
        `noise-${sequence}`,
        'queued_supplement',
        'PRIVATE_OTHER_LARGE_INPUT '.repeat(1800),
      ),
    });
  }
  f.rows.set('old', [
    {
      type: 'tool_result',
      id: 'old-result',
      turnId: 'turn-work',
      ts: 2,
      toolUseId: 'old-call',
      isError: false,
      content: { kind: 'text', text: 'OWNED_OLD_TOOL_RESULT' },
    },
  ]);
  const input = {
    operation: 'read',
    view: 'task_history',
    sourceActionId: 'work',
    kinds: ['tool_result'],
  } as const;
  const first = await f.reader({ ...input, kinds: [...input.kinds] }, f.ctx);
  assert.ok('history' in first && first.history.nextCursor);
  assert.deepEqual(first.history.records, []);
  const records = await collect(f, {
    ...input,
    kinds: [...input.kinds],
    cursor: first.history.nextCursor,
  });
  assert.match(JSON.stringify(records), /OWNED_OLD_TOOL_RESULT/);
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_OTHER_LARGE_INPUT/);
});

for (const state of ['cancelled', 'queued', 'shared', 'unavailable'] as const) {
  test(`accepted requirements remain readable with an explicit ${state} execution limit`, async () => {
    const f = fixture();
    f.states.set('work', state);
    const input = acceptedInput(
      f.assignments[0]!,
      'never-started',
      'queued_supplement',
      '已受理的原始补充，不能冒充已执行。',
    );
    f.inputs.push({ sequence: 10, message: input });
    let cursor: string | undefined;
    const records: RecordRow[] = [];
    const omissions: unknown[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await f.reader(
        {
          operation: 'read',
          view: 'task_history',
          sourceActionId: 'work',
          kinds: ['user'],
          ...(cursor ? { cursor } : {}),
        },
        f.ctx,
      );
      assert.ok('history' in result, JSON.stringify(result));
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= READ_PAGE_MAX_BYTES);
      records.push(...(result.history.records as RecordRow[]));
      if ('unavailableExecutions' in result.history)
        omissions.push(...(result.history.unavailableExecutions as unknown[]));
      cursor = result.history.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.equal(
      cursor,
      undefined,
      'bounded historical reads finish without inventing an execution',
    );
    assert.ok(records.some((row) => row.text === input.originalUserText));
    assert.ok(records.some((row) => row.text === f.assignments[0]!.userText));
    assert.deepEqual(omissions, [
      { actionId: 'work', reason: state === 'cancelled' ? 'cancelled_before_start' : state },
    ]);
    assert.deepEqual(f.transcriptReads, []);
  });
}

test('the SQLite-backed history reader preserves accepted raw input across reopen without including intervening work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-history-input-'));
  let store = createSessionStore(root);
  try {
    await store.createStableSession({
      sessionId: WORKHUB_COORDINATION_SESSION_ID,
      requestFingerprint: `sha256:${'a'.repeat(64)}`,
      input: {
        cwd: root,
        name: 'WorkHub',
        role: WORKHUB_COORDINATION_SESSION_ROLE,
        model: 'test',
        llmConnectionSlug: 'test',
        permissionMode: 'explore',
        toolProfile: 'workhub-coordination-v2',
      },
    });
    const f = fixture();
    for (const source of f.assignments) {
      source.id = `wha_${createHash('sha256').update(source.actionId).digest('hex').slice(0, 48)}`;
    }
    f.assignments[0]!.work = { id: 'work', generationId: 'work' };
    f.assignments[1]!.work = { id: 'other', generationId: 'other' };
    f.assignments[2]!.work = { id: 'work', generationId: 'work', continuesActionId: 'work' };
    f.assignments[3]!.work = { id: 'work', generationId: 'fresh', continuesActionId: 'followup' };
    const old = acceptedInput(
      f.assignments[0]!,
      'persisted-old',
      'steering',
      '持久原始纠正：不能把大编号转为 Number。',
    );
    const other = acceptedInput(
      f.assignments[1]!,
      'persisted-other',
      'queued_supplement',
      'PRIVATE_OTHER_PERSISTED_INPUT',
    );
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
      f.assignments[0]!,
      old,
      f.assignments[1]!,
      other,
      f.assignments[2]!,
      f.assignments[3]!,
    ]);
    // This is the production SQLite/query composition. The unchanged actor and
    // execution fixtures isolate read projection, not Host invocation authority.
    for (let opening = 0; opening < 2; opening++) {
      if (opening) {
        await store.close?.();
        store = createSessionStore(root);
      }
      f.reader = createWorkHubTaskHistoryReader({ ...f.options, stores: store });
      const records = await collect(f, { kinds: ['user'] });
      const projected = records.find((row) => row.messageId === old.id);
      assert.equal(projected?.text, old.originalUserText);
      assert.equal(projected?.acceptance, 'not_consumption_proof');
      assert.doesNotMatch(JSON.stringify(records), /PRIVATE_OTHER_PERSISTED_INPUT/);
      assert.equal(
        (await store.readWorkHubTaskInput(old.inputId))?.originalUserText,
        old.originalUserText,
      );
      assert.equal(
        (await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID)).permissionMode,
        'explore',
      );
    }
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
