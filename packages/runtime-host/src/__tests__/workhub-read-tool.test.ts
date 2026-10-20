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

// Unit tests of the native read adapter. All Root authority and
// readers are injected seams; this is NOT production authorization/provider proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorkHubReadTool } from '../server/workhub-read-tool.js';
import { z } from 'zod';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import type {
  SessionHeader,
  StoredMessage,
  WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
type TestReadResponse = {
  status: string;
  reason?: string;
  nextCursor: string | null;
  transcript: { nextCursor?: string | null };
  history: { nextCursor?: string | null };
  tasks: { taskId: string; sourceActionId: string }[];
  entries: {
    messageId: string;
    origin: string;
    text: string;
    textOffset: number;
    textSource: string;
  }[];
};

const coor = 'maka_workhub_coordination';
const source: WorkHubDelegationAssignedMessage = {
  type: 'workhub_coordination',
  schemaVersion: 4,
  kind: 'delegation_assigned',
  id: 'wha_' + 'a'.repeat(48),
  turnId: 'source-turn',
  coordinationTurnId: 'source-turn',
  ts: 1,
  actionFingerprint: `sha256:${'a'.repeat(64)}`,
  disposition: 'delegate_existing',
  actionId: 'source-a',
  delegationId: 'delegation-a',
  targetSessionId: 'worker-a',
  targetSessionName: 'Worker A',
  targetTurnId: 'worker-turn',
  targetMessageId: 'message-a',
  userText: 'Original task',
  work: { id: 'work-a', generationId: 'generation-a' },
  returnResults: true,
};
function context(sessionId = coor): MakaToolContext {
  return {
    sessionId,
    turnId: 'turn',
    runId: 'run',
    invocationId: 'invocation',
    toolCallId: 'call',
    cwd: '/workspace',
    emitOutput() {},
    abortSignal: new AbortController().signal,
  };
}
function fixture() {
  const facts: { sequence: number; message: StoredMessage }[] = [];
  const calls: unknown[][] = [];
  let latest: WorkHubDelegationAssignedMessage | undefined = source;
  let header: Partial<SessionHeader> = { backend: 'ai-sdk', labels: [] };
  let resultRun = 'result-run';
  let historyLimit: { status: 'unsupported'; reason: string } | undefined;
  const tool = createWorkHubReadTool({
    sessions: {
      readWorkHubAssignment: async (actionId) => {
        calls.push(['anchor', actionId]);
        return actionId === source.actionId ? source : latest;
      },
      readLatestWorkHubAssignment: async (taskId) =>
        taskId === 'work-a'
          ? latest
          : { ...source, actionId: 'source-b', work: { id: taskId, generationId: taskId } },
      readHeaderSnapshot: async () => header as SessionHeader,
      readWorkHubTaskFactsPage: async (request) => ({
        highWaterSequence: facts.at(-1)?.sequence ?? null,
        records: facts
          .filter((row) => row.sequence < (request.beforeSequence ?? Number.MAX_SAFE_INTEGER))
          .reverse()
          .slice(0, request.maxMessages),
      }),
    },
    admission: new SessionAdmissionGate(),
    authorize: async (ctx) => {
      calls.push(['authorize', ctx.sessionId]);
      if (ctx.sessionId === coor) return undefined;
      if (ctx.sessionId === source.targetSessionId) return source;
      throw Error('Not a current owned Root');
    },
    status: async () => ({
      task: { status: 'running' },
      delivery: { text: 'must not leak into status' },
    }),
    result: async ({ actionId, offset }) => {
      calls.push(['result', actionId, offset]);
      return {
        sessionId: source.targetSessionId,
        turnId: 'result-turn',
        runId: resultRun,
        eventKey: 'terminal',
        status: 'completed',
        result: 'page',
        nextOffset: offset === 0 ? 16000 : null,
      };
    },
    evidence: async (input) => {
      calls.push(['evidence', input]);
      return {
        status: 'ok',
        evidence: { status: 'completed', messages: ['allowed evidence'], nextCursor: null },
      };
    },
    catalog: async (input) => ({
      status: 'ok',
      tasks: [{ workId: 'work-b', actionId: 'source-b' }],
      nextCursor: input.cursor ? null : 'native-catalog-cursor',
    }),
    history: async (input) => {
      calls.push(['history', input]);
      if (historyLimit) return historyLimit;
      return {
        status: 'ok',
        history: {
          records: ['accepted user / tool records'],
          nextCursor: input.cursor ? null : 'native-inner-history',
        },
      };
    },
    inspect: async (input) => ({
      status: 'ok',
      observedAt: 1,
      executionEvidence: { status: 'running' },
      transcript: {
        messages: ['ordinary user/assistant'],
        nextCursor: input.cursor ? null : 'native-inner-transcript',
      },
    }),
  });
  const read = async (input: Parameters<typeof tool.impl>[0], ctx: MakaToolContext = context()) =>
    (await tool.impl(input, ctx)) as TestReadResponse;
  return {
    tool,
    read,
    calls,
    facts,
    setLatest: (value: WorkHubDelegationAssignedMessage | undefined) => {
      latest = value;
    },
    setResultRun: (value: string) => {
      resultRun = value;
    },
    setHeader: (value: Partial<SessionHeader>) => {
      header = value;
    },
    setHistoryLimit: (value: { status: 'unsupported'; reason: string }) => {
      historyLimit = value;
    },
  };
}
test('read status strips full results and validates real reader callback', async () => {
  const f = fixture();
  assert.deepEqual(await f.read({ taskId: 'work-a' }, context()), { task: { status: 'running' } });
  await assert.rejects(f.read({ taskId: 'work-a' }, context('foreign')), /owned Root/);
});
test('raw history stays own-task and its inner cursor is scoped', async () => {
  const f = fixture(),
    ctx = context('worker-a');
  const first = await f.read({ taskId: 'work-a', view: 'history', kinds: ['user'] }, ctx);
  assert.ok(first.nextCursor && first.nextCursor !== 'native-inner-history');
  assert.equal(first.history.nextCursor, undefined);
  const second = await f.read(
    { taskId: 'work-a', view: 'history', kinds: ['user'], cursor: first.nextCursor },
    ctx,
  );
  assert.equal(second.nextCursor, null);
  assert.ok(
    f.calls.some(
      (row) =>
        row[0] === 'history' && (row[1] as { cursor?: string }).cursor === 'native-inner-history',
    ),
  );
  await assert.rejects(f.read({ taskId: 'work-b', view: 'history' }, ctx), /same task/);
  await assert.rejects(
    f.read(
      { taskId: 'work-a', view: 'history', kinds: ['tool_result'], cursor: first.nextCursor },
      ctx,
    ),
    /cursor/,
  );
  await assert.rejects(
    f.read(
      { taskId: 'work-a', view: 'history', kinds: ['user'], cursor: first.nextCursor },
      context(),
    ),
    /cursor/,
  );
});
test('other-task status uses only existing result evidence', async () => {
  const f = fixture();
  assert.deepEqual(await f.read({ taskId: 'work-b', view: 'status' }, context('worker-a')), {
    status: 'ok',
    state: 'completed',
    scope: 'result_enabled_task',
  });
  assert.ok(f.calls.some((row) => row[0] === 'evidence'));
  await assert.rejects(
    f.read({ sessionRef: 'manual', view: 'history' }, context('worker-a')),
    /arbitrary Sessions/,
  );
});
test('workers retain bounded evidence discovery without exposing raw sessions', async () => {
  const f = fixture();
  const first = await f.read({ view: 'catalog', query: 'checksum' }, context('worker-a'));
  assert.deepEqual(
    first.tasks.map(({ taskId, sourceActionId }) => ({ taskId, sourceActionId })),
    [{ taskId: 'work-b', sourceActionId: 'source-b' }],
  );
  assert.ok(first.nextCursor && first.nextCursor !== 'native-catalog-cursor');
  const next = await f.read(
    { view: 'catalog', query: 'checksum', cursor: first.nextCursor },
    context('worker-a'),
  );
  assert.equal(next.nextCursor, null);
  await assert.rejects(
    f.read({ view: 'catalog', query: 'other', cursor: first.nextCursor }, context('worker-a')),
    /cursor/,
  );
  await assert.rejects(f.read({ view: 'catalog' }, context()), /find tool/);
  await assert.rejects(f.read({ view: 'catalog', taskId: 'work-b' }, context('worker-a')));
});
test('explicit manual reads wrap transcript cursor and never conflate full task results', async () => {
  const f = fixture();
  const first = await f.read({ sessionRef: 'manual', view: 'history' }, context());
  assert.ok(first.nextCursor);
  assert.equal(first.transcript.nextCursor, undefined);
  const next = await f.read(
    { sessionRef: 'manual', view: 'history', cursor: first.nextCursor },
    context(),
  );
  assert.equal(next.nextCursor, null);
  await assert.rejects(
    f.read({ taskId: 'manual', view: 'history', cursor: first.nextCursor }, context()),
    /cursor/,
  );
  await assert.rejects(f.read({ sessionRef: 'manual', view: 'result' }, context()));
  assert.deepEqual(await f.read({ sessionRef: 'manual', view: 'status' }, context()), {
    status: 'ok',
    scope: 'manual_session_latest_root',
    observedAt: 1,
    executionEvidence: { status: 'running' },
  });
});
test('coor requirements retain original text, bounded Unicode pages and fixed source', async () => {
  const f = fixture();
  const original = 'x'.repeat(7999) + '😀' + 'correction'.repeat(200);
  f.facts.push({
    sequence: 1,
    message: {
      ...source,
      id: 'initial-request',
      ts: 1,
      userText: original,
      delegationText: 'prepared text is not original user input',
    },
  });
  f.facts.push({
    sequence: 2,
    message: {
      type: 'workhub_coordination',
      kind: 'task_input',
      schemaVersion: 1,
      id: 'feedback',
      turnId: 'source-turn',
      ts: 2,
      inputId: 'feedback',
      workId: 'work-a',
      generationId: 'generation-a',
      sourceDelegationId: source.delegationId,
      targetSessionId: source.targetSessionId,
      targetMessageId: 'feedback-message',
      targetContentDigest: `sha256:${'b'.repeat(64)}`,
      mode: 'queued_supplement',
      text: 'prepared reminder',
      originalUserText: 'historical feedback',
      inputOrigin: 'feedback',
      sourceActionId: source.actionId,
    },
  });
  const first = await f.read({ taskId: 'work-a', view: 'requirements' }, context());
  assert.ok(first.nextCursor);
  assert.equal(first.entries[0].origin, 'feedback');
  assert.equal(first.entries[0].textSource, 'original_user_text');
  assert.equal(first.entries[0].text, 'historical feedback');
  const fragment = first.entries.find((entry) => entry.messageId === 'initial-request');
  assert.ok(fragment);
  assert.equal(fragment.textSource, 'recorded_user_context');
  assert.ok(fragment.text.length < 8000);
  assert.doesNotMatch(fragment.text, /[\uD800-\uDBFF]$/u);
  assert.equal(Object.hasOwn(fragment, 'acceptedInstruction'), false);
  f.setLatest({
    ...source,
    actionId: 'new-source',
    work: { id: 'work-a', generationId: 'new-generation' },
  });
  const second = await f.read(
    { taskId: 'work-a', view: 'requirements', cursor: first.nextCursor },
    context(),
  );
  assert.equal(fragment.text + second.entries[0].text, original);
  assert.ok(f.calls.some((row) => row[0] === 'anchor' && row[1] === source.actionId));
  await assert.rejects(
    f.read({ taskId: 'work-a', view: 'history', kinds: ['tool_result'] }, context()),
    /worker raw/,
  );
});
test('coor paged result cannot silently select a newer assignment', async () => {
  const f = fixture();
  const first = await f.read({ taskId: 'work-a', view: 'result' }, context());
  assert.ok(first.nextCursor);
  f.setLatest({ ...source, actionId: 'new-source' });
  await f.read({ taskId: 'work-a', view: 'result', cursor: first.nextCursor }, context());
  assert.deepEqual(
    f.calls.filter((row) => row[0] === 'result'),
    [
      ['result', source.actionId, 0],
      ['result', source.actionId, 16000],
    ],
  );
});
test('requirements refuse a rolled-back canonical snapshot instead of reporting empty history', async () => {
  const f = fixture();
  f.facts.push(
    { sequence: 1, message: { ...source, id: 'original', userText: 'original requirement' } },
    { sequence: 2, message: { ...source, id: 'later', userText: 'later requirement' } },
  );
  const first = await f.read({ taskId: 'work-a', view: 'requirements' });
  assert.ok(first.nextCursor);
  f.facts.pop();
  await assert.rejects(
    f.read({ taskId: 'work-a', view: 'requirements', cursor: first.nextCursor }),
    /snapshot is no longer available/,
  );
});
test('coor paged result detects a newer execution behind the same action', async () => {
  const f = fixture();
  const first = await f.read({ taskId: 'work-a', view: 'result' }, context());
  assert.ok(first.nextCursor);
  f.setResultRun('later-run');
  await assert.rejects(
    f.read({ taskId: 'work-a', view: 'result', cursor: first.nextCursor }, context()),
    /execution changed/,
  );
});
test('an explicit result source stays in its task and cannot change a paged cursor', async () => {
  const f = fixture();
  f.setLatest({ ...source, actionId: 'new-source' });
  const first = await f.read({ taskId: 'work-a', view: 'result', sourceActionId: source.actionId });
  assert.ok(first.nextCursor);
  assert.deepEqual(
    f.calls.filter((row) => row[0] === 'result'),
    [['result', source.actionId, 0]],
  );
  await assert.rejects(
    f.read({
      taskId: 'work-a',
      view: 'result',
      cursor: first.nextCursor,
      sourceActionId: 'new-source',
    }),
    /cursor source changed/,
  );
  await f.read({ taskId: 'work-a', view: 'result', cursor: first.nextCursor });
  assert.equal(
    (
      await f.read(
        { taskId: 'work-b', view: 'result', sourceActionId: source.actionId },
        context('worker-a'),
      )
    ).status,
    'unavailable',
  );
  for (const input of [
    { taskId: 'work-a', sourceActionId: source.actionId },
    { sessionRef: 'manual', view: 'reply' as const, sourceActionId: source.actionId },
  ])
    await assert.rejects(f.read(input));
});
test('read routes executor task history to the native reader and retains ineligible source checks', async () => {
  const f = fixture();
  f.setHeader({ backend: 'plugin-executor', labels: [] });
  const executor = await f.read({ taskId: 'work-a', view: 'history' }, context('worker-a'));
  assert.equal(executor.status, 'ok');
  assert.equal(
    f.calls.some((call) => call[0] === 'history'),
    true,
  );
  f.setHistoryLimit({ status: 'unsupported', reason: 'Native records have an unsupported shape' });
  const limited = await f.read({ taskId: 'work-a', view: 'history' }, context('worker-a'));
  assert.equal(limited.status, 'unsupported');
  assert.equal(limited.reason, 'Native records have an unsupported shape');
  const excluded: Partial<SessionHeader>[] = [
    { backend: 'ai-sdk', labels: [], isArchived: true },
    { backend: 'ai-sdk', labels: [], role: 'workhub_coordination' },
    {
      backend: 'ai-sdk',
      labels: [],
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'parent',
        lifecycle: 'foreground',
        spawnedBy: { parentRunId: 'parent-run', parentTurnId: 'parent-turn', toolCallId: 'spawn' },
      },
    },
    { backend: 'ai-sdk', labels: ['mode:side_conversation'] },
  ];
  for (const header of excluded) {
    f.setHeader(header);
    assert.equal(
      (await f.read({ taskId: 'work-a', view: 'history' }, context())).status,
      'unavailable',
    );
  }
  f.setLatest(undefined);
  assert.equal(
    (await f.read({ taskId: 'work-a', view: 'history' }, context())).status,
    'unavailable',
  );
});
test('read model parameters do not accept actor, permission or execution authority fields', () => {
  const f = fixture();
  for (const extra of [
    { actor: 'coordinator' },
    { permissionMode: 'bypass' },
    { generationId: 'fake' },
    { sourceTurnId: 'other' },
    { operation: 'resolve' },
    { confirmed: true },
  ])
    assert.equal(
      (f.tool.parameters as z.ZodType).safeParse({ taskId: 'work-a', ...extra }).success,
      false,
    );
});
