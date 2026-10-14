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
import { test, afterEach } from 'node:test';
import { act, createElement, StrictMode } from 'react';
import { LocaleProvider } from '@maka/ui';
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import type { WorkHubTaskAssignment, WorkHubTaskExecutionsResult, TurnSnapshot } from '@maka/runtime-host/protocol';
import { createWorkHubTaskViewModel, workHubTaskInputSource, useWorkHubExecutionView, useWorkHubTaskView, useWorkHubTaskInput } from '../../renderer/features/workhub/testing.js';
import type { SessionSummary } from '@maka/core/session';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';
import { installReactRenderer, cleanupFakeDom } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('real task view hook closes old scope readers and ignores late events/history after switching tasks', async () => {
  const subscriptions: Array<{ id: string; scope: Parameters<WorkHubServices['observe']>[5]; event: Parameters<WorkHubServices['observe']>[1]; closed: boolean }> = [];
  const readers: Array<{ scope: Parameters<WorkHubServices['openTranscript']>[4]; accept: Parameters<WorkHubServices['openTranscript']>[1]; signal: AbortSignal; closed: boolean }> = [];
  const services = {
    getTaskSession: async () => null,
    observe(id, event, _error, phase, execution, scope) {
      const subscription = { id, scope, event, closed: false }; subscriptions.push(subscription);
      phase('ready'); execution?.({ type: 'host_execution', available: true, rootTurn: { sessionId: id, ...scope!, status: 'running' } });
      return () => { subscription.closed = true; };
    },
    async openTranscript(_id, accept, signal, _error, scope) {
      const reader = { scope, accept, signal, closed: false }; readers.push(reader);
      accept({ messages: [{ type: 'user', id: `user-${scope!.turnId}`, turnId: scope!.turnId, ts: 1, text: scope!.turnId }], ready: true, hasOlder: false });
      return { observationChanged() {}, loadEarlier: async () => {}, close: async () => { reader.closed = true; } };
    },
  } satisfies Pick<WorkHubServices, 'getTaskSession' | 'observe' | 'openTranscript'>;
  let view!: ReturnType<typeof useWorkHubExecutionView>;
  function Probe({ id }: { id: string }) {
    view = useWorkHubExecutionView(services, 'same-session', { turnId: id, runId: `run-${id}` });
    return null;
  }
  const { root } = installReactRenderer();
  const render = (id: string) => createElement(StrictMode, {}, createElement(LocaleProvider, { locale: 'en', children: null }, createElement(Probe, { key: id, id })));
  await act(async () => { root.render(render('a')); });
  assert.equal(view.transcript.messages[0]!.turnId, 'a');
  await act(async () => { root.render(render('b')); });
  assert.equal(view.transcript.messages[0]!.turnId, 'b');
  assert.equal(view.activeTurn?.turnId, 'b');
  await act(async () => {
    for (const reader of readers.filter(item => item.scope?.turnId === 'a')) {
      assert.ok(reader.signal.aborted && reader.closed);
      reader.accept({ messages: [{ type: 'user', id: 'late-a', turnId: 'a', ts: 2, text: 'Late old task' }], ready: true, hasOlder: false });
    }
    for (const subscription of subscriptions.filter(item => item.scope?.turnId === 'a')) {
      assert.equal(subscription.closed, true);
      subscription.event({ type: 'error', id: 'late-error', turnId: 'a', ts: 3, message: 'Old task failed', recoverable: false });
    }
  });
  assert.equal(view.transcript.messages[0]!.turnId, 'b');
  assert.equal(view.error, undefined);
  assert.ok(subscriptions.every(item => item.scope && item.scope.runId === `run-${item.scope.turnId}`));
});

const assignment = (actionId: string, patch: Partial<WorkHubTaskAssignment> = {}): WorkHubTaskAssignment => ({
  workId: 'work', generationId: 'original', actionId, delegationId: `delegation-${actionId}`, targetSessionId: 'same-session',
  targetSessionName: 'Same name', targetMessageId: `message-${actionId}`, text: 'Same topic /same/path', createdAt: 1,
  state: 'owned', superseded: false, execution: { turnId: `turn-${actionId}`, runId: `run-${actionId}` }, ...patch,
});
const turn = (id: string, sessionId = 'same-session'): TurnSnapshot => ({ sessionId, turnId: id, runId: `run-${id}`, status: 'completed', terminalEventId: `terminal-${id}` });

for (const revisit of ['refresh', 'loadEarlier'] as const) test(`a selected old queued assignment becomes readable after ${revisit}`, async () => {
  let owned = false;
  const original = assignment('old', { state: 'queued', execution: undefined });
  const latest = Array.from({ length: 8 }, (_, index) => assignment(`new-${index}`, { state: 'queued', execution: undefined }));
  const current = () => owned ? assignment('old') : original;
  const exactReads: string[] = [];
  const model = createWorkHubTaskViewModel({
    taskHistory: async (_owner, input) => {
      if (input.actionId) { exactReads.push(input.actionId); return { workId: 'work', assignments: [current()], nextCursor: null }; }
      return input.cursor ? { workId: 'work', assignments: [current()], nextCursor: owned ? null : 'old-page-again' }
        : { workId: 'work', assignments: latest, nextCursor: 'old-page' };
    },
    taskExecutions: async (_owner, input) => ({ actionId: input.actionId, delegationId: input.delegationId, targetSessionId: 'same-session', executions: [{ sessionId: 'same-session', turnId: 'turn-old', runId: 'run-old', status: 'running' }], nextCursor: null }),
  }, 'host-a-coordinator', 'work');
  await model.refresh(); await model.loadEarlier(); model.selectAssignment('old');
  assert.equal(model.snapshot().assignment?.state, 'queued');
  owned = true;
  await model[revisit]();
  assert.equal(model.snapshot().assignment?.actionId, 'old');
  assert.equal(model.snapshot().assignment?.state, 'owned');
  assert.equal(model.snapshot().assignments.find(item => item.actionId === 'old')?.state, 'owned');
  assert.deepEqual(model.snapshot().execution, { turnId: 'turn-old', runId: 'run-old' });
  if (revisit === 'refresh') assert.deepEqual(exactReads, ['old'], 'refresh uses a bounded exact read, not an unbounded history walk');
  model.close();
});

test('a late failed exact assignment read cannot mark a newly selected assignment unavailable', async () => {
  const delayed = deferred<Awaited<ReturnType<WorkHubServices['taskHistory']>>>();
  const old = assignment('old', { state: 'queued', execution: undefined });
  const current = assignment('current');
  let exactStarted = false;
  const model = createWorkHubTaskViewModel({
    taskHistory: async (_owner, input) => {
      if (input.actionId) { exactStarted = true; return delayed.promise; }
      return input.cursor ? { workId: 'work', assignments: [old], nextCursor: null }
        : { workId: 'work', assignments: [current], nextCursor: 'old-page' };
    },
    taskExecutions: async () => ({ actionId: current.actionId, delegationId: current.delegationId, targetSessionId: current.targetSessionId, executions: [{ ...turn('turn-current'), runId: 'run-current' }], nextCursor: null }),
  }, 'host-a-coordinator', 'work');
  await model.refresh(); await model.loadEarlier(); model.selectAssignment('old');
  const refreshing = model.refresh();
  await waitFor(() => exactStarted);
  model.selectAssignment('current');
  await waitFor(() => model.snapshot().executionsReady);
  delayed.reject(new Error('Old assignment query failed'));
  await refreshing;
  assert.equal(model.snapshot().assignment?.actionId, 'current');
  assert.equal(model.snapshot().execution?.turnId, 'turn-current');
  assert.equal(model.snapshot().ready, true);
  assert.equal(model.snapshot().error, undefined);
  model.close();
});

test('task view follows the exact assignment and paged lineage, not a shared Session name or path', async () => {
  const original = assignment('a'), replacement = assignment('b', { generationId: 'replacement', targetSessionId: 'another-session' });
  const reads: string[] = [];
  let rows = [replacement, { ...original, superseded: true }];
  const model = createWorkHubTaskViewModel({
    taskHistory: async (_owner, input) => {
      assert.equal(input.workId, 'work');
      return input.cursor ? { workId: 'work', assignments: rows, nextCursor: null } : { workId: 'work', assignments: [], nextCursor: 'sparse-page' };
    },
    taskExecutions: async (owner, input) => {
      assert.equal(owner, 'host-a-coordinator'); reads.push(input.actionId);
      const a = rows.find(a => a.actionId === input.actionId)!;
      return { actionId: a.actionId, delegationId: a.delegationId, targetSessionId: a.targetSessionId,
        executions: [input.cursor ? turn('latest-resume', a.targetSessionId) : { ...turn(a.execution!.turnId, a.targetSessionId), runId: a.execution!.runId }], nextCursor: input.cursor ? null : 'lineage-page' };
    },
  }, 'host-a-coordinator', 'work');
  await model.refresh();
  assert.equal(model.snapshot().assignment?.actionId, 'b');
  assert.equal(model.snapshot().execution?.turnId, 'latest-resume');
  assert.deepEqual(model.snapshot().executions.map(item => item.turnId), ['turn-b', 'latest-resume']);
  model.selectAssignment('a');
  await waitFor(() => model.snapshot().executionsReady);
  assert.equal(model.snapshot().assignment?.superseded, true, 'superseded work remains inspectable');
  model.selectExecution('turn-a');
  rows = [assignment('c'), ...rows];
  await model.refresh();
  assert.equal(model.snapshot().assignment?.actionId, 'a', 'new work cannot take over an explicit history selection');
  assert.equal(model.snapshot().execution?.turnId, 'turn-a');
  model.followLatest();
  await waitFor(() => model.snapshot().assignment?.actionId === 'c' && model.snapshot().executionsReady);
  assert.ok(reads.every(id => ['a', 'b', 'c'].includes(id)));
  model.close();
});

test('a fresh queued generation becomes the current source while old Session history stays inspectable and read-only', async () => {
  const old = assignment('old');
  const fresh = assignment('fresh', { generationId: 'fresh-generation', targetSessionId: 'new-session', state: 'queued', execution: undefined });
  let rows = [old];
  const model = createWorkHubTaskViewModel({
    taskHistory: async () => ({ workId: 'work', assignments: rows, nextCursor: null }),
    taskExecutions: async (_owner, input) => {
      const selected = rows.find(row => row.actionId === input.actionId)!;
      return { actionId: selected.actionId, delegationId: selected.delegationId, targetSessionId: selected.targetSessionId,
        executions: [{ ...turn(selected.execution!.turnId, selected.targetSessionId), runId: selected.execution!.runId }], nextCursor: null };
    },
  }, 'host-a-coordinator', 'work');
  await model.refresh();
  rows = [fresh, { ...old, superseded: true }];
  await model.refresh();
  assert.equal(model.snapshot().assignment?.actionId, 'fresh');
  assert.equal(model.snapshot().execution, undefined);
  assert.equal(workHubTaskInputSource(model.snapshot())?.targetSessionId, 'new-session', 'queueing does not fall back to the retired owned Session');
  model.selectAssignment('old');
  await waitFor(() => model.snapshot().executionsReady);
  assert.equal(model.snapshot().assignment?.targetSessionId, old.targetSessionId);
  assert.equal(workHubTaskInputSource(model.snapshot()), undefined);
  const owned = { ...fresh, state: 'owned' as const, execution: { turnId: 'fresh-turn', runId: 'fresh-run' } };
  rows = [owned, { ...old, superseded: true }];
  await model.refresh();
  assert.equal(model.snapshot().assignment?.actionId, 'old', 'new progress does not steal an explicit historical inspection');
  model.followLatest();
  await waitFor(() => model.snapshot().assignment?.actionId === 'fresh' && model.snapshot().executionsReady);
  assert.equal(model.snapshot().execution?.runId, 'fresh-run');
  assert.equal(workHubTaskInputSource(model.snapshot())?.targetSessionId, 'new-session');
  model.close();
});

test('late lineage answers cannot replace a new assignment or outlive the view', async () => {
  const delayed = deferred<WorkHubTaskExecutionsResult>();
  const a = assignment('a'), b = assignment('b');
  const model = createWorkHubTaskViewModel({
    taskHistory: async () => ({ workId: 'work', assignments: [a, b], nextCursor: null }),
    taskExecutions: async (_owner, input) => input.actionId === 'a' ? delayed.promise : ({ actionId: b.actionId, delegationId: b.delegationId, targetSessionId: b.targetSessionId, executions: [{ ...turn('turn-b'), runId: 'run-b' }], nextCursor: null }),
  }, 'host-a-coordinator', 'work');
  const reading = model.refresh();
  await waitFor(() => model.snapshot().assignment?.actionId === 'a');
  model.selectAssignment('b');
  await waitFor(() => model.snapshot().executionsReady);
  delayed.resolve({ actionId: a.actionId, delegationId: a.delegationId, targetSessionId: a.targetSessionId, executions: [turn('late-a')], nextCursor: null });
  await reading;
  assert.equal(model.snapshot().execution?.turnId, 'turn-b');
  const last = model.snapshot(); model.close();
  await model.refresh(); model.selectAssignment('a');
  assert.equal(model.snapshot(), last);
});

test('queued, shared and unavailable assignments never fall back to a Session transcript', async () => {
  let executions = 0;
  const rows = ['queued', 'shared', 'unavailable'].map((state, index) => assignment(String(index), { state: state as WorkHubTaskAssignment['state'], execution: undefined }));
  const model = createWorkHubTaskViewModel({
    taskHistory: async () => ({ workId: 'work', assignments: rows, nextCursor: null }),
    taskExecutions: async () => { executions++; throw new Error('No owned root'); },
  }, 'host-a-coordinator', 'work');
  await model.refresh();
  for (const row of rows) { model.selectAssignment(row.actionId); assert.equal(model.snapshot().execution, undefined); }
  assert.equal(executions, 0);
  model.close();
});

test('task view rejects foreign work/session responses and expires restart-bound cursors honestly', async () => {
  let mode: 'foreign-work' | 'foreign-session' | 'expired' = 'foreign-work';
  const a = assignment('a');
  const model = createWorkHubTaskViewModel({
    taskHistory: async () => ({ workId: mode === 'foreign-work' ? 'foreign' : 'work', assignments: [a], nextCursor: null }),
    taskExecutions: async () => {
      if (mode === 'expired') throw new Error('expired cursor; refresh');
      return { actionId: a.actionId, delegationId: a.delegationId, targetSessionId: 'other-host-session', executions: [], nextCursor: null };
    },
  }, 'host-a-coordinator', 'work');
  await model.refresh(); assert.match(model.snapshot().error!, /changed work/);
  mode = 'foreign-session'; await model.refresh(); assert.match(model.snapshot().error!, /changed identity/);
  assert.equal(model.snapshot().execution, undefined);
  mode = 'expired'; await model.refresh(); assert.match(model.snapshot().error!, /expired cursor/);
  assert.equal(model.snapshot().executionsReady, false);
  model.close();
});

test('the shared task view withdraws send authority synchronously on scope or availability changes', async () => {
  const { root } = installReactRenderer();
  const availability = new Set<() => void>();
  const history = (workId: string) => ({ ...assignment(workId), workId });
  const services = {
    taskHistory: async (_owner: string, input: { workId: string }) => ({ workId: input.workId, assignments: [history(input.workId)], nextCursor: null }),
    taskExecutions: async (_owner: string, input: { actionId: string; delegationId: string }) => ({ actionId: input.actionId, delegationId: input.delegationId, targetSessionId: 'same-session', executions: [{ ...turn(`turn-${input.actionId}`), runId: `run-${input.actionId}` }], nextCursor: null }),
    subscribeSessions: () => () => {}, subscribeAvailability: (handler: () => void) => { availability.add(handler); return () => { availability.delete(handler); }; },
  } as unknown as WorkHubServices;
  let view!: ReturnType<typeof useWorkHubTaskView>;
  function Probe({ workId, available = true }: { workId?: string; available?: boolean }) { view = useWorkHubTaskView(services, 'owner', workId, available); return null; }
  await act(async () => { root.render(createElement(StrictMode, {}, createElement(Probe, { workId: 'a' }))); });
  const a = view; assert.equal(a.currentSnapshot().assignment?.workId, 'a');
  await act(async () => { root.render(createElement(StrictMode, {}, createElement(Probe, { workId: 'b' }))); });
  assert.equal(view.assignment?.workId, 'b'); assert.equal(a.currentSnapshot().ready, false);
  const beforeLoss = view;
  await act(async () => {
    for (const handler of availability) handler();
    assert.equal(beforeLoss.currentSnapshot().ready, false, 'invalidated live model outranks a still-rendered ready closure');
  });
  await act(async () => { root.render(createElement(StrictMode, {}, createElement(Probe, { workId: 'b', available: false }))); });
  assert.equal(view.assignment?.workId, 'b', 'records remain inspectable while authority is absent');
  assert.equal(beforeLoss.currentSnapshot().ready, false); assert.equal(view.currentSnapshot().ready, false);
  await act(async () => { root.render(createElement(StrictMode, {}, createElement(Probe, {}))); });
  assert.deepEqual(view.assignments, []); assert.equal(view.currentSnapshot().ready, false);
});

test('real task input hook uses the shared canonical source, survives switching, and stops only its shown owned execution', async (t) => {
  const storageValues = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => storageValues.get(key) ?? null, setItem: (key: string, value: string) => storageValues.set(key, value) } });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage'); });
  const owner = desktopSessionKey({ hostId: 'task-host', sessionId: 'maka_workhub_coordination' });
  const tasks = ['a', 'b'].map(id => assignment(id, { workId: `work-${id}`, targetSessionId: desktopSessionKey({ hostId: 'task-host', sessionId: `session-${id}` }) }));
  const sessionChanges = new Set<() => void>(), availability = new Set<() => void>();
  const sends: Array<Parameters<WorkHubServices['sendTaskInput']>> = [], stops: unknown[] = [];
  let backend: SessionSummary['backend'] = 'ai-sdk';
  let successor = '';
  const services = {
    taskHistory: async (_owner, input) => ({ workId: input.workId, assignments: tasks.filter(a => a.workId === input.workId), nextCursor: null }),
    taskExecutions: async (_owner, input) => {
      const a = tasks.find(a => a.actionId === input.actionId)!;
      return { actionId: a.actionId, delegationId: a.delegationId, targetSessionId: a.targetSessionId,
        executions: [{ sessionId: a.targetSessionId, ...a.execution!, status: 'completed', terminalEventId: 'old-complete' },
          { sessionId: a.targetSessionId, turnId: `${a.execution!.turnId}-resume${successor}`, runId: `${a.execution!.runId}-resume${successor}`, status: 'running' }], nextCursor: null };
    },
    getTaskSession: async id => ({ id, name: 'Actual task', backend, model: 'actual-worker-model', llmConnectionId: 'worker-connection', llmConnectionSlug: 'worker',
      permissionMode: 'ask', cwd: '/original-worker', isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active', connectionLocked: false, runningTurnIds: ['unrelated-root'] }),
    subscribeSessions: handler => { sessionChanges.add(handler); return () => { sessionChanges.delete(handler); }; },
    subscribeAvailability: handler => { availability.add(handler); return () => { availability.delete(handler); }; },
    sendTaskInput: async (...args) => {
      sends.push(args); const [_owner, input] = args;
      const a = tasks.find(a => a.actionId === input.sourceActionId)!;
      return { kind: 'accepted', receipt: { workId: input.workId, generationId: input.generationId, sourceActionId: input.sourceActionId, sourceDelegationId: input.sourceDelegationId,
        inputId: input.inputId, acceptedAt: 1, targetSessionId: a.targetSessionId, targetMessageId: 'accepted-input', mode: 'steering', delivery: 'queued' } };
    },
    readTaskInput: async () => { throw new Error('No receipt yet'); },
    stop: async (...args) => { stops.push(args); return []; },
  } satisfies Pick<WorkHubServices, 'taskHistory' | 'taskExecutions' | 'getTaskSession' | 'subscribeSessions' | 'subscribeAvailability' | 'sendTaskInput' | 'readTaskInput' | 'stop'>;
  let view!: ReturnType<typeof useWorkHubTaskView>, input!: ReturnType<typeof useWorkHubTaskInput>;
  function Probe({ workId }: { workId: string }) {
    view = useWorkHubTaskView(services, owner, workId);
    input = useWorkHubTaskInput(services, owner, workId, view);
    return null;
  }
  const { root } = installReactRenderer();
  const render = (workId: string) => root.render(createElement(StrictMode, {}, createElement(Probe, { workId })));
  await act(async () => { render('work-a'); });
  assert.equal(input.ready, true); const oldA = input;
  await act(async () => { input.model.writeDraft('A correction'); });
  await act(async () => { render('work-b'); });
  await act(async () => { input.model.writeDraft('B draft'); assert.equal(await oldA.send('stale A closure'), false); });
  assert.equal(sends.length, 0); assert.equal(input.model.readDraft(), 'B draft');
  await act(async () => { render('work-a'); });
  assert.equal(input.model.readDraft(), 'A correction');
  assert.equal(input.session?.model, 'actual-worker-model'); assert.equal(input.session?.permissionMode, 'ask'); assert.equal(input.session?.cwd, '/original-worker');
  await act(async () => { assert.equal(await input.send('A correction'), true); });
  assert.equal(sends.length, 1); assert.equal(sends[0]![0], owner); assert.equal(sends[0]![1].sourceActionId, tasks[0]!.actionId);
  await act(async () => { await input.stop(); });
  assert.deepEqual(stops, [[tasks[0]!.targetSessionId, 'turn-a-resume']], 'never stop the unrelated Session root or coordinator');
  const stillRendered = input;
  await act(async () => {
    successor = '-next'; await view.refresh();
    assert.equal(view.execution?.turnId, 'turn-a-resume', 'React has not committed the new execution yet');
    assert.equal(view.currentSnapshot().execution?.turnId, 'turn-a-resume-next');
    await stillRendered.stop();
    assert.equal(stops.length, 1, 'the old Stop must not target an undisplayed successor');
  });
  await act(async () => { await input.stop(); });
  assert.deepEqual(stops[1], [tasks[0]!.targetSessionId, 'turn-a-resume-next'], 'the newly rendered Stop can address its exact successor');
  await act(async () => { view.selectExecution('turn-a'); });
  assert.equal(input.ready, false); assert.equal(input.canStop, false);
  await act(async () => { await input.stop(); }); assert.equal(stops.length, 2);
  await act(async () => { view.followLatest(); });
  const beforeLoss = input;
  await act(async () => { for (const notify of availability) notify(); assert.equal(await beforeLoss.send('during loss'), false); });
  assert.equal(sends.length, 1);
  await act(async () => { backend = 'plugin-executor'; for (const notify of sessionChanges) notify(); });
  assert.equal(input.ready, false); await act(async () => { assert.equal(await input.send('unsupported'), false); });
  await act(async () => { await input.stop(); }); assert.equal(stops.length, 2);
  assert.equal(sends.length, 1);
});
