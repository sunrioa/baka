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
import { act, createElement, StrictMode } from 'react';
import { LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { WorkHubTask, WorkHubTaskAssignment, WorkHubTaskFindItem, WorkHubTaskFindResult, WorkHubPendingInteraction } from '@maka/runtime-host/protocol';
import { createWorkHubTaskSearchModel, workHubTaskCategory, workHubTaskTitle, workHubTaskSegments, useWorkHubTaskSearch, useWorkHubTaskSelection, WorkHubTaskRequest, workHubTaskCopy } from '../../renderer/features/workhub/testing.js';
import { WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import { installReactRenderer, cleanupFakeDom } from './fake-dom.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';

afterEach(cleanupFakeDom);

const hit = (id: string, state: WorkHubTaskFindItem['state'], lastActivityAt = 1): WorkHubTaskFindItem => ({ kind: 'task', id, title: `Title ${id}`, state, lastActivityAt, location: null, available: true, summary: 'Original task requirement', segments: 1 });

test('WorkHub has five automatic categories and no acceptance label in any locale', () => {
  const statuses: WorkHubTask['status'][] = ['queued', 'waiting_resource', 'running', 'stopping', 'waiting_for_user', 'pending_acceptance', 'failed', 'unavailable', 'cancelled', 'stopped'];
  assert.equal(new Set(statuses.map(workHubTaskCategory)).size, 5);
  assert.equal(workHubTaskCategory('waiting_resource'), 'queued');
  assert.equal(workHubTaskCategory('stopping'), 'running');
  for (const copy of Object.values(workHubTaskCopy)) {
    assert.equal(new Set(Object.values(copy.status)).size, 5);
    assert.doesNotMatch(copy.status.pending_acceptance, /acceptance|验收|驗收/iu);
  }
  assert.equal(workHubTaskTitle({ title: 'Stable task title', targetSessionName: 'Renamed Session', text: 'Original requirement' }), 'Stable task title');
  assert.equal(workHubTaskTitle({ targetSessionName: 'legacy-session-id', text: 'Original requirement\nDetails' }), 'Original requirement');
});

test('segment labels deduplicate complete histories and never infer a global number from a partial page', () => {
  const assignment = (targetSessionId: string, actionId: string): WorkHubTaskAssignment => ({ actionId, delegationId: actionId, workId: 'work', generationId: targetSessionId, targetSessionId, targetSessionName: 'Opaque Session name', targetMessageId: actionId, text: 'Task', createdAt: 1, state: 'owned', superseded: false });
  const rows = [assignment('new', 'new-followup'), assignment('new', 'new'), assignment('old', 'old')];
  assert.deepEqual(workHubTaskSegments(rows, true), [{ sessionId: 'old', number: 1 }, { sessionId: 'new', number: 2 }]);
  assert.deepEqual(workHubTaskSegments(rows.slice(0, 1), false), [{ sessionId: 'new', number: undefined }]);
  assert.deepEqual(workHubTaskSegments([Object.assign(rows[0]!, { segment: 4 })], false), [{ sessionId: 'new', number: 4 }]);
});

test('task discovery fetches only requested pages, sorts attention first and keeps task identity across duplicate hits', async () => {
  const calls: unknown[] = [];
  const pages: WorkHubTaskFindResult[] = [
    { items: [hit('done', 'ended', 9), hit('queued', 'queued', 8), hit('running', 'running', 7), hit('attention', 'waiting_for_user', 6)], match: 'recent', nextCursor: 'page-2' },
    { items: [hit('running', 'ended', 10), hit('older', 'stopped', 1)], match: 'recent', nextCursor: null },
  ];
  const model = createWorkHubTaskSearchModel({ findTasks: async (owner, input) => { calls.push([owner, input]); return pages[calls.length - 1]!; } }, 'host-owner', '');
  await model.refresh();
  assert.deepEqual(model.snapshot().items.map(item => item.id), ['attention', 'running', 'queued', 'done']);
  assert.deepEqual(calls, [['host-owner', {}]], 'opening the task list must not preload the whole index');
  await model.loadMore();
  assert.deepEqual(calls[1], ['host-owner', { cursor: 'page-2' }]);
  assert.deepEqual(model.snapshot().items.map(item => item.id), ['attention', 'queued', 'running', 'done', 'older']);
  assert.equal(model.snapshot().items.filter(item => item.id === 'running').length, 1);
  model.close();
});

test('search pagination preserves the exact query and the Host relevance order', async () => {
  const calls: unknown[] = [];
  const model = createWorkHubTaskSearchModel({ findTasks: async (_owner, input) => {
    calls.push(input);
    return calls.length === 1 ? { items: [hit('ended-relevant', 'ended'), hit('running-relevant', 'running')], match: 'all', nextCursor: 'cursor' }
      : { items: [{ ...hit('manual', 'available'), kind: 'session' }, hit('older-match', 'ended')], match: 'any', nextCursor: null };
  } }, 'owner', '登录 限流');
  await model.refresh();
  assert.deepEqual(model.snapshot().items.map(item => item.id), ['ended-relevant', 'running-relevant']);
  await model.loadMore();
  assert.deepEqual(calls, [{ query: '登录 限流' }, { query: '登录 限流', cursor: 'cursor' }]);
  assert.deepEqual(model.snapshot().items.map(item => item.id), ['ended-relevant', 'running-relevant', 'older-match']);
  assert.equal(model.snapshot().match, 'any');
  model.close();
});

test('a refresh retires a pending page and a closed search cannot publish late results', async () => {
  const more = deferred<WorkHubTaskFindResult>();
  let reads = 0;
  const model = createWorkHubTaskSearchModel({ findTasks: async () => {
    reads++;
    if (reads === 2) return more.promise;
    return { items: [hit(reads === 1 ? 'before' : 'after', 'running')], match: 'recent', nextCursor: reads === 1 ? 'next' : null };
  } }, 'owner', '');
  await model.refresh();
  const loading = model.loadMore();
  await model.refresh();
  more.resolve({ items: [hit('stale', 'ended')], match: 'recent', nextCursor: null });
  await loading;
  assert.deepEqual(model.snapshot().items.map(item => item.id), ['after']);
  model.close();
  await model.refresh();
  assert.equal(reads, 3);
});

test('StrictMode task search drops a former Host and query before rendering its late page', async () => {
  const oldPage = deferred<WorkHubTaskFindResult>();
  const services = { findTasks: async (owner: string) => owner === 'old' ? oldPage.promise : { items: [hit('current', 'running')], match: 'recent' as const, nextCursor: null },
    subscribeSessions: () => () => {}, subscribeActiveInteractions: () => () => {}, subscribeAvailability: () => () => {},
  } as unknown as WorkHubServices;
  let search!: ReturnType<typeof useWorkHubTaskSearch>;
  function Probe({ owner }: { owner: string }) { search = useWorkHubTaskSearch(services, owner, true); return null; }
  const { root } = installReactRenderer();
  const render = (owner: string) => createElement(StrictMode, {}, createElement(Probe, { owner }));
  await act(async () => { root.render(render('old')); });
  await act(async () => { root.render(render('new')); });
  assert.deepEqual(search.items.map(item => item.id), ['current']);
  await act(async () => { oldPage.resolve({ items: [hit('old', 'ended')], match: 'recent', nextCursor: null }); });
  assert.deepEqual(search.items.map(item => item.id), ['current']);
  await act(async () => { search.setQuery('登录'); });
  assert.equal(search.query, '登录');
  assert.equal(search.ready, true);
});

test('task permission prompts expose only original once, turn and deny decisions', async () => {
  for (const rememberForTurnAllowed of [true, false]) {
    const item: WorkHubPendingInteraction = { actionId: 'opaque-action', delegationId: 'opaque-delegation', targetSessionName: 'Task', interaction: {
      schemaVersion: 1, interactionId: 'opaque-request', sessionId: 'opaque-session', turnId: 'opaque-turn', runId: 'opaque-run', revision: 1, status: 'pending', outcome: null,
      request: { kind: 'permission', toolUseId: 'opaque-tool', prompt: { kind: 'tool_permission', toolName: 'Bash', category: 'shell_unsafe', reason: 'shell_dangerous', review: { kind: 'command', command: 'npm test' }, rememberForTurnAllowed } },
    } };
    const inbox = { requests: [item], truncated: false, ready: true, error: undefined, requestsForWork: () => [item], respond: async () => {}, refresh: async () => {}, isAnswering: () => false };
    const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null }, createElement(WorkHubServicesProvider, {
      services: {} as WorkHubServices, children: createElement(WorkHubTaskRequest, { item, inbox }),
    })));
    assert.match(markup, /Allow once/);
    assert.equal(markup.includes('Allow for this turn'), rememberForTurnAllowed);
    assert.match(markup, /Deny request/);
    assert.doesNotMatch(markup, /Allow for this task|Active task grants/);
    assert.doesNotMatch(markup, /opaque-(action|delegation|request|session|turn|run|tool)/);
  }
});

test('late task lookups cannot undo a newer selection, overview navigation or loss of availability', async () => {
  const pending = new Map(['a', 'c', 'd'].map(id => [id, deferred<{ task: WorkHubTask }>()]));
  const writes: Array<Parameters<WorkHubServices['presentation']['selectTask']>[0]> = [];
  const task = (workId: string): WorkHubTask => ({ actionId: workId, workId, delegationId: workId, targetSessionId: `session-${workId}`, targetSessionName: 'Conversation', targetMessageId: workId, text: `Task ${workId}`, status: 'running', createdAt: 1 });
  const services = { readTask: async (_owner: string, ref: { workId: string }) => pending.get(ref.workId)?.promise ?? { task: task(ref.workId) },
    presentation: { getSnapshot: async () => ({}), subscribe: () => () => {}, selectTask: async (selection: Parameters<WorkHubServices['presentation']['selectTask']>[0]) => { writes.push(selection); } },
  } as unknown as WorkHubServices;
  let selection!: ReturnType<typeof useWorkHubTaskSelection>;
  function Probe({ available }: { available: boolean }) { selection = useWorkHubTaskSelection(services, 'owner', available); return null; }
  const { root } = installReactRenderer();
  await act(async () => { root.render(createElement(Probe, { available: true })); });
  let first!: Promise<void>;
  await act(async () => { first = selection.open({ workId: 'a' }); });
  await act(async () => { await selection.open({ workId: 'b' }, 'Stable B title'); });
  await act(async () => { pending.get('a')!.resolve({ task: task('a') }); await first; });
  assert.deepEqual(writes.map(item => item.work?.workId), ['b']);
  assert.equal(writes[0]!.work?.name, 'Stable B title');
  let next!: Promise<void>;
  await act(async () => { next = selection.open({ workId: 'c' }); selection.select(undefined); });
  await act(async () => { pending.get('c')!.resolve({ task: task('c') }); await next; });
  assert.deepEqual(writes.map(item => item.work?.workId), ['b', undefined]);
  let offline!: Promise<void>;
  await act(async () => { offline = selection.open({ workId: 'd' }); });
  await act(async () => { root.render(createElement(Probe, { available: false })); });
  await act(async () => { pending.get('d')!.resolve({ task: task('d') }); await offline; });
  assert.equal(writes.length, 2);
});
