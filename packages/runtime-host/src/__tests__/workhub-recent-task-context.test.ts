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
import test from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { RootTurnAdmission } from '@maka/storage/execution-stores';
import {
  createWorkHubRecentTaskContext,
  WORKHUB_RECENT_TASK_CONTEXT_MAX_BYTES,
} from '../server/workhub-recent-task-context.js';

type Options = Parameters<typeof createWorkHubRecentTaskContext>[0];
const scope = {
  sessionId: WORKHUB_COORDINATION_SESSION_ID,
  turnId: 'current',
  runId: 'current-run',
  cwd: '/unused',
};
function root(turnId: string, feedback = false): RootTurnAdmission {
  return {
    runId: `${turnId}-run`,
    execution: {
      kind: 'workhub_coordination',
      ...(feedback ? { feedback: { kind: 'workhub_result' } } : {}),
    },
  } as RootTurnAdmission;
}
function fixture() {
  const records: { sequence: number; message: StoredMessage }[] = [];
  const roots = new Map([['current', root('current')]]);
  const tasks = new Map<string, WorkHubDelegationAssignedMessage>();
  let reads = 0;
  const options: Options = {
    readRoot: async (_session, turn) => roots.get(turn),
    readTask: async (id) => tasks.get(id),
    reader: {
      readDurableRecords: async (_session, request) => {
        reads++;
        assert.equal(request.direction, 'older');
        assert.equal(request.maxMessages, 32);
        assert.equal(request.maxStoredBytes, 128 * 1024);
        const selected = records
          .filter((row) => row.sequence <= (request.position ?? Infinity))
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, request.maxMessages);
        const last = selected.at(-1)?.sequence;
        return {
          throughSequence: request.throughSequence ?? records.length,
          records: selected,
          nextPosition: last && last > 1 ? last - 1 : null,
        };
      },
    },
  };
  function add(
    operation: 'start' | 'continue' | 'ask',
    taskId: string,
    input: { feedback?: boolean; failed?: boolean; cancelled?: boolean } = {},
  ) {
    const turnId = `turn-${records.length}`;
    const callId = `call-${records.length}`;
    roots.set(turnId, root(turnId, input.feedback));
    tasks.set(taskId, {
      actionId: taskId,
      taskTitle: `Title ${taskId}`,
      targetSessionName: 'Session',
    } as WorkHubDelegationAssignedMessage);
    records.push({
      sequence: records.length + 1,
      message: {
        type: 'tool_call',
        id: callId,
        turnId,
        ts: 1,
        toolName: `mcp__desktop_workhub__${operation}`,
        args: { taskId: 'ARGUMENT_IS_NOT_A_RECEIPT' },
      },
    });
    const value = input.cancelled
      ? { kind: 'cancelled' }
      : operation === 'ask'
        ? { kind: 'selected', target: { kind: 'task', id: taskId } }
        : { taskId, admission: 'admitted' };
    records.push({
      sequence: records.length + 1,
      message: {
        type: 'tool_result',
        id: `${callId}-result`,
        toolUseId: callId,
        turnId,
        ts: 2,
        isError: input.failed === true,
        content: { kind: 'json', value },
      },
    });
  }
  return { records, roots, tasks, options, add, reads: () => reads };
}
const ids = (contexts: { text: string }[]) =>
  JSON.parse(contexts[0]!.text.split('\n').at(-1)!).map(
    (entry: { taskId: string }) => entry.taskId,
  );

test('orders user starts, continuations and confirmed task choices by mention, not background completion', async () => {
  const f = fixture();
  f.add('start', 'a');
  f.add('start', 'b');
  f.add('continue', 'a');
  f.add('continue', 'background', { feedback: true });
  f.add('ask', 'b');
  f.add('ask', 'cancelled', { cancelled: true });
  f.add('continue', 'failed', { failed: true });
  const contexts = await createWorkHubRecentTaskContext(f.options)(scope);
  assert.deepEqual(ids(contexts), ['b', 'a']);
  assert.doesNotMatch(contexts[0]!.text, /background|cancelled|failed|ARGUMENT_IS_NOT_A_RECEIPT/u);
});

test('never adds a preview, unproven receipt, foreign task identity or notification-root target', async () => {
  const f = fixture();
  f.add('start', 'unproven');
  f.roots.delete('turn-0');
  f.add('continue', 'foreign');
  f.tasks.set('foreign', {
    actionId: 'different-task',
    targetSessionName: 'Wrong',
  } as WorkHubDelegationAssignedMessage);
  assert.deepEqual(await createWorkHubRecentTaskContext(f.options)(scope), []);
  f.roots.set('current', root('current', true));
  const before = f.reads();
  assert.deepEqual(await createWorkHubRecentTaskContext(f.options)(scope), []);
  assert.equal(f.reads(), before);
  assert.deepEqual(
    await createWorkHubRecentTaskContext(f.options)({ ...scope, sessionId: 'worker' }),
    [],
  );
});

test('reads the actual Desktop structured-content receipt, not a text block or a failed MCP envelope', async () => {
  const f = fixture();
  f.add('start', 'desktop');
  const row = f.records.at(-1)!;
  assert.ok(row.message.type === 'tool_result' && row.message.content.kind === 'json');
  const value = row.message.content.value;
  row.message = { ...row.message, content: { kind: 'json', value: {
    structuredContent: value,
    content: [{ type: 'text', text: '{"taskId":"wrong-text-reference"}' }],
  } } };
  assert.deepEqual(ids(await createWorkHubRecentTaskContext(f.options)(scope)), ['desktop']);
  row.message = { ...row.message, content: { kind: 'json', value: {
    isError: true, structuredContent: value,
  } } };
  assert.deepEqual(await createWorkHubRecentTaskContext(f.options)(scope), []);
});

test('bounded references preserve full identifiers and rebuild identically from the original records', async () => {
  const f = fixture();
  for (let n = 0; n < 12; n++) f.add('start', `task-${n}-${'x'.repeat(180)}`);
  const first = await createWorkHubRecentTaskContext(f.options)(scope);
  const restarted = await createWorkHubRecentTaskContext(f.options)(scope);
  assert.deepEqual(first, restarted);
  assert.ok(Buffer.byteLength(first[0]!.text) <= WORKHUB_RECENT_TASK_CONTEXT_MAX_BYTES);
  const selected: string[] = ids(first);
  assert.ok(selected.length > 0 && selected.length <= 8);
  assert.ok(
    selected.every((id) => f.tasks.has(id)),
    'no shortened or manufactured task ID',
  );
});

test('does not scan without bounds and missing recent context does not fail user work', async () => {
  const f = fixture();
  for (let n = 0; n < 100; n++) f.add('continue', `task-${n}`, { feedback: true });
  assert.deepEqual(await createWorkHubRecentTaskContext(f.options)(scope), []);
  assert.equal(f.reads(), 4);
  f.options.reader.readDurableRecords = async () => {
    throw new Error('storage temporarily unavailable');
  };
  assert.deepEqual(await createWorkHubRecentTaskContext(f.options)(scope), []);
});
