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
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import type { SessionTodoSnapshot } from '@maka/core/session-todo';
import { testInvocationRecord } from '@maka/runtime/test-only/invocation-fixture';
import type { SystemPromptContext } from '@maka/runtime/ai-sdk-backend';
import {
  createWorkHubTaskBriefReader,
  createWorkHubWorkerStatusContext,
  isWorkHubTaskBriefCurrent,
  formatWorkHubTaskBrief,
  readWorkHubWorkerStatus,
  WORKHUB_TASK_BRIEF_MAX_BYTES,
  WORKHUB_WORKER_STATUS_INSTRUCTION,
  type WorkHubTaskBrief,
} from '../server/workhub-task-brief.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { HostMessageExecutionDisposition } from '../server/message-coordinator.js';

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

function workerStatusFixture() {
  const lane = new SessionAdmissionGate();
  const source: WorkHubDelegationAssignedMessage = { ...assignment('task'), returnResults: true };
  const active = [source];
  const original = { sessionId: 'worker', turnId: 'turn-task', runId: 'run-task' };
  const scope: SystemPromptContext = {
    ...original,
    invocationId: 'invocation-task',
    cwd: '/unused',
  };
  const runs = new Map([
    [original.runId, testInvocationRecord({ ...original, invocationId: scope.invocationId })],
  ]);
  const calls: { assignment: WorkHubDelegationAssignedMessage; root: typeof original }[] = [];
  let disposition: HostMessageExecutionDisposition = {
    kind: 'owned_root',
    turnId: original.turnId,
    runId: original.runId,
  };
  let current = original;
  const options: Parameters<typeof createWorkHubWorkerStatusContext>[0] = {
    admission: lane,
    stores: {
      sessionStore: { readActiveWorkHubAssignmentsByTarget: async () => active },
      runtimeEventStore: {
        readRunInvocation: async (sid: string, rid: string) => {
          const run = runs.get(rid);
          return run?.sessionId === sid ? run : undefined;
        },
      } as never,
    },
    messages: {
      readMessageExecutionDispositionAdmitted: async (sid, messageId, lease) =>
        lane.runAdmitted(sid, lease, () => {
          assert.equal(messageId, source.targetMessageId);
          return disposition;
        }),
    },
    evidence: {
      taskExecution: async (assigned, root) => {
        calls.push({ assignment: assigned, root });
        return { ...current, round: 0 };
      },
    },
  };
  return {
    options,
    scope,
    source,
    active,
    original,
    runs,
    calls,
    read: createWorkHubWorkerStatusContext(options),
    setDisposition(value: HostMessageExecutionDisposition) {
      disposition = value;
    },
    setCurrent(value: typeof original) {
      current = value;
    },
  };
}

test('worker status is optional execution context only for its live, exclusively owned WorkHub Root', async () => {
  const f = workerStatusFixture();
  const before = structuredClone({ source: f.source, scope: f.scope, runs: [...f.runs] });
  assert.deepEqual(await f.read(f.scope), [
    {
      name: 'workhub_worker_status',
      text: WORKHUB_WORKER_STATUS_INSTRUCTION,
    },
  ]);
  assert.deepEqual(f.calls, [{ assignment: f.source, root: f.original }]);
  assert.deepEqual(
    { source: f.source, scope: f.scope, runs: [...f.runs] },
    before,
    'the hint cannot rewrite user records, settings or invocation facts',
  );
  assert.deepEqual(Object.keys((await f.read(f.scope))[0]!).sort(), ['name', 'text']);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Pure JSON, a single line.*takes priority/);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Never make a separate report.*model call/);
});

test('worker status rejects manual, shared, queued, cancelled, foreign and non-live prompt scopes', async () => {
  for (const mode of [
    'manual',
    'shared',
    'pending',
    'cancelled',
    'recovering',
    'no-run',
    'no-invocation',
    'coordinator',
    'foreign-session',
    'foreign-turn',
    'foreign-run',
    'foreign-invocation',
    'no-return-results',
    'foreign-assignment',
  ] as const) {
    const f = workerStatusFixture();
    let scope = { ...f.scope };
    if (mode === 'manual') f.active.length = 0;
    if (mode === 'shared')
      f.setDisposition({ kind: 'shared_turn', turnId: f.original.turnId, runId: f.original.runId });
    if (mode === 'pending' || mode === 'cancelled' || mode === 'recovering')
      f.setDisposition({ kind: mode });
    if (mode === 'no-run') scope.runId = undefined;
    if (mode === 'no-invocation') scope.invocationId = undefined;
    if (mode === 'coordinator') scope.sessionId = WORKHUB_COORDINATION_SESSION_ID;
    if (mode === 'foreign-session') scope.sessionId = 'manual-with-workhub-looking-name';
    if (mode === 'foreign-turn') scope.turnId = 'different-turn';
    if (mode === 'foreign-run') scope.runId = 'different-run';
    if (mode === 'foreign-invocation') scope.invocationId = 'different-invocation';
    if (mode === 'no-return-results') f.source.returnResults = undefined;
    if (mode === 'foreign-assignment') f.source.targetSessionId = 'another-worker';
    assert.deepEqual(await f.read(scope), [], mode);
  }
});

test('worker status follows the authenticated current task continuation, not its old Root or another same-Session execution', async () => {
  const f = workerStatusFixture();
  const next = { sessionId: 'worker', turnId: 'continued-task-turn', runId: 'continued-task-run' };
  f.setCurrent(next);
  f.runs.set(next.runId, testInvocationRecord({ ...next, invocationId: 'continued-invocation' }));
  f.runs.set(f.original.runId, testInvocationRecord({ ...f.original, outcome: 'completed' }));
  assert.deepEqual(await f.read(f.scope), []);
  assert.deepEqual(
    await f.read({ ...next, invocationId: 'continued-invocation', cwd: '/unused' }),
    [
      {
        name: 'workhub_worker_status',
        text: WORKHUB_WORKER_STATUS_INSTRUCTION,
      },
    ],
  );
  const unrelated = { sessionId: 'worker', turnId: 'manual-turn', runId: 'manual-run' };
  f.runs.set(unrelated.runId, testInvocationRecord(unrelated));
  assert.deepEqual(
    await f.read({ ...unrelated, invocationId: unrelated.runId, cwd: '/unused' }),
    [],
  );
  f.setCurrent({ ...next, sessionId: 'another-worker' });
  assert.deepEqual(
    await f.read({ ...next, invocationId: 'continued-invocation', cwd: '/unused' }),
    [],
  );
});

test('worker status requires the immutable matching invocation to exist, stay nonterminal and retain user-root provenance', async () => {
  for (const mode of [
    'missing',
    'completed',
    'failed',
    'aborted',
    'wrong-invocation',
    'non-user-root',
  ] as const) {
    const f = workerStatusFixture();
    if (mode === 'missing') f.runs.clear();
    else
      f.runs.set(
        f.original.runId,
        testInvocationRecord({
          ...f.original,
          invocationId: mode === 'wrong-invocation' ? 'not-the-scope' : f.scope.invocationId,
          ...(mode === 'completed' || mode === 'failed' || mode === 'aborted'
            ? { outcome: mode }
            : {}),
          ...(mode === 'non-user-root'
            ? { opening: { root: { kind: 'context_compact' as const } } }
            : {}),
        }),
      );
    assert.deepEqual(await f.read(f.scope), [], mode);
  }
});
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
  const factReads: Parameters<Options['sessions']['readWorkHubTaskFactsPage']>[0][] = [];
  let todo: SessionTodoSnapshot = { items: [] };
  let latestSource: WorkHubDelegationAssignedMessage | undefined = latest;
  const options: Options = {
    sessions: {
      readWorkHubAssignment: async (id) => assignments.find((item) => item.actionId === id),
      readLatestWorkHubAssignment: async () => latestSource,
      readHeaderSnapshot: async () => ({ labels: [], backend: 'ai-sdk' }) as never,
      readWorkHubTaskFactsPage: async (request) => {
        factReads.push(request);
        return {
          highWaterSequence: Math.max(...facts.map((row) => row.sequence)),
          records: facts
            .filter((row) => row.sequence < (request.beforeSequence ?? Infinity))
            .sort((a, b) => b.sequence - a.sequence)
            .slice(0, request.maxMessages),
        };
      },
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
    factReads,
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

test('canonical preparation has a finite page budget and refuses a task boundary beyond it', async () => {
  const f = fixture();
  for (let i = 0; i < 2_049; i++)
    f.facts.push({
      sequence: 20 + i,
      message: assignment('other-' + i, 'other-task-' + i),
    });
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'unavailable');
  assert.equal(
    f.factReads.length,
    32,
    'a cold task cannot cause an unbounded coordination transcript scan',
  );
  assert.equal(
    f.reads.length,
    0,
    'an unavailable canonical boundary does not trigger native transcript reads',
  );
});

test('canonical preparation also requires the origin boundary and stops there without scanning older coordination work', async () => {
  const f = fixture();
  f.facts[0]!.sequence = 100;
  f.facts[1]!.sequence = 110;
  for (let i = 0; i < 100; i++)
    f.facts.push({ sequence: i, message: assignment('older-' + i, 'older-task-' + i) });
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'ok');
  assert.equal(f.factReads.length, 1);
  if (prepared.status !== 'ok') return;
  assert.deepEqual(prepared.witness, { taskId: 'task', throughSequence: 110 });
  assert.equal(Object.hasOwn(prepared.brief, 'witness'), false);
  assert.doesNotMatch(formatWorkHubTaskBrief(prepared.brief), /throughSequence|older-task-/);

  const hiddenOrigin = fixture();
  hiddenOrigin.facts[1]!.sequence = 3_000;
  for (let i = 0; i < 2_049; i++)
    hiddenOrigin.facts.push({
      sequence: 20 + i,
      message: assignment('other-' + i, 'other-task-' + i),
    });
  const limited = await createWorkHubTaskBriefReader(hiddenOrigin.options)({ taskId: 'task' });
  assert.equal(limited.status, 'unavailable');
  assert.ok('reason' in limited && /boundary.*bounded.*retry/.test(limited.reason));
  assert.equal(hiddenOrigin.factReads.length, 32);
  assert.equal(
    hiddenOrigin.reads.length,
    0,
    'do not claim a complete omission count after an unread origin gap',
  );
});

test('ephemeral freshness rejects same-generation steering even after that execution has completed', async () => {
  const f = fixture();
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'ok');
  if (prepared.status !== 'ok') return;
  assert.deepEqual(prepared.witness, { taskId: 'task', throughSequence: 10 });
  const correction = accepted(f.latest, 'after-brief');
  f.facts.push({ sequence: 11, message: correction });
  f.transcript.push(assistant('Correction consumed and complete', 'late-terminal-reply'));
  assert.equal(correction.generationId, f.latest.work!.generationId);
  const execution = await f.options.history.readExecutions(
    f.latest.actionId,
    f.latest.delegationId,
  );
  assert.equal(execution.executions[0]?.status, 'completed');
  const lane = new SessionAdmissionGate();
  const readsBefore = f.factReads.length;
  assert.equal(
    await lane.run(WORKHUB_COORDINATION_SESSION_ID, () =>
      isWorkHubTaskBriefCurrent(f.options.sessions, prepared.witness),
    ),
    false,
  );
  assert.equal(
    f.factReads.length - readsBefore,
    1,
    'final revalidation is one pure bounded read under the existing lane',
  );
  assert.ok(!prepared.brief.requirements.some((item) => item.text === correction.originalUserText));
  const refreshed = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(refreshed.status, 'ok');
  if (refreshed.status !== 'ok') return;
  assert.ok(refreshed.brief.requirements.some((item) => item.text === correction.originalUserText));
  assert.equal(await isWorkHubTaskBriefCurrent(f.options.sessions, refreshed.witness), true);
});

test('freshness rejects later same-task assignments and task facts accepted while native evidence is being read', async () => {
  const f = fixture();
  const nativeRead = f.options.history.readExecutions;
  let injected = false;
  f.options.history.readExecutions = async (...args) => {
    if (!injected) {
      injected = true;
      f.facts.push({ sequence: 11, message: accepted(f.latest, 'during-evidence-read') });
    }
    return nativeRead(...args);
  };
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'ok');
  if (prepared.status !== 'ok') return;
  assert.equal(
    prepared.witness.throughSequence,
    10,
    'a later point read must not silently advance the canonical preparation snapshot',
  );
  assert.equal(await isWorkHubTaskBriefCurrent(f.options.sessions, prepared.witness), false);

  const laterAssignment = fixture();
  const first = await createWorkHubTaskBriefReader(laterAssignment.options)({ taskId: 'task' });
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  laterAssignment.facts.push({ sequence: 11, message: assignment('later') });
  assert.equal(
    await isWorkHubTaskBriefCurrent(laterAssignment.options.sessions, first.witness),
    false,
  );
});

test('freshness ignores unrelated tasks but refuses an unprovable new-tail page instead of scanning without a bound', async () => {
  const f = fixture();
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'ok');
  if (prepared.status !== 'ok') return;
  for (let i = 0; i < 63; i++)
    f.facts.push({ sequence: 11 + i, message: assignment('other-' + i, 'other-task-' + i) });
  const before = f.factReads.length;
  assert.equal(
    await isWorkHubTaskBriefCurrent(f.options.sessions, prepared.witness),
    true,
    'a different global high-water is not by itself a task conflict',
  );
  assert.equal(f.factReads.length - before, 1);
  f.facts.push({
    sequence: 74,
    message: accepted(assignment('unrelated', 'unrelated-task'), 'unrelated-correction'),
  });
  const atLimit = f.factReads.length;
  assert.equal(
    await isWorkHubTaskBriefCurrent(f.options.sessions, prepared.witness),
    false,
    '64 newer facts leave no room for the original boundary, even if every observed fact is unrelated',
  );
  assert.equal(f.factReads.length - atLimit, 1);
  assert.deepEqual(f.factReads.at(-1), {
    beforeSequence: Number.MAX_SAFE_INTEGER,
    maxMessages: 64,
    maxStoredBytes: 256 * 1024,
  });
});

test('freshness fails closed for rollback, a byte-truncated gap and store errors; preparation failures produce no witness', async () => {
  const f = fixture();
  const prepared = await createWorkHubTaskBriefReader(f.options)({ taskId: 'task' });
  assert.equal(prepared.status, 'ok');
  if (prepared.status !== 'ok') return;
  for (const page of [
    { highWaterSequence: 9, records: [] },
    { highWaterSequence: null, records: [] },
    { highWaterSequence: Number.NaN, records: [] },
    {
      highWaterSequence: 20,
      records: [{ sequence: 20, message: assignment('other', 'other-task') }],
    },
    { highWaterSequence: 20, records: [] },
  ])
    assert.equal(
      await isWorkHubTaskBriefCurrent(
        { readWorkHubTaskFactsPage: async () => page },
        prepared.witness,
      ),
      false,
    );
  const failure = new Error('canonical store unavailable');
  f.options.sessions.readWorkHubTaskFactsPage = async () => {
    throw failure;
  };
  await assert.rejects(
    isWorkHubTaskBriefCurrent(f.options.sessions, prepared.witness),
    (error) => error === failure,
  );
  await assert.rejects(
    createWorkHubTaskBriefReader(f.options)({ taskId: 'task' }),
    (error) => error === failure,
  );
  const missing = fixture();
  missing.facts.splice(0, 1);
  const unavailable = await createWorkHubTaskBriefReader(missing.options)({ taskId: 'task' });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(Object.hasOwn(unavailable, 'witness'), false);
});

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
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const visible = formatWorkHubTaskBrief(brief, locale);
    assert.doesNotMatch(
      visible,
      /MODEL_REWRITE|PREPARED_INPUT|HISTORICAL_BACKGROUND|OTHER_TASK_SECRET|UNPROVEN_BINDING/u,
    );
    assert.ok(visible.includes(JSON.stringify(first.originalUserText)));
  }
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
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const visible = formatWorkHubTaskBrief(brief, locale);
    assert.doesNotMatch(visible, /HIDDEN_PATH|FOREIGN_PATH/u);
    assert.match(visible, /src\/failed\.ts|src\/unknown\.ts/u);
  }
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
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const visible = formatWorkHubTaskBrief(brief, locale);
    assert.equal(formatWorkHubTaskBrief(brief, locale), visible);
    assert.ok(Buffer.byteLength(visible) <= WORKHUB_TASK_BRIEF_MAX_BYTES);
    assert.doesNotMatch(visible, /input-39|read\(taskId=|session-todo/u);
    assert.match(
      visible,
      /39:/u,
      'the newest original user wording remains despite hidden metadata IDs',
    );
    assert.doesNotMatch(visible, /\ud83d(?!\ude00)/u);
  }
  assert.doesNotMatch(text, /\ud83d(?!\ude00)/u);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Pure JSON, a single line/);
  assert.match(WORKHUB_WORKER_STATUS_INSTRUCTION, /Never make a separate report/);
});

test('task-view brief localizes source limits without stripping literal IDs or HTML from original user text', () => {
  const wording =
    'Keep the literal Session ID user-written-id and <script>alert(1)</script> unchanged';
  const brief: WorkHubTaskBrief = {
    taskId: 'private-task-id',
    sourceActionId: 'private-source-id',
    goal: { text: wording, messageId: 'private-goal-id', actionId: 'private-source-id', at: 1 },
    requirements: [
      {
        text: 'Only change validation',
        messageId: 'private-input-id',
        actionId: 'private-source-id',
        at: 2,
      },
    ],
    omittedRequirements: 3,
    files: [],
    limits: [
      { kind: 'missing_execution', actionId: 'private-missing-id' },
      { kind: 'unknown_inputs', count: 2 },
    ],
  };
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    const text = formatWorkHubTaskBrief(brief, locale);
    assert.ok(
      text.includes(JSON.stringify(wording)),
      'presentation never regex-redacts user wording',
    );
    assert.doesNotMatch(
      text,
      /private-(?:task|source|goal|input|missing)-id|read\(taskId=|session-todo/u,
    );
    assert.match(text, /2/u);
    assert.match(text, /3/u);
    assert.match(
      text,
      locale === 'en'
        ? /unknown|Source limitation|Omitted/u
        : locale === 'zh-CN'
          ? /未知|来源限制|已省略/u
          : /未知|來源限制|已省略/u,
    );
  }
  assert.match(
    formatWorkHubTaskBrief(brief),
    /private-missing-id/u,
    'the existing model-facing provenance format is retained',
  );
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
