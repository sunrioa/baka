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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { DesktopTranscriptBatch } from '../../preload/transcript-contract.js';
import { createDesktopWorkHubServices } from '../../renderer/platform/desktop/create-workhub-services.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import type { WorkHubPrepareAttachmentsResult } from '../../shared/workhub-conversation.js';
import { encodeDesktopTranscriptBatches, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { AttachmentIngestBlockedError } from '@maka/core/attachments';
import type { AttachmentRef } from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { OperationInput } from '@maka/runtime-host/protocol';

test('WorkHub permission reads, writes and notifications stay on the Coordination Host', async () => {
  const owners = ['host-a', 'host-b'].map((hostId, index) => ({
    hostId, targetEpoch: `epoch-${hostId}`, epoch: `epoch-${hostId}`, profileId: hostId,
    profileName: hostId, profileKind: 'local', profileAccess: 'owner', readiness: 'ready', isDefault: index === 0,
  }));
  const modes = new Map<string, 'ask' | 'bypass'>(owners.map((owner) => [owner.hostId, 'ask']));
  const calls: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let bridge!: MakaBridge;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) { if (name === 'maka') bridge = value; } },
      ipcRenderer: {
        on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
        off(channel: string) { listeners.delete(channel); }, send() {},
        async invoke(channel: string, scope: { hostId: string }, mode: 'ask' | 'bypass' | number | OperationInput<'workhub.tasks.send'>) {
          if (channel === 'runtime-host:identities') return owners;
          if (channel === 'runtime-host:awaitReady') return { ready: true };
          assert.ok(modes.has(scope.hostId));
          calls.push(`${channel}:${scope.hostId}`);
          if (channel === 'workhub:queryInteractions') return { requests: [{
            actionId: 'action', delegationId: 'delegation', targetSessionName: 'Task',
            interaction: { sessionId: 'original-task', interactionId: 'question', turnId: 'turn', runId: 'run' },
          }], truncated: false };
          if (channel === 'workhub:answerInteraction') return { sessionId: 'original-task', interactionId: 'question', turnId: 'turn', runId: 'run', status: 'answered' };
          if (channel === 'workhub:queryTasks') return { tasks: [{ actionId: 'task-action', delegationId: 'task-delegation', targetSessionId: 'original-task' }], truncated: false };
          if (channel === 'workhub:findTasks') {
            assert.equal(scope.hostId, 'host-b');
            assert.deepEqual(JSON.parse(JSON.stringify(mode)), { query: '登录 限流', cursor: 'host-cursor' });
            return { items: [{ kind: 'task', id: 'older-than-recent-task', title: '登录限流', state: 'ended', lastActivityAt: 1, location: null, available: true, summary: 'Saved task title', segments: 2 }], match: 'all', nextCursor: 'next-page' };
          }
          if (channel === 'workhub:readTask' && typeof mode === 'object' && 'workId' in mode) {
            const overview = 'includeBrief' in mode && mode.includeBrief === true;
            assert.deepEqual(JSON.parse(JSON.stringify(mode)), { workId: 'older-than-recent-task', ...(overview ? { includeBrief: true, briefLocale: 'zh-CN' } : {}) });
            assert.equal(scope.hostId, 'host-b');
            return { task: { workId: 'older-than-recent-task', actionId: 'old-action', delegationId: 'old-delegation', targetSessionId: 'original-task',
              targetSessionName: 'Older task', targetMessageId: 'old-message', text: 'Original requirement', createdAt: 1, status: 'stopped' },
              ...(overview ? { brief: { workId: 'older-than-recent-task', actionId: 'old-action', delegationId: 'old-delegation', status: 'ok', text: 'Host 已拼装的有界概况（未经验证）' } } : {}) };
          }
          if (channel === 'workhub:readTask') return { task: { actionId: 'task-action', delegationId: 'task-delegation', targetSessionId: 'original-task' } };
          if (channel === 'workhub:sendTaskInput' || channel === 'workhub:readTaskInput') {
            const request = mode as OperationInput<'workhub.tasks.send'>;
            assert.equal(scope.hostId, 'host-b', 'task input stays on its non-default owning Host');
            assert.equal(request.inputId, 'task-input');
            const receipt = { workId: request.workId, inputId: request.inputId, generationId: 'task-generation', sourceActionId: 'task-action', sourceDelegationId: 'task-delegation',
              targetSessionId: 'original-task', targetMessageId: 'input-message', acceptedAt: 1, mode: 'steering', delivery: 'queued' };
            return channel === 'workhub:sendTaskInput' ? { kind: 'accepted', receipt } : receipt;
          }
          if (channel === 'workhub:getExecutionConcurrency') return 3;
          if (channel === 'workhub:setExecutionConcurrency') return mode;
          if (channel === 'workhub:setNewWorkPermissionMode') modes.set(scope.hostId, mode as 'ask' | 'bypass');
          return modes.get(scope.hostId);
        },
      },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto,
  });
  const session = (hostId: string, sessionId: string = WORKHUB_COORDINATION_SESSION_ID) => desktopSessionKey({ hostId, sessionId });
  assert.equal(await bridge.workHub.getNewWorkPermissionMode(session('host-b')), 'ask');
  assert.equal(await bridge.workHub.setNewWorkPermissionMode(session('host-b'), 'bypass'), 'bypass');
  assert.equal(await bridge.workHub.getNewWorkPermissionMode(session('host-a')), 'ask');
  assert.equal(await bridge.workHub.getExecutionConcurrency(session('host-b')), 3);
  assert.equal(await bridge.workHub.setExecutionConcurrency(session('host-b'), 1), 1);
  const inbox = await bridge.workHub.queryInteractions(session('host-b'));
  assert.equal(inbox.requests[0]!.interaction.sessionId, session('host-b', 'original-task'));
  const answered = await bridge.workHub.answerInteraction(session('host-b'), {
    actionId: 'action', interactionId: 'question', expectedTurnId: 'turn', expectedRunId: 'run',
    answer: { kind: 'question', answers: ['Yes'] },
  });
  assert.equal(answered.sessionId, session('host-b', 'original-task'));
  const taskPage = await bridge.workHub.queryTasks(session('host-b'));
  assert.equal(taskPage.tasks[0]!.targetSessionId, session('host-b', 'original-task'));
  const found = await bridge.workHub.findTasks(session('host-b'), { query: '登录 限流', cursor: 'host-cursor' });
  assert.ok(!('kind' in found), 'authorized indexed discovery retains its original result');
  assert.equal(found.items[0]!.title, '登录限流');
  assert.equal(found.items[0]!.id, 'older-than-recent-task');
  assert.equal(found.nextCursor, 'next-page');
  const taskRef = { actionId: 'task-action', delegationId: 'task-delegation' };
  const taskDetail = await bridge.workHub.readTask(session('host-b'), taskRef);
  assert.equal(taskDetail.task.targetSessionId, session('host-b', 'original-task'));
  const olderTask = await bridge.workHub.readTask(session('host-b'), { workId: 'older-than-recent-task' });
  assert.equal(olderTask.task.workId, 'older-than-recent-task');
  assert.equal(olderTask.task.targetSessionId, session('host-b', 'original-task'), 'exact task lookup uses the owning Host even when it is not default');
  const overview = await bridge.workHub.readTask(session('host-b'), { workId: 'older-than-recent-task', includeBrief: true, briefLocale: 'zh-CN' });
  assert.equal(overview.task.targetSessionId, session('host-b', 'original-task'));
  assert.deepEqual(structuredClone(overview.brief), { workId: 'older-than-recent-task', actionId: 'old-action', delegationId: 'old-delegation', status: 'ok', text: 'Host 已拼装的有界概况（未经验证）' }, 'preload preserves source binding and the bounded projection without remapping it into model context');
  const taskInput = { inputId: 'task-input', workId: 'task-work', generationId: 'task-generation', sourceActionId: 'task-action', sourceDelegationId: 'task-delegation', text: 'Correction' };
  const accepted = await bridge.workHub.sendTaskInput(session('host-b'), taskInput);
  assert.equal(accepted.kind, 'accepted');
  if (accepted.kind === 'accepted') {
    assert.equal(accepted.receipt.targetSessionId, session('host-b', 'original-task'));
    assert.equal(accepted.receipt.sourceActionId, taskInput.sourceActionId);
  }
  assert.equal((await bridge.workHub.readTaskInput(session('host-b'), { workId: taskInput.workId, inputId: taskInput.inputId })).targetSessionId, session('host-b', 'original-task'));
  const before = calls.length;
  await assert.rejects(bridge.workHub.setNewWorkPermissionMode(session('host-b', 'ordinary-session'), 'bypass'), /Invalid WorkHub Coordination Session identity/u);
  await assert.rejects(bridge.workHub.setNewWorkPermissionMode(session('unknown-host'), 'bypass'));
  await assert.rejects(bridge.workHub.setExecutionConcurrency(session('host-b', 'ordinary-session'), 1));
  await assert.rejects(bridge.workHub.getExecutionConcurrency(session('unknown-host')));
  await assert.rejects(bridge.workHub.queryInteractions(session('host-b', 'ordinary-session')));
  await assert.rejects(bridge.workHub.queryTasks(session('host-b', 'ordinary-session')));
  await assert.rejects(bridge.workHub.findTasks(session('host-b', 'ordinary-session'), { query: '登录' }));
  await assert.rejects(bridge.workHub.findTasks(session('unknown-host'), {}));
  await assert.rejects(bridge.workHub.readTask(session('unknown-host'), taskRef));
  await assert.rejects(bridge.workHub.sendTaskInput(session('host-b', 'ordinary-session'), taskInput));
  await assert.rejects(bridge.workHub.sendTaskInput(session('unknown-host'), taskInput));
  await assert.rejects(bridge.workHub.readTaskInput(session('host-b', 'ordinary-session'), { workId: taskInput.workId, inputId: taskInput.inputId }));
  await assert.rejects(bridge.workHub.answerInteraction(session('unknown-host'), {
    actionId: 'action', interactionId: 'question', expectedTurnId: 'turn', expectedRunId: 'run',
    answer: { kind: 'question', answers: ['Yes'] },
  }));
  assert.equal(calls.length, before, 'invalid identities never reach the mutation IPC');
  let notifications = 0;
  const unsubscribe = bridge.workHub.subscribeNewWorkPermissionMode(session('host-b'), () => { notifications++; });
  const notify = listeners.get('settings:externalChanged')!;
  notify({}, owners[0], {});
  notify({}, { ...owners[1], targetEpoch: 'old-epoch' }, {});
  assert.equal(notifications, 0);
  notify({}, owners[1], {});
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(listeners.has('settings:externalChanged'), false);
});

test('WorkHub upload references round-trip through idle answers, both queue modes and attachment reads', async (t) => {
  const owner = {
    hostId: 'upload-host', targetEpoch: 'upload-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const nativeSessionId = 'maka_workhub_coordination';
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: nativeSessionId });
  const uploaded: AttachmentRef = {
    kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 5,
    ref: { kind: 'session_file', sessionId: nativeSessionId, relativePath: 'brief.txt' },
  };
  let preparationResult: WorkHubPrepareAttachmentsResult = {
    ok: true,
    attachments: [uploaded],
  };
  const sent: Array<{ channel: string; attachments: AttachmentRef[] }> = [];
  let bridge!: MakaBridge;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) { if (name === 'maka') bridge = value; } },
      ipcRenderer: {
        on() {}, off() {}, send() {},
        async invoke(channel: string, ...args: unknown[]) {
          if (channel === 'runtime-host:identities') {
            return [{ ...owner, epoch: owner.targetEpoch, isDefault: true }];
          }
          if (channel === 'runtime-host:awaitReady') return { ready: true };
          assert.equal((args[0] as typeof owner).hostId, owner.hostId);
          if (channel === 'workhub:prepareAttachments') {
            assert.deepEqual(structuredClone(args[1]), [{ name: 'brief.txt', mimeType: 'text/plain', base64: 'aGVsbG8=' }]);
            return preparationResult;
          }
          if (channel === 'workhub:answer') {
            const input = args[1] as { attachments: AttachmentRef[]; turnId: string };
            sent.push({ channel, attachments: input.attachments });
            return { kind: 'admitted', turnId: input.turnId };
          }
          assert.equal(args[1], nativeSessionId);
          if (channel === 'sessions:submitMessage') {
            const command = args[3] as { retainedAttachments: AttachmentRef[] };
            sent.push({ channel, attachments: command.retainedAttachments });
            return { ok: true, disposition: args[2] === 'current_turn' ? 'steering' : 'followup', attachments: [uploaded] };
          }
          if (channel === 'attachments:readBytes') return { ok: true, base64: 'aGVsbG8=' };
          throw new Error(`Unexpected channel: ${channel}`);
        },
      },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Uint8Array, btoa, crypto: globalThis.crypto,
  });
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const services = createDesktopWorkHubServices(bridge);
  const attachments = await services.prepareAttachments(sessionId, [
    { file: new File(['hello'], 'brief.txt', { type: 'text/plain' }) },
  ]);
  assert.equal(attachments[0]!.ref.kind, 'session_file');
  assert.equal(attachments[0]!.ref.kind === 'session_file' && attachments[0]!.ref.sessionId, sessionId);
  assert.equal((await services.answer(sessionId, { turnId: 'idle-answer', text: 'read this', attachments })).kind, 'admitted');
  for (const placement of ['next_turn', 'current_turn'] as const) {
    assert.equal(await services.enqueueMessage(sessionId, `message-${placement}`, 'read this', attachments, placement), 'admitted');
  }
  assert.deepEqual(structuredClone(sent.map(({ attachments }) => attachments)), [[uploaded], [uploaded], [uploaded]]);
  assert.equal((await services.readAttachmentBytes(sessionId, 'brief.txt')).ok, true);
  preparationResult = { ok: false, code: 'item_too_large' };
  await assert.rejects(
    services.prepareAttachments(sessionId, [
      { file: new File(['hello'], 'brief.txt', { type: 'text/plain' }) },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof AttachmentIngestBlockedError);
      assert.equal(error.code, 'item_too_large');
      return true;
    },
  );
  const foreign = [{ ...uploaded, ref: { ...uploaded.ref, kind: 'session_file' as const, sessionId: desktopSessionKey({ hostId: 'foreign-host', sessionId: nativeSessionId }), relativePath: 'brief.txt' } }];
  await assert.rejects(services.answer(sessionId, { turnId: 'foreign', text: 'read this', attachments: foreign }), /another Host or Session/);
  await assert.rejects(services.enqueueMessage(sessionId, 'foreign', 'read this', foreign, 'next_turn'), /another Host or Session/);
});

// Keep the real preload in this consumer regression; the IPC stub models the
// observer's earlier-history answer to a load-earlier command.
test('WorkHub loads earlier history through the preload with a fragmented answer', { timeout: 5_000 }, async (t) => {
  const owner = {
    hostId: 'owner-host', targetEpoch: 'owner-epoch', profileId: 'local',
    profileName: 'Local', profileKind: 'local', profileAccess: 'owner', readiness: 'ready',
  };
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: 'coordination' });
  const identity = { sessionId: 'coordination', generation: 'generation-1', hostEpoch: 'epoch-1' };
  const tail: StoredMessage = {
    type: 'user', id: 'tail-message', turnId: 'tail-turn', ts: 8, text: 'Tail coordination record',
  };
  const earlier: StoredMessage = {
    type: 'user', id: 'earlier-message', turnId: 'earlier-turn', ts: 7,
    text: 'Earlier coordination record '.repeat(8_000),
  };
  const earlierReads: unknown[] = [];
  const projections: Array<{ ids: string[]; hasOlder: boolean }> = [];
  const partialProjectionCounts: number[] = [];
  let bridge: MakaBridge | undefined;
  let consumerId: string;
  let deliverySequence = 0;
  let deliverDirect: ((batch: DesktopTranscriptBatch) => void) | undefined;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const responseDelivered = deferred<void>();
  const deliver = (batch: Omit<DesktopTranscriptBatch, 'deliverySequence'>) => {
    listeners.get(`sessions:transcript:${consumerId}`)?.({}, owner, {
      ...batch, deliverySequence: ++deliverySequence,
    });
  };
  const ipcRenderer = {
    on(channel: string, listener: (...args: unknown[]) => void) { listeners.set(channel, listener); },
    off(channel: string) { listeners.delete(channel); },
    send() {},
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (channel === 'runtime-host:identities') {
        return [{ ...owner, epoch: owner.targetEpoch, isDefault: true }];
      }
      if (channel === 'runtime-host:awaitReady') return { ready: true };
      if (channel === 'session-local:transcript') return null;
      if (channel === 'sessions:transcript:open') {
        consumerId = args[2] as string;
        assert.equal(args[3], 'history');
        for (const batch of encodeDesktopTranscriptSnapshot({
          beginsAtTurnBoundary: true,
          ...identity, durableThrough: 8, hasOlder: true,
          durable: [{ sequence: 8, message: tail }],
        })) deliver(batch);
        return { kind: 'ready', value: { ...identity, readThroughMessageId: null } };
      }
      if (channel === 'sessions:transcript:load-earlier') {
        earlierReads.push(args[1]);
        assert.equal(args[1], consumerId);
        // Bound a regressed request loop so the test reports its cause.
        if (earlierReads.length >= 2) return new Promise(() => {});
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          for (const batch of encodeDesktopTranscriptBatches(identity, {
            durableThrough: 8, durable: [{ sequence: 7, message: earlier }],
            earlierThan: 8, hasOlder: false, reset: false, ready: true,
          })) {
            deliver(batch);
            if (!batch.ready) {
              partialProjectionCounts.push(projections.length);
              // A batch from another replica generation must not publish a
              // partial answer or complete it.
              deliverDirect?.({
                ...batch, generation: 'unrelated-generation', fragments: [], ready: true,
                deliverySequence: ++deliverySequence,
              });
              partialProjectionCounts.push(projections.length);
            }
          }
        } finally {
          responseDelivered.resolve();
        }
        return;
      }
      if (
        channel === 'sessions:transcript:ack' ||
        channel === 'sessions:transcript:acknowledge-tail' ||
        channel === 'sessions:transcript:close'
      ) return;
      throw new Error(`Unexpected channel: ${channel}`);
    },
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      ipcRenderer,
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) {
        if (name === 'maka') bridge = value;
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    Uint8Array, crypto: globalThis.crypto,
  });
  assert.ok(bridge);
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const services = createDesktopWorkHubServices({
    ...bridge,
    transcripts: {
      ...bridge.transcripts,
      open(requestedSessionId, handler, registerCancellation, mode) {
        deliverDirect = handler;
        return bridge!.transcripts.open(requestedSessionId, handler, registerCancellation, mode);
      },
    },
  });
  const handle = await services.openTranscript(
    sessionId,
    (snapshot) => projections.push({ ids: snapshot.messages.map((message) => message.id), hasOlder: snapshot.hasOlder }),
    new AbortController().signal,
    (error) => { throw error; },
  );
  try {
    await waitFor(() => projections.length === 1, { timeoutMs: 5_000 });
    await handle.loadEarlier();
    await responseDelivered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(earlierReads.length, 1);
    assert.ok(partialProjectionCounts.length > 0, 'the answer has to span more than one batch');
    assert.ok(partialProjectionCounts.every((count) => count === 1));
    assert.deepEqual(projections, [
      { ids: ['tail-message'], hasOlder: true },
      { ids: ['earlier-message', 'tail-message'], hasOlder: false },
    ]);
    await handle.loadEarlier();
    assert.equal(earlierReads.length, 1, 'nothing is read once no earlier history remains');
  } finally {
    await handle.close();
  }
});


// Exercise the production adapter with the same cached handle shape returned by
// preload, and both orderings of initial read failure versus observation readiness.
for (const initial of ['failure-before-ready', 'failure-after-ready', 'cached'] as const) {
  test(`WorkHub read reconnects through observation readiness: ${initial}`, async (t) => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '?surface=workhub' } } });
    t.after(() => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    });
    const sessionId = desktopSessionKey({ hostId: 'owner-host', sessionId: 'coordination' });
    let openCount = 0;
    let closedCount = 0;
    let onReady!: () => void;
    let onPhase!: (phase: 'pending' | 'ready') => void;
    let latest: readonly StoredMessage[] = [];
    const opening = deferred<void>();
    const errors: unknown[] = [];
    const services = createDesktopWorkHubServices({
      attachments: {},
      sessions: {
        subscribeEvents(_sessionId, _onEvent, phase) {
          onReady = () => phase!('ready');
          onPhase = phase!;
          return () => {};
        },
      } satisfies Pick<MakaBridge['sessions'], 'subscribeEvents'>,
      transcripts: {
        async open(_sessionId, onBatch) {
          const attempt = ++openCount;
          if (attempt === 1 && initial !== 'cached') {
            await opening.promise;
            throw new Error('transient initial open failure');
          }
          const cached = attempt === 1;
          const identity = {
            sessionId: 'coordination', generation: cached ? 'cached:epoch-1' : `live-${attempt}`,
            hostEpoch: 'epoch-1',
          };
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            ...identity, durableThrough: 1, hasOlder: false,
            durable: [{ sequence: 1, message: { type: 'user', id: cached ? 'cached-message' : 'live-message', turnId: 'turn-1', ts: 1, text: cached ? 'Cached history' : 'Live history' } }],
          })) onBatch({ ...batch, deliverySequence: 1 });
          const unavailable = async () => { throw new Error('Reconnect the Host to load uncached history'); };
          return {
            ...identity, readThroughMessageId: null,
            acknowledgeTail: async () => {},
            loadEarlier: unavailable,
            close: async () => { closedCount++; },
          };
        },
      } satisfies Pick<MakaBridge['transcripts'], 'open'>,
    } as unknown as Parameters<typeof createDesktopWorkHubServices>[0]);
    const handle = await services.openTranscript(sessionId, (snapshot) => { latest = snapshot.messages; }, new AbortController().signal, (error) => errors.push(error));
    const unsubscribe = services.observe(sessionId, () => {}, (error) => errors.push(error), handle.observationChanged);
    try {
      if (initial === 'failure-after-ready') onReady();
      opening.resolve();
      if (initial !== 'cached') await waitFor(() => errors.length > 0, { timeoutMs: 5_000 });
      else assert.deepEqual(latest.map(({ id }) => id), ['cached-message']);
      onPhase('pending');
      onPhase('ready');
      await waitFor(() => latest.some(({ id }) => id === 'live-message'), { timeoutMs: 5_000 });
      assert.equal(openCount, 2);
      assert.equal(closedCount, initial === 'cached' ? 1 : 0);
      assert.equal(errors.length, initial === 'cached' ? 0 : 1);
    } finally {
      unsubscribe();
      await handle.close();
    }
  });
}
