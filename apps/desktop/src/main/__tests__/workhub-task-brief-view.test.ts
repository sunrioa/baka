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
import type { WorkHubTask, WorkHubTaskAssignment, WorkHubTaskDetail } from '@maka/runtime-host/protocol';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import { useWorkHubTaskView, WorkHubTaskView, workHubTaskInputSource } from '../../renderer/features/workhub/testing.js';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';
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
