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
} from '../model-history.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { projectWorkHubResultContext } from '@maka/core/workhub-result-context';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';

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
  assert.ok(!compact.content.includes('FULL_RESULT_TAIL'));
  assert.equal(unchanged.content, text, 'human text is never identified by a string prefix');
  const copy = buildRuntimeEventModelReplayPlan([{ ...notification, sessionId: 'ordinary-copy' }])
    .items[0];
  assert.ok(copy?.kind === 'text');
  assert.equal(copy.content, text, 'ordinary copied conversations retain their source text');
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
