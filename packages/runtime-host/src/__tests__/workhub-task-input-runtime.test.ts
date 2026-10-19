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
import { test } from 'node:test';
import { normalizeMessageContent, type AttachmentRef } from '@maka/core/events';
import type {
  WorkHubTaskInputMessage,
  WorkHubTaskInputRequest,
} from '@maka/core/workhub-task-input';
import { WORKHUB_COORDINATION_SESSION_ID, type WorkHubActionClaim } from '@maka/core/session';
import { messageContentDigest } from '@maka/core/events';
import type { PendingMessageAdmission } from '@maka/storage/execution-stores';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { createWorkHubTaskInputRuntime } from '../server/workhub-task-input-runtime.js';
import {
  readWorkHubTaskInputBinding,
  readWorkHubTaskInputContinuation,
} from '../server/workhub-task-input-lineage.js';

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
    'stopping',
    'recovering_snapshot',
    'settling',
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
  const legacy = fixture();
  const forged = await legacy.handlers['workhub.tasks.send'](
    { ...input, sourceDelegationId: 'foreign-source' },
    context,
  );
  assert.ok(!forged.ok && forged.error.code === 'operation_conflict');
  assert.equal(
    legacy.commits,
    0,
    'a saved exact source must be checked, never overwritten during resolution',
  );
});

const modernInput = {
  inputId: input.inputId,
  workId: input.workId,
  generationId: input.generationId,
  text: input.text,
};
const modelInput = {
  turnId: 'model-turn',
  actionId: 'model-input',
  taskId: input.workId,
  text: input.text,
};

test('a saved legacy continuation retains its pre-upgrade six-field action fingerprint', async () => {
  const f = fixture();
  f.state = 'ended';
  const outcome = await f.handlers['workhub.tasks.send'](input, context);
  assert.ok(outcome.ok, JSON.stringify(outcome));
  assert.equal(outcome.result.mode, 'continuation');
  assert.deepEqual(
    f.continuation,
    input,
    'do not add optional provenance to a legacy action payload',
  );
  assert.equal(f.stored?.originalUserText, undefined);
  assert.equal(f.stored?.inputOrigin, undefined);
});

test('task-aware native input finds its own running source behind a later withdrawn same-task admission', async () => {
  const f = fixture();
  f.latestWithdrawn = true;
  const result = await f.handlers['workhub.tasks.send'](modernInput, context);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.result.mode, 'steering');
  assert.equal(result.result.sourceActionId, input.sourceActionId);
  assert.equal(result.result.sourceDelegationId, input.sourceDelegationId);
  assert.equal(f.continuations, 0);
  assert.equal(f.stored?.originalUserText, input.text);
  assert.equal(f.stored?.inputOrigin, 'user');
  f.state = 'stale';
  assert.deepEqual(
    await f.handlers['workhub.tasks.send'](modernInput, context),
    result,
    'accepted replay keeps its old generation',
  );
  const stale = await f.handlers['workhub.tasks.send'](
    { ...modernInput, inputId: 'uncommitted-stale' },
    context,
  );
  assert.ok(!stale.ok && stale.error.code === 'operation_conflict');
  assert.equal(f.commits, 1);
});

test('model reuse enters the same task input path and retains authenticated original text, not a claimed user message', async () => {
  const f = fixture();
  f.modelAuthority = true;
  f.latestWithdrawn = true;
  const result = await f.handlers['workhub.tasks.continue'](modelInput, context);
  assert.ok(result.ok && result.result.container === 'reuse', JSON.stringify(result));
  assert.equal(result.result.input.mode, 'steering');
  assert.equal(result.result.input.sourceActionId, input.sourceActionId);
  assert.equal(f.continuations, 0);
  assert.equal(f.commits, 1);
  assert.equal(f.stored?.text, input.text);
  assert.equal(f.stored?.originalUserText, 'The actual original user request.');
  assert.equal(f.stored?.sourceMessageId, 'coordinator-user-message');
  assert.equal(
    f.stored?.turnId,
    'coordination',
    'source binding is not rewritten to the new model Turn',
  );
  assert.equal(f.claims.size, 1);
  f.state = 'stale';
  assert.deepEqual(await f.handlers['workhub.tasks.continue'](modelInput, context), result);
  for (const changed of [
    { ...modelInput, text: 'Changed instruction' },
    { ...modelInput, taskId: 'foreign' },
    { ...modelInput, container: 'fresh' as const },
  ])
    assert.equal((await f.handlers['workhub.tasks.continue'](changed, context)).ok, false);
  const nativeCollision = await f.handlers['workhub.tasks.send'](
    { ...modernInput, inputId: modelInput.actionId },
    context,
  );
  assert.ok(!nativeCollision.ok && nativeCollision.error.code === 'operation_conflict');
  assert.equal(f.commits, 1);
  assert.equal(f.hydrations, 1);
});

test('model task input requires a live coordinator and rejects a globally claimed different operation before input effects', async () => {
  const f = fixture();
  assert.equal((await f.handlers['workhub.tasks.continue'](modelInput, context)).ok, false);
  f.modelAuthority = true;
  f.claims.set(modelInput.actionId, {
    actionId: modelInput.actionId,
    operation: 'stop',
    subject: 'other',
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
  });
  const conflict = await f.handlers['workhub.tasks.continue'](modelInput, context);
  assert.ok(!conflict.ok && conflict.error.code === 'operation_conflict');
  assert.equal(f.commits, 0);
  assert.equal(f.hydrations, 0);
  assert.equal(f.continuations, 0);
});

test('automatic feedback provenance is retained and busy attachment input is explicitly unsupported, not queued as a new Turn', async () => {
  const feedback = fixture();
  feedback.modelAuthority = true;
  feedback.modelOrigin = 'feedback';
  const accepted = await feedback.handlers['workhub.tasks.continue'](modelInput, context);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.equal(feedback.stored?.inputOrigin, 'feedback');
  assert.equal(feedback.stored?.sourceMessageId, undefined);
  assert.equal(feedback.stored?.originalUserText, 'The actual original user request.');
  feedback.modelOrigin = 'user';
  assert.equal(
    (await feedback.handlers['workhub.tasks.continue'](modelInput, context)).ok,
    false,
    'replay cannot change feedback into fresh user authority',
  );
  assert.equal(feedback.commits, 1);
  for (const state of ['active', 'pending']) {
    const f = fixture();
    f.state = state;
    f.modelAuthority = true;
    f.modelAttachments = [
      {
        kind: 'code',
        name: 'requirements.txt',
        mimeType: 'text/plain',
        bytes: 1,
        ref: {
          kind: 'session_file',
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          relativePath: 'requirements.txt',
        },
      },
    ];
    const result = await f.handlers['workhub.tasks.continue'](modelInput, context);
    assert.ok(!result.ok && result.error.code === 'operation_unavailable', JSON.stringify(result));
    assert.equal(f.commits, 0);
    assert.equal(f.hydrations, 0);
    assert.equal(f.continuations, 0);
  }
});

test('settled task inputs use ordinary admission, while an unrelated root is never steered', async () => {
  for (const state of ['ended', 'cancelled', 'unrelated']) {
    for (const model of [false, true]) {
      const f = fixture();
      f.state = state;
      f.modelAuthority = model;
      const outcome = model
        ? await f.handlers['workhub.tasks.continue'](modelInput, context)
        : await f.handlers['workhub.tasks.send'](modernInput, context);
      assert.ok(outcome.ok, JSON.stringify({ state, model, outcome }));
      assert.equal(f.continuations, 1);
      assert.equal(f.hydrations, 0, 'no Steering or safe-boundary resume was substituted');
      assert.equal(f.continuation?.sourceActionId, input.sourceActionId);
      assert.equal(f.continuationTurnId, model ? modelInput.turnId : undefined);
      assert.equal(f.stored?.mode, 'continuation');
      assert.equal(
        f.stored?.originalUserText,
        model ? 'The actual original user request.' : input.text,
      );
    }
  }
});

test('ordinary input rejects a newly started execution at final admission, but an unrelated root may finish normally', async () => {
  const changed = fixture();
  changed.state = 'ended';
  changed.beforeContinuation = () => {
    changed.state = 'active';
  };
  const rejected = await changed.handlers['workhub.tasks.send'](modernInput, context);
  assert.ok(!rejected.ok && rejected.error.code === 'session_busy');
  assert.equal(changed.stored, undefined);
  assert.equal(changed.commits, 0);
  assert.equal(changed.hydrations, 0);
  assert.equal(changed.continuations, 0);
  const ended = fixture();
  ended.state = 'unrelated';
  ended.beforeContinuation = () => {
    ended.state = 'ended';
  };
  const accepted = await ended.handlers['workhub.tasks.send'](modernInput, context);
  assert.ok(accepted.ok, JSON.stringify(accepted));
  assert.equal(accepted.result.mode, 'continuation');
  assert.equal(ended.continuations, 1);
  assert.equal(ended.hydrations, 0);
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
    modelAuthority: false,
    modelOrigin: 'user' as 'user' | 'feedback',
    modelAttachments: [] as AttachmentRef[],
    latestWithdrawn: false,
    claims: new Map<string, WorkHubActionClaim>(),
    continuation: undefined as
      | Parameters<Options['coordination']['continueTaskInput']>[0]
      | undefined,
    continuationTurnId: undefined as string | undefined,
    beforeContinuation: undefined as (() => void) | undefined,
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
        readWorkHubTaskInput: async (id: string) => {
          if (f.stored && f.readFailsAfterCommit) throw new Error('Read unavailable after commit');
          return f.stored?.inputId === id ? f.stored : undefined;
        },
        readWorkHubAssignment: async (id: string) =>
          f.state === 'foreign'
            ? undefined
            : id === 'withdrawn'
              ? {
                  ...assignment,
                  actionId: 'withdrawn',
                  delegationId: 'withdrawn-delegation',
                  targetMessageId: 'withdrawn-message',
                }
              : assignment,
        readWorkHubAssignmentByMessage: async () => assignment,
        readWorkHubTaskInputByMessage: async () => undefined,
        readLatestWorkHubAssignment: async () =>
          f.state === 'stale'
            ? { ...assignment, work: { ...assignment.work, generationId: 'new-generation' } }
            : f.latestWithdrawn
              ? {
                  ...assignment,
                  actionId: 'withdrawn',
                  delegationId: 'withdrawn-delegation',
                  targetMessageId: 'withdrawn-message',
                }
              : assignment,
        claimWorkHubAction: async (claim: WorkHubActionClaim) => {
          const old = f.claims.get(claim.actionId);
          if (old) return JSON.stringify(old) === JSON.stringify(claim) ? 'same_claim' : 'conflict';
          f.claims.set(claim.actionId, claim);
          return 'claimed';
        },
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
      agentRunStore: {
        readRootTurnSourceMessageReceipt: async () => undefined,
        readRootTurnAdmission: async () => ({
          sourceMessages: [{ messageId: 'original' }],
          execution: { kind: 'external_message' },
        }),
      },
      runtimeEventStore: { readImmutableSteeringMessageProof: async () => undefined },
    } as unknown as Options['stores'],
    messages: {
      readMessageExecutionDispositionAdmitted: async (_sessionId: string, messageId: string) =>
        f.state === 'pending'
          ? { kind: 'pending' }
          : messageId === 'withdrawn-message'
            ? { kind: 'cancelled' }
            : ['cancelled', 'recovering'].includes(f.state)
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
      readRootState: (sessionId: string) =>
        sessionId === WORKHUB_COORDINATION_SESSION_ID
          ? f.modelAuthority
            ? { kind: 'active', sessionId, turnId: 'model-turn', runId: 'model-run' }
            : { kind: 'idle' }
          : f.state === 'reserved'
            ? { kind: 'reserved' }
            : ['ended', 'cancelled'].includes(f.state)
              ? { kind: 'idle' }
              : {
                  kind: 'active',
                  sessionId: 'target',
                  turnId: f.state === 'unrelated' ? 'unrelated-turn' : 'turn',
                  runId: 'run',
                },
      readLatestRootTurnLineage: async () => ({
        sessionId: 'target',
        turnId: 'turn',
        runId: 'run',
      }),
      read: async () => ({
        status:
          f.state === 'stopping'
            ? 'stopping'
            : f.state === 'recovering_snapshot'
              ? 'recovering'
              : f.state === 'settling'
                ? 'completed'
                : 'running',
      }),
      readActiveWorkHubRoutingRequest: async () =>
        f.modelAuthority
          ? {
              content: normalizeMessageContent({
                text: 'The actual original user request.',
                ...(f.modelAttachments.length ? { attachments: f.modelAttachments } : {}),
              }),
              runId: 'model-run',
              ...(f.modelOrigin === 'user' ? { sourceMessageId: 'coordinator-user-message' } : {}),
              origin: f.modelOrigin,
            }
          : undefined,
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
      continueTaskInput: async (bound, _context, origin) => {
        assert.ok(
          ['ended', 'cancelled', 'unrelated'].includes(f.state),
          'An active own task must never fall back to a later Turn',
        );
        f.beforeContinuation?.();
        await origin?.validateTaskInput();
        f.continuations++;
        f.continuation = bound;
        f.continuationTurnId = origin?.coordinationTurnId;
        f.stored = {
          ...bound,
          type: 'workhub_coordination',
          kind: 'task_input',
          schemaVersion: 1,
          id: `whti_${createHash('sha256').update(bound.inputId).digest('hex').slice(0, 48)}`,
          ts: 1,
          turnId: assignment.coordinationTurnId,
          targetSessionId: 'target',
          targetMessageId: 'continued-message',
          targetContentDigest: messageContentDigest(normalizeMessageContent({ text: bound.text })),
          mode: 'continuation',
        };
        return {
          disposition: 'delegate_existing',
          workId: bound.workId,
          targetSessionId: 'target',
          targetMessageId: 'continued-message',
        };
      },
      handlers: {
        'workhub.coordination.actFromTurn': async () =>
          assert.fail('No fresh container is authorized in these reuse cases'),
      },
    },
    requestDrain: () => {
      f.drains++;
    },
    onError: () => {},
  });
  return Object.assign(f, runtime);
}

test('folded input lineage owns only a canonical same-work batch, never a mixed/manual or foreign source', async () => {
  const a = {
    actionId: 'action',
    delegationId: 'delegation',
    coordinationTurnId: 'coordination',
    targetSessionId: 'target',
    work: { id: 'work', generationId: 'generation' },
  };
  const previous = { sessionId: 'target', turnId: 'previous-turn', runId: 'previous-run' };
  const fact = (suffix: string): WorkHubTaskInputMessage => ({
    ...input,
    inputId: suffix,
    type: 'workhub_coordination',
    kind: 'task_input',
    schemaVersion: 1,
    id: `whti_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`,
    turnId: 'coordination',
    ts: 1,
    targetSessionId: 'target',
    targetMessageId: `whtm_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`,
    targetContentDigest: `sha256:${'0'.repeat(64)}`,
    mode: 'steering',
    execution: { turnId: previous.turnId, runId: previous.runId },
  });
  const first = fact('a'),
    second = fact('b');
  let facts = [first, second];
  let messageIds = facts.map((value) => value.targetMessageId);
  const stores = {
    sessionStore: {
      readWorkHubTaskInputSuccessors: async () => facts,
      readWorkHubTaskInputByMessage: async (id: string) =>
        facts.find((value) => value.targetMessageId === id),
      readWorkHubAssignment: async (id: string) => (id === a.actionId ? a : undefined),
    },
    agentRunStore: {
      readRootTurnSourceMessageReceipt: async () => ({
        admission: {
          sessionId: 'target',
          turnId: 'next-turn',
          runId: 'next-run',
          execution: { kind: 'external_message' },
          sourceMessages: messageIds.map((messageId) => ({ messageId })),
        },
      }),
    },
  } as unknown as Options['stores'];
  const source = a as Parameters<typeof readWorkHubTaskInputContinuation>[1];
  assert.deepEqual(await readWorkHubTaskInputContinuation(stores, source, previous), {
    sessionId: 'target',
    turnId: 'next-turn',
    runId: 'next-run',
  });
  messageIds.push('unrelated-manual-message');
  assert.equal(
    await readWorkHubTaskInputContinuation(stores, source, previous),
    undefined,
    'a mixed root is not exclusively controlled by the original work',
  );
  messageIds = [first.targetMessageId, second.targetMessageId];
  for (const patch of [
    { generationId: 'other' },
    { sourceDelegationId: 'other' },
    { targetSessionId: 'other' },
    { execution: { turnId: 'other-turn', runId: 'other-run' } },
  ]) {
    facts = [first, { ...second, ...patch }];
    assert.equal(await readWorkHubTaskInputContinuation(stores, source, previous), undefined);
  }
  facts = [first, second];
  assert.equal(
    await readWorkHubTaskInputBinding(stores, 'foreign-session', first.targetMessageId),
    undefined,
  );
  assert.equal(await readWorkHubTaskInputBinding(stores, 'target', 'ordinary-message'), undefined);
});
