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
import { createWorkHubTaskViewModel, useWorkHubExecutionView } from '../../renderer/features/workhub/testing.js';
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
