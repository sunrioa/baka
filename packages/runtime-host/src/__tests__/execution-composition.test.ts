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
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { AsyncResource } from 'node:async_hooks';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type StoredMessage,
  type WorkHubCreateDefaults,
} from '@maka/core/session';
import {
  TOOL_BOUNDARY_PROTOCOL_V1,
  decodeRuntimeEvent,
  type RuntimeEvent,
} from '@maka/core/runtime-event';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import {
  buildInvocationOpenedEvent,
  runtimeInvocationOutcome,
} from '@maka/core/runtime-invocation';
import { createRunCompositionSnapshot } from '@maka/core/run-composition';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { runtimeHandoffPause } from '@maka/core/runtime-handoff';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import { runtimeInvocationFailureClass } from '@maka/runtime/runtime-event-read-model';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { RuntimeInteractionAdmissionRejectedError } from '@maka/runtime/interaction-authority';
import { parseNoRealConnectionError } from '@maka/core/connection-error-copy';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type {
  AgentGraphIntentClaim,
  AgentGraphIntentClaimRequest,
} from '@maka/core/agent-graph-control';
import type { HostedUserQuestionSettlement } from '@maka/core/backend-types';
import type { ShellRunRecord } from '@maka/core/shell-run';
import { waitFor as pollFor } from '@maka/core/test-only/async-primitives';
import {
  AgentGraphCoordinator,
  agentGraphIdForRootSession,
} from '@maka/runtime/stream-graph-coordinator';
import {
  FAKE_ASK_USER_QUESTION_PROMPT,
  FAKE_ERROR_PROMPT_PREFIX,
  FAKE_HOLD_OPEN_PROMPT,
  FakeBackend,
} from '@maka/runtime/test-only/fake-backend';
import { LOCAL_READ_AGENT_DEFINITION } from '@maka/runtime/agent-catalog';
import { SessionManager, type BackendFactory } from '@maka/runtime/session-manager';
import {
  FilesystemWorkerClient,
  FilesystemWorkerClientError,
  createFilesystemWorkerLaunchSpecProvider,
} from '@maka/runtime/filesystem-worker';
import { createDefaultSandboxManager } from '@maka/runtime/sandbox';
import { testInvocationOpening } from '@maka/runtime/test-only/invocation-fixture';
import { workHubDirectStopAbortSource } from '@maka/runtime/session-manager';
import { fingerprintAgentGraphRunnableIntent } from '@maka/runtime/stream-graph-admission';
import type { AgentGraphRunnableIntent } from '@maka/runtime/stream-graph-readiness';
import { createAgentGraphControlStore } from '@maka/storage/agent-graph-control-store';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { createSqliteRuntimeStore } from '@maka/storage/sqlite-runtime-store';
import { createSessionStore } from '@maka/storage/session-store';
import {
  LONG_TERM_MEMORY_DATABASE_NAME,
  openInteractiveLongTermMemoryStoreForWrite,
} from '@maka/storage/long-term-memory-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveUsageStoresForWrite } from '@maka/storage/usage-stores';
import { openInteractiveDailyReviewAuthorityForWrite } from '@maka/storage/daily-review-authority';
import { openInteractiveScheduledTaskStoreForWrite } from '@maka/storage/scheduled-task-store';
import { openInteractiveShellRunStoreForWrite } from '@maka/storage/shell-run-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveWorkspaceIdentity } from '@maka/storage/workspace-identity';
import {
  HostResidencyRegistry,
  type HostResidencyKind,
} from '../server/host-residency-registry.js';
import {
  createExecutionRuntimeHostComposition,
  runtimeHostFilesystemWorkerRuntime,
  stopOwnedWorkHubRoot,
  retireWorkHubDelegation,
  type ExecutionRuntimeHostCompositionDependencies,
  type ExecutionRuntimeHostComposition,
} from '../server/execution-composition.js';
import { RuntimeHostKernel, type RuntimeHostCompositionContext } from '../server/host-kernel.js';
import { defineInteractiveRuntimeHostComposition } from '../server/host-composition.js';
import { connectRuntimeHost, RuntimeHostOperationError } from '../client/index.js';
import {
  MESSAGE_QUEUE_MAX_ENTRIES,
  RUNTIME_HOST_PROTOCOL_VERSION,
  HOST_OPERATION_SPECS,
  type ClientCapabilityHostFrame,
  type WorkHubTaskStartInput,
  type WorkHubTaskStopInput,
} from '../protocol/index.js';
import { RootTurnCoordinator } from '../server/root-turn-coordinator.js';
import { WORKHUB_TASK_INPUT_OPERATION_SPECS } from '../protocol/workhub-task-input.js';
import { HostWorkHubResultCoordinator } from '../server/workhub-result-coordinator.js';
import {
  workHubEvidenceRequestId,
  workHubEvidenceTurnId,
} from '../server/workhub-evidence-runtime.js';
import { WorkHubExecutionSlots } from '../server/workhub-execution-slots.js';
import { readLedgerMessages } from './fixtures/ledger-transcript.js';
import { clientCapabilityConnectionIdentity } from './fixtures/client-capability.js';
import { workHubDesktopCapabilityOffers } from './fixtures/workhub-capabilities.js';
import { HostWorkHubCoordinationCoordinator } from '../server/workhub-coordination-coordinator.js';
import { clientSubscription } from './fixtures/client-session-subscription.js';

const require = createRequire(import.meta.url);
const FAKE_CONNECTION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTEXT_OFFLOAD_DATABASE_NAME = 'context-offload.sqlite';

test('WorkHub workspace slots do not dispatch conflicting directories or block unrelated work', () => {
  const slots = new WorkHubExecutionSlots(3);
  const first = slots.acquire(join(tmpdir(), 'project'));
  const second = slots.acquire(join(tmpdir(), 'project', 'src'));
  const unrelated = slots.acquire(join(tmpdir(), 'research'));
  assert.equal(first.waiting, false);
  assert.equal(second.waiting, true, 'a child directory shares its parent write resource');
  assert.equal(second.waitReason, 'workspace');
  assert.equal(unrelated.waiting, false, 'a blocked project must not consume an unrelated slot');
  first.release();
  assert.equal(second.waiting, false);
  assert.equal(second.waitReason, undefined);
  second.release();
  unrelated.release();
});

test('WorkHub workspace slots retain conflict FIFO, inode aliases and cancellation fairness', async () => {
  const slots = new WorkHubExecutionSlots(3);
  const path = join(tmpdir(), 'slot-project');
  const first = slots.acquire(path, 'dev:1');
  const alias = slots.acquire(path, 'dev:1');
  const child = slots.acquire(join(path, 'src'));
  const parent = slots.acquire(tmpdir());
  const sibling = slots.acquire(join(path, 'docs'));
  assert.deepEqual(
    [alias.waiting, child.waiting, parent.waiting, sibling.waiting],
    [true, true, true, true],
  );
  first.release();
  assert.deepEqual(
    [alias.waiting, child.waiting, parent.waiting, sibling.waiting],
    [false, true, true, true],
  );
  alias.release();
  assert.equal(child.waiting, false);
  parent.cancelWaiting();
  await parent.ready;
  assert.equal(
    sibling.waiting,
    false,
    'a cancelled ancestor no longer reserves unrelated descendants',
  );
  for (const slot of [first, alias, child, parent, sibling]) {
    slot.release();
    slot.release();
  }
  slots.setLimit(1);
  const final = slots.acquire(path);
  const limited = slots.acquire(join(tmpdir(), 'unrelated-slot'));
  assert.equal(limited.waitReason, 'concurrency');
  limited.cancelWaiting();
  assert.equal(limited.waitReason, undefined);
  assert.equal(final.waiting, false, 'releases are idempotent and do not leak budget');
  final.release();
  const inodeRoot = slots.acquire(path, 'dev:2');
  const inodeAlias = slots.acquire(join(tmpdir(), 'slot-alias'), 'dev:2');
  assert.equal(inodeAlias.waiting, true, 'matching root identities supplement canonical paths');
  inodeRoot.release();
  assert.equal(inodeAlias.waiting, false);
  inodeAlias.release();
  assert.throws(() => slots.acquire('relative'), /Invalid WorkHub workspace/);
});
const HANDOFF_TEST_COMPOSITION = createRunCompositionSnapshot({
  composerId: 'test.handoff',
  composerRevision: '1',
  sourceRevisions: [],
  baseSystemPromptHash: `sha256:${'0'.repeat(64)}`,
  toolCatalogHash: `sha256:${'0'.repeat(64)}`,
  toolAvailabilityHash: `sha256:${'0'.repeat(64)}`,
  baseProviderOptionsHash: `sha256:${'0'.repeat(64)}`,
  toolNames: [],
  contextWindow: null,
});

test('production Host recovery starts with a dispatched tool whose outcome is unknown', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const run = {
      sessionId: session.id,
      invocationId: 'unknown-tool-run',
      runId: 'unknown-tool-run',
      turnId: 'unknown-tool-turn',
    };
    await stores.runtimeEventStore.appendRuntimeEvent(
      session.id,
      run.runId,
      buildInvocationOpenedEvent({
        id: 'unknown-tool-open',
        run,
        openedAt: 10,
        opening: testInvocationOpening(),
      }),
    );
    await stores.agentRunStore.appendEvent(session.id, run.runId, {
      type: 'turn_started',
      id: 'unknown-tool-started',
      sessionId: session.id,
      runId: run.runId,
      turnId: run.turnId,
      ts: 11,
    });
    const args = { path: '/workspace/README.md' };
    const canonicalArgsHash = canonicalToolArgsHash('Read', args);
    await stores.runtimeEventStore.commitToolPrepared({
      operationId: 'unknown-tool-operation',
      journalEventId: 'unknown-tool-operation_prepared',
      runtimeEvent: {
        id: 'unknown-tool-call',
        ...run,
        ts: 12,
        partial: false,
        role: 'model',
        author: 'agent',
        content: { kind: 'function_call', id: 'unknown-tool-call-id', name: 'Read', args },
      },
      dispatchRuntimeEvent: {
        id: 'unknown-tool-dispatch',
        ...run,
        ts: 13,
        partial: false,
        role: 'system',
        author: 'system',
        actions: {
          toolDispatch: {
            protocol: TOOL_BOUNDARY_PROTOCOL_V1,
            operationId: 'unknown-tool-operation',
            providerToolCallId: 'unknown-tool-call-id',
            toolName: 'Read',
            canonicalArgsHash,
            recoveryMode: 'replay_safe',
          },
        },
        refs: { operationId: 'unknown-tool-operation', toolCallId: 'unknown-tool-call-id' },
      },
      providerToolCallId: 'unknown-tool-call-id',
      toolName: 'Read',
      canonicalArgsHash,
      recoveryMode: 'replay_safe',
      committedAt: 13,
    });

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const [invocation] = await stores.runtimeEventStore.listSessionInvocations(session.id);
      assert.equal(invocation?.terminalEvent?.status, 'failed');
      assert.equal(invocation && runtimeInvocationFailureClass(invocation), 'outcome_unknown');
      assert.deepEqual(await stores.runtimeEventStore.listUnsettledToolOperations(session.id), []);
      assert.equal(
        (await stores.runtimeEventStore.readImmutableRuntimeEvents(session.id, run.runId)).some(
          (event) => event.content?.kind === 'function_response',
        ),
        false,
      );
    } finally {
      await composition.close();
    }
  });
});

test('Host bundle recovery repairs terminal tool projections without decoding opaque Session history', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const { composition } = await createCapturedExecutionComposition(owner);
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      const session = await stores.sessionStore.create({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const invocationId = 'bundle-recovery-invocation';
      const runId = 'bundle-recovery-run';
      const turnId = 'bundle-recovery-turn';
      const operationId = 'bundle-recovery-operation';
      const providerToolCallId = 'bundle-recovery-call';
      const args = { path: '/workspace/README.md' };
      const canonicalArgsHash = canonicalToolArgsHash('Read', args);
      const timestamp = Date.now();
      await stores.runtimeEventStore.commitToolPrepared({
        operationId,
        journalEventId: `${operationId}_prepared`,
        runtimeEvent: {
          id: 'bundle-recovery-call-event',
          invocationId,
          runId,
          sessionId: session.id,
          turnId,
          ts: timestamp,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: providerToolCallId, name: 'Read', args },
        },
        dispatchRuntimeEvent: {
          id: 'bundle-recovery-dispatch-event',
          invocationId,
          runId,
          sessionId: session.id,
          turnId,
          ts: timestamp + 1,
          partial: false,
          role: 'system',
          author: 'system',
          actions: {
            toolDispatch: {
              protocol: TOOL_BOUNDARY_PROTOCOL_V1,
              operationId,
              providerToolCallId,
              toolName: 'Read',
              canonicalArgsHash,
              recoveryMode: 'replay_safe',
            },
          },
          refs: { operationId, toolCallId: providerToolCallId },
        },
        providerToolCallId,
        toolName: 'Read',
        canonicalArgsHash,
        recoveryMode: 'replay_safe',
        committedAt: timestamp + 1,
      });

      // Simulate an interrupted run whose terminal RuntimeEvent survived but
      // whose disposable tool projection did not reach its terminal state.
      const rawStore = createSqliteRuntimeStore(join(root, 'runtime.sqlite'));
      try {
        await rawStore.importRuntimeEventsBatch({
          sessionId: session.id,
          runId,
          events: [
            {
              id: 'bundle-recovery-terminal-event',
              invocationId,
              runId,
              sessionId: session.id,
              turnId,
              ts: timestamp + 2,
              partial: false,
              role: 'system',
              author: 'system',
              status: 'failed',
              actions: { endInvocation: true },
            },
          ],
        });
        await rawStore.importRuntimeEventsBatch({
          sessionId: session.id,
          runId: 'bundle-recovery-legacy-run',
          events: [
            {
              id: 'bundle-recovery-opaque-legacy-event',
              invocationId: 'bundle-recovery-legacy-invocation',
              runId: 'bundle-recovery-legacy-run',
              sessionId: session.id,
              turnId: 'bundle-recovery-legacy-turn',
              ts: timestamp + 3,
              partial: false,
              role: 'system',
              author: 'system',
              status: 'failed',
              actions: { endInvocation: true },
              content: { kind: 'text', text: 'preserve this legacy event' },
            },
          ],
        });
      } finally {
        rawStore.close();
      }

      const raw = new DatabaseSync(join(root, 'runtime.sqlite'));
      try {
        const row = raw
          .prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?')
          .get('bundle-recovery-opaque-legacy-event') as { payload_json: string };
        const opaquePayload = `${row.payload_json.slice(0, -1)},"legacyBytePreserved":true}`;
        assert.throws(
          () => decodeRuntimeEvent(JSON.parse(opaquePayload) as unknown),
          /Invalid RuntimeEvent schema/,
        );
        raw
          .prepare('UPDATE runtime_events SET payload_json = ? WHERE event_id = ?')
          .run(opaquePayload, 'bundle-recovery-opaque-legacy-event');
      } finally {
        raw.close();
      }

      const outcome = await composition.handlers['session-bundle.export'](
        {
          sessionId: session.id,
          destination: join(root, 'bundle-recovery.maka-session'),
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'bundle-recovery-test',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.ok(outcome.ok, JSON.stringify(outcome));
      assert.deepEqual(
        await stores.runtimeEventStore.listUnsettledToolOperations([session.id]),
        [],
      );
    } finally {
      await composition.close();
    }
  });
});

test('idle schedules and armed or paused Goals allow production handoff and recover in the successor', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const store = await openInteractiveDailyReviewAuthorityForWrite(owner.lease);
    const snapshot = await store.readConfig();
    await store.updateConfig(snapshot.revision, {
      enabled: true,
      executeTime: '00:00',
      modelKey: '',
    });
    const schedules = await openInteractiveScheduledTaskStoreForWrite(owner.lease);
    await schedules.create(
      {
        title: 'Future reminder',
        intentBody: 'Remind me tomorrow',
        schedule: { kind: 'once', runAt: Date.now() + 86_400_000 },
        effect: { kind: 'notify', channel: 'local' },
        createdBy: { kind: 'user' },
      },
      Date.now(),
    );
    schedules.close();
    const residencies = new HostResidencyRegistry();
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      residencies,
    });
    const expected = [
      { label: 'daily-review', count: 1 },
      { label: 'goal', count: 2 },
      { label: 'scheduled-task', count: 1 },
    ];
    try {
      const context = {
        hostEpoch: 'old-host',
        connectionId: 'test',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      for (const pause of [false, true]) {
        const session = await manager.createSession({
          cwd: root,
          llmConnectionId: FAKE_CONNECTION_ID,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
        const armed = await composition.handlers['goal.arm'](
          {
            sessionId: session.id,
            condition: 'Finish later',
            maxIterations: null,
            tokenBudget: null,
          },
          context,
        );
        assert.ok(armed.ok);
        if (pause) {
          const paused = await composition.handlers['goal.control'](
            {
              sessionId: session.id,
              goalId: armed.result.goal.goalId,
              expectedRevision: armed.result.goal.revision,
              action: 'pause',
            },
            context,
          );
          assert.ok(paused.ok);
        }
      }
      await waitFor(async () => residencies.drainCount === 0);
      assert.deepEqual(residencies.snapshot(), expected);
      const cancelled = await composition.prepareHandoff!('old-host', new AbortController().signal);
      assert.ok(cancelled);
      assert.equal(await cancelled.seal(), true);
      const cancelledProof = await cancelled.residencies();
      assert.ok(cancelledProof);
      assert.equal(residencies.hasDrainResidenciesExcept(cancelledProof), false);
      cancelled.cancel();
      const prepared = await composition.prepareHandoff!('old-host', new AbortController().signal);
      assert.ok(prepared);
      assert.equal(await prepared.seal(), true);
      const proof = await prepared.residencies();
      assert.ok(proof);
      assert.equal(residencies.hasDrainResidenciesExcept(proof), false);
      await prepared.detach();
    } finally {
      await composition.close();
    }
    assert.equal(residencies.activeCount, 0);
    await owner.close();
    const successorOwner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(successorOwner);
    try {
      const successor = await createCapturedExecutionComposition(successorOwner, { residencies });
      try {
        await waitFor(async () => residencies.drainCount === 0);
        assert.deepEqual(residencies.snapshot(), expected);
      } finally {
        await successor.composition.close();
      }
    } finally {
      await successorOwner.close();
    }
  });
});

test('production handoff fences WorkHub result polling and waits for a poll resumed by cancellation', {
  timeout: 20_000,
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const finishPoll = deferred<void>();
  let polls = 0;
  t.mock.method(HostWorkHubResultCoordinator.prototype, 'reconcile', async () => {
    polls += 1;
    await finishPoll.promise;
  });
  await withCompositionRoot(async ({ owner }) => {
    const residencies = new HostResidencyRegistry();
    const { composition } = await createCapturedExecutionComposition(owner, { residencies });
    try {
      const cancelled = await composition.prepareHandoff!('old-host', new AbortController().signal);
      assert.ok(cancelled);
      assert.equal(await cancelled.seal(), true);
      // Move past the startup poll while the handoff owns the scheduler.
      t.mock.timers.tick(1000);
      assert.equal(polls, 0);
      const proof = await cancelled.residencies();
      assert.ok(proof);
      assert.equal(residencies.hasDrainResidenciesExcept(proof), false);

      cancelled.cancel();
      t.mock.timers.tick(100);
      assert.equal(polls, 1);
      assert.ok(residencies.drainCount > 0);
      let prepared = false;
      const preparing = composition.prepareHandoff!('old-host', new AbortController().signal).then(
        (result) => {
          prepared = true;
          return result;
        },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(prepared, false, 'handoff must wait for the poll and its residency to settle');
      finishPoll.resolve();
      const next = await preparing;
      assert.ok(next);
      assert.equal(await next.seal(), true);
      const nextProof = await next.residencies();
      assert.ok(nextProof);
      assert.equal(residencies.hasDrainResidenciesExcept(nextProof), false);
      await next.detach();
      t.mock.timers.tick(60_000);
      assert.equal(polls, 1, 'a detached predecessor must not restart result polling');
    } finally {
      finishPoll.resolve();
      await composition.close();
    }
    assert.equal(residencies.activeCount, 0);
  });
});

test('production composition resumes a sealed logical Root after all stores and runtime owners reopen', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const entered = deferred<void>();
    const boundary = deferred<void>();
    const requested = deferred<void>();
    let dispatches = 0;
    const backendFactory: BackendFactory = (context) =>
      new (class extends FakeBackend {
        async prepareRunComposition(input: { runId: string; turnId: string }): Promise<void> {
          await context.recordRunComposition!(input.runId, HANDOFF_TEST_COMPOSITION);
        }

        override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          assert.ok(input.runId);
          await this.prepareRunComposition({ runId: input.runId, turnId: input.turnId });
          dispatches += 1;
          if (!input.continuation) {
            assert.equal(input.maxSteps, 4);
            entered.resolve();
            await boundary.promise;
            assert.equal(await input.handoffBoundary!(new AbortController().signal, 3), 'pause');
            return;
          }
          assert.equal(input.maxSteps, 3);
          yield {
            type: 'complete',
            id: 'completed-after-reopen',
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: 'end_turn',
          };
        }
      })(context);
    const residencies = new HostResidencyRegistry();
    const first = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: backendFactory,
      residencies,
    });
    let successorOwner: InteractiveRootOwner | undefined;
    let successor: Awaited<ReturnType<typeof createCapturedExecutionComposition>> | undefined;
    try {
      const request = first.manager.requestRunHandoff.bind(first.manager);
      first.manager.requestRunHandoff = (...args) => {
        const result = request(...args);
        requested.resolve();
        return result;
      };
      const session = await first.manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await first.composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'reopen-handoff-turn',
          content: { text: 'continue after restart' },
          maxSteps: 4,
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'client',
          principal: 'local_os_user',
          acquireResidency: () => residencies.acquire('test-operation'),
        },
      );
      assert.equal(started.ok, true, JSON.stringify(started));
      await entered.promise;
      assert.ok(first.composition.prepareHandoff);
      const preparing = first.composition.prepareHandoff(
        'execution-composition-test',
        new AbortController().signal,
      );
      await requested.promise;
      boundary.resolve();
      const preparation = await preparing;
      assert.ok(preparation);
      assert.equal(await preparation.seal(), true);
      const transferred = await preparation.residencies();
      assert.ok(transferred);
      assert.equal(
        residencies.hasDrainResidenciesExcept(transferred),
        false,
        JSON.stringify(residencies.snapshot()),
      );
      await preparation.detach();
      first.composition.beginDrain();
      await first.composition.close();
      assert.equal(dispatches, 1);
      await owner.close();

      successorOwner = await tryAcquireInteractiveRootOwner(
        await resolveStorageRoot({ path: root, kind: 'interactive' }),
      );
      assert.ok(successorOwner);
      successor = await createCapturedExecutionComposition(successorOwner, {
        primaryBackendFactory: backendFactory,
      });
      const stores = await openInteractiveExecutionStoresForWrite(successorOwner.lease);
      await waitFor(
        async () =>
          (await stores.runtimeEventStore.listSessionInvocations(session.id)).some(
            (run) => runtimeInvocationOutcome(run) === 'completed',
          ),
        5_000,
      );
      const runs = await stores.runtimeEventStore.listSessionInvocations(session.id);
      assert.equal(runs.length, 2);
      assert.equal(new Set(runs.map((run) => run.turnId)).size, 1);
      assert.equal(
        runs.filter((run) => run.terminalEvent && runtimeHandoffPause(run.terminalEvent)).length,
        1,
      );
      assert.equal(runs.filter((run) => runtimeInvocationOutcome(run) === 'completed').length, 1);
      assert.equal(dispatches, 2);
    } finally {
      boundary.resolve();
      first.composition.beginDrain();
      await first.composition.close();
      successor?.composition.beginDrain();
      await successor?.composition.close();
      await successorOwner?.close();
    }
  });
});

test('production recovery leaves upgrade residue for explicitly started maintenance', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const directory = join(root, 'artifacts', 'retired');
    const path = join(directory, 'orphan');
    await mkdir(directory, { recursive: true });
    await writeFile(path, 'old bytes');
    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      database
        .prepare('INSERT INTO artifact_upgrade_orphan_paths VALUES (?)')
        .run('retired/orphan');
      await composition.recover();
      assert.equal((await stat(path)).size, 9);
      composition.startMaintenance?.();
      await waitFor(async () => {
        return (
          database.prepare('SELECT count(*) AS n FROM artifact_upgrade_orphan_paths').get()?.n === 0
        );
      });
      await assert.rejects(stat(path), { code: 'ENOENT' });
    } finally {
      await composition.close();
      database.close();
    }
  });
});

test('filesystem worker follows the candidate executable runtime', () => {
  assert.equal(runtimeHostFilesystemWorkerRuntime({ electron: '43.1.1' }), 'electron');
  assert.equal(runtimeHostFilesystemWorkerRuntime({}), 'node');
});

for (const scopeCurrent of [true, false])
  test(`task Stop rechecks scope inside cancellation admission and only uses preserving Root Stop (${scopeCurrent})`, async () => {
    const source: Parameters<typeof retireWorkHubDelegation>[0] = {
      type: 'workhub_coordination',
      kind: 'delegation_assigned',
      schemaVersion: 4,
      id: 'assignment-task',
      turnId: 'coordination',
      ts: 1,
      actionId: 'source-task',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      coordinationTurnId: 'coordination',
      disposition: 'delegate_existing',
      delegationId: 'delegation-task',
      targetSessionId: 'target',
      targetSessionName: 'Task',
      targetMessageId: 'message-task',
      targetTurnId: 'original',
      userText: 'work',
      work: { id: 'task', generationId: 'generation' },
    };
    const identity = { sessionId: 'target', turnId: 'original', runId: 'original-run' };
    const admission = new SessionAdmissionGate();
    const trace: string[] = [];
    let terminal = false;
    const result = await retireWorkHubDelegation(
      source,
      {
        cause: 'direct_stop',
        cancellationClaimId: 'stop-action',
        executionBinding: 'confirmed',
      },
      {
        messages: {
          cancelMessageIfPending: (sessionId, _id, _claim, validate) =>
            admission.run(sessionId, async (lease) => {
              trace.push('locked');
              if ((await validate?.(lease)) === false) return { kind: 'not_owned' };
              trace.push('cancel');
              return { kind: 'owned_root', turnId: identity.turnId, runId: identity.runId };
            }),
        },
        readStopTarget: async (_source, lease) => {
          assert.ok(lease);
          await admission.runAdmitted('target', lease, async () => {});
          trace.push('binding');
          return { binding: 'confirmed', execution: identity };
        },
        coordinator: {
          readRootState: () => ({ kind: 'active', ...identity }),
          read: async () => ({
            ...identity,
            status: terminal ? 'cancelled' : 'running',
            abortSource: workHubDirectStopAbortSource('stop-action'),
          }),
          stopRoot: async () => assert.fail('must not fall back to a full Session Stop'),
        } as unknown as Parameters<typeof retireWorkHubDelegation>[2]['coordinator'],
        taskStop: {
          validate: (lease) =>
            admission.runAdmitted('target', lease, async () => {
              trace.push('scope');
              return scopeCurrent;
            }),
          stopRoot: async (actual, input) => {
            assert.deepEqual(actual, identity);
            assert.equal(input?.source, 'workhub_direct_stop');
            trace.push('preserve');
            terminal = true;
          },
        },
      },
    );
    assert.deepEqual(
      trace,
      scopeCurrent ? ['locked', 'scope', 'binding', 'cancel', 'preserve'] : ['locked', 'scope'],
    );
    assert.equal(result.outcome, scopeCurrent ? 'stop_delivered' : 'not_owned');
  });

test('WorkHub recovers a delivered root Stop from its durable cancelled Turn', async () => {
  let stopCalls = 0;
  const outcome = await stopOwnedWorkHubRoot(
    {
      readRootState: () => ({ kind: 'idle' }),
      read: async (identity: { sessionId: string; turnId: string; runId: string }) => ({
        ...identity,
        status: 'cancelled',
        terminalEventId: 'terminal-workhub-stop',
        abortSource: workHubDirectStopAbortSource('workhub-stop-action'),
      }),
      stopRoot: async () => {
        stopCalls += 1;
      },
    } as unknown as Parameters<typeof stopOwnedWorkHubRoot>[0],
    { sessionId: 'target-session', turnId: 'target-turn', runId: 'target-run' },
    'workhub-stop-action',
  );

  assert.deepEqual(outcome, {
    outcome: 'stop_delivered',
    targetTurnId: 'target-turn',
  });
  assert.equal(stopCalls, 0);
});

for (const scenario of [
  'changed-after-claim',
  'changed-after-validation',
  'legacy-resumed',
] as const)
  test(`WorkHub stop cannot retarget a resumed execution (${scenario})`, async () => {
    const assignment: Parameters<typeof retireWorkHubDelegation>[0] = {
      type: 'workhub_coordination',
      id: `wha_${'a'.repeat(48)}`,
      turnId: 'coordination',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'task-action',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      coordinationTurnId: 'coordination',
      targetSessionId: 'target',
      targetSessionName: 'task',
      targetTurnId: 'original',
      targetMessageId: `whm_${'a'.repeat(48)}`,
      delegationId: `whd_${'a'.repeat(48)}`,
      disposition: 'delegate_existing',
      userText: 'work',
    };
    const original = { sessionId: 'target', turnId: 'original', runId: 'original-run' };
    const resumed = { sessionId: 'target', turnId: 'resumed', runId: 'resumed-run' };
    let active = scenario === 'changed-after-validation' ? original : resumed;
    let cancellations = 0,
      stops = 0;
    const admission = new SessionAdmissionGate();
    const result = await retireWorkHubDelegation(
      assignment,
      {
        cancellationClaimId: 'stop-action',
        cause: 'direct_stop',
        ...(scenario === 'legacy-resumed' ? {} : { executionBinding: 'confirmed-original' }),
      },
      {
        messages: {
          cancelMessageIfPending: async (sessionId, _messageId, _claim, validate) =>
            admission.run(sessionId, async (lease) => {
              if ((await validate?.(lease)) === false) return { kind: 'not_owned' };
              cancellations++;
              if (scenario === 'changed-after-validation') active = resumed;
              return { kind: 'owned_root', turnId: original.turnId, runId: original.runId };
            }),
        },
        readStopTarget: async (_source, lease) => {
          if (lease) await admission.runAdmitted('target', lease, async () => undefined);
          return {
            binding: active === original ? 'confirmed-original' : 'different-resumed',
            execution: active,
          };
        },
        coordinator: {
          readRootState: () => ({ kind: 'active', ...active }),
          read: async (identity: typeof original) => ({
            ...identity,
            status: 'completed',
            terminalEventId: 'old-terminal',
          }),
          stopRoot: async () => {
            stops++;
          },
        } as unknown as Parameters<typeof retireWorkHubDelegation>[2]['coordinator'],
      },
    );
    assert.equal(stops, 0, 'never sends Stop to the resumed execution');
    assert.equal(cancellations, scenario === 'changed-after-claim' ? 0 : 1);
    assert.equal(
      result.outcome,
      scenario === 'changed-after-validation' ? 'already_terminal' : 'not_owned',
    );
    assert.equal(active, resumed);
  });

for (const legacy of [false, true])
  for (const phase of ['pending', 'initial', 'resumed', 'unproven'] as const)
    test(`pending WorkHub stop follows only the first Message execution (${phase}, legacy=${legacy})`, async () => {
      const assignment: Parameters<typeof retireWorkHubDelegation>[0] = {
        type: 'workhub_coordination',
        id: `wha_${'b'.repeat(48)}`,
        turnId: 'coordination',
        ts: 1,
        schemaVersion: 1,
        kind: 'delegation_assigned',
        actionId: 'pending-task',
        actionFingerprint: `sha256:${'b'.repeat(64)}`,
        coordinationTurnId: 'coordination',
        targetSessionId: 'target',
        targetSessionName: 'queued task',
        targetTurnId: 'preceding-turn',
        targetMessageId: `whm_${'b'.repeat(48)}`,
        delegationId: `whd_${'b'.repeat(48)}`,
        disposition: 'delegate_existing',
        userText: 'work',
      };
      const initial = { sessionId: 'target', turnId: 'first', runId: 'first-run' };
      const resumed = { sessionId: 'target', turnId: 'later', runId: 'later-run' };
      const active = phase === 'resumed' ? resumed : initial;
      const admission = new SessionAdmissionGate();
      let stops = 0;
      const result = await retireWorkHubDelegation(
        assignment,
        {
          cancellationClaimId: 'pending-stop',
          cause: 'direct_stop',
          executionBinding: legacy
            ? '{"kind":"pending"}'
            : JSON.stringify([
                'pending_message',
                assignment.actionId,
                assignment.delegationId,
                assignment.targetSessionId,
                assignment.targetMessageId,
              ]),
        },
        {
          messages: {
            cancelMessageIfPending: async (sessionId, _messageId, _claimId, validate) =>
              admission.run(sessionId, async (lease) => {
                if ((await validate?.(lease)) === false) return { kind: 'not_owned' };
                if (phase === 'pending') return { kind: 'cancelled_pending' };
                return { kind: 'owned_root', turnId: initial.turnId, runId: initial.runId };
              }),
          },
          readStopTarget: async (_source, lease) => {
            if (lease) await admission.runAdmitted('target', lease, async () => undefined);
            if (phase === 'pending')
              return {
                binding: JSON.stringify([
                  'pending_message',
                  assignment.actionId,
                  assignment.delegationId,
                  assignment.targetSessionId,
                  assignment.targetMessageId,
                ]),
              };
            return {
              binding: 'current-execution',
              execution: active,
              ...(phase === 'unproven' ? {} : { initialExecution: initial }),
            };
          },
          coordinator: {
            readRootState: () => ({ kind: 'active', ...active }),
            stopRoot: async (identity: typeof initial) => {
              assert.deepEqual(identity, initial);
              stops++;
            },
            read: async (identity: typeof initial) => ({
              ...identity,
              status: 'cancelled',
              terminalEventId: 'first-terminal',
              abortSource: workHubDirectStopAbortSource('pending-stop'),
            }),
          } as unknown as Parameters<typeof retireWorkHubDelegation>[2]['coordinator'],
        },
      );
      assert.equal(stops, phase === 'initial' ? 1 : 0);
      assert.equal(
        result.outcome,
        phase === 'pending'
          ? 'cancelled_pending'
          : phase === 'initial'
            ? 'stop_delivered'
            : 'not_owned',
      );
    });

test('WorkHub never reports a still-running root as already terminal', async () => {
  // The restart window: the execution is not registered in memory yet, so the
  // root looks inactive while its durable snapshot is still running.
  const outcome = await stopOwnedWorkHubRoot(
    {
      readRootState: () => ({ kind: 'idle' }),
      read: async (identity: { sessionId: string; turnId: string; runId: string }) => ({
        ...identity,
        status: 'running',
      }),
      stopRoot: async () => assert.fail('an unregistered root cannot be stopped'),
    } as unknown as Parameters<typeof stopOwnedWorkHubRoot>[0],
    { sessionId: 'target-session', turnId: 'target-turn', runId: 'target-run' },
    'workhub-stop-action',
  );

  assert.deepEqual(outcome, { outcome: 'recovering', targetTurnId: 'target-turn' });

  // A durably terminal snapshot is still the proof `already_terminal` needs.
  const settled = await stopOwnedWorkHubRoot(
    {
      readRootState: () => ({ kind: 'idle' }),
      read: async (identity: { sessionId: string; turnId: string; runId: string }) => ({
        ...identity,
        status: 'completed',
        terminalEventId: 'terminal-complete',
      }),
      stopRoot: async () => assert.fail('a completed root cannot be stopped'),
    } as unknown as Parameters<typeof stopOwnedWorkHubRoot>[0],
    { sessionId: 'target-session', turnId: 'target-turn', runId: 'target-run' },
    'workhub-stop-action',
  );

  assert.deepEqual(settled, { outcome: 'already_terminal', targetTurnId: 'target-turn' });
});

test('WorkHub binds a fresh owning-root Stop to its action identity', async () => {
  let source: string | undefined;
  let actionId: string | undefined;
  const outcome = await stopOwnedWorkHubRoot(
    {
      readRootState: () => ({
        kind: 'active',
        sessionId: 'target-session',
        turnId: 'target-turn',
        runId: 'target-run',
      }),
      read: async (identity: { sessionId: string; turnId: string; runId: string }) => ({
        ...identity,
        status: 'cancelled',
        terminalEventId: 'terminal-workhub-stop',
        abortSource: workHubDirectStopAbortSource('workhub-stop-action'),
      }),
      stopRoot: async (
        _identity: { sessionId: string; turnId: string; runId: string },
        input: {
          source?: 'stop_button' | 'graph_supervisor' | 'workhub_direct_stop';
          workHubActionId?: string;
        },
      ) => {
        source = input.source;
        actionId = input.workHubActionId;
      },
    } as unknown as Parameters<typeof stopOwnedWorkHubRoot>[0],
    { sessionId: 'target-session', turnId: 'target-turn', runId: 'target-run' },
    'workhub-stop-action',
  );

  assert.equal(source, 'workhub_direct_stop');
  assert.equal(actionId, 'workhub-stop-action');
  assert.equal(outcome.outcome, 'stop_delivered');
});

test('WorkHub detects a manual Stop that wins after its active-root check', async () => {
  let stopCalls = 0;
  const outcome = await stopOwnedWorkHubRoot(
    {
      readRootState: () => ({
        kind: 'active',
        sessionId: 'target-session',
        turnId: 'target-turn',
        runId: 'target-run',
      }),
      read: async (identity: { sessionId: string; turnId: string; runId: string }) => ({
        ...identity,
        status: 'cancelled',
        terminalEventId: 'concurrent-manual-stop',
        abortSource: 'renderer.stop_button',
      }),
      stopRoot: async () => {
        stopCalls += 1;
      },
    } as unknown as Parameters<typeof stopOwnedWorkHubRoot>[0],
    { sessionId: 'target-session', turnId: 'target-turn', runId: 'target-run' },
    'workhub-stop-action',
  );

  assert.equal(stopCalls, 1);
  assert.equal(outcome.outcome, 'already_terminal');
});

test('production composition owns the long-term memory database lifecycle', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const databasePath = join(root, LONG_TERM_MEMORY_DATABASE_NAME);
    await assert.rejects(stat(databasePath), { code: 'ENOENT' });

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const workspaceExecution = composition.workspaceExecution;
    assert.equal(workspaceExecution.state, 'ready');
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
    assert.equal((await stat(databasePath)).isFile(), true);

    composition.beginDrain();
    assert.equal(workspaceExecution.state, 'draining');
    await composition.close();
    assert.equal(workspaceExecution.state, 'closed');
    await assert.rejects(memory.readItem('after-close'), /closed/);
    const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    const database = new Database(databasePath);
    try {
      const counts = database
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM memory_items) AS item_count,
             (SELECT COUNT(*) FROM memory_write_operations) AS operation_count`,
        )
        .get() as { item_count?: unknown; operation_count?: unknown };
      assert.equal(counts.item_count, 0);
      assert.equal(counts.operation_count, 0);
    } finally {
      database.close();
    }
  });
});

test('production composition reaches Ready when the optional context Store cannot open', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const requestFingerprint = `sha256:${'a'.repeat(64)}` as const;
    const preparingSessionId = 'preparing-context-copy';
    const sessionStore = createSessionStore(root);
    await sessionStore.createStableSession({
      sessionId: preparingSessionId,
      requestFingerprint,
      input: {
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
        name: 'Preparing context copy',
        labels: [],
        parentSessionId: 'source-session',
        branchOfTurnId: 'source-turn',
        conversationCopy: {
          kind: 'branch',
          sourceSessionId: 'source-session',
          sourceTurnId: 'source-turn',
          requestFingerprint,
          state: 'preparing',
        },
      },
    });
    await sessionStore.close?.();
    await mkdir(join(root, CONTEXT_OFFLOAD_DATABASE_NAME));
    const originalConsoleError = console.error;
    const diagnostics: string[] = [];
    console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(' '));
    let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>> | undefined;
    try {
      composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
      assert.equal(composition.workspaceExecution.state, 'ready');
      assert.equal(
        diagnostics.some((message) => message.includes('optional context-offload Store')),
        true,
      );
      await composition.recover();
      assert.equal(
        diagnostics.some((message) =>
          message.includes('conversation copy cleanup deferred during recovery'),
        ),
        true,
      );
    } finally {
      console.error = originalConsoleError;
      if (composition) {
        await composition.close();
      }
    }
    const reopened = createSessionStore(root);
    try {
      assert.equal(
        (await reopened.readHeaderSnapshot(preparingSessionId)).conversationCopy?.state,
        'preparing',
      );
    } finally {
      await reopened.close?.();
    }
  });
});

test('production composition closes long-term memory after a later startup failure', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const memory = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);

    // Fail the composition after the memory store is opened: beginHostEpoch
    // runs later in the startup sequence and rejects an invalid host epoch,
    // so the composition must close every resource it opened, including
    // long-term memory.
    await assert.rejects(
      createExecutionRuntimeHostComposition({
        ...compositionContext(owner),
        hostEpoch: 'invalid host epoch!',
      }),
    );
    await assert.rejects(memory.readItem('after-failed-start'), /closed/);

    await owner.close();
    const recoveredCapability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    const recoveredOwner = await tryAcquireInteractiveRootOwner(recoveredCapability);
    assert.ok(recoveredOwner);
    if (!recoveredOwner) return;
    try {
      const recovered = await createExecutionRuntimeHostComposition(
        compositionContext(recoveredOwner),
      );
      await recovered.close();
    } finally {
      await recoveredOwner.close();
    }
  });
});

test('production recovery preserves legacy Automation history and closes an orphaned admission', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const historical = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const pending = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const admitted = await stores.agentRunStore.admitRootTurn({
      sessionId: pending.id,
      turnId: 'legacy-automation-turn',
      proposedRunId: 'legacy-automation-run',
      proposedUserMessageId: 'legacy-automation-message',
      execution: { kind: 'scheduled_task', scheduledTaskId: 'legacy-automation' },
      previousRootTurnId: null,
      normalizedInput: { text: 'Run the legacy Automation' },
      sourceMessages: [],
      admittedAt: 1,
    });
    assert.equal(admitted.kind, 'admitted');

    const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
    const database = new Database(join(root, 'runtime.sqlite'));
    database.exec('BEGIN IMMEDIATE');
    try {
      database
        .prepare(`
          INSERT INTO session_messages(
            session_id, sequence, message_id, message_type, message_ts, record_json
          ) VALUES (?, 0, ?, 'user', 1, ?)
        `)
        .run(
          historical.id,
          'historical-automation-message',
          JSON.stringify({
            type: 'user',
            id: 'historical-automation-message',
            turnId: 'historical-automation-turn',
            ts: 1,
            text: 'Historical Automation prompt',
            origin: { kind: 'automation', automationId: 'historical-automation' },
          }),
        );
      const row = database
        .prepare(`
          SELECT record_json
          FROM core_root_turn_admissions
          WHERE session_id = ? AND turn_id = 'legacy-automation-turn'
        `)
        .get(pending.id) as { record_json: string };
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      record.execution = { kind: 'automation', automationId: 'legacy-automation' };
      database
        .prepare(`
          UPDATE core_root_turn_admissions
          SET record_json = ?
          WHERE session_id = ? AND turn_id = 'legacy-automation-turn'
        `)
        .run(JSON.stringify(record), pending.id);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    database.close();

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      // The legacy transcript itself, as the converter reads it: recovery must
      // leave a pre-ledger Automation's origin intact for the import that
      // follows on the Session's first read.
      const history = await stores.sessionStore.readMessages(historical.id);
      assert.deepEqual(history[0]?.type === 'user' ? history[0].origin : undefined, {
        kind: 'legacy_automation',
        automationId: 'historical-automation',
      });
      const recoveredRun = (await stores.runtimeEventStore.listSessionInvocations(pending.id)).find(
        (candidate) => candidate.runId === 'legacy-automation-run',
      );
      assert.ok(recoveredRun);
      assert.equal(recoveredRun && runtimeInvocationOutcome(recoveredRun), 'failed');
      assert.deepEqual(recoveredRun?.opening.root, {
        kind: 'legacy_automation',
        legacyAutomationId: 'legacy-automation',
      });
      assert.equal(recoveredRun && runtimeInvocationFailureClass(recoveredRun), 'app_restarted');
    } finally {
      await composition.close();
    }
  });
});

test('composition drain preserves usage admission until active Runtime work settles', async () => {
  await withCompositionRoot(async ({ owner }) => {
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const usage = await openInteractiveUsageStoresForWrite(owner.lease);
    composition.beginDrain();

    await usage.telemetry.recordLlmCall(lifecycleUsageRecord());
    const persisted = await usage.telemetry.logs({ range: 'all' }, 0, 10);
    assert.deepEqual(
      persisted.rows.map((row) => row.id),
      ['usage_after_composition_drain'],
    );

    await composition.close();
  });
});

test('WorkHub find reads configured connection pricing through the production composition', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const session = await stores.sessionStore.create({
        cwd: root,
        name: 'Pricing discovery target',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const usage = await openInteractiveUsageStoresForWrite(owner.lease);
      const snapshot = await usage.pricing.snapshot();
      await usage.pricing.upsert(snapshot.revision, {
        modelKey: 'fake:fake-model',
        inputUsdPer1M: 2,
        outputUsdPer1M: 3,
        cacheReadUsdPer1M: 0.2,
      });
      const result = await composition.handlers['workhub.tasks.find'](
        { query: session.name },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'pricing-discovery',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.ok(result.ok, JSON.stringify(result));
      const hit = result.result.items.find((item) => item.id === session.id);
      assert.ok(hit);
      assert.equal(hit.context?.estimates?.costs.pricingSource, 'configured_connection_override');
      assert.equal(
        hit.context?.estimates?.costs.reuseInputBaseline.status,
        'unknown',
        'price is known but no measured model request exists',
      );
      assert.equal(hit.context?.estimates?.costs.reuseInputBaseline.uncachedUsd, null);
      assert.equal(
        (await stores.sessionStore.readHeaderSnapshot(session.id)).permissionMode,
        'ask',
      );
    } finally {
      await composition.close();
    }
  });
});

for (const withChild of [false, true]) {
  test(
    withChild
      ? 'WorkHub find discovers an imported root when its child sorts first'
      : 'WorkHub find discovers a manual Session imported after its first lookup',
    async () => {
      await withCompositionRoot(async ({ root: sourceRoot, owner: sourceOwner }) => {
        const sourceConnectionId = await configureFakeDefaultTarget(sourceOwner);
        const source = await createExecutionRuntimeHostComposition(compositionContext(sourceOwner));
        const context: ConnectionContext = {
          hostEpoch: 'execution-composition-test',
          connectionId: 'import-discovery',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        };
        try {
          const sourceStores = await openInteractiveExecutionStoresForWrite(sourceOwner.lease);
          const created = await sourceStores.sessionStore.createStableSession({
            sessionId: 'zz-manual-discovery',
            requestFingerprint: `sha256:${'d'.repeat(64)}`,
            input: {
              cwd: sourceRoot,
              name: 'Imported manual discovery',
              model: 'fake-model',
              llmConnectionId: sourceConnectionId,
              llmConnectionSlug: 'fake',
              permissionMode: 'ask',
            },
          });
          assert.equal(created.kind, 'created');
          const manual = created.record.header;
          if (withChild) {
            const child = await sourceStores.sessionStore.createStableSession({
              sessionId: 'aa-imported-child',
              requestFingerprint: `sha256:${'e'.repeat(64)}`,
              input: {
                cwd: sourceRoot,
                name: 'Imported child',
                model: 'fake-model',
                llmConnectionId: sourceConnectionId,
                llmConnectionSlug: 'fake',
                permissionMode: 'ask',
                subagentParent: {
                  kind: 'subagent',
                  parentSessionId: manual.id,
                  spawnedBy: {
                    parentRunId: 'parent-run',
                    parentTurnId: 'parent-turn',
                    toolCallId: 'spawn',
                  },
                  lifecycle: 'foreground',
                },
              },
            });
            assert.equal(child.kind, 'created');
            assert.ok(
              'aa-imported-child' < manual.id,
              'regression requires the child to sort before the root',
            );
          }
          const bundle = join(sourceRoot, 'manual-discovery.maka-session');
          const exported = await source.handlers['session-bundle.export'](
            { sessionId: manual.id, destination: bundle },
            context,
          );
          assert.ok(exported.ok, JSON.stringify(exported));
          await withCompositionRoot(async ({ owner }) => {
            await configureFakeDefaultTarget(owner);
            const target = await createExecutionRuntimeHostComposition(compositionContext(owner));
            try {
              const before = await target.handlers['workhub.tasks.find']({}, context);
              assert.ok(before.ok);
              assert.deepEqual(before.result.items, []);
              const imported = await target.handlers['session-bundle.import'](
                { source: bundle },
                context,
              );
              assert.ok(imported.ok, JSON.stringify(imported));
              assert.equal(imported.result.sessionCount, withChild ? 2 : 1);
              const after = await target.handlers['workhub.tasks.find'](
                { query: manual.name },
                context,
              );
              assert.ok(after.ok, JSON.stringify(after));
              assert.equal(
                after.result.items.find((item) => item.kind === 'session' && item.id === manual.id)
                  ?.available,
                true,
              );
              assert.equal(
                after.result.items.some((item) => item.id === 'aa-imported-child'),
                false,
              );
              const all = await target.handlers['workhub.tasks.find']({}, context);
              assert.ok(all.ok);
              assert.deepEqual(
                all.result.items.map((item) => item.id),
                [manual.id],
                'the root is discovered and its subagent remains ineligible',
              );
            } finally {
              await target.close();
            }
          });
        } finally {
          await source.close();
        }
      });
    },
  );
}

test('WorkHub find removes a directly deleted manual Session without requiring restart', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'remove-discovery',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const manual = await stores.sessionStore.create({
        cwd: root,
        name: 'Deleted manual discovery',
        model: 'fake-model',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        permissionMode: 'ask',
      });
      const before = await composition.handlers['workhub.tasks.find'](
        { query: manual.name },
        context,
      );
      assert.ok(before.ok);
      assert.equal(before.result.items[0]?.id, manual.id);
      const current = await stores.sessionStore.readCatalogRecord(manual.id);
      const removed = await composition.handlers['session.remove'](
        { sessionId: manual.id, expectedRevision: current.revision },
        context,
      );
      assert.ok(removed.ok, JSON.stringify(removed));
      const after = await composition.handlers['workhub.tasks.find'](
        { query: manual.name },
        context,
      );
      assert.ok(after.ok);
      assert.deepEqual(after.result.items, []);
      assert.equal(
        await stores.sessionStore.workHubTaskIndex!.read('session', manual.id),
        undefined,
      );
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub find observes a ledger-only native terminal Stop without falsely retiring completed work', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'retirement-discovery',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const target = await manager.createSession({
        cwd: root,
        name: 'Terminal discovery target',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const resolved = await composition.handlers['workhub.coordination.resolve']({}, context);
      assert.ok(resolved.ok, JSON.stringify(resolved));
      await delegateWorkHubTarget(
        composition,
        context,
        target.id,
        'discovery-terminal-task',
        'Return the completed task output.',
      );
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const source = await stores.sessionStore.readWorkHubAssignment('discovery-terminal-task');
      assert.ok(source);
      await waitFor(async () => {
        const result = await composition.handlers['workhub.tasks.read'](
          { actionId: source.actionId, delegationId: source.delegationId },
          context,
        );
        return result.ok && result.result.task.status === 'pending_acceptance';
      });
      await waitFor(async () => manager.runningTurnIds(target.id).length === 0);
      const first = await composition.handlers['workhub.tasks.find']({}, context);
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal(first.result.items.find((item) => item.id === source.actionId)?.state, 'ended');
      // Flush the initial terminal/catalog notifications before exercising a
      // later ledger-only change; a previously dirty task would mask the bug.
      const warmed = await composition.handlers['workhub.tasks.find']({}, context);
      assert.ok(warmed.ok, JSON.stringify(warmed));
      assert.equal(warmed.result.items.find((item) => item.id === source.actionId)?.state, 'ended');
      assert.equal(
        (await stores.sessionStore.workHubTaskIndex!.read('task', source.actionId))?.dirtyRevision,
        0,
        'the task is cleanly cached before the ledger-only stop',
      );
      const before = await stores.runtimeEventStore.listSessionInvocations(target.id);
      const stopped = await stopWorkHubTasks(
        composition,
        context,
        'discovery-stop-terminal',
        [source.work?.id ?? source.actionId],
        'Stop that completed task.',
      );
      assert.ok(stopped.ok && stopped.result.kind === 'result', JSON.stringify(stopped));
      assert.equal(stopped.result.targets[0]?.outcome, 'already_terminal');
      const resolution = await stores.sessionStore.readWorkHubStopResolution(
        source.delegationId,
        'discovery-stop-terminal',
      );
      assert.equal(resolution?.taskStop, true, 'native no-op scope is explicit');
      assert.equal(
        (await stores.sessionStore.workHubTaskIndex!.read('task', source.actionId))?.dirtyRevision,
        0,
        'no target notification invalidates the cached task',
      );
      assert.deepEqual(
        await stores.runtimeEventStore.listSessionInvocations(target.id),
        before,
        'stopping the ended task creates no target Run or runtime event',
      );
      const after = await composition.handlers['workhub.tasks.find']({}, context);
      assert.ok(after.ok, JSON.stringify(after));
      assert.equal(after.result.items.find((item) => item.id === source.actionId)?.state, 'ended');
      const detail = await composition.handlers['workhub.tasks.read'](
        { actionId: source.actionId, delegationId: source.delegationId },
        context,
      );
      assert.ok(detail.ok, JSON.stringify(detail));
      assert.equal(detail.result.task.status, 'pending_acceptance');
      assert.equal((await stores.sessionStore.readHeaderSnapshot(target.id)).permissionMode, 'ask');
    } finally {
      await composition.close();
    }
  });
});

test('hosted execution settles while its tracked environment resource remains verifiable', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'hosted-fake',
        name: 'Hosted fake',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'fake-model' }],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
    if (fetched.kind !== 'committed') return;
    const defaultTarget = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: fetched.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: 'fake-model' },
    });
    assert.equal(defaultTarget.kind, 'committed');

    const residencies = new HostResidencyRegistry();
    let composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
    const operationContext = {
      hostEpoch: 'hosted-environment-test',
      connectionId: 'hosted-environment-test',
      principal: 'runtime_host' as const,
      acquireResidency: () => ({ release() {} }),
    };
    composition = await createExecutionRuntimeHostComposition(
      {
        owner,
        hostEpoch: operationContext.hostEpoch,
        acquireResidency: (label) => residencies.acquire(label),
        retainUntilProcessExit: () => undefined,
        requestDrain: () => composition?.beginDrain(),
        waitForResidencies: () => residencies.waitForEmpty(),
        waitForResidenciesExcept: (label) => residencies.waitForEmptyExcept(label),
      },
      { bootstrapRuntimePolicy: false },
      {
        primaryBackendFactory: (backendContext) => {
          const backend = new FakeBackend(backendContext);
          const send = backend.send.bind(backend);
          backend.send = async function* (input) {
            if (input.text === 'leave the environment ready for verification') {
              const started = await composition.handlers['runtime.resource.start'](
                { sessionId: backendContext.sessionId, launchId: input.turnId },
                operationContext,
              );
              assert.equal(started.ok, true);
            }
            yield* send(input);
          };
          return backend;
        },
      },
    );
    try {
      await composition.recover();
      const executionId = '00000000-0000-4000-8000-000000000111';
      const execution = composition.handlers['hosted.execution.start'](
        {
          executionId,
          session: {
            workspace: { kind: 'host_path', path: root },
            modelTarget: { kind: 'default' },
            name: 'Hosted environment test',
          },
          content: { text: 'leave the environment ready for verification' },
        },
        operationContext,
      );
      let settled = false;
      void execution.then(() => {
        settled = true;
      });
      try {
        await waitFor(async () => settled, 5_000);
      } catch {
        assert.fail(`Hosted execution did not settle: ${JSON.stringify(residencies.snapshot())}`);
      }
      const result = await execution;
      assert.equal(result.ok, true);
      if (!result.ok) return;
      if (result.result.kind !== 'settled') assert.fail(result.result.failureReason);

      const resources = await composition.handlers['runtime.resource.query'](
        { kind: 'list_start', sessionId: executionId },
        operationContext,
      );
      assert.equal(resources.ok, true);
      if (!resources.ok || resources.result.kind !== 'page') return;
      assert.equal(
        resources.result.resources.some((item) => item.result.status === 'running'),
        true,
      );
    } finally {
      composition.beginDrain();
      await composition.close();
    }
  });
});

test('production composition commits automatic titles through Host-owned Session effects', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'turn-title',
          content: { text: 'Host owns this automatic title' },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'title-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(started.ok, true);
      await waitFor(async () => {
        const summary = (await manager.listSessions()).find((item) => item.id === session.id);
        return summary?.name === 'Host owns this automatic title';
      });
    } finally {
      await composition.close();
    }
  });
});

test('injected title generation preserves the Session retirement boundary', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const releaseTitle = deferred<void>();
    const residencies = new HostResidencyRegistry();
    let titleCalls = 0;
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      residencies,
      generateSessionTitle: async ({ sourceText }) => {
        assert.equal(sourceText, 'Archive after naming');
        titleCalls += 1;
        await releaseTitle.promise;
        // Desktop E2E uses the same local fallback, not a provider request.
        return undefined;
      },
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'archive-title-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => residencies.acquire('archive-title-turn'),
    };
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'archive-title-turn',
          content: { text: 'Archive after naming' },
        },
        context,
      );
      assert.equal(started.ok, true);
      await waitFor(async () => titleCalls === 1);
      // A durable terminal snapshot can precede release of the live root.
      // Isolate the naming guard only after the Turn's residency is released.
      await waitFor(
        async () => !residencies.snapshot().some(({ label }) => label === 'archive-title-turn'),
      );
      const busy = await composition.handlers['session.lifecycle.set'](
        {
          sessionId: session.id,
          state: 'archived',
        },
        context,
      );
      assert.equal(busy.ok, false);
      if (busy.ok) assert.fail('An active naming effect must block archive');
      assert.equal(busy.error.code, 'session_busy');
      assert.match(busy.error.message, /live derived effect/);

      releaseTitle.resolve();
      await waitFor(
        async () => !residencies.snapshot().some(({ label }) => label === 'session-effect'),
      );
      const named = (await manager.listSessions()).find(({ id }) => id === session.id);
      assert.equal(named?.name, 'Archive after naming');
      const archived = await composition.handlers['session.lifecycle.set'](
        {
          sessionId: session.id,
          state: 'archived',
        },
        context,
      );
      assert.equal(archived.ok, true, JSON.stringify(archived));
      assert.equal(titleCalls, 1);
    } finally {
      releaseTitle.resolve();
      await composition.close();
    }
  });
});

test('a committed Client Capability replacement stays acknowledged when recovery drains the Host', async (t) => {
  await withCompositionRoot(async ({ owner }) => {
    let drainRequests = 0;
    const { composition } = await createCapturedExecutionComposition(owner, {
      context: {
        retainUntilProcessExit: () => undefined,
        requestDrain: () => {
          drainRequests += 1;
        },
      },
    });
    const frames: ClientCapabilityHostFrame[] = [];
    const connectionId = 'capability-recovery-client';
    const connection = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(connectionId),
      {
        send: async (frame) => {
          frames.push(frame);
        },
      },
    );
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId,
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const firstRegistrationId = randomUUID();
    try {
      const first = await composition.handlers['client.capability.replace'](
        {
          registrationId: firstRegistrationId,
          offers: workHubDesktopCapabilityOffers(),
        },
        context,
      );
      assert.ok(first.ok, JSON.stringify(first));

      t.mock.method(RootTurnCoordinator.prototype, 'recover', async () => {
        throw new Error('fixture post-commit recovery failure');
      });
      const replacement = await composition.handlers['client.capability.replace'](
        {
          registrationId: randomUUID(),
          offers: workHubDesktopCapabilityOffers(),
        },
        context,
      );

      assert.ok(replacement.ok, JSON.stringify(replacement));
      assert.equal(drainRequests, 1);
      await waitFor(async () =>
        frames.some(
          (frame) =>
            frame.kind === 'client.capability.registration_release' &&
            frame.registrationId === firstRegistrationId,
        ),
      );
    } finally {
      await connection.close();
      await composition.close();
    }
  });
});

test('Session capability publication follows durable archive and removal state, including after reconnect', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const { composition } = await createCapturedExecutionComposition(owner);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'scoped-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const attach = () =>
      composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => undefined },
      );
    let connection = attach();
    const publish = (sessionId: string) =>
      composition.handlers['client.capability.replace'](
        {
          registrationId: randomUUID(),
          sessionId,
          offers: [],
        },
        context,
      );
    const setArchived = async (archived: boolean) => {
      const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
      await stores.sessionStore.setSessionsArchivedVersioned(
        [{ sessionId: session.id, expectedVersion: snapshot.revision }],
        archived,
      );
    };
    try {
      assert.equal(
        (await publish(randomUUID())).ok,
        true,
        'ACP may publish before Session creation',
      );
      assert.equal((await publish(session.id)).ok, true);
      await setArchived(true);
      const archived = await publish(session.id);
      assert.equal(archived.ok, false);
      if (!archived.ok) assert.match(archived.error.message, /retired/);
      await connection.close();
      connection = attach();
      assert.equal((await publish(session.id)).ok, false, 'reconnect must not bypass retirement');
      await setArchived(false);
      assert.equal((await publish(session.id)).ok, true, 'unarchiving allows a fresh publication');
      const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
      await stores.sessionStore.removeSessionsVersioned([
        { sessionId: session.id, expectedVersion: snapshot.revision },
      ]);
      assert.equal((await publish(session.id)).ok, false, 'a tombstone is not a pre-creation ID');
    } finally {
      await connection.close();
      await composition.close();
    }
  });
});

test('production composition enables an explicit resume after user Stop by default', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    await resolveWorkspaceIdentity({ path: root });
    const backendEntered = deferred<void>();
    const stopRequested = deferred<void>();
    const backendFactory: BackendFactory = (context) =>
      new (class extends FakeBackend {
        override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          backendEntered.resolve();
          await stopRequested.promise;
          yield {
            type: 'abort',
            id: `stop-${input.turnId}`,
            turnId: input.turnId,
            ts: Date.now(),
            reason: 'user_stop',
          };
          yield {
            type: 'complete',
            id: `complete-${input.turnId}`,
            turnId: input.turnId,
            ts: Date.now(),
            stopReason: 'user_stop',
          };
        }

        override async stop(): Promise<void> {
          stopRequested.resolve();
          await super.stop();
        }
      })(context);
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: backendFactory,
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'default-interactive-resume-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    const desktop = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(context.connectionId),
      { send: async () => {} },
    );
    try {
      const registered = await composition.handlers['client.capability.replace'](
        { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
        context,
      );
      assert.ok(registered.ok, JSON.stringify(registered));
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'turn-default-interactive-resume',
          content: { text: 'stop before any assistant output' },
        },
        context,
      );
      assert.equal(started.ok, true);
      if (!started.ok || started.result.kind !== 'started') return;
      const startedTurn = started.result.turn;
      await backendEntered.promise;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const sourceEvents = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        session.id,
        startedTurn.runId,
      );
      const sourceIdentity = sourceEvents[0];
      assert.ok(sourceIdentity, 'the running invocation should have a durable RuntimeEvent');
      const toolCallId = 'resume-tool-search-call';
      const eventTs = Math.max(Date.now(), ...sourceEvents.map((event) => event.ts)) + 1;
      const eventIdentity = {
        invocationId: sourceIdentity.invocationId,
        runId: startedTurn.runId,
        sessionId: session.id,
        turnId: startedTurn.turnId,
        partial: false,
      };
      await stores.runtimeEventStore.appendRuntimeEvent(session.id, startedTurn.runId, {
        id: 'resume-tool-search-call-event',
        ...eventIdentity,
        ts: eventTs,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: toolCallId,
          name: 'tool_search',
          args: { query: 'docs' },
        },
        refs: { toolCallId },
      });
      await stores.runtimeEventStore.appendRuntimeEvent(session.id, startedTurn.runId, {
        id: 'resume-tool-search-result-event',
        ...eventIdentity,
        ts: eventTs + 1,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: toolCallId,
          name: 'tool_search',
          result: { kind: 'json', value: { activated: ['fixture_deferred_tool'] } },
          isError: false,
        },
        refs: { toolCallId },
      });
      const stopped = await composition.handlers['turn.stop'](
        {
          sessionId: session.id,
          turnId: startedTurn.turnId,
          runId: startedTurn.runId,
        },
        context,
      );
      assert.equal(stopped.ok, true);
      await waitFor(async () =>
        (await manager.listTurns(session.id)).some(
          (turn) => turn.turnId === startedTurn.turnId && turn.status === 'aborted',
        ),
      );

      const plan = await composition.handlers['turn.resume.query'](
        { sessionId: session.id },
        context,
      );
      assert.equal(plan.ok, true);
      if (plan.ok) {
        assert.equal(plan.result.disposition, 'ready', JSON.stringify(plan.result));
      }
    } finally {
      await desktop.close();
      await composition.close();
    }
  });
});

test('production composition preserves an explicit interactive resume kill switch', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      safeBoundaryResume: false,
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'disabled-interactive-resume-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const plan = await composition.handlers['turn.resume.query'](
        { sessionId: session.id },
        context,
      );
      assert.equal(plan.ok, true);
      assert.deepEqual(plan.ok && plan.result, {
        sessionId: session.id,
        disposition: 'parked',
        reason: 'resume_feature_disabled',
      });
    } finally {
      await composition.close();
    }
  });
});

// Legacy E/F compatibility is exercised below using explicit canonical seeds,
// never by re-enabling the retired model tools or auto-wake producers.

type LegacyRetirementStores = Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
type LegacyAssigned = import('@maka/core/session').WorkHubDelegationAssignedMessage;
type LegacyPeerQuestion = import('@maka/core/workhub-evidence').WorkHubPeerQuestionMessage;
type LegacyWait = import('@maka/core/workhub-evidence').WorkHubEvidenceRequestMessage;
const legacyTaskRef = (a: LegacyAssigned) => ({
  workId: a.work?.id ?? a.actionId,
  generationId: a.work?.generationId ?? a.actionId,
  actionId: a.actionId,
  delegationId: a.delegationId,
  sessionId: a.targetSessionId,
  messageId: a.targetMessageId,
});

/** Native admission establishes real single-source receipts; no old relay RPC is used. */
async function admitLegacyFixtureTask(
  composition: ExecutionRuntimeHostComposition,
  stores: LegacyRetirementStores,
  context: ConnectionContext,
  actionId: string,
  sessionId: string,
  text: string,
): Promise<LegacyAssigned> {
  const desktop = composition.clientCapabilities!.attachConnection(
    clientCapabilityConnectionIdentity(context.connectionId),
    { send: async () => {} },
  );
  const turnId = randomUUID();
  try {
    assert.ok(
      (
        await composition.handlers['client.capability.replace'](
          {
            registrationId: randomUUID(),
            offers: workHubDesktopCapabilityOffers(),
          },
          context,
        )
      ).ok,
    );
    assert.ok(
      (
        await composition.handlers['workhub.coordination.answer'](
          {
            turnId,
            text: 'Authorize the isolated recovery fixture task ' + actionId,
          },
          context,
        )
      ).ok,
    );
    try {
      const started = await composition.handlers['workhub.tasks.start'](
        {
          turnId,
          actionId,
          title: actionId,
          text,
          sessionRef: sessionId,
        },
        context,
      );
      assert.ok(started.ok, JSON.stringify(started));
      const assigned = await stores.sessionStore.readWorkHubAssignment(actionId);
      assert.ok(assigned);
      return assigned;
    } finally {
      const root = await composition.handlers['turn.query'](
        { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId },
        context,
      );
      assert.ok(root.ok, JSON.stringify(root));
      assert.ok(
        (
          await composition.handlers['turn.stop'](
            {
              sessionId: WORKHUB_COORDINATION_SESSION_ID,
              turnId,
              runId: root.result.runId,
            },
            context,
          )
        ).ok,
      );
    }
  } finally {
    await desktop.close();
  }
}

/** Seed old protocol facts only after the real invocation recorded each immutable call. */
async function* legacyFixtureTrace(
  stores: LegacyRetirementStores,
  input: BackendSendInput,
  a: LegacyAssigned,
  b: LegacyAssigned,
): AsyncGenerator<SessionEvent, { question: LegacyPeerQuestion; request: LegacyWait }> {
  const { workHubPeerQuestionIdentity } = await import('@maka/core/workhub-evidence');
  assert.ok(input.runId);
  const run = await stores.runtimeEventStore.readRunInvocation(a.targetSessionId, input.runId);
  assert.ok(run);
  assert.equal(run.turnId, input.turnId);
  assert.equal(run.opening.root.kind, 'user');
  const ask = 'old-peer-ask-' + a.actionId,
    wait = 'old-peer-wait-' + a.actionId;
  const source = legacyTaskRef(b);
  const askArgs = {
    operation: 'ask',
    source: {
      workId: source.workId,
      generationId: source.generationId,
      actionId: source.actionId,
      delegationId: source.delegationId,
    },
    question: 'Pre-upgrade checksum question',
  };
  yield {
    type: 'tool_start',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    toolUseId: ask,
    toolName: 'WorkHubEvidence',
    args: askArgs,
  };
  const ts = Date.now();
  let question: LegacyPeerQuestion = {
    type: 'workhub_peer_question',
    schemaVersion: 1,
    id: '',
    turnId: input.turnId,
    ts,
    expiresAt: ts + 3600000,
    sender: legacyTaskRef(a),
    recipient: legacyTaskRef(b),
    senderRunId: run.runId,
    senderInvocationId: run.invocationId,
    toolCallId: ask,
    question: askArgs.question,
    round: 1,
  };
  question = {
    ...question,
    id:
      'whpq_' +
      createHash('sha256').update(workHubPeerQuestionIdentity(question)).digest('hex').slice(0, 48),
  };
  const askCall = (
    await stores.runtimeEventStore.readImmutableRuntimeEvents(a.targetSessionId, run.runId)
  ).find((event) => event.content?.kind === 'function_call' && event.content.id === ask);
  assert.ok(askCall?.content?.kind === 'function_call');
  assert.equal(askCall.invocationId, run.invocationId);
  assert.deepEqual(askCall.content.args, askArgs);
  await stores.sessionStore.commitWorkHubPeerQuestion(question);
  yield {
    type: 'tool_result',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    toolUseId: ask,
    isError: false,
    content: {
      kind: 'text',
      text: JSON.stringify({ questionId: question.id, requesterSessionId: a.targetSessionId }),
    },
  };
  const waitArgs = {
    operation: 'wait',
    requesterSessionId: a.targetSessionId,
    questionId: question.id,
  };
  yield {
    type: 'tool_start',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    toolUseId: wait,
    toolName: 'WorkHubEvidence',
    args: waitArgs,
  };
  const waitCall = (
    await stores.runtimeEventStore.readImmutableRuntimeEvents(a.targetSessionId, run.runId)
  ).find((event) => event.content?.kind === 'function_call' && event.content.id === wait);
  assert.ok(waitCall?.content?.kind === 'function_call');
  assert.equal(waitCall.invocationId, run.invocationId);
  assert.deepEqual(waitCall.content.args, waitArgs);
  const request: LegacyWait = {
    type: 'workhub_evidence',
    schemaVersion: 1,
    id: workHubEvidenceRequestId(input.turnId),
    turnId: input.turnId,
    ts,
    expiresAt: ts + 3600000,
    senderSessionId: a.targetSessionId,
    senderRunId: run.runId,
    senderInvocationId: run.invocationId,
    toolCallId: wait,
    actionId: a.actionId,
    delegationId: a.delegationId,
    rootMessageId: a.targetMessageId,
    question: question.question,
    round: 1,
    peerQuestionId: question.id,
  };
  await stores.sessionStore.appendMessage(a.targetSessionId, request);
  yield {
    type: 'tool_result',
    id: randomUUID(),
    turnId: input.turnId,
    ts: Date.now(),
    toolUseId: wait,
    isError: false,
    content: {
      kind: 'text',
      text: JSON.stringify({ kind: 'workhub_evidence_waiting', requestId: request.id }),
    },
  };
  return { question, request };
}

test('legacy retirement waits for real terminal iterator cleanup, then releases one worker slot in FIFO without waking old protocol work', {
  timeout: 30000,
}, async (t) => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const targets = await Promise.all(
      ['A', 'B', 'C', 'ordinary-approval'].map(async (name) => {
        const cwd = join(root, 'legacy-' + name);
        await mkdir(cwd);
        return stores.sessionStore.create({
          cwd,
          name,
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
      }),
    );
    const [aTarget, bTarget, cTarget, approvalTarget] = targets;
    assert.ok(aTarget && bTarget && cTarget && approvalTarget);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'legacy-live-fixture',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const peersReady = deferred<void>(),
      cleanup = deferred<void>(),
      stopEntered = deferred<void>(),
      bReplyRecorded = deferred<void>(),
      releaseB = deferred<void>(),
      releaseC = deferred<void>();
    const seen: string[] = [],
      coordinationInputs: string[] = [];
    let facts: { question: LegacyPeerQuestion; request: LegacyWait } | undefined;
    let a: LegacyAssigned | undefined, b: LegacyAssigned | undefined, c: LegacyAssigned | undefined;
    let cleanupReleased = false,
      recoverySettled = false,
      injected = false;
    let pendingApproval: Awaited<
      ReturnType<typeof stores.sessionStore.listPendingSandboxBoundaryRequests>
    >;
    let fifo: Awaited<ReturnType<typeof stores.sessionStore.listMessageAdmissions>>;
    let approvalTurn: { sessionId: string; turnId: string; runId: string } | undefined;
    let composition: ExecutionRuntimeHostComposition | undefined;
    const stopCalls: Parameters<RootTurnCoordinator['stopRootPreservingFollowups']>[] = [];
    const exactStop = RootTurnCoordinator.prototype.stopRootPreservingFollowups;
    t.mock.method(
      RootTurnCoordinator.prototype,
      'stopRootPreservingFollowups',
      function (
        this: RootTurnCoordinator,
        ...args: Parameters<RootTurnCoordinator['stopRootPreservingFollowups']>
      ) {
        stopCalls.push(structuredClone(args));
        stopEntered.resolve();
        return exactStop.apply(this, args);
      },
    );
    const recover = RootTurnCoordinator.prototype.recover;
    t.mock.method(
      RootTurnCoordinator.prototype,
      'recover',
      async function (this: RootTurnCoordinator) {
        await recover.call(this);
        if (injected) return;
        injected = true;
        assert.ok(composition);
        // Adversarial lifecycle seam, NOT a normal pre-Ready product API: after
        // Interaction/root recovery, place live canonical roots in the exact
        // window before E/F startup retirement. A cold process cannot retain an
        // old backend iterator; the separate test below covers real reopen.
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        await setWorkHubConcurrency(composition, context, 1);
        a = await admitLegacyFixtureTask(
          composition,
          stores,
          context,
          'legacy-a',
          aTarget.id,
          'LEGACY_A',
        );
        b = await admitLegacyFixtureTask(
          composition,
          stores,
          context,
          'legacy-b',
          bTarget.id,
          'LEGACY_B',
        );
        c = await admitLegacyFixtureTask(
          composition,
          stores,
          context,
          'legacy-c',
          cTarget.id,
          'LEGACY_C',
        );
        for (const suffix of ['1', '2'])
          assert.ok(
            (
              await composition.handlers['turn.message.submit'](
                {
                  originHostEpoch: context.hostEpoch,
                  sessionId: bTarget.id,
                  messageId: 'ordinary-followup-' + suffix,
                  content: { text: 'ORDINARY_FOLLOWUP_' + suffix },
                  placement: 'next_turn',
                },
                context,
              )
            ).ok,
          );
        fifo = await stores.sessionStore.listMessageAdmissions(bTarget.id);
        assert.deepEqual(
          fifo.map((entry) => entry.messageId),
          ['ordinary-followup-1', 'ordinary-followup-2'],
        );
        const { FAKE_ASK_SANDBOX_BOUNDARY_PROMPT } = await import(
          '@maka/runtime/test-only/fake-backend'
        );
        const ordinary = await composition.handlers['turn.start'](
          {
            sessionId: approvalTarget.id,
            turnId: 'ordinary-approval-turn',
            content: { text: FAKE_ASK_SANDBOX_BOUNDARY_PROMPT },
          },
          context,
        );
        assert.ok(ordinary.ok, JSON.stringify(ordinary));
        assert.ok('turn' in ordinary.result, JSON.stringify(ordinary));
        approvalTurn = {
          sessionId: approvalTarget.id,
          turnId: ordinary.result.turn.turnId,
          runId: ordinary.result.turn.runId,
        };
        await waitFor(
          async () =>
            (await stores.sessionStore.listPendingSandboxBoundaryRequests(approvalTarget.id))
              .length === 1,
        );
        pendingApproval = await stores.sessionStore.listPendingSandboxBoundaryRequests(
          approvalTarget.id,
        );
        peersReady.resolve();
        await waitFor(async () => {
          const value = await composition!.handlers['turn.query'](
            { sessionId: aTarget.id, turnId: a!.targetTurnId },
            context,
          );
          return value.ok && value.result.status === 'completed';
        });
        for (const target of [b, c]) {
          const queued = await composition.handlers['turn.query'](
            { sessionId: target.targetSessionId, turnId: target.targetTurnId },
            context,
          );
          assert.ok(queued.ok && queued.result.status === 'admitted', JSON.stringify(queued));
        }
      },
    );
    const backend: BackendFactory = (backendContext) =>
      new (class extends FakeBackend {
        override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
          if (this.sessionId === aTarget.id && input.text.includes('LEGACY_A')) {
            seen.push('A');
            await peersReady.promise;
            assert.ok(a && b);
            facts = yield* legacyFixtureTrace(stores, input, a, b);
            yield {
              type: 'complete',
              id: randomUUID(),
              turnId: input.turnId,
              ts: Date.now(),
              stopReason: 'dependency_wait',
            };
            await cleanup.promise;
            return;
          }
          if (this.sessionId === bTarget.id && input.text.includes('LEGACY_B')) {
            seen.push('B');
            assert.ok(facts);
            yield {
              type: 'tool_start',
              id: randomUUID(),
              turnId: input.turnId,
              ts: Date.now(),
              toolUseId: 'old-b-reply',
              toolName: 'WorkHubEvidence',
              args: {
                operation: 'reply',
                requesterSessionId: aTarget.id,
                questionId: facts.question.id,
                answer: 'Late checksum',
              },
            };
            bReplyRecorded.resolve();
            await releaseB.promise;
            yield {
              type: 'tool_result',
              id: randomUUID(),
              turnId: input.turnId,
              ts: Date.now(),
              toolUseId: 'old-b-reply',
              isError: false,
              content: { kind: 'text', text: 'The old request is already cancelled' },
            };
            yield {
              type: 'complete',
              id: randomUUID(),
              turnId: input.turnId,
              ts: Date.now(),
              stopReason: 'end_turn',
            };
            return;
          }
          if (this.sessionId === cTarget.id && input.text.includes('LEGACY_C')) {
            seen.push('C');
            await releaseC.promise;
            yield {
              type: 'complete',
              id: randomUUID(),
              turnId: input.turnId,
              ts: Date.now(),
              stopReason: 'end_turn',
            };
            return;
          }
          if (input.text.startsWith('ORDINARY_FOLLOWUP_')) seen.push(input.text);
          yield* super.send(input);
        }
      })(backendContext);
    const before = await Promise.all(
      targets.map((target) => stores.sessionStore.readHeaderSnapshot(target.id)),
    );
    try {
      composition = await createExecutionRuntimeHostComposition(
        compositionContext(owner),
        {},
        {
          primaryBackendFactory: (backendContext) =>
            backendContext.sessionId === WORKHUB_COORDINATION_SESSION_ID
              ? new (class extends FakeBackend {
                  override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
                    coordinationInputs.push(input.text);
                    yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
                  }
                })(backendContext)
              : backend(backendContext),
        },
      );
      const recovering = composition.recover();
      void recovering.then(
        () => {
          recoverySettled = true;
        },
        () => {
          recoverySettled = true;
        },
      );
      await withTimeout(stopEntered.promise, 5000, 'legacy exact-stop entered');
      assert.ok(facts && a && b && c);
      const { workHubEvidenceRetirementId } = await import('../server/workhub-evidence-runtime.js');
      const { workHubPeerSettlementId } = await import('@maka/core/workhub-evidence');
      assert.equal(cleanupReleased, false);
      assert.equal(
        recoverySettled,
        false,
        'retirement waits for the exact terminal Root iterator cleanup',
      );
      assert.deepEqual(
        seen,
        ['A'],
        'terminal ledger publication alone does not release the worker slot',
      );
      assert.deepEqual(
        stopCalls,
        [[{ sessionId: aTarget.id, turnId: a.targetTurnId, runId: facts.request.senderRunId }]],
        'no renderer stop source or coordinator actor is invented',
      );
      assert.equal(
        (await stores.sessionStore.readMessagesSnapshot(aTarget.id)).some(
          (row) => row.id === workHubEvidenceRetirementId(facts!.request.id),
        ),
        false,
      );
      const coordinationBefore = await stores.runtimeEventStore.listSessionInvocations(
        WORKHUB_COORDINATION_SESSION_ID,
      );
      cleanupReleased = true;
      cleanup.resolve();
      await withTimeout(recovering, 5000, 'legacy recovery after exact cleanup');
      await withTimeout(bReplyRecorded.promise, 2000, 'B starts after cleanup');
      const marker = (await stores.sessionStore.readMessagesSnapshot(aTarget.id)).find(
        (row) => row.id === workHubEvidenceRetirementId(facts!.request.id),
      );
      assert.ok(marker?.type === 'workhub_evidence_resolution');
      assert.equal(marker.origin, 'legacy_protocol_retirement');
      const closed = (await stores.sessionStore.readMessagesSnapshot(bTarget.id)).find(
        (row) => row.id === workHubPeerSettlementId(facts!.question.id),
      );
      assert.ok(closed?.type === 'workhub_peer_settlement');
      assert.equal(closed.origin, 'legacy_protocol_retirement');
      assert.equal(closed.outcome, 'cancelled');
      const retiredTask = await composition.handlers['workhub.tasks.read'](
        { actionId: a.actionId, delegationId: a.delegationId },
        context,
      );
      assert.ok(retiredTask.ok, JSON.stringify(retiredTask));
      assert.equal(retiredTask.result.task.status, 'cancelled');
      assert.equal(retiredTask.result.task.dependency, undefined);
      assert.deepEqual(seen, ['A', 'B']);
      assert.deepEqual(await stores.sessionStore.listMessageAdmissions(bTarget.id), fifo!);
      assert.deepEqual(
        await stores.sessionStore.listPendingSandboxBoundaryRequests(approvalTarget.id),
        pendingApproval!,
      );
      const bRuns = await stores.runtimeEventStore.listSessionInvocations(bTarget.id);
      const bRun = bRuns.find((run) => run.turnId === b!.targetTurnId);
      assert.ok(bRun);
      const bCall = (
        await stores.runtimeEventStore.readImmutableRuntimeEvents(bTarget.id, bRun.runId)
      ).find(
        (event) => event.content?.kind === 'function_call' && event.content.id === 'old-b-reply',
      );
      assert.ok(bCall?.content?.kind === 'function_call');
      assert.equal(bCall.invocationId, bRun.invocationId);
      assert.deepEqual(bCall.content.args, {
        operation: 'reply',
        requesterSessionId: aTarget.id,
        questionId: facts.question.id,
        answer: 'Late checksum',
      });
      assert.deepEqual(
        await stores.sessionStore.commitWorkHubPeerSettlement({
          type: 'workhub_peer_settlement',
          schemaVersion: 1,
          id: closed.id,
          turnId: bRun.turnId,
          ts: Date.now(),
          requesterSessionId: aTarget.id,
          questionId: facts.question.id,
          actor: legacyTaskRef(b),
          senderRunId: bRun.runId,
          senderInvocationId: bRun.invocationId,
          toolCallId: 'old-b-reply',
          outcome: 'reply',
          answer: 'Late checksum',
        }),
        closed,
        'a delayed old callback cannot replace the Host cancellation',
      );
      for (let retry = 0; retry < 3; retry++) await composition.recover();
      assert.equal(stopCalls.length, 1);
      assert.deepEqual(seen, ['A', 'B'], 'repeated recovery never stops or bypasses B to run C');
      assert.deepEqual(
        await stores.runtimeEventStore.listSessionInvocations(WORKHUB_COORDINATION_SESSION_ID),
        coordinationBefore,
      );
      assert.equal(
        coordinationInputs.length,
        3,
        'only the three explicitly admitted coordinator requests ran',
      );
      assert.equal(
        await stores.agentRunStore.readRootTurnAdmission(
          aTarget.id,
          workHubEvidenceTurnId(facts.request.id),
        ),
        undefined,
      );
      releaseB.resolve();
      await waitFor(async () => seen.includes('C'));
      releaseC.resolve();
      await waitFor(async () => seen.includes('ORDINARY_FOLLOWUP_2'));
      assert.deepEqual(
        seen.filter((value) => value === 'B' || value === 'C'),
        ['B', 'C'],
      );
      assert.deepEqual(
        seen.filter((value) => value.startsWith('ORDINARY_FOLLOWUP_')),
        ['ORDINARY_FOLLOWUP_1', 'ORDINARY_FOLLOWUP_2'],
      );
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(aTarget.id)).length, 1);
      assert.deepEqual(
        await stores.sessionStore.listPendingSandboxBoundaryRequests(approvalTarget.id),
        pendingApproval!,
      );
      for (const [index, target] of targets.entries()) {
        const after = await stores.sessionStore.readHeaderSnapshot(target.id);
        for (const key of ['cwd', 'model', 'permissionMode', 'llmConnectionId'] as const)
          assert.equal(after[key], before[index]![key]);
        assert.deepEqual(await stores.sessionStore.listTaskExecutionGrants(target.id), []);
      }
    } finally {
      peersReady.resolve();
      cleanup.resolve();
      releaseB.resolve();
      releaseC.resolve();
      if (composition && approvalTurn)
        await composition.handlers['turn.stop'](approvalTurn, context);
      await composition?.close();
    }
  });
});

test('cold composition reopen retires explicitly seeded canonical E/F facts once without starting a model or another Turn', {
  timeout: 30000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    let stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const targets = await Promise.all(
      ['cold-a', 'cold-b'].map(async (name) => {
        const cwd = join(root, name);
        await mkdir(cwd);
        return stores.sessionStore.create({
          cwd,
          name,
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
      }),
    );
    const [aTarget, bTarget] = targets;
    assert.ok(aTarget && bTarget);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'legacy-cold-fixture',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const peersReady = deferred<void>();
    let a: LegacyAssigned | undefined, b: LegacyAssigned | undefined;
    let facts: { question: LegacyPeerQuestion; request: LegacyWait } | undefined;
    const first = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            if (this.sessionId === aTarget.id) {
              await peersReady.promise;
              assert.ok(a && b);
              facts = yield* legacyFixtureTrace(stores, input, a, b);
              yield {
                type: 'complete',
                id: randomUUID(),
                turnId: input.turnId,
                ts: Date.now(),
                stopReason: 'dependency_wait',
              };
            } else yield* super.send({ ...input, text: 'Original independent work completed' });
          }
        })(backendContext),
    });
    const { workHubEvidenceRetirementId } = await import('../server/workhub-evidence-runtime.js');
    const { workHubPeerSettlementId } = await import('@maka/core/workhub-evidence');
    let currentOwner = owner;
    let successor: Awaited<ReturnType<typeof createCapturedExecutionComposition>> | undefined;
    try {
      assert.ok((await first.composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      a = await admitLegacyFixtureTask(
        first.composition,
        stores,
        context,
        'cold-old-a',
        aTarget.id,
        'COLD_A',
      );
      b = await admitLegacyFixtureTask(
        first.composition,
        stores,
        context,
        'cold-old-b',
        bTarget.id,
        'COLD_B',
      );
      peersReady.resolve();
      await waitFor(async () => {
        const results = await Promise.all(
          [a!, b!].map((task) =>
            first.composition.handlers['turn.query'](
              { sessionId: task.targetSessionId, turnId: task.targetTurnId },
              context,
            ),
          ),
        );
        return results.every((result) => result.ok && result.result.status === 'completed');
      });
      await waitFor(async () =>
        targets.every((target) => first.manager.runningTurnIds(target.id).length === 0),
      );
      assert.ok(facts);
      const headers = await Promise.all(
        targets.map((target) => stores.sessionStore.readHeaderSnapshot(target.id)),
      );
      const sourceRuns = await Promise.all(
        targets.map((target) => stores.runtimeEventStore.listSessionInvocations(target.id)),
      );
      const coordinationRuns = await stores.runtimeEventStore.listSessionInvocations(
        WORKHUB_COORDINATION_SESSION_ID,
      );
      assert.equal(
        (await stores.sessionStore.readMessagesSnapshot(aTarget.id)).some(
          (row) => row.id === workHubEvidenceRetirementId(facts!.request.id),
        ),
        false,
      );
      await first.composition.close();
      await owner.close();
      for (let restart = 0; restart < 3; restart++) {
        const acquired = await tryAcquireInteractiveRootOwner(
          await resolveStorageRoot({ path: root, kind: 'interactive' }),
        );
        assert.ok(acquired);
        currentOwner = acquired;
        let modelCalls = 0;
        successor = await createCapturedExecutionComposition(currentOwner, {
          primaryBackendFactory: (backendContext) =>
            new (class extends FakeBackend {
              override async *send(_input: BackendSendInput): AsyncIterable<SessionEvent> {
                modelCalls++;
                assert.fail('Retirement cannot call a worker model');
              }
            })(backendContext),
          coordinationBackendFactory: (backendContext) =>
            new (class extends FakeBackend {
              override async *send(_input: BackendSendInput): AsyncIterable<SessionEvent> {
                modelCalls++;
                assert.fail('Retirement cannot call a coordinator model');
              }
            })(backendContext),
        });
        stores = await openInteractiveExecutionStoresForWrite(currentOwner.lease);
        const marker = (await stores.sessionStore.readMessagesSnapshot(aTarget.id)).find(
          (row) => row.id === workHubEvidenceRetirementId(facts!.request.id),
        );
        assert.ok(marker?.type === 'workhub_evidence_resolution');
        assert.equal(marker.origin, 'legacy_protocol_retirement');
        const closed = (await stores.sessionStore.readMessagesSnapshot(bTarget.id)).find(
          (row) => row.id === workHubPeerSettlementId(facts!.question.id),
        );
        assert.ok(closed?.type === 'workhub_peer_settlement');
        assert.equal(closed.origin, 'legacy_protocol_retirement');
        assert.equal(closed.outcome, 'cancelled');
        const retiredTask = await successor.composition.handlers['workhub.tasks.read'](
          { actionId: a.actionId, delegationId: a.delegationId },
          context,
        );
        assert.ok(retiredTask.ok, JSON.stringify(retiredTask));
        assert.equal(retiredTask.result.task.status, 'cancelled');
        assert.equal(retiredTask.result.task.dependency, undefined);
        assert.equal(modelCalls, 0);
        assert.deepEqual(
          await Promise.all(
            targets.map((target) => stores.runtimeEventStore.listSessionInvocations(target.id)),
          ),
          sourceRuns,
        );
        assert.deepEqual(
          await stores.runtimeEventStore.listSessionInvocations(WORKHUB_COORDINATION_SESSION_ID),
          coordinationRuns,
        );
        assert.equal(
          await stores.agentRunStore.readRootTurnAdmission(
            aTarget.id,
            workHubEvidenceTurnId(facts.request.id),
          ),
          undefined,
        );
        for (const [index, target] of targets.entries()) {
          const after = await stores.sessionStore.readHeaderSnapshot(target.id);
          for (const key of ['cwd', 'model', 'permissionMode', 'llmConnectionId'] as const)
            assert.equal(after[key], headers[index]![key]);
          assert.deepEqual(await stores.sessionStore.listTaskExecutionGrants(target.id), []);
        }
        await successor.composition.recover();
        await successor.composition.close();
        successor = undefined;
        await currentOwner.close();
      }
    } finally {
      peersReady.resolve();
      await first.composition.close();
      await successor?.composition.close();
      if (currentOwner !== owner) await currentOwner.close();
    }
  });
});

for (const readMode of ['evidence', 'native-history'] as const)
  test(`production WorkHub continues cold work in a fresh model route without replaying history or steering unrelated work (${readMode})`, {
    timeout: 30000,
  }, async (t) => {
    const sourceCallEntered = deferred<void>(),
      releaseSourceCall = deferred<void>(),
      releaseSource = deferred<void>(),
      releaseB = deferred<void>();
    // Deliberately extreme stored output, not a context-switch threshold.
    const cold = 'SELECTED_OLD_EVIDENCE\n' + 'x'.repeat(900000) + 'COLD_FAR_SENTINEL';
    const requests: Array<{ model: string; url: string; body: string; coordinator: boolean }> = [];
    const reads: Array<{
      taskId: string;
      view: string;
      sourceActionId?: string;
      kinds?: string[];
      cursor?: string;
    }> = [];
    let readDiscoveries = 0;
    const errors: unknown[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        const input = JSON.parse(body) as {
          model: string;
          tools?: {
            function: {
              name: string;
              parameters: { type?: string; oneOf?: unknown; anyOf?: unknown };
            };
          }[];
          messages: { role: string; content: unknown }[];
        };
        for (const tool of input.tools ?? []) {
          assert.ok(
            !['WorkHubEvidence', 'WorkHubResult', 'WorkHubInspect'].includes(tool.function.name),
            'retired E/F producers and old read surfaces are not published',
          );
          if (tool.function.name !== 'WorkHubRead') continue;
          assert.equal(tool.function.parameters.type, 'object');
          assert.equal(tool.function.parameters.oneOf, undefined);
          assert.equal(tool.function.parameters.anyOf, undefined);
        }
        const coordinator = input.messages.some(
          (message) =>
            message.role === 'system' &&
            JSON.stringify(message.content).includes(
              'the WorkHub assistant for this Desktop window',
            ),
        );
        requests.push({ model: input.model, url: request.url ?? '', body, coordinator });
        const users = JSON.stringify(input.messages.filter((message) => message.role === 'user'));
        const chunk = (delta: unknown, finish: string | null) =>
          'data: ' +
          JSON.stringify({
            id: 'fresh-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish
              ? {
                  usage: {
                    prompt_tokens: input.model === 'new-model' ? 600 : 900000,
                    completion_tokens: 20,
                    total_tokens: input.model === 'new-model' ? 620 : 900020,
                  },
                }
              : {}),
          }) +
          '\n\n';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (coordinator) {
          response.write(
            chunk({ role: 'assistant', content: 'Admitting the requested work.' }, null),
          );
          await new Promise<void>((resolve) => response.on('close', resolve));
          return;
        }
        if (
          input.model === 'fake-model' &&
          users.includes('OLD_LONG_SOURCE') &&
          !users.includes('REUSE_CHECK') &&
          !users.includes('OLD_B_HOLD') &&
          !input.messages.some(
            (message) =>
              message.role === 'tool' &&
              JSON.stringify(message.content).includes('OWNED_TOOL_EVIDENCE'),
          )
        ) {
          sourceCallEntered.resolve();
          await releaseSourceCall.promise;
          const visible = input.tools?.some((tool) => tool.function.name === 'Bash');
          response.write(
            chunk(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: visible ? 'owned-source-tool' : 'discover-source-tool',
                    type: 'function',
                    function: {
                      name: visible ? 'Bash' : 'tool_search',
                      arguments: JSON.stringify(
                        visible
                          ? { command: "printf 'OWNED_TOOL_EVIDENCE\\n'", timeout_ms: 5000 }
                          : { query: 'Bash' },
                      ),
                    },
                  },
                ],
              },
              null,
            ),
          );
          response.write(chunk({}, 'tool_calls'));
          response.end('data: [DONE]\n\n');
          return;
        }
        const hasReply = input.messages.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('SELECTED_OLD_EVIDENCE'),
        );
        const historyPages = input.messages
          .filter((message) => message.role === 'tool')
          .flatMap((message) => {
            try {
              const value = JSON.parse(String(message.content)) as {
                history?: { records: { kind: string; isError?: boolean; text?: string }[] };
                nextCursor?: string | null;
              };
              return value.history ? [value] : [];
            } catch {
              return [];
            }
          });
        const records = historyPages.flatMap((page) => page.history!.records);
        const hasHistory =
          records.some(
            (record) =>
              record.kind === 'tool_result' &&
              record.isError === false &&
              record.text?.includes('OWNED_TOOL_EVIDENCE'),
          ) &&
          records.some(
            (record) => record.kind === 'user' && record.text === 'RAW_OLD_CORRECTION_KEEP_BIGINT',
          );
        if (
          !coordinator &&
          input.model === 'new-model' &&
          users.includes('FRESH_CONTINUE') &&
          (!hasHistory || (readMode === 'evidence' && !hasReply))
        ) {
          const name = 'WorkHubRead';
          const visible = input.tools?.some((tool) => tool.function.name === name);
          const cursor = historyPages.at(-1)?.nextCursor;
          if (visible && (readMode !== 'evidence' || hasReply) && historyPages.length)
            assert.equal(
              typeof cursor,
              'string',
              'follow the top-level cursor until the source facts are read',
            );
          const args =
            readMode === 'evidence' && !hasReply
              ? { taskId: 'source-a', view: 'reply', sourceActionId: 'source-a' }
              : {
                  taskId: 'source-a',
                  view: 'history',
                  kinds: ['user', 'tool_call', 'tool_result'],
                  ...(cursor ? { cursor } : {}),
                };
          if (visible) reads.push(args);
          else readDiscoveries++;
          const tool = visible ? { name, args } : { name: 'tool_search', args: { query: name } };
          response.write(
            chunk(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: visible
                      ? 'read-task-' + args.view + '-' + reads.length
                      : 'discover-evidence-' + readDiscoveries,
                    type: 'function',
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              },
              null,
            ),
          );
          response.write(chunk({}, 'tool_calls'));
        } else {
          let text = 'Result noted.';
          if (!coordinator && input.model === 'new-model' && users.includes('FRESH_CONTINUE'))
            text = 'Selected historical evidence was read without restarting its source.';
          else if (!coordinator && users.includes('INDEPENDENT_C'))
            text = 'C finished independently.';
          else if (!coordinator && users.includes('OLD_B_HOLD')) {
            await releaseB.promise;
            text = 'UNRELATED_B_SECRET';
          } else if (!coordinator && users.includes('REUSE_CHECK'))
            text = 'SELECTED_OLD_EVIDENCE: The original route was reused.';
          else if (!coordinator) {
            await releaseSource.promise;
            text = cold;
          }
          response.write(chunk({ role: 'assistant', content: text }, null));
          response.write(chunk({}, 'stop'));
        }
        response.end('data: [DONE]\n\n');
      })().catch((error) => {
        errors.push(error);
        response.destroy(error as Error);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          releaseSourceCall.resolve();
          releaseSource.resolve();
          releaseB.resolve();
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await withCompositionRoot(async ({ owner }) => {
      const originalId = await configureFakeDefaultTarget(
        owner,
        ['fake-model'],
        `http://127.0.0.1:${address.port}/old/v1`,
      );
      const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const snapshot = await policy.connectionCatalog.getSnapshot();
      const created = await policy.connectionCatalog.create({
        expectedCatalogRevision: snapshot.revision,
        connection: {
          slug: 'fresh',
          name: 'Fresh route',
          providerType: 'ollama',
          baseUrl: `http://127.0.0.1:${address.port}/fresh/v1`,
          enabled: true,
          enabledModelIds: ['new-model'],
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') return;
      const newId = created.snapshot.connections.find(
        (connection) => connection.slug === 'fresh',
      )!.connectionId;
      const fetching = await policy.operations.beginModelFetch(newId);
      assert.equal(fetching.kind, 'ready');
      if (fetching.kind !== 'ready') return;
      assert.equal(
        (
          await policy.operations.completeModelFetch(fetching.ticket, {
            models: [{ id: 'new-model', contextWindow: 128000 }],
            source: 'fetched',
            fetchedAt: Date.now(),
          })
        ).kind,
        'committed',
      );
      let activeOwner = owner;
      const residencies = new HostResidencyRegistry();
      const hostedRoots = () =>
        residencies.snapshot().find(({ label }) => label === 'hosted-execution')?.count ?? 0;
      let composition = await createExecutionRuntimeHostComposition({
        ...compositionContext(activeOwner),
        acquireResidency: (label, kind) => residencies.acquire(label, kind),
      });
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'fresh-client',
        principal: 'local_os_user',
        acquireResidency: () => residencies.acquire('hosted-execution'),
      };
      const attach = () =>
        composition.clientCapabilities!.attachConnection(
          clientCapabilityConnectionIdentity(context.connectionId),
          { send: async () => {} },
        );
      let desktop = attach();
      let stores = await openInteractiveExecutionStoresForWrite(activeOwner.lease);
      const register = async () => {
        assert.ok(
          (
            await composition.handlers['client.capability.replace'](
              { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
              context,
            )
          ).ok,
        );
      };
      const wait = (predicate: () => Promise<boolean>) =>
        waitFor(async () => {
          assert.deepEqual(errors, []);
          return predicate();
        }, 10000);
      const done = async (sessionId: string, turnId: string) => {
        const result = await composition.handlers['turn.query']({ sessionId, turnId }, context);
        return result.ok && result.result.status === 'completed';
      };
      const continueTask = (actionId: string, text: string, container: 'reuse' | 'fresh') =>
        composition.handlers['workhub.tasks.continue'](
          { turnId: 'fresh-authority', actionId, taskId: 'source-a', text, container },
          context,
        );
      const inputReceipt = async (inputId: string) => {
        const result = await composition.handlers['workhub.tasks.input.read'](
          { workId: 'source-a', inputId },
          context,
        );
        assert.ok(result.ok, JSON.stringify(result));
        return result.result;
      };
      const newTaskDefaults = {
        model: { llmConnectionId: originalId, llmConnectionSlug: 'fake', model: 'fake-model' },
        permissionMode: 'bypass' as const,
      };
      const failures: unknown[] = [];
      try {
        await composition.recover();
        await register();
        await setWorkHubConcurrency(composition, context, 1);
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        assert.ok(
          (
            await composition.handlers['workhub.coordination.answer'](
              {
                turnId: 'fresh-authority',
                text: 'ORIGINAL_USER_GOAL: Complete OLD_LONG_SOURCE, reuse then fresh for related work, and admit independent B and C without mixing their requirements.',
              },
              context,
            )
          ).ok,
        );
        const original = await composition.handlers['workhub.tasks.start'](
          {
            turnId: 'fresh-authority',
            actionId: 'source-a',
            title: 'Same title',
            text: 'OLD_LONG_SOURCE',
            create: { workspace: { kind: 'isolated' } },
            newWorkDefaults: newTaskDefaults,
          },
          context,
        );
        assert.ok(original.ok, JSON.stringify(original));
        const a = await stores.sessionStore.readWorkHubAssignment('source-a');
        assert.ok(a);
        await withTimeout(sourceCallEntered.promise, 10000, 'source model call entered');
        await wait(async () => requests.filter((request) => request.coordinator).length === 1);
        // Result reconciliation may briefly hold its own hosted-execution lease.
        await wait(async () => hostedRoots() === 2);
        assert.equal(hostedRoots(), 2, 'the held coordinator and source each own a live root');
        const beforeBlocked = (await stores.sessionStore.listHeaders()).map(({ id }) => id).sort();
        const beforeBlockedRequests = requests.length;
        const blocked = await continueTask('busy-fresh-a', 'FRESH_CONTINUE', 'fresh');
        assert.ok(!blocked.ok && blocked.error.code === 'session_busy', JSON.stringify(blocked));
        assert.equal(await stores.sessionStore.readWorkHubAssignment('busy-fresh-a'), undefined);
        assert.deepEqual(
          (await stores.sessionStore.listHeaders()).map(({ id }) => id).sort(),
          beforeBlocked,
          'busy fresh rejection creates no container',
        );
        assert.equal(requests.length, beforeBlockedRequests, 'busy fresh admits no provider call');
        assert.deepEqual(await stores.sessionStore.listMessageAdmissions(a.targetSessionId), []);
        const correction = await composition.handlers['workhub.tasks.send'](
          {
            inputId: 'raw-source-correction',
            workId: 'source-a',
            generationId: 'source-a',
            text: 'RAW_OLD_CORRECTION_KEEP_BIGINT',
          },
          context,
        );
        assert.ok(correction.ok, JSON.stringify(correction));
        assert.equal(correction.result.mode, 'steering');
        releaseSourceCall.resolve();
        await wait(
          async () => (await inputReceipt('raw-source-correction')).delivery === 'delivered',
        );
        releaseSource.resolve();
        // A canonical terminal event precedes Host transition/resource cleanup.
        // Wait for the worker's real residency release; the coordinator stays
        // deliberately held open. Never retry the continuation command itself.
        await wait(
          async () => (await done(a.targetSessionId, a.targetTurnId)) && hostedRoots() === 1,
        );
        const reused = await continueTask('reuse-a', 'REUSE_CHECK', 'reuse');
        assert.ok(reused.ok, JSON.stringify(reused));
        assert.equal(reused.result.container, 'reuse');
        assert.ok(reused.result.container === 'reuse');
        assert.equal(reused.result.input.targetSessionId, a.targetSessionId);
        await wait(async () => (await inputReceipt('reuse-a')).delivery === 'delivered');
        const reuse = await inputReceipt('reuse-a');
        assert.ok(reuse.execution);
        const reuseAssignment = await stores.sessionStore.readWorkHubAssignmentByMessage(
          reuse.targetMessageId,
        );
        assert.ok(reuseAssignment, 'native reuse commits its own canonical assignment');
        assert.equal(reuseAssignment.work?.id, 'source-a');
        assert.equal(reuseAssignment.work?.generationId, 'source-a');
        assert.equal(reuseAssignment.work?.continuesActionId, 'source-a');
        assert.equal(reuseAssignment.targetSessionId, a.targetSessionId);
        await wait(
          async () =>
            (await done(a.targetSessionId, reuse.execution!.turnId)) && hostedRoots() === 1,
        );
        await wait(async () => {
          if (
            !requests.some(
              (request) => !request.coordinator && request.body.includes('REUSE_CHECK'),
            )
          )
            return false;
          const catalog = await composition.handlers['session.catalog.query'](
            { kind: 'get', sessionId: a.targetSessionId },
            context,
          );
          return (
            catalog.ok &&
            catalog.result.kind === 'session' &&
            catalog.result.session !== null &&
            !('kind' in catalog.result.session) &&
            catalog.result.session.liveRunState?.runningTurnIds.length === 0
          );
        });
        const oldHeader = await stores.sessionStore.readHeaderSnapshot(a.targetSessionId);
        const oldTasks = await composition.handlers['workhub.tasks.find']({}, context);
        assert.ok(oldTasks.ok, JSON.stringify(oldTasks));
        const oldObservation = oldTasks.result.items.find(
          (task) => task.kind === 'task' && task.id === 'source-a',
        )?.context;
        assert.equal(oldObservation?.configuredInputLimit, null);
        assert.equal(oldObservation?.lastRequest.status, 'observed');
        assert.ok(oldObservation?.lastRequest.status === 'observed');
        assert.equal(oldObservation.lastRequest.inputTokens, 900000);
        assert.equal(oldObservation.lastRequest.matchesCurrentRoute, true);
        const aRuns = await stores.runtimeEventStore.listSessionInvocations(a.targetSessionId);
        assert.equal(aRuns.length, 2);
        // An explicit user edit to the current idle segment wins over both its
        // creation settings and any current WorkHub new-task defaults.
        const sourceConfiguration = await stores.sessionStore.readHeaderRecordSnapshot(
          a.targetSessionId,
        );
        const changedSource = await composition.handlers['session.configuration.update'](
          {
            sessionId: a.targetSessionId,
            expectedRevision: sourceConfiguration.revision,
            patch: {
              modelTarget: {
                kind: 'explicit',
                connectionId: newId,
                connectionSlug: 'fresh',
                model: 'new-model',
              },
              permissionMode: 'ask',
            },
          },
          context,
        );
        assert.ok(
          changedSource.ok && changedSource.result.kind === 'committed',
          JSON.stringify(changedSource),
        );
        const bResult = await composition.handlers['workhub.tasks.start'](
          {
            turnId: 'fresh-authority',
            actionId: 'independent-b',
            title: 'Independent same-Session task B',
            text: 'OLD_B_HOLD',
            sessionRef: a.targetSessionId,
          },
          context,
        );
        assert.ok(bResult.ok, JSON.stringify(bResult));
        await wait(async () =>
          requests.some((request) => !request.coordinator && request.body.includes('OLD_B_HOLD')),
        );
        // B's first request is a same-Session barrier after A's durable terminal cleanup.
        const sourceEvents = await Promise.all(
          aRuns.map((run) =>
            stores.runtimeEventStore.readImmutableRuntimeEvents(a.targetSessionId, run.runId),
          ),
        );
        const fresh = await continueTask('fresh-a', 'FRESH_CONTINUE', 'fresh');
        assert.ok(fresh.ok, JSON.stringify(fresh));
        assert.equal(fresh.result.container, 'fresh');
        assert.ok(fresh.result.container === 'fresh');
        assert.equal(fresh.result.action.disposition, 'create_new');
        assert.equal(fresh.result.action.workId, 'source-a');
        const current = await stores.sessionStore.readWorkHubAssignment('fresh-a');
        assert.ok(current);
        assert.equal(current.settings?.basis, 'current_segment');
        assert.equal(current.settings?.sessionId, a.targetSessionId);
        assert.equal(current.settings?.model, 'new-model');
        assert.equal(current.settings?.permissionMode, 'ask');
        assert.notEqual(current.settings?.model, newTaskDefaults.model.model);
        assert.notEqual(current.settings?.permissionMode, newTaskDefaults.permissionMode);
        assert.equal(a.settings?.permissionMode, 'bypass');
        assert.notEqual(current.targetSessionId, a.targetSessionId);
        assert.deepEqual(
          current.work && {
            id: current.work.id,
            generationId: current.work.generationId,
            continuesActionId: current.work.continuesActionId,
          },
          {
            id: 'source-a',
            generationId: 'fresh-a',
            continuesActionId: reuseAssignment.actionId,
          },
        );
        assert.equal(
          (await stores.sessionStore.readHeaderSnapshot(current.targetSessionId)).cwd,
          oldHeader.cwd,
        );
        assert.equal(
          (await stores.sessionStore.readHeaderSnapshot(current.targetSessionId)).model,
          'new-model',
        );
        assert.equal(
          (await stores.sessionStore.readHeaderSnapshot(current.targetSessionId)).permissionMode,
          'ask',
        );
        assert.equal(
          requests.filter(
            (request) => request.model === 'new-model' && request.body.includes('FRESH_CONTINUE'),
          ).length,
          0,
          'one worker slot keeps fresh A behind unrelated B',
        );
        const replay = await continueTask('fresh-a', 'FRESH_CONTINUE', 'fresh');
        assert.deepEqual(replay, fresh);
        const stale = await composition.handlers['workhub.tasks.send'](
          {
            inputId: 'stale-old-input',
            workId: 'source-a',
            generationId: 'source-a',
            text: 'DO_NOT_STEER_B',
          },
          context,
        );
        assert.ok(!stale.ok && stale.error.code === 'operation_conflict', JSON.stringify(stale));
        assert.equal(await stores.sessionStore.readWorkHubTaskInput('stale-old-input'), undefined);
        const supplement = await composition.handlers['workhub.tasks.send'](
          {
            inputId: 'fresh-supplement',
            workId: 'source-a',
            generationId: 'fresh-a',
            text: 'QUEUED_FRESH_CORRECTION',
          },
          context,
        );
        assert.ok(supplement.ok, JSON.stringify(supplement));
        assert.equal(
          supplement.result.mode,
          'steering',
          'the admitted root waits for a worker slot and accepts same-work steering',
        );
        assert.equal(
          (await inputReceipt('fresh-supplement')).delivery,
          'queued',
          'acceptance is not immutable consumption while the worker slot is held by B',
        );
        assert.equal(
          requests.filter(
            (request) => request.model === 'new-model' && request.body.includes('FRESH_CONTINUE'),
          ).length,
          0,
          'accepting a correction does not bypass the worker queue',
        );
        const cResult = await composition.handlers['workhub.tasks.start'](
          {
            turnId: 'fresh-authority',
            actionId: 'independent-c',
            title: 'Same title',
            text: 'INDEPENDENT_C',
            create: { workspace: { kind: 'isolated' } },
            newWorkDefaults: { ...newTaskDefaults, permissionMode: 'ask' },
          },
          context,
        );
        assert.ok(cResult.ok, JSON.stringify(cResult));
        const c = await stores.sessionStore.readWorkHubAssignment('independent-c');
        assert.ok(c);
        const b = await stores.sessionStore.readWorkHubAssignment('independent-b');
        assert.ok(b);
        const runningB = await composition.handlers['turn.query'](
          { sessionId: b.targetSessionId, turnId: b.targetTurnId },
          context,
        );
        assert.ok(runningB.ok, JSON.stringify(runningB));
        assert.equal(runningB.result.status, 'running');
        assert.ok(!requests.some((request) => request.body.includes('DO_NOT_STEER_B')));
        releaseB.resolve();
        await wait(async () => (await inputReceipt('fresh-supplement')).delivery === 'delivered');
        const consumed = await inputReceipt('fresh-supplement');
        assert.equal(consumed.targetSessionId, current.targetSessionId);
        assert.equal(consumed.execution?.turnId, current.targetTurnId);
        await wait(() => done(current.targetSessionId, current.targetTurnId));
        await wait(() => done(c.targetSessionId, c.targetTurnId));
        const freshRequests = requests.filter(
          (request) => request.model === 'new-model' && request.body.includes('FRESH_CONTINUE'),
        );
        assert.deepEqual(
          reads.filter((read) => read.view === 'reply'),
          readMode === 'evidence'
            ? [{ taskId: 'source-a', view: 'reply', sourceActionId: 'source-a' }]
            : [],
          'the optional reply read is explicitly pinned to the old source',
        );
        const historyReads = reads.filter((read) => read.view === 'history');
        assert.ok(historyReads.length > 0);
        assert.equal(historyReads[0]!.cursor, undefined);
        for (const { cursor: _cursor, ...scope } of historyReads)
          assert.deepEqual(scope, {
            taskId: 'source-a',
            view: 'history',
            kinds: ['user', 'tool_call', 'tool_result'],
          });
        assert.equal(reads.length, historyReads.length + (readMode === 'evidence' ? 1 : 0));
        assert.ok(readDiscoveries <= 1);
        assert.equal(
          freshRequests.length,
          reads.length + readDiscoveries + 1,
          'fresh makes only read/discovery steps and one final response, never a summary call',
        );
        const freshFinal = freshRequests.at(-1)!;
        assert.equal(
          requests.filter((request) => !request.coordinator && request.model === 'new-model')
            .length,
          freshRequests.length + 1,
          'the new route sees only independent B and fresh A, not an auxiliary summary request',
        );
        const freshStart = JSON.parse(freshRequests[0]!.body) as {
          messages: { role: string; content: unknown }[];
        };
        const freshUserText = freshStart.messages
          .filter((message) => message.role === 'user')
          .map((message) =>
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          )
          .join('\n');
        assert.match(freshUserText, /Use WorkHubRead with taskId and view=history/u);
        assert.ok(freshUserText.includes('"taskId":"source-a"'));
        assert.ok(freshUserText.includes('ORIGINAL_USER_GOAL'));
        assert.ok(freshUserText.includes('RAW_OLD_CORRECTION_KEEP_BIGINT'));
        assert.doesNotMatch(freshUserText, /Use WorkHubEvidence read/u);
        assert.match(freshUserText, /Follow nextCursor without changing taskId, view or kinds/u);
        assert.doesNotMatch(freshUserText, /history\.nextCursor/u);
        assert.ok(
          freshRequests.every(
            (request) =>
              request.url.startsWith('/fresh/') &&
              !request.body.includes('COLD_FAR_SENTINEL') &&
              !request.body.includes('UNRELATED_B_SECRET') &&
              !request.body.includes('OLD_B_HOLD') &&
              Buffer.byteLength(request.body) < Buffer.byteLength(cold) / 2,
          ),
        );
        assert.ok(freshRequests[0]!.body.includes('QUEUED_FRESH_CORRECTION'));
        assert.ok(freshFinal.body.includes('RAW_OLD_CORRECTION_KEEP_BIGINT'));
        const finalRequest = JSON.parse(freshFinal.body) as {
          messages: { role: string; content: string }[];
        };
        const historyPages = finalRequest.messages
          .filter((message) => message.role === 'tool')
          .map((message) => {
            try {
              return JSON.parse(message.content) as {
                history?: { records: { kind: string; isError?: boolean; text?: string }[] };
                nextCursor?: string | null;
              };
            } catch {
              return {};
            }
          })
          .filter((message) => message.history);
        assert.equal(historyPages.length, historyReads.length);
        for (let page = 1; page < historyReads.length; page++)
          assert.equal(historyReads[page]!.cursor, historyPages[page - 1]!.nextCursor);
        const historyRecords = historyPages.flatMap((page) => page.history!.records);
        const kinds = historyRecords.map((record) => record.kind);
        assert.ok(kinds.includes('user'));
        assert.ok(kinds.includes('tool_call'));
        assert.ok(kinds.includes('tool_result'));
        assert.ok(
          historyRecords.some(
            (record) => record.kind === 'user' && record.text === 'RAW_OLD_CORRECTION_KEEP_BIGINT',
          ),
        );
        assert.ok(
          historyRecords
            .filter((record) => record.kind === 'tool_result')
            .every((record) => record.isError === false),
        );
        assert.ok(
          historyRecords.some(
            (record) =>
              record.kind === 'tool_result' &&
              record.isError === false &&
              record.text?.includes('OWNED_TOOL_EVIDENCE'),
          ),
        );
        if (readMode === 'evidence') {
          assert.ok(freshFinal.body.includes('SELECTED_OLD_EVIDENCE'));
          assert.ok(freshFinal.body.includes('historical'));
        }
        const oldRequests = requests.filter(
          (request) => !request.coordinator && request.model === 'fake-model',
        );
        const reuseRequest = oldRequests.find((request) => request.body.includes('REUSE_CHECK'));
        assert.ok(reuseRequest);
        assert.ok(reuseRequest.url.startsWith('/old/'));
        assert.ok(reuseRequest.body.includes('COLD_FAR_SENTINEL'));
        assert.equal(
          requests.filter(
            (request) =>
              !request.coordinator &&
              request.body.includes('OLD_B_HOLD') &&
              !request.body.includes('FRESH_CONTINUE'),
          ).length,
          1,
          'stale correction never reaches B',
        );
        assert.ok(
          requests.findIndex(
            (request) => !request.coordinator && request.body.includes('INDEPENDENT_C'),
          ) > requests.indexOf(freshFinal),
          'independent C keeps FIFO after fresh A',
        );
        assert.equal(
          requests.filter((request) => request.coordinator).length,
          1,
          'direct input does not wake a busy coordinator',
        );
        const observedTasks = await composition.handlers['workhub.tasks.find']({}, context);
        assert.ok(observedTasks.ok, JSON.stringify(observedTasks));
        assert.deepEqual(
          HOST_OPERATION_SPECS['workhub.tasks.find'].decodeOutput(observedTasks.result),
          observedTasks.result,
        );
        const freshObservation = observedTasks.result.items.find(
          (task) => task.kind === 'task' && task.id === 'source-a',
        )?.context;
        assert.equal(freshObservation?.configuredInputLimit, 128000);
        assert.equal(freshObservation?.lastRequest.status, 'observed');
        assert.ok(freshObservation?.lastRequest.status === 'observed');
        assert.equal(
          freshObservation.lastRequest.inputTokens,
          600,
          'last provider request, not an aggregate across discovery and read steps',
        );
        assert.equal(freshObservation.lastRequest.connectionId, newId);
        assert.equal(freshObservation.lastRequest.modelId, 'new-model');
        assert.equal(freshObservation.lastRequest.matchesCurrentRoute, true);
        const freshDetail = await composition.handlers['workhub.tasks.read'](
          { workId: 'source-a' },
          context,
        );
        assert.ok(freshDetail.ok, JSON.stringify(freshDetail));
        assert.equal(freshDetail.result.task.actionId, current.actionId);
        assert.equal(freshDetail.result.task.targetSessionId, current.targetSessionId);
        assert.equal(freshDetail.result.task.status, 'pending_acceptance');
        assert.deepEqual(
          await stores.sessionStore.listTaskExecutionGrants(current.targetSessionId),
          [],
        );
        assert.equal(
          (await stores.runtimeEventStore.listSessionInvocations(a.targetSessionId)).length,
          3,
          'A is not woken for historical evidence',
        );
        const afterSourceEvents = await Promise.all(
          aRuns.map((run) =>
            stores.runtimeEventStore.readImmutableRuntimeEvents(a.targetSessionId, run.runId),
          ),
        );
        assert.deepEqual(afterSourceEvents, sourceEvents);
        const unchanged = await stores.sessionStore.readHeaderSnapshot(a.targetSessionId);
        assert.equal(unchanged.model, 'new-model');
        assert.equal(unchanged.permissionMode, 'ask');
        assert.equal(unchanged.cwd, oldHeader.cwd);
        assert.deepEqual(await continueTask('fresh-a', 'FRESH_CONTINUE', 'fresh'), fresh);
        const conflict = await continueTask('fresh-a', 'CHANGED_COMMITTED_INPUT', 'fresh');
        assert.ok(
          !conflict.ok && conflict.error.code === 'operation_conflict',
          JSON.stringify(conflict),
        );
        const coordinator = await composition.handlers['turn.query'](
          { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'fresh-authority' },
          context,
        );
        assert.ok(coordinator.ok);
        assert.ok(
          (
            await composition.handlers['turn.stop'](
              {
                sessionId: WORKHUB_COORDINATION_SESSION_ID,
                turnId: 'fresh-authority',
                runId: coordinator.result.runId,
              },
              context,
            )
          ).ok,
        );
        await desktop.close();
        await composition.close();
        await activeOwner.close();
        const reopened = await tryAcquireInteractiveRootOwner(owner.capability);
        assert.ok(reopened);
        activeOwner = reopened;
        composition = await createExecutionRuntimeHostComposition(compositionContext(activeOwner));
        desktop = attach();
        stores = await openInteractiveExecutionStoresForWrite(activeOwner.lease);
        await composition.recover();
        await register();
        // No stale model-caller authority is reconstructed after restart. Native
        // readonly APIs reconcile the current task, saved inputs and old segment.
        const found = await composition.handlers['workhub.tasks.find']({}, context);
        assert.ok(found.ok, JSON.stringify(found));
        const foundTask = found.result.items.find(
          (task) => task.kind === 'task' && task.id === 'source-a',
        );
        assert.ok(foundTask?.available);
        assert.equal(foundTask.state, 'ended');
        assert.equal(foundTask.segments, 2);
        const reopenedDetail = await composition.handlers['workhub.tasks.read'](
          { workId: 'source-a' },
          context,
        );
        assert.ok(reopenedDetail.ok, JSON.stringify(reopenedDetail));
        assert.equal(reopenedDetail.result.task.actionId, current.actionId);
        assert.equal(reopenedDetail.result.task.targetSessionId, current.targetSessionId);
        assert.equal(reopenedDetail.result.task.status, 'pending_acceptance');
        const history = await composition.handlers['workhub.tasks.history'](
          { workId: 'source-a', actionId: 'source-a' },
          context,
        );
        assert.ok(history.ok);
        assert.equal(history.result.assignments[0]!.superseded, true);
        assert.equal(history.result.assignments[0]!.targetSessionId, a.targetSessionId);
        assert.deepEqual(await inputReceipt('fresh-supplement'), consumed);
        assert.deepEqual(
          await Promise.all(
            aRuns.map((run) =>
              stores.runtimeEventStore.readImmutableRuntimeEvents(a.targetSessionId, run.runId),
            ),
          ),
          sourceEvents,
        );
        assert.equal(
          (await stores.runtimeEventStore.listSessionInvocations(a.targetSessionId)).length,
          3,
        );
        t.diagnostic(
          JSON.stringify({
            measurement: 'local HTTP fixture, not real-provider context/cost proof',
            coldSourceBytes: Buffer.byteLength(cold),
            freshRequestBytes: freshRequests.map((request) => Buffer.byteLength(request.body)),
            originalRoute: '/old/fake-model',
            freshRoute: '/fresh/new-model',
            oldSourceInvocations: 3,
            fullSourceRunsUnchanged: true,
            FIFO: 'B -> fresh A -> independent C',
          }),
        );
      } catch (error) {
        t.diagnostic(
          JSON.stringify({
            fixtureRequests: requests.map((request) => {
              const input = JSON.parse(request.body) as {
                tools?: { function: { name: string } }[];
                messages: { role: string; content: unknown }[];
              };
              return {
                model: request.model,
                url: request.url,
                coordinator: request.coordinator,
                tools: input.tools?.map((tool) => tool.function.name),
                users: input.messages
                  .filter((message) => message.role === 'user')
                  .map((message) => JSON.stringify(message.content).slice(0, 180)),
              };
            }),
          }),
        );
        failures.push(error);
      } finally {
        releaseSourceCall.resolve();
        releaseSource.resolve();
        releaseB.resolve();
        server.closeAllConnections();
        for (const close of [
          () => desktop.close(),
          () => composition.close(),
          ...(activeOwner !== owner ? [() => activeOwner.close()] : []),
        ]) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(failures, 'Fresh continuation verification/cleanup failed');
      }
    });
  });

test('production WorkHub keeps full task output out of automatic requests after restart', async (t) => {
  const releaseWorker = deferred<void>();
  const sourceText = 'SHORT_HANDOFF ' + '中文😀\\\n"证据'.repeat(10000) + 'FULL_RESULT_TAIL';
  const requests: Array<{
    coordinator: boolean;
    rawBytes: number;
    messages: unknown[];
    tools: unknown;
    observedAt: number;
    firstResponseMs?: number;
  }> = [];
  let dispatchStartedAt = 0;
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const input = JSON.parse(raw) as {
        model: string;
        tools?: { function: { name: string } }[];
        messages: { role: string; content: unknown }[];
      };
      const coordinator = isWorkHubCoordinatorFixtureRequest(input);
      const latestUser = input.messages
        .filter((message) => message.role === 'user')
        .at(-1)?.content;
      const observedAt = performance.now();
      const captured: (typeof requests)[number] = {
        coordinator,
        rawBytes: Buffer.byteLength(raw),
        messages: input.messages,
        tools: input.tools,
        observedAt,
      };
      requests.push(captured);
      const chunk = (content: string, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: `context-${requests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [
            {
              index: 0,
              delta: finish ? {} : { role: 'assistant', content },
              finish_reason: finish,
            },
          ],
          ...(finish
            ? {
                usage: {
                  prompt_tokens: 900,
                  completion_tokens: 20,
                  total_tokens: 920,
                  prompt_tokens_details: { cached_tokens: 400 },
                },
              }
            : {}),
        }) +
        '\n\n';
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (coordinator && latestUser === 'Authorize compact-context task.') {
        response.write(chunk('Admitting the requested task.', null));
        await new Promise<void>((resolve) => response.on('close', resolve));
        return;
      }
      if (!coordinator) await releaseWorker.promise;
      captured.firstResponseMs = performance.now() - observedAt;
      response.write(
        chunk(
          coordinator ? 'The task result is available in its execution view.' : sourceText,
          null,
        ),
      );
      response.write(chunk('', 'stop'));
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      errors.push(error);
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        releaseWorker.resolve();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await withCompositionRoot(async ({ owner }) => {
    const connectionId = await configureFakeDefaultTarget(
      owner,
      ['fake-model'],
      `http://127.0.0.1:${address.port}/v1`,
    );
    let activeOwner = owner;
    let composition = await createExecutionRuntimeHostComposition(compositionContext(activeOwner));
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'compact-context-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const attach = () =>
      composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
    let desktop = attach();
    const register = async () => {
      assert.ok(
        (
          await composition.handlers['client.capability.replace'](
            { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
            context,
          )
        ).ok,
      );
    };
    let stores = await openInteractiveExecutionStoresForWrite(activeOwner.lease);
    const completed = async (sessionId: string, turnId: string) => {
      const state = await composition.handlers['turn.query']({ sessionId, turnId }, context);
      return state.ok && state.result.status === 'completed';
    };
    try {
      await composition.recover();
      await register();
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      const turnId = 'compact-context-authority';
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            { turnId, text: 'Authorize compact-context task.' },
            context,
          )
        ).ok,
      );
      dispatchStartedAt = performance.now();
      const assigned = await composition.handlers['workhub.tasks.start'](
        {
          turnId,
          actionId: 'compact-context-worker',
          text: 'Produce the fixture evidence.',
          title: 'Context source',
          create: { workspace: { kind: 'isolated' } },
          newWorkDefaults: {
            permissionMode: 'ask',
            model: {
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
            },
          },
        },
        context,
      );
      assert.ok(assigned.ok, JSON.stringify(assigned));
      const source = await stores.sessionStore.readWorkHubAssignment('compact-context-worker');
      assert.ok(source);
      const initial = await composition.handlers['turn.query'](
        { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId },
        context,
      );
      assert.ok(initial.ok);
      assert.ok(
        (
          await composition.handlers['turn.stop'](
            { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId, runId: initial.result.runId },
            context,
          )
        ).ok,
      );
      releaseWorker.resolve();
      await waitFor(() => completed(source.targetSessionId, source.targetTurnId), 10000);
      let notification: Extract<StoredMessage, { type: 'user' }> | undefined;
      await waitFor(async () => {
        notification = (
          await readLedgerMessages(stores.runtimeEventStore, WORKHUB_COORDINATION_SESSION_ID)
        ).find(
          (message): message is Extract<StoredMessage, { type: 'user' }> =>
            message.type === 'user' && message.origin?.kind === 'workhub_result',
        );
        return !!notification && completed(WORKHUB_COORDINATION_SESSION_ID, notification.turnId);
      }, 10000);
      assert.ok(notification);
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ text: notification.text, displayText: notification.displayText }),
        ) <= 6144,
      );
      assert.ok(notification.text.includes('"resultTruncated":true'));
      const sourceRuns = await stores.runtimeEventStore.listSessionInvocations(
        source.targetSessionId,
      );
      assert.equal(sourceRuns.length, 1);
      const sourceRunId = sourceRuns[0]!.runId;
      const original = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        source.targetSessionId,
        sourceRunId,
      );
      assert.ok(
        (await readLedgerMessages(stores.runtimeEventStore, source.targetSessionId)).some(
          (message) => message.type === 'assistant' && message.text === sourceText,
        ),
      );
      await desktop.close();
      await composition.close();
      await activeOwner.close();
      const reopened = await tryAcquireInteractiveRootOwner(activeOwner.capability);
      assert.ok(reopened);
      activeOwner = reopened;
      composition = await createExecutionRuntimeHostComposition(compositionContext(activeOwner));
      stores = await openInteractiveExecutionStoresForWrite(activeOwner.lease);
      desktop = attach();
      await composition.recover();
      await register();
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            { turnId: 'compact-after-restart', text: 'Which task has a result available?' },
            context,
          )
        ).ok,
      );
      await waitFor(
        () => completed(WORKHUB_COORDINATION_SESSION_ID, 'compact-after-restart'),
        10000,
      );
      assert.deepEqual(errors, []);
      const coordinatorRequests = requests.filter((request) => request.coordinator);
      assert.equal(
        coordinatorRequests.length,
        3,
        'one authorizing stream, one result wake, one user follow-up; no summary model',
      );
      for (const request of coordinatorRequests.slice(1)) {
        const text = JSON.stringify(request.messages);
        assert.ok(text.includes('SHORT_HANDOFF'));
        assert.ok(!text.includes('FULL_RESULT_TAIL'));
        assert.ok(!text.includes(sourceText));
      }
      assert.deepEqual(coordinatorRequests[1]!.tools, coordinatorRequests[2]!.tools);
      assert.deepEqual(
        coordinatorRequests[1]!.messages.filter(
          (message) => (message as { role: string }).role === 'system',
        ),
        coordinatorRequests[2]!.messages.filter(
          (message) => (message as { role: string }).role === 'system',
        ),
      );
      assert.equal(requests.filter((request) => !request.coordinator).length, 1);
      assert.deepEqual(
        await stores.runtimeEventStore.readImmutableRuntimeEvents(
          source.targetSessionId,
          sourceRunId,
        ),
        original,
      );
      assert.equal(
        (await stores.runtimeEventStore.listSessionInvocations(source.targetSessionId)).length,
        1,
      );
      assert.ok(
        (await readLedgerMessages(stores.runtimeEventStore, source.targetSessionId)).some(
          (message) => message.type === 'assistant' && message.text === sourceText,
        ),
      );
      const usages = (
        await readLedgerMessages(stores.runtimeEventStore, WORKHUB_COORDINATION_SESSION_ID)
      ).filter(
        (message): message is Extract<StoredMessage, { type: 'token_usage' }> =>
          message.type === 'token_usage',
      );
      const usage = usages.find((message) => message.turnId === 'compact-after-restart');
      assert.ok(usage);
      assert.equal(usage.input, 900);
      assert.equal(
        usage.cacheHitInput,
        400,
        'the fixture-reported cache sample survives real telemetry',
      );
      t.diagnostic(
        JSON.stringify({
          measurement: 'local HTTP fixture, not real-provider savings',
          sourceUtf8Bytes: Buffer.byteLength(sourceText),
          notificationEncodedBytes: Buffer.byteLength(JSON.stringify(notification.text)),
          coordinatorRequestBytes: coordinatorRequests.slice(1).map((request) => request.rawBytes),
          workerRequests: 1,
          extraSummaryRequests: 0,
          localDispatchMs:
            requests.find((request) => !request.coordinator)!.observedAt - dispatchStartedAt,
          localPostBodyToFirstResponseMs: coordinatorRequests
            .slice(1)
            .map((request) => request.firstResponseMs),
          fixtureReportedUsage: {
            input: usage.input,
            cacheHitInput: usage.cacheHitInput,
            cacheMissInput: usage.cacheMissInput,
            output: usage.output,
          },
          compactionDecisions: usages.flatMap(
            (message) => message.contextBudget?.compactionDecisions ?? [],
          ).length,
          cost: usage.costUsd ?? 'unknown; fake-model has no registered price',
        }),
      );
    } finally {
      releaseWorker.resolve();
      await desktop.close();
      await composition.close();
      if (activeOwner !== owner) await activeOwner.close();
    }
  });
});

test('production WorkHub inspects an independent Session through its provider tool surface without starting target work', async (t) => {
  const sourceText = 'Tests passed.\nPublishing is still pending. 😀';
  let targetSessionId = '';
  let inspecting = false;
  const inspectionRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const providerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body);
      if (inspecting) inspectionRequests.push(input);
      const call = inspecting && inspectionRequests.length === 1;
      if (call) assert.match(body, /WorkHubRead/);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: `inspection-${inspectionRequests.length}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.write(
        chunk(
          call
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'inspect-existing',
                    type: 'function',
                    function: {
                      name: 'WorkHubRead',
                      arguments: JSON.stringify({
                        sessionRef: targetSessionId,
                        view: 'reply',
                      }),
                    },
                  },
                ],
              }
            : {
                role: 'assistant',
                content: inspecting ? 'Read the existing source reply.' : sourceText,
              },
          null,
        ),
      );
      response.write(chunk({}, call ? 'tool_calls' : 'stop'));
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      providerErrors.push(error);
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(
      owner,
      ['fake-model'],
      `http://127.0.0.1:${address.port}/v1`,
    );
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'inspection-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const desktop = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(context.connectionId),
      { send: async () => {} },
    );
    try {
      await composition.recover();
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const target = await stores.sessionStore.create({
        cwd: root,
        name: 'Independent release',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'bypass',
      });
      targetSessionId = target.id;
      const started = await composition.handlers['turn.start'](
        {
          sessionId: target.id,
          turnId: 'independent-turn',
          content: { text: 'Report release progress' },
        },
        context,
      );
      assert.ok(started.ok, JSON.stringify(started));
      if (!started.ok || started.result.kind !== 'started') return;
      const targetRunId = started.result.turn.runId;
      const completed = async (sessionId: string, turnId: string) => {
        const turn = await composition.handlers['turn.query']({ sessionId, turnId }, context);
        return turn.ok && turn.result.status === 'completed';
      };
      await waitFor(() => completed(target.id, 'independent-turn'), 10000);
      const sourceMessages = await readLedgerMessages(stores.runtimeEventStore, target.id);
      const source = sourceMessages.find(
        (message) => message.type === 'assistant' && message.text === sourceText,
      );
      assert.ok(source);
      // The terminal fact precedes the target's unread/last-message projection.
      // Let its own bookkeeping settle before measuring inspection side effects.
      await waitFor(async () => {
        const header = await stores.sessionStore.readHeaderSnapshot(target.id);
        return header.hasUnread && (header.lastMessageAt ?? 0) >= source.ts;
      });
      const registered = await composition.handlers['client.capability.replace'](
        {
          registrationId: randomUUID(),
          offers: workHubDesktopCapabilityOffers(),
        },
        context,
      );
      assert.ok(registered.ok, JSON.stringify(registered));
      const resolved = await composition.handlers['workhub.coordination.resolve']({}, context);
      assert.ok(resolved.ok, JSON.stringify(resolved));
      const before = {
        header: await stores.sessionStore.readHeaderRecordSnapshot(target.id),
        events: await stores.runtimeEventStore.readImmutableRuntimeEvents(target.id, targetRunId),
        sessions: (await stores.sessionStore.listHeaders()).map(({ id }) => id).sort(),
      };
      inspecting = true;
      const answer = await composition.handlers['workhub.coordination.answer'](
        {
          turnId: 'inspection-turn',
          text: 'Read the latest reply from the existing release Session.',
        },
        context,
      );
      assert.ok(answer.ok, JSON.stringify(answer));
      await waitFor(() => completed(WORKHUB_COORDINATION_SESSION_ID, 'inspection-turn'), 10000);
      assert.deepEqual(providerErrors, []);
      assert.equal(inspectionRequests.length, 2);
      const resultMessage = inspectionRequests[1]!.messages.find(({ role }) => role === 'tool');
      assert.ok(resultMessage);
      assert.ok(resultMessage.content.startsWith('{'), resultMessage.content);
      const output = { result: JSON.parse(resultMessage.content) };
      assert.equal(output.result.status, 'ok');
      assert.equal(output.result.sessionId, target.id);
      assert.equal(output.result.transcript.messages[0].messageId, source.id);
      assert.equal(output.result.transcript.messages[0].text, sourceText);
      assert.equal(output.result.executionEvidence.turnId, 'independent-turn');
      assert.equal(output.result.executionEvidence.runId, targetRunId);
      assert.equal(output.result.executionEvidence.status, 'completed');
      assert.equal(output.result.executionEvidence.artifactsVerified, false);
      assert.deepEqual(
        await readLedgerMessages(stores.runtimeEventStore, target.id),
        sourceMessages,
      );
      assert.deepEqual(
        await stores.sessionStore.readHeaderRecordSnapshot(target.id),
        before.header,
      );
      assert.deepEqual(
        await stores.runtimeEventStore.readImmutableRuntimeEvents(target.id, targetRunId),
        before.events,
      );
      assert.deepEqual(
        (await stores.sessionStore.listHeaders()).map(({ id }) => id).sort(),
        before.sessions,
      );
    } finally {
      await desktop.close();
      await composition.close();
    }
  });
});

test('native WorkHub ask records an exact durable choice before a separate task start', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner, ['fake-model', 'selected-model']);
    const { composition, manager } = await createCapturedExecutionComposition(owner, {});
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'selection-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const desktop = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(context.connectionId),
      { send: async () => {} },
    );
    try {
      const registered = await composition.handlers['client.capability.replace'](
        {
          registrationId: randomUUID(),
          offers: workHubDesktopCapabilityOffers(),
        },
        context,
      );
      assert.ok(registered.ok, JSON.stringify(registered));
      await composition.handlers['workhub.coordination.resolve']({}, context);
      const alpha = await manager.createSession({
        cwd: root,
        name: 'Release',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'bypass',
      });
      const beta = await manager.createSession({
        cwd: root,
        name: 'Release',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'selected-model',
        permissionMode: 'bypass',
      });
      const turnId = randomUUID();
      const started = await composition.handlers['workhub.coordination.answer'](
        { turnId, text: 'Continue Release; let me choose which work.' },
        context,
      );
      assert.ok(started.ok, JSON.stringify(started));
      const input = {
        turnId,
        actionId: 'selected-release',
        question: 'Which release work should continue?',
        choices: [
          { kind: 'session' as const, id: alpha.id },
          { kind: 'session' as const, id: beta.id },
        ],
      };
      let selectionOutcome: unknown;
      const pending = composition.handlers['workhub.tasks.ask'](input, context).then((result) => {
        selectionOutcome = result;
        return result;
      });
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await waitFor(async () => {
        assert.equal(selectionOutcome, undefined, JSON.stringify(selectionOutcome));
        return (
          (
            await stores.interactionStore.listPending({
              sessionId: WORKHUB_COORDINATION_SESSION_ID,
            })
          ).length === 1
        );
      });
      const record = (
        await stores.interactionStore.listPending({ sessionId: WORKHUB_COORDINATION_SESSION_ID })
      )[0]!;
      const query = () =>
        composition.handlers['interaction.query'](
          { sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: record.requestId },
          context,
        );
      const offered = await query();
      assert.ok(offered.ok);
      if (!offered.ok) return;
      const interaction = offered.result;
      assert.equal(interaction.request.kind, 'form');
      assert.equal(await stores.sessionStore.readWorkHubAssignment(input.actionId), undefined);
      assert.equal(interaction.request.kind, 'form');
      if (
        interaction.request.kind !== 'form' ||
        interaction.request.fields[0]?.kind !== 'single_select'
      )
        return;
      const selected = interaction.request.fields[0].options.find(
        (option) => JSON.parse(option.value)[1] === beta.id,
      )!;
      // Other candidates can change while the user chooses; identity remains the selected Session.
      await manager.createSession({
        cwd: root,
        name: 'Unrelated work',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'bypass',
      });
      const answered = await composition.handlers['interaction.answer'](
        {
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          interactionId: interaction.interactionId,
          answer: { kind: 'form', action: 'accept', values: { target: selected.value } },
        },
        context,
      );
      assert.ok(answered.ok, JSON.stringify(answered));
      const selection = await pending;
      assert.ok(selection.ok && selection.result.kind === 'selected', JSON.stringify(selection));
      assert.deepEqual(selection.result.target, { kind: 'session', id: beta.id });
      assert.equal(selection.result.generationId, undefined);
      assert.equal(selection.result.context?.currentConnectionId, beta.llmConnectionId);
      assert.equal(selection.result.context?.currentConnectionSlug, beta.llmConnectionSlug);
      assert.equal(selection.result.context?.currentModelId, beta.model);
      assert.notEqual(selection.result.context?.currentModelId, alpha.model);
      assert.deepEqual(selection.result.context?.lastRequest, {
        status: 'unknown',
        reason: 'not_observed',
      });
      assert.equal(
        await stores.sessionStore.readWorkHubAssignment(input.actionId),
        undefined,
        'ask never delegates or steers',
      );
      const delegated = await composition.handlers['workhub.tasks.start'](
        {
          turnId,
          actionId: 'selected-release-task',
          title: 'Release readiness',
          text: 'Report release readiness',
          sessionRef: beta.id,
        },
        context,
      );
      assert.ok(delegated.ok, JSON.stringify(delegated));
      assert.notEqual(beta.id, alpha.id);
      const replay = await composition.handlers['workhub.tasks.ask'](input, context);
      assert.ok(replay.ok && replay.result.kind === 'selected', JSON.stringify(replay));
      assert.deepEqual(replay.result.target, selection.result.target);
      assert.equal(replay.result.generationId, selection.result.generationId);
      // The choice is durable; its advisory observation still comes from the selected Session.
      assert.equal(replay.result.context?.currentConnectionId, beta.llmConnectionId);
      assert.equal(replay.result.context?.currentConnectionSlug, beta.llmConnectionSlug);
      assert.equal(replay.result.context?.currentModelId, beta.model);
      const assignment = await stores.sessionStore.readWorkHubAssignment('selected-release-task');
      assert.equal(assignment?.targetSessionId, beta.id);
      const targetTurnId = delegated.result.targetTurnId;
      assert.ok(targetTurnId);
      await waitFor(async () => {
        const turn = await composition.handlers['turn.query'](
          { sessionId: beta.id, turnId: targetTurnId! },
          context,
        );
        return turn.ok && turn.result.status === 'completed';
      });
      assert.equal((await query()).ok, true);
      // Wait for the worker's own terminal cleanup, not a mutable discovery snapshot.
      await waitFor(async () => manager.runningTurnIds(beta.id).length === 0);
      assert.equal(interaction.request.fields[0].options.at(-1)?.value, 'new_task');
      for (const scenario of ['cancel', 'new', 'stale'] as const) {
        const cancel = scenario === 'cancel';
        const nextInput = {
          ...input,
          actionId: scenario + '-release',
        };
        let nextOutcome: unknown;
        const next = composition.handlers['workhub.tasks.ask'](nextInput, context).then(
          (result) => {
            nextOutcome = result;
            return result;
          },
        );
        await waitFor(async () => {
          assert.equal(nextOutcome, undefined, JSON.stringify(nextOutcome));
          return (
            (
              await stores.interactionStore.listPending({
                sessionId: WORKHUB_COORDINATION_SESSION_ID,
              })
            ).length === 1
          );
        });
        const offer = (
          await stores.interactionStore.listPending({ sessionId: WORKHUB_COORDINATION_SESSION_ID })
        )[0]!;
        assert.equal(offer.request.kind, 'form');
        if (offer.request.kind !== 'form' || offer.request.fields[0]?.kind !== 'single_select')
          return;
        const option = offer.request.fields[0].options.find(
          (item) => JSON.parse(item.value)[1] === alpha.id,
        )!;
        if (scenario === 'stale') {
          const snapshot = await stores.sessionStore.readCatalogRecord(alpha.id);
          await stores.sessionStore.setSessionsArchivedVersioned(
            [{ sessionId: alpha.id, expectedVersion: snapshot.revision }],
            true,
          );
        }
        const answer = await composition.handlers['interaction.answer'](
          {
            sessionId: WORKHUB_COORDINATION_SESSION_ID,
            interactionId: offer.requestId,
            answer: cancel
              ? { kind: 'form', action: 'cancel' }
              : {
                  kind: 'form',
                  action: 'accept',
                  values: { target: scenario === 'new' ? 'new_task' : option.value },
                },
          },
          context,
        );
        assert.ok(answer.ok, JSON.stringify(answer));
        const result = await next;
        if (cancel) assert.deepEqual(result, { ok: true, result: { kind: 'cancelled' } });
        else if (scenario === 'new')
          assert.deepEqual(result, { ok: true, result: { kind: 'new_task' } });
        else {
          assert.equal(result.ok, false);
          if (!result.ok) assert.equal(result.error.code, 'operation_conflict');
        }
        assert.equal(
          await stores.sessionStore.readWorkHubAssignment(nextInput.actionId),
          undefined,
        );
      }
    } finally {
      await desktop.close();
      await composition.close();
    }
  });
});

for (const restart of [false, true]) {
  test(`WorkHub result returns after ${restart ? 'Host restart' : 'Desktop reconnect'} without another user message`, async () => {
    await withCompositionRoot(async ({ root, owner }) => {
      const connectionId = await configureFakeDefaultTarget(owner);
      const received: BackendSendInput[] = [];
      let { composition, manager } = await createCapturedExecutionComposition(owner, {
        onWorkHubResult: (input) => received.push(input),
      });
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'workhub-feedback-client',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      let desktop:
        | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
        | undefined;
      let restartedOwner: InteractiveRootOwner | undefined;
      const reopen = async () => {
        await desktop?.close();
        desktop = undefined;
        await composition.close();
        await owner.close();
        restartedOwner = await tryAcquireInteractiveRootOwner(
          await resolveStorageRoot({ path: root, kind: 'interactive' }),
        );
        assert.ok(restartedOwner);
        owner = restartedOwner;
        ({ composition, manager } = await createCapturedExecutionComposition(owner, {
          onWorkHubResult: (input) => received.push(input),
        }));
      };
      try {
        await composition.handlers['workhub.coordination.resolve']({}, context);
        const result = await actWorkHub(
          composition,
          {
            actionId: 'feedback-assignment',
            userText: 'Create a task to produce a report',
            proposal: { disposition: 'create_new', title: 'Report' },
            create: { workspace: { kind: 'host_path', path: root } },
            newWorkDefaults: {
              model: {
                llmConnectionId: connectionId,
                llmConnectionSlug: 'fake',
                model: 'fake-model',
              },
            },
          },
          context,
        );
        assert.ok(result.ok, JSON.stringify(result));
        if (!result.ok || result.result.disposition !== 'create_new') return;
        const target = result.result.targetSessionId;
        await waitFor(async () =>
          (await manager.listTurns(target)).some((t) => t.status === 'completed'),
        );
        if (restart) await reopen();
        desktop = composition.clientCapabilities!.attachConnection(
          clientCapabilityConnectionIdentity(context.connectionId),
          { send: async () => {} },
        );
        const registered = await composition.handlers['client.capability.replace'](
          { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
          context,
        );
        assert.ok(registered.ok, JSON.stringify(registered));
        await waitFor(async () => received.length === 1, 12000);
        assert.ok(received[0]!.text.includes('feedback-assignment'));
        const transcript = await manager.getMessages(WORKHUB_COORDINATION_SESSION_ID);
        const notification = transcript.find(
          (m) => m.type === 'user' && m.origin?.kind === 'workhub_result',
        );
        assert.ok(notification?.type === 'user');
        assert.equal(notification.origin?.kind, 'workhub_result');
        assert.equal(notification.displayText, 'Report');
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        {
          const delivery = await stores.agentRunStore.readRootTurnAdmission(
            WORKHUB_COORDINATION_SESSION_ID,
            notification.turnId,
          );
          assert.equal(delivery?.execution.kind, 'workhub_coordination');
          assert.ok(
            delivery?.execution.kind === 'workhub_coordination' && delivery.execution.feedback,
          );
          assert.equal(
            delivery?.execution.kind === 'workhub_coordination' &&
              'routingDecision' in delivery.execution,
            false,
          );
        }
        await waitFor(async () =>
          (await manager.listTurns(WORKHUB_COORDINATION_SESSION_ID)).some(
            (t) => t.turnId === notification.turnId && t.status === 'completed',
          ),
        );
        if (restart) {
          await reopen();
          desktop = composition.clientCapabilities!.attachConnection(
            clientCapabilityConnectionIdentity(context.connectionId),
            { send: async () => {} },
          );
          const registration = await composition.handlers['client.capability.replace'](
            { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
            context,
          );
          assert.ok(registration.ok);
          // Two reconciliation polls must observe the existing durable receipt.
          await new Promise((resolve) => setTimeout(resolve, 5500));
          const notifications = (await manager.getMessages(WORKHUB_COORDINATION_SESSION_ID)).filter(
            (m) => m.type === 'user' && m.origin?.kind === 'workhub_result',
          );
          assert.equal(notifications.length, 1);
        }
        assert.equal(received.length, 1);
      } finally {
        await desktop?.close();
        await composition.close();
        await restartedOwner?.close();
      }
    });
  });
}

test('WorkHub native task and linked child approval preserve original Session authority', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const release = deferred<void>();
    let childTask: Promise<unknown> | undefined;
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            for await (const event of super.send(input)) {
              if (input.text === '__e2e_ask_sandbox_boundary__' && event.type === 'complete')
                continue;
              yield event;
            }
            if (input.text === '__e2e_ask_sandbox_boundary__') await release.promise;
          }
          override async stop() {
            release.resolve();
            await super.stop();
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'task-grant-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      await composition.handlers['workhub.coordination.resolve']({}, context);
      const assigned = await actWorkHub(
        composition,
        {
          actionId: 'task-grant-action',
          userText: '__e2e_ask_sandbox_boundary__',
          proposal: { disposition: 'create_new', title: 'Task grant' },
          create: { workspace: { kind: 'host_path', path: root } },
          newWorkDefaults: {
            model: {
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
            },
          },
        },
        context,
      );
      assert.ok(assigned.ok, JSON.stringify(assigned));
      if (!assigned.ok || assigned.result.disposition !== 'create_new') return;
      const target = assigned.result.targetSessionId;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const unrelated = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const readConfiguration = async (sessionId: string) => {
        const header = await stores.sessionStore.readHeaderSnapshot(sessionId);
        return {
          cwd: header.cwd,
          backend: header.backend,
          executorId: header.executorId,
          executorConfig: header.executorConfig,
          llmConnectionId: header.llmConnectionId,
          llmConnectionSlug: header.llmConnectionSlug,
          model: header.model,
          permissionMode: header.permissionMode,
        };
      };
      const independentSessions = [WORKHUB_COORDINATION_SESSION_ID, unrelated.id];
      const independentBefore = await Promise.all(
        independentSessions.map(async (sessionId) => ({
          configuration: await readConfiguration(sessionId),
          boundary: await stores.sessionStore.readExecutionBoundary(sessionId),
          grants: await stores.sessionStore.listTaskExecutionGrants(sessionId),
        })),
      );
      const targetConfiguration = await readConfiguration(target);
      await waitFor(
        async () =>
          (await stores.sessionStore.listPendingSandboxBoundaryRequests(target)).length === 1,
      );
      const before = await stores.sessionStore.readExecutionBoundary(target);
      const allowRequestedNetwork = (boundary: typeof before) => {
        assert.ok(boundary.kind === 'managed');
        return {
          ...boundary,
          profile: { ...boundary.profile, network: { kind: 'enabled' as const } },
          revision: boundary.revision + (boundary.profile.network.kind === 'enabled' ? 0 : 1),
        };
      };
      const inbox = await composition.handlers['workhub.interactions.query']({}, context);
      assert.ok(inbox.ok);
      const original = inbox.result.requests[0]!.interaction;
      assert.equal(original.sessionId, target);
      assert.ok(original.request.kind === 'sandbox_boundary');
      assert.deepEqual(original.request.expansion, { network: { enabled: true } });
      const approved = await composition.handlers['workhub.interactions.answer'](
        {
          actionId: 'task-grant-action',
          interactionId: original.interactionId,
          expectedTurnId: original.turnId,
          expectedRunId: original.runId,
          answer: { kind: 'sandbox_boundary', decision: 'allow' },
        },
        context,
      );
      assert.ok(approved.ok, JSON.stringify(approved));
      const parentApproved = await stores.sessionStore.readExecutionBoundary(target);
      assert.deepEqual(parentApproved, allowRequestedNetwork(before));
      assert.deepEqual(await readConfiguration(target), targetConfiguration);
      assert.deepEqual(await stores.sessionStore.listTaskExecutionGrants(target), []);
      const childReady = deferred<{ childSessionId: string; turnId: string; runId: string }>();
      childTask = manager.spawnChildSession(target, {
        agentProfile: 'local_read',
        prompt: '__e2e_ask_sandbox_boundary__',
        spawnedBy: {
          parentTurnId: original.turnId,
          parentRunId: original.runId,
          toolCallId: 'task-child-spawn',
        },
        onReady: async (identity) => {
          childReady.resolve(identity);
        },
      });
      void childTask.catch(() => {});
      const child = await childReady.promise;
      await waitFor(
        async () =>
          (await stores.sessionStore.listPendingSandboxBoundaryRequests(child.childSessionId))
            .length === 1,
      );
      const childInbox = await composition.handlers['workhub.interactions.query']({}, context);
      assert.ok(childInbox.ok);
      const childRequest = childInbox.result.requests.find(
        (p) => p.interaction.sessionId === child.childSessionId,
      );
      assert.ok(
        childRequest,
        'the production linked child (without cross-Session Run lineage) reaches its task inbox',
      );
      assert.equal(childRequest.interaction.sessionId, child.childSessionId);
      assert.equal(childRequest.interaction.turnId, child.turnId);
      assert.equal(childRequest.interaction.runId, child.runId);
      assert.ok(childRequest.interaction.request.kind === 'sandbox_boundary');
      assert.deepEqual(childRequest.interaction.request.expansion, {
        network: { enabled: true },
      });
      const childBefore = await stores.sessionStore.readExecutionBoundary(child.childSessionId);
      const childConfiguration = await readConfiguration(child.childSessionId);
      const childApproval = await composition.handlers['workhub.interactions.answer'](
        {
          actionId: 'task-grant-action',
          interactionId: childRequest.interaction.interactionId,
          expectedTurnId: child.turnId,
          expectedRunId: child.runId,
          answer: { kind: 'sandbox_boundary', decision: 'allow' },
        },
        context,
      );
      assert.ok(childApproval.ok, JSON.stringify(childApproval));
      assert.deepEqual(
        await stores.sessionStore.readExecutionBoundary(child.childSessionId),
        allowRequestedNetwork(childBefore),
      );
      assert.deepEqual(await readConfiguration(child.childSessionId), childConfiguration);
      assert.deepEqual(await stores.sessionStore.listTaskExecutionGrants(target), []);
      assert.deepEqual(
        await stores.sessionStore.listTaskExecutionGrants(child.childSessionId),
        [],
        'answering an original request does not create task-wide grants',
      );
      assert.deepEqual(await stores.sessionStore.readExecutionBoundary(target), parentApproved);
      assert.deepEqual(await readConfiguration(target), targetConfiguration);
      assert.deepEqual(
        await Promise.all(
          independentSessions.map(async (sessionId) => ({
            configuration: await readConfiguration(sessionId),
            boundary: await stores.sessionStore.readExecutionBoundary(sessionId),
            grants: await stores.sessionStore.listTaskExecutionGrants(sessionId),
          })),
        ),
        independentBefore,
        'original Session approval cannot expand the coordinator or an unrelated Session',
      );
    } finally {
      release.resolve();
      await composition.close();
      await childTask?.catch(() => {});
    }
  });
});

test('WorkHub receives a pending question and then the result after the target resumes', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const received: BackendSendInput[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      coordinationBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            const notification = input.text.startsWith('Host task result notification.');
            if (notification) received.push(input);
            yield* super.send({
              ...input,
              text:
                notification || input.text === 'A separate user request while the task needs input'
                  ? 'The independent request was received.'
                  : FAKE_HOLD_OPEN_PROMPT,
            });
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-question-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    let desktop:
      | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
      | undefined;
    try {
      await composition.handlers['workhub.coordination.resolve']({}, context);
      const created = await actWorkHub(
        composition,
        {
          actionId: 'question-assignment',
          userText: FAKE_ASK_USER_QUESTION_PROMPT,
          proposal: { disposition: 'create_new', title: 'Release questions' },
          create: { workspace: { kind: 'host_path', path: root } },
          newWorkDefaults: {
            model: {
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
            },
          },
        },
        context,
      );
      assert.ok(created.ok, JSON.stringify(created));
      if (!created.ok || created.result.disposition !== 'create_new') return;
      const target = created.result.targetSessionId;
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await waitFor(
        async () => (await stores.interactionStore.listPending({ sessionId: target })).length === 1,
      );
      desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      const registered = await composition.handlers['client.capability.replace'](
        { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
        context,
      );
      assert.ok(registered.ok);
      await waitFor(async () => received.length === 1, 12000);
      assert.match(received[0]!.text, /"status":"waiting_for_user"/u);
      const pending = (await stores.interactionStore.listPending({ sessionId: target }))[0]!;
      assert.ok(received[0]!.text.includes(pending.requestId));
      const inbox = await composition.handlers['workhub.interactions.query']({}, context);
      assert.ok(inbox.ok, JSON.stringify(inbox));
      assert.equal(inbox.result.requests.length, 1);
      assert.equal(inbox.result.requests[0]!.interaction.interactionId, pending.requestId);
      assert.equal(inbox.result.requests[0]!.interaction.sessionId, target);
      const answerInput = {
        actionId: 'question-assignment',
        interactionId: pending.requestId,
        expectedTurnId: pending.turnId,
        expectedRunId: pending.runId,
        answer: { kind: 'question' as const, answers: ['邀请制', '本周', '是'] },
      };
      const stale = await composition.handlers['workhub.interactions.answer'](
        { ...answerInput, expectedRunId: 'another-host-run' },
        context,
      );
      assert.ok(!stale.ok);
      assert.equal((await stores.interactionStore.listPending({ sessionId: target })).length, 1);
      const queuedInput = await composition.handlers['turn.message.submit'](
        {
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          originHostEpoch: context.hostEpoch,
          messageId: randomUUID(),
          placement: 'next_turn',
          content: { text: 'A separate user request while the task needs input' },
        },
        context,
      );
      assert.ok(queuedInput.ok, JSON.stringify(queuedInput));
      const answered = await composition.handlers['workhub.interactions.answer'](
        answerInput,
        context,
      );
      assert.ok(answered.ok, JSON.stringify(answered));
      assert.equal(
        (await composition.handlers['workhub.interactions.answer'](answerInput, context)).ok,
        false,
      );
      const remaining = await composition.handlers['workhub.interactions.query']({}, context);
      assert.ok(remaining.ok);
      assert.deepEqual(remaining.result.requests, []);
      /* The same original authority remains compatible with ordinary clients. */
      const replayed = await composition.handlers['interaction.answer'](
        {
          sessionId: target,
          interactionId: pending.requestId,
          answer: { kind: 'question', answers: ['邀请制', '本周', '是'] },
        },
        context,
      );
      assert.ok(replayed.ok, JSON.stringify(replayed));
      await waitFor(async () => received.length === 2, 12000);
      assert.match(received[1]!.text, /"status":"completed"/u);
      assert.equal(
        (await manager.getMessages(WORKHUB_COORDINATION_SESSION_ID)).filter(
          (m) => m.type === 'user' && m.origin?.kind === 'workhub_result',
        ).length,
        2,
      );
    } finally {
      await desktop?.close();
      await composition.close();
    }
  });
});

test('production execution-scoped subscriptions read a past task without waking it or exposing the new root', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input.text);
            yield* super.send(input);
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'scoped-production',
      principal: 'local_owner',
      principalKind: 'local_owner',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const first = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'original-work',
          content: { text: 'original scoped work' },
        },
        context,
      );
      assert.ok(first.ok, JSON.stringify(first));
      await waitFor(
        async () =>
          (await manager.listTurns(session.id)).some(
            (t) => t.turnId === 'original-work' && t.status === 'completed',
          ),
        12_000,
      );
      if (first.result.kind !== 'started') assert.fail('Expected the original root to start');
      const scope = { turnId: first.result.turn.turnId, runId: first.result.turn.runId };
      const second = await composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId: 'unrelated-work',
          content: { text: FAKE_HOLD_OPEN_PROMPT },
        },
        context,
      );
      assert.ok(second.ok, JSON.stringify(second));
      if (second.result.kind !== 'started') assert.fail('Expected the unrelated root to start');
      await waitFor(async () => sends.length === 2);
      assert.ok(composition.continuity);
      const observing = composition.continuity.attachConnection(context.connectionId, {
        send: async () => {},
      });
      try {
        const invalid = await composition.handlers['subscription.open'](
          {
            sessionId: session.id,
            execution: { ...scope, runId: second.result.turn.runId },
            transcript: { kind: 'tail', maxBytes: 1024 },
          },
          context,
        );
        assert.ok(!invalid.ok && invalid.error.code === 'not_found');
        const input = {
          sessionId: session.id,
          execution: scope,
          transcript: { kind: 'tail' as const, maxBytes: 1024 },
        };
        const opened = await composition.handlers['subscription.open'](input, context);
        assert.ok(opened.ok, JSON.stringify(opened));
        assert.deepEqual(opened.result.execution, scope);
        assert.equal(opened.result.snapshot.rootTurn, null);
        assert.deepEqual(opened.result.activeAssistantStreams, []);
        const subscription = clientSubscription(
          opened.result,
          async () => {},
          async (query) => {
            const page = await composition.handlers['session.transcript.page'](query, context);
            assert.ok(page.ok, JSON.stringify(page));
            return page.result;
          },
        );
        const transcript = await subscription.loadTranscript((value) => value as StoredMessage);
        assert.ok(transcript.some((m) => m.type === 'user' && m.text === 'original scoped work'));
        assert.ok(transcript.some((m) => m.type === 'assistant'));
        assert.ok(transcript.every((m) => m.turnId === scope.turnId));
        const unchanged = (await manager.listSessions()).find((s) => s.id === session.id)!;
        assert.equal(unchanged.permissionMode, 'ask');
        assert.equal(unchanged.model, 'fake-model');
        assert.equal(unchanged.cwd, root);
        assert.deepEqual(sends, ['original scoped work', FAKE_HOLD_OPEN_PROMPT]);
      } finally {
        observing.close();
      }
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub task history separates same-Session work and exposes only original owned roots without waking workers', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const residencies = new HostResidencyRegistry();
    const hostedRoots = () =>
      residencies.snapshot().find(({ label }) => label === 'hosted-execution')?.count ?? 0;
    const sends: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      residencies,
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput) {
            sends.push(input.text);
            yield* super.send(input);
          }
        })(backendContext),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'task-history-client',
      principal: 'local_os_user',
      acquireResidency: () => residencies.acquire('hosted-execution'),
    };
    try {
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      const target = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      await delegateWorkHubTarget(composition, context, target.id, 'view-work-a', 'Read task A');
      await waitFor(
        async () =>
          (await manager.listTurns(target.id)).some((turn) => turn.status === 'completed'),
        12_000,
      );
      const initial = await composition.handlers['workhub.tasks.history'](
        { workId: 'view-work-a' },
        context,
      );
      assert.ok(initial.ok, JSON.stringify(initial));
      const source = initial.result.assignments[0]!;
      // A canonical terminal fact precedes release of the actual Root and workspace slot.
      await waitFor(
        async () =>
          (await manager.listTurns(target.id)).some(
            (turn) => turn.turnId === source.execution?.turnId && turn.status === 'completed',
          ) && hostedRoots() === 0,
        12_000,
      );
      assert.equal(source.workId, 'view-work-a');
      assert.equal(source.state, 'owned');
      const followupAction = `whtinput_${createHash('sha256').update('view-a-followup').digest('hex').slice(0, 48)}`;
      const desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      const registered = await composition.handlers['client.capability.replace'](
        { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
        context,
      );
      assert.ok(registered.ok, JSON.stringify(registered));
      const continued = await composition.handlers['workhub.tasks.send'](
        {
          inputId: 'view-a-followup',
          text: 'A follow-up',
          workId: source.workId,
          generationId: source.generationId,
        },
        context,
      );
      await desktop.close();
      assert.ok(continued.ok, JSON.stringify(continued));
      assert.equal(continued.result.mode, 'continuation');
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const inputFact = await stores.sessionStore.readWorkHubTaskInput('view-a-followup');
      assert.equal(inputFact?.kind, 'task_input');
      assert.equal(inputFact?.sourceActionId, source.actionId);
      assert.equal(inputFact?.targetMessageId, continued.result.targetMessageId);
      await waitFor(
        async () =>
          (await manager.listTurns(target.id)).filter((turn) => turn.status === 'completed')
            .length === 2,
        12_000,
      );
      const after = await composition.handlers['workhub.tasks.history'](
        { workId: 'view-work-a' },
        context,
      );
      assert.ok(after.ok, JSON.stringify(after));
      assert.deepEqual(
        after.result.assignments.map((item) => item.actionId),
        [followupAction, 'view-work-a'],
      );
      const followup = after.result.assignments[0]!;
      await waitFor(
        async () =>
          (await manager.listTurns(target.id)).some(
            (turn) => turn.turnId === followup.execution?.turnId && turn.status === 'completed',
          ) && hostedRoots() === 0,
        12_000,
      );
      await delegateWorkHubTarget(
        composition,
        context,
        target.id,
        'view-work-b',
        'Independent task B',
      );
      await waitFor(async () => sends.includes('Independent task B'));
      const accepted = await composition.handlers['workhub.tasks.input.read'](
        { workId: source.workId, inputId: 'view-a-followup' },
        context,
      );
      assert.ok(accepted.ok, JSON.stringify(accepted));
      assert.equal(accepted.result.delivery, 'delivered');
      assert.deepEqual(accepted.result.execution, followup.execution);
      const beforeReads = sends.length;
      const history = await composition.handlers['workhub.tasks.history'](
        { workId: 'view-work-a' },
        context,
      );
      assert.ok(history.ok, JSON.stringify(history));
      assert.deepEqual(
        history.result.assignments.map((item) => item.actionId),
        [followupAction, 'view-work-a'],
      );
      assert.equal(new Set(history.result.assignments.map((item) => item.generationId)).size, 1);
      const selected = await composition.handlers['workhub.tasks.history'](
        { workId: 'view-work-a', actionId: source.actionId },
        context,
      );
      assert.ok(selected.ok, JSON.stringify(selected));
      assert.deepEqual(
        selected.result.assignments.map((item) => item.actionId),
        [source.actionId],
      );
      assert.deepEqual(selected.result.assignments[0]!.execution, source.execution);
      for (const assignment of history.result.assignments) {
        const executions = await composition.handlers['workhub.tasks.executions'](
          { actionId: assignment.actionId, delegationId: assignment.delegationId },
          context,
        );
        assert.ok(executions.ok, JSON.stringify(executions));
        assert.deepEqual(
          executions.result.executions.map((item) => item.turnId),
          [assignment.execution!.turnId],
        );
        assert.equal(executions.result.targetSessionId, target.id);
      }
      const unknown = await composition.handlers['workhub.tasks.executions'](
        { actionId: source.actionId, delegationId: 'wrong-delegation' },
        context,
      );
      assert.ok(!unknown.ok && unknown.error.code === 'not_found');
      const changed = (await manager.listSessions()).find((item) => item.id === target.id)!;
      assert.equal(changed.permissionMode, 'ask');
      assert.equal(changed.model, 'fake-model');
      assert.equal(changed.cwd, root);
      assert.equal(
        sends.length,
        beforeReads,
        'read-only history cannot dispatch, admit or wake a worker',
      );
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub creates new work through the production assignment composition', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner, ['fake-model', 'fake-model-b']);
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-create-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const resolved = await composition.handlers['workhub.coordination.resolve']({}, context);
      assert.equal(resolved.ok, true);
      const created = await actWorkHub(
        composition,
        {
          actionId: 'workhub-create-action',
          userText: 'Fix login stability',
          proposal: { disposition: 'create_new', title: 'Login stability' },
          create: { workspace: { kind: 'host_path', path: root } },
          newWorkDefaults: {
            model: {
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model-b',
            },
          },
        },
        context,
      );

      assert.equal(created.ok, true, JSON.stringify(created));
      if (!created.ok || created.result.disposition !== 'create_new') return;
      const targetSessionId = created.result.targetSessionId;
      const session = (await manager.listSessions()).find(({ id }) => id === targetSessionId);
      assert.equal(session?.name, 'Login stability');
      assert.equal(session?.llmConnectionId, connectionId);
      assert.equal(session?.model, 'fake-model-b');
      assert.equal(
        session?.permissionMode,
        'ask',
        'unconfigured WorkHub work does not inherit the ordinary chat bypass default',
      );

      const current = await composition.handlers['workhub.tasks.find'](
        { query: 'Login stability' },
        context,
      );
      assert.ok(current.ok, JSON.stringify(current));
      assert.equal(
        current.result.items.find((item) => item.kind === 'task')?.id,
        'workhub-create-action',
      );
      const stopped = await stopWorkHubTasks(
        composition,
        context,
        'workhub-create-stop-action',
        ['workhub-create-action'],
        'Stop Login stability',
      );
      assert.ok(stopped.ok && stopped.result.kind === 'result', JSON.stringify(stopped));
      assert.equal(stopped.result.targets[0]?.workId, 'workhub-create-action');
    } finally {
      await composition.close();
    }
  });
});

for (const scenario of ['running', 'waiting_for_user'] as const) {
  test(`WorkHub queues independent Turns behind ${scenario} without steering`, async () => {
    await withCompositionRoot(async ({ root, owner }) => {
      const connectionId = await configureFakeDefaultTarget(owner);
      const policyStores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
      const policy = await policyStores.runtimePolicy.getSnapshot();
      await policyStores.runtimePolicy.mutate({
        expectedRevision: policy.revision,
        operation: {
          kind: 'set_chat_defaults',
          value: {
            ...policy.policy.chatDefaults,
            workHubPermissionMode: scenario === 'running' ? 'ask' : 'bypass',
          },
        },
      });
      const releaseOriginal = deferred<void>();
      const sends: BackendSendInput[] = [];
      const executionPermissions: string[] = [];
      const originalText =
        scenario === 'waiting_for_user'
          ? FAKE_ASK_USER_QUESTION_PROMPT
          : 'Finish the original manual task';
      const backendFactory: BackendFactory = (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input);
            executionPermissions.push(
              (await context.store.readHeader(context.sessionId)).permissionMode,
            );
            if (input.text === originalText && scenario !== 'waiting_for_user') {
              await releaseOriginal.promise;
            }
            yield* super.send(input);
          }
          override async stop(): Promise<void> {
            await super.stop();
            releaseOriginal.resolve();
          }
        })(context);
      const { composition, manager } = await createCapturedExecutionComposition(owner, {
        primaryBackendFactory: backendFactory,
      });
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'workhub-queued-turn-client',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      const desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      try {
        assert.ok(
          (
            await composition.handlers['client.capability.replace'](
              {
                registrationId: randomUUID(),
                offers: workHubDesktopCapabilityOffers(),
              },
              context,
            )
          ).ok,
        );
        const target = await manager.createSession({
          cwd: root,
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: scenario === 'running' ? 'bypass' : 'ask',
        });
        const started = await composition.handlers['turn.start'](
          {
            sessionId: target.id,
            turnId: 'manual-original-turn',
            content: { text: originalText },
          },
          context,
        );
        assert.ok(started.ok, JSON.stringify(started));
        await waitFor(async () => sends.length === 1);
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        if (scenario === 'waiting_for_user') {
          await waitFor(async () => {
            const pending = await stores.interactionStore.listPending({ sessionId: target.id });
            const catalog = await stores.sessionStore.readCatalogRecord(target.id);
            return pending.length === 1 && catalog.header.status === 'waiting_for_user';
          });
        }
        await composition.handlers['workhub.coordination.resolve']({}, context);
        assert.ok(
          (
            await composition.handlers['workhub.coordination.answer'](
              {
                turnId: 'queued-authority',
                text: 'Accept First delegated job and Second delegated job independently.',
              },
              context,
            )
          ).ok,
        );
        const inputs: NativeWorkHubFixtureStart[] = [];
        const messageIds: string[] = [];
        for (const text of ['First delegated job', 'Second delegated job']) {
          const input: NativeWorkHubFixtureStart = {
            actionId: `queued-${inputs.length}`,
            userText: text,
            turnId: 'queued-authority',
            proposal: { disposition: 'delegate_existing', sessionRef: target.id },
          };
          inputs.push(input);
          const delegated = await actWorkHub(composition, input, context);
          assert.ok(delegated.ok, JSON.stringify(delegated));
          assert.equal(delegated.result.disposition, 'delegate_existing');
          if (delegated.result.disposition !== 'delegate_existing') return;
          assert.equal(delegated.result.steered, undefined);
          assert.equal(
            delegated.result.targetTurnId,
            undefined,
            'an admission Turn is not execution evidence',
          );
          const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
          assert.ok(assignment);
          assert.equal(
            Reflect.get(delegated.result, 'targetMessageId'),
            assignment.targetMessageId,
          );
          messageIds.push(assignment.targetMessageId);
        }
        const replay = await actWorkHub(composition, inputs[0]!, context);
        assert.ok(replay.ok, JSON.stringify(replay));
        const pending = await composition.handlers['turn.message.execution.query'](
          {
            sessionId: target.id,
            messageIds,
          },
          context,
        );
        assert.ok(pending.ok, JSON.stringify(pending));
        assert.deepEqual(
          pending.result.resolutions.map((entry) => entry.state),
          ['pending', 'pending'],
        );
        assert.equal(sends.length, 1, 'queued requests must not call the target backend yet');

        if (scenario === 'running') {
          const current = await stores.sessionStore.readHeaderRecordSnapshot(target.id);
          const tightened = await composition.handlers['session.configuration.update'](
            {
              sessionId: target.id,
              expectedRevision: current.revision,
              patch: { permissionMode: 'ask' },
            },
            context,
          );
          assert.equal(
            tightened.ok,
            false,
            'WorkHub does not bypass the existing active-Turn configuration guard',
          );
          if (!tightened.ok) assert.equal(tightened.error.code, 'session_busy');
          assert.equal(
            (await stores.sessionStore.readHeaderSnapshot(target.id)).permissionMode,
            'bypass',
          );
        }

        if (scenario === 'waiting_for_user') {
          const question = (
            await stores.interactionStore.listPending({ sessionId: target.id })
          )[0]!;
          const answered = await composition.handlers['interaction.answer'](
            {
              sessionId: target.id,
              interactionId: question.requestId,
              answer: { kind: 'question', answers: ['邀请制', '本周', '是'] },
            },
            context,
          );
          assert.ok(answered.ok, JSON.stringify(answered));
        } else {
          releaseOriginal.resolve();
        }
        await waitFor(async () => {
          const messages = await manager.getMessages(target.id);
          return ['First delegated job', 'Second delegated job'].every((text) =>
            messages.some((message) => message.type === 'assistant' && message.text.includes(text)),
          );
        }, 12_000);
        assert.deepEqual(
          sends.map((input) => input.text),
          [originalText, 'First delegated job', 'Second delegated job'],
        );
        assert.equal(new Set(sends.map((input) => input.turnId)).size, 3);
        const expectedPermission = scenario === 'running' ? 'bypass' : 'ask';
        assert.deepEqual(
          executionPermissions.slice(1),
          [expectedPermission, expectedPermission],
          'queued delegations use the target Session permission at execution, not the WorkHub default',
        );
        const executed = await composition.handlers['turn.message.execution.query'](
          { sessionId: target.id, messageIds },
          context,
        );
        assert.ok(executed.ok, JSON.stringify(executed));
        for (const resolution of executed.result.resolutions) {
          assert.equal(resolution.state, 'owned');
          if (resolution.state === 'owned')
            assert.notEqual(resolution.turnId, 'manual-original-turn');
        }
        const messages = await manager.getMessages(target.id);
        for (const text of ['First delegated job', 'Second delegated job']) {
          const users = messages.filter(
            (message) => message.type === 'user' && message.text === text,
          );
          assert.equal(
            users.length,
            1,
            'same-Root native start replay must not duplicate the accepted Message',
          );
          assert.notEqual(users[0]!.turnId, 'manual-original-turn');
        }
        const session = (await manager.listSessions()).find((entry) => entry.id === target.id)!;
        assert.equal(session.permissionMode, expectedPermission);
        assert.equal(session.model, 'fake-model');
        assert.equal(session.cwd, root);
      } finally {
        releaseOriginal.resolve();
        await desktop.close();
        await composition.close();
      }
    });
  });
}

test('one WorkHub Turn admits independent goals in private or registered workspaces and remains responsive', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const coordinatorRelease = deferred<void>();
    const workerRelease = deferred<void>();
    const workerInputs: Array<{ sessionId: string; cwd: string; input: BackendSendInput }> = [];
    const coordinationInputs: BackendSendInput[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      coordinationBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            coordinationInputs.push(input);
            if (input.turnId === 'independent-goals') await coordinatorRelease.promise;
            yield* super.send({
              ...input,
              text: 'The accepted goals are delegated; I can take the next request.',
            });
          }
        })(backendContext),
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            workerInputs.push({ sessionId: this.sessionId, cwd: backendContext.header.cwd, input });
            await Promise.race([
              workerRelease.promise,
              new Promise<void>((resolve) => {
                backendContext.abortSignal?.addEventListener('abort', () => resolve(), {
                  once: true,
                });
              }),
            ]);
            yield* super.send(input);
          }
        })(backendContext),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'batch-workhub-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const desktop = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(context.connectionId),
      { send: async () => {} },
    );
    try {
      assert.ok(
        (
          await composition.handlers['client.capability.replace'](
            { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
            context,
          )
        ).ok,
      );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      const projectPath = join(root, 'registered-code');
      await mkdir(projectPath);
      const registered = await composition.handlers['project.catalog.mutate'](
        { kind: 'register', path: projectPath },
        context,
      );
      assert.ok(registered.ok, JSON.stringify(registered));
      const userText = 'Research A, draft B, and fix code C. These are independent goals.';
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            { turnId: 'independent-goals', text: userText },
            context,
          )
        ).ok,
      );
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const ids: string[] = [];
      for (const [index, text] of ['Research A', 'Draft B', 'Fix code C'].entries()) {
        const input: WorkHubTaskStartInput = {
          turnId: 'independent-goals',
          actionId: `independent-${index}`,
          text,
          title: text,
          create: {
            workspace:
              index === 2
                ? { kind: 'project' as const, projectId: registered.result.project.id }
                : { kind: 'isolated' as const },
          },
          newWorkDefaults: {
            permissionMode: 'ask' as const,
            model: {
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
            },
          },
        };
        const accepted = await composition.handlers['workhub.tasks.start'](input, context);
        assert.ok(accepted.ok, JSON.stringify(accepted));
        assert.equal(accepted.result.disposition, 'create_new');
        if (accepted.result.disposition !== 'create_new') throw new Error('Missing created target');
        ids.push(accepted.result.targetSessionId);
        assert.deepEqual(
          await composition.handlers['workhub.tasks.start'](input, context),
          accepted,
          'exact replay converges without a second Session or Message',
        );
        const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
        assert.equal(assignment?.coordinationTurnId, input.turnId);
        assert.equal(assignment?.userText, userText);
      }
      await waitFor(async () => workerInputs.length === 3);
      assert.deepEqual(
        workerInputs.map(({ input }) => input.text),
        ['Research A', 'Draft B', 'Fix code C'],
      );
      const cwds = workerInputs.map(({ cwd }) => cwd);
      assert.equal(new Set(cwds).size, 3);
      for (const [index, id] of ids.entries()) {
        assert.equal(
          cwds[index],
          index === 2 ? await realpath(projectPath) : join(root, 'workhub-tasks', id),
        );
        const header = await stores.sessionStore.readHeaderSnapshot(id);
        assert.equal(header.permissionMode, 'ask');
        assert.equal(header.model, 'fake-model');
      }
      // StateRoot is deliberately outside the OS temporary grant. Check the
      // unchanged managed file-tool policy against the real Seatbelt worker.
      if (process.platform === 'darwin') {
        const worker = new FilesystemWorkerClient({
          sandboxManager: createDefaultSandboxManager(),
          getLaunchSpec: createFilesystemWorkerLaunchSpecProvider({
            runtime: 'node',
            resourceLocation: { kind: 'runtime' },
          }),
        });
        const path = join(cwds[0]!, 'result.txt');
        await worker.execute({
          cwd: cwds[0]!,
          mode: 'ask',
          operation: { kind: 'write', path, content: 'private result' },
          expectedIdentity: 'missing',
        });
        assert.equal(await readFile(path, 'utf8'), 'private result');
        const read = await worker.execute({
          cwd: cwds[0]!,
          mode: 'ask',
          operation: { kind: 'read', path },
        });
        assert.equal(read.kind, 'read');
        for (const access of ['read', 'write'] as const)
          await assert.rejects(
            worker.execute({
              cwd: cwds[1]!,
              mode: 'ask',
              operation:
                access === 'read'
                  ? { kind: 'read', path }
                  : { kind: 'write', path, content: 'must not overwrite' },
              expectedIdentity: 'unchecked',
            }),
            (error: unknown) =>
              error instanceof FilesystemWorkerClientError && error.reason === 'path_denied',
          );
        assert.equal(await readFile(path, 'utf8'), 'private result');
      }
      const queuedText = 'What can I ask while you delegate?';
      const queued = await composition.handlers['turn.message.submit'](
        {
          originHostEpoch: context.hostEpoch,
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          messageId: 'input-during-delegation',
          content: { text: queuedText },
          placement: 'next_turn',
        },
        context,
      );
      assert.ok(queued.ok, JSON.stringify(queued));
      assert.equal(
        coordinationInputs.some((input) => input.text === queuedText),
        false,
      );
      coordinatorRelease.resolve();
      await waitFor(async () =>
        (await manager.listTurns(WORKHUB_COORDINATION_SESSION_ID)).some(
          (turn) => turn.turnId === 'independent-goals' && turn.status === 'completed',
        ),
      );
      await waitFor(async () => {
        const queuedInput = coordinationInputs.find((input) => input.text === queuedText);
        return (
          queuedInput !== undefined &&
          (await manager.listTurns(WORKHUB_COORDINATION_SESSION_ID)).some(
            (turn) => turn.turnId === queuedInput.turnId && turn.status === 'completed',
          )
        );
      });
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            { turnId: 'while-workers-run', text: 'What can I ask next?' },
            context,
          )
        ).ok,
      );
      await waitFor(async () =>
        (await manager.listTurns(WORKHUB_COORDINATION_SESSION_ID)).some(
          (turn) => turn.turnId === 'while-workers-run' && turn.status === 'completed',
        ),
      );
      assert.equal(
        (await stores.sessionStore.listHeaders()).length,
        4,
        'Q&A does not create a task',
      );
      assert.equal(
        coordinationInputs.filter((input) => input.text.startsWith('Host task result notification.')).length,
        0,
      );
      workerRelease.resolve();
      await waitFor(
        async () =>
          coordinationInputs.filter((input) => input.text.startsWith('Host task result notification.'))
            .length === 3,
        12000,
      );
      const notifications = (await manager.getMessages(WORKHUB_COORDINATION_SESSION_ID)).filter(
        (message) => message.type === 'user' && message.origin?.kind === 'workhub_result',
      );
      assert.equal(notifications.length, 3);
      for (const [index, id] of ids.entries()) {
        const matched = notifications.filter(
          (message) =>
            message.type === 'user' &&
            message.origin?.kind === 'workhub_result' &&
            message.origin.targetSessionId === id,
        );
        assert.equal(matched.length, 1);
        const notification = matched[0];
        assert.ok(notification?.type === 'user');
        assert.match(notification.text, new RegExp(`independent-${index}`));
        const users = (await manager.getMessages(id)).filter((message) => message.type === 'user');
        assert.equal(users.length, 1);
      }
    } finally {
      coordinatorRelease.resolve();
      workerRelease.resolve();
      await desktop.close();
      await composition.close();
    }
  }, homedir());
});

test('WorkHub unavailable cwd retains conservative serialization without failing Host admission', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    let drains = 0;
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      context: {
        retainUntilProcessExit: () => undefined,
        requestDrain: () => {
          drains++;
        },
      },
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(this.sessionId);
            yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'missing-cwd-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const targets: Array<Awaited<ReturnType<SessionManager['createSession']>>> = [];
      for (const name of ['Removed', 'Available']) {
        const cwd = join(root, name);
        await mkdir(cwd);
        targets.push(
          await manager.createSession({
            cwd,
            name,
            llmConnectionId: connectionId,
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            permissionMode: 'ask',
          }),
        );
      }
      await rm(join(root, 'Removed'), { recursive: true });
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      for (const [index, target] of targets.entries())
        await delegateWorkHubTarget(
          composition,
          context,
          target.id,
          `missing-${index}`,
          'Continue',
        );
      await waitFor(async () => sends.length === 1);
      assert.deepEqual(sends, [targets[0]!.id]);
      assert.equal(drains, 0, 'filesystem availability must not become an authority failure');
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const assignment = await stores.sessionStore.readWorkHubAssignment('missing-0');
      assert.ok(assignment);
      const snapshot = await composition.handlers['turn.query'](
        { sessionId: targets[0]!.id, turnId: assignment.targetTurnId },
        context,
      );
      assert.ok(snapshot.ok);
      assert.ok(
        (
          await composition.handlers['turn.stop'](
            {
              sessionId: targets[0]!.id,
              turnId: assignment.targetTurnId,
              runId: snapshot.result.runId,
            },
            context,
          )
        ).ok,
      );
      await waitFor(async () => sends.length === 2);
      assert.deepEqual(
        sends,
        targets.map(({ id }) => id),
      );
      assert.equal(drains, 0);
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub direct worker directory aliases serialize while unrelated roots bypass the conflict', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const project = join(root, 'project');
    const child = join(project, 'src');
    const unrelated = join(root, 'research');
    const alias = join(root, 'project-alias');
    await mkdir(child, { recursive: true });
    await mkdir(unrelated);
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const sends: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(this.sessionId);
            yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'directory-slot-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const targets: Array<Awaited<ReturnType<SessionManager['createSession']>>> = [];
      for (const cwd of [project, alias, child, unrelated])
        targets.push(
          await manager.createSession({
            cwd,
            name: `Resource worker ${targets.length}`,
            llmConnectionId: connectionId,
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            permissionMode: 'ask',
          }),
        );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      for (const [index, target] of targets.entries())
        await delegateWorkHubTarget(
          composition,
          context,
          target.id,
          `directory-${index}`,
          `worker-${index}`,
        );
      await waitFor(async () => sends.length === 2);
      assert.deepEqual(sends, [targets[0]!.id, targets[3]!.id]);
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const stop = async (index: number) => {
        const assignment = await stores.sessionStore.readWorkHubAssignment(`directory-${index}`);
        assert.ok(assignment);
        const snapshot = await composition.handlers['turn.query'](
          { sessionId: targets[index]!.id, turnId: assignment.targetTurnId },
          context,
        );
        assert.ok(snapshot.ok);
        assert.ok(
          (
            await composition.handlers['turn.stop'](
              {
                sessionId: targets[index]!.id,
                turnId: assignment.targetTurnId,
                runId: snapshot.result.runId,
              },
              context,
            )
          ).ok,
        );
      };
      await stop(0);
      await waitFor(async () => sends.length === 3);
      assert.equal(
        sends[2],
        targets[1]!.id,
        'the alias queued first owns the resource before its descendant',
      );
      await stop(1);
      await waitFor(async () => sends.length === 4);
      assert.equal(sends[3], targets[2]!.id);
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub default concurrency admits three direct workers without blocking coordination', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    const release = deferred<void>();
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input.text);
            await Promise.race([
              release.promise,
              new Promise<void>((resolve) => {
                context.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
            yield* super.send(input);
          }
        })(context),
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-concurrency-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const targets = await Promise.all(
        Array.from({ length: 4 }, async (_, index) => {
          const cwd = join(root, `worker-${index}`);
          await mkdir(cwd);
          return manager.createSession({
            cwd,
            name: `Default worker ${index}`,
            llmConnectionId: connectionId,
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            permissionMode: 'ask',
          });
        }),
      );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      for (const [index, target] of targets.entries()) {
        const accepted = await actWorkHub(
          composition,
          {
            actionId: `concurrent-${index}`,
            userText: `worker-${index}`,
            proposal: { disposition: 'delegate_existing', sessionRef: target.id },
          },
          context,
        );
        assert.ok(accepted.ok, JSON.stringify(accepted));
      }
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const assignment = await stores.sessionStore.readWorkHubAssignment('concurrent-3');
      assert.ok(assignment);
      const queued = await composition.handlers['turn.query'](
        { sessionId: targets[3]!.id, turnId: assignment.targetTurnId },
        context,
      );
      assert.ok(queued.ok, JSON.stringify(queued));
      assert.equal(
        queued.result.status,
        'admitted',
        'a fourth accepted worker must not dispatch yet',
      );
      assert.deepEqual(sends, ['worker-0', 'worker-1', 'worker-2']);
      release.resolve();
      await waitFor(async () => sends.length === 4);
      assert.equal(sends[3], 'worker-3');
    } finally {
      release.resolve();
      await composition.close();
    }
  });
});

for (const limit of [1, 2, 8]) {
  test(`WorkHub concurrency ${limit} holds direct roots and cancels queued work before dispatch`, {
    timeout: 30_000,
  }, async () => {
    await withCompositionRoot(async ({ root, owner }) => {
      const connectionId = await configureFakeDefaultTarget(owner);
      const sends: string[] = [];
      let drainRequested = false;
      const { composition, manager } = await createCapturedExecutionComposition(owner, {
        context: {
          requestDrain: () => {
            drainRequested = true;
          },
          retainUntilProcessExit: () => undefined,
        },
        primaryBackendFactory: (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              sends.push(this.sessionId);
              yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
            }
          })(context),
      });
      const context = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'workhub-pool-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      try {
        await setWorkHubConcurrency(composition, context, limit);
        const targets = await Promise.all(
          Array.from({ length: limit + 1 }, async (_, index) => {
            const cwd = join(root, `worker-${index}`);
            await mkdir(cwd);
            return manager.createSession({
              cwd,
              name: `Pool worker ${index}`,
              llmConnectionId: connectionId,
              llmConnectionSlug: 'fake',
              model: 'fake-model',
              permissionMode: 'ask',
            });
          }),
        );
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        for (const [index, target] of targets.entries())
          await delegateWorkHubTarget(
            composition,
            context,
            target.id,
            `pool-${index}`,
            `worker-${index}`,
          );
        await waitFor(async () => sends.length === limit);
        const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const queued = await stores.sessionStore.readWorkHubAssignment(`pool-${limit}`);
        assert.ok(queued);
        const snapshot = await composition.handlers['turn.query'](
          { sessionId: queued.targetSessionId, turnId: queued.targetTurnId },
          context,
        );
        assert.ok(snapshot.ok, JSON.stringify(snapshot));
        assert.equal(snapshot.result.status, 'admitted');
        const stopped = await composition.handlers['turn.stop'](
          {
            sessionId: queued.targetSessionId,
            turnId: queued.targetTurnId,
            runId: snapshot.result.runId,
          },
          context,
        );
        assert.ok(stopped.ok, JSON.stringify(stopped));
        assert.equal(stopped.result.status, 'cancelled');
        assert.ok(
          !sends.includes(queued.targetSessionId),
          'cancelled queued roots must not call a backend',
        );
        assert.equal(drainRequested, false);
        // A normal user Turn in another Session is deliberately outside this budget.
        const manual = await manager.createSession({
          cwd: root,
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
        const started = await composition.handlers['turn.start'](
          {
            sessionId: manual.id,
            turnId: 'manual-outside-pool',
            content: { text: FAKE_HOLD_OPEN_PROMPT },
          },
          context,
        );
        assert.ok(started.ok, JSON.stringify(started));
        assert.ok(sends.includes(manual.id));
      } finally {
        await composition.close();
      }
    });
  });
}

test('WorkHub concurrency raises immediately, lowers without killing and releases exact terminal roots', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(this.sessionId);
            yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
          }
        })(context),
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-resize-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      await setWorkHubConcurrency(composition, context, 1);
      const targets = await Promise.all(
        Array.from({ length: 3 }, async (_, index) => {
          const cwd = join(root, `worker-${index}`);
          await mkdir(cwd);
          return manager.createSession({
            cwd,
            name: `Resize worker ${index}`,
            llmConnectionId: connectionId,
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            permissionMode: 'ask',
          });
        }),
      );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      for (const [index, target] of targets.entries())
        await delegateWorkHubTarget(
          composition,
          context,
          target.id,
          `resize-${index}`,
          `worker-${index}`,
        );
      await waitFor(async () => sends.length === 1);
      await setWorkHubConcurrency(composition, context, 2);
      await waitFor(async () => sends.length === 2);
      await setWorkHubConcurrency(composition, context, 1);
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const identities = await Promise.all(
        targets.map(async (target, index) => {
          const assignment = await stores.sessionStore.readWorkHubAssignment(`resize-${index}`);
          assert.ok(assignment);
          const queried = await composition.handlers['turn.query'](
            { sessionId: target.id, turnId: assignment.targetTurnId },
            context,
          );
          assert.ok(queried.ok, JSON.stringify(queried));
          return {
            sessionId: target.id,
            turnId: assignment.targetTurnId,
            runId: queried.result.runId,
            status: queried.result.status,
          };
        }),
      );
      assert.deepEqual(
        identities.map((entry) => entry.status),
        ['running', 'running', 'admitted'],
      );
      assert.ok((await composition.handlers['turn.stop'](identities[0]!, context)).ok);
      assert.equal(
        sends.length,
        2,
        'lowering must not start work while the remaining slot is occupied',
      );
      assert.ok((await composition.handlers['turn.stop'](identities[1]!, context)).ok);
      await waitFor(async () => sends.length === 3);
      assert.deepEqual(
        sends,
        targets.map((target) => target.id),
      );
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub concurrency retains a live user question until its original answer settles', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input.text);
            yield* super.send(input);
          }
        })(context),
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-question-pool-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      await setWorkHubConcurrency(composition, context, 1);
      const first = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const second = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(
        composition,
        context,
        first.id,
        'pool-question',
        FAKE_ASK_USER_QUESTION_PROMPT,
      );
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      await waitFor(async () => {
        const pending = await stores.interactionStore.listPending({ sessionId: first.id });
        const catalog = await stores.sessionStore.readCatalogRecord(first.id);
        return pending.length === 1 && catalog.header.status === 'waiting_for_user';
      });
      await delegateWorkHubTarget(
        composition,
        context,
        second.id,
        'pool-after-question',
        'Only after the answer',
      );
      const assignment = await stores.sessionStore.readWorkHubAssignment('pool-after-question');
      assert.ok(assignment);
      const queried = await composition.handlers['turn.query'](
        { sessionId: second.id, turnId: assignment.targetTurnId },
        context,
      );
      assert.ok(queried.ok, JSON.stringify(queried));
      assert.equal(queried.result.status, 'admitted');
      const question = (await stores.interactionStore.listPending({ sessionId: first.id }))[0]!;
      assert.ok(
        (
          await composition.handlers['interaction.answer'](
            {
              sessionId: first.id,
              interactionId: question.requestId,
              answer: { kind: 'question', answers: ['邀请制', '本周', '是'] },
            },
            context,
          )
        ).ok,
      );
      await waitFor(async () => sends.length === 2);
      assert.deepEqual(sends, [FAKE_ASK_USER_QUESTION_PROMPT, 'Only after the answer']);
    } finally {
      await composition.close();
    }
  });
});

test('WorkHub concurrency releases failed roots and places same-Session successors behind other ready work', {
  timeout: 20_000,
}, async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const sends: string[] = [];
    const releases = new Map(
      ['fail-first', 'next-first', 'other'].map((text) => [text, deferred<void>()]),
    );
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input.text);
            await releases.get(input.text)!.promise;
            yield* super.send({
              ...input,
              text:
                input.text === 'fail-first'
                  ? `${FAKE_ERROR_PROMPT_PREFIX}expected failure`
                  : input.text,
            });
          }
        })(context),
    });
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-fair-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    try {
      await setWorkHubConcurrency(composition, context, 1);
      const targets = await Promise.all(
        Array.from({ length: 2 }, () =>
          manager.createSession({
            cwd: root,
            llmConnectionId: connectionId,
            llmConnectionSlug: 'fake',
            model: 'fake-model',
            permissionMode: 'ask',
          }),
        ),
      );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(composition, context, targets[0]!.id, 'fair-first', 'fail-first');
      await delegateWorkHubTarget(
        composition,
        context,
        targets[0]!.id,
        'fair-successor',
        'next-first',
      );
      await delegateWorkHubTarget(composition, context, targets[1]!.id, 'fair-other', 'other');
      assert.deepEqual(sends, ['fail-first']);
      releases.get('fail-first')!.resolve();
      await waitFor(async () => sends.length === 2);
      assert.deepEqual(sends, ['fail-first', 'other']);
      releases.get('other')!.resolve();
      await waitFor(async () => sends.length === 3);
      assert.deepEqual(sends, ['fail-first', 'other', 'next-first']);
      releases.get('next-first')!.resolve();
    } finally {
      for (const release of releases.values()) release.resolve();
      await composition.close();
    }
  });
});

test('one coordinator Root establishes independent native tasks and supplements queued A without another assignment', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const release = deferred<void>();
    const sends: Array<{ sessionId: string; text: string }> = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push({ sessionId: backendContext.sessionId, text: input.text });
            if (input.text === 'manual-capacity-holder') await release.promise;
            yield* super.send(input);
          }
        })(backendContext),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'work-objectives-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    const desktop = composition.clientCapabilities!.attachConnection(
      clientCapabilityConnectionIdentity(context.connectionId),
      { send: async () => {} },
    );
    try {
      assert.ok(
        (
          await composition.handlers['client.capability.replace'](
            {
              registrationId: randomUUID(),
              offers: workHubDesktopCapabilityOffers(),
            },
            context,
          )
        ).ok,
      );
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await setWorkHubConcurrency(composition, context, 1);
      const manual = await manager.createSession({
        cwd: root,
        name: 'Unrelated capacity owner',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      assert.ok(
        (
          await composition.handlers['turn.start'](
            {
              sessionId: manual.id,
              turnId: 'manual-holder',
              content: { text: 'manual-capacity-holder' },
            },
            context,
          )
        ).ok,
      );
      await waitFor(async () => sends.length === 1);
      const userText = 'Inspect A and summarize unrelated B. Add the details to A.';
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            {
              turnId: 'batch-objectives',
              text: userText,
            },
            context,
          )
        ).ok,
      );
      for (const [actionId, text] of [
        ['batch-a', 'batch objective A'],
        ['batch-b', 'batch objective B'],
      ]) {
        const base = {
          turnId: 'batch-objectives',
          actionId: actionId!,
          title: 'Same title',
          text: text!,
        };
        const result = await composition.handlers['workhub.tasks.start'](
          actionId === 'batch-a'
            ? { ...base, sessionRef: manual.id }
            : {
                ...base,
                create: { workspace: { kind: 'isolated' } },
                newWorkDefaults: {
                  permissionMode: 'ask',
                  model: {
                    llmConnectionId: connectionId,
                    llmConnectionSlug: 'fake',
                    model: 'fake-model',
                  },
                },
              },
          context,
        );
        assert.ok(result.ok, JSON.stringify(result));
      }
      const page = await composition.handlers['workhub.tasks.find']({}, context);
      assert.ok(page.ok, JSON.stringify(page));
      assert.deepEqual(
        page.result.items
          .filter((item) => item.kind === 'task')
          .map((item) => item.id)
          .sort(),
        ['batch-a', 'batch-b'],
      );
      const authority = await stores.agentRunStore.readRootTurnAdmission(
        WORKHUB_COORDINATION_SESSION_ID,
        'batch-objectives',
      );
      assert.ok(authority?.userMessageId);
      const a = (await stores.sessionStore.readWorkHubAssignment('batch-a'))!;
      const b = (await stores.sessionStore.readWorkHubAssignment('batch-b'))!;
      for (const id of ['batch-a', 'batch-b']) {
        const source = (await stores.sessionStore.readWorkHubAssignment(id))!;
        assert.equal(source.userText, userText);
        assert.equal(source.work?.sourceMessageId, authority.userMessageId);
      }
      const continued = await composition.handlers['workhub.tasks.continue'](
        {
          turnId: 'batch-objectives',
          actionId: 'batch-a-followup',
          taskId: 'batch-a',
          text: 'A follow-up details',
          container: 'reuse',
        },
        context,
      );
      assert.ok(continued.ok && continued.result.container === 'reuse', JSON.stringify(continued));
      assert.equal(continued.result.input.mode, 'queued_supplement');
      assert.equal(continued.result.input.targetSessionId, a.targetSessionId);
      assert.equal(continued.result.input.targetMessageId, a.targetMessageId);
      const accepted = await stores.sessionStore.readWorkHubTaskInput('batch-a-followup');
      assert.equal(accepted?.mode, 'queued_supplement');
      assert.equal(accepted?.sourceActionId, a.actionId);
      assert.equal(accepted?.originalUserText, userText);
      assert.equal(await stores.sessionStore.readWorkHubAssignment('batch-a-followup'), undefined);
      assert.equal(
        (await stores.sessionStore.readLatestWorkHubAssignment('batch-a'))?.actionId,
        a.actionId,
      );
      // Manual execution does not consume WorkHub capacity; only A shares its Session FIFO.
      await waitFor(async () => sends.length === 2, 10000);
      assert.deepEqual(sends, [
        { sessionId: manual.id, text: 'manual-capacity-holder' },
        { sessionId: b.targetSessionId, text: 'batch objective B' },
      ]);
      assert.notEqual(b.targetSessionId, a.targetSessionId);
      const pending = await stores.sessionStore.readMessageAdmission(
        a.targetSessionId,
        a.targetMessageId,
      );
      assert.equal(pending?.placement, 'next_turn');
      assert.match(JSON.stringify(pending?.content), /batch objective A[\s\S]*A follow-up details/);
      release.resolve();
      await waitFor(async () => sends.length === 3, 10000);
      assert.equal(sends[2]!.sessionId, a.targetSessionId);
      assert.match(sends[2]!.text, /batch objective A[\s\S]*A follow-up details/);
      await waitFor(async () => {
        const delivered = await composition.handlers['workhub.tasks.input.read'](
          { workId: 'batch-a', inputId: 'batch-a-followup' },
          context,
        );
        return delivered.ok && delivered.result.delivery === 'delivered';
      });
      const facts = await stores.sessionStore.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID);
      assert.equal(
        facts.filter(
          (message) =>
            message.type === 'workhub_coordination' && message.kind === 'delegation_assigned',
        ).length,
        2,
      );
      assert.equal(
        facts.filter(
          (message) => message.type === 'workhub_coordination' && message.kind === 'task_input',
        ).length,
        1,
      );
    } finally {
      release.resolve();
      await desktop.close();
      await composition.close();
    }
  });
});

for (const { entry, finalBoundary } of (['native', 'task-aware', 'model'] as const).flatMap(
  (entry) => [false, true].map((finalBoundary) => ({ entry, finalBoundary })),
))
  test(`${entry} task input reaches the next actual provider request without another coordinator request${finalBoundary ? ' and retains work ownership after the final pull' : ''}`, async (t) => {
    const firstRequest = deferred<void>();
    const releaseFirst = deferred<void>();
    const beforeTerminal = deferred<void>();
    const releaseTerminal = deferred<void>();
    if (finalBoundary) {
      // Pause the public native backend stream after its last provider/steering
      // boundary, before the Host terminal transition. Do not manufacture events.
      const original = AiSdkBackend.prototype.send;
      AiSdkBackend.prototype.send = async function* (input) {
        for await (const event of original.call(this, input)) {
          if (input.text === 'NATIVE_TASK_INPUT' && event.type === 'complete') {
            beforeTerminal.resolve();
            await releaseTerminal.promise;
          }
          yield event;
        }
      };
      t.after(() => {
        AiSdkBackend.prototype.send = original;
      });
    }
    const workerRequests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    const errors: unknown[] = [];
    let coordinatorRequests = 0;
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) body += chunk.toString();
        const input = JSON.parse(body);
        const coordinator = isWorkHubCoordinatorFixtureRequest(input);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({
            id: 'task-input-step',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        if (coordinator) {
          coordinatorRequests++;
          response.write(chunk({ role: 'assistant', content: 'Coordinating other input.' }, null));
          await new Promise<void>((resolve) => response.on('close', resolve));
          return;
        }
        workerRequests.push(input);
        const first = workerRequests.length === 1;
        if (finalBoundary && workerRequests.length === 2) {
          response.write(chunk({ role: 'assistant', content: 'Continuing the correction.' }, null));
          await new Promise<void>((resolve) => response.on('close', resolve));
          return;
        }
        if (first) {
          assert.ok(
            input.tools?.some(
              (item: { function: { name: string } }) => item.function.name === 'tool_search',
            ),
          );
          firstRequest.resolve();
          await releaseFirst.promise;
        }
        response.write(
          chunk(
            first && !finalBoundary
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'read-tool-search',
                      type: 'function',
                      function: {
                        name: 'tool_search',
                        arguments: JSON.stringify({ query: 'Read' }),
                      },
                    },
                  ],
                }
              : { role: 'assistant', content: 'Completed using the user correction.' },
            null,
          ),
        );
        response.write(chunk({}, first && !finalBoundary ? 'tool_calls' : 'stop'));
        response.end('data: [DONE]\n\n');
      })().catch((error) => {
        errors.push(error);
        response.destroy(error as Error);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          releaseFirst.resolve();
          releaseTerminal.resolve();
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await withCompositionRoot(async ({ owner }) => {
      const connectionId = await configureFakeDefaultTarget(
        owner,
        ['fake-model'],
        `http://127.0.0.1:${address.port}/v1`,
      );
      const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'native-input-provider-client',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      const desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      try {
        await composition.recover();
        if (finalBoundary) await setWorkHubConcurrency(composition, context, 1);
        assert.ok(
          (
            await composition.handlers['client.capability.replace'](
              { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
              context,
            )
          ).ok,
        );
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        assert.ok(
          (
            await composition.handlers['workhub.coordination.answer'](
              {
                turnId: 'input-provider-coordinator',
                text: 'Coordinate this task and remain available for other requests.',
              },
              context,
            )
          ).ok,
        );
        const assigned = await composition.handlers['workhub.tasks.start'](
          {
            turnId: 'input-provider-coordinator',
            actionId: 'input-provider-task',
            title: 'Native task input',
            text: 'NATIVE_TASK_INPUT',
            create: { workspace: { kind: 'isolated' } },
            newWorkDefaults: {
              permissionMode: 'ask',
              model: {
                llmConnectionId: connectionId,
                llmConnectionSlug: 'fake',
                model: 'fake-model',
              },
            },
          },
          context,
        );
        assert.ok(assigned.ok, JSON.stringify(assigned));
        const a = await stores.sessionStore.readWorkHubAssignment('input-provider-task');
        assert.ok(a);
        await withTimeout(
          firstRequest.promise,
          10000,
          'Worker did not send its first provider request',
        );
        assert.doesNotMatch(JSON.stringify(workerRequests[0]), /CORRECTION_INPUT/);
        if (finalBoundary) {
          releaseFirst.resolve();
          await withTimeout(
            beforeTerminal.promise,
            10000,
            'Native backend did not reach its final boundary',
          );
        }
        const source = {
          inputId: 'provider-correction',
          workId: a.work!.id,
          generationId: a.work!.generationId,
          sourceActionId: a.actionId,
          sourceDelegationId: a.delegationId,
          text: 'CORRECTION_INPUT: use the new user evidence.',
        };
        const send = async () => {
          if (entry === 'model') {
            const outcome = await composition.handlers['workhub.tasks.continue'](
              {
                turnId: 'input-provider-coordinator',
                actionId: source.inputId,
                taskId: source.workId,
                text: source.text,
              },
              context,
            );
            if (!outcome.ok) return outcome;
            assert.equal(outcome.result.container, 'reuse');
            if (outcome.result.container !== 'reuse')
              assert.fail('Expected an ordinary task input');
            return { ok: true as const, result: outcome.result.input };
          }
          return composition.handlers['workhub.tasks.send'](
            entry === 'native'
              ? source
              : {
                  inputId: source.inputId,
                  workId: source.workId,
                  generationId: source.generationId,
                  text: source.text,
                },
            context,
          );
        };
        const accepted = await send();
        assert.ok(accepted.ok, JSON.stringify(accepted));
        assert.equal(accepted.result.mode, 'steering');
        assert.equal(accepted.result.delivery, 'queued');
        const fact = await stores.sessionStore.readWorkHubTaskInput(source.inputId);
        assert.equal(
          fact?.originalUserText,
          entry === 'native'
            ? undefined
            : entry === 'model'
              ? 'Coordinate this task and remain available for other requests.'
              : source.text,
        );
        assert.equal(fact?.inputOrigin, entry === 'native' ? undefined : 'user');
        assert.equal(workerRequests.length, 1, 'an already-sent request cannot be rewritten');
        assert.equal(coordinatorRequests, 1, 'direct input does not create a coordinator request');
        releaseFirst.resolve();
        releaseTerminal.resolve();
        await waitFor(async () => workerRequests.length === 2, 10000);
        assert.match(JSON.stringify(workerRequests[1]), /CORRECTION_INPUT/);
        assert.equal(
          workerRequests[1]!.messages.filter((message) =>
            JSON.stringify(message).includes('CORRECTION_INPUT'),
          ).length,
          1,
        );
        await waitFor(async () => {
          const turn = await composition.handlers['turn.query'](
            { sessionId: a.targetSessionId, turnId: a.targetTurnId },
            context,
          );
          return turn.ok && turn.result.status === 'completed';
        }, 10000);
        const delivered = await composition.handlers['workhub.tasks.input.read'](
          { workId: source.workId, inputId: source.inputId },
          context,
        );
        assert.ok(delivered.ok, JSON.stringify(delivered));
        assert.equal(delivered.result.delivery, 'delivered');
        assert.deepEqual(await send(), delivered);
        if (finalBoundary) {
          const task = await composition.handlers['workhub.tasks.read'](
            { actionId: a.actionId, delegationId: a.delegationId },
            context,
          );
          assert.ok(task.ok, JSON.stringify(task));
          assert.equal(
            task.result.task.execution?.turnId,
            delivered.result.execution?.turnId,
            'the folded correction is still the same work',
          );
          assert.equal(task.result.task.status, 'running');
          const history = await composition.handlers['workhub.tasks.executions'](
            { actionId: a.actionId, delegationId: a.delegationId },
            context,
          );
          assert.ok(history.ok, JSON.stringify(history));
          assert.deepEqual(
            history.result.executions.map((item) => item.turnId),
            [a.targetTurnId, delivered.result.execution!.turnId],
          );
          const b = await composition.handlers['workhub.tasks.start'](
            {
              turnId: 'input-provider-coordinator',
              actionId: 'input-independent-b',
              title: 'Independent B',
              text: 'INDEPENDENT_B',
              create: { workspace: { kind: 'isolated' } },
              newWorkDefaults: {
                permissionMode: 'ask',
                model: {
                  llmConnectionId: connectionId,
                  llmConnectionSlug: 'fake',
                  model: 'fake-model',
                },
              },
            },
            context,
          );
          assert.ok(b.ok, JSON.stringify(b));
          const bSource = await stores.sessionStore.readWorkHubAssignment('input-independent-b');
          assert.ok(bSource);
          await waitFor(async () => {
            const state = await composition.handlers['workhub.tasks.read'](
              { actionId: bSource.actionId, delegationId: bSource.delegationId },
              context,
            );
            return state.ok && state.result.task.waitReason === 'concurrency';
          });
          assert.equal(
            workerRequests.length,
            2,
            'the correction successor still consumes the single worker slot',
          );
          const stop = await composition.handlers['workhub.tasks.stop'](
            {
              turnId: 'input-provider-coordinator',
              actionId: 'input-stop-a',
              taskIds: [a.work!.id],
            },
            context,
          );
          assert.ok(stop.ok && stop.result.kind === 'result', JSON.stringify(stop));
          assert.equal(stop.result.targets[0]?.outcome, 'stop_delivered');
          assert.equal(
            (await stores.sessionStore.readWorkHubStopResolution(a.delegationId))?.outcome,
            'stop_delivered',
          );
          const stopped = await composition.handlers['turn.query'](
            { sessionId: a.targetSessionId, ...delivered.result.execution! },
            context,
          );
          assert.ok(stopped.ok);
          assert.equal(stopped.result.status, 'cancelled');
          await waitFor(async () => workerRequests.length === 3, 10000);
        }
        assert.equal(workerRequests.length, finalBoundary ? 3 : 2);
        assert.equal(coordinatorRequests, 1);
        assert.deepEqual(errors, []);
        assert.equal(
          (await stores.sessionStore.readHeaderSnapshot(a.targetSessionId)).permissionMode,
          'ask',
        );
      } finally {
        releaseFirst.resolve();
        releaseTerminal.resolve();
        await desktop.close();
        await composition.close();
      }
    });
  });

test('a pre-commit legacy task input claim survives protocol decoding and Host restart without changing its fingerprint', async (t) => {
  let executions: RootTurnCoordinator | undefined;
  const readRoot = RootTurnCoordinator.prototype.readRootState;
  t.mock.method(
    RootTurnCoordinator.prototype,
    'readRootState',
    function (this: RootTurnCoordinator, sessionId: string) {
      executions = this;
      return readRoot.call(this, sessionId);
    },
  );
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    let { composition, manager } = await createCapturedExecutionComposition(owner);
    let database: DatabaseSync | undefined;
    const context: ConnectionContext = {
      hostEpoch: 'test',
      connectionId: 'legacy-input-recovery',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const target = await manager.createSession({
        cwd: root,
        name: 'Legacy input',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(composition, context, target.id, 'legacy-source-work', 'Seed');
      assert.ok(executions);
      await waitFor(async () => executions!.readRootState(target.id).kind === 'idle');
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const a = await stores.sessionStore.readWorkHubAssignment('legacy-source-work');
      assert.ok(a?.work);
      // Exact released protocol order, before the new four-field send existed.
      const original = {
        workId: a.work.id,
        generationId: a.work.generationId,
        sourceActionId: a.actionId,
        sourceDelegationId: a.delegationId,
        inputId: 'legacy-precommit-input',
        text: 'Done',
      };
      const hash = createHash('sha256').update(original.inputId).digest('hex').slice(0, 48);
      const internalActionId = `whtinput_${hash}`;
      database = new DatabaseSync(join(root, 'runtime.sqlite'));
      database.exec(`CREATE TRIGGER legacy_input_precommit_failure BEFORE INSERT ON session_messages
        WHEN NEW.message_id = 'whti_${hash}'
        BEGIN SELECT RAISE(ABORT, 'legacy_input_precommit_failure'); END;`);
      const failed = await composition.handlers['workhub.tasks.send'](original, context);
      assert.ok(
        !failed.ok,
        'the fixture must stop after the action claim, before the atomic input/assignment commit',
      );
      assert.equal(await stores.sessionStore.readWorkHubTaskInput(original.inputId), undefined);
      assert.equal(await stores.sessionStore.readWorkHubAssignment(internalActionId), undefined);
      const claim = await stores.sessionStore.readWorkHubActionClaim(internalActionId);
      assert.ok(claim);
      database.exec('DROP TRIGGER legacy_input_precommit_failure');
      database.close();
      database = undefined;
      await composition.close();
      ({ composition, manager } = await createCapturedExecutionComposition(owner));
      const resumedStores = await openInteractiveExecutionStoresForWrite(owner.lease);
      assert.deepEqual(
        await resumedStores.sessionStore.readWorkHubActionClaim(internalActionId),
        claim,
      );
      const decoded = WORKHUB_TASK_INPUT_OPERATION_SPECS['workhub.tasks.send'].decodeInput({
        inputId: original.inputId,
        text: original.text,
        generationId: original.generationId,
        sourceDelegationId: original.sourceDelegationId,
        workId: original.workId,
        sourceActionId: original.sourceActionId,
      });
      const accepted = await composition.handlers['workhub.tasks.send'](decoded, context);
      assert.ok(accepted.ok, JSON.stringify(accepted));
      assert.equal(accepted.result.mode, 'continuation');
      assert.deepEqual(
        await resumedStores.sessionStore.readWorkHubActionClaim(internalActionId),
        claim,
        'the pre-upgrade claim is not replaced or rehashed',
      );
      assert.equal(
        (await resumedStores.sessionStore.readLatestWorkHubAssignment(a.work.id))?.actionId,
        internalActionId,
      );
      const replay = await composition.handlers['workhub.tasks.send'](decoded, context);
      assert.ok(replay.ok, JSON.stringify(replay));
      for (const key of [
        'inputId',
        'workId',
        'generationId',
        'sourceActionId',
        'sourceDelegationId',
        'acceptedAt',
        'mode',
        'targetSessionId',
        'targetMessageId',
      ] as const)
        assert.equal(
          replay.result[key],
          accepted.result[key],
          'immutable acceptance does not change as delivery advances',
        );
      await waitFor(async () => manager.runningTurnIds(target.id).length === 0);
      const runs = await resumedStores.runtimeEventStore.listSessionInvocations(target.id);
      assert.equal(runs.length, 2, 'only the original Seed and one recovered input execute');
      assert.equal(
        (await resumedStores.sessionStore.readHeaderSnapshot(target.id)).permissionMode,
        'ask',
      );
    } finally {
      database?.close();
      await composition.close();
    }
  });
});

for (const { entry, pendingStop } of [
  ...(['pane', 'model', 'fresh'] as const).map((entry) => ({ entry, pendingStop: false })),
  ...(['fresh', 'legacy'] as const).map((entry) => ({ entry, pendingStop: true })),
])
  test(`task-centric ${entry} input ${pendingStop ? 'rejects a newer unresolved Stop despite older terminal receipts' : 'continues settled stopped work without resuming old tools or replaying a stop on the successor'}`, async (t) => {
    let executions: RootTurnCoordinator | undefined;
    const readRoot = RootTurnCoordinator.prototype.readRootState;
    t.mock.method(
      RootTurnCoordinator.prototype,
      'readRootState',
      function (this: RootTurnCoordinator, sessionId: string) {
        executions = this;
        return readRoot.call(this, sessionId);
      },
    );
    await withCompositionRoot(async ({ root, owner }) => {
      const connectionId = await configureFakeDefaultTarget(owner);
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const first = deferred<void>(),
        second = deferred<void>(),
        releaseSecond = deferred<void>();
      const seen: BackendSendInput[] = [];
      const { composition, manager } = await createCapturedExecutionComposition(owner, {
        safeBoundaryResume: false,
        primaryBackendFactory: (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              seen.push(input);
              if (input.text === 'Original stopped objective') {
                first.resolve();
                yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
                return;
              }
              if (input.text.startsWith('Ordinary task continuation')) {
                second.resolve();
                await releaseSecond.promise;
                // The fake otherwise echoes a fresh history reference at
                // 9 characters / 45ms. Keep its reply, not its actual input
                // captured above, bounded independently of context length.
                yield* super.send({ ...input, text: 'Done' });
                return;
              }
              yield* super.send(input);
            }
          })(context),
        coordinationBackendFactory: (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
            }
          })(context),
      });
      const context: ConnectionContext = {
        hostEpoch: 'test',
        connectionId: 'common-stopped-input',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      let desktop:
        | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
        | undefined;
      try {
        const target = await manager.createSession({
          cwd: root,
          name: 'Stopped objective',
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        await delegateWorkHubTarget(
          composition,
          context,
          target.id,
          'stopped-objective',
          'Original stopped objective',
        );
        await first.promise;
        desktop = composition.clientCapabilities!.attachConnection(
          clientCapabilityConnectionIdentity(context.connectionId),
          { send: async () => {} },
        );
        const source = await stores.sessionStore.readWorkHubAssignment('stopped-objective');
        assert.ok(source?.work);
        assert.ok(
          (
            await composition.handlers['client.capability.replace'](
              { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
              context,
            )
          ).ok,
        );
        assert.ok(
          (
            await composition.handlers['workhub.coordination.answer'](
              {
                turnId: 'stopped-input-coordinator',
                text: 'Stop this task, then continue the same objective with the new requirement.',
              },
              context,
            )
          ).ok,
        );
        const sessionsBefore = (await stores.sessionStore.listHeaders()).length;
        const busy = await composition.handlers['workhub.tasks.continue'](
          {
            turnId: 'stopped-input-coordinator',
            actionId: 'busy-fresh',
            taskId: source.work.id,
            text: 'Do not create while busy',
            container: 'fresh',
          },
          context,
        );
        assert.ok(!busy.ok, JSON.stringify(busy));
        assert.equal(await stores.sessionStore.readWorkHubAssignment('busy-fresh'), undefined);
        assert.equal((await stores.sessionStore.listHeaders()).length, sessionsBefore);
        const stopInput: WorkHubTaskStopInput = {
          turnId: 'stopped-input-coordinator',
          actionId: 'stop-original-task',
          taskIds: [source.work.id],
        };
        const stopped = await composition.handlers['workhub.tasks.stop'](stopInput, context);
        assert.ok(stopped.ok && stopped.result.kind === 'result', JSON.stringify(stopped));
        assert.equal(stopped.result.targets[0]?.outcome, 'stop_delivered');
        assert.ok(executions);
        await waitFor(async () => executions!.readRootState(target.id).kind === 'idle');
        if (pendingStop) {
          const noop = await composition.handlers['workhub.tasks.stop'](
            {
              turnId: 'stopped-input-coordinator',
              actionId: 'terminal-noop',
              taskIds: [source.work.id],
            },
            context,
          );
          assert.ok(noop.ok && noop.result.kind === 'result', JSON.stringify(noop));
          assert.equal(noop.result.targets[0]?.outcome, 'already_terminal');
          const firstStop = await stores.sessionStore.readWorkHubStopRequest(source.delegationId);
          assert.ok(firstStop?.executionBinding);
          assert.ok(firstStop.stopSet);
          // A constructed, immutable crash-window fact: actual Stop delivery is
          // covered above; continuation admission and its effects below are real.
          const actionId = 'unfinished-stop';
          const actionFingerprint =
            `sha256:${createHash('sha256').update(actionId).digest('hex')}` as const;
          await stores.sessionStore.claimWorkHubAction({
            actionId,
            operation: 'stop',
            actionFingerprint,
            subject: source.delegationId,
          });
          await stores.sessionStore.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
            {
              ...firstStop,
              taskStop: true,
              workId: source.work.id,
              actionId,
              actionFingerprint,
              stopSet: { ...firstStop.stopSet, actionId },
              id:
                'whq_' +
                createHash('sha256')
                  .update(JSON.stringify([source.delegationId, actionId]))
                  .digest('hex')
                  .slice(0, 48),
              ts: Date.now(),
            },
          ]);
          assert.equal(
            (await stores.sessionStore.readWorkHubStopRequest(source.delegationId, undefined, true))
              ?.stopSet?.actionId,
            actionId,
          );
          assert.equal(
            await stores.sessionStore.readWorkHubStopResolution(source.delegationId, actionId),
            undefined,
          );
          const beforeSessions = (await stores.sessionStore.listHeaders()).length;
          const beforeSends = seen.length;
          const attempt =
            entry === 'fresh'
              ? await composition.handlers['workhub.tasks.continue'](
                  {
                    turnId: 'stopped-input-coordinator',
                    actionId: 'must-not-continue',
                    taskId: source.work.id,
                    text: 'Ordinary task continuation must wait for Stop settlement',
                    container: 'fresh',
                  },
                  context,
                )
              : await composition.handlers['workhub.tasks.continue'](
                  {
                    turnId: 'stopped-input-coordinator',
                    actionId: 'must-not-continue',
                    taskId: source.work.id,
                    container: 'reuse',
                    text: 'Ordinary task continuation must wait for Stop settlement',
                  },
                  context,
                );
          assert.ok(
            !attempt.ok,
            'no continuation may enter while the newer Stop is unresolved: ' +
              JSON.stringify(attempt),
          );
          assert.equal(
            await stores.sessionStore.readWorkHubAssignment('must-not-continue'),
            undefined,
          );
          assert.equal((await stores.sessionStore.listHeaders()).length, beforeSessions);
          assert.equal(
            (await stores.sessionStore.readLatestWorkHubAssignment(source.work.id))?.actionId,
            source.actionId,
          );
          assert.equal(seen.length, beforeSends);
          return;
        }
        const text = 'Ordinary task continuation: apply only this new requirement';
        let targetSessionId = target.id;
        let messageId: string;
        if (entry === 'pane') {
          const outcome = await composition.handlers['workhub.tasks.send'](
            {
              inputId: 'settled-input',
              workId: source.work.id,
              generationId: source.work.generationId,
              text,
            },
            context,
          );
          assert.ok(outcome.ok, JSON.stringify(outcome));
          assert.equal(outcome.result.mode, 'continuation');
          messageId = outcome.result.targetMessageId;
        } else {
          const outcome = await composition.handlers['workhub.tasks.continue'](
            {
              turnId: 'stopped-input-coordinator',
              actionId: 'settled-input',
              taskId: source.work.id,
              text,
              container: entry === 'fresh' ? 'fresh' : 'reuse',
            },
            context,
          );
          assert.ok(outcome.ok, JSON.stringify(outcome));
          if (outcome.result.container === 'reuse') {
            assert.equal(outcome.result.input.mode, 'continuation');
            messageId = outcome.result.input.targetMessageId;
          } else {
            targetSessionId = outcome.result.action.targetSessionId;
            assert.notEqual(targetSessionId, target.id);
            assert.ok(outcome.result.action.targetMessageId);
            messageId = outcome.result.action.targetMessageId;
          }
        }
        await withTimeout(
          second.promise,
          10000,
          'The new task input did not start an ordinary execution',
        );
        const latest = await stores.sessionStore.readLatestWorkHubAssignment(source.work.id);
        assert.ok(latest?.work);
        assert.equal(latest.work.id, source.work.id);
        assert.equal(
          latest.work.generationId,
          entry === 'fresh' ? 'settled-input' : source.work.generationId,
        );
        assert.equal(latest.targetSessionId, targetSessionId);
        const proof = await stores.agentRunStore.readRootTurnSourceMessageReceipt(
          targetSessionId,
          messageId,
        );
        assert.ok(proof);
        assert.equal(
          proof.admission.execution.kind,
          'external_message',
          'normal continuation never replays a safe-boundary tool',
        );
        assert.notEqual(proof.admission.turnId, source.targetTurnId);
        if (entry !== 'fresh') {
          const accepted = await stores.sessionStore.readWorkHubTaskInput('settled-input');
          assert.ok(accepted);
          assert.equal(
            accepted.turnId,
            source.coordinationTurnId,
            'the input fact keeps its exact source binding',
          );
          assert.equal(
            latest.coordinationTurnId,
            entry === 'model' ? 'stopped-input-coordinator' : source.coordinationTurnId,
          );
          assert.equal(
            accepted.originalUserText,
            entry === 'model'
              ? 'Stop this task, then continue the same objective with the new requirement.'
              : text,
          );
        }
        assert.equal(seen.length, 2);
        assert.equal(seen.filter((input) => input.text === 'Original stopped objective').length, 1);
        assert.deepEqual(
          await composition.handlers['workhub.tasks.stop'](stopInput, context),
          stopped,
        );
        const stillRunning = await composition.handlers['turn.query'](
          {
            sessionId: targetSessionId,
            turnId: proof.admission.turnId,
          },
          context,
        );
        assert.ok(
          stillRunning.ok && stillRunning.result.status === 'running',
          JSON.stringify(stillRunning),
        );
        assert.equal(stillRunning.result.runId, proof.admission.runId);
        assert.equal(seen.length, 2, 'the old Stop neither replays a tool nor starts another task');
        const header = await stores.sessionStore.readHeaderSnapshot(targetSessionId);
        assert.equal(header.permissionMode, 'ask');
        assert.equal(header.model, 'fake-model');
        assert.equal(header.cwd, entry === 'fresh' ? await realpath(root) : root);
        releaseSecond.resolve();
        await waitFor(async () => manager.runningTurnIds(targetSessionId).length === 0);
      } finally {
        releaseSecond.resolve();
        await desktop?.close();
        await composition.close();
      }
    });
  });

for (const mode of ['single', 'set', 'cancel', 'promoted-set'] as const)
  test(`task Stop preserves same-Session FIFO and its exact receipt after coordinator end and Host restart (${mode})`, async () => {
    await withCompositionRoot(async ({ root, owner }) => {
      const connectionId = await configureFakeDefaultTarget(owner);
      let stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const release = deferred<void>();
      const finishPredecessor = deferred<void>();
      const sends: string[] = [];
      let { composition, manager } = await createCapturedExecutionComposition(owner, {
        primaryBackendFactory: (context) =>
          new (class extends FakeBackend {
            private stopRequested = deferred<void>();
            private stoppedByTest = false;
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              this.stopRequested = deferred<void>();
              this.stoppedByTest = false;
              sends.push(input.text);
              await Promise.race([
                release.promise,
                this.stopRequested.promise,
                ...(input.text === 'running-A' ? [finishPredecessor.promise] : []),
              ]);
              if (this.stoppedByTest) {
                yield {
                  type: 'abort',
                  id: randomUUID(),
                  turnId: input.turnId,
                  ts: Date.now(),
                  reason: 'user_stop',
                };
                yield {
                  type: 'complete',
                  id: randomUUID(),
                  turnId: input.turnId,
                  ts: Date.now(),
                  stopReason: 'user_stop',
                };
                return;
              }
              yield* super.send(input);
            }
            override async stop(): Promise<void> {
              this.stoppedByTest = true;
              this.stopRequested.resolve();
              await super.stop();
            }
          })(context),
        coordinationBackendFactory: (context) =>
          new (class extends FakeBackend {
            override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
              yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
            }
          })(context),
      });
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'task-stop-client',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      let desktop:
        | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
        | undefined;
      try {
        const target = await manager.createSession({
          cwd: root,
          name: 'Shared worker',
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        });
        const originalHeader = await stores.sessionStore.readHeaderSnapshot(target.id);
        const originalBoundary = await stores.sessionStore.readExecutionBoundary(target.id);
        assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
        await delegateWorkHubTarget(composition, context, target.id, 'stop-work-a', 'running-A');
        await waitFor(async () => sends.length === 1);
        await delegateWorkHubTarget(composition, context, target.id, 'stop-work-b', 'queued-B');
        await delegateWorkHubTarget(composition, context, target.id, 'stop-work-c', 'queued-C');
        const a = await stores.sessionStore.readWorkHubAssignment('stop-work-a');
        const b = await stores.sessionStore.readWorkHubAssignment('stop-work-b');
        const c = await stores.sessionStore.readWorkHubAssignment('stop-work-c');
        assert.ok(a && b && c);
        assert.deepEqual(sends, ['running-A']);
        desktop = composition.clientCapabilities!.attachConnection(
          clientCapabilityConnectionIdentity(context.connectionId),
          { send: async () => {} },
        );
        assert.ok(
          (
            await composition.handlers['client.capability.replace'](
              { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
              context,
            )
          ).ok,
        );
        const turnId = 'actual-stop-authority';
        assert.ok(
          (
            await composition.handlers['workhub.coordination.answer'](
              {
                turnId,
                text:
                  mode === 'single'
                    ? 'Stop only A, leave B/C alone.'
                    : mode === 'promoted-set'
                      ? 'Stop B/C after confirmation; A may finish naturally.'
                      : 'Stop A/B together, leave C alone.',
              },
              context,
            )
          ).ok,
        );
        const command = {
          turnId,
          actionId: 'actual-task-stop',
          taskIds:
            mode === 'single'
              ? [a.work!.id]
              : mode === 'promoted-set'
                ? [b.work!.id, c.work!.id]
                : [a.work!.id, b.work!.id],
        };
        const firstTarget = mode === 'promoted-set' ? b : a;
        const pending = composition.handlers['workhub.tasks.stop'](command, context);
        if (mode !== 'single') {
          await waitFor(
            async () =>
              (
                await stores.interactionStore.listPending({
                  sessionId: WORKHUB_COORDINATION_SESSION_ID,
                })
              ).length === 1,
          );
          assert.equal(
            await stores.sessionStore.readWorkHubStopRequest(
              firstTarget.delegationId,
              command.actionId,
            ),
            undefined,
          );
          assert.deepEqual(
            sends,
            ['running-A'],
            'neither active nor queued target changes before whole-set confirmation',
          );
          const form = (
            await stores.interactionStore.listPending({
              sessionId: WORKHUB_COORDINATION_SESSION_ID,
            })
          )[0]!;
          const offered = await composition.handlers['interaction.query'](
            { sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: form.requestId },
            context,
          );
          assert.ok(offered.ok && offered.result.request.kind === 'form');
          if (mode === 'promoted-set') {
            finishPredecessor.resolve();
            await waitFor(async () => sends.length === 2);
            assert.deepEqual(sends, ['running-A', 'queued-B']);
          }
          assert.ok(
            (
              await composition.handlers['interaction.answer'](
                {
                  sessionId: WORKHUB_COORDINATION_SESSION_ID,
                  interactionId: form.requestId,
                  answer: {
                    kind: 'form',
                    action: 'accept',
                    values: { stop: mode === 'cancel' ? 'cancel' : 'confirm' },
                  },
                },
                context,
              )
            ).ok,
          );
        }
        const first = await withTimeout(pending, 10000, 'Task Stop did not finish its exact Root');
        assert.ok(first.ok, JSON.stringify(first));
        if (mode === 'promoted-set') {
          assert.equal(first.result.kind, 'result');
          if (first.result.kind === 'result')
            assert.deepEqual(
              first.result.targets.map((row) => row.outcome),
              ['stop_delivered', 'cancelled_pending'],
            );
          assert.deepEqual(
            sends,
            ['running-A', 'queued-B'],
            'C must be withdrawn before B Stop can hand off',
          );
          assert.deepEqual(
            await composition.handlers['workhub.tasks.stop'](command, context),
            first,
          );
          await desktop.close();
          desktop = undefined;
          await composition.close();
          ({ composition, manager } = await createCapturedExecutionComposition(owner));
          stores = await openInteractiveExecutionStoresForWrite(owner.lease);
          const before = await stores.runtimeEventStore.listSessionInvocations(target.id);
          assert.deepEqual(
            await composition.handlers['workhub.tasks.stop'](command, context),
            first,
          );
          assert.deepEqual(
            await stores.runtimeEventStore.listSessionInvocations(target.id),
            before,
          );
          return;
        }
        if (mode === 'cancel') {
          assert.equal(first.result.kind, 'cancelled');
          assert.equal(
            await stores.sessionStore.readWorkHubStopRequest(a.delegationId, command.actionId),
            undefined,
          );
          assert.deepEqual(sends, ['running-A']);
          release.resolve();
          await waitFor(
            async () => sends.length === 3 && manager.runningTurnIds(target.id).length === 0,
            10000,
          );
          assert.deepEqual(sends, ['running-A', 'queued-B', 'queued-C']);
          return;
        }
        assert.equal(first.result.kind, 'result');
        if (first.result.kind === 'result')
          assert.deepEqual(
            first.result.targets.map((row) => row.outcome),
            mode === 'single' ? ['stop_delivered'] : ['stop_delivered', 'cancelled_pending'],
          );
        await waitFor(async () => sends.length === 2);
        assert.deepEqual(sends, ['running-A', mode === 'single' ? 'queued-B' : 'queued-C']);
        const currentB = manager.runningTurnIds(target.id)[0];
        assert.ok(currentB);
        assert.deepEqual(await composition.handlers['workhub.tasks.stop'](command, context), first);
        assert.deepEqual(
          manager.runningTurnIds(target.id),
          [currentB],
          'old A Stop cannot interrupt B',
        );
        if (mode === 'single')
          assert.ok(
            (await stores.sessionStore.listMessageAdmissions(target.id)).some(
              (row) => row.messageId === c.targetMessageId,
            ),
          );
        const request = await stores.sessionStore.readWorkHubStopRequest(
          a.delegationId,
          command.actionId,
        );
        assert.equal(request?.taskStop, true);
        assert.deepEqual(
          request?.stopSet?.targets.map((row) => row.sourceActionId),
          mode === 'single' ? [a.actionId] : [a.actionId, b.actionId],
        );
        const coordinatorRoot = await composition.handlers['turn.query'](
          { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId },
          context,
        );
        assert.ok(coordinatorRoot.ok);
        await composition.handlers['turn.stop'](
          {
            sessionId: WORKHUB_COORDINATION_SESSION_ID,
            turnId,
            runId: coordinatorRoot.result.runId,
          },
          context,
        );
        assert.deepEqual(
          await composition.handlers['workhub.tasks.stop'](command, context),
          first,
          'committed replay uses its immutable original Turn, not fresh routing authority',
        );
        release.resolve();
        await waitFor(
          async () =>
            sends.length === (mode === 'single' ? 3 : 2) &&
            manager.runningTurnIds(target.id).length === 0,
          10000,
        );
        assert.deepEqual(
          sends,
          mode === 'single' ? ['running-A', 'queued-B', 'queued-C'] : ['running-A', 'queued-C'],
        );
        const header = await stores.sessionStore.readHeaderSnapshot(target.id);
        assert.equal(header.permissionMode, originalHeader.permissionMode);
        assert.equal(header.model, originalHeader.model);
        assert.equal(header.cwd, originalHeader.cwd);
        assert.deepEqual(
          await stores.sessionStore.readExecutionBoundary(target.id),
          originalBoundary,
        );
        await desktop.close();
        desktop = undefined;
        await composition.close();
        ({ composition, manager } = await createCapturedExecutionComposition(owner));
        stores = await openInteractiveExecutionStoresForWrite(owner.lease);
        const before = await stores.runtimeEventStore.listSessionInvocations(target.id);
        assert.deepEqual(await composition.handlers['workhub.tasks.stop'](command, context), first);
        assert.deepEqual(await stores.runtimeEventStore.listSessionInvocations(target.id), before);
        assert.deepEqual(
          await stores.sessionStore.readWorkHubStopRequest(a.delegationId, command.actionId),
          request,
        );
      } finally {
        release.resolve();
        await desktop?.close();
        await composition.close();
      }
    });
  });

for (const entry of ['native', 'task-aware', 'model'] as const)
  test(`${entry} task input supplements queued A behind unrelated B, keeps C FIFO and continues A while coordination stays busy`, () =>
    queuedTaskInputJourney(entry));

async function queuedTaskInputJourney(entry: 'native' | 'task-aware' | 'model') {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    let stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const release = deferred<void>();
    const sends: BackendSendInput[] = [],
      coordinatorSends: string[] = [];
    let { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push(input);
            if (input.text === 'unrelated-B') await release.promise;
            yield* super.send(input);
          }
        })(context),
      coordinationBackendFactory: (context) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            coordinatorSends.push(input.text);
            yield* super.send({
              ...input,
              text: input.text.startsWith('Host task result notification.')
                ? 'Received'
                : FAKE_HOLD_OPEN_PROMPT,
            });
          }
        })(context),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'native-task-input-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    let desktop:
      | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
      | undefined;
    try {
      const target = await manager.createSession({
        cwd: root,
        name: 'Same task',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      await manager.createSession({
        cwd: root,
        name: 'Same task',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'bypass',
      });
      const boundary = await stores.sessionStore.readExecutionBoundary(target.id);
      assert.ok(
        (
          await composition.handlers['turn.start'](
            { sessionId: target.id, turnId: 'unrelated-b', content: { text: 'unrelated-B' } },
            context,
          )
        ).ok,
      );
      await waitFor(async () => sends.length === 1);
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(composition, context, target.id, 'input-work-a', 'queued-A');
      await delegateWorkHubTarget(composition, context, target.id, 'input-work-c', 'independent-C');
      desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      assert.ok(
        (
          await composition.handlers['client.capability.replace'](
            { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
            context,
          )
        ).ok,
      );
      const a = await stores.sessionStore.readWorkHubAssignment('input-work-a');
      assert.ok(a);
      const queuedIds = (await stores.sessionStore.listMessageAdmissions(target.id)).map(
        (item) => item.messageId,
      );
      assert.ok(
        (
          await composition.handlers['workhub.coordination.answer'](
            { turnId: 'busy-input-coordinator', text: 'Keep coordinating unrelated user input' },
            context,
          )
        ).ok,
      );
      await waitFor(async () =>
        coordinatorSends.includes('Keep coordinating unrelated user input'),
      );
      const count = coordinatorSends.length;
      const input = {
        inputId: 'supplement-A',
        workId: a.work!.id,
        generationId: a.work!.generationId,
        sourceActionId: a.actionId,
        sourceDelegationId: a.delegationId,
        text: 'Use the new evidence for A',
      };
      const send = async (value: typeof input) => {
        if (entry === 'model') {
          const outcome = await composition.handlers['workhub.tasks.continue'](
            {
              turnId: 'busy-input-coordinator',
              actionId: value.inputId,
              taskId: value.workId,
              text: value.text,
            },
            context,
          );
          if (!outcome.ok) return outcome;
          assert.equal(outcome.result.container, 'reuse');
          if (outcome.result.container !== 'reuse') assert.fail('Expected a reused task input');
          return { ok: true as const, result: outcome.result.input };
        }
        return composition.handlers['workhub.tasks.send'](
          entry === 'native'
            ? value
            : {
                inputId: value.inputId,
                workId: value.workId,
                generationId: value.generationId,
                text: value.text,
              },
          context,
        );
      };
      const accepted = await send(input);
      assert.ok(accepted.ok, JSON.stringify(accepted));
      assert.equal(accepted.result.mode, 'queued_supplement');
      assert.equal(accepted.result.delivery, 'queued');
      assert.equal(accepted.result.targetSessionId, target.id);
      assert.deepEqual(await send(input), accepted);
      for (const invalid of [
        { ...input, text: 'Changed under the same ID' },
        { ...input, inputId: 'foreign-input', workId: 'foreign-work' },
        ...(entry === 'native'
          ? [{ ...input, inputId: 'foreign-source', sourceDelegationId: 'foreign' }]
          : []),
        ...(entry !== 'model' ? [{ ...input, inputId: 'stale-input', generationId: 'stale' }] : []),
      ])
        assert.equal((await send(invalid)).ok, false);
      assert.ok(
        (await stores.sessionStore.listMessageAdmissions(target.id)).every(
          (item) => item.disposition === 'followup',
        ),
      );
      assert.deepEqual(
        (await stores.sessionStore.listMessageAdmissions(target.id)).map((item) => item.messageId),
        queuedIds,
      );
      assert.deepEqual(
        sends.map((item) => item.text),
        ['unrelated-B'],
      );
      assert.equal(
        coordinatorSends.length,
        count,
        'direct input neither waits for nor calls the busy coordinator',
      );
      release.resolve();
      await waitFor(async () => sends.some((item) => item.text === 'independent-C'), 10000);
      assert.deepEqual(
        sends.slice(0, 3).map((item) => item.text),
        ['unrelated-B', 'queued-A\n\nUse the new evidence for A', 'independent-C'],
      );
      const delivered = await composition.handlers['workhub.tasks.input.read'](
        { workId: input.workId, inputId: input.inputId },
        context,
      );
      assert.ok(delivered.ok, JSON.stringify(delivered));
      assert.equal(delivered.result.delivery, 'delivered');
      const continued = await send({
        ...input,
        inputId: 'after-A',
        text: 'Continue only objective A',
      });
      assert.ok(continued.ok, JSON.stringify(continued));
      assert.equal(continued.result.mode, 'continuation');
      const continuedFact = await stores.sessionStore.readWorkHubTaskInput('after-A');
      assert.equal(continuedFact?.turnId, a.coordinationTurnId);
      assert.equal(
        continuedFact?.originalUserText,
        entry === 'native'
          ? undefined
          : entry === 'model'
            ? 'Keep coordinating unrelated user input'
            : 'Continue only objective A',
      );
      assert.equal(
        (await stores.sessionStore.readLatestWorkHubAssignment(a.work!.id))?.coordinationTurnId,
        entry === 'model' ? 'busy-input-coordinator' : a.coordinationTurnId,
      );
      await waitFor(
        async () => sends.some((item) => item.text === 'Continue only objective A'),
        10000,
      );
      assert.equal(coordinatorSends.length, count);
      assert.equal(sends.filter((item) => item.text === 'Continue only objective A').length, 1);
      const header = await stores.sessionStore.readHeaderSnapshot(target.id);
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.model, 'fake-model');
      assert.equal(header.cwd, root);
      assert.deepEqual(await stores.sessionStore.readExecutionBoundary(target.id), boundary);
      await waitFor(async () => manager.runningTurnIds(target.id).length === 0);
      await desktop.close();
      await composition.close();
      ({ composition, manager } = await createCapturedExecutionComposition(owner));
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const beforeReplay = await stores.runtimeEventStore.listSessionInvocations(target.id);
      assert.deepEqual(
        entry === 'model'
          ? await composition.handlers['workhub.tasks.input.read'](
              { workId: input.workId, inputId: input.inputId },
              context,
            )
          : await send(input),
        delivered,
      );
      assert.deepEqual(
        await stores.runtimeEventStore.listSessionInvocations(target.id),
        beforeReplay,
        'a replay after restart cannot create another execution',
      );
    } finally {
      release.resolve();
      await desktop?.close();
      await composition.close();
    }
  });
}

test('native input lineage accepts its own execution history cursor across the 16-root page boundary', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const ready = Array.from({ length: 16 }, () => deferred<void>());
    const release = Array.from({ length: 16 }, () => deferred<void>());
    const turns: string[] = [];
    const { composition, manager } = await createCapturedExecutionComposition(owner, {
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            const index = turns.length;
            turns.push(input.turnId);
            if (index < 16) {
              for await (const event of super.send(input)) {
                if (event.type === 'complete') {
                  ready[index]!.resolve();
                  await release[index]!.promise;
                }
                yield event;
              }
            } else yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
          }
        })(backendContext),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'native-input-history-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const target = await manager.createSession({
        cwd: root,
        name: 'Native input pages',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(composition, context, target.id, 'native-page-a', 'R0');
      const a = await stores.sessionStore.readWorkHubAssignment('native-page-a');
      assert.ok(a);
      for (let index = 0; index < 16; index++) {
        await withTimeout(
          ready[index]!.promise,
          10000,
          `Root ${index} did not reach its final boundary`,
        );
        const accepted = await composition.handlers['workhub.tasks.send'](
          {
            inputId: `native-page-${index}`,
            workId: a.work!.id,
            generationId: a.work!.generationId,
            sourceActionId: a.actionId,
            sourceDelegationId: a.delegationId,
            text: `R${index + 1}`,
          },
          context,
        );
        assert.ok(accepted.ok, JSON.stringify(accepted));
        assert.equal(accepted.result.mode, 'steering');
        release[index]!.resolve();
      }
      await waitFor(async () => turns.length === 17, 10000);
      const read = (cursor?: string) =>
        composition.handlers['workhub.tasks.executions'](
          { actionId: a.actionId, delegationId: a.delegationId, ...(cursor ? { cursor } : {}) },
          context,
        );
      const first = await read();
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal(first.result.executions.length, 16);
      assert.ok(first.result.nextCursor);
      const second = await read(first.result.nextCursor);
      assert.ok(
        second.ok,
        `The Host must accept its own execution history cursor: ${JSON.stringify(second)}`,
      );
      assert.equal(second.result.executions.length, 1);
      assert.equal(second.result.nextCursor, null);
      assert.deepEqual(
        [...first.result.executions, ...second.result.executions].map((item) => item.turnId),
        turns,
      );
    } finally {
      for (const entry of release) entry.resolve();
      await composition.close();
    }
  });
});

test('native task input steers the exact same-name task and reconstructs accepted facts after restart', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    let stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const release = deferred<void>(),
      finishNotifications = deferred<void>();
    const residencies = new HostResidencyRegistry();
    const hostedRoots = () =>
      residencies.snapshot().find(({ label }) => label === 'hosted-execution')?.count ?? 0;
    let notificationStarted = false;
    const sends: Array<{ sessionId: string; text: string }> = [];
    let { composition, manager } = await createCapturedExecutionComposition(owner, {
      residencies,
      coordinationBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            if (input.text.startsWith('Host task result notification.')) {
              notificationStarted = true;
              await finishNotifications.promise;
            }
            yield* super.send({ ...input, text: 'Task update acknowledged.' });
          }
        })(backendContext),
      primaryBackendFactory: (backendContext) =>
        new (class extends FakeBackend {
          override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
            sends.push({ sessionId: backendContext.sessionId, text: input.text });
            if (input.text === 'original-task') await release.promise;
            yield* super.send(input);
          }
        })(backendContext),
    });
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'task-overview-client',
      principal: 'local_os_user',
      acquireResidency: () => residencies.acquire('hosted-execution'),
    };
    let desktop:
      | ReturnType<NonNullable<typeof composition.clientCapabilities>['attachConnection']>
      | undefined;
    try {
      const settings = {
        cwd: root,
        name: 'Same task name',
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask' as const,
      };
      const target = await manager.createSession(settings);
      const unrelated = await manager.createSession(settings);
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      await delegateWorkHubTarget(
        composition,
        context,
        target.id,
        'overview-source',
        'original-task',
      );
      const source = (await stores.sessionStore.readWorkHubAssignment('overview-source'))!;
      assert.ok(source.work);
      const sourceAuthority = await stores.agentRunStore.readRootTurnAdmission(
        WORKHUB_COORDINATION_SESSION_ID,
        source.coordinationTurnId,
      );
      assert.equal(source.work.sourceMessageId, sourceAuthority?.userMessageId);
      const query = async () => {
        const page = await composition.handlers['workhub.tasks.query']({}, context);
        assert.ok(page.ok, JSON.stringify(page));
        return page.result.tasks;
      };
      await waitFor(async () => sends.length === 1);
      assert.equal((await query()).length, 1);
      const input = {
        inputId: 'overview-followup',
        workId: source.work.id,
        generationId: source.work.generationId,
        text: 'followup-task',
      };
      const originalRoot = await stores.agentRunStore.readRootTurnAdmission(
        target.id,
        source.targetTurnId,
      );
      assert.ok(originalRoot);
      const originalExecution = { turnId: originalRoot.turnId, runId: originalRoot.runId };
      const liveInput = {
        ...input,
        inputId: 'overview-live-steering',
        text: 'native-live-details',
      };
      const live = await composition.handlers['workhub.tasks.send'](liveInput, context);
      assert.ok(live.ok, JSON.stringify(live));
      assert.equal(live.result.mode, 'steering');
      assert.equal(live.result.delivery, 'queued');
      assert.equal(live.result.targetSessionId, target.id);
      const liveFact = await stores.sessionStore.readWorkHubTaskInput(liveInput.inputId);
      assert.equal(liveFact?.mode, 'steering');
      assert.equal(liveFact?.sourceActionId, source.actionId);
      assert.equal(liveFact?.sourceDelegationId, source.delegationId);
      assert.deepEqual(liveFact?.execution, originalExecution);
      assert.equal(await stores.sessionStore.readWorkHubAssignment(liveInput.inputId), undefined);
      assert.equal((await query()).length, 1, 'live Steering does not create a task or later Run');
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(target.id)).length, 1);
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(unrelated.id)).length, 0);
      assert.deepEqual(
        sends.map((send) => send.text),
        ['original-task'],
      );
      desktop = composition.clientCapabilities!.attachConnection(
        clientCapabilityConnectionIdentity(context.connectionId),
        { send: async () => {} },
      );
      assert.ok(
        (
          await composition.handlers['client.capability.replace'](
            {
              registrationId: randomUUID(),
              offers: workHubDesktopCapabilityOffers(),
            },
            context,
          )
        ).ok,
      );
      release.resolve();
      await waitFor(async () => {
        const receipt = await composition.handlers['workhub.tasks.input.read'](
          { workId: liveInput.workId, inputId: liveInput.inputId },
          context,
        );
        return (
          receipt.ok &&
          receipt.result.delivery === 'delivered' &&
          manager.runningTurnIds(target.id).length === 0 &&
          notificationStarted &&
          hostedRoots() === 1
        );
      });
      const liveReceipt = await composition.handlers['workhub.tasks.input.read'](
        { workId: liveInput.workId, inputId: liveInput.inputId },
        context,
      );
      assert.ok(liveReceipt.ok, JSON.stringify(liveReceipt));
      assert.deepEqual(liveReceipt.result.execution, originalExecution);
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(target.id)).length, 1);
      // Only the held notification Root remains; target ownership and its resources are released.
      const first = await composition.handlers['workhub.tasks.send'](input, context);
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal(first.result.mode, 'continuation');
      assert.equal(first.result.targetSessionId, target.id);
      const fact = await stores.sessionStore.readWorkHubTaskInput(input.inputId);
      assert.equal(fact?.kind, 'task_input');
      assert.equal(fact?.sourceActionId, source.actionId);
      assert.equal(fact?.targetMessageId, first.result.targetMessageId);
      assert.notEqual(first.result.targetMessageId, source.targetMessageId);
      await waitFor(async () => {
        const receipt = await composition.handlers['workhub.tasks.input.read'](
          { workId: input.workId, inputId: input.inputId },
          context,
        );
        return (
          receipt.ok &&
          receipt.result.delivery === 'delivered' &&
          manager.runningTurnIds(target.id).length === 0 &&
          hostedRoots() === 1
        );
      });
      const receipt = await composition.handlers['workhub.tasks.input.read'](
        { workId: input.workId, inputId: input.inputId },
        context,
      );
      assert.ok(receipt.ok && receipt.result.execution, JSON.stringify(receipt));
      assert.deepEqual(await composition.handlers['workhub.tasks.send'](input, context), receipt);
      assert.equal(
        (
          await composition.handlers['workhub.tasks.send'](
            {
              ...input,
              text: 'changed instruction',
            },
            context,
          )
        ).ok,
        false,
      );
      assert.equal(
        (
          await composition.handlers['workhub.tasks.send'](
            {
              ...input,
              inputId: 'foreign-attempt',
              sourceActionId: source.actionId,
              sourceDelegationId: 'foreign',
            },
            context,
          )
        ).ok,
        false,
      );
      assert.ok(
        manager.runningTurnIds(WORKHUB_COORDINATION_SESSION_ID).length > 0,
        'the original notification Root is still busy',
      );
      const afterEndInput = {
        ...input,
        inputId: 'overview-after-end',
        text: 'verify-the-delivery',
      };
      const afterEnd = await composition.handlers['workhub.tasks.send'](afterEndInput, context);
      assert.ok(afterEnd.ok, JSON.stringify(afterEnd));
      assert.equal(afterEnd.result.mode, 'continuation');
      assert.equal(afterEnd.result.targetSessionId, target.id);
      await waitFor(
        async () =>
          manager.runningTurnIds(target.id).length === 0 &&
          sends.some((send) => send.text === afterEndInput.text) &&
          hostedRoots() === 1,
      );
      assert.deepEqual(
        sends.map((send) => send.sessionId),
        [target.id, target.id, target.id],
      );
      assert.deepEqual(
        sends.map((send) => send.text),
        ['original-task', 'followup-task', 'verify-the-delivery'],
      );
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(unrelated.id)).length, 0);
      assert.deepEqual(await stores.sessionStore.readWorkHubTaskInput(input.inputId), fact);
      assert.deepEqual(await stores.sessionStore.readWorkHubTaskInput(liveInput.inputId), liveFact);
      const taskRows = await query();
      assert.equal(taskRows.length, 3);
      assert.ok(taskRows.every((task) => task.workId === source.work!.id));
      const header = await stores.sessionStore.readHeaderSnapshot(target.id);
      assert.equal(header.cwd, root);
      assert.equal(header.permissionMode, 'ask');
      assert.equal(header.model, 'fake-model');
      finishNotifications.resolve();
      await waitFor(
        async () => manager.runningTurnIds(WORKHUB_COORDINATION_SESSION_ID).length === 0,
      );
      await desktop.close();
      desktop = undefined;
      await composition.close();
      ({ composition, manager } = await createCapturedExecutionComposition(owner));
      stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      assert.deepEqual(await stores.sessionStore.readWorkHubTaskInput(input.inputId), fact);
      assert.deepEqual(await stores.sessionStore.readWorkHubTaskInput(liveInput.inputId), liveFact);
      assert.deepEqual(
        await composition.handlers['workhub.tasks.input.read'](
          { workId: liveInput.workId, inputId: liveInput.inputId },
          context,
        ),
        liveReceipt,
      );
      const restored = await query();
      assert.equal(restored.length, 3);
      assert.ok(restored.every((task) => task.status === 'pending_acceptance'));
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(target.id)).length, 3);
      assert.equal((await stores.runtimeEventStore.listSessionInvocations(unrelated.id)).length, 0);
    } finally {
      release.resolve();
      finishNotifications.resolve();
      await desktop?.close();
      await composition.close();
    }
  });
});

test('active plugin executor task rejects unsupported Steering without queuing or changing authority', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    await configureFakeDefaultTarget(owner);
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'active-executor-input-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const sourceDirectory = join(root, 'active-executor-fixture');
      await mkdir(sourceDirectory);
      await writeFile(
        join(sourceDirectory, 'maka.extension.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'active-executor-fixture',
          runtime: { entry: 'index.mjs' },
          configuration: { properties: {}, required: [] },
          composition: { patch: 'maka.composition.json', structuralDependencies: [] },
        }),
      );
      await writeFile(
        join(sourceDirectory, 'index.mjs'),
        `export default {
          packageId: 'active-executor-fixture',
          contributions: [{ id: 'executor', kind: 'executor' }],
          host: { apply(ctx) {
            ctx.executors.register({
              id: 'test.workhub-live',
              capabilities: { toolActivity: true },
              discover: async () => ({
                id: 'test.workhub-live', displayName: 'Held test executor', readiness: 'ready',
                models: [{ id: 'held-model', name: 'held-model' }],
                supportsAttachments: false, supportsModelChange: true,
              }),
              execute: async (_request, context) => {
                context.emit({ type: 'tool_start', toolCallId: 'executor-entered', name: 'FixtureExecutorHold' });
                context.emit({ type: 'tool_result', toolCallId: 'executor-entered',
                  content: { kind: 'text', text: 'WORKHUB_EXECUTOR_ENTERED' } });
                await new Promise(resolve => {
                  if (context.signal.aborted) resolve();
                  else context.signal.addEventListener('abort', () => resolve(), { once: true });
                });
                return { status: 'cancelled' };
              },
            });
          } },
        };`,
      );
      await writeFile(
        join(sourceDirectory, 'maka.composition.json'),
        JSON.stringify([
          {
            type: 'insert',
            rootId: 'profile',
            entry: {
              id: 'active-executor',
              packageId: 'active-executor-fixture',
              config: {},
            },
          },
        ]),
      );
      const installed = await composition.plugins.installPackage(sourceDirectory);
      assert.equal(installed.convergence, 'converged', JSON.stringify(installed));
      assert.ok((await composition.handlers['workhub.coordination.resolve']({}, context)).ok);
      const assigned = await actWorkHub(
        composition,
        {
          actionId: 'live-executor-source',
          userText: 'Keep the executor task active for its original request.',
          proposal: { disposition: 'create_new', title: 'Live executor task' },
          create: { workspace: { kind: 'host_path', path: root } },
          newWorkDefaults: {
            executorId: 'test.workhub-live',
            executorModel: 'held-model',
            permissionMode: 'ask',
          },
        },
        context,
      );
      assert.ok(assigned.ok, JSON.stringify(assigned));
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const source = await stores.sessionStore.readWorkHubAssignment('live-executor-source');
      assert.ok(source?.work);
      assert.equal(source.targetSessionId, assigned.result.targetSessionId);
      assert.equal(source.targetTurnId, assigned.result.targetTurnId);
      const target = source.targetSessionId;
      // This is a real plugin-backed Run, not a native fake relabelled as unsupported.
      await waitFor(async () =>
        (await readLedgerMessages(stores.runtimeEventStore, target)).some(
          (message) =>
            message.type === 'tool_result' &&
            message.turnId === source.targetTurnId &&
            JSON.stringify(message.content).includes('WORKHUB_EXECUTOR_ENTERED'),
        ),
      );
      const original = await stores.agentRunStore.readRootTurnAdmission(
        target,
        source.targetTurnId,
      );
      assert.ok(original);
      const before = {
        header: await stores.sessionStore.readHeaderRecordSnapshot(target),
        boundary: await stores.sessionStore.readExecutionBoundary(target),
        assignment: await stores.sessionStore.readLatestWorkHubAssignment(source.work.id),
        admissions: await stores.sessionStore.listMessageAdmissions(target),
        invocations: await stores.runtimeEventStore.listSessionInvocations(target),
        grants: await stores.sessionStore.listTaskExecutionGrants(target),
      };
      assert.equal(before.header.header.backend, 'plugin-executor');
      assert.equal(before.header.header.executorId, 'test.workhub-live');
      assert.equal(before.header.header.model, 'held-model');
      assert.deepEqual(before.header.header.executorConfig, { model: 'held-model' });
      assert.equal(before.header.header.permissionMode, 'ask');
      assert.equal(before.header.header.cwd, await realpath(root));
      assert.deepEqual(manager.runningTurnIds(target), [original.turnId]);
      assert.equal(before.invocations.length, 1);
      assert.equal(before.invocations[0]!.runId, original.runId);
      const input = {
        inputId: 'live-executor-rejected-input',
        workId: source.work.id,
        generationId: source.work.generationId,
        text: 'This must not become a hidden later executor request.',
      };
      // Task-aware input reaches the live provider check, not the saved-legacy-input gate.
      const rejected = await composition.handlers['workhub.tasks.send'](input, context);
      assert.ok(!rejected.ok, JSON.stringify(rejected));
      assert.equal(rejected.error.code, 'operation_unavailable');
      assert.match(rejected.error.message, /Live task Steering is not supported for this executor/);
      assert.equal(await stores.sessionStore.readWorkHubTaskInput(input.inputId), undefined);
      assert.equal(await stores.sessionStore.readWorkHubAssignment(input.inputId), undefined);
      assert.deepEqual(
        {
          header: await stores.sessionStore.readHeaderRecordSnapshot(target),
          boundary: await stores.sessionStore.readExecutionBoundary(target),
          assignment: await stores.sessionStore.readLatestWorkHubAssignment(source.work.id),
          admissions: await stores.sessionStore.listMessageAdmissions(target),
          invocations: await stores.runtimeEventStore.listSessionInvocations(target),
          grants: await stores.sessionStore.listTaskExecutionGrants(target),
        },
        before,
        'unsupported live input cannot alter the original task, authority or pending FIFO',
      );
      assert.deepEqual(manager.runningTurnIds(target), [original.turnId]);
    } finally {
      // The provider waits on the real executor cancellation signal from normal Host close.
      await composition.close();
    }
  });
});

async function setWorkHubConcurrency(
  composition: ExecutionRuntimeHostComposition,
  context: ConnectionContext,
  value: number,
): Promise<void> {
  const current = await composition.handlers['runtime.policy.query']({}, context);
  assert.ok(current.ok, JSON.stringify(current));
  const saved = await composition.handlers['runtime.policy.mutate'](
    {
      expectedRevision: current.result.revision,
      operation: {
        kind: 'set_chat_defaults',
        value: { ...current.result.policy.chatDefaults, workHubMaxConcurrentSessions: value },
      },
    },
    context,
  );
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(saved.result.kind, 'committed');
}

async function delegateWorkHubTarget(
  composition: ExecutionRuntimeHostComposition,
  context: ConnectionContext,
  sessionId: string,
  actionId: string,
  text: string,
): Promise<void> {
  const result = await actWorkHub(
    composition,
    {
      actionId,
      userText: text,
      proposal: { disposition: 'delegate_existing', sessionRef: sessionId },
    },
    context,
  );
  assert.ok(result.ok, JSON.stringify(result));
}

test('native WorkHub Stop cancels only its queued task Message without stopping a manual Root', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    const context = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-shared-turn-client',
      principal: 'local_os_user' as const,
      acquireResidency: () => ({ release() {} }),
    };
    let activeRunId: string | undefined;
    let sourceId: string | undefined;
    try {
      const source = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      sourceId = source.id;
      const started = await composition.handlers['turn.start'](
        {
          sessionId: source.id,
          turnId: 'manual-active-turn',
          content: { text: FAKE_HOLD_OPEN_PROMPT },
        },
        context,
      );
      assert.equal(started.ok, true);
      if (!started.ok || started.result.kind !== 'started') return;
      activeRunId = started.result.turn.runId;

      const resolved = await composition.handlers['workhub.coordination.resolve']({}, context);
      assert.equal(resolved.ok, true);
      const delegated = await actWorkHub(
        composition,
        {
          actionId: 'workhub-queued-action',
          userText: 'Continue this manual work from WorkHub',
          proposal: {
            disposition: 'delegate_existing',
            sessionRef: source.id,
          },
        },
        context,
      );
      assert.equal(delegated.ok, true);
      if (!delegated.ok) return;
      assert.equal(delegated.result.disposition, 'delegate_existing');
      if (delegated.result.disposition !== 'delegate_existing') return;
      assert.equal(delegated.result.steered, undefined);

      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      const assignment = await stores.sessionStore.readWorkHubAssignment('workhub-queued-action');
      assert.ok(assignment);
      if (!assignment) return;
      await waitFor(async () => {
        const proof = await composition.handlers['turn.message.execution.query'](
          { sessionId: source.id, messageIds: [assignment.targetMessageId] },
          context,
        );
        return proof.ok && proof.result.resolutions[0]?.state === 'pending';
      });
      assert.deepEqual(
        await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([source.id]),
        [assignment],
      );

      {
        for (let index = 1; index < MESSAGE_QUEUE_MAX_ENTRIES; index++) {
          const queued = await composition.handlers['turn.message.submit'](
            {
              originHostEpoch: context.hostEpoch,
              sessionId: source.id,
              messageId: `capacity-followup-${index}`,
              content: { text: `Unrelated queued work ${index}` },
              placement: 'next_turn',
            },
            context,
          );
          assert.ok(queued.ok, JSON.stringify(queued));
        }
        const receipt = await composition.handlers['workhub.tasks.read'](
          {
            actionId: assignment.actionId,
            delegationId: assignment.delegationId,
          },
          context,
        );
        assert.ok(receipt.ok, 'a committed queued task remains readable when the FIFO is full');
        assert.equal(receipt.result.task.targetMessageId, assignment.targetMessageId);
        const full = await actWorkHub(
          composition,
          {
            actionId: 'queue-overflow',
            userText: 'Another independent request',
            proposal: {
              disposition: 'delegate_existing',
              sessionRef: source.id,
            },
          },
          context,
        );
        assert.equal(full.ok, false);
        if (!full.ok) assert.equal(full.error.code, 'session_busy');
        assert.equal(await stores.sessionStore.readWorkHubAssignment('queue-overflow'), undefined);

        const stopped = await stopWorkHubTasks(
          composition,
          context,
          'workhub-stop-shared-action',
          [assignment.work?.id ?? assignment.actionId],
          'Stop only the queued task',
        );
        assert.ok(stopped.ok && stopped.result.kind === 'result', JSON.stringify(stopped));
        assert.equal(stopped.result.targets[0]?.outcome, 'cancelled_pending');
        assert.equal(stopped.result.targets[0]?.targetSessionId, source.id);
        assert.equal(
          (await stores.sessionStore.readWorkHubStopResolution(assignment.delegationId))?.outcome,
          'cancelled_pending',
        );
      }

      const unrelated = await composition.handlers['turn.message.submit'](
        {
          originHostEpoch: context.hostEpoch,
          sessionId: source.id,
          messageId: 'unrelated-followup-message',
          content: { text: 'Keep this unrelated follow-up queued' },
          placement: 'next_turn',
        },
        context,
      );
      assert.equal(unrelated.ok, true);
      if (!unrelated.ok) return;
      assert.equal(unrelated.result.disposition, 'followup');

      const active = await composition.handlers['turn.query'](
        { sessionId: source.id, turnId: 'manual-active-turn' },
        context,
      );
      assert.equal(active.ok, true);
      if (active.ok) {
        assert.equal(active.result.status, 'running');
        assert.equal(active.result.runId, activeRunId);
      }
      const queued = await composition.handlers['turn.message.execution.query'](
        { sessionId: source.id, messageIds: ['unrelated-followup-message'] },
        context,
      );
      assert.equal(queued.ok, true);
      if (queued.ok) assert.equal(queued.result.resolutions[0]?.state, 'pending');
      const cancelled = await composition.handlers['turn.message.execution.query'](
        {
          sessionId: source.id,
          messageIds: [assignment.targetMessageId],
        },
        context,
      );
      assert.ok(cancelled.ok, JSON.stringify(cancelled));
      assert.equal(cancelled.result.resolutions[0]?.state, 'cancelled');
    } finally {
      if (sourceId && activeRunId) {
        await composition.handlers['turn.stop'](
          { sessionId: sourceId, turnId: 'manual-active-turn', runId: activeRunId },
          context,
        );
      }
      await composition.close();
    }
  });
});

test('WorkHub rejects a queued delegation that exceeds projection bytes before committing', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const connectionId = await configureFakeDefaultTarget(owner);
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    const context: ConnectionContext = {
      hostEpoch: 'execution-composition-test',
      connectionId: 'workhub-queue-bytes-client',
      principal: 'local_os_user',
      acquireResidency: () => ({ release() {} }),
    };
    try {
      const target = await manager.createSession({
        cwd: root,
        llmConnectionId: connectionId,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const started = await composition.handlers['turn.start'](
        {
          sessionId: target.id,
          turnId: 'manual-queue-bytes',
          content: { text: FAKE_HOLD_OPEN_PROMPT },
        },
        context,
      );
      assert.ok(started.ok, JSON.stringify(started));
      const queued = await composition.handlers['turn.message.submit'](
        {
          originHostEpoch: context.hostEpoch,
          sessionId: target.id,
          messageId: 'large-followup',
          content: { text: 'x'.repeat(40 * 1024) },
          placement: 'next_turn',
        },
        context,
      );
      assert.ok(queued.ok, JSON.stringify(queued));
      await composition.handlers['workhub.coordination.resolve']({}, context);
      const result = await actWorkHub(
        composition,
        {
          actionId: 'byte-overflow',
          userText: 'y'.repeat(16 * 1024),
          proposal: {
            disposition: 'delegate_existing',
            sessionRef: target.id,
          },
        },
        context,
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /projection capacity/u);
      const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
      assert.equal(await stores.sessionStore.readWorkHubAssignment('byte-overflow'), undefined);
      const proof = await composition.handlers['turn.message.execution.query'](
        {
          sessionId: target.id,
          messageIds: ['large-followup'],
        },
        context,
      );
      assert.ok(proof.ok, JSON.stringify(proof));
      assert.equal(proof.result.resolutions[0]?.state, 'pending');
    } finally {
      await composition.close();
    }
  });
});

test('a legacy fake-backend session is refused with the product reason, not a registry error', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    // Written by an older build: no creation path here can produce `fake`, so
    // the row is seeded under the writer — which is the only way it was ever
    // produced — and then read back by a Host that starts up against it, since
    // activation dispatches straight off the durable header.
    const legacyId = await seedLegacyFakeBackendSession(root, owner);
    const { composition } = await createCapturedExecutionComposition(owner);
    try {
      const failure = await composition.handlers['turn.start'](
        {
          sessionId: legacyId,
          turnId: 'turn-legacy-fake',
          content: { text: 'resume a retired local simulation' },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'legacy-fake-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      ).then(
        (result) => result,
        (error: unknown) => error,
      );
      const message = failure instanceof Error ? failure.message : JSON.stringify(failure);
      assert.doesNotMatch(message, /No backend factory registered/);
      assert.equal(parseNoRealConnectionError(message).reason, 'fake_backend');
    } finally {
      await composition.close();
    }
  });
});

test('production executor admission discovers the Session provider, including profile shadows', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const sessions = [];
    for (const executorId of ['private', 'shared']) {
      sessions.push(
        await stores.sessionStore.create({
          cwd: root,
          executorId,
          llmConnectionSlug: `executor:${executorId}`,
          model: 'before',
          permissionMode: 'ask',
        }),
      );
    }
    const { composition } = await createCapturedExecutionComposition(owner);
    try {
      const source = join(root, 'executor-fixture');
      await mkdir(source);
      await writeFile(
        join(source, 'maka.extension.json'),
        JSON.stringify({
          schemaVersion: 1,
          id: 'executor-fixture',
          runtime: { entry: 'index.mjs' },
          configuration: {
            properties: { executorId: { type: 'string' }, model: { type: 'string' } },
            required: ['executorId', 'model'],
          },
          composition: { patch: 'maka.composition.json', structuralDependencies: [] },
        }),
      );
      await writeFile(
        join(source, 'index.mjs'),
        `export default {
        packageId: 'executor-fixture',
        contributions: [{ id: 'executor', kind: 'executor' }],
        host: { apply(ctx, config) {
          ctx.executors.register({
            id: config.executorId,
            discover: async () => ({
              id: config.executorId, displayName: config.executorId, readiness: 'ready',
              models: [{ id: config.model, name: config.model }],
              supportsAttachments: false, supportsModelChange: true,
            }),
            inspectConversation: async () => { throw new Error('Admission must discover, not inspect'); },
            execute: async () => ({ status: 'completed', text: '' }),
          });
        } },
      };`,
      );
      await writeFile(
        join(source, 'maka.composition.json'),
        JSON.stringify([
          {
            type: 'insert',
            rootId: 'profile',
            entry: {
              id: 'profile-shared',
              packageId: 'executor-fixture',
              config: { executorId: 'shared', model: 'profile-model' },
            },
          },
          ...sessions.map((session) => ({
            type: 'insert',
            rootId: `session:${session.id}`,
            entry: {
              id: `session-${session.executorId}`,
              packageId: 'executor-fixture',
              config: { executorId: session.executorId, model: 'session-model' },
            },
          })),
        ]),
      );
      const installed = await composition.plugins.installPackage(source);
      assert.equal(installed.convergence, 'converged', JSON.stringify(installed));
      const context: ConnectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'executor-admission-client',
        principal: 'local_os_user',
        acquireResidency: () => ({ release() {} }),
      };
      for (const session of sessions) {
        const current = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
        const outcome = await composition.handlers['session.configuration.update'](
          {
            sessionId: session.id,
            expectedRevision: current.revision,
            patch: { executorTarget: { executorId: session.executorId!, model: 'session-model' } },
          },
          context,
        );
        assert.equal(outcome.ok, true, JSON.stringify(outcome));
        const updated = await stores.sessionStore.readHeaderSnapshot(session.id);
        assert.equal(updated.model, 'session-model');
        assert.deepEqual(updated.executorConfig, { model: 'session-model' });
      }
    } finally {
      await composition.close();
    }
  });
});

test('production composition orphans ownerless ShellRuns before serving Resource queries', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const shellRuns = await openInteractiveShellRunStoreForWrite(owner.lease);
    await shellRuns.createShellRun(shellRunRecord(session.id, 'starting-shell', 'starting'));
    await shellRuns.createShellRun(shellRunRecord(session.id, 'running-shell', 'running'));

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['runtime.resource.query'](
        { kind: 'list_start', sessionId: session.id },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'recovery-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(outcome.ok, true);
      if (!outcome.ok || outcome.result.kind !== 'page') return;
      assert.equal(outcome.result.resources.length, 2);
      assert.deepEqual(
        outcome.result.resources.map((resource) => resource.result.status),
        ['orphaned', 'orphaned'],
      );
      assert.equal(
        outcome.result.resources.every(
          (resource) =>
            resource.result.failureMessage ===
            'Runtime restarted without a live shell process handle',
        ),
        true,
      );
    } finally {
      await composition.close();
    }
  });
});

test('production Skill catalog resolves a Graph child durable tool surface', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const parent = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const child = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'c',
      stores,
      prompt: 'inspect the child Skill catalog',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: child.request.targetSessionId },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'graph-child-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.result.kind, 'page');
    } finally {
      await composition.close();
    }
  });
});

test('production Skill catalog reports an archived Session without resolving its live tool surface', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
    await stores.sessionStore.setSessionsArchivedVersioned(
      [{ sessionId: session.id, expectedVersion: snapshot.revision }],
      true,
    );

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: session.id },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'archived-session-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: 'session_archived', message: 'Session is archived' },
      });
    } finally {
      await composition.close();
    }
  });
});

test('production Skill catalog reports a removed Session as not found', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
    await stores.sessionStore.removeSessionsVersioned([
      { sessionId: session.id, expectedVersion: snapshot.revision },
    ]);

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: session.id },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'removed-session-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: 'not_found', message: 'Session does not exist' },
      });
    } finally {
      await composition.close();
    }
  });
});

test('production Skill catalog preserves an archive race during live tool resolution', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const originalToolsForSession = AgentGraphCoordinator.prototype.toolsForSession;
    let archiveInjected = false;
    try {
      await composition.recover();
      AgentGraphCoordinator.prototype.toolsForSession = async function (sessionId) {
        if (sessionId === session.id && !archiveInjected) {
          archiveInjected = true;
          const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
          await stores.sessionStore.setSessionsArchivedVersioned(
            [{ sessionId: session.id, expectedVersion: snapshot.revision }],
            true,
          );
        }
        return originalToolsForSession.call(this, sessionId);
      };

      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: session.id },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'archive-race-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(archiveInjected, true);
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: 'session_archived', message: 'Session is archived' },
      });
    } finally {
      AgentGraphCoordinator.prototype.toolsForSession = originalToolsForSession;
      await composition.close();
    }
  });
});

test('production Skill catalog preserves a removal race during live tool resolution', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    const originalToolsForSession = AgentGraphCoordinator.prototype.toolsForSession;
    let removalInjected = false;
    try {
      await composition.recover();
      AgentGraphCoordinator.prototype.toolsForSession = async function (sessionId) {
        if (sessionId === session.id && !removalInjected) {
          removalInjected = true;
          const snapshot = await stores.sessionStore.readHeaderRecordSnapshot(session.id);
          await stores.sessionStore.removeSessionsVersioned([
            { sessionId: session.id, expectedVersion: snapshot.revision },
          ]);
        }
        return originalToolsForSession.call(this, sessionId);
      };

      const outcome = await composition.handlers['skill.catalog.invocable.query'](
        {
          kind: 'start',
          target: { kind: 'session', sessionId: session.id },
        },
        {
          hostEpoch: 'execution-composition-test',
          connectionId: 'removal-race-skill-client',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(removalInjected, true);
      assert.deepEqual(outcome, {
        ok: false,
        error: { code: 'not_found', message: 'Session does not exist' },
      });
    } finally {
      AgentGraphCoordinator.prototype.toolsForSession = originalToolsForSession;
      await composition.close();
    }
  });
});

test('new Full Access Plan Skill previews use the mutating tool surface', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const skillDirectory = join(root, '.agents', 'skills', 'write-preview');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, 'SKILL.md'),
      [
        '---',
        'name: Write Preview',
        'description: Requires the Write tool.',
        'required-tools: [Write]',
        '---',
        '# Write Preview',
        '',
      ].join('\n'),
    );

    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner));
    try {
      await composition.recover();
      const connection = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'new-session-skill-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const query = (permissionMode: 'ask' | 'bypass') =>
        composition.handlers['skill.catalog.invocable.query'](
          {
            kind: 'start',
            target: {
              kind: 'new_session',
              context: { workspace: { kind: 'host_path', path: root } },
              collaborationMode: 'plan',
              permissionMode,
            },
          },
          connection,
        );

      const managed = await query('ask');
      assert.equal(managed.ok, true);
      if (!managed.ok || managed.result.kind !== 'page') return;
      assert.equal(
        managed.result.items.some((item) => item.id === 'write-preview'),
        false,
      );

      const fullAccess = await query('bypass');
      assert.equal(fullAccess.ok, true);
      if (!fullAccess.ok || fullAccess.result.kind !== 'page') return;
      assert.equal(
        fullAccess.result.items.some((item) => item.id === 'write-preview'),
        true,
      );
    } finally {
      await composition.close();
    }
  });
});

test('Skill capability previews keep a bound Session off a same-slug replacement', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    for (const [id, requiredTool] of [
      ['web-search-preview', 'WebSearch'],
      ['web-research-preview', 'web_research'],
    ] as const) {
      const skillDirectory = join(root, '.agents', 'skills', id);
      await mkdir(skillDirectory, { recursive: true });
      await writeFile(
        join(skillDirectory, 'SKILL.md'),
        [
          '---',
          `name: ${id}`,
          `description: Requires ${requiredTool}.`,
          `required-tools: [${requiredTool}]`,
          '---',
          `# ${id}`,
          '',
        ].join('\n'),
      );
    }

    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'skill-preview-model',
        name: 'Skill preview model',
        providerType: 'ollama',
        enabled: true,
        enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') return;
    const connection = created.snapshot.connections[0];
    assert.ok(connection);
    if (!connection) return;
    const fetch = await policy.operations.beginModelFetch(connection.connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') return;
    const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
      models: [{ id: 'fake-model' }],
      source: 'fetched',
      fetchedAt: Date.now(),
    });
    assert.equal(fetched.kind, 'committed');
    if (fetched.kind !== 'committed') return;
    const defaultTarget = await policy.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: fetched.snapshot.revision,
      target: { connectionId: connection.connectionId, modelId: 'fake-model' },
    });
    assert.equal(defaultTarget.kind, 'committed');
    const policySnapshot = await policy.runtimePolicy.getSnapshot();
    const webSearchEnabled = await policy.runtimePolicy.mutate({
      expectedRevision: policySnapshot.revision,
      operation: {
        kind: 'set_web_search',
        value: { enabled: true, defaultProvider: 'tavily' },
      },
    });
    assert.equal(webSearchEnabled.kind, 'committed');
    assert.equal(
      (
        await policy.operations.resolveExecutionConnection({
          kind: 'catalog_slug',
          connectionSlug: connection.slug,
        })
      ).kind,
      'ready',
    );

    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const session = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: connection.connectionId,
      llmConnectionSlug: connection.slug,
      model: 'fake-model',
      permissionMode: 'bypass',
    });
    const composition = await createExecutionRuntimeHostComposition(compositionContext(owner), {
      bootstrapRuntimePolicy: false,
    });
    try {
      await composition.recover();
      const connectionContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'web-search-skill-preview-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const query = (target: 'session' | 'new_session') =>
        composition.handlers['skill.catalog.invocable.query'](
          {
            kind: 'start',
            target:
              target === 'session'
                ? { kind: 'session', sessionId: session.id }
                : {
                    kind: 'new_session',
                    context: { workspace: { kind: 'host_path', path: root } },
                    collaborationMode: 'agent',
                    permissionMode: 'bypass',
                  },
          },
          connectionContext,
        );

      for (const target of ['session', 'new_session'] as const) {
        const outcome = await query(target);
        assert.equal(outcome.ok, true);
        if (!outcome.ok || outcome.result.kind !== 'page') continue;
        assert.equal(
          outcome.result.items.some(
            (item) => item.id === 'web-search-preview' || item.id === 'web-research-preview',
          ),
          false,
        );
      }

      assert.equal(
        (
          await policy.credentialVault.set({
            locator: { scope: 'web_search', provider: 'tavily', kind: 'api_key' },
            expected: null,
            secret: 'replacement-must-not-be-read',
          })
        ).kind,
        'committed',
      );
      const beforeRemoval = await policy.connectionCatalog.getSnapshot();
      const currentConnection = beforeRemoval.connections.find(
        (candidate) => candidate.connectionId === connection.connectionId,
      );
      assert.ok(currentConnection);
      if (!currentConnection) return;
      assert.equal(
        (
          await policy.connectionCatalog.remove({
            expected: {
              connectionId: currentConnection.connectionId,
              revision: currentConnection.revision,
            },
          })
        ).kind,
        'committed',
      );
      const afterRemoval = await policy.connectionCatalog.getSnapshot();
      const replacementCreated = await policy.connectionCatalog.create({
        expectedCatalogRevision: afterRemoval.revision,
        connection: {
          slug: connection.slug,
          name: 'Same-slug replacement',
          providerType: 'ollama',
          enabled: true,
          enabledModelIds: ['fake-model'],
        },
      });
      assert.equal(replacementCreated.kind, 'committed');
      if (replacementCreated.kind !== 'committed') return;
      const replacement = replacementCreated.snapshot.connections[0];
      assert.ok(replacement);
      if (!replacement) return;
      const replacementFetch = await policy.operations.beginModelFetch(replacement.connectionId);
      assert.equal(replacementFetch.kind, 'ready');
      if (replacementFetch.kind !== 'ready') return;
      const replacementFetched = await policy.operations.completeModelFetch(
        replacementFetch.ticket,
        {
          models: [{ id: 'fake-model' }],
          source: 'fetched',
          fetchedAt: Date.now(),
        },
      );
      assert.equal(replacementFetched.kind, 'committed');
      if (replacementFetched.kind !== 'committed') return;
      assert.equal(
        (
          await policy.connectionCatalog.setDefaultTarget({
            expectedCatalogRevision: replacementFetched.snapshot.revision,
            target: { connectionId: replacement.connectionId, modelId: 'fake-model' },
          })
        ).kind,
        'committed',
      );

      const boundSession = await query('session');
      assert.equal(boundSession.ok, true);
      if (boundSession.ok && boundSession.result.kind === 'page') {
        assert.equal(
          boundSession.result.items.some(
            (item) => item.id === 'web-search-preview' || item.id === 'web-research-preview',
          ),
          false,
        );
      }
      const replacementPreview = await query('new_session');
      assert.equal(replacementPreview.ok, true);
      if (replacementPreview.ok && replacementPreview.result.kind === 'page') {
        assert.equal(
          replacementPreview.result.items.some(
            (item) => item.id === 'web-search-preview' || item.id === 'web-research-preview',
          ),
          true,
        );
      }
    } finally {
      await composition.close();
    }
  });
});

test('production composition validates graph stop before aborting a claimed child', async () => {
  await withCompositionRoot(async ({ root, owner }) => {
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    const claims = createAgentGraphControlStore(root);
    const parent = await stores.sessionStore.create({
      cwd: root,
      llmConnectionId: FAKE_CONNECTION_ID,
      llmConnectionSlug: 'fake',
      model: 'fake-model',
      permissionMode: 'ask',
    });
    const completedPrompt = 'execute the canonical claimed graph activation';
    const completed = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'a',
      stores,
      prompt: completedPrompt,
    });
    const completedClaim = (await claims.claimAgentGraphIntent(completed.request)).claim;
    const abortedFixture = await createClaimedGraphChild({
      root,
      parentSessionId: parent.id,
      suffix: 'e',
      stores,
      prompt: FAKE_ASK_USER_QUESTION_PROMPT,
    });
    const abortedClaim = (await claims.claimAgentGraphIntent(abortedFixture.request)).claim;
    claims.close();
    const { composition, manager } = await createCapturedExecutionComposition(owner);
    let journeyError: unknown;
    try {
      const first = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.equal(first.status, 'completed');

      const admission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.ok(admission);
      assert.ok(admission.userMessageId);
      assert.deepEqual(admission.execution, graphExecutionDescriptor(completedClaim));
      assert.deepEqual(admission.normalizedInput, { text: completedPrompt });

      const retry = await manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: completed.intent,
        graphId: completedClaim.graphId,
        intentId: completedClaim.intentId,
        prompt: completedPrompt,
      });
      assert.deepEqual(
        {
          claimId: retry.claimId,
          childSessionId: retry.childSessionId,
          turnId: retry.turnId,
          runId: retry.runId,
          status: retry.status,
          summary: retry.summary,
        },
        {
          claimId: first.claimId,
          childSessionId: first.childSessionId,
          turnId: first.turnId,
          runId: first.runId,
          status: first.status,
          summary: first.summary,
        },
      );
      const retriedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        completedClaim.targetSessionId,
        completedClaim.targetTurnId,
      );
      assert.equal(retriedAdmission?.userMessageId, admission.userMessageId);
      await assertUniqueGraphExecutionFacts(stores, completedClaim, admission.userMessageId);

      const abort = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const aborting = manager.runClaimedAgentGraphIntent({
        claimStore: claims,
        intent: abortedFixture.intent,
        graphId: abortedClaim.graphId,
        intentId: abortedClaim.intentId,
        prompt: FAKE_ASK_USER_QUESTION_PROMPT,
        abortSignal: abort.signal,
        onReady: ready,
      });
      await started;
      const clientContext = {
        hostEpoch: 'execution-composition-test',
        connectionId: 'graph-stop-client',
        principal: 'local_os_user' as const,
        acquireResidency: () => ({ release() {} }),
      };
      const invalidStop = await composition.handlers['agent.graph.stop'](
        {
          rootSessionId: abortedClaim.targetSessionId,
          expectedGraphId: abortedClaim.graphId,
        },
        clientContext,
      );
      assert.equal(invalidStop.ok, false);
      if (invalidStop.ok) return;
      assert.equal(invalidStop.error.code, 'operation_conflict');
      const stillActive = await composition.handlers['turn.query'](
        {
          sessionId: abortedClaim.targetSessionId,
          turnId: abortedClaim.targetTurnId,
        },
        clientContext,
      );
      assert.equal(stillActive.ok, true);
      if (!stillActive.ok) return;
      assert.equal(['completed', 'failed', 'cancelled'].includes(stillActive.result.status), false);
      abort.abort();
      const aborted = await aborting;
      assert.equal(aborted.status, 'cancelled');

      const abortedAdmission = await stores.agentRunStore.readRootTurnAdmission(
        abortedClaim.targetSessionId,
        abortedClaim.targetTurnId,
      );
      assert.ok(abortedAdmission?.userMessageId);
      assert.deepEqual(abortedAdmission?.execution, graphExecutionDescriptor(abortedClaim));
      const abortedRun = (
        await stores.runtimeEventStore.listSessionInvocations(abortedClaim.targetSessionId)
      ).find((candidate) => candidate.runId === abortedClaim.targetRunId);
      assert.ok(abortedRun);
      assert.equal(abortedRun && runtimeInvocationOutcome(abortedRun), 'cancelled');
      await assertUniqueGraphExecutionFacts(
        stores,
        abortedClaim,
        abortedAdmission.userMessageId,
        'cancelled',
      );
      const completedRun = (
        await stores.runtimeEventStore.listSessionInvocations(completedClaim.targetSessionId)
      ).find((candidate) => candidate.runId === completedClaim.targetRunId);
      assert.ok(completedRun);
      assert.equal(completedRun && runtimeInvocationOutcome(completedRun), 'completed');
    } catch (error) {
      journeyError = error;
      throw error;
    } finally {
      try {
        await composition.close();
      } catch (closeError) {
        if (journeyError !== undefined) {
          throw new AggregateError(
            [journeyError, closeError],
            'Claimed graph journey and composition close both failed',
          );
        }
        throw closeError;
      }
    }
  });
});

test('interaction fail-stop stops graph operators through the kernel and releases ownership', {
  timeout: 10_000,
}, async (t) => {
  await withCompositionRoot(async ({ root, owner }) => {
    const failure = new Error('backend continuation apply failed');
    let graph!: AgentGraphCoordinator;
    const recoverGraph = AgentGraphCoordinator.prototype.recover;
    t.mock.method(
      AgentGraphCoordinator.prototype,
      'recover',
      async function (this: AgentGraphCoordinator) {
        graph = this;
        return recoverGraph.call(this);
      },
    );
    const published = deferred<string>();
    const stopped = deferred<void>();
    const stopObservations: Array<{ error?: unknown }> = [];
    let settlement: HostedUserQuestionSettlement | undefined;
    let retained = false;
    let retainedAtShutdownRequest = false;
    let captured!: Awaited<ReturnType<typeof createCapturedExecutionComposition>>;
    const host = await RuntimeHostKernel.start({
      owner,
      idleGraceMs: 60_000,
      shutdownGraceMs: 5_000,
      composition: defineInteractiveRuntimeHostComposition(async (kernelContext) => {
        captured = await createCapturedExecutionComposition(owner, {
          context: {
            ...kernelContext,
            retainUntilProcessExit: () => {
              retained = true;
              kernelContext.retainUntilProcessExit();
            },
            requestDrain: () => {
              retainedAtShutdownRequest = retained;
              kernelContext.requestDrain();
            },
          },
          primaryBackendFactory: (backendContext) => {
            const backend = new FakeBackend(backendContext);
            const send = backend.send.bind(backend);
            backend.send = async function* (input) {
              const bridge = input.hostedInteraction;
              assert.ok(bridge);
              yield* send({
                ...input,
                hostedInteraction: {
                  ...bridge,
                  admitUserQuestionRequest: async (request) => {
                    settlement = request.settlement;
                    await bridge.admitUserQuestionRequest({
                      ...request,
                      settlement: {
                        ...request.settlement,
                        applyAnswer: async () => {
                          throw failure;
                        },
                      },
                    });
                    published.resolve(request.request.requestId);
                  },
                },
              });
            };
            return backend;
          },
        });
        return captured.composition;
      }),
    });
    const closed = host.closed.then(
      () => undefined,
      (error: unknown) => error,
    );
    const connected = await connectRuntimeHost({
      rootPath: root,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') throw new Error('kernel connection unavailable');
    const { manager } = captured;
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      const session = await manager.createSession({
        cwd: root,
        llmConnectionId: FAKE_CONNECTION_ID,
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      await graph.toolsForSession(session.id);
      const turnId = 'interaction-drain-turn';
      // Prepare the held-open backend with a fixture residency. The answer below exercises
      // kernel drain over UDS; poisoned root-execution settlement is a separate close path.
      const started = await captured.composition.handlers['turn.start'](
        {
          sessionId: session.id,
          turnId,
          content: { text: FAKE_ASK_USER_QUESTION_PROMPT },
        },
        {
          hostEpoch: host.hostEpoch,
          connectionId: 'interaction-drain-fixture',
          principal: 'local_os_user',
          acquireResidency: () => ({ release() {} }),
        },
      );
      assert.equal(started.ok, true);
      const interactionId = await published.promise;
      const run = (await stores.runtimeEventStore.listSessionInvocations(session.id)).find(
        (run) => run.turnId === turnId,
      );
      assert.ok(run);
      const operator = await manager.provisionAgentGraphOperator({
        graphId: agentGraphIdForRootSession(session.id),
        workId: `graph_work_${'a'.repeat(32)}`,
        operatorId: `graph_operator_${'b'.repeat(32)}`,
        agentId: LOCAL_READ_AGENT_DEFINITION.id,
        source: {
          sessionId: session.id,
          turnId,
          runId: run.runId,
          toolCallId: 'provision-for-drain',
        },
        edges: [],
        expectedScheduleRevision: 0,
      });
      const stopSession = manager.stopSession.bind(manager);
      t.mock.method(
        manager,
        'stopSession',
        async (sessionId: string, input: Parameters<SessionManager['stopSession']>[1]) => {
          if (sessionId !== operator.header.id) return stopSession(sessionId, input);
          const observation: (typeof stopObservations)[number] = {};
          stopObservations.push(observation);
          try {
            await stopSession(sessionId, input);
          } catch (error) {
            observation.error = error;
            throw error;
          } finally {
            stopped.resolve();
          }
        },
      );
      await assert.rejects(
        connected.connection.request('interaction.answer', {
          sessionId: session.id,
          interactionId,
          answer: { kind: 'question', answers: ['邀请制', '本周', '是'] },
        }),
        (error: unknown) =>
          error instanceof RuntimeHostOperationError && error.code === 'internal_failure',
      );
      await stopped.promise;
      assert.equal(retained, true);
      assert.equal(retainedAtShutdownRequest, true);
      assert.deepEqual(stopObservations, [{}]);
    } finally {
      // Release the injected backend waiter; fail-stop intentionally cannot apply its continuation.
      await settlement?.applyClosure('turn_stopped');
      await connected.connection.close();
      void host.close().catch(() => undefined);
      const closeError = await closed;
      assert.ok(
        closeError instanceof AggregateError,
        `Unexpected shutdown result: ${String(closeError)}`,
      );
      const errorTree = (error: unknown): string =>
        error instanceof AggregateError
          ? [error.message, ...error.errors.map(errorTree)].join('\n')
          : String(error);
      // Poisoned compositions can aggregate other close errors; operator stop must not reenter admission.
      const details = errorTree(closeError);
      assert.match(details, /Interaction coordinator entered fail-stop/);
      assert.doesNotMatch(
        details,
        /Cannot enter Session admission|termination required|shutdown deadline/i,
      );
      const replacementOwner = await tryAcquireInteractiveRootOwner(owner.capability);
      assert.ok(replacementOwner, 'kernel released exclusive root ownership');
      await replacementOwner.close();
    }
  });
});

function compositionContext(owner: InteractiveRootOwner) {
  return {
    owner,
    hostEpoch: 'execution-composition-test',
    acquireResidency: () => ({ release() {} }),
    retainUntilProcessExit: () => undefined,
    requestDrain: () => undefined,
  };
}

async function configureFakeDefaultTarget(
  owner: InteractiveRootOwner,
  modelIds: readonly string[] = ['fake-model'],
  baseUrl?: string,
): Promise<string> {
  const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
  const created = await policy.connectionCatalog.create({
    expectedCatalogRevision: 0,
    connection: {
      slug: 'fake',
      name: 'Fake',
      providerType: 'ollama',
      ...(baseUrl ? { baseUrl } : {}),
      enabled: true,
      enabledModelIds: [...modelIds],
    },
  });
  assert.equal(created.kind, 'committed');
  if (created.kind !== 'committed') throw new Error('Fake connection was not committed');
  const connection = created.snapshot.connections[0];
  assert.ok(connection);
  if (!connection) throw new Error('Fake connection is unavailable');
  const fetch = await policy.operations.beginModelFetch(connection.connectionId);
  assert.equal(fetch.kind, 'ready');
  if (fetch.kind !== 'ready') throw new Error('Fake model fetch did not start');
  const fetched = await policy.operations.completeModelFetch(fetch.ticket, {
    models: modelIds.map((id) => ({ id })),
    source: 'fetched',
    fetchedAt: Date.now(),
  });
  assert.equal(fetched.kind, 'committed');
  if (fetched.kind !== 'committed') throw new Error('Fake model catalog was not committed');
  const selected = await policy.connectionCatalog.setDefaultTarget({
    expectedCatalogRevision: fetched.snapshot.revision,
    target: { connectionId: connection.connectionId, modelId: 'fake-model' },
  });
  assert.equal(selected.kind, 'committed');
  if (selected.kind !== 'committed') throw new Error('Fake default target was not committed');
  return connection.connectionId;
}

function shellRunRecord(
  sessionId: string,
  shellRunId: string,
  status: 'starting' | 'running',
): ShellRunRecord {
  return {
    shellRunId,
    sessionId,
    sourceTurnId: `turn-${shellRunId}`,
    sourceToolCallId: `tool-${shellRunId}`,
    cwd: '/workspace',
    command: 'sleep 60',
    status,
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

/**
 * Writes one session whose durable header says `backend: 'fake'`.
 *
 * Nothing in this build can write that value, so the row goes in underneath the
 * session writer: create a normal row through the real store, then rewrite the
 * persisted backend the way an older build left it on disk. The database
 * filename is `OPERATIONAL_STATE_DATABASE_NAME` in `@maka/storage`, which the
 * package does not export.
 */
async function seedLegacyFakeBackendSession(
  root: string,
  owner: InteractiveRootOwner,
): Promise<string> {
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  const { id: sessionId } = await stores.sessionStore.create({
    cwd: root,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  });

  const legacy = new DatabaseSync(join(root, 'runtime.sqlite'));
  try {
    const row = legacy
      .prepare(`SELECT payload_json FROM session_metadata WHERE session_id = ?`)
      .get(sessionId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.backend = 'fake';
    legacy
      .prepare(`UPDATE session_metadata SET payload_json = ?, backend = ? WHERE session_id = ?`)
      .run(JSON.stringify(payload), 'fake', sessionId);
  } finally {
    legacy.close();
  }
  return sessionId;
}

async function createCapturedExecutionComposition(
  owner: InteractiveRootOwner,
  options: {
    readonly context?: Pick<
      RuntimeHostCompositionContext,
      'retainUntilProcessExit' | 'requestDrain'
    >;
    readonly safeBoundaryResume?: boolean;
    readonly onWorkHubResult?: (input: BackendSendInput) => void;
    readonly primaryBackendFactory?: BackendFactory;
    readonly coordinationBackendFactory?: BackendFactory;
    readonly generateSessionTitle?: ExecutionRuntimeHostCompositionDependencies['generateSessionTitle'];
    readonly residencies?: HostResidencyRegistry;
  } = {},
): Promise<{
  composition: Awaited<ReturnType<typeof createExecutionRuntimeHostComposition>>;
  manager: SessionManager;
}> {
  const originalRecover = SessionManager.prototype.recoverInterruptedSessionsStrict;
  const originalSafeBoundaryResume = process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
  const primaryBackendFactory =
    options.primaryBackendFactory ?? ((context) => new FakeBackend(context));
  const residencies = options.residencies;
  let manager: SessionManager | undefined;
  SessionManager.prototype.recoverInterruptedSessionsStrict = async function (stores) {
    manager = this;
    return originalRecover.call(this, stores);
  };
  try {
    if (options.safeBoundaryResume === true) process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME = '1';
    else if (options.safeBoundaryResume === false)
      process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME = '0';
    else delete process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
    // The production composition no longer registers a test backend of its
    // own; the deterministic one arrives through the same `primaryBackendFactory`
    // seam the Desktop E2E run uses.
    const composition = await createExecutionRuntimeHostComposition(
      {
        ...compositionContext(owner),
        ...(residencies
          ? {
              acquireResidency: (label: string, kind?: HostResidencyKind) =>
                residencies.acquire(label, kind),
            }
          : {}),
        ...options.context,
      },
      {},
      {
        generateSessionTitle: options.generateSessionTitle,
        primaryBackendFactory: (context) =>
          context.sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? (options.coordinationBackendFactory?.(context) ??
              new (class extends FakeBackend {
                override async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
                  if (input.text.startsWith('Host task result notification.')) {
                    options.onWorkHubResult?.(input);
                    yield* super.send({ ...input, text: 'The delegated result was received.' });
                  } else {
                    yield* super.send({ ...input, text: FAKE_HOLD_OPEN_PROMPT });
                  }
                }
              })(context))
            : primaryBackendFactory(context),
      },
    );
    await composition.recover();
    if (!manager) throw new Error('Production execution composition did not construct Runtime');
    return { composition, manager };
  } finally {
    if (originalSafeBoundaryResume === undefined) {
      delete process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME;
    } else {
      process.env.MAKA_RUNTIME_SAFE_BOUNDARY_RESUME = originalSafeBoundaryResume;
    }
    SessionManager.prototype.recoverInterruptedSessionsStrict = originalRecover;
  }
}

async function createClaimedGraphChild(input: {
  root: string;
  parentSessionId: string;
  suffix: string;
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
  prompt: string;
}): Promise<{ request: AgentGraphIntentClaimRequest; intent: AgentGraphRunnableIntent }> {
  const turnId = `graph-turn-${input.suffix}`;
  const runId = `graph-run-${input.suffix}`;
  const child = await input.stores.sessionStore.createSubagent({
    cwd: input.root,
    name: `Graph operator ${input.suffix}`,
    llmConnectionId: FAKE_CONNECTION_ID,
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'explore',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    subagentParent: {
      kind: 'subagent',
      parentSessionId: input.parentSessionId,
      spawnedBy: {
        parentRunId: `parent-run-${input.suffix}`,
        parentTurnId: `parent-turn-${input.suffix}`,
        toolCallId: `graph-tool-${input.suffix}`,
      },
      lifecycle: 'foreground',
    },
    subagentRuntime: {
      schemaVersion: 1,
      definitionVersion: LOCAL_READ_AGENT_DEFINITION.definitionVersion,
      agentId: LOCAL_READ_AGENT_DEFINITION.id,
      agentName: LOCAL_READ_AGENT_DEFINITION.name,
      profile: LOCAL_READ_AGENT_DEFINITION.profile,
      systemPrompt: LOCAL_READ_AGENT_DEFINITION.systemPrompt,
      toolNames: [...LOCAL_READ_AGENT_DEFINITION.tools],
      categoryPolicy: {},
    },
    subagentSpawn: {
      schemaVersion: 1,
      requestFingerprint: input.suffix.repeat(64),
      initialTurnId: turnId,
      initialRunId: runId,
    },
  });
  assert.equal(child.created, true);
  const intent: AgentGraphRunnableIntent = {
    schemaVersion: 1,
    intentId: `graph_intent_${input.suffix.repeat(32)}`,
    graphId: `graph-${input.suffix}`,
    readinessContextFingerprint: `sha256:${nextHex(input.suffix).repeat(64)}`,
    policyFingerprint: `sha256:${nextHex(nextHex(input.suffix)).repeat(64)}`,
    readinessId: `readiness-${input.suffix}`,
    operatorId: LOCAL_READ_AGENT_DEFINITION.id,
    targetSessionId: child.header.id,
    policyKind: 'map',
    triggerRouteIds: [`route-${input.suffix}`],
    triggerRecordIds: [`record-${input.suffix}`],
  };
  return {
    intent,
    request: {
      schemaVersion: 1,
      claimId: `graph_claim_${input.suffix.repeat(32)}`,
      graphId: intent.graphId,
      intentId: intent.intentId,
      intentFingerprint: fingerprintAgentGraphRunnableIntent({
        intent,
        executionInput: { prompt: input.prompt },
      }),
      readinessContextFingerprint: intent.readinessContextFingerprint,
      targetOperatorId: LOCAL_READ_AGENT_DEFINITION.id,
      targetSessionId: child.header.id,
      targetTurnId: turnId,
      targetRunId: runId,
    },
  };
}

function graphExecutionDescriptor(claim: AgentGraphIntentClaim) {
  return {
    kind: 'claimed_agent_graph_intent' as const,
    claim,
    agentId: LOCAL_READ_AGENT_DEFINITION.id,
    agentName: LOCAL_READ_AGENT_DEFINITION.name,
  };
}

function lifecycleUsageRecord() {
  return {
    id: 'usage_after_composition_drain',
    providerId: 'openai',
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 30,
    costUsd: 0.001,
    latencyMs: 100,
    status: 'success',
    date: '2026-07-30',
    ts: Date.UTC(2026, 6, 30),
    startedAt: Date.UTC(2026, 6, 30) - 100,
  } as Parameters<
    Awaited<ReturnType<typeof openInteractiveUsageStoresForWrite>>['telemetry']['recordLlmCall']
  >[0];
}

async function assertUniqueGraphExecutionFacts(
  stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>,
  claim: AgentGraphIntentClaim,
  userMessageId: string,
  expectedOutcome: 'completed' | 'cancelled' = 'completed',
): Promise<void> {
  const [runs, messages, runtimeEvents] = await Promise.all([
    stores.runtimeEventStore.listSessionInvocations(claim.targetSessionId),
    readLedgerMessages(stores.runtimeEventStore, claim.targetSessionId),
    stores.runtimeEventStore.readImmutableRuntimeEvents(claim.targetSessionId, claim.targetRunId),
  ]);
  assert.deepEqual(
    runs.filter((run) => run.turnId === claim.targetTurnId).map((run) => run.runId),
    [claim.targetRunId],
  );
  assert.deepEqual(
    messages
      .filter((message) => message.type === 'user' && message.turnId === claim.targetTurnId)
      .map((message) => message.id),
    [userMessageId],
  );
  assert.equal(
    runtimeEvents.filter((event) => event.content?.kind === 'invocation_opened').length,
    1,
  );
  assert.equal(
    runtimeEvents.filter(
      (event) => event.status === (expectedOutcome === 'cancelled' ? 'aborted' : 'completed'),
    ).length,
    1,
  );
}

function nextHex(value: string): string {
  const code = Number.parseInt(value, 16);
  return ((code + 1) % 16).toString(16);
}

async function withCompositionRoot(
  run: (fixture: {
    root: string;
    owner: NonNullable<Awaited<ReturnType<typeof tryAcquireInteractiveRootOwner>>>;
  }) => Promise<void>,
  parent = tmpdir(),
): Promise<void> {
  const base = await mkdtemp(join(parent, 'maka-execution-composition-'));
  const root = join(base, 'interactive');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  if (!owner) throw new Error('Unable to acquire composition test root');
  try {
    await run({ root, owner });
  } finally {
    await owner.close();
    await rm(base, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  await pollFor(predicate, { timeoutMs, pollMs: 10, message: 'Timed out waiting for condition' });
}

/** Test-only native start fixture shape; it cannot express legacy routing or control. */
interface NativeWorkHubFixtureStart {
  readonly actionId: string;
  readonly userText: string;
  readonly turnId?: string;
  readonly delegationText?: string;
  readonly attachments?: import('@maka/core/events').AttachmentRef[];
  readonly proposal:
    | { readonly disposition: 'create_new'; readonly title: string }
    | { readonly disposition: 'delegate_existing'; readonly sessionRef: string };
  readonly create?: WorkHubTaskStartInput['create'];
  readonly newWorkDefaults?: WorkHubCreateDefaults;
}

/** Uses a real admitted coordinator Root, never a fabricated authority callback. */
async function withWorkHubAuthority<T>(
  composition: ExecutionRuntimeHostComposition,
  context: ConnectionContext,
  text: string,
  run: (turnId: string) => Promise<T>,
  attachments?: import('@maka/core/events').AttachmentRef[],
) {
  const desktop = composition.clientCapabilities!.attachConnection(
    clientCapabilityConnectionIdentity(context.connectionId),
    { send: async () => {} },
  );
  const turnId = randomUUID();
  try {
    const registered = await composition.handlers['client.capability.replace'](
      { registrationId: randomUUID(), offers: workHubDesktopCapabilityOffers() },
      context,
    );
    assert.ok(registered.ok, JSON.stringify(registered));
    const started = await composition.handlers['workhub.coordination.answer'](
      { turnId, text, ...(attachments ? { attachments } : {}) },
      context,
    );
    assert.ok(started.ok, JSON.stringify(started));
    try {
      return await run(turnId);
    } finally {
      const root = await composition.handlers['turn.query'](
        { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId },
        context,
      );
      assert.ok(root.ok, JSON.stringify(root));
      const stopped = await composition.handlers['turn.stop'](
        { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId, runId: root.result.runId },
        context,
      );
      assert.ok(stopped.ok, JSON.stringify(stopped));
    }
  } finally {
    await desktop.close();
  }
}

async function actWorkHub(
  composition: ExecutionRuntimeHostComposition,
  input: NativeWorkHubFixtureStart,
  context: ConnectionContext,
) {
  const start = async (turnId: string) => {
    const base = {
      turnId,
      actionId: input.actionId,
      title:
        input.proposal.disposition === 'create_new'
          ? input.proposal.title
          : input.userText.slice(0, 64),
      text: input.delegationText ?? input.userText,
    };
    if (input.proposal.disposition === 'delegate_existing')
      return composition.handlers['workhub.tasks.start'](
        { ...base, sessionRef: input.proposal.sessionRef },
        context,
      );
    const current = await composition.handlers['workhub.coordination.query']({}, context);
    assert.ok(current.ok, JSON.stringify(current));
    assert.ok('model' in current.result);
    assert.ok(current.result.llmConnectionId);
    const settings: WorkHubCreateDefaults = {
      ...(input.newWorkDefaults?.executorId
        ? {}
        : {
            model: {
              llmConnectionId: current.result.llmConnectionId,
              llmConnectionSlug: current.result.llmConnectionSlug,
              model: current.result.model,
            },
          }),
      ...input.newWorkDefaults,
      permissionMode: input.newWorkDefaults?.permissionMode ?? 'ask',
    };
    return composition.handlers['workhub.tasks.start'](
      {
        ...base,
        create: input.create ?? { workspace: { kind: 'isolated' } },
        newWorkDefaults: settings,
      },
      context,
    );
  };
  return input.turnId
    ? start(input.turnId)
    : withWorkHubAuthority(composition, context, input.userText, start, input.attachments);
}

async function stopWorkHubTasks(
  composition: ExecutionRuntimeHostComposition,
  context: ConnectionContext,
  actionId: string,
  taskIds: readonly string[],
  userText: string,
) {
  return withWorkHubAuthority(composition, context, userText, (turnId) =>
    composition.handlers['workhub.tasks.stop']({ turnId, actionId, taskIds }, context),
  );
}

function isWorkHubCoordinatorFixtureRequest(input: {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
}): boolean {
  // WorkHubRead is also a worker tool, so it cannot distinguish either route.
  return input.messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes('You are Maka, the WorkHub assistant for this Desktop window.'),
  );
}
