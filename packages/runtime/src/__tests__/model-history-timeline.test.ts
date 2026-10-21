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
import {
  buildRuntimeEventModelReplayPlan,
  buildRuntimeEventReplayTimeline,
  estimateRuntimeEventsTokens,
  type RuntimeEventModelReplayPlan,
} from '../model-history.js';
import { isHistoryCompactContentEvent } from '../history-compaction.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { projectWorkHubResultContext } from '@maka/core/workhub-result-context';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { jsonSchema } from 'ai';
import { AiSdkMessageProjection } from '../ai-sdk-message-projection.js';
import { ModelAdapter } from '../model-adapter.js';
import { getAIModel } from '../model-factory.js';

test('model history compacts only source-bound Host result notifications without changing the ledger', () => {
  const origin = {
    kind: 'workhub_result' as const,
    eventId: 'host-result',
    actionId: 'source-action',
    delegationId: 'source-delegation',
    targetSessionId: 'source-session',
    targetTurnId: 'source-turn',
  };
  const text =
    'Host notification: delegated work has new information. This is not a new user request.\n\n' +
    JSON.stringify({
      actionId: origin.actionId,
      delegationId: origin.delegationId,
      targetSessionId: origin.targetSessionId,
      targetTurnId: origin.targetTurnId,
      targetRunId: 'source-run',
      originalRequest: 'Original objective',
      latestUserInput: 'Use the corrected output, not the original output.',
      status: 'completed',
      sharedTurn: false,
      result: '中文😀\\\n"'.repeat(10000) + 'FULL_RESULT_TAIL',
      resultTruncated: false,
      details: null,
    });
  const notification = {
    ...event({
      id: 'host-notification',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text, origin },
    }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  };
  const human = {
    ...event({
      id: 'human-lookalike',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text },
    }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  };
  const raw = JSON.stringify([notification, human]);
  const plan = buildRuntimeEventModelReplayPlan([notification, human]);
  assert.equal(JSON.stringify([notification, human]), raw);
  const compact = plan.items.find((item) => item.eventId === notification.id);
  const unchanged = plan.items.find((item) => item.eventId === human.id);
  assert.ok(compact?.kind === 'text');
  assert.ok(unchanged?.kind === 'text');
  assert.ok(Buffer.byteLength(JSON.stringify(compact.content), 'utf8') <= 7500);
  assert.ok(compact.content.includes('"actionId":"source-action"'));
  assert.ok(compact.content.includes('"resultTruncated":true'));
  assert.ok(compact.content.includes('Use the corrected output, not the original output.'));
  assert.ok(!compact.content.includes('FULL_RESULT_TAIL'));
  assert.equal(unchanged.content, text, 'human text is never identified by a string prefix');
  const copy = buildRuntimeEventModelReplayPlan([{ ...notification, sessionId: 'ordinary-copy' }])
    .items[0];
  assert.ok(copy?.kind === 'text');
  assert.equal(copy.content, text, 'ordinary copied conversations retain their source text');
});

test('committed native WorkHub receipts remain visible after their user input and survive compaction sizing', () => {
  const user = {
    ...event({
      id: 'native-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Correct A' },
    }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  };
  const receipt: RuntimeEvent = {
    ...event({ id: 'native-receipt', role: 'system', author: 'host' }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    modelVisibility: 'hidden',
    actions: {
      coordination: {
        actionId: 'accepted-action',
        userText: 'Correct A',
        result: {
          disposition: 'delegate_existing',
          workId: 'work-a',
          targetSessionId: 'session-a',
          targetMessageId: 'message-a',
        },
      },
    },
  };
  const raw = JSON.stringify(receipt);
  const plan = buildRuntimeEventModelReplayPlan([user, receipt]);
  const acknowledgment = plan.items[1];
  assert.ok(acknowledgment?.kind === 'text');
  assert.equal(acknowledgment.role, 'assistant');
  assert.ok(acknowledgment.content.includes('accepted-action'));
  assert.ok(acknowledgment.content.includes('message-a'));
  assert.ok(acknowledgment.content.includes('not a new request'));
  assert.ok(isHistoryCompactContentEvent(receipt));
  assert.ok(estimateRuntimeEventsTokens([receipt]) > 0);
  assert.equal(JSON.stringify(receipt), raw, 'receipt projection never edits durable facts');
  for (const rejected of [
    { ...receipt, sessionId: 'ordinary-session' },
    { ...receipt, partial: true },
    { ...receipt, author: 'agent' as const },
    { ...receipt, actions: { coordination: { ...receipt.actions!.coordination!, actionId: '' } } },
  ]) {
    assert.equal(buildRuntimeEventModelReplayPlan([rejected]).items.length, 0);
  }
});

test('a stopped WorkHub coordinator keeps its cancellation fact beside its historical request', async () => {
  const inCoordinator = (value: RuntimeEvent): RuntimeEvent => ({
    ...value,
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  });
  const user = inCoordinator(
    event({
      id: 'stopped-request',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Add a regression to the earlier task.' },
    }),
  );
  const stopped: RuntimeEvent = {
    ...inCoordinator(event({ id: 'stopped-terminal', role: 'system', author: 'system' })),
    status: 'aborted',
    modelVisibility: 'hidden',
    actions: { endInvocation: true, stateDelta: { abortSource: 'user_stop' } },
  };
  const next = inCoordinator(
    inInvocation(
      event({
        id: 'new-request',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'Start a separate new task.' },
      }),
      'next',
    ),
  );
  const events = [user, stopped, next];
  const raw = JSON.stringify(events);
  const plan = buildRuntimeEventModelReplayPlan(events);
  assert.deepEqual(
    plan.items.map((item) => item.eventId),
    events.map((value) => value.id),
  );
  const fact = plan.items[1];
  assert.ok(fact?.kind === 'text');
  assert.equal(fact.role, 'assistant', 'the Host lifecycle fact is not a new user instruction');
  assert.match(fact.content, /"terminalEventId":"stopped-terminal"/);
  assert.match(fact.content, /"turnId":"turn-1"/);
  assert.match(fact.content, /"runId":"run-1"/);
  assert.match(fact.content, /"invocationId":"invocation-1"/);
  assert.match(fact.content, /"status":"aborted"/);
  assert.match(fact.content, /"abortSource":"user_stop"/);
  assert.match(fact.content, /unsubmitted work.*not a pending request/);
  assert.match(fact.content, /committed task operations remain unchanged/);
  assert.ok(isHistoryCompactContentEvent(stopped));
  assert.ok(estimateRuntimeEventsTokens([stopped]) > 0);
  const native = await fixtureReplay(plan);
  assert.ok(JSON.stringify(native).includes('stopped-terminal'));
  assert.ok(JSON.stringify(plan.textMessages).includes('stopped-terminal'));
  assert.equal(JSON.stringify(events), raw, 'request projection never edits the ledger');
});

test('WorkHub cancellation projection does not erase committed effects or a later explicit request', () => {
  const coordinator = (value: RuntimeEvent): RuntimeEvent => ({
    ...value,
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  });
  const call = coordinator({
    ...toolCall('already-started'),
    content: {
      kind: 'function_call',
      id: 'start-1',
      name: 'mcp__desktop_workhub__start',
      args: { title: 'A', text: 'Implement A' },
    },
  });
  const result = coordinator({
    ...toolResult('accepted-start'),
    content: {
      kind: 'function_response',
      id: 'start-1',
      name: 'mcp__desktop_workhub__start',
      result: { taskId: 'task-a', status: 'admitted' },
    },
  });
  const stopped: RuntimeEvent = coordinator({
    ...event({ id: 'stop-after-start', role: 'system', author: 'host' }),
    status: 'cancelled',
    actions: { endInvocation: true, stateDelta: { abortSource: 'user_stop' } },
  });
  const resumed = coordinator(
    inInvocation(
      event({
        id: 'explicitly-resume',
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'Now explicitly continue the earlier task.' },
      }),
      'later',
    ),
  );
  const plan = buildRuntimeEventModelReplayPlan([call, result, stopped, resumed]);
  assert.deepEqual(
    plan.items.map((item) => item.eventId),
    [call.id, result.id, stopped.id, resumed.id],
  );
  assert.equal(plan.items[0]?.kind, 'tool_call');
  assert.equal(plan.items[1]?.kind, 'tool_result');
  assert.equal(plan.items.at(-1)?.kind, 'text');
  assert.ok(JSON.stringify(plan.items.at(-1)).includes('Now explicitly continue'));
});

test('only native WorkHub cancellation facts are projected and unknown abort causes do not imply user withdrawal', () => {
  const terminal: RuntimeEvent = {
    ...event({ id: 'native-stop', role: 'system', author: 'system' }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    status: 'aborted',
    actions: { endInvocation: true, stateDelta: { abortSource: 'user_stop' } },
  };
  for (const rejected of [
    { ...terminal, sessionId: 'ordinary-session' },
    { ...terminal, partial: true },
    { ...terminal, role: 'tool' as const, author: 'tool' as const },
    { ...terminal, role: 'model' as const, author: 'agent' as const },
    { ...terminal, status: 'completed' as const },
    { ...terminal, status: 'streaming' as const },
    { ...terminal, actions: { stateDelta: { abortSource: 'user_stop' } } },
  ]) {
    assert.equal(buildRuntimeEventModelReplayPlan([rejected]).items.length, 0);
  }
  const unknown: RuntimeEvent = { ...terminal, actions: { endInvocation: true } };
  const item = buildRuntimeEventModelReplayPlan([unknown]).items[0];
  assert.ok(item?.kind === 'text');
  assert.match(item.content, /"abortSource":"unknown"/);
  assert.doesNotMatch(item.content, /The user stopped|unsubmitted work/);
});

test('malformed or mismatched Host result data cannot substitute another source in replay', () => {
  const origin = {
    kind: 'workhub_result' as const,
    eventId: 'result',
    actionId: 'actual-action',
    delegationId: 'actual-delegation',
    targetSessionId: 'actual-session',
    targetTurnId: 'actual-turn',
  };
  for (const text of [
    'legacy payload without recognized JSON',
    JSON.stringify({
      ...origin,
      actionId: 'foreign-action',
      status: 'completed',
      result: 'foreign',
    }),
  ]) {
    const plan = buildRuntimeEventModelReplayPlan([
      {
        ...event({
          id: 'legacy-notice',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text, origin },
        }),
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
      },
    ]);
    const item = plan.items[0];
    assert.ok(item?.kind === 'text');
    assert.ok(item.content.includes('"actionId":"actual-action"'));
    assert.ok(item.content.includes('"status":"unknown"'));
    assert.ok(!item.content.includes('foreign'));
  }
});

test('compact replay preserves opaque released origin references without tightening their codec', () => {
  for (const id of ['legacy:action.name', 'a'.repeat(256), '\u0000'.repeat(256)]) {
    const origin = {
      kind: 'workhub_result' as const,
      eventId: 'notice',
      actionId: id,
      delegationId: id,
      targetSessionId: id,
      targetTurnId: id,
    };
    const text = JSON.stringify({
      actionId: id,
      delegationId: id,
      targetSessionId: id,
      targetTurnId: id,
      status: 'completed',
      result: 'Committed source result.',
    });
    const projected = projectWorkHubResultContext(text, origin);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 6144);
    const data = JSON.parse(projected.split('\n\n').at(-1)!);
    assert.equal(data.actionId, id);
    assert.notEqual(data.sourceUnavailable, true);
    assert.equal(data.status, data.referenceFieldsOmitted ? 'unknown' : 'completed');
    assert.equal(projectWorkHubResultContext(projected, origin), projected);
  }
});

test('model history drops repaired assistant prefixes by default and diagnoses the boundary', () => {
  const repairedAssistant = {
    ...event({
      id: 'repaired-assistant',
      role: 'model',
      author: 'agent',
      content: { kind: 'text' as const, text: 'Recovered opening answer' },
    }),
    refs: { storedMessageId: 'stored-assistant' },
  };
  const user = event({
    id: 'first-user',
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'Continue from here' },
  });

  const ordinary = buildRuntimeEventModelReplayPlan([repairedAssistant, user]);
  const admittedContinuation = buildRuntimeEventModelReplayPlan([repairedAssistant, user], {
    allowRepairedAssistantPrefix: true,
  });

  assert.deepEqual(
    ordinary.items.map((item) => item.eventId),
    ['first-user'],
  );
  assert.deepEqual(
    ordinary.diagnostics.filter(({ code }) => code === 'repaired_prefix_dropped'),
    [
      {
        code: 'repaired_prefix_dropped',
        message: 'repaired assistant prefix dropped before provider replay user boundary',
        eventId: 'repaired-assistant',
        turnId: 'turn-1',
        detail: { droppedEventCount: 1 },
      },
    ],
  );
  assert.deepEqual(
    admittedContinuation.items.map((item) => item.eventId),
    ['repaired-assistant', 'first-user'],
  );
});

test('model history keeps reused step ids as separate chronological segments', () => {
  const items = buildRuntimeEventModelReplayPlan([
    assistantText('text-a', 'shared-step', 'Text A'),
    assistantText('text-b', 'intervening-step', 'Text B'),
    toolCall('call', 'shared-step'),
    toolResult('result'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).map((entry) => {
      if (entry.kind !== 'assistant_step') return entry.kind;
      return {
        stepId: entry.stepId,
        text: entry.text?.content,
        calls: entry.calls.map(({ call, result }) => ({
          id: call.toolCallId,
          settled: result !== undefined,
        })),
      };
    }),
    [
      { stepId: 'shared-step', text: 'Text A', calls: [] },
      { stepId: 'intervening-step', text: 'Text B', calls: [] },
      { stepId: 'shared-step', text: undefined, calls: [{ id: 'read-1', settled: true }] },
    ],
  );
});

test('model history separates settled legacy calls but keeps overlapping calls together', () => {
  const settledItems = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', undefined, 'read-1'),
    toolResult('result-1', 'read-1', 'first'),
    toolCall('call-2', undefined, 'read-2'),
    toolResult('result-2', 'read-2', 'second'),
  ]).items;
  const overlappingItems = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', undefined, 'read-1'),
    toolCall('call-2', undefined, 'read-2'),
    toolResult('result-1', 'read-1', 'first'),
    toolResult('result-2', 'read-2', 'second'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(settledItems).map((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ call }) => call.toolCallId) : [],
    ),
    [['read-1'], ['read-2']],
  );
  assert.deepEqual(
    buildRuntimeEventReplayTimeline(overlappingItems).map((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ call }) => call.toolCallId) : [],
    ),
    [['read-1', 'read-2']],
  );
});

test('model history pairs reused tool call ids by durable occurrence', () => {
  const items = buildRuntimeEventModelReplayPlan([
    toolCall('call-1', 'step-1'),
    toolResult('result-1', 'read-1', 'first'),
    toolCall('call-2', 'step-2'),
    toolResult('result-2', 'read-1', 'second'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).flatMap((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ result }) => result?.output) : [],
    ),
    ['first', 'second'],
  );
});

test('model history does not pair an orphan result with a later reused call id', () => {
  const items = buildRuntimeEventModelReplayPlan([
    toolResult('orphan-result', 'read-1', 'orphan'),
    toolCall('call', 'step-1'),
    toolResult('matching-result', 'read-1', 'matching'),
  ]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).flatMap((entry) =>
      entry.kind === 'assistant_step' ? entry.calls.map(({ result }) => result?.output) : [],
    ),
    ['matching'],
  );
});

test('model history scopes reused tool call ids to their invocation', () => {
  const callA = inInvocation(toolCall('call-a', 'shared-step'), 'a');
  const callB = inInvocation(toolCall('call-b', 'shared-step'), 'b');
  const resultB = inInvocation(toolResult('result-b', 'read-1', 'second'), 'b');

  const plan = buildRuntimeEventModelReplayPlan([callA, callB, resultB]);

  assert.deepEqual(
    plan.diagnostics
      .filter(({ code }) => code === 'unmatched_tool_call')
      .map(({ eventId }) => eventId),
    ['call-a'],
  );
  assert.deepEqual(
    buildRuntimeEventReplayTimeline(plan.items).flatMap((entry) =>
      entry.kind === 'assistant_step'
        ? entry.calls.map(({ call, result }) => ({
            call: call.eventId,
            result: result?.eventId,
          }))
        : [],
    ),
    [{ call: 'call-b', result: 'result-b' }],
  );
});

test('retired WorkHub operations replay as historical facts, not executable tool examples', async () => {
  const name = 'mcp__desktop_workhub__tasks';
  const args = { request: { operation: 'delegate', text: 'Keep the corrected user requirement.' } };
  const events = [
    event({
      id: 'user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Continue A' },
    }),
    event({
      id: 'old-call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'old', name, args },
    }),
    event({
      id: 'old-result',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'old',
        name,
        result: { admitted: true, workId: 'original-A' },
      },
    }),
    event({
      id: 'bad-call',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'bad',
        name: 'invalid',
        args: { tool: name, error: 'returned tool is unavailable' },
      },
    }),
    event({
      id: 'bad-result',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'bad',
        name: 'invalid',
        result: { kind: 'text', text: 'Unavailable; no work performed' },
        isError: true,
      },
    }),
    toolCall('current-call', 'current-step'),
    toolResult('current-result', 'read-1', 'current output'),
  ].map((item) => ({ ...item, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
  const raw = JSON.stringify(events);
  const plan = buildRuntimeEventModelReplayPlan(events);
  assert.deepEqual(
    plan.items.flatMap((item) =>
      item.kind === 'tool_call' && !item.retiredWorkHubOperation ? [item.toolName] : [],
    ),
    ['Read'],
  );
  const messages = await fixtureReplay(plan);
  assert.deepEqual(
    messages.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.flatMap((part) => (part.type === 'tool-call' ? [part.toolName] : [])),
    ),
    ['Read'],
  );
  const facts = messages
    .flatMap((message) =>
      typeof message.content === 'string'
        ? [message.content]
        : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
  assert.ok(facts.includes('Keep the corrected user requirement.'));
  assert.ok(facts.includes('original-A'));
  assert.ok(facts.includes('Unavailable; no work performed'));
  assert.ok(facts.includes('"isError":true'));
  assert.ok(facts.includes('Historical retired WorkHub operation'));
  assert.equal(JSON.stringify(events), raw, 'UI and durable history are not edited');
  assert.deepEqual(plan.diagnostics, []);

  const ordinary = buildRuntimeEventModelReplayPlan(
    events.map((item) => ({ ...item, sessionId: 'ordinary' })),
  );
  assert.equal(
    ordinary.items.filter((item) => item.kind === 'tool_call').length,
    3,
    'ordinary Sessions are unchanged',
  );
});

test('retired WorkHub facts require the exact paired invocation and leave unknown/current tools intact', async () => {
  const name = 'mcp__desktop_workhub__tasks';
  const call = (id: string, toolName = name) => ({
    ...event({
      id,
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call' as const,
        id: 'reused',
        name: toolName,
        args: { taskId: 'A' },
      },
    }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  });
  const response = (id: string, toolName = name) => ({
    ...event({
      id,
      role: 'tool',
      author: 'tool',
      content: { kind: 'function_response' as const, id: 'reused', name: toolName, result: id },
    }),
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
  });
  const plan = buildRuntimeEventModelReplayPlan([
    inInvocation(call('unsettled'), 'a'),
    inInvocation(call('settled'), 'b'),
    inInvocation(response('settled-result'), 'b'),
    inInvocation(call('new-tool', 'mcp__desktop_workhub__start'), 'c'),
    inInvocation(response('new-result', 'mcp__desktop_workhub__start'), 'c'),
    inInvocation(call('unrelated-tool', 'SomeOtherRetiredTool'), 'd'),
    inInvocation(response('unrelated-result', 'SomeOtherRetiredTool'), 'd'),
  ]);
  assert.deepEqual(
    plan.diagnostics.map((item) => item.eventId),
    ['unsettled'],
  );
  assert.deepEqual(
    plan.items.flatMap((item) =>
      item.kind === 'tool_call' && !item.retiredWorkHubOperation ? [item.toolName] : [],
    ),
    ['mcp__desktop_workhub__start', 'SomeOtherRetiredTool'],
  );
  const facts = JSON.stringify(await fixtureReplay(plan));
  assert.ok(facts.includes('settled-result'));
  assert.ok(!facts.includes('unsettled'));
});

test('retired WorkHub history honors the effective result rather than reviving evicted raw output', async () => {
  const name = 'mcp__desktop_workhub__tasks';
  const events = [
    event({
      id: 'call',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'old', name, args: {} },
    }),
    event({
      id: 'result',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'old',
        name,
        result: 'RAW_OUTPUT_MUST_STAY_EVICTED',
        modelProjection: {
          version: 1,
          kind: 'text',
          text: 'Existing bounded result / original task A',
        },
      },
    }),
  ].map((item) => ({ ...item, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
  const plan = buildRuntimeEventModelReplayPlan(events);
  const request = JSON.stringify(await fixtureReplay(plan));
  assert.ok(!request.includes('RAW_OUTPUT_MUST_STAY_EVICTED'));
  assert.ok(request.includes('Existing bounded result / original task A'));
  assert.ok(JSON.stringify(events).includes('RAW_OUTPUT_MUST_STAY_EVICTED'));
});

test('Command Code Chat wire carries native cancellation and retired operations as facts', async () => {
  const oldName = 'mcp__desktop_workhub__tasks';
  const events = [
    event({
      id: 'user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Original user correction' },
    }),
    event({
      id: 'old',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'old',
        name: oldName,
        args: { request: { operation: 'delegate', text: 'Keep duplicate query keys' } },
      },
    }),
    event({
      id: 'outcome',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'old',
        name: oldName,
        result: { admitted: true, workId: 'original-A' },
      },
    }),
    {
      ...event({ id: 'coordinator-user-stop', role: 'system', author: 'system' }),
      status: 'aborted' as const,
      modelVisibility: 'hidden' as const,
      actions: { endInvocation: true, stateDelta: { abortSource: 'user_stop' } },
    },
    event({
      id: 'latest',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Continue the current A' },
    }),
  ].map((item) => ({ ...item, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
  let wire: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    wire = JSON.parse(await request.text()) as Record<string, unknown>;
    const body = `data: ${JSON.stringify({ id: 'offline', model: 'deepseek/deepseek-v4.1-flash', choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\ndata: [DONE]\n\n`;
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = new ModelAdapter({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    connection: {
      slug: 'commandcode',
      providerType: 'commandcode',
      defaultModel: 'deepseek/deepseek-v4.1-flash',
    },
    apiKey: 'offline-test-only',
    modelId: 'deepseek/deepseek-v4.1-flash',
    modelFactory: (input) => getAIModel({ ...input, fetch }),
    newId: () => 'offline-request',
    now: () => 1,
  });
  const projection = new AiSdkMessageProjection({ modelAdapter: adapter, applyPatchProfile: null });
  const messages = await projection.materializeRuntimeReplayPlan(
    buildRuntimeEventModelReplayPlan(events),
    { used: 0, decisions: new Map() },
    undefined,
    new Set(),
  );
  const names = ['find', 'start', 'continue', 'ask', 'stop'].map(
    (name) => `mcp__desktop_workhub__${name}`,
  );
  const result = await adapter.startStream({
    model: adapter.resolveModel(),
    messages,
    tools: Object.fromEntries(
      names.map((name) => [
        name,
        { description: name, inputSchema: jsonSchema({ type: 'object', properties: {} }) },
      ]),
    ),
    activeTools: names,
    abortSignal: new AbortController().signal,
    repairToolCall: () => null,
    onStreamActivity: () => {},
  });
  for await (const _event of result.events) {
    /* Drain the offline response. */
  }
  assert.ok(wire);
  const tools = wire.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(tools.map((tool) => tool.function.name).sort(), [...names].sort());
  const history = wire.messages as Array<{ role: string; content: unknown; tool_calls?: unknown }>;
  assert.ok(
    history.every((message) => message.tool_calls === undefined && message.role !== 'tool'),
  );
  const text = JSON.stringify(history);
  assert.ok(text.includes('Original user correction'));
  assert.ok(text.includes('Keep duplicate query keys'));
  assert.ok(text.includes('original-A'));
  assert.ok(text.includes('Historical retired WorkHub operation'));
  assert.ok(text.includes('coordinator-user-stop'));
  assert.match(text, /unsubmitted work.*not a pending request/);
  assert.match(text, /committed task operations remain unchanged/);
  const stoppedIndex = history.findIndex((message) =>
    JSON.stringify(message.content).includes('coordinator-user-stop'),
  );
  const latestIndex = history.findIndex((message) =>
    JSON.stringify(message.content).includes('Continue the current A'),
  );
  assert.equal(history[stoppedIndex]?.role, 'assistant');
  assert.ok(stoppedIndex >= 0 && stoppedIndex < latestIndex);
  assert.equal(wire.model, 'deepseek/deepseek-v4.1-flash');
  adapter.dispose();
});

for (const retiredName of ['mcp__desktop_workhub__tasks', 'invalid']) {
  for (const order of ['retired-first', 'current-first', 'interleaved']) {
    test(`retired ${retiredName} keeps signed reasoning with the retained call (${order})`, async () => {
      const retainedName = 'mcp__desktop_workhub__control';
      const oldResult = event({
        id: 'old-result',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'old',
          name: retiredName,
          result: { workId: 'original-A' },
        },
      });
      const currentResult = event({
        id: 'current-result',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'current',
          name: retainedName,
          result: 'current-result',
        },
      });
      const events = [
        event({
          id: 'user',
          role: 'user',
          author: 'user',
          content: { kind: 'text', text: 'Start A' },
        }),
        event({
          id: 'old-call',
          role: 'model',
          author: 'agent',
          refs: { stepId: 'step' },
          content: {
            kind: 'function_call',
            id: 'old',
            name: retiredName,
            args:
              retiredName === 'invalid' ? { tool: 'mcp__desktop_workhub__tasks' } : { taskId: 'A' },
          },
        }),
        ...(order === 'interleaved' ? [oldResult] : []),
        event({
          id: 'current-call',
          role: 'model',
          author: 'agent',
          refs: { stepId: 'step' },
          content: { kind: 'function_call', id: 'current', name: retainedName, args: {} },
        }),
        ...(order === 'interleaved'
          ? [currentResult]
          : order === 'retired-first'
            ? [oldResult, currentResult]
            : [currentResult, oldResult]),
        event({
          id: 'reasoning',
          role: 'model',
          author: 'agent',
          refs: { providerEventId: 'step' },
          content: {
            kind: 'thinking',
            text: 'Synthetic replay fixture',
            signature: 'offline-signature',
          },
        }),
        assistantText('answer', 'step', 'Accepted'),
      ].map((item) => ({ ...item, sessionId: WORKHUB_COORDINATION_SESSION_ID }));
      const adapter = new ModelAdapter({
        connection: {
          slug: 'offline',
          providerType: 'anthropic',
          defaultModel: 'claude-sonnet-4-6',
        },
        apiKey: 'offline',
        modelId: 'claude-sonnet-4-6',
        modelFactory: () => ({}),
        newId: () => 'fixture',
        now: () => 1,
      });
      const messages = await new AiSdkMessageProjection({
        modelAdapter: adapter,
        applyPatchProfile: null,
      }).materializeRuntimeReplayPlan(
        buildRuntimeEventModelReplayPlan(events),
        { used: 0, decisions: new Map() },
        undefined,
        new Set(['reasoning']),
      );
      const toolMessage = messages.find(
        (message) =>
          message.role === 'assistant' &&
          typeof message.content !== 'string' &&
          message.content.some((part) => part.type === 'tool-call'),
      );
      assert.ok(toolMessage?.role === 'assistant' && typeof toolMessage.content !== 'string');
      assert.equal(toolMessage.content[0]?.type, 'reasoning');
      assert.ok(
        toolMessage.content.some(
          (part) => part.type === 'text' && part.text.includes('original-A'),
        ),
      );
      assert.deepEqual(
        toolMessage.content
          .filter((part) => part.type === 'tool-call')
          .map((part) => part.toolName),
        [retainedName],
      );
      assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
      adapter.dispose();
    });
  }
}

test('model history keeps reused step ids separate across invocations', () => {
  const textA = inInvocation(assistantText('text-a', 'shared-step', 'First invocation text'), 'a');
  const callB = inInvocation(toolCall('call-b', 'shared-step'), 'b');
  const resultB = inInvocation(toolResult('result-b'), 'b');

  const items = buildRuntimeEventModelReplayPlan([textA, callB, resultB]).items;

  assert.deepEqual(
    buildRuntimeEventReplayTimeline(items).map((entry) => {
      if (entry.kind !== 'assistant_step') return entry.kind;
      return {
        text: entry.text?.eventId,
        calls: entry.calls.map(({ call }) => call.eventId),
      };
    }),
    [
      { text: 'text-a', calls: [] },
      { text: undefined, calls: ['call-b'] },
    ],
  );
});

async function fixtureReplay(plan: RuntimeEventModelReplayPlan) {
  const adapter = new ModelAdapter({
    connection: {
      slug: 'offline',
      providerType: 'commandcode',
      defaultModel: 'deepseek/deepseek-v4.1-flash',
    },
    apiKey: 'offline',
    modelId: 'deepseek/deepseek-v4.1-flash',
    modelFactory: () => ({}),
    newId: () => 'fixture',
    now: () => 1,
  });
  try {
    return await new AiSdkMessageProjection({
      modelAdapter: adapter,
      applyPatchProfile: null,
    }).materializeRuntimeReplayPlan(plan, { used: 0, decisions: new Map() }, undefined, new Set());
  } finally {
    adapter.dispose();
  }
}

function inInvocation(event: RuntimeEvent, suffix: string): RuntimeEvent {
  return {
    ...event,
    invocationId: `invocation-${suffix}`,
    runId: `run-${suffix}`,
    turnId: `turn-${suffix}`,
  };
}

function assistantText(id: string, stepId: string, text: string): RuntimeEvent {
  return event({
    id,
    role: 'model',
    author: 'agent',
    refs: { providerEventId: stepId },
    content: { kind: 'text', text },
  });
}

function toolCall(id: string, stepId?: string, toolCallId = 'read-1'): RuntimeEvent {
  return event({
    id,
    role: 'model',
    author: 'agent',
    refs: stepId ? { stepId } : undefined,
    content: {
      kind: 'function_call',
      id: toolCallId,
      name: 'Read',
      args: { path: 'notes.md' },
    },
  });
}

function toolResult(id: string, toolCallId = 'read-1', result = 'contents'): RuntimeEvent {
  return event({
    id,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: toolCallId,
      name: 'Read',
      result,
    },
  });
}

function event(
  input: Pick<RuntimeEvent, 'id' | 'role' | 'author' | 'content'> &
    Partial<Pick<RuntimeEvent, 'refs'>>,
): RuntimeEvent {
  return {
    ...input,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
  };
}
