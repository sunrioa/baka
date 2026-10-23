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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { planHistoryCompaction, isHistoryCompactContentEvent } from '../history-compaction.js';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
} from '../history-compact-checkpoint.js';
import { buildLlmHistorySummarizer } from '../history-compact-summarizer.js';
import { buildRuntimeEventModelReplayPlan } from '../model-history.js';
import { testInvocationRecord } from './invocation-fixture.js';
import { sectionedSummary } from './history-compact-test-fixtures.js';

function fixture(sessionId = 'session-1') {
  const invocation = testInvocationRecord({
    sessionId,
    invocationId: 'unknown-invocation',
    runId: 'unknown-run',
    turnId: 'unknown-turn',
    openedAt: 100,
    closedAt: 110,
    outcome: 'failed',
    failureClass: 'outcome_unknown',
  });
  Object.assign(invocation.terminalEvent!.actions!.stateDelta!, {
    recovered: true,
    recoveryReason: 'outcome_unknown',
  });
  const identity = {
    sessionId,
    invocationId: invocation.invocationId,
    runId: invocation.runId,
    turnId: invocation.turnId,
    ts: 101,
    partial: false,
  } as const;
  const text = (id: string, turnId: string): RuntimeEvent => ({
    ...identity,
    id,
    invocationId: turnId,
    runId: turnId,
    turnId,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: id },
  });
  const prefix = text('older-settled-history', 'older-turn');
  const call: RuntimeEvent = {
    ...identity,
    id: 'unknown-call',
    role: 'model',
    author: 'agent',
    origin: 'provider',
    content: {
      kind: 'function_call',
      id: 'provider-call',
      name: 'AskUserQuestion',
      args: { question: 'Which format?' },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call' },
  };
  const dispatch: RuntimeEvent = {
    ...identity,
    id: 'unknown-dispatch',
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call',
        toolName: 'AskUserQuestion',
        canonicalArgsHash: canonicalToolArgsHash('AskUserQuestion', { question: 'Which format?' }),
        recoveryMode: 'never_auto_retry',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call' },
  };
  const facts: RuntimeEvent[] = [
    prefix,
    {
      ...identity,
      id: 'protocol',
      role: 'system',
      author: 'system',
      actions: { runtimeProtocol: { toolBoundary: 't1_after_preflight_v1' } },
    },
    {
      ...identity,
      id: 'unknown-user',
      role: 'user',
      author: 'user',
      content: { kind: 'text', text: 'Ask once.' },
    },
    call,
    dispatch,
    invocation.terminalEvent!,
    text('newer-requirement', 'newer-turn'),
    text('newer-answer', 'newer-turn'),
  ];
  return { invocation, facts, call, dispatch, prefix };
}

for (const sessionId of ['session-1', WORKHUB_COORDINATION_SESSION_ID]) {
  test(`compaction preserves a verified unknown as summary input, not a fabricated response: ${sessionId}`, async () => {
    const f = fixture(sessionId);
    const original = JSON.stringify(f.facts);
    let seen = '';
    const summarize = buildLlmHistorySummarizer({
      resolveModel: () => 'fake-model',
      generateText: async (input) => {
        seen = JSON.stringify(input.messages);
        return {
          text: sectionedSummary(
            'The old question has an unknown outcome; newer work is complete.',
          ),
        };
      },
    });
    const later = testInvocationRecord({
      sessionId,
      runId: 'newer-turn',
      turnId: 'newer-turn',
      openedAt: 111,
      closedAt: 130,
      outcome: 'completed',
    });
    const plan = await planHistoryCompaction({
      sessionId,
      phase: 'standalone',
      orderedEvents: f.facts.filter(isHistoryCompactContentEvent),
      recoveryRuntimeEvents: f.facts,
      invocations: [f.invocation, later],
      summarize: async (input) => {
        assert.equal(
          input.coveredRuntimeEvents.some((event) => event.content?.kind === 'function_response'),
          false,
        );
        const replay = buildRuntimeEventModelReplayPlan(input.coveredRuntimeEvents);
        assert.equal(
          replay.diagnostics.some((diagnostic) => diagnostic.code === 'unmatched_tool_call'),
          false,
        );
        return summarize({
          sessionId,
          turnId: 'compact-turn',
          source: { foldedRuntimeEvents: [...input.coveredRuntimeEvents] },
          newlyFoldedRuntimeEvents: [...input.newlyFoldedRuntimeEvents],
        });
      },
    });
    assert.equal(plan.decision, 'compacted');
    if (plan.decision !== 'compacted') return;
    assert.equal(plan.checkpoint.coverage.through.runtimeEventId, 'newer-answer');
    assert.match(seen, /outcome_unknown/);
    assert.match(seen, /effect may have happened/);
    assert.match(seen, /Which format/);
    assert.match(seen, /newer-requirement/);
    assert.equal(JSON.stringify(f.facts), original);
    assert.equal(
      plan.coveredRuntimeEvents.find((event) => event.id === f.call.id)?.content?.kind,
      'function_call',
    );
    assert.equal(
      matchHistoryCompactCheckpointPrefix(
        plan.checkpoint,
        f.facts.filter(isHistoryCompactContentEvent),
      ).reason,
      undefined,
    );
  });
}

test('a sealed call cannot hide an open call in another invocation with the same provider ID', async () => {
  const f = fixture();
  const open: RuntimeEvent = {
    ...f.call,
    id: 'other-open-call',
    invocationId: 'other-invocation',
    runId: 'other-run',
    turnId: 'other-turn',
  };
  f.facts.splice(f.facts.indexOf(f.call), 0, open);
  const plan = await planHistoryCompaction({
    sessionId: 'session-1',
    phase: 'standalone',
    orderedEvents: f.facts.filter(isHistoryCompactContentEvent),
    recoveryRuntimeEvents: f.facts,
    invocations: [f.invocation],
    summarize: () => sectionedSummary('Safe prefix only.'),
  });
  assert.equal(plan.decision, 'compacted');
  if (plan.decision !== 'compacted') return;
  assert.equal(
    plan.coveredRuntimeEvents.some((event) => event.id === open.id),
    false,
  );
  assert.ok(plan.tailRuntimeEvents.some((event) => event.id === open.id));
});

const guards: [string, (f: ReturnType<typeof fixture>) => RuntimeInvocationRecord[]][] = [
  ['a live question without a terminal', (f) => [{ ...f.invocation, terminalEvent: undefined }]],
  ['missing invocation', () => []],
  [
    'completed instead of failed',
    (f) => {
      f.invocation.terminalEvent!.status = 'completed';
      return [f.invocation];
    },
  ],
  [
    'an ordinary failure',
    (f) => {
      f.invocation.terminalEvent!.actions!.stateDelta!.failureClass = 'provider_error';
      return [f.invocation];
    },
  ],
  [
    'no Host recovery marker',
    (f) => {
      delete f.invocation.terminalEvent!.actions!.stateDelta!.recovered;
      return [f.invocation];
    },
  ],
  [
    'a partial terminal',
    (f) => {
      f.invocation.terminalEvent!.partial = true;
      return [f.invocation];
    },
  ],
  [
    'an Agent-authored terminal',
    (f) => {
      f.invocation.terminalEvent!.author = 'agent';
      return [f.invocation];
    },
  ],
  ['wrong invocation Session', (f) => [{ ...f.invocation, sessionId: 'another-session' }]],
  [
    'wrong terminal Run',
    (f) => {
      f.invocation.terminalEvent!.runId = 'wrong-run';
      return [f.invocation];
    },
  ],
  [
    'wrong terminal Turn',
    (f) => {
      f.invocation.terminalEvent!.turnId = 'wrong-turn';
      return [f.invocation];
    },
  ],
  [
    'wrong terminal invocation',
    (f) => {
      f.invocation.terminalEvent!.invocationId = 'wrong-invocation';
      return [f.invocation];
    },
  ],
  [
    'a terminal absent from the raw ledger',
    (f) => [
      {
        ...f.invocation,
        terminalEvent: { ...f.invocation.terminalEvent!, id: 'not-in-the-ledger' },
      },
    ],
  ],
  [
    'missing T1 dispatch',
    (f) => {
      f.facts.splice(f.facts.indexOf(f.dispatch), 1);
      return [f.invocation];
    },
  ],
  [
    'a mismatching tool name',
    (f) => {
      f.dispatch.actions!.toolDispatch!.toolName = 'Bash';
      return [f.invocation];
    },
  ],
  [
    'a mismatching argument hash',
    (f) => {
      f.dispatch.actions!.toolDispatch!.canonicalArgsHash = canonicalToolArgsHash(
        'AskUserQuestion',
        {},
      );
      return [f.invocation];
    },
  ],
  [
    'a duplicate dispatch',
    (f) => {
      f.facts.splice(f.facts.indexOf(f.dispatch), 0, { ...f.dispatch, id: 'duplicate-dispatch' });
      return [f.invocation];
    },
  ],
  [
    'a handoff pause, not a logical outcome',
    (f) => {
      delete f.invocation.terminalEvent!.status;
      f.invocation.terminalEvent!.actions = {
        endInvocation: true,
        handoffPause: {
          protocol: 'runtime_handoff_pause_v1',
          handoffId: 'handoff-1',
          hostEpoch: 'epoch-1',
          rootRunId: 'root-run',
          successorRunId: 'successor-run',
          successorInvocationId: 'successor-invocation',
          claimId: 'claim-1',
          remainingSteps: null,
        },
      };
      return [f.invocation];
    },
  ],
];

for (const [name, mutate] of guards) {
  test(`compaction still protects ${name}`, async () => {
    const f = fixture();
    const invocations = mutate(f);
    const plan = await planHistoryCompaction({
      sessionId: 'session-1',
      phase: 'standalone',
      orderedEvents: f.facts.filter(isHistoryCompactContentEvent),
      recoveryRuntimeEvents: f.facts,
      invocations,
      summarize: () => sectionedSummary('Only the earlier safe prefix.'),
    });
    assert.equal(plan.decision, 'compacted');
    if (plan.decision !== 'compacted') return;
    assert.equal(
      plan.coveredRuntimeEvents.some((event) => event.id === f.call.id),
      false,
    );
    assert.ok(plan.tailRuntimeEvents.some((event) => event.id === f.call.id));
  });
}

test('an unchanged selected range is a no-op, but effective drift or wider coverage still folds', async () => {
  const f = fixture();
  const orderedEvents = f.facts.filter(isHistoryCompactContentEvent);
  const covered = orderedEvents.slice(0, orderedEvents.indexOf(f.call));
  const previous = buildHistoryCompactCheckpoint({
    sessionId: 'session-1',
    coveredRuntimeEvents: covered,
    summary: sectionedSummary('Existing summary.'),
  });
  let calls = 0;
  let drift = false;
  const input = {
    sessionId: 'session-1',
    phase: 'standalone' as const,
    orderedEvents,
    previousCheckpoint: previous,
    projectEffectiveCoverage: async (events: readonly RuntimeEvent[]) =>
      events.map((event) =>
        drift && event.id === f.prefix.id
          ? { ...event, content: { kind: 'text' as const, text: 'Updated effective content.' } }
          : event,
      ),
    summarize: () => {
      calls++;
      return previous.summary;
    },
  };
  const unchanged = await planHistoryCompaction(input);
  assert.equal(unchanged.decision, 'unchanged');
  assert.equal(calls, 0);
  if (unchanged.decision !== 'unchanged') return;
  assert.equal(unchanged.checkpoint.checkpointId, previous.checkpointId);
  drift = true;
  const refreshed = await planHistoryCompaction(input);
  assert.equal(refreshed.decision, 'compacted');
  assert.equal(calls, 1);
  drift = false;
  const advanced = await planHistoryCompaction({
    ...input,
    orderedEvents: orderedEvents.filter((event) => event.id !== f.call.id),
  });
  assert.equal(advanced.decision, 'compacted');
  assert.equal(calls, 2);
  if (advanced.decision === 'compacted') {
    assert.equal(advanced.checkpoint.version, 2);
    if (advanced.checkpoint.version !== 2) return;
    assert.equal(
      advanced.checkpoint.summary,
      previous.summary,
      'Equal text is not proof of equal coverage.',
    );
    assert.ok(advanced.checkpoint.coverage.eventCount > previous.coverage.eventCount);
  }
});
