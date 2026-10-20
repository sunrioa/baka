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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deferred, waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { connectRuntimeHost, type RuntimeHostConnection } from '@maka/runtime-host/client';
import { startExecutionRuntimeHostService } from '@maka/runtime-host/server';
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
      if (input.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'WorkHubResult')) {
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
