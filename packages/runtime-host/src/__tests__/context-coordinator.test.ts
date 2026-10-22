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
import { WORKHUB_COORDINATION_SESSION_ID, WORKHUB_COORDINATION_SESSION_ROLE, type SessionHeader } from '@maka/core/session';
import { CONTEXT_OPERATION_SPECS } from '../protocol/context.js';
import type { HostedExecutionPreparation } from '../server/hosted-execution-authority.js';
import { completedHostedExecutionAdmission } from '../server/hosted-execution-authority.js';
import { HostContextCoordinator } from '../server/context-coordinator.js';

test('the dedicated coordinator compaction entry is fixed-target and reuses native admission without ordinary chat authority', async () => {
  const sessionId = WORKHUB_COORDINATION_SESSION_ID;
  let header = { id: sessionId, role: WORKHUB_COORDINATION_SESSION_ROLE, toolProfile: 'workhub-coordination-v2',
    permissionMode: 'bypass', collaborationMode: 'agent', orchestrationMode: 'default',
    backend: 'ai-sdk', llmConnectionId: 'account', transcriptLedgerVersion: 1, isArchived: false } as SessionHeader;
  const turn = { sessionId, turnId: 'manual-compact', runId: 'run', status: 'running' as const };
  const admissions: unknown[] = [];
  let busy = false, nativeStarts = 0, preflights = 0, bindings = 0;
  let bindingError: string | undefined;
  const coordinator = new HostContextCoordinator({
    sessions: { readHeaderSnapshot: async () => header },
    prepareWorkHubCompaction: async current => {
      assert.equal(current.id, sessionId); bindings++; return bindingError;
    },
    runtime: { compactSession: async function* () { nativeStarts++; },
      listTurns: async () => [], getContextDiagnostics: async () => ({}) as never,
      preflightContextCompaction: async () => { preflights++; } },
    executions: { lookup: async () => undefined,
      prepare: () => busy ? { kind: 'busy', whenIdle: new Promise(() => {}) } : { kind: 'prepared', admission: {
        sessionId, release() {}, admit: async input => { admissions.push(input); return completedHostedExecutionAdmission(turn); } } },
      reconcile: async () => assert.fail('No terminal worker is reconciled or stopped'),
      admit: async () => assert.fail('Must use the existing prepared lane') },
    requestDrain: () => assert.fail('A rejection is not a drain'), newId: () => 'run',
  });
  const generic = await coordinator.handlers['context.compact']({ sessionId, turnId: turn.turnId }, {} as never);
  assert.equal(generic.ok, false);
  assert.equal(admissions.length, 0);
  const accepted = await coordinator.handlers['workhub.coordination.compact']({ turnId: turn.turnId }, {} as never);
  assert.deepEqual(accepted, { ok: true, result: { kind: 'started', turn } });
  assert.equal(admissions.length, 1);
  assert.equal(preflights, 1);
  assert.equal(bindings, 1, 'cold compaction binds the requesting Desktop through the existing capability owner');
  assert.equal(nativeStarts, 0, 'only the existing execution lane starts the admitted generator');
  busy = true;
  const rejected = await coordinator.handlers['workhub.coordination.compact']({ turnId: 'busy' }, {} as never);
  assert.ok(!rejected.ok && rejected.error.code === 'session_busy');
  assert.equal(admissions.length, 1, 'busy does not register a delayed compaction');
  assert.equal(bindings, 1, 'busy compaction cannot rebind active execution tools');
  busy = false;
  bindingError = 'Desktop capability unavailable';
  const noDesktop = await coordinator.handlers['workhub.coordination.compact']({ turnId: 'unbound' }, {} as never);
  assert.ok(!noDesktop.ok && noDesktop.error.code === 'operation_unavailable');
  assert.equal(preflights, 1, 'no backend/model call on a missing Desktop binding');
  bindingError = undefined;
  header = { ...header, role: undefined };
  const malformed = await coordinator.handlers['workhub.coordination.compact']({ turnId: 'invalid' }, {} as never);
  assert.ok(!malformed.ok && malformed.error.code === 'operation_unavailable');
  assert.equal(admissions.length, 1);
  const spec = CONTEXT_OPERATION_SPECS['workhub.coordination.compact'];
  assert.deepEqual(spec.decodeInput({ turnId: turn.turnId }), { turnId: turn.turnId });
  assert.throws(() => spec.decodeInput({ turnId: turn.turnId, sessionId: 'worker' }));
  assert.throws(() => spec.assertOutputForInput!({ turnId: turn.turnId }, { kind: 'started', turn: { ...turn, sessionId: 'worker' } }));
});

test('context compaction waits for terminal execution cleanup before preparing', async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let prepareCalls = 0;
  const terminal = {
    sessionId: 'session-context',
    turnId: 'turn-terminal',
    runId: 'run-terminal',
    status: 'completed' as const,
    terminalEventId: 'event-terminal',
  };
  const compacted = {
    sessionId: terminal.sessionId,
    turnId: 'turn-compact',
    runId: 'run-compact',
    status: 'completed' as const,
    terminalEventId: 'event-compact',
    contextCompactionOutcome: { kind: 'compacted' as const, checkpointId: 'checkpoint-1' },
  };
  const prepare = (): HostedExecutionPreparation => {
    prepareCalls += 1;
    if (prepareCalls === 1) {
      return {
        kind: 'busy',
        execution: terminal,
        whenIdle: cleanup,
      };
    }
    return {
      kind: 'prepared',
      admission: {
        sessionId: terminal.sessionId,
        admit: async () => completedHostedExecutionAdmission(compacted),
        release: () => {},
      },
    };
  };
  const coordinator = new HostContextCoordinator({
    runtime: {
      compactSession: async function* () {},
      getContextDiagnostics: async () => ({}) as never,
      listTurns: async () => [],
      preflightContextCompaction: async () => {},
    },
    executions: {
      lookup: async () => undefined,
      prepare,
      reconcile: async () => terminal,
      admit: async () => assert.fail('Context compaction must use its prepared admission'),
    },
    sessions: {
      readHeaderSnapshot: async () =>
        ({
          status: 'active',
          isArchived: false,
          llmConnectionId: 'connection-context',
        }) as unknown as SessionHeader,
    },
    requestDrain: () => {},
    newId: () => compacted.runId,
  });

  const compaction = coordinator.handlers['context.compact'](
    {
      sessionId: terminal.sessionId,
      turnId: compacted.turnId,
    },
    {} as never,
  );
  let settled = false;
  void compaction.finally(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);

  releaseCleanup();
  const outcome = await compaction;
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.result, {
      kind: 'finished',
      turn: compacted,
      outcome: compacted.contextCompactionOutcome,
    });
  }
  assert.equal(prepareCalls, 2);
});

test('completed legacy compaction without an outcome returns a typed failure without draining', async () => {
  const completed = {
    sessionId: 'session-context',
    turnId: 'turn-compact',
    runId: 'run-compact',
    status: 'completed' as const,
    terminalEventId: 'event-compact',
  };
  let drainRequests = 0;
  const coordinator = new HostContextCoordinator({
    runtime: {
      compactSession: async function* () {},
      getContextDiagnostics: async () => ({}) as never,
      listTurns: async () => [],
      preflightContextCompaction: async () => {},
    },
    executions: {
      lookup: async () => ({
        sessionId: completed.sessionId,
        turnId: completed.turnId,
        runId: completed.runId,
        userMessageId: null,
        descriptor: { kind: 'context_compact' as const },
      }),
      prepare: () => assert.fail('existing execution must not prepare another root'),
      reconcile: async () => assert.fail('existing execution must not reconcile'),
      admit: async () => completedHostedExecutionAdmission(completed),
    },
    sessions: {
      readHeaderSnapshot: async () =>
        ({ status: 'active', isArchived: false }) as unknown as SessionHeader,
    },
    requestDrain: () => {
      drainRequests += 1;
    },
  });

  const outcome = await coordinator.handlers['context.compact'](
    { sessionId: completed.sessionId, turnId: completed.turnId },
    {} as never,
  );

  assert.deepEqual(outcome, {
    ok: true,
    result: {
      kind: 'finished',
      turn: completed,
      outcome: { kind: 'failed', reason: 'missing_durable_outcome' },
    },
  });
  assert.equal(drainRequests, 0);
});
