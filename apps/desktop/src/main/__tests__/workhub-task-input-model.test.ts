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
import test from 'node:test';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { WorkHubTaskInputRequest } from '@maka/core/workhub-task-input';
import type { WorkHubTaskAssignment, WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
import type { WorkHubTaskSendResult } from '../../shared/workhub-conversation.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { createWorkHubTaskInputModel, workHubTaskInputSource } from '../../renderer/features/workhub/testing.js';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';

const owner = (hostId = 'host-a') => desktopSessionKey({ hostId, sessionId: 'maka_workhub_coordination' });
const task = (id: string, hostId = 'host-a'): WorkHubTaskAssignment => ({
  workId: `work-${id}`, generationId: `generation-${id}`, actionId: `action-${id}`, delegationId: `delegation-${id}`,
  targetSessionId: desktopSessionKey({ hostId, sessionId: `session-${id}` }), targetSessionName: `Task ${id}`,
  targetMessageId: `message-${id}`, text: 'Original task', createdAt: 1, state: 'owned', superseded: false,
  execution: { turnId: `turn-${id}`, runId: `run-${id}` },
});
function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
function receipt(input: WorkHubTaskInputRequest, targetSessionId: string, delivery: WorkHubTaskInputResult['delivery'] = 'queued'): WorkHubTaskInputResult {
  const { text: _text, ...source } = input;
  return { ...source, targetSessionId, targetMessageId: `message-${input.inputId}`, acceptedAt: 7, mode: 'steering', delivery,
    ...(delivery === 'delivered' ? { execution: { turnId: 'delivered-turn', runId: 'delivered-run' } } : {}) };
}
type Services = Pick<WorkHubServices, 'sendTaskInput' | 'readTaskInput'>;

test('A → B → A and reload retain source-bound IDs, drafts and newer edits after a late old acknowledgment', async () => {
  const storage = memoryStorage(), a = task('a'), b = task('b');
  const response = deferred<WorkHubTaskSendResult>();
  let submitted!: WorkHubTaskInputRequest;
  const services: Services = { sendTaskInput: async (id, input) => { assert.equal(id, owner()); submitted = input; return response.promise; },
    readTaskInput: async () => receipt(submitted, a.targetSessionId) };
  const firstA = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage, () => 'original-input');
  firstA.writeDraft('Original correction');
  const sending = firstA.send(a, firstA.readDraft());
  assert.equal(firstA.snapshot().sending, true);
  const viewB = createWorkHubTaskInputModel(services, owner(), b.workId, () => b, storage);
  viewB.writeDraft('Independent B draft'); firstA.close();
  const revisitedA = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage);
  assert.equal(revisitedA.snapshot().attempt?.input.inputId, 'original-input');
  revisitedA.writeDraft('Newer A edit');
  response.resolve({ kind: 'accepted', receipt: receipt(submitted, a.targetSessionId) });
  assert.equal(await sending, true);
  assert.equal(viewB.readDraft(), 'Independent B draft');
  await revisitedA.reconcile();
  assert.equal(revisitedA.readDraft(), 'Newer A edit');
  assert.equal(revisitedA.snapshot().receipt?.inputId, 'original-input');
  const reloadedA = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage);
  assert.equal(reloadedA.readDraft(), 'Newer A edit');
  assert.equal(reloadedA.snapshot().attempt?.input.inputId, 'original-input');
  const foreign = createWorkHubTaskInputModel(services, owner('host-b'), a.workId, () => task('a', 'host-b'), storage);
  assert.equal(foreign.readDraft(), ''); assert.equal(foreign.snapshot().attempt, undefined);
  viewB.close(); revisitedA.close(); reloadedA.close(); foreign.close();
});

test('an unknown send and absent receipt never become a new ID; explicit retry keeps the old payload across a generation change', async () => {
  const a = task('a'), storage = memoryStorage(), calls: WorkHubTaskInputRequest[] = [];
  let current = a;
  const services: Services = { sendTaskInput: async (_id, input) => { calls.push(input); return calls.length === 1 ? { kind: 'unknown' } : { kind: 'accepted', receipt: receipt(input, a.targetSessionId, 'delivered') }; },
    readTaskInput: async () => { throw new Error('not_found while the original command may still be arriving'); } };
  const model = createWorkHubTaskInputModel(services, owner(), a.workId, () => current, storage, () => `input-${calls.length + 1}`);
  model.writeDraft('Original payload'); assert.equal(await model.send(a, model.readDraft()), false);
  model.writeDraft('Edited next input'); await model.reconcile();
  assert.equal(model.snapshot().attempt?.input.inputId, 'input-1');
  assert.equal(await model.send(a, model.readDraft()), false); assert.equal(calls.length, 1);
  current = { ...a, generationId: 'new-generation', actionId: 'new-action', delegationId: 'new-delegation' };
  assert.equal(await model.retry(), true);
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1]!.generationId, a.generationId);
  assert.equal(model.readDraft(), 'Edited next input');
  assert.equal(model.snapshot().receipt?.delivery, 'delivered');
  assert.equal(await model.send(a, 'stale callback'), false);
  assert.equal(await model.send(current, model.readDraft()), true);
  assert.equal(calls[2]!.sourceActionId, 'new-action'); assert.notEqual(calls[2]!.inputId, 'input-1');
  model.close();
});

test('reload reconciles accepted delivery without replaying a command and clears only the unchanged submitted draft', async () => {
  const a = task('a'), storage = memoryStorage();
  let submitted!: WorkHubTaskInputRequest, sends = 0;
  const services: Services = { sendTaskInput: async (_owner, input) => { sends++; submitted = input; return { kind: 'unknown' }; },
    readTaskInput: async (_owner, input) => { assert.equal(input.inputId, submitted.inputId); return receipt(submitted, a.targetSessionId, 'delivered'); } };
  const first = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage, () => 'reload-input');
  first.writeDraft('Correction before reload'); await first.send(a, first.readDraft()); first.close();
  const reload = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage);
  await reload.reconcile();
  assert.equal(reload.readDraft(), ''); assert.equal(reload.snapshot().receipt?.delivery, 'delivered'); assert.equal(sends, 1);
  await reload.reconcile(); assert.equal(reload.snapshot().receipt?.delivery, 'delivered'); assert.equal(sends, 1);
  reload.close();
});

test('late receipt reads cannot replace a newer input or downgrade proven delivery', async () => {
  const a = task('a'), storage = memoryStorage(), delayed = deferred<WorkHubTaskInputResult>();
  const calls: WorkHubTaskInputRequest[] = [];
  let reads = 0;
  const services: Services = { sendTaskInput: async (_owner, input) => { calls.push(input); return { kind: 'accepted', receipt: receipt(input, a.targetSessionId, calls.length > 1 ? 'delivered' : 'queued') }; },
    readTaskInput: async () => { reads++; return delayed.promise; } };
  const model = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage, () => `input-${calls.length + 1}`);
  model.writeDraft('First'); await model.send(a, 'First'); const reading = model.reconcile();
  model.writeDraft('Second'); await model.send(a, 'Second');
  delayed.resolve(receipt(calls[0]!, a.targetSessionId, 'unproven')); await reading;
  assert.equal(model.snapshot().receipt?.inputId, calls[1]!.inputId);
  assert.equal(model.snapshot().receipt?.delivery, 'delivered');
  await model.reconcile(); assert.equal(reads, 1, 'immutable delivered proof needs no polling');
  model.close();
});

test('foreign or contradictory receipts remain unknown and cannot clear the draft', async () => {
  const a = task('a'), storage = memoryStorage();
  let input!: WorkHubTaskInputRequest;
  const services: Services = { sendTaskInput: async (_owner, request) => { input = request; return { kind: 'accepted', receipt: receipt(request, task('a', 'foreign-host').targetSessionId) }; },
    readTaskInput: async () => receipt(input, a.targetSessionId) };
  const model = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage, () => 'identity-input');
  model.writeDraft('Keep this correction'); assert.equal(await model.send(a, model.readDraft()), false);
  assert.equal(model.snapshot().error, 'identity'); assert.equal(model.readDraft(), 'Keep this correction');
  assert.equal(model.snapshot().receipt, undefined);
  await model.reconcile(); assert.equal(model.snapshot().receipt?.targetSessionId, a.targetSessionId); assert.equal(model.readDraft(), '');
  model.close();
});

test('unavailable, full or unreadable recovery storage never dispatches or overwrites a possible pending identity', async () => {
  const a = task('a'); let sends = 0;
  const services: Services = { sendTaskInput: async () => { sends++; return { kind: 'unknown' }; }, readTaskInput: async () => { throw new Error('No input'); } };
  const full = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } };
  const corrupt = memoryStorage(); const key = JSON.stringify(['workhub-task-input-v1', owner(), a.workId]); corrupt.values.set(key, '{unreadable pending input');
  for (const storage of [undefined, full, corrupt]) {
    const model = createWorkHubTaskInputModel(services, owner(), a.workId, () => a, storage);
    model.writeDraft('Do not forget this'); assert.equal(await model.send(a, model.readDraft()), false);
    assert.equal(model.snapshot().error, 'storage'); model.close();
  }
  assert.equal(sends, 0); assert.equal(corrupt.values.get(key), '{unreadable pending input');
});

test('UTF-8 size, current-source identity and same-Host targeting are checked before reserving a command', async () => {
  const a = task('a'), storage = memoryStorage(); let source: WorkHubTaskAssignment | undefined = a, sends = 0;
  const services: Services = { sendTaskInput: async () => { sends++; return { kind: 'unknown' }; }, readTaskInput: async () => { throw new Error('No input'); } };
  const model = createWorkHubTaskInputModel(services, owner(), a.workId, () => source, storage);
  model.writeDraft('Last recoverable draft'); model.writeDraft('x'.repeat(120001));
  const reloaded = createWorkHubTaskInputModel(services, owner(), a.workId, () => source, storage);
  assert.equal(reloaded.readDraft(), 'Last recoverable draft'); assert.notEqual(reloaded.snapshot().error, 'storage'); reloaded.close();
  assert.equal(await model.send(a, '中'.repeat(17000)), false); assert.equal(model.snapshot().error, 'length');
  source = undefined; assert.equal(await model.send(a, 'Host not ready'), false);
  source = { ...a, generationId: 'replacement' }; assert.equal(await model.send(a, 'Old UI callback'), false);
  source = task('a', 'foreign-host'); assert.equal(await model.send(source, 'Wrong Host'), false);
  assert.equal(model.snapshot().error, 'identity'); assert.equal(sends, 0); model.close();
});

test('queued/shared/ended current work accepts input, but historical generations and earlier executions do not', () => {
  const a = task('a');
  const view = { assignments: [a], assignment: a, historyCursor: null, ready: true, loadingEarlier: false,
    executions: [{ sessionId: a.targetSessionId, turnId: 'turn-a', runId: 'run-a', status: 'completed' as const, terminalEventId: 'completed-a' }],
    execution: a.execution, executionsReady: true };
  assert.equal(workHubTaskInputSource(view), a);
  for (const state of ['queued', 'shared'] as const) {
    const assignment = { ...a, state, execution: undefined };
    assert.equal(workHubTaskInputSource({ ...view, assignments: [assignment], assignment, executions: [], execution: undefined }), assignment);
  }
  assert.equal(workHubTaskInputSource({ ...view, ready: false }), undefined);
  assert.equal(workHubTaskInputSource({ ...view, assignment: { ...a, superseded: true } }), undefined);
  assert.equal(workHubTaskInputSource({ ...view, assignments: [{ ...a, actionId: 'new-action' }, a] }), undefined);
  assert.equal(workHubTaskInputSource({ ...view, executions: [...view.executions, { sessionId: a.targetSessionId, turnId: 'later', runId: 'later-run', status: 'running' }] }), undefined);
});
