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
import { createServer } from 'node:http';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { connectRuntimeHost, type RuntimeHostConnection } from '@maka/runtime-host/client';
import { installRuntimeHostLogCapture, startExecutionRuntimeHostService } from '@maka/runtime-host/server';
import { RUNTIME_HOST_PROTOCOL_VERSION, type OperationInput, type WorkHubTaskAssignment } from '@maka/runtime-host/protocol';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { clientCapabilityEntityId } from '@maka/runtime-host/client-capability-entity-id';
import { createWorkHubTaskModelRuntime } from '../workhub-task-model-runtime.js';
import { readWorkHubCreationDefaults } from '../workhub-new-work-defaults.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { WorkHubTaskSendResult } from '../../shared/workhub-conversation.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import { DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { isTerminalRuntimeEvent, type RuntimeEvent } from '@maka/core/runtime-event';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { createExecutionRuntimeHostComposition } from '../../../../../packages/runtime-host/dist/server/execution-composition.js';

for (const bridge of ['pane', 'model'] as const) test(`Desktop ${bridge} task input reaches the native provider, supplements queued A in FIFO, and continues ended work while the coordinator is busy`, { timeout: 30_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-task-input-'));
  const root = join(base, 'root');
  const firstWorker = deferred<void>(), releaseFirst = deferred<void>(), releaseB = deferred<void>();
  const requests: Array<{ model: string; messages: Array<{ role: string; content: unknown }> }> = [];
  const queueOrder: string[] = [], errors: unknown[] = [];
  // Native requests append an environment message with role=user. Select the
  // latest fixture goal, not that trailing environment or an older goal.
  const goalText = (input: (typeof requests)[number]) => input.messages.filter(message => message.role === 'user').map(message =>
    typeof message.content === 'string' ? message.content : Array.isArray(message.content)
      ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n') : '',
  ).reverse().find(text => /^(?:NATIVE_TASK_INPUT|CORRECTION_INPUT|UNRELATED_B|QUEUED_A|INDEPENDENT_C|ENDED_CONTINUATION|FRESH_MODEL_FALLBACK)\b/u.test(text)) ?? '';
  let coordinatorRequests = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'fake-model' }], models: [{ name: 'fake-model' }] })); return;
      }
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'desktop-input-step', object: 'chat.completion.chunk', created: 1,
        model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      // The retired result tool is no longer published; WorkHubRead also exists
      // on workers. Distinguish the actual coordinator profile, not a read tool.
      if (input.messages.some((message: { role: string; content: unknown }) => message.role === 'system' &&
          typeof message.content === 'string' && message.content.includes('You are Maka, the WorkHub assistant for this Desktop window.'))) {
        coordinatorRequests++; response.write(chunk({ role: 'assistant', content: 'Coordinating unrelated user input.' }, null));
        await new Promise<void>(resolve => response.on('close', resolve)); return;
      }
      requests.push(input);
      const first = requests.length === 1;
      const prompt = goalText(input);
      for (const label of ['UNRELATED_B', 'QUEUED_A', 'INDEPENDENT_C', 'ENDED_CONTINUATION']) if (prompt.includes(label)) queueOrder.push(label);
      if (first) { firstWorker.resolve(); await releaseFirst.promise; }
      if (prompt.includes('UNRELATED_B')) await releaseB.promise;
      response.write(chunk(first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'input-search', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: 'Read' }) } }] }
        : { role: 'assistant', content: 'Completed the task.' }, null));
      response.write(chunk({}, first ? 'tool_calls' : 'stop')); response.end('data: [DONE]\n\n');
    })().catch(error => { errors.push(error); response.destroy(error as Error); });
  });
  t.signal.addEventListener('abort', () => { releaseFirst.resolve(); releaseB.resolve(); server.closeAllConnections(); }, { once: true });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined;
  let connection: RuntimeHostConnection | undefined;
  let client: DesktopRuntimeHostClient | undefined;
  const coordinationTurn = 'desktop-input-coordinator';
  try {
    host = await startExecutionRuntimeHostService({ rootPath: root }, {
      managedDeploymentAuthority: { authorityRoot: join(base, 'authority'), durabilityBoundary: base, homeDir: base },
    });
    const connected = await connectRuntimeHost({ rootPath: root, protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION } });
    assert.equal(connected.kind, 'connected'); if (connected.kind !== 'connected') assert.fail('No Desktop Host connection');
    connection = connected.connection; client = new DesktopRuntimeHostClient(connection);
    const catalog = await connection.request('connection.catalog.query', { kind: 'start' });
    assert.equal(catalog.kind, 'page'); if (catalog.kind !== 'page') assert.fail('No initial catalog');
    const created = await connection.request('connection.catalog.create', { expectedCatalogRevision: catalog.revision, connection: {
      slug: 'desktop-native-input', name: 'Local native input fixture', providerType: 'ollama', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, enabledModelIds: ['fake-model'],
    } });
    assert.equal(created.kind, 'committed'); if (created.kind !== 'committed') assert.fail('No fixture connection');
    assert.equal((await connection.request('connection.catalog.set-default-target', { expectedCatalogRevision: created.catalogRevision, target: { connectionId: created.connection.connectionId, modelId: 'fake-model' } })).kind, 'committed');
    await client.replaceClientCapabilities({ offers: () => [
      { offerId: 'desktop-workhub', label: 'Desktop WorkHub', version: '0', affinity: 'session', hostPathAccess: 'none', tools: ['control', 'find', 'start', 'continue', 'ask', 'stop'].map(name => ({ serverId: 'desktop_workhub', name, inputSchema: { type: 'object', additionalProperties: false } })) },
      { offerId: 'desktop-browser', label: 'Browser', version: '0', affinity: 'session', hostPathAccess: 'none', tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_wait', 'browser_extract'].map(name => ({ serverId: 'desktop_browser', name, inputSchema: { type: 'object', additionalProperties: false } })) },
    ], call: async () => assert.fail('This journey does not invoke a Desktop UI tool') });
    await client.resolveWorkHubCoordinationSession();
    await client.answerWorkHubCoordination({ turnId: coordinationTurn, text: 'Coordinate these independent tasks and remain available.' });
    const scope = { hostId: client.hostId, targetEpoch: 'native-fixture-target' };
    const workhub = createWorkHubTaskModelRuntime({ client: () => client!, isCurrent: () => true,
      createDefaults: () => readWorkHubCreationDefaults(client!), changed() {} });
    const actionId = (id: string) => bridge === 'model' ? clientCapabilityEntityId(JSON.stringify(['workhub-task', coordinationTurn, id])) : id;
    const started = bridge === 'model'
      ? await workhub.actTask(scope, coordinationTurn, 'native-input-action', { kind: 'start', input: { title: 'Native input task', text: 'NATIVE_TASK_INPUT' } })
      : await connection.request('workhub.tasks.start', { turnId: coordinationTurn, actionId: 'native-input-action', title: 'Native input task',
      text: 'NATIVE_TASK_INPUT', create: { workspace: { kind: 'isolated' } }, newWorkDefaults: {
        model: { llmConnectionId: created.connection.connectionId, llmConnectionSlug: 'desktop-native-input', model: 'fake-model' }, permissionMode: 'ask',
      } });
    assert.ok(started && ('workId' in started || 'taskId' in started));
    const startedId = 'taskId' in started ? started.taskId : 'workId' in started ? started.workId : undefined;
    assert.equal(startedId, actionId('native-input-action'));
    const firstTask = (await client.queryWorkHubTasks()).tasks.find(task => task.actionId === actionId('native-input-action')); assert.ok(firstTask?.workId);
    const found = await workhub.actTask(scope, coordinationTurn, 'native-find', { kind: 'find', input: { query: 'Native input task' } });
    assert.ok(found && 'items' in found);
    assert.equal(found.items[0]?.id, firstTask.workId);
    const source = (await client.readWorkHubTaskHistory({ workId: firstTask.workId })).assignments[0]!;
    const before = await client.getSession(source.targetSessionId); assert.ok(before);
    const handlers = new Map<string, IpcHandler>();
    registerRuntimeHostWorkHubIpc(client, { handle: (channel, handler) => handlers.set(channel, handler) }, {});
    const event = {} as Parameters<IpcHandler>[0];
    const send = async (input: OperationInput<'workhub.tasks.send'>): Promise<WorkHubTaskSendResult> => {
      if (bridge === 'pane') return await handlers.get('workhub:sendTaskInput')!(event, input) as WorkHubTaskSendResult;
      const result = await workhub.actTask(scope, coordinationTurn, input.inputId, { kind: 'continue', input: { taskId: input.workId, text: input.text } });
      assert.ok(result && 'mode' in result);
      const receipt = await client!.readWorkHubTaskInput({ workId: input.workId, inputId: actionId(input.inputId) });
      assert.equal(result.mode, receipt.mode); assert.equal(result.delivery, receipt.delivery);
      return { kind: 'accepted', receipt };
    };
    const read = async (inputId: string, workId: string) => await handlers.get('workhub:readTaskInput')!(event, { inputId: actionId(inputId), workId }) as Awaited<ReturnType<DesktopRuntimeHostClient['readWorkHubTaskInput']>>;
    const input = (a: WorkHubTaskAssignment, inputId: string, text: string): OperationInput<'workhub.tasks.send'> => ({ workId: a.workId, generationId: a.generationId, sourceActionId: a.actionId, sourceDelegationId: a.delegationId, inputId, text });
    await withTimeout(firstWorker.promise, 10_000, 'Native worker did not request its first step');
    const selectionInput = { turnId: coordinationTurn, actionId: 'native-selection', question: 'Which task should continue?',
      choices: [{ kind: 'task' as const, id: source.workId }] };
    const selecting = connection.request('workhub.tasks.ask', selectionInput);
    void selecting.catch(() => undefined);
    let pending: import('@maka/runtime-host/protocol').InteractionPendingSnapshot | undefined;
    await waitFor(async () => {
      const opened = await client!.openSession(WORKHUB_COORDINATION_SESSION_ID);
      try {
        pending = opened.snapshot.interactions.pending.find(item => item.request.kind === 'form' && item.request.toolUseId === 'native-selection');
        return pending !== undefined;
      } finally { await opened.close(); }
    }, { timeoutMs: 10_000, pollMs: 10, message: 'The native task selection never reached the original interaction authority' });
    assert.ok(pending); assert.equal(pending.request.kind, 'form');
    if (pending.request.kind !== 'form') assert.fail('No native selection Form');
    const targetField = pending.request.fields[0]!;
    assert.equal(targetField.kind, 'single_select');
    if (targetField.kind !== 'single_select') assert.fail('No native selection options');
    assert.equal(targetField.options.at(-1)!.value, 'new_task');
    await client.answerInteraction({ sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: pending.interactionId,
      answer: { kind: 'form', action: 'accept', values: { target: targetField.options[0]!.value } } });
    const selection = await selecting;
    assert.equal(selection.kind, 'selected');
    if (selection.kind !== 'selected') assert.fail('Original task not selected');
    assert.deepEqual(selection.target, { kind: 'task', id: source.workId });
    assert.equal(selection.generationId, source.generationId);
    assert.deepEqual(await connection.request('workhub.tasks.ask', selectionInput), selection, 'durable Form replay does not need a second user answer');
    assert.equal((await client.queryWorkHubTasks()).tasks.length, 1, 'selection alone never delegates another message');
    assert.equal(requests.length, 1, 'asking does not steer or interrupt the blocked worker');
    const observer = new RuntimeHostSessionObserver({ client, emitSessionsChanged() {} });
    try {
      const store = new DesktopTranscriptRangeStore(desktopSessionKey({ hostId: client.hostId, sessionId: source.targetSessionId }));
      await withTimeout(observer.openTranscript(source.targetSessionId, 'running-worker-history', {
        id: 99, send(_channel, batch) { store.accept(batch); queueMicrotask(() => observer.acknowledgeTranscript('running-worker-history', batch.generation, batch.deliverySequence, 99)); }, once() {}, off() {},
      }, 'history'), 10_000, 'Opening a running worker transcript waited for its provider to finish');
      assert.equal(store.snapshot().ready, true);
      assert.ok(store.snapshot().messages.some(message => message.type === 'user' && message.text === 'NATIVE_TASK_INPUT'), 'a sidebar reader receives the original task while the worker is still running');
    } finally { await observer.close(); }
    assert.doesNotMatch(JSON.stringify(requests[0]), /CORRECTION_INPUT/);
    const correction = input(source, 'desktop-correction', 'CORRECTION_INPUT: use the new user evidence.');
    const accepted = await send(correction); assert.equal(accepted.kind, 'accepted');
    if (accepted.kind !== 'accepted') assert.fail('Native steering was not admitted');
    assert.equal(accepted.receipt.mode, 'steering'); assert.equal(accepted.receipt.delivery, 'queued');
    assert.equal(requests.length, 1); assert.equal(coordinatorRequests, 1);
    releaseFirst.resolve(); await waitFor(() => requests.length === 2, { timeoutMs: 10000, pollMs: 10, message: 'Native correction did not reach the next request' });
    assert.match(JSON.stringify(requests[1]), /CORRECTION_INPUT/);
    assert.equal(JSON.stringify(requests[1]).split('CORRECTION_INPUT').length - 1, 1);
    await waitFor(async () => (await read(correction.inputId, source.workId)).delivery === 'delivered', { timeoutMs: 10000, pollMs: 10 });
    const firstExecution = (await client.readWorkHubTaskExecutions({ actionId: source.actionId, delegationId: source.delegationId })).executions.at(-1)!;
    await waitFor(async () => (await client!.queryTurn({ sessionId: source.targetSessionId, turnId: firstExecution.turnId })).status === 'completed', { timeoutMs: 10000, pollMs: 10 });
    await client.startTurn({ sessionId: source.targetSessionId, turnId: 'unrelated-b', content: { text: 'UNRELATED_B' } });
    await waitFor(() => queueOrder.includes('UNRELATED_B'), { timeoutMs: 10000, pollMs: 10, message: 'The unrelated B request was not observed' });
    const delegate = async (actionId: string, text: string) => {
      const started = bridge === 'model'
        ? await workhub.actTask(scope, coordinationTurn, actionId, { kind: 'start', input: { title: text, sessionRef: source.targetSessionId, text } })
        : await connection!.request('workhub.tasks.start', { turnId: coordinationTurn, actionId, title: text, sessionRef: source.targetSessionId, text });
      assert.ok(started && ('workId' in started || 'taskId' in started));
      const workId = 'taskId' in started ? started.taskId : 'workId' in started ? started.workId : undefined;
      const task = (await client!.queryWorkHubTasks()).tasks.find(item => item.workId === workId); assert.ok(task?.workId);
      return (await client!.readWorkHubTaskHistory({ workId: task.workId })).assignments[0]!;
    };
    const queuedA = await delegate('queued-a-action', 'QUEUED_A'); await delegate('independent-c-action', 'INDEPENDENT_C');
    const supplement = input(queuedA, 'desktop-queued-supplement', 'SUPPLEMENT_A: apply only to queued A.');
    const queued = await send(supplement); assert.equal(queued.kind, 'accepted');
    if (queued.kind !== 'accepted') assert.fail('Queued A was not supplemented');
    assert.equal(queued.receipt.mode, 'queued_supplement'); assert.equal(queued.receipt.delivery, 'queued');
    assert.deepEqual(await send(supplement), queued, 'exact retry returns the durable input without another queue entry');
    assert.deepEqual(queueOrder, ['UNRELATED_B']);
    releaseB.resolve(); await waitFor(() => queueOrder.includes('INDEPENDENT_C'), { timeoutMs: 10000, pollMs: 10 });
    assert.deepEqual(queueOrder.slice(0, 3), ['UNRELATED_B', 'QUEUED_A', 'INDEPENDENT_C']);
    const aRequest = requests.find(request => goalText(request).includes('QUEUED_A'))!;
    assert.match(JSON.stringify(aRequest), /SUPPLEMENT_A/);
    assert.equal(JSON.stringify(aRequest).split('SUPPLEMENT_A').length - 1, 1);
    const bRequest = requests.find(request => goalText(request).includes('UNRELATED_B'))!;
    assert.doesNotMatch(JSON.stringify(bRequest), /SUPPLEMENT_A/);
    await waitFor(async () => (await read(supplement.inputId, queuedA.workId)).delivery === 'delivered', { timeoutMs: 10000, pollMs: 10 });
    const followup = await send(input(queuedA, 'desktop-ended-continuation', 'ENDED_CONTINUATION'));
    assert.equal(followup.kind, 'accepted'); if (followup.kind !== 'accepted') assert.fail('Ended work did not continue');
    assert.equal(followup.receipt.mode, 'continuation');
    assert.equal(followup.receipt.workId, queuedA.workId); assert.equal(followup.receipt.targetSessionId, source.targetSessionId);
    await waitFor(() => queueOrder.includes('ENDED_CONTINUATION'), { timeoutMs: 10000, pollMs: 10 });
    assert.equal(coordinatorRequests, 1, 'direct input never waits for or starts another coordinator request');
    const after = await client.getSession(source.targetSessionId); assert.ok(after);
    assert.deepEqual({ model: after.model, workspace: after.workspace, permission: after.permissionMode }, { model: before.model, workspace: before.workspace, permission: before.permissionMode });
    const currentSource = (await client.readWorkHubTaskHistory({ workId: queuedA.workId })).assignments[0]!;
    const currentExecution = (await client.readWorkHubTaskExecutions({ actionId: currentSource.actionId, delegationId: currentSource.delegationId })).executions.at(-1)!;
    await waitFor(async () => (await client!.queryTurn({ sessionId: currentSource.targetSessionId, turnId: currentExecution.turnId })).status === 'completed', { timeoutMs: 10000, pollMs: 10 });
    const currentCatalog = await connection.request('connection.catalog.query', { kind: 'start' });
    assert.equal(currentCatalog.kind, 'page'); if (currentCatalog.kind !== 'page') assert.fail('No current catalog');
    const other = await connection.request('connection.catalog.create', { expectedCatalogRevision: currentCatalog.revision, connection: {
      slug: 'different-global', name: 'Different global route', providerType: 'ollama', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, enabledModelIds: ['different-global-model'],
    } });
    assert.equal(other.kind, 'committed'); if (other.kind !== 'committed') assert.fail('No other route');
    assert.equal((await connection.request('connection.catalog.set-default-target', { expectedCatalogRevision: other.catalogRevision, target: { connectionId: other.connection.connectionId, modelId: 'different-global-model' } })).kind, 'committed');
    const visibleFallback = await client.getWorkHubSession(); assert.equal(visibleFallback.id, WORKHUB_COORDINATION_SESSION_ID);
    assert.equal(visibleFallback.model, 'fake-model', 'the visible coordination fallback stays on its own route after the global default changes');
    const fresh = await workhub.actTask(scope, coordinationTurn, 'native-fresh-model', { kind: 'continue', input: {
      taskId: queuedA.workId, container: 'fresh', text: 'FRESH_MODEL_FALLBACK: continue in a fresh context.',
    } });
    assert.ok(fresh && 'taskId' in fresh && 'container' in fresh);
    assert.equal(fresh.taskId, queuedA.workId); assert.equal(fresh.container, 'fresh');
    const freshSource = (await client.readWorkHubTaskHistory({ workId: queuedA.workId })).assignments[0]!;
    const latestDetail = await client.readWorkHubTask({ workId: queuedA.workId });
    assert.equal(latestDetail.task.workId, queuedA.workId);
    assert.equal(latestDetail.task.actionId, freshSource.actionId, 'logical task lookup follows the fresh assignment, not the original segment');
    assert.equal(latestDetail.task.targetSessionId, freshSource.targetSessionId);
    await waitFor(() => requests.some(request => goalText(request).startsWith('FRESH_MODEL_FALLBACK')), { timeoutMs: 10000, pollMs: 10 });
    assert.equal(requests.find(request => goalText(request).startsWith('FRESH_MODEL_FALLBACK'))!.model, visibleFallback.model, 'the actual HTTP request uses the displayed fallback, not the different global model');
    const freshHeader = await client.getSession(freshSource.targetSessionId); assert.ok(freshHeader);
    assert.equal(freshHeader.llmConnectionId, visibleFallback.llmConnectionId);
    assert.equal(freshHeader.permissionMode, 'ask', 'new work never inherits the coordinator bypass');
    assert.notEqual(freshHeader.id, source.targetSessionId);
    const retained = await client.getSession(source.targetSessionId); assert.ok(retained);
    assert.deepEqual({ model: retained.model, workspace: retained.workspace, permission: retained.permissionMode }, { model: after.model, workspace: after.workspace, permission: after.permissionMode }, 'fresh creation does not reconfigure the old worker');
    const freshExecution = (await client.readWorkHubTaskExecutions({ actionId: freshSource.actionId, delegationId: freshSource.delegationId })).executions.at(-1)!;
    await waitFor(async () => (await client!.queryTurn({ sessionId: freshSource.targetSessionId, turnId: freshExecution.turnId })).status === 'completed', { timeoutMs: 10000, pollMs: 10 });
    const stop = await workhub.actTask(scope, coordinationTurn, 'native-stop-model', { kind: 'stop', input: { taskIds: [queuedA.workId] } });
    assert.deepEqual(stop, { kind: 'result', targets: [{ taskId: queuedA.workId, outcome: 'already_terminal' }] });
    assert.deepEqual(await workhub.actTask(scope, coordinationTurn, 'native-stop-model', { kind: 'stop', input: { taskIds: [queuedA.workId] } }), stop);
    const countBeforeChoice = (await client.queryWorkHubTasks()).tasks.length;
    const chooseNew = workhub.actTask(scope, coordinationTurn, 'native-new-task-choice', { kind: 'ask', input: { question: 'Start a separate task instead?', choices: [] } });
    void chooseNew.catch(() => undefined);
    const choiceToolId = clientCapabilityEntityId(JSON.stringify(['workhub-task', coordinationTurn, 'native-new-task-choice']));
    let newChoice: import('@maka/runtime-host/protocol').InteractionPendingSnapshot | undefined;
    await waitFor(async () => {
      const opened = await client!.openSession(WORKHUB_COORDINATION_SESSION_ID);
      try { newChoice = opened.snapshot.interactions.pending.find(item => item.request.kind === 'form' && item.request.toolUseId === choiceToolId); return newChoice !== undefined; }
      finally { await opened.close(); }
    }, { timeoutMs: 10000, pollMs: 10 });
    assert.ok(newChoice);
    await client.answerInteraction({ sessionId: WORKHUB_COORDINATION_SESSION_ID, interactionId: newChoice.interactionId,
      answer: { kind: 'form', action: 'accept', values: { target: 'new_task' } } });
    assert.deepEqual(await chooseNew, { kind: 'new_task' });
    assert.equal((await client.queryWorkHubTasks()).tasks.length, countBeforeChoice, 'new-task selection alone does not start work');
    assert.equal(coordinatorRequests, 1, 'default inspection does not call or restart the coordinator model');
    assert.deepEqual(errors, []);
  } finally {
    releaseFirst.resolve(); releaseB.resolve();
    // End the deliberately held provider stream before waiting for Host/client
    // teardown. Never issue another read behind an action that already failed.
    server.closeAllConnections();
    await host?.close(); await client?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});

test('Desktop native question interrupt settles the original durable attempt without draining the Host', { timeout: 30_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'maka-desktop-question-stop-'));
  const root = join(base, 'root');
  const questionTurnId = 'native-question-stop';
  const questionToolId = 'native-question-call';
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const questionRequests: typeof requests = [];
  const providerErrors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        return;
      }
      assert.equal(request.method, 'POST');
      const input = JSON.parse(body) as (typeof requests)[number];
      requests.push(input); // Count actual HTTP requests, never inferred model steps.
      const asking = input.messages.some(message =>
        message.role === 'user' && JSON.stringify(message.content).includes('NATIVE_QUESTION_STOP'));
      if (asking) { questionRequests.push(input); assert.match(body, /AskUserQuestion/); }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({
        id: `question-stop-${requests.length}`, object: 'chat.completion.chunk', created: 1,
        model: 'fake-model', choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      response.write(chunk(asking ? { role: 'assistant', tool_calls: [{
        index: 0, id: questionToolId, type: 'function', function: {
          name: 'AskUserQuestion', arguments: JSON.stringify({ questions: [{
            question: 'Which implementation should continue?', options: [{ label: 'First' }, { label: 'Second' }],
          }] }),
        },
      }] } : { role: 'assistant', content: 'The unrelated task is complete.' }, null));
      response.write(chunk({}, asking ? 'tool_calls' : 'stop'));
      response.end('data: [DONE]\n\n');
    })().catch(error => { providerErrors.push(error); response.destroy(error as Error); });
  });
  t.signal.addEventListener('abort', () => server.closeAllConnections(), { once: true });
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined;
  let client: DesktopRuntimeHostClient | undefined;
  let database: DatabaseSync | undefined;
  let ownerClosed: (() => boolean) | undefined;
  installRuntimeHostLogCapture();
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    host = await startExecutionRuntimeHostService({ rootPath: root }, {
      managedDeploymentAuthority: { authorityRoot: join(base, 'authority'), durabilityBoundary: base, homeDir: base },
      createComposition: async (context, options) => {
        const capability = context.owner.capability;
        const identity = await lstat(capability.canonicalPath, { bigint: true });
        t.diagnostic(`question-stop-root ${JSON.stringify({ rootId: capability.rootId,
          canonicalPath: capability.canonicalPath, dev: String(identity.dev), ino: String(identity.ino),
          uid: Number(identity.uid), pid: process.pid, ownerLockPath: context.owner.lockPath,
          controlDirectory: context.owner.controlDirectory })}`);
        ownerClosed = () => context.owner.closed;
        // This isolated fixture differs from the product default only to keep
        // startup's models.dev refresh offline. No user profile is imported.
        const policy = await openInteractiveRuntimePolicyStoresForWrite(context.owner.lease);
        const before = await policy.runtimePolicy.getSnapshot();
        assert.equal((await policy.runtimePolicy.mutate({ expectedRevision: before.revision,
          operation: { kind: 'set_privacy', value: { incognitoActive: true } },
        })).kind, 'committed');
        return createExecutionRuntimeHostComposition(context, {
          ...options, bootstrapRuntimePolicy: false, skillHomeDirectory: base,
        }, { generateSessionTitle: async () => undefined });
      },
    });
    const connected = await connectRuntimeHost({ rootPath: root,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION } });
    assert.equal(connected.kind, 'connected');
    if (connected.kind !== 'connected') assert.fail('No native question Host connection');
    const connection = connected.connection;
    client = new DesktopRuntimeHostClient(connection);
    await waitFor(async () => (await client!.queryHostDiagnostics()).logs.some(line =>
      line.includes('models.dev catalog refresh skipped: privacy mode is active')),
    { timeoutMs: 10_000, pollMs: 10, message: 'The fixture did not suppress startup catalog egress' });
    const privatePolicy = await connection.request('runtime.policy.query', {});
    assert.equal(privatePolicy.policy.privacy.incognitoActive, true);
    assert.equal((await connection.request('runtime.policy.mutate', {
      expectedRevision: privatePolicy.revision,
      operation: { kind: 'set_privacy', value: { incognitoActive: false } },
    })).kind, 'committed');
    const restoredPolicy = await connection.request('runtime.policy.query', {});
    assert.equal(restoredPolicy.policy.privacy.incognitoActive, false);
    t.diagnostic('question-stop fixture: startup incognito=true; public policy restored incognito=false before local provider execution');
    const catalog = await connection.request('connection.catalog.query', { kind: 'start' });
    assert.equal(catalog.kind, 'page');
    if (catalog.kind !== 'page') assert.fail('No initial native question catalog');
    const created = await connection.request('connection.catalog.create', {
      expectedCatalogRevision: catalog.revision, connection: { slug: 'native-question-stop',
        name: 'Local native question fixture', providerType: 'ollama',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true, enabledModelIds: ['fake-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') assert.fail('No local native question provider');
    assert.equal((await connection.request('connection.catalog.set-default-target', {
      expectedCatalogRevision: created.catalogRevision,
      target: { connectionId: created.connection.connectionId, modelId: 'fake-model' },
    })).kind, 'committed');
    const unrelated = await client.createSession({ sessionId: 'unrelated-completed-task',
      name: 'Completed unrelated task', workspace: { kind: 'host_path', path: root },
      modelTarget: { kind: 'default' }, permissionMode: 'ask',
    });
    const unrelatedTurn = 'unrelated-completed-turn';
    assert.equal((await client.startTurn({ sessionId: unrelated.id, turnId: unrelatedTurn,
      content: { text: 'Complete this unrelated bounded task.' },
    })).kind, 'started');
    await waitFor(async () => (await client!.queryTurn({ sessionId: unrelated.id, turnId: unrelatedTurn })).status === 'completed',
      { timeoutMs: 10_000, pollMs: 10, message: 'The real provider did not complete the unrelated task' });
    await waitFor(async () => !(await client!.queryHostDiagnostics()).residencies.some(item => item.label === 'operation.turn.start'),
      { timeoutMs: 10_000, pollMs: 10, message: 'The unrelated Root never released its residency' });
    assert.equal(requests.length, 1);
    database = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
    const completedFacts = () => ({
      runtime: database!.prepare('SELECT * FROM runtime_events WHERE session_id = ? ORDER BY invocation_id, event_seq').all(unrelated.id),
      runs: database!.prepare('SELECT * FROM core_agent_runs WHERE session_id = ? ORDER BY run_id').all(unrelated.id),
      events: database!.prepare('SELECT * FROM core_agent_run_events WHERE session_id = ? ORDER BY run_id, sequence').all(unrelated.id),
      admissions: database!.prepare('SELECT * FROM core_root_turn_admissions WHERE session_id = ? ORDER BY turn_id').all(unrelated.id),
      proofs: database!.prepare('SELECT * FROM core_root_source_message_proofs WHERE session_id = ? ORDER BY message_id').all(unrelated.id),
    });
    const unrelatedBefore = completedFacts();
    await client.replaceClientCapabilities({ offers: () => [
      { offerId: 'desktop-workhub', label: 'Desktop WorkHub', version: '0', affinity: 'session', hostPathAccess: 'none', tools: ['control', 'find', 'start', 'continue', 'ask', 'stop'].map(name => ({ serverId: 'desktop_workhub', name, inputSchema: { type: 'object', additionalProperties: false } })) },
      { offerId: 'desktop-browser', label: 'Browser', version: '0', affinity: 'session', hostPathAccess: 'none', tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_wait', 'browser_extract'].map(name => ({ serverId: 'desktop_browser', name, inputSchema: { type: 'object', additionalProperties: false } })) },
    ], call: async () => assert.fail('The native question never calls a Desktop UI tool') });
    await client.resolveWorkHubCoordinationSession();
    const headerBefore = await client.getWorkHubSession();
    assert.ok(headerBefore);
    await client.answerWorkHubCoordination({ turnId: questionTurnId, text: 'NATIVE_QUESTION_STOP: ask which implementation should continue.' });
    let question: import('@maka/runtime-host/protocol').InteractionPendingSnapshot | undefined;
    await waitFor(async () => {
      const opened = await client!.openSession(WORKHUB_COORDINATION_SESSION_ID);
      try {
        question = opened.snapshot.interactions.pending.find(item =>
          item.turnId === questionTurnId && item.request.kind === 'question' && item.request.toolUseId === questionToolId);
        return question !== undefined;
      } finally { await opened.close(); }
    }, { timeoutMs: 10_000, pollMs: 10, message: 'The actual provider tool call did not publish its native question' });
    assert.ok(question);
    assert.equal(question.request.kind, 'question');
    const operation = database.prepare(`SELECT operation_id, invocation_id, run_id, turn_id, tool_name,
      current_state, call_event_id, dispatch_event_id, result_event_id FROM tool_operations
      WHERE provider_tool_call_id = ? AND turn_id = ?`).all(questionToolId, questionTurnId) as unknown as Array<{
      operation_id: string; invocation_id: string; run_id: string; turn_id: string;
      tool_name: string; current_state: string; call_event_id: string; dispatch_event_id: string; result_event_id: string | null;
    }>;
    assert.equal(operation.length, 1);
    const original = operation[0]!;
    assert.equal(original.tool_name, 'AskUserQuestion');
    assert.equal(original.current_state, 'prepared');
    assert.ok(original.dispatch_event_id);
    assert.equal(original.result_event_id, null);
    assert.equal(original.run_id, question.runId);
    const call = database.prepare('SELECT payload_json FROM runtime_events WHERE event_id = ?').get(original.call_event_id);
    const callEvent = JSON.parse(String(call?.payload_json)) as RuntimeEvent;
    assert.equal(callEvent.sessionId, question.sessionId);
    assert.equal(callEvent.invocationId, original.invocation_id);
    assert.equal(callEvent.content?.kind, 'function_call');
    assert.equal(requests.length, 2);
    assert.equal(questionRequests.length, 1);
    const waitingDiagnostics = await client.queryHostDiagnostics();
    assert.ok(waitingDiagnostics.residencies.some(item => item.label === 'operation.workhub.coordination.answer' && item.count === 1));
    t.diagnostic(`question-stop-before-interrupt ${JSON.stringify({ operationId: original.operation_id,
      invocationId: original.invocation_id, residencies: waitingDiagnostics.residencies })}`);
    // Exactly one public Stop; all question closure and backend abort sequencing
    // below belongs to the real Host, never a test-supplied interaction callback.
    const interrupted = await client.interruptTurn({ sessionId: question.sessionId,
      turnId: question.turnId, runId: question.runId, interruptId: 'public-native-question-interrupt',
    });
    assert.equal(interrupted.turn.status, 'cancelled');
    await waitFor(async () => {
      const diagnostics = await client!.queryHostDiagnostics();
      assert.equal(diagnostics.state, 'ready', 'normal question cancellation must not poison or drain the Host');
      return !diagnostics.residencies.some(item => item.label === 'operation.workhub.coordination.answer');
    }, { timeoutMs: 10_000, pollMs: 10, message: 'The cancelled question Root never released its actual Host residency' });
    const rows = database.prepare(`SELECT event_id, event_seq, payload_json FROM runtime_events
      WHERE invocation_id = ? ORDER BY event_seq`).all(original.invocation_id) as unknown as Array<{
      event_id: string; event_seq: number; payload_json: string;
    }>;
    const outcomes = rows.filter(row => {
      const event = JSON.parse(row.payload_json) as RuntimeEvent;
      return event.content?.kind === 'function_response' && event.refs?.operationId === original.operation_id;
    });
    assert.equal(outcomes.length, 1, 'the original dispatched operation gets exactly one T2');
    const t2 = outcomes[0]!;
    const t2Event = JSON.parse(t2.payload_json) as RuntimeEvent;
    assert.equal(t2Event.content?.kind, 'function_response');
    if (t2Event.content?.kind !== 'function_response') assert.fail('No original native question T2');
    assert.equal(t2Event.content.id, questionToolId);
    assert.equal(t2Event.content.isError, true);
    assert.match(JSON.stringify(t2Event.content), /turn_stopped/);
    const terminals = rows.filter(row => isTerminalRuntimeEvent(JSON.parse(row.payload_json) as RuntimeEvent));
    assert.equal(terminals.length, 1);
    const terminal = terminals[0]!;
    // The native abort fact projects to the public Turn's cancelled status.
    assert.equal((JSON.parse(terminal.payload_json) as RuntimeEvent).status, 'aborted');
    assert.ok(t2.event_seq < terminal.event_seq, 'T2 commits before cancelled terminal seals the invocation');
    if (interrupted.turn.status !== 'cancelled') assert.fail('Public interrupt did not return the cancelled Turn');
    assert.equal(terminal.event_id, interrupted.turn.terminalEventId);
    const settled = database.prepare('SELECT current_state, result_event_id FROM tool_operations WHERE operation_id = ?').get(original.operation_id);
    assert.equal(settled?.current_state, 'outcome_committed');
    assert.equal(settled?.result_event_id, t2.event_id);
    const closed = await client.queryInteraction({ sessionId: question.sessionId, interactionId: question.interactionId });
    assert.equal(closed.status, 'closed');
    assert.equal(closed.outcome?.kind, 'closure');
    if (closed.outcome?.kind !== 'closure') assert.fail('No native question closure');
    assert.equal(closed.outcome.reason, 'turn_stopped');
    const headerAfter = await client.getWorkHubSession();
    assert.ok(headerAfter);
    assert.deepEqual({ permission: headerAfter.permissionMode, model: headerAfter.model, workspace: headerAfter.workspace },
      { permission: headerBefore.permissionMode, model: headerBefore.model, workspace: headerBefore.workspace });
    assert.deepEqual(completedFacts(), unrelatedBefore, 'cancelling this question never mutates the completed unrelated task');
    assert.equal((await client.queryTurn({ sessionId: unrelated.id, turnId: unrelatedTurn })).status, 'completed');
    assert.deepEqual(await connection.request('runtime.policy.query', {}), restoredPolicy);
    const finalDiagnostics = await client.queryHostDiagnostics();
    assert.equal(finalDiagnostics.state, 'ready');
    assert.equal(finalDiagnostics.residencies.find(item => item.label === 'operation.workhub.coordination.answer')?.count ?? 0, 0);
    assert.equal(requests.length, 2, 'one unrelated request plus one question request: no second provider request after Stop');
    assert.equal(questionRequests.length, 1, 'the actual HTTP handler observed exactly one question model request');
    assert.deepEqual(providerErrors, []);
    t.diagnostic(`question-stop-settled ${JSON.stringify({ operationId: original.operation_id,
      invocationId: original.invocation_id, t2EventId: t2.event_id, t2Sequence: t2.event_seq,
      terminalEventId: terminal.event_id, terminalSequence: terminal.event_seq,
      actualProviderRequests: requests.length, questionProviderRequests: questionRequests.length,
      hostState: finalDiagnostics.state, residencies: finalDiagnostics.residencies })}`);
  } finally {
    if (database) t.diagnostic(`question-stop-final-ledger ${JSON.stringify({
      events: database.prepare(`SELECT event_id, invocation_id, event_seq, event_kind,
        json_extract(payload_json, '$.status') AS status,
        json_extract(payload_json, '$.refs.operationId') AS operation_id
        FROM runtime_events WHERE turn_id = ? ORDER BY invocation_id, event_seq`).all(questionTurnId),
      operations: database.prepare('SELECT operation_id, current_state, call_event_id, dispatch_event_id, result_event_id FROM tool_operations WHERE turn_id = ?').all(questionTurnId),
      actualProviderRequests: requests.length, questionProviderRequests: questionRequests.length,
    })}`);
    database?.close();
    server.closeAllConnections();
    await client?.close();
    await host?.close();
    if (ownerClosed) assert.equal(ownerClosed(), true, 'the temporary Host owner closes normally');
    t.diagnostic(`question-stop-owner-closed ${JSON.stringify({ pid: process.pid, closed: ownerClosed?.() ?? null })}`);
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  }
});
