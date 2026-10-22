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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { UiLocale } from '@maka/core/ui-locale';
import type { StoredMessage } from '@maka/core/session';
import type { WorkHubPendingInteraction, WorkHubTask, WorkHubTaskAssignment, WorkHubTaskDetail, WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { useWorkHubSessionView, useWorkHubTaskInbox, useWorkHubTaskInput, useWorkHubTaskView, WorkHubTaskView, workHubTaskInputSource } from '../../renderer/features/workhub/testing.js';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { installReactRenderer, cleanupFakeDom } from './fake-dom.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';

afterEach(cleanupFakeDom);

const source = (workId: string): WorkHubTask => ({ workId, actionId: `latest-${workId}`, delegationId: `link-${workId}`,
  targetSessionId: 'shared-session', targetSessionName: 'Task', targetMessageId: `message-${workId}`, text: 'Later queued continuation', createdAt: 10, status: 'queued' });
function detail(workId: string, text = 'Original user goal, outside the loaded assignment page'): WorkHubTaskDetail {
  const task = source(workId);
  return { task, brief: { workId, actionId: task.actionId, delegationId: task.delegationId, status: 'ok', text } };
}
function fixture(readTask: WorkHubServices['readTask']) {
  const changes = new Set<() => void>(), unavailable = new Set<() => void>();
  const historyReads: Array<Parameters<WorkHubServices['taskHistory']>> = [];
  const services = {
    readTask,
    taskHistory: async (owner, input) => {
      historyReads.push([owner, input]);
      const task = source(input.workId);
      const assignments: WorkHubTaskAssignment[] = Array.from({ length: input.cursor ? 1 : 8 }, (_, index) => ({
        ...task, workId: input.workId, generationId: input.workId,
        actionId: index === 0 ? task.actionId : `other-${input.workId}-${index}`, delegationId: index === 0 ? task.delegationId : `other-link-${input.workId}-${index}`,
        state: index % 2 ? 'cancelled' : 'queued', superseded: false,
      }));
      return { workId: input.workId, assignments, nextCursor: input.cursor ? null : 'earlier-page' };
    },
    taskExecutions: async () => assert.fail('Queued metadata does not grant an execution read'),
    subscribeSessions: handler => { changes.add(handler); return () => { changes.delete(handler); }; },
    subscribeAvailability: handler => { unavailable.add(handler); return () => { unavailable.delete(handler); }; },
  } satisfies Pick<WorkHubServices, 'readTask' | 'taskHistory' | 'taskExecutions' | 'subscribeSessions' | 'subscribeAvailability'>;
  return { services, historyReads, changes, unavailable };
}
async function mount(services: ReturnType<typeof fixture>['services'], owner = 'host-a-owner', workId = 'work', available = true) {
  const { root } = installReactRenderer();
  let view!: ReturnType<typeof useWorkHubTaskView>;
  function Probe(props: { owner: string; workId: string; available: boolean }) { view = useWorkHubTaskView(services, props.owner, props.workId, props.available); return null; }
  const render = (nextOwner = owner, nextWork = workId, nextAvailable = available, locale: UiLocale = 'en') => act(async () => {
    root.render(createElement(LocaleProvider, { locale, children: createElement(Probe, { owner: nextOwner, workId: nextWork, available: nextAvailable }) }));
  });
  await render();
  return { get view() { return view; }, render };
}

test('the Host overview is independent of loaded history and a slow read never blocks the original queued input source', async () => {
  const pending = deferred<WorkHubTaskDetail>();
  const reads: Array<Parameters<WorkHubServices['readTask']>> = [];
  const f = fixture(async (owner, input) => { reads.push([owner, input]); return pending.promise; });
  const h = await mount(f.services);
  assert.equal(h.view.ready, true);
  assert.equal(h.view.assignments.length, 8);
  assert.ok(h.view.assignments.every(item => !item.text.includes('Original user goal')));
  assert.equal(h.view.briefReady, false);
  assert.equal(workHubTaskInputSource(h.view.currentSnapshot())?.actionId, 'latest-work');
  await act(async () => { await h.view.loadEarlier(); });
  await h.render();
  assert.equal(reads.length, 1, 'neither loadEarlier nor ordinary rerender scans the overview again');
  assert.deepEqual(reads[0], ['host-a-owner', { workId: 'work', includeBrief: true, briefLocale: 'en' }]);
  await act(async () => { pending.resolve(detail('work')); });
  assert.equal(h.view.brief?.status, 'ok');
  if (h.view.brief?.status !== 'ok') assert.fail('Expected the independent Host overview');
  assert.match(h.view.brief.text, /Original user goal/u);
  assert.equal(workHubTaskInputSource(h.view.currentSnapshot())?.actionId, 'latest-work');
});

for (const outcome of ['resolve', 'reject'] as const) test(`task input and original approval finish before a pending overview can ${outcome}`, { timeout: 5_000 }, async t => {
  const storage = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const owner = desktopSessionKey({ hostId: 'task-host', sessionId: 'maka_workhub_coordination' });
  const target = desktopSessionKey({ hostId: 'task-host', sessionId: 'shared-session' });
  const original: WorkHubTask = { ...source('work'), actionId: 'original-action', delegationId: 'original-link',
    targetSessionId: target, targetMessageId: 'original-message', status: 'waiting_for_user',
    execution: { turnId: 'waiting-turn', runId: 'waiting-run', sharedTurn: false } };
  const request: WorkHubPendingInteraction = { actionId: original.actionId, delegationId: original.delegationId,
    targetSessionName: original.targetSessionName, interaction: {
      schemaVersion: 1, interactionId: 'original-permission', sessionId: target,
      turnId: 'waiting-turn', runId: 'waiting-run', revision: 1, status: 'pending', outcome: null,
      request: { kind: 'permission', toolUseId: 'original-tool', prompt: { kind: 'tool_permission',
        toolName: 'Bash', category: 'shell_unsafe', reason: 'shell_dangerous',
        review: { kind: 'command', command: 'npm test' }, rememberForTurnAllowed: true } },
    } };
  const pending = deferred<WorkHubTaskDetail>();
  let settled = false, overviewReads = 0, transcriptReads = 0;
  const exactReads: Array<Parameters<WorkHubServices['readTask']>> = [];
  const f = fixture(async (sessionId, ref) => {
    assert.equal(sessionId, owner);
    if (ref.includeBrief) {
      ++overviewReads;
      assert.deepEqual(ref, { workId: 'work', includeBrief: true, briefLocale: 'en' });
      return pending.promise;
    }
    exactReads.push([sessionId, ref]);
    assert.deepEqual(ref, { actionId: original.actionId, delegationId: original.delegationId });
    return { task: original };
  });
  let requests = [request];
  let receipt: WorkHubTaskInputResult | undefined;
  const sends: Array<Parameters<WorkHubServices['sendTaskInput']>> = [];
  const answers: Array<Parameters<WorkHubServices['answerTaskInteraction']>> = [];
  const messages: StoredMessage[] = [
    { type: 'user', id: 'original-user', turnId: 'original-turn', ts: 1, text: 'Original task history' },
    { type: 'user', id: 'other-user', turnId: 'other-turn', ts: 2, text: 'Intervening Session history' },
  ];
  const services = {
    ...f.services,
    taskHistory: async (...args: Parameters<WorkHubServices['taskHistory']>) => {
      const page = await f.services.taskHistory(...args);
      return { ...page, assignments: page.assignments.map(item => ({ ...item, targetSessionId: target })) };
    },
    getTaskSession: async (id: string) => {
      assert.equal(id, target);
      return { id, name: 'Actual task', backend: 'ai-sdk' as const, model: 'worker-model', llmConnectionId: 'worker-connection', llmConnectionSlug: 'worker',
        permissionMode: 'ask' as const, cwd: '/original-worker', isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active' as const, connectionLocked: false };
    },
    async sendTaskInput(sessionId, input) {
      assert.equal(settled, false, 'input must reach its Host before overview settlement');
      assert.equal(sessionId, owner);
      assert.deepEqual(input, { inputId: input.inputId, workId: 'work', generationId: 'work', text: 'New task requirement' });
      sends.push([sessionId, input]);
      receipt = { inputId: input.inputId, workId: input.workId, generationId: input.generationId,
        sourceActionId: 'latest-work', sourceDelegationId: 'link-work', targetSessionId: target,
        targetMessageId: 'accepted-input', acceptedAt: 12, mode: 'queued_supplement', delivery: 'queued' };
      return { kind: 'accepted' as const, receipt };
    },
    async readTaskInput(sessionId, input) {
      assert.equal(sessionId, owner); assert.ok(receipt);
      assert.deepEqual(input, { workId: 'work', inputId: receipt.inputId });
      return receipt;
    },
    queryTaskInteractions: async (sessionId: string) => { assert.equal(sessionId, owner); return { requests, truncated: false }; },
    async answerTaskInteraction(sessionId, input) {
      assert.equal(settled, false, 'the original approval must reach its Host before overview settlement');
      assert.equal(sessionId, owner);
      assert.deepEqual(input, { actionId: original.actionId, interactionId: request.interaction.interactionId,
        expectedTurnId: request.interaction.turnId, expectedRunId: request.interaction.runId,
        answer: { kind: 'permission', decision: 'allow', rememberForTurn: false } });
      assert.deepEqual(requests, [request]);
      answers.push([sessionId, input]);
      if (input.answer.kind !== 'permission') assert.fail('Expected the native permission answer');
      requests = [];
      return { ...request.interaction, status: 'answered' as const, revision: 2,
        outcome: { ...input.answer, kind: 'permission_answer' as const, reviewer: 'user' as const, committedAt: 13 } };
    },
    subscribeActiveInteractions: () => () => {},
    observe(_id, _event, _error, phase) { phase('ready'); return () => {}; },
    async openTranscript(id, accept, _signal, _error, scope) {
      assert.equal(id, target); assert.equal(scope, undefined); ++transcriptReads;
      accept({ messages, ready: true, hasOlder: false });
      return { observationChanged() {}, loadEarlier: async () => {}, close: async () => {} };
    },
    stop: async () => assert.fail('This fixture must not stop an execution'),
  } satisfies Pick<WorkHubServices, 'taskHistory' | 'taskExecutions' | 'readTask' | 'getTaskSession' | 'subscribeSessions' |
    'subscribeAvailability' | 'sendTaskInput' | 'readTaskInput' | 'stop' | 'queryTaskInteractions' | 'answerTaskInteraction' |
    'subscribeActiveInteractions' | 'observe' | 'openTranscript'>;
  const ports = services as unknown as WorkHubServices;
  let view!: ReturnType<typeof useWorkHubTaskView>, input!: ReturnType<typeof useWorkHubTaskInput>;
  let inbox!: ReturnType<typeof useWorkHubTaskInbox>, session!: ReturnType<typeof useWorkHubSessionView>;
  function Probe() {
    view = useWorkHubTaskView(ports, owner, 'work');
    input = useWorkHubTaskInput(ports, owner, 'work', view);
    inbox = useWorkHubTaskInbox(ports, owner);
    session = useWorkHubSessionView(ports, target);
    return null;
  }
  const { root } = installReactRenderer();
  await act(async () => { root.render(createElement(LocaleProvider, { locale: 'en', children: createElement(Probe) })); });
  assert.equal(view.ready, true); assert.equal(view.briefLoading, true); assert.equal(view.briefReady, false);
  assert.equal(input.ready, true); assert.equal(input.source?.actionId, 'latest-work');
  assert.equal(inbox.ready, true); assert.equal(inbox.requestsForWork('work')[0], request);
  assert.equal(session.ready && session.sessionReady && session.transcript.ready, true);
  assert.deepEqual(session.transcript.messages, messages);
  await act(async () => { await view.loadEarlier(); });
  const assignments = view.assignments;
  await act(async () => {
    input.model.writeDraft('New task requirement');
    const [sent] = await Promise.all([input.send('New task requirement'), inbox.respond(request, { kind: 'permission', decision: 'allow', rememberForTurn: false })]);
    assert.equal(sent, true);
  });
  assert.equal(settled, false); assert.equal(sends.length, 1); assert.equal(answers.length, 1);
  assert.equal(input.state.receipt, receipt); assert.equal(input.state.sending, false); assert.equal(input.state.error, undefined);
  assert.equal(inbox.ready, true); assert.deepEqual(inbox.requests, []); assert.equal(inbox.isAnswering(request), false);
  assert.equal(view.briefReady, false); assert.equal(view.briefLoading, true);
  assert.deepEqual(exactReads, [[owner, { actionId: original.actionId, delegationId: original.delegationId }]]);
  await act(async () => {
    settled = true;
    if (outcome === 'resolve') {
      const result = detail('work', 'Overview arrived after accepted input and approval');
      pending.resolve({ ...result, task: { ...result.task, targetSessionId: target } });
    } else pending.reject(new Error('Overview failed after accepted input and approval'));
  });
  assert.equal(view.briefReady, true); assert.equal(view.briefLoading, false);
  if (outcome === 'resolve') assert.equal(view.brief?.status, 'ok');
  else assert.match(view.briefError ?? '', /Overview failed after accepted input and approval/u);
  assert.equal(input.state.receipt, receipt); assert.equal(input.state.error, undefined); assert.equal(input.ready, true);
  assert.equal(inbox.ready, true); assert.deepEqual(inbox.requests, []); assert.equal(inbox.error, undefined);
  assert.equal(view.ready, true); assert.equal(view.error, undefined); assert.deepEqual(view.assignments, assignments);
  assert.equal(session.ready && session.sessionReady && session.transcript.ready, true);
  assert.equal(session.error, undefined); assert.deepEqual(session.transcript.messages, messages);
  assert.equal(sends.length, 1); assert.equal(answers.length, 1); assert.equal(overviewReads, 1); assert.equal(transcriptReads, 1);
});

test('overview notification bursts coalesce exact-source requests without serializing normal history refresh', async () => {
  const pending = deferred<WorkHubTaskDetail>();
  let reads = 0, active = 0, maximum = 0;
  const f = fixture(async () => {
    const call = ++reads; maximum = Math.max(maximum, ++active);
    try { return call === 1 ? await pending.promise : detail('work', 'Refreshed overview'); }
    finally { active--; }
  });
  const h = await mount(f.services);
  await act(async () => { for (let i = 0; i < 10; i++) for (const notify of f.changes) notify(); });
  assert.equal(reads, 1);
  assert.ok(f.historyReads.length > 1, 'history continues while overview I/O remains pending');
  await act(async () => { pending.resolve(detail('work', 'Old overview')); });
  assert.equal(reads, 2); assert.equal(maximum, 1);
  assert.equal(h.view.brief?.status, 'ok');
  if (h.view.brief?.status !== 'ok') assert.fail('Expected refreshed overview');
  assert.equal(h.view.brief.text, 'Refreshed overview');
  const before = f.historyReads.length;
  await h.render('host-a-owner', 'work', true, 'zh-CN');
  assert.equal(reads, 3);
  assert.equal(f.historyReads.length, before, 'locale refresh does not remount or rescan full history');
});

for (const late of ['success', 'failure'] as const) test(`switching Host and task ignores a late overview ${late}`, async () => {
  const pending = deferred<WorkHubTaskDetail>();
  const f = fixture(async owner => owner === 'host-a-owner' ? pending.promise : detail('new-work', 'Current Host task overview'));
  const h = await mount(f.services);
  await h.render('host-b-owner', 'new-work');
  assert.equal(h.view.brief?.workId, 'new-work');
  await act(async () => {
    if (late === 'success') pending.resolve(detail('work', 'Foreign old Host overview'));
    else pending.reject(new Error('Old Host read failed'));
  });
  assert.equal(h.view.brief?.workId, 'new-work');
  assert.equal(h.view.briefError, undefined);
  assert.equal(h.view.assignments[0]?.workId, 'new-work');
});

test('availability invalidates an in-flight overview and foreign read identities never become current content', async () => {
  const pending = deferred<WorkHubTaskDetail>();
  let reads = 0;
  const f = fixture(async () => ++reads === 1 ? pending.promise : detail('foreign-work'));
  const h = await mount(f.services);
  await act(async () => { for (const notify of f.unavailable) notify(); });
  await act(async () => { pending.resolve(detail('work', 'Old Host epoch overview')); });
  assert.equal(reads, 2);
  assert.equal(h.view.brief, undefined);
  assert.match(h.view.briefError ?? '', /canonical source/u);
  assert.equal(h.view.ready, true, 'a rejected overview does not withdraw the task model');
  assert.equal(h.view.error, undefined);
  await h.render('host-a-owner', 'work', false);
  assert.equal(h.view.brief, undefined);
});

test('remote overview denial is independent and never falls back to broader history or another task read', async () => {
  const reads: Array<Parameters<WorkHubServices['readTask']>[1]> = [];
  const f = fixture(async (_owner, input) => {
    reads.push(input);
    if (input.includeBrief) throw new RuntimeHostOperationError('workhub.tasks.read', 'unauthorized', 'Overview is local-owner-only');
    return { task: source('work') };
  });
  const h = await mount(f.services, 'remote-owner');
  assert.equal(h.view.briefReady, true); assert.equal(h.view.brief, undefined);
  assert.match(h.view.briefError ?? '', /local-owner-only/u);
  assert.equal(h.view.ready, true); assert.equal(h.view.error, undefined);
  assert.equal(workHubTaskInputSource(h.view.currentSnapshot())?.actionId, 'latest-work');
  assert.deepEqual(reads, [{ workId: 'work', includeBrief: true, briefLocale: 'en' }]);
  assert.equal(f.historyReads.length, 1, 'no automatic history fallback is created');
  assert.equal((await f.services.readTask('remote-owner', { workId: 'work' })).task.workId, 'work', 'ordinary metadata remains independently readable');
});

test('task overview markup is at the top, read only and plain escaped text, including unavailable states', async () => {
  const text = 'Original <script>alert(1)</script> <img src=x onerror=alert(1)> user text';
  for (const brief of [detail('work', text).brief, undefined]) {
    const snapshot = { assignments: [], historyCursor: null, ready: true, loadingEarlier: false, executions: [], executionsReady: true };
    const view = { ...snapshot, brief, briefReady: true, briefLoading: false, briefError: brief ? undefined : 'Not authorized', currentSnapshot: () => snapshot,
      async refresh() {}, async loadEarlier() {}, selectAssignment() {}, selectExecution() {}, followLatest() {} };
    const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
      createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubTaskView, {
        services: {} as WorkHubServices, owner: 'owner', workId: 'work', name: 'Task', view,
      }))));
    const document = parseHTML(markup).document;
    const overview = document.querySelector('.workHubTaskBrief')!;
    assert.match(overview.querySelector('summary')!.textContent!, /Task overview.*Read only/u);
    assert.equal(overview.querySelectorAll('textarea,input,[contenteditable],script,img').length, 0);
    assert.equal(overview.hasAttribute('open'), false, 'asynchronous overview arrival cannot move the initial transcript placement');
    if (brief) assert.equal(overview.querySelector('pre')!.textContent, text);
    else assert.match(overview.textContent!, /history, input and original approvals remain available/u);
    assert.doesNotMatch(overview.textContent!, /latest-work|link-work|shared-session/u, 'the source binding is not a display label');
  }
});
