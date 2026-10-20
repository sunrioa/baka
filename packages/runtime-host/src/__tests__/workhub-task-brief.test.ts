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
import type { StoredMessage, WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import type { SessionTodoSnapshot } from '@maka/core/session-todo';
import {
  createWorkHubTaskBriefReader,
  formatWorkHubTaskBrief,
  readWorkHubWorkerStatus,
  WORKHUB_TASK_BRIEF_MAX_BYTES,
  WORKHUB_WORKER_STATUS_INSTRUCTION,
  type WorkHubTaskBrief,
} from '../server/workhub-task-brief.js';

type Options = Parameters<typeof createWorkHubTaskBriefReader>[0];
function assignment(actionId: string, taskId = 'task'): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 4,
    id: `fact-${actionId}`,
    actionId,
    turnId: `coor-${actionId}`,
    coordinationTurnId: `coor-${actionId}`,
    ts: 1,
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    disposition: 'delegate_existing',
    delegationId: `delegation-${actionId}`,
    targetSessionId: 'worker',
    targetSessionName: 'Worker',
    targetTurnId: `turn-${actionId}`,
    targetMessageId: `input-${actionId}`,
    userText: '原始目标：修复逻辑。',
    delegationText: 'MODEL_REWRITE_MUST_NOT_BECOME_A_REQUIREMENT',
    inputOrigin: 'user',
    work: { id: taskId, generationId: 'segment', sourceMessageId: `user-${actionId}` },
  };
}
function accepted(owner: WorkHubDelegationAssignedMessage, id: string): WorkHubTaskInputMessage {
  return {
    type: 'workhub_coordination',
    kind: 'task_input',
    schemaVersion: 1,
    id: `input-fact-${id}`,
    inputId: id,
    ts: 2,
    turnId: owner.coordinationTurnId,
    workId: owner.work!.id,
    generationId: owner.work!.generationId,
    sourceActionId: owner.actionId,
    sourceDelegationId: owner.delegationId,
    targetSessionId: owner.targetSessionId,
    targetMessageId: `target-${id}`,
    targetContentDigest: `sha256:${'b'.repeat(64)}`,
    mode: 'steering',
    text: 'PREPARED_INPUT_MUST_NOT_BECOME_A_REQUIREMENT',
    originalUserText: `原始纠正 ${id}`,
    inputOrigin: 'user',
    sourceMessageId: `user-${id}`,
  };
}
function fixture() {
  const initial = assignment('task');
  const latest = { ...assignment('latest'), ts: 3 };
  const assignments = [initial, latest];
  const facts: Array<{ sequence: number; message: StoredMessage }> = [
    { sequence: 0, message: initial },
    { sequence: 10, message: latest },
  ];
  const transcript: StoredMessage[] = [];
  const reads: Array<{ sessionId: string; turnId?: string }> = [];
  let todo: SessionTodoSnapshot = { items: [] };
  let latestSource: WorkHubDelegationAssignedMessage | undefined = latest;
  const options: Options = {
    sessions: {
      readWorkHubAssignment: async (id) => assignments.find((item) => item.actionId === id),
      readLatestWorkHubAssignment: async () => latestSource,
      readHeaderSnapshot: async () => ({ labels: [], backend: 'ai-sdk' }) as never,
      readWorkHubTaskFactsPage: async (request) => ({
        highWaterSequence: Math.max(...facts.map((row) => row.sequence)),
        records: facts
          .filter((row) => row.sequence < (request.beforeSequence ?? Infinity))
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, request.maxMessages),
      }),
    },
    reader: {
      readDurableHighWater: async (_sid, turnId) => {
        const rows = transcript
          .map((message, sequence) => ({ message, sequence }))
          .filter((row) => turnId === undefined || row.message.turnId === turnId);
        return rows.at(-1)?.sequence ?? null;
      },
      readDurableRecords: async (sessionId, request, turnId) => {
        reads.push({ sessionId, turnId });
        const rows = transcript
          .map((message, sequence) => ({ message, sequence }))
          .filter(
            (row) =>
              (turnId === undefined || row.message.turnId === turnId) &&
              row.sequence <= (request.position ?? Infinity),
          )
          .reverse();
        const records = rows.slice(0, request.maxMessages);
        return {
          records,
          throughSequence: request.throughSequence ?? null,
          nextPosition: rows[records.length]?.sequence ?? null,
        };
      },
    },
    history: {
      readAssignmentState: async () => 'owned',
      readExecutions: async (actionId, delegationId) => ({
        actionId,
        delegationId,
        targetSessionId: 'worker',
        executions: [
          {
            sessionId: 'worker',
            turnId: `turn-${actionId}`,
            runId: `run-${actionId}`,
            status: 'completed',
            terminalEventId: `terminal-${actionId}`,
          },
        ],
        nextCursor: null,
      }),
    },
    readTodo: async () => todo,
  };
  return {
    initial,
    latest,
    facts,
    assignments,
    transcript,
    reads,
    options,
    setTodo(value: SessionTodoSnapshot) {
      todo = value;
    },
    setLatest(value: WorkHubDelegationAssignedMessage | undefined) {
      latestSource = value;
    },
    async read() {
      const value = await createWorkHubTaskBriefReader(options)({ taskId: 'task' });
      assert.equal(value.status, 'ok');
      assert.ok('brief' in value);
      return value.brief;
    },
  };
}
function assistant(text: string, id = 'reply', turnId = 'turn-latest'): StoredMessage {
  return { type: 'assistant', id, turnId, ts: 4, text, modelId: 'test' };
}
function call(id: string, toolName: string, args: unknown, turnId = 'turn-latest'): StoredMessage {
  return { type: 'tool_call', id, turnId, ts: 4, toolName, args };
}
function result(toolUseId: string, isError = false, turnId = 'turn-latest'): StoredMessage {
  return {
    type: 'tool_result',
    id: `result-${toolUseId}`,
    toolUseId,
    turnId,
    ts: 5,
    isError,
    content: { kind: 'text', text: isError ? 'failed' : 'done' },
  };
}
const report =
  '<task-status>\n完成：参数校验\n未完成 / 下一步：限流测试\n已验证：单元测试通过\n</task-status>';

test('brief keeps only proven original user requirements, not rewrites, feedback or unrelated task content', async () => {
  const f = fixture();
  const first = accepted(f.initial, 'first');
  f.facts.push({ sequence: 2, message: first });
  f.facts.push({
    sequence: 3,
    message: {
      ...accepted(f.initial, 'notification'),
      inputOrigin: 'feedback',
      originalUserText: 'HISTORICAL_BACKGROUND',
    },
  });
  f.facts.push({
    sequence: 4,
    message: { ...accepted(f.initial, 'legacy'), originalUserText: undefined },
  });
  f.facts.push({
    sequence: 5,
    message: {
      ...accepted(f.initial, 'foreign'),
      workId: 'foreign',
      originalUserText: 'OTHER_TASK_SECRET',
    },
  });
  f.facts.push({
    sequence: 6,
    message: {
      ...accepted(f.initial, 'mismatch'),
      sourceDelegationId: 'other-delegation',
      originalUserText: 'UNPROVEN_BINDING',
    },
  });
  f.facts.push({ sequence: 11, message: accepted(f.latest, 'after-assignment') });
  const brief = await f.read();
  assert.equal(brief.goal?.text, f.initial.userText);
  assert.deepEqual(
    brief.requirements.map((item) => item.text),
    [first.originalUserText, f.latest.userText, '原始纠正 after-assignment'],
  );
  const text = formatWorkHubTaskBrief(brief);
  assert.doesNotMatch(
    text,
    /MODEL_REWRITE|PREPARED_INPUT|HISTORICAL_BACKGROUND|OTHER_TASK_SECRET|UNPROVEN_BINDING/,
  );
  assert.match(text, /2 条输入缺少可确认的用户原文来源或任务归属/);
  assert.match(text, /不是完整约束/);
  assert.match(text, /read\(taskId="task", view=history\)/);
});

test('worker status accepts only an unquoted final assistant block and falls back to an explicitly labelled 800-character excerpt', async () => {
  assert.equal(readWorkHubWorkerStatus(report), report.split('\n').slice(1, -1).join('\n'));
  for (const text of [
    '```xml\n' + report + '\n```',
    report
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n'),
    report + '\nThis was quoted history',
    report.replace('已验证：单元测试通过', 'arbitrary status'),
  ])
    assert.equal(readWorkHubWorkerStatus(text), undefined);
  const f = fixture();
  f.initial.work = { ...f.initial.work!, generationId: 'older-segment' };
  f.transcript.push(assistant(report, 'old-report', 'turn-task'));
  f.transcript.push(result('unrelated-tool'));
  f.transcript.push(assistant('```xml\n' + report + '\n```\n' + '😀'.repeat(1_000)));
  const fallback = await f.read();
  assert.equal(fallback.progress?.kind, 'reply_excerpt');
  assert.equal(Array.from(fallback.progress!.text).length, 800);
  assert.match(formatWorkHubTaskBrief(fallback), /回复摘录，非完整进展；未经验证/);
  f.transcript.push(assistant('当前工作。\n\n' + report, 'new-report'));
  const current = await f.read();
  assert.equal(current.progress?.kind, 'worker_status');
  assert.equal(current.progress?.messageId, 'new-report');
  assert.match(formatWorkHubTaskBrief(current), /worker 自述，未经验证/);
});

test('brief requires successful task-owned write/result pairs and matching current todo, retaining failed and unknown operations', async () => {
  const f = fixture();
  const todos: SessionTodoSnapshot = { items: [{ content: '测试', status: 'pending' }] };
  f.setTodo(todos);
  f.transcript.push(call('todo', 'todo_write', { todos: todos.items }), result('todo'));
  f.transcript.push(call('success', 'Write', { path: 'src/ok.ts' }), result('success'));
  f.transcript.push(call('duplicate', 'Edit', { path: 'src/ok.ts' }), result('duplicate'));
  f.transcript.push(call('failure', 'Edit', { path: 'src/failed.ts' }), result('failure', true));
  f.transcript.push(call('unknown', 'Write', { path: 'src/unknown.ts' }));
  f.transcript.push(
    {
      ...call('hidden', 'Write', { path: 'HIDDEN_PATH' }),
      modelVisibility: 'hidden',
    } as StoredMessage,
    result('hidden'),
  );
  f.transcript.push(
    call('foreign', 'Write', { path: 'FOREIGN_PATH' }, 'foreign-turn'),
    result('foreign', false, 'foreign-turn'),
  );
  // A result in another Turn cannot complete an attempted write in this Turn.
  f.transcript.push(result('unknown', false, 'foreign-turn'));
  const brief = await f.read();
  assert.deepEqual(brief.todo?.items, todos.items);
  assert.deepEqual(brief.files.map((item) => [item.path, item.outcome]).sort(), [
    ['src/failed.ts', 'failed'],
    ['src/ok.ts', 'succeeded'],
    ['src/unknown.ts', 'unknown'],
  ]);
  assert.ok(
    f.reads.every(
      (read) =>
        read.turnId === undefined || read.turnId === 'turn-task' || read.turnId === 'turn-latest',
    ),
  );
  const text = formatWorkHubTaskBrief(brief);
  assert.doesNotMatch(text, /HIDDEN_PATH|FOREIGN_PATH/);
  assert.match(text, /失败，不能当作成功修改/);
  f.setTodo({ items: [{ content: '来自别的任务', status: 'completed' }] });
  const changed = await f.read();
  assert.equal(changed.todo, undefined);
  assert.match(formatWorkHubTaskBrief(changed), /当前 session-todo.*归属未知/);
  f.setTodo(todos);
  f.transcript.push(
    call('foreign-todo', 'todo_write', { todos: todos.items }, 'foreign-turn'),
    result('foreign-todo', false, 'foreign-turn'),
  );
  const sameContentForeignWrite = await f.read();
  assert.equal(
    sameContentForeignWrite.todo,
    undefined,
    'equal contents alone cannot prove task ownership',
  );
});

test('the latest worker status follows owned continuation records rather than the first root execution', async () => {
  const f = fixture();
  f.options.history.readExecutions = async (actionId, delegationId, cursor) => {
    const resumed = actionId === 'latest' && !!cursor;
    const turnId = resumed ? 'turn-resumed' : `turn-${actionId}`;
    return {
      actionId,
      delegationId,
      targetSessionId: 'worker',
      executions: [
        {
          sessionId: 'worker',
          turnId,
          runId: `run-${turnId}`,
          status: 'completed',
          terminalEventId: `terminal-${turnId}`,
        },
      ],
      nextCursor: actionId === 'latest' && !cursor ? 'resumed' : null,
    };
  };
  f.transcript.push(assistant(report, 'root-report'));
  f.transcript.push({
    ...assistant(report.replace('参数校验', '后续限流测试'), 'resumed-report', 'turn-resumed'),
    ts: 10,
  } as StoredMessage);
  const brief = await f.read();
  assert.equal(brief.progress?.messageId, 'resumed-report');
  assert.match(brief.progress!.text, /后续限流测试/);
});

test('brief is deterministic, bounded for Unicode and escaped input, and reports omitted sources', () => {
  const brief: WorkHubTaskBrief = {
    taskId: 'task',
    sourceActionId: 'source',
    goal: { text: '\u0000'.repeat(2_000), messageId: 'goal', actionId: 'source', at: 0 },
    requirements: Array.from({ length: 40 }, (_, i) => ({
      text: `要求${i}:` + '😀\\\n'.repeat(1_000),
      messageId: `input-${i}`,
      actionId: 'source',
      at: i,
    })),
    omittedRequirements: 4,
    progress: {
      kind: 'worker_status',
      text: '完成：一项',
      messageId: 'report',
      actionId: 'source',
      at: 40,
    },
    todo: {
      messageId: 'todo',
      items: Array.from({ length: 200 }, () => ({ content: '待办内容', status: 'pending' })),
    },
    files: Array.from({ length: 100 }, (_, i) => ({
      path: 'src/' + i,
      toolName: 'Write',
      outcome: 'succeeded',
      messageId: `file-${i}`,
    })),
    limits: [],
  };
  const text = formatWorkHubTaskBrief(brief);
  assert.equal(formatWorkHubTaskBrief(brief), text);
  assert.ok(
    Buffer.byteLength(text) <= WORKHUB_TASK_BRIEF_MAX_BYTES,
    String(Buffer.byteLength(text)),
  );
  assert.match(text, /目标已截断/);
  assert.match(text, /input-39/);
  assert.match(text, /原文已截断/);
  assert.match(text, /已省略 \d+ 条用户要求、\d+ 条进展\/待办\/文件记录/);
  assert.doesNotMatch(text, /\ud83d(?!\ude00)/u);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Pure JSON, a single line/);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Never make a separate report/);
});

test('brief leaves legacy provenance and missing records explicit without a summary call or new state', async () => {
  const f = fixture();
  f.initial.inputOrigin = undefined;
  f.latest.inputOrigin = 'feedback';
  const brief = await f.read();
  assert.equal(brief.goal, undefined);
  assert.equal(brief.progress, undefined);
  assert.equal(brief.todo, undefined);
  assert.deepEqual(brief.files, []);
  assert.match(formatWorkHubTaskBrief(brief), /原目标的用户来源无法确认/);
  assert.match(formatWorkHubTaskBrief(brief), /最新进展：未知/);
  assert.deepEqual(f.reads, []);
  f.setLatest(undefined);
  assert.deepEqual(await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' }), {
    status: 'unavailable',
    reason: 'Canonical task source is missing',
  });
});
