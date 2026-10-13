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
import { normalizeMessageContent } from '@maka/core/events';
import type {
  WorkHubTaskInputMessage,
  WorkHubTaskInputRequest,
} from '@maka/core/workhub-task-input';
import type { PendingMessageAdmission } from '@maka/storage/execution-stores';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { createWorkHubTaskInputRuntime } from '../server/workhub-task-input-runtime.js';

type Options = Parameters<typeof createWorkHubTaskInputRuntime>[0];
const input: WorkHubTaskInputRequest = {
  inputId: 'input',
  workId: 'work',
  generationId: 'generation',
  sourceActionId: 'action',
  sourceDelegationId: 'delegation',
  text: 'Use this correction.',
};
const context = {
  hostEpoch: 'test',
  connectionId: 'test',
  principal: 'local_os_user' as const,
  acquireResidency: () => ({ release() {} }),
};

test('task input fails closed for retired, foreign, unsupported and unresolved execution sources', async () => {
  for (const state of [
    'foreign',
    'stale',
    'replacement',
    'aborted',
    'superseded',
    'stopped',
    'archived',
    'plugin',
    'cancelled',
    'recovering',
    'dependency',
    'reserved',
  ] as const) {
    const f = fixture();
    f.state = state;
    const result = await f.handlers['workhub.tasks.send'](input, context);
    assert.equal(result.ok, false, state);
    assert.equal(f.commits, 0, state);
    assert.equal(f.hydrations, 0, state);
    assert.equal(f.continuations, 0, state);
  }
  const f = fixture();
  f.state = 'preflight_race';
  const result = await f.handlers['workhub.tasks.send'](input, context);
  assert.ok(!result.ok && result.error.code === 'session_busy');
  assert.equal(f.commits, 0);
});

test('committed task input survives hydration failure; unknown commit reads drain and require the same ID', async () => {
  for (const readFails of [false, true]) {
    const f = fixture();
    f.state = 'hydrate_failure';
    f.readFailsAfterCommit = readFails;
    const result = await f.handlers['workhub.tasks.send'](input, context);
    if (readFails) assert.ok(!result.ok && result.error.code === 'commit_outcome_unknown');
    else {
      assert.ok(result.ok, JSON.stringify(result));
      assert.equal(result.result.delivery, 'queued');
    }
    assert.ok(f.drains > 0);
    assert.equal(f.commits, 1);
    f.readFailsAfterCommit = false;
    f.state = 'active';
    const replay = await f.handlers['workhub.tasks.send'](input, context);
    assert.ok(replay.ok);
    assert.equal(replay.result.delivery, 'queued');
    assert.equal(f.commits, 1);
    assert.equal(f.hydrations, 1, 'an accepted retry cannot re-admit the Message');
    const changed = await f.handlers['workhub.tasks.send'](
      { ...input, text: 'Changed text' },
      context,
    );
    assert.ok(!changed.ok && changed.error.code === 'operation_conflict');
    assert.equal(f.commits, 1);
  }
});

test('task input receipt reads do not wake a worker or equate a missing pending row with delivery', async () => {
  const f = fixture();
  const accepted = await f.handlers['workhub.tasks.send'](input, context);
  assert.ok(accepted.ok);
  const before = { commits: f.commits, hydrations: f.hydrations, continuations: f.continuations };
  f.pending = undefined;
  const unproven = await f.handlers['workhub.tasks.input.read']({
    workId: input.workId,
    inputId: input.inputId,
  });
  assert.ok(unproven.ok);
  assert.equal(unproven.result.delivery, 'unproven');
  f.cancelled = true;
  const cancelled = await f.handlers['workhub.tasks.input.read']({
    workId: input.workId,
    inputId: input.inputId,
  });
  assert.ok(cancelled.ok);
  assert.equal(cancelled.result.delivery, 'cancelled');
  const foreign = await f.handlers['workhub.tasks.input.read']({
    workId: 'other',
    inputId: input.inputId,
  });
  assert.ok(!foreign.ok && foreign.error.code === 'not_found');
  assert.deepEqual(
    { commits: f.commits, hydrations: f.hydrations, continuations: f.continuations },
    before,
  );
});

function fixture() {
  const f = {
    state: 'active',
    commits: 0,
    hydrations: 0,
    continuations: 0,
    drains: 0,
    readFailsAfterCommit: false,
    cancelled: false,
    pending: undefined as PendingMessageAdmission | undefined,
    stored: undefined as WorkHubTaskInputMessage | undefined,
  };
  const assignment = {
    actionId: 'action',
    delegationId: 'delegation',
    coordinationTurnId: 'coordination',
    targetSessionId: 'target',
    targetMessageId: 'original',
    work: { id: 'work', generationId: 'generation' },
  };
  const runtime = createWorkHubTaskInputRuntime({
    admission: new SessionAdmissionGate(),
    // External authority seams only; production SQLite atomicity and actual
    // provider requests are exercised in the storage/composition suites.
    stores: {
      sessionStore: {
        readWorkHubTaskInput: async () => {
          if (f.stored && f.readFailsAfterCommit) throw new Error('Read unavailable after commit');
          return f.stored;
        },
        readWorkHubAssignment: async () => (f.state === 'foreign' ? undefined : assignment),
        readLatestWorkHubAssignment: async () =>
          f.state === 'stale'
            ? { ...assignment, work: { ...assignment.work, generationId: 'new-generation' } }
            : assignment,
        readWorkHubReplacement: async () => (f.state === 'replacement' ? {} : undefined),
        readWorkHubReplacementAbort: async () => (f.state === 'aborted' ? {} : undefined),
        readWorkHubSupersession: async () => (f.state === 'superseded' ? {} : undefined),
        readWorkHubStopRequest: async () => (f.state === 'stopped' ? {} : undefined),
        readWorkHubStopResolution: async () => undefined,
        readHeaderSnapshot: async () => ({
          isArchived: f.state === 'archived',
          backend: f.state === 'plugin' ? 'plugin-executor' : 'ai-sdk',
          labels: [],
        }),
        commitWorkHubTaskInput: async (request: {
          input: WorkHubTaskInputMessage;
          admission: PendingMessageAdmission;
        }) => {
          f.commits++;
          f.stored = request.input;
          f.pending = request.admission;
          return request.input;
        },
        readMessageAdmission: async () => f.pending,
        hasCancelledMessageAdmission: async () => f.cancelled,
      },
      agentRunStore: { readRootTurnSourceMessageReceipt: async () => undefined },
      runtimeEventStore: { readImmutableSteeringMessageProof: async () => undefined },
    } as unknown as Options['stores'],
    messages: {
      readMessageExecutionDispositionAdmitted: async () =>
        ['cancelled', 'recovering'].includes(f.state)
          ? { kind: f.state }
          : { kind: 'owned_root', turnId: 'turn', runId: 'run' },
      preflightQueuedAdmissionAdmitted: async () =>
        f.state === 'preflight_race'
          ? { ok: false, error: { code: 'session_busy', message: 'The root changed' } }
          : { ok: true, result: undefined },
      consumePendingAdmissionsAdmitted: async () => {
        f.hydrations++;
        if (f.state === 'hydrate_failure') throw new Error('Failed hydration');
      },
    } as unknown as Options['messages'],
    executions: {
      readRootState: () =>
        f.state === 'reserved'
          ? { kind: 'reserved' }
          : { kind: 'active', sessionId: 'target', turnId: 'turn', runId: 'run' },
      prepareMessage: async ({ content }: { content: { text: string } }) => ({
        kind: 'ready',
        content: normalizeMessageContent(content),
        skillInvocation: { loaded: [], failed: [], receipts: [] },
      }),
    } as unknown as Options['executions'],
    evidence: {
      taskExecution: async () => ({
        sessionId: 'target',
        turnId: 'turn',
        runId: 'run',
        round: 0,
        ...(f.state === 'dependency' ? { request: {} } : {}),
      }),
    } as unknown as Options['evidence'],
    coordination: {
      continueTaskInput: async () => {
        f.continuations++;
        assert.fail('No continuation is authorized in these active-root cases');
      },
    },
    requestDrain: () => {
      f.drains++;
    },
    onError: () => {},
  });
  return Object.assign(f, runtime);
}
