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
import { LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import { RuntimeHostRequestInterruptedError, RuntimeHostOperationError } from '@maka/runtime-host/client';
import { registerRuntimeHostSessionExecutionIpc, type RuntimeHostSessionExecutionIpcDeps } from '../runtime-host-session-execution-ipc-main.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { DesktopSessionStopResult } from '../../preload/bridge-contract.js';
import type { AttachmentRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import { WorkHubModelConfigurationRequiredError, WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../../renderer/features/workhub/index.js';
import { useWorkHubController } from '../../renderer/features/workhub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('WorkHub task overview stays independent of coordinator input and retries a lost continuation with the same identity', async () => {
  const task: import('@maka/runtime-host/protocol').WorkHubTask = { actionId: 'task-action', delegationId: 'task-delegation', targetSessionId: 'task-session', targetSessionName: 'Same name', targetMessageId: 'message', text: 'Task', createdAt: 1, status: 'waiting_for_dependency' };
  const attempts: Parameters<WorkHubServices['continueTask']>[1][] = [];
  let hostChange!: Parameters<WorkHubServices['subscribeHosts']>[0];
  const h = await mountController(false, {
    subscribeHosts: listener => { hostChange = listener; return () => {}; },
    queryTasks: async () => ({ tasks: [task], truncated: false }),
    readTask: async () => ({ task }),
    continueTask: async (_owner, input) => { attempts.push(input); if (attempts.length === 1) throw new Error('Lost receipt'); return { disposition: 'delegate_existing', targetSessionId: task.targetSessionId }; },
  });
  assert.equal(h.controller.activeTurn, undefined, 'a worker wait never blocks the coordinator composer');
  assert.equal(h.controller.taskOverview.tasks[0]!.status, 'waiting_for_dependency');
  await act(async () => { await assert.rejects(h.controller.taskOverview.continue(task, 'New user instruction'), /Lost receipt/); });
  await act(async () => { hostChange({ hostId: 'host-1', isDefault: true, readiness: 'unavailable' }); });
  assert.equal(h.controller.taskOverview.ready, false);
  await assert.rejects(h.controller.taskOverview.continue(task, 'New user instruction'), /unavailable/);
  await act(async () => { hostChange({ hostId: 'host-1', isDefault: true, readiness: 'ready' }); });
  assert.deepEqual(h.controller.taskOverview.pendingContinuation(task), attempts[0]);
  await assert.rejects(h.controller.taskOverview.continue(task, 'Changed instruction'), /original continuation/);
  await act(async () => { assert.equal(await h.controller.taskOverview.continue(task, 'New user instruction'), true); });
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0], 'an explicit retry cannot create a second native root identity');
  assert.deepEqual(h.queueMutations, []);
});
test('task overview drops old Host projections and detail reads after a Host switch', async () => {
  const first = JSON.stringify(['host-1', 'workhub-coordination']);
  const second = JSON.stringify(['host-2', 'workhub-coordination']);
  let selected = first;
  let hostChange!: Parameters<WorkHubServices['subscribeHosts']>[0];
  const task: import('@maka/runtime-host/protocol').WorkHubTask = { actionId: 'action', delegationId: 'delegation', targetSessionId: 'first-task', targetSessionName: 'Old task', targetMessageId: 'message', text: 'Task', createdAt: 1, status: 'running' };
  const delayed = deferred<import('@maka/runtime-host/protocol').WorkHubTaskDetail>();
  const h = await mountController(false, {
    resolve: async () => selected,
    subscribeHosts: listener => { hostChange = listener; return () => {}; },
    queryTasks: async owner => ({ tasks: owner === first ? [task] : [{ ...task, targetSessionId: 'second-task', targetSessionName: 'New task' }], truncated: false }),
    readTask: async () => delayed.promise,
  });
  let read!: ReturnType<typeof h.controller.taskOverview.read>;
  await act(() => { read = h.controller.taskOverview.read(task); });
  selected = second;
  await act(async () => { hostChange({ hostId: 'host-2', isDefault: true, readiness: 'ready' }); });
  await act(async () => { delayed.resolve({ task }); });
  assert.equal(await read, undefined);
  assert.equal(h.controller.taskOverview.tasks[0]!.targetSessionName, 'New task');
  await assert.rejects(h.controller.taskOverview.continue(task, 'Continue'), /unavailable/);
});
test('a confirmed continuation does not wait for refresh or regain uncertainty when that read fails', async () => {
  const task: import('@maka/runtime-host/protocol').WorkHubTask = { actionId: 'action', delegationId: 'delegation', targetSessionId: 'target', targetSessionName: 'Task', targetMessageId: 'message', text: 'Original', createdAt: 1, status: 'pending_acceptance' };
  const refresh = deferred<import('@maka/runtime-host/protocol').WorkHubTasksQueryResult>();
  let reads = 0;
  const availability = new Set<() => void>();
  const h = await mountController(false, {
    queryTasks: async () => ++reads === 1 ? { tasks: [task], truncated: false } : refresh.promise,
    subscribeAvailability: listener => { availability.add(listener); return () => { availability.delete(listener); }; },
    continueTask: async () => ({ disposition: 'delegate_existing', targetSessionId: task.targetSessionId }),
  });
  const staleRead = h.controller.taskOverview.read;
  await act(async () => { assert.equal(await h.controller.taskOverview.continue(task, 'New instruction'), true); });
  assert.equal(h.controller.taskOverview.pendingContinuation(task), undefined);
  await act(() => { for (const listener of availability) listener(); });
  await assert.rejects(staleRead(task), /unavailable/);
  await act(async () => { refresh.reject(new Error('Read disconnected after confirmed send')); });
  assert.equal(h.controller.taskOverview.pendingContinuation(task), undefined);
  assert.equal(h.controller.taskOverview.ready, false);
});
test('task overview coalesces notification bursts and rebuilds disconnected authority', async () => {
  const delayed = deferred<import('@maka/runtime-host/protocol').WorkHubTasksQueryResult>();
  const changes = new Set<() => void>();
  const unavailable = new Set<() => void>();
  let calls = 0;
  let maximum = 0;
  let running = 0;
  const h = await mountController(false, {
    subscribeSessions: listener => { changes.add(listener); return () => { changes.delete(listener); }; },
    subscribeAvailability: listener => { unavailable.add(listener); return () => { unavailable.delete(listener); }; },
    queryTasks: async () => { calls++; maximum = Math.max(maximum, ++running); try { return calls === 1 ? await delayed.promise : { tasks: [], truncated: true }; } finally { running--; } },
  });
  await act(() => { for (let i = 0; i < 10; i++) for (const change of changes) change(); });
  assert.equal(calls, 1);
  await act(async () => { delayed.resolve({ tasks: [], truncated: false }); });
  assert.equal(calls, 2); assert.equal(maximum, 1); assert.equal(h.controller.taskOverview.truncated, true);
  await act(async () => { for (const listener of unavailable) listener(); });
  assert.equal(h.controller.taskOverview.ready, true, 'reconnect rebuilds the canonical bounded projection');
});


async function mountController(failFirstRead = false, overrides: Partial<WorkHubServices> = {}) {
  let hostEpoch = 'host-epoch-1';
  let openCount = 0;
  let onPhase!: (phase: 'pending' | 'ready') => void;
  const { root } = installReactRenderer();
  let controller!: ReturnType<typeof useWorkHubController>;
  let publish!: (snapshot: WorkHubTranscriptSnapshot) => void;
  let onExecution: Parameters<WorkHubServices['observe']>[4];
  let observe!: Parameters<WorkHubServices['observe']>[1];
  let earlierLoads = 0;
  let admission = deferred<{ turnId: string }>();
  const requests: Array<Parameters<WorkHubServices['answer']>[1]> = [];
  let rootTurn: { turnId: string; runId: string; status: 'running' | 'cancelled' | 'completed' } | undefined;
  const queueMutations: unknown[][] = [];
  const restoredDrafts: [string, string][] = [];
  const steers: Array<Parameters<WorkHubServices['enqueueMessage']>> = [];
  let steerResult: Awaited<ReturnType<WorkHubServices['enqueueMessage']>> = 'admitted';
  const executionQueries: string[][] = [];
  let executionResolutions: Awaited<ReturnType<WorkHubServices['queryMessageExecutions']>>['resolutions'] = [];
  let newWorkDefaults: Awaited<ReturnType<WorkHubServices['getNewWorkDefaults']>> = {};
  let onSteer: ((input: Parameters<WorkHubServices['enqueueMessage']>) => void) | undefined;
  const interrupts: Array<{ sessionId: string; turnId: string; runId: string }> = [];
  let stopRetractions: string[] = [];
  const handlers = new Map<string, IpcHandler>();
  const ipc = { handle: (channel: string, handler: IpcHandler) => { handlers.set(channel, handler); } };
  registerRuntimeHostSessionExecutionIpc({
    observer: { snapshot: async () => ({ rootTurn }) },
    beforeStop: async () => {},
    emitSessionsChanged: () => {},
    client: { interruptTurn: async (input: typeof interrupts[number]) => {
      interrupts.push({ sessionId: input.sessionId, turnId: input.turnId, runId: input.runId });
      rootTurn!.status = 'cancelled';
      projectExecution();
      return { retracted: stopRetractions.map((messageId) => ({ messageId })) };
    } },
  } as unknown as RuntimeHostSessionExecutionIpcDeps, ipc);
  registerRuntimeHostWorkHubIpc({
    get hostEpoch() { return hostEpoch; },
    queryTurn: async () => {
      if (!rootTurn) throw new RuntimeHostOperationError('turn.query', 'not_found', 'Turn was not admitted');
      return { ...rootTurn, sessionId: 'workhub-coordination' };
    },
    answerWorkHubCoordination: async (input: Parameters<WorkHubServices['answer']>[1]) => {
      requests.push(input);
      return admission.promise;
    },
  } as unknown as Parameters<typeof registerRuntimeHostWorkHubIpc>[0], ipc, {});
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as Parameters<IpcHandler>[0], ...args);

  const sessionId = JSON.stringify(['host-1', 'workhub-coordination']);
  function projectExecution(available = true) {
    onExecution?.({ type: 'host_execution', available,
      rootTurn: rootTurn ? { ...rootTurn, sessionId,
        ...(rootTurn.status === 'running' ? { status: 'running' as const } : { status: rootTurn.status, terminalEventId: 'terminal', abortSource: 'user_stop' }) } : null });
  }
  const services = {
    resolve: async () => sessionId,
    getSession: async () => ({ id: sessionId, runningTurnIds: [] }),
    listSessions: async () => [],
    modelChoices: async () => [],
    setDefaultModel: async () => {},
    getNewWorkDefaults: async () => newWorkDefaults,
    setNewWorkDefaults: async (_id: string, defaults: typeof newWorkDefaults) => {
      newWorkDefaults = defaults;
    },
    getNewWorkPermissionMode: async () => 'ask',
    setNewWorkPermissionMode: async (_id: string, mode: 'ask' | 'bypass') => mode,
    subscribeNewWorkPermissionMode: () => () => {},
    getExecutionConcurrency: async () => 3,
    setExecutionConcurrency: async (_id: string, value: number) => value,
    subscribeHosts: () => () => {},
    subscribeAvailability: () => () => {},
    subscribeSessions: () => () => {},
    observe: (_id: string, handler: typeof observe, _onError: unknown, phase: typeof onPhase, execution: typeof onExecution) => { observe = handler; onPhase = phase; onExecution = execution; return () => {}; },
    openTranscript: async (_id: string, handler: typeof publish) => {
      openCount++;
      if (failFirstRead && openCount === 1) throw new Error('transient initial read failure');
      publish = handler;
      handler({ messages: [], ready: true, hasOlder: false });
      return {
        observationChanged: () => {},
        loadEarlier: async () => { earlierLoads += 1; },
        close: async () => {},
      };
    },
    retractQueueEntry: async (...input: Parameters<WorkHubServices['retractQueueEntry']>) => { queueMutations.push(['retract', ...input]); },
    updateQueueEntry: async (...input: Parameters<WorkHubServices['updateQueueEntry']>) => { queueMutations.push(['update', ...input]); },
    promoteQueueEntry: async (...input: Parameters<WorkHubServices['promoteQueueEntry']>) => { queueMutations.push(['promote', ...input]); },
    reorderQueueEntries: async (...input: Parameters<WorkHubServices['reorderQueueEntries']>) => { queueMutations.push(['reorder', ...input]); },
    enqueueMessage: async (...input: Parameters<WorkHubServices['enqueueMessage']>) => { steers.push(input); onSteer?.(input); return steerResult; },
    queryMessageExecutions: async (_id: string, messageIds: readonly string[]) => {
      executionQueries.push([...messageIds]);
      return { resolutions: executionResolutions };
    },
    listActiveInteractions: async () => [],
    queryTaskInteractions: async () => ({ requests: [], truncated: false }),
    queryTasks: async () => ({ tasks: [], truncated: false }),
    readTask: async () => { throw new Error('No task in this fixture'); },
    continueTask: async () => { throw new Error('No task in this fixture'); },
    revokeTaskGrant: async () => {throw new Error('No task grant in this fixture');},
    answerTaskInteraction: async () => { throw new Error('No task request in this fixture'); },
    subscribeActiveInteractions: () => () => {},
    respondToUserForm: async () => {},
    respondToUserQuestion: async () => {},
    answer: (_id: string, input: Parameters<WorkHubServices['answer']>[1]) => invoke('workhub:answer', input),
    stop: async (target: string, turnId: string) => {
      const result = await invoke('sessions:stop', target, { source: 'stop_button', expectedTurnId: turnId }) as DesktopSessionStopResult;
      return result?.kind === 'interrupted' ? result.retractedMessageIds : undefined;
    },
    ...overrides,
  } as unknown as WorkHubServices;
  let submissions = 0;
  function Probe() { controller = useWorkHubController(() => { submissions++; }, (sessionId, draft) => { restoredDrafts.push([sessionId, draft.text]); }); return null; }
  await act(async () => {
    root.render(createElement(LocaleProvider, { locale: 'en', children:
      createElement(WorkHubServicesProvider, { services }, createElement(Probe)),
    }));
  });
  if (!overrides.resolve) assert.equal(controller.sessionId, sessionId);
  return {
    get submissions() { return submissions; },
    get controller() { return controller; }, get openCount() { return openCount; },
    reconnect(epoch = hostEpoch) { hostEpoch = epoch; onPhase('pending'); onPhase('ready'); },
    complete(turnId: string) { rootTurn = { turnId, runId: `run:${turnId}`, status: 'completed' }; projectExecution(); },
    onSteer(handler: typeof onSteer) { onSteer = handler; },
    queueMutations, restoredDrafts, steers, setSteerResult(value: typeof steerResult) { steerResult = value; },
    executionQueries, setExecutionResolutions(value: typeof executionResolutions) { executionResolutions = value; },
    setStopRetractions(ids: string[]) { stopRetractions = ids; },
    sessionId, requests, get admission() { return admission; }, interrupts,
    resetAdmission() { admission = deferred<{ turnId: string }>(); },
    admit(turnId: string) { rootTurn = { turnId, runId: `run:${turnId}`, status: 'running' }; projectExecution(); },
    loseObservation() { projectExecution(false); },
    get earlierLoads() { return earlierLoads; },
    emit(event: Parameters<typeof observe>[0]) { observe(event); },
    publish(messages: StoredMessage[]) { publish({ messages, ready: true, hasOlder: false }); },
  };
}

test('WorkHub presents model setup instead of a retry-only resolution error', async () => {
  const h = await mountController(false, {
    resolve: async () => { throw new WorkHubModelConfigurationRequiredError(); },
  });

  assert.equal(h.controller.modelSetupRequired, true);
  assert.equal(h.controller.modelSetupChoicesReady, true);
  assert.deepEqual(h.controller.choices, []);
  assert.equal(h.controller.error, undefined);
  assert.equal(h.controller.canRetry, false);
});

test('WorkHub offers pre-session models and saves the selected default', async () => {
  const choice: ChatModelChoice = {
    connectionId: 'connection',
    connectionSlug: 'provider',
    connectionName: 'Provider',
    providerType: 'openai',
    providerLabel: 'OpenAI',
    model: 'model-a',
    label: 'Model A',
    isDefault: false,
    thinkingLevels: [],
  };
  const reads: Array<string | undefined> = [];
  const defaults: Array<{ llmConnectionSlug: string; model: string }> = [];
  const h = await mountController(false, {
    resolve: async () => { throw new WorkHubModelConfigurationRequiredError(); },
    modelChoices: async (sessionId) => {
      reads.push(sessionId);
      return [choice];
    },
    setDefaultModel: async (input) => { defaults.push(input); },
  });

  assert.equal(h.controller.modelSetupRequired, true);
  assert.equal(h.controller.modelSetupChoicesReady, true);
  assert.deepEqual(h.controller.choices, [choice]);
  assert.deepEqual(reads, [undefined]);
  await act(async () => {
    await h.controller.selectSetupModel({
      llmConnectionId: choice.connectionId,
      llmConnectionSlug: choice.connectionSlug,
      model: choice.model,
    });
  });
  assert.deepEqual(defaults, [{ llmConnectionSlug: 'provider', model: 'model-a' }]);
  assert.equal(h.controller.configuringModel, false);
  assert.equal(h.controller.error, undefined);
});

test('WorkHub model selection configures only newly created work', async () => {
  type Session = Awaited<ReturnType<WorkHubServices['getSession']>>;
  const initial = {
    id: JSON.stringify(['host-1', 'workhub-coordination']),
    revision: 1, model: 'A', llmConnectionId: 'connection', llmConnectionSlug: 'provider',
    runningTurnIds: [],
  } as unknown as Session;
  let failSave = false;
  const requests: Array<Awaited<ReturnType<WorkHubServices['getNewWorkDefaults']>>> = [];
  const h = await mountController(false, {
    getSession: async () => initial,
    getNewWorkDefaults: async () => ({}),
    setNewWorkDefaults: async (_id, defaults) => {
      if (failSave) throw new Error('configuration failed');
      requests.push(defaults);
    },
  });
  await act(async () => {
    await h.controller.changeExecutor({
      executorId: 'codex.app-server',
      model: 'gpt-6-astra',
      thinkingLevel: 'high',
    });
  });
  assert.deepEqual(requests[0], {
    executorId: 'codex.app-server',
    executorModel: 'gpt-6-astra',
    thinkingLevel: 'high',
  });
  assert.equal(h.controller.session?.model, 'A', 'the coordination Session keeps its own model');
  assert.equal(h.controller.session?.revision, 1);

  await act(async () => { await h.controller.changeThinkingLevel('max'); });
  assert.equal(requests.at(-1)?.thinkingLevel, 'max');
  assert.equal(requests.at(-1)?.executorModel, 'gpt-6-astra');

  await act(async () => {
    await h.controller.changeModel({
      llmConnectionId: 'connection',
      llmConnectionSlug: 'provider',
      model: 'C',
    });
  });
  assert.deepEqual(requests.at(-1), {
    model: { llmConnectionId: 'connection', llmConnectionSlug: 'provider', model: 'C' },
  });
  assert.equal(h.controller.session?.model, 'A');

  failSave = true;
  await act(async () => {
    await h.controller.changeModel({
      llmConnectionId: 'connection',
      llmConnectionSlug: 'provider',
      model: 'D',
    });
  });
  assert.equal(h.controller.newWorkDefaults.model?.model, 'C', 'failed writes retain the saved default');
  assert.equal(h.controller.error, 'configuration failed');
  assert.equal(h.controller.configuringModel, false);

  const count = requests.length;
  await act(async () => { h.admit('busy-turn'); });
  await act(async () => { await h.controller.changeThinkingLevel('high'); });
  assert.equal(requests.length, count, 'running coordination turns freeze new-work defaults');
});

test('WorkHub concurrency saves Host policy and ignores stale reads and invalid controls', async () => {
  let value = 3;
  let refresh!: () => void;
  let reads = 0;
  const stale = deferred<number>();
  const writes: number[] = [];
  const h = await mountController(false, {
    getExecutionConcurrency: () => ++reads === 2 ? stale.promise : Promise.resolve(value),
    setExecutionConcurrency: async (_id, next) => { writes.push(next); return value = next; },
    subscribeNewWorkPermissionMode: (_id, handler) => { refresh = handler; return () => {}; },
  });
  assert.equal(h.controller.executionConcurrency, 3);
  await act(async () => { refresh(); });
  await act(async () => { await h.controller.changeExecutionConcurrency(1); });
  await act(async () => { stale.resolve(8); });
  assert.equal(h.controller.executionConcurrency, 1);
  await act(async () => { await h.controller.changeExecutionConcurrency(0); await h.controller.changeExecutionConcurrency(9); });
  assert.deepEqual(writes, [1]);
  assert.equal(h.controller.savingConcurrency, false);
});

test('WorkHub concurrency failures leave the control unavailable until a fresh policy read', async () => {
  let failed = true;
  let refresh!: () => void;
  const h = await mountController(false, {
    getExecutionConcurrency: async () => { if (failed) throw new Error('Host policy unavailable'); return 2; },
    setExecutionConcurrency: async () => { throw new Error('Host rejected concurrency'); },
    subscribeNewWorkPermissionMode: (_id, handler) => { refresh = handler; return () => {}; },
  });
  assert.equal(h.controller.executionConcurrency, undefined);
  await act(async () => { failed = false; refresh(); });
  assert.equal(h.controller.executionConcurrency, 2);
  await act(async () => { await h.controller.changeExecutionConcurrency(1); });
  assert.equal(h.controller.executionConcurrency, 2);
  assert.equal(h.controller.savingConcurrency, false);
  assert.equal(h.controller.error, 'Host rejected concurrency');
});

test('WorkHub new-work permissions require confirmation and never change the coordination Session', async () => {
  let mode: 'ask' | 'bypass' = 'ask';
  let confirmations = 0;
  const writes: string[] = [];
  const h = await mountController(false, {
    getSession: async (id) => ({
      id, revision: 1, runningTurnIds: [], permissionMode: 'bypass', name: 'WorkHub',
      isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active',
      backend: 'fake', llmConnectionSlug: 'fake', connectionLocked: false, model: 'fake-model',
    }),
    getNewWorkPermissionMode: async () => mode,
    setNewWorkPermissionMode: async (_id, next) => { writes.push(next); return mode = next; },
  });
  assert.equal(h.controller.newWorkPermissionMode, 'ask');
  await act(async () => { await h.controller.changeNewWorkPermissionMode('bypass', async () => { confirmations++; return false; }); });
  assert.deepEqual(writes, []);
  assert.equal(h.controller.newWorkPermissionMode, 'ask');
  await act(async () => { await h.controller.changeNewWorkPermissionMode('bypass', async () => { confirmations++; return true; }); });
  assert.equal(h.controller.newWorkPermissionMode, 'bypass');
  await act(async () => { await h.controller.changeNewWorkPermissionMode('ask', async () => { throw new Error('tightening must not ask for bypass consent'); }); });
  assert.deepEqual(writes, ['bypass', 'ask']);
  assert.equal(confirmations, 2);
  assert.equal(h.controller.session?.permissionMode, 'bypass');
  assert.deepEqual(h.controller.newWorkDefaults, {});
});

test('WorkHub permission read and write failures do not silently enable bypass', async () => {
  let failRead = true;
  let refresh!: () => void;
  let writes = 0;
  const h = await mountController(false, {
    getNewWorkPermissionMode: async () => { if (failRead) throw new Error('Host policy unavailable'); return 'ask'; },
    setNewWorkPermissionMode: async () => { writes++; throw new Error('Host rejected permission change'); },
    subscribeNewWorkPermissionMode: (_id, handler) => { refresh = handler; return () => {}; },
  });
  assert.equal(h.controller.newWorkPermissionMode, undefined);
  await act(async () => { await h.controller.changeNewWorkPermissionMode('bypass', async () => true); });
  assert.equal(writes, 0);
  failRead = false;
  await act(async () => { refresh(); });
  await act(async () => { await h.controller.changeNewWorkPermissionMode('bypass', async () => true); });
  assert.equal(writes, 1);
  assert.equal(h.controller.newWorkPermissionMode, 'ask');
  assert.equal(h.controller.error, 'Host rejected permission change');
  assert.equal(h.controller.savingPermission, false);
});

test('a stale WorkHub permission read cannot overwrite a confirmed write', async () => {
  const stale = deferred<'ask'>();
  let mode: 'ask' | 'bypass' = 'ask';
  let reads = 0;
  let refresh!: () => void;
  const h = await mountController(false, {
    getNewWorkPermissionMode: () => ++reads === 2 ? stale.promise : Promise.resolve(mode),
    setNewWorkPermissionMode: async (_id, next) => mode = next,
    subscribeNewWorkPermissionMode: (_id, handler) => { refresh = handler; return () => {}; },
  });
  await act(async () => { refresh(); });
  await act(async () => { await h.controller.changeNewWorkPermissionMode('bypass', async () => true); });
  await act(async () => { stale.resolve('ask'); });
  assert.equal(h.controller.newWorkPermissionMode, 'bypass');
});

test('switching Hosts cancels pending bypass consent and ignores old policy reads and writes', async () => {
  const consent = deferred<boolean>();
  const stale = deferred<'bypass'>();
  const staleConcurrency = deferred<number>();
  const savedConcurrency = deferred<number>();
  let id = JSON.stringify(['host-1', 'workhub-coordination']);
  let hostsChanged!: Parameters<WorkHubServices['subscribeHosts']>[0];
  let refresh!: () => void;
  let reads = 0;
  let concurrencyReads = 0;
  const writes: string[] = [];
  const concurrencyWrites: string[] = [];
  const h = await mountController(false, {
    resolve: async () => id,
    getNewWorkPermissionMode: () => ++reads === 2 ? stale.promise : Promise.resolve('ask'),
    setNewWorkPermissionMode: async (target, mode) => { writes.push(target); return mode; },
    getExecutionConcurrency: () => ++concurrencyReads === 2 ? staleConcurrency.promise : Promise.resolve(id.includes('host-2') ? 2 : 3),
    setExecutionConcurrency: (target) => { concurrencyWrites.push(target); return savedConcurrency.promise; },
    subscribeNewWorkPermissionMode: (_id, handler) => { refresh = handler; return () => {}; },
    subscribeHosts: (handler) => { hostsChanged = handler; return () => {}; },
  });
  await act(async () => { refresh(); });
  let changing!: Promise<void>;
  let changingConcurrency!: Promise<void>;
  await act(async () => { changing = h.controller.changeNewWorkPermissionMode('bypass', () => consent.promise); });
  await act(async () => { changingConcurrency = h.controller.changeExecutionConcurrency(1); });
  assert.equal(h.controller.savingConcurrency, true);
  await act(async () => { id = JSON.stringify(['host-2', 'workhub-coordination']); hostsChanged({ hostId: 'host-2', isDefault: true, readiness: 'ready' }); });
  assert.equal(h.controller.sessionId, id);
  await act(async () => { consent.resolve(true); stale.resolve('bypass'); staleConcurrency.resolve(8); savedConcurrency.resolve(1); await changing; await changingConcurrency; });
  assert.deepEqual(writes, []);
  assert.deepEqual(concurrencyWrites, [JSON.stringify(['host-1', 'workhub-coordination'])]);
  assert.equal(h.controller.executionConcurrency, 2);
  assert.equal(h.controller.savingConcurrency, false);
  assert.equal(h.controller.newWorkPermissionMode, 'ask');
  assert.equal(h.controller.savingPermission, false);
});

test('WorkHub stops presenting execution on observation loss while retaining the Stop target', async () => {
  const h = await mountController();
  await act(async () => { h.admit('running-turn'); });
  assert.equal(h.controller.activeTurn?.turnId, 'running-turn');
  await act(async () => { h.loseObservation(); });
  assert.equal(h.controller.activeTurn, undefined);
  assert.equal(h.controller.busy, true);
  await act(async () => { await h.controller.stop(); });
  assert.deepEqual(h.interrupts, [{ sessionId: h.sessionId, turnId: 'running-turn', runId: 'run:running-turn' }]);
});

test('WorkHub shows the submitted prompt before admission and keeps it until its durable user record arrives', async () => {
  const h = await mountController();
  await act(() => {
    h.emit({ type: 'text_delta', id: 'previous-output', turnId: 'previous-turn', messageId: 'previous-answer', ts: 1, text: 'Earlier answer' });
    h.emit({ type: 'abort', id: 'previous-abort', turnId: 'previous-turn', ts: 2, reason: 'user_stop' });
  });
  assert.ok(h.controller.liveTurn?.terminal);
  const text = '给我改成浅色主题';
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  const followed: string[] = [];
  const unsubscribe = h.controller.viewportNavigation.subscribe((id) => followed.push(id));
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send(text, attachments); });
  assert.deepEqual(h.controller.transientMessages.map((message) => message.text), [text]);
  assert.deepEqual(h.controller.transientMessages[0]!.attachments, attachments);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(followed, [h.sessionId]);
  const turnId = h.requests[0]!.turnId;
  assert.equal(h.controller.liveTurn?.turnId, turnId, 'waiting feedback starts before admission');
  assert.equal(h.controller.busy, true);
  await act(async () => { h.admission.resolve({ turnId }); assert.equal(await sent, true); });
  assert.equal(h.controller.transientMessages.length, 1, 'an acknowledgement is not a durable message');
  await act(async () => {
    h.publish([{ type: 'assistant', id: 'reply', turnId, text: 'Working on it', ts: 2, modelId: 'fixture' }]);
  });
  assert.equal(h.controller.transientMessages.length, 1, 'assistant delivery cannot erase the user prompt');
  await act(async () => {
    h.publish([{ type: 'user', id: 'canonical-user-id', turnId, text, attachments, ts: 1 }]);
  });
  assert.equal(h.controller.transientMessages.length, 0);
  assert.deepEqual(h.controller.transcript.messages.map((message) => message.id), ['canonical-user-id']);
  unsubscribe();
});

test('WorkHub hands transcript and live content off together when publication commits', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(() => { sent = h.controller.send('handoff prompt', []); });
  const turnId = h.requests[0]!.turnId;
  await act(async () => { h.admission.resolve({ turnId }); await sent; });
  await act(() => h.emit({ type: 'text_delta', id: 'delta', turnId, messageId: 'answer', ts: 1, text: 'Answer' }));
  const messages: StoredMessage[] = [
    { type: 'user', id: 'user', turnId, text: 'handoff prompt', ts: 1 },
    { type: 'assistant', id: 'answer', turnId, text: 'Answer', ts: 2, modelId: 'fixture' },
  ];
  await act(() => h.publish(messages));
  await act(() => h.emit({ type: 'complete', id: 'done', turnId, ts: 3, stopReason: 'end_turn' }));
  await act(() => h.controller.streamingSettled('answer'));
  assert.deepEqual(h.controller.transcript.messages, messages);
  assert.equal(h.controller.transientMessages.length, 0);
  assert.ok(!h.controller.liveTurn?.steps.some((step) => step.stepId === 'answer'));
});

test('WorkHub marks a failed submission and preserves its retry identity', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('retry this prompt', []); });
  const turnId = h.requests[0]!.turnId;
  await act(async () => { h.admission.reject(new Error('admission rejected')); assert.equal(await sent, false); });
  assert.equal(h.controller.transientMessages.length, 1);
  assert.equal(h.controller.error, 'admission rejected');
  assert.equal(h.controller.liveTurn, undefined, 'rejected admission retires the waiting feedback');
  assert.equal(h.controller.busy, false);
  await act(async () => { assert.equal(await h.controller.send('retry this prompt', []), false); });
  assert.equal(h.requests[1]!.turnId, turnId);
  assert.equal(h.controller.transientMessages.length, 1);
});

test('a lost admission response cannot erase confirmed WorkHub activity', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('keep the real activity', []); });
  const turnId = h.requests[0]!.turnId;
  await act(() => { h.admit(turnId); h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 1, text: 'Working' }); });
  await act(async () => { h.admission.reject(new Error('response lost')); assert.equal(await sent, false); });
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.equal(h.controller.liveTurn?.unconfirmed, undefined);
  assert.equal(h.controller.busy, true);
});


test('WorkHub carries Stop through deferred or uncertain admission for the original Turn', async () => {
  for (const order of ['stop-before-response', 'stop-after-response', 'response-before-observation', 'lost-response', 'observation-during-stop', 'rejected', 'terminal'] as const) {
    const h = await mountController();
    let sent!: Promise<boolean>;
    await act(async () => { sent = h.controller.send('stop this attempt', []); });
    const turnId = h.requests[0]!.turnId;
    if (order === 'stop-after-response') {
      h.admit(turnId);
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
    } else if (order === 'lost-response') {
      await act(async () => {
        h.admission.reject(new RuntimeHostRequestInterruptedError('workhub.coordination.answer', 'control', 'dispatched', 'connection_lost'));
        assert.equal(await sent, true);
      });
      assert.equal(h.controller.busy, true, 'an unknown outcome still exposes Stop');
    }
    await act(async () => {
      const stopped = h.controller.stop();
      if (order === 'observation-during-stop') {
        h.admit(turnId);
        h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 1, text: 'Working' });
      }
      await stopped;
    });
    if (order === 'rejected') {
      await act(async () => { h.admission.reject(new Error('admission rejected')); assert.equal(await sent, false); });
      assert.equal(h.controller.stopPending, false);
      assert.equal(h.controller.busy, false);
      assert.deepEqual(h.interrupts, []);
      // Retrying a rejected send keeps identity but must not inherit its Stop.
      h.resetAdmission();
      let retried!: Promise<boolean>;
      await act(async () => { retried = h.controller.send('stop this attempt', []); });
      assert.equal(h.requests[1]!.turnId, turnId);
      h.admit(turnId);
      await act(async () => {
        h.emit({ type: 'text_delta', id: 'retry-output', turnId, messageId: 'retry-answer', ts: 2, text: 'Retrying' });
        h.admission.resolve({ turnId });
        assert.equal(await retried, true);
      });
      assert.deepEqual(h.interrupts, [], 'a successful retry cannot inherit a rejected attempt’s Stop');
    } else if (order === 'terminal') {
      await act(async () => h.emit({ type: 'complete', id: 'done', turnId, ts: 1, stopReason: 'end_turn' }));
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
      assert.equal(h.controller.stopPending, false);
      assert.equal(h.controller.busy, false);
      assert.deepEqual(h.interrupts, []);
    } else {
      if (order === 'response-before-observation') {
        await act(async () => { h.admission.resolve({ turnId }); await sent; });
        assert.deepEqual(h.interrupts, [], 'the response can precede the observer root');
      }
      if (order === 'stop-before-response' || order === 'lost-response' || order === 'response-before-observation') {
        assert.deepEqual(h.interrupts, []);
        h.admit('different-turn');
        await act(async () => h.emit({ type: 'text_delta', id: 'other', turnId: 'different-turn', messageId: 'other-answer', ts: 1, text: 'Other work' }));
        assert.deepEqual(h.interrupts, []);
        h.admit(turnId);
        if (order !== 'stop-before-response')
          await act(async () => h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 2, text: 'Working' }));
      }
      if (order === 'stop-before-response' || order === 'observation-during-stop') {
        await act(async () => { h.admission.resolve({ turnId }); await sent; });
      }
      assert.deepEqual(h.interrupts, [{ sessionId: h.sessionId, turnId, runId: `run:${turnId}` }], order);
      assert.equal(h.controller.stopPending, false);
      h.admit('later-turn');
      await act(async () => h.emit({ type: 'text_delta', id: 'later', turnId: 'later-turn', messageId: 'later-answer', ts: 3, text: 'Later work' }));
      assert.equal(h.interrupts.length, 1, 'the intent cannot transfer to a later Turn');
    }
    cleanupFakeDom();
  }
});


test('an unknown WorkHub submission converges through the original Host admission and payload', async () => {
  for (const outcome of ['not_admitted', 'running', 'completed', 'replay'] as const) {
    const h = await mountController();
    const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
    let sent!: Promise<boolean>;
    await act(async () => { sent = h.controller.send('original payload', attachments); });
    const original = h.requests[0]!;
    await act(async () => {
      h.admission.reject(new RuntimeHostRequestInterruptedError('workhub.coordination.answer', 'command', 'dispatched', 'connection_lost'));
      assert.equal(await sent, true);
      await h.controller.stop();
      h.publish([]);
    });
    assert.equal(h.controller.busy, true, 'absence in the same Host is not rejection');
    await act(async () => {
      h.emit({ type: 'text_delta', id: 'other-output', turnId: 'other-turn', messageId: 'other-answer', ts: 1, text: 'Other work' });
      h.emit({ type: 'complete', id: 'other-completed', turnId: 'other-turn', ts: 2, stopReason: 'end_turn' });
    });
    assert.equal(h.controller.busy, true, 'another Turn finishing cannot settle the original unknown submission');
    assert.equal(h.controller.stopPending, true);
    assert.equal(h.controller.canRetry, true);
    const submitted = h.requests.length;
    const submissions = h.submissions;
    if (outcome === 'running') h.admit(original.turnId);
    if (outcome === 'completed') h.complete(original.turnId);
    if (outcome === 'replay') h.resetAdmission();
    await act(async () => h.reconnect(outcome === 'replay' ? undefined : 'host-epoch-2'));
    if (outcome === 'replay') {
      assert.deepEqual(h.requests.at(-1), original, 'replay keeps the original Turn, text and attachments');
      assert.equal(h.requests.length, submitted + 1);
      await act(async () => {
        h.admit(original.turnId);
        h.admission.resolve({ turnId: original.turnId });
      });
    } else assert.equal(h.requests.length, submitted, 'admission lookup must not send a new request after Host replacement');
    assert.equal(h.submissions, submissions, 'unknown-admission recovery is not a new submission');
    assert.equal(h.controller.stopPending, false);
    if (outcome === 'not_admitted' || outcome === 'completed') {
      assert.equal(h.controller.busy, false);
      assert.equal(h.interrupts.length, 0);
    } else {
      assert.deepEqual(h.interrupts.map(({ turnId }) => turnId), [original.turnId]);
    }
    if (outcome === 'not_admitted') {
      h.resetAdmission();
      await act(async () => h.controller.retry());
      assert.equal(h.submissions, submissions + 1, 'explicit rejected Retry crosses the shared submission boundary');
      assert.deepEqual(h.requests.at(-1), original, 'explicit Retry retains the text, attachments and unadmitted Turn identity');
      await act(async () => {
        h.admit(original.turnId);
        h.admission.resolve({ turnId: original.turnId });
      });
      assert.equal(h.interrupts.length, 0, 'explicit Retry cannot inherit the retired Stop intent');
      await act(async () => { h.complete(original.turnId); h.emit({ type: 'complete', id: 'retry-completed', turnId: original.turnId, ts: 2, stopReason: 'end_turn' }); });
      h.resetAdmission();
      let next!: Promise<boolean>;
      await act(async () => { next = h.controller.send('a different message', []); });
      const nextTurn = h.requests.at(-1)!.turnId;
      assert.notEqual(nextTurn, original.turnId);
      await act(async () => { h.admit(nextTurn); h.admission.resolve({ turnId: nextTurn }); await next; });
      assert.equal(h.interrupts.length, 0, 'an unadmitted attempt cannot leave Stop on a later Turn');
    }
    cleanupFakeDom();
  }
});

test('Retry reopens a failed initial WorkHub read after Session resolution', async () => {
  const h = await mountController(true);
  assert.ok(h.controller.sessionId);
  assert.equal(h.controller.transcript.ready, false);
  assert.equal(h.controller.canRetry, true);
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('retain this in-flight message', []); });
  const turnId = h.requests[0]!.turnId;
  await act(async () => h.controller.retry());
  assert.equal(h.openCount, 2);
  assert.equal(h.submissions, 1, 'read recovery does not resubmit');
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.equal(h.controller.transientMessages[0]?.text, 'retain this in-flight message');
  assert.equal(h.controller.transcript.ready, true);
  assert.equal(h.controller.error, undefined);
  await act(async () => { h.admission.resolve({ turnId }); await sent; });
});


test('WorkHub steering keeps the current Turn and Stop authority and reconciles only its own durable message', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('original request', []); });
  const turnId = h.requests[0]!.turnId;
  h.admit(turnId);
  await act(async () => { h.admission.resolve({ turnId }); await sent; });
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  await act(async () => { assert.equal(await h.controller.send('change direction', attachments, 'steer'), true); });
  assert.equal(h.requests.length, 1, 'steering must not start or queue another answer');
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.deepEqual(h.steers[0]!.slice(2), ['change direction', attachments, 'current_turn']);
  const messageId = h.steers[0]![1];
  const original: StoredMessage = { type: 'user', id: 'original-canonical-id', turnId, text: 'original request', ts: 1 };
  await act(() => h.publish([original]));
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId],
    'an admitted response and unrelated transcript evidence must keep the submission visible');
  await act(() => h.emit({ type: 'steering_message', id: 'steer-observation', turnId, messageId, ts: 2, content: { text: 'change direction', attachments } }));
  assert.deepEqual(h.controller.transientMessages, [], 'live steering must not duplicate its admission placeholder while the transcript lags');
  await act(() => h.publish([original, { type: 'user', id: messageId, turnId, text: 'change direction', attachments, ts: 2 }]));
  assert.deepEqual(h.controller.transientMessages, []);
  await act(async () => { await h.controller.stop(); });
  assert.equal(h.interrupts[0]?.turnId, turnId);
});

test('uncertain steering retains its identity across Turn completion and rejection preserves the active Turn', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('rejected');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), false); });
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
  assert.equal(h.controller.busy, true);
  assert.equal(h.controller.transientMessages.length, 0);
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), false); });
  const messageId = h.steers[1]![1];
  await act(async () => { assert.equal(await h.controller.send('change direction', []), false); });
  assert.match(h.controller.error!, /Cmd\/Ctrl\+Enter/);
  assert.equal(h.steers.length, 2, 'Enter cannot silently replay uncertain steering or duplicate it');
  for (const [text, attachments] of [
    ['edited direction', []],
    ['change direction', [{ kind: 'doc', name: 'new.txt', mimeType: 'text/plain', bytes: 1,
      ref: { kind: 'workspace_file', relativePath: 'new.txt' } }]],
  ] as [string, AttachmentRef[]][]) {
    await act(async () => { assert.equal(await h.controller.send(text, attachments, 'steer'), false); });
  }
  assert.equal(h.steers.length, 2, 'edited text or attachments cannot overwrite an unknown attempt');
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId]);
  await act(() => { h.complete('active-turn'); h.emit({ type: 'complete', id: 'done', turnId: 'active-turn', ts: 2, stopReason: 'end_turn' }); });
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), true); });
  assert.equal(h.steers[2]![1], messageId);
  assert.equal(h.requests.length, 0, 'retry must recover the steering receipt even after its Turn ends');
});


test('Host retraction resolves an uncertain WorkHub attempt before the next draft is sent', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('old direction', [], 'steer'), false); });
  const messageId = h.steers[0]![1];
  await act(() => h.emit({ type: 'message_admission', id: 'retracted', turnId: 'active-turn', messageId, ts: 2, outcome: 'retracted' }));
  assert.equal(h.controller.transientMessages.length, 0);
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('new direction', [], 'steer'), true); });
  assert.notEqual(h.steers[1]![1], messageId);
});

test('an unobserved retraction resolves an uncertain WorkHub send on reseed', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('old direction', [], 'steer'), false); });
  const messageId = h.steers[0]![1];
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId]);
  // The Host retracted the entry while Desktop was away: no admission event
  // replays and the reseeded queue arrives already empty — only the
  // resolution record can still say what happened to the send.
  h.setExecutionResolutions([{ messageId, state: 'cancelled' }]);
  await act(async () => h.reconnect());
  assert.deepEqual(h.executionQueries, [[messageId]]);
  assert.deepEqual(h.controller.transientMessages, []);
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('new direction', [], 'steer'), true); });
  assert.notEqual(h.steers[1]![1], messageId);
});

test('a queued send consumed while away keeps its row until the durable merge but unblocks retry', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('do this next', []), false); });
  const messageId = h.steers[0]![1];
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId]);
  // The Host drained the entry into a successor Turn during the gap.
  h.setExecutionResolutions([{ messageId, state: 'owned', turnId: 'followup-turn', runId: 'run-2' }]);
  await act(async () => h.reconnect());
  assert.deepEqual(h.executionQueries, [[messageId]]);
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId],
    'the placeholder stays until its durable row lands — never dropped, never stuck in the plate');
  await act(() => h.publish([{ type: 'user', id: messageId, turnId: 'followup-turn', ts: 3, text: 'do this next' } as StoredMessage]));
  assert.deepEqual(h.controller.transientMessages, []);
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('another message', []), true); });
});

test('steering observed before its admission response renders once and outranks an uncertain receipt', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  h.onSteer(([, messageId, text]) => h.emit({ type: 'steering_message', id: 'consumed', turnId: 'active-turn', messageId, ts: 2, content: { text } }));
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), true); });
  assert.deepEqual(h.controller.transientMessages, []);
  assert.equal(h.controller.error, undefined);
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
});


test('WorkHub queued steering keeps a transcript bubble until consumed or retracted', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  const entry = { entryId: 'queued', messageId: 'queued', placement: 'current_turn' as const, state: 'queued' as const, content: { text: 'change direction' } };
  const project = (state: 'queued' | 'in_flight') => h.emit({
    type: 'queue_update', id: 'snapshot', turnId: 'active-turn', ts: 2,
    steering: [entry.content.text], followup: [], steeringEntries: [{ ...entry, state }],
  });
  await act(() => project('queued'));
  assert.deepEqual(h.controller.messageQueue.entries, [entry]);
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), ['queued'],
    'queued steering waits in the transcript, not the follow-up plate');
  await act(() => h.emit({ type: 'steering_message', id: 'consumed', turnId: 'active-turn', ts: 3, messageId: entry.messageId, content: entry.content }));
  await act(() => project('in_flight'));
  assert.deepEqual(h.controller.messageQueue.entries, [{ ...entry, state: 'in_flight' }], 'a pulled message stays pending until the runtime places it');
  await act(() => h.emit({ type: 'steering_message', id: 'consumed', turnId: 'active-turn', ts: 3, messageId: entry.messageId, content: entry.content }));
  assert.deepEqual(h.controller.messageQueue.entries, []);
  assert.deepEqual(h.controller.transientMessages, []);
  await act(() => project('queued'));
  assert.equal(h.controller.transientMessages.length, 1);
  await act(async () => { await h.controller.deleteQueuedEntry(entry.entryId); });
  await act(() => h.emit({ type: 'queue_update', id: 'removed', turnId: 'active-turn', ts: 4, steering: [], followup: [], steeringEntries: [] }));
  assert.deepEqual(h.controller.messageQueue.entries, []);
  assert.deepEqual(h.controller.transientMessages, [], 'withdrawal needs no separate admission event');
});

test('WorkHub sends queue edits, withdrawal and both queue orders to the Host and waits for its projection', async () => {
  const h = await mountController();
  const entries = ['first', 'second'].map((id) => ({ entryId: id, messageId: id,
    content: { text: id }, placement: 'current_turn' as const, state: 'queued' as const }));
  await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId: 'active-turn', ts: 2,
    queueRevision: 7, steering: ['first', 'second'], followup: [], steeringEntries: entries }));
  await act(async () => {
    await h.controller.updateQueuedEntry('second', 7, 'edited second');
    await h.controller.reorderQueuedEntries(['second', 'first'], 7);
    await h.controller.deleteQueuedEntry('first');
  });
  assert.deepEqual(h.queueMutations, [
    ['update', h.controller.sessionId, 'second', 7, 'edited second'],
    ['reorder', h.controller.sessionId, ['second', 'first'], 7],
    ['retract', h.controller.sessionId, 'first'],
  ]);
  assert.deepEqual(h.restoredDrafts, [], 'Host-side edits stay in the queue projection');
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.entryId), ['first', 'second']);
  await act(() => h.emit({ type: 'queue_update', id: 'updated', turnId: 'active-turn', ts: 3,
    queueRevision: 10, steering: ['edited second'], followup: [], steeringEntries: [{ ...entries[1]!, content: { text: 'edited second' } }] }));
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.content.text), ['edited second']);
  assert.deepEqual(h.controller.transientMessages.map((message) => message.text), ['edited second'],
    'the queue snapshot retires the edited-out steering bubble and republishes the edited one');
});


test('WorkHub defaults to follow-up and moves each message into its admitted successor Turn', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  await act(async () => {
    assert.equal(await h.controller.send('first follow-up', attachments), true);
    assert.equal(await h.controller.send('second follow-up', []), true);
  });
  assert.deepEqual(h.steers.map((input) => input.slice(2)), [
    ['first follow-up', attachments, 'next_turn'], ['second follow-up', [], 'next_turn'],
  ]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
  const first = h.steers[0]![1];
  const second = h.steers[1]![1];
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [first, second]);
  await act(() => h.reconnect());
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [first, second],
    'disconnecting before canonical evidence cannot hide accepted messages');
  const entries = h.steers.map(([, messageId, text, attachments]) => ({
    entryId: messageId, messageId, content: { text, attachments }, placement: 'next_turn' as const, state: 'queued' as const,
  }));
  await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId: 'active-turn', ts: 2,
    steering: [], followup: entries.map((entry) => entry.content.text), followupEntries: entries }));
  await act(() => h.emit({ type: 'message_admission', id: 'first-admission', turnId: 'successor', messageId: first, ts: 2, outcome: 'admitted' }));
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), [second]);
  await act(() => {
    h.admit('successor');
    h.emit({ type: 'text_delta', id: 'successor-output', turnId: 'successor', messageId: 'successor-answer', ts: 3, text: 'Responding to first follow-up' });
  });
  assert.equal(h.controller.liveTurn?.steps[0]?.text?.text, 'Responding to first follow-up');
  assert.deepEqual(h.controller.transientMessages.map(({ id, text, attachments, hostTurnId, transientPlacement }) =>
    ({ id, text, attachments, hostTurnId, transientPlacement })), [{
    id: first, text: 'first follow-up', attachments, hostTurnId: 'successor', transientPlacement: 'transcript',
  }], 'the admitted prompt must accompany its live answer before transcript publication');
  await act(() => h.emit({ type: 'queue_update', id: 'remaining', turnId: 'successor', ts: 3,
    steering: [], followup: ['second follow-up'], followupEntries: entries.slice(1) }));
  assert.equal(h.controller.transientMessages[0]?.id, first, 'later queue snapshots cannot retire an admitted prompt');
  await act(() => h.publish([{ type: 'user', id: first, turnId: 'successor', text: 'first follow-up', attachments, ts: 2 }]));
  assert.deepEqual(h.controller.transientMessages, []);
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), [second]);
});

test('restored follow-ups transfer edited Host content once, regardless of transcript arrival order', async () => {
  for (const transcriptFirst of [false, true]) {
    const h = await mountController();
    const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
    const entry = { entryId: 'restored-entry', messageId: 'restored-message', placement: 'next_turn' as const, state: 'queued' as const,
      content: { text: 'model-facing envelope', displayText: 'edited follow-up', attachments } };
    await act(() => {
      h.emit({ type: 'queue_update', id: 'restored', turnId: 'predecessor', ts: 1, steering: [], followup: ['old follow-up'],
        followupEntries: [{ ...entry, content: { text: 'old follow-up' } }] });
      h.emit({ type: 'queue_update', id: 'edited', turnId: 'predecessor', ts: 2, steering: [], followup: [entry.content.text], followupEntries: [entry] });
    });
    const publish = () => h.publish([{ type: 'user', id: entry.messageId, turnId: 'successor', ts: 3, ...entry.content }]);
    const admit = () => h.emit({ type: 'message_admission', id: 'admitted', turnId: 'successor', messageId: entry.messageId, ts: 3, outcome: 'admitted' });
    if (transcriptFirst) await act(publish);
    await act(() => { admit(); admit(); });
    assert.deepEqual(h.controller.messageQueue.entries, []);
    assert.deepEqual(h.controller.transientMessages.map(({ id, text, attachments, hostTurnId }) => ({ id, text, attachments, hostTurnId })),
      transcriptFirst ? [] : [{ id: entry.messageId, text: 'edited follow-up', attachments, hostTurnId: 'successor' }]);
    if (!transcriptFirst) await act(publish);
    await act(admit);
    assert.deepEqual(h.controller.transientMessages, [], 'late admission cannot recreate a published user row');
    cleanupFakeDom();
  }
});

test('withdrawing a queued follow-up never transfers it into the conversation', async () => {
  const h = await mountController();
  const entry = { entryId: 'queued-entry', messageId: 'queued-message', placement: 'next_turn' as const, state: 'queued' as const, content: { text: 'withdraw me' } };
  await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId: 'active', ts: 1, steering: [], followup: ['withdraw me'], followupEntries: [entry] }));
  await act(() => h.emit({ type: 'message_admission', id: 'retracted', turnId: 'active', messageId: entry.messageId, ts: 2, outcome: 'retracted' }));
  assert.deepEqual(h.controller.messageQueue.entries, []);
  assert.deepEqual(h.controller.transientMessages, []);
});

test('an uncertain queued follow-up blocks the next one until its row is observed', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('queued while parked in history', []), false); });
  const messageId = h.steers[0]![1];  await act(async () => { assert.equal(await h.controller.send('a different follow-up', []), false); });
  assert.equal(h.steers.length, 1, 'an unobserved attempt refuses the next follow-up');
  await act(() => h.publish([{ type: 'user', id: messageId, turnId: 'successor', text: 'queued while parked in history', ts: 2 }]));
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('a different follow-up', []), true); });
  assert.equal(h.steers.length, 2, 'the observed row releases the guard');
});

test('loading earlier history reaches WorkHub’s transcript', async () => {
  const h = await mountController();
  await h.controller.loadEarlier();
  assert.equal(h.earlierLoads, 1);
});

test('follow-up admission before an uncertain response keeps its successor placement', async () => {
  const h = await mountController();
  await act(() => { h.admit('active-turn'); h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }); });
  h.setSteerResult('unknown');
  h.onSteer(([, messageId]) => h.emit({ type: 'message_admission', id: 'admitted', turnId: 'successor', messageId, ts: 2, outcome: 'admitted' }));
  await act(async () => { assert.equal(await h.controller.send('next request', []), true); });
  assert.equal(h.controller.transientMessages[0]?.transientPlacement, 'transcript');
  assert.equal(h.controller.transientMessages[0]?.hostTurnId, 'successor');
  assert.equal(h.controller.error, undefined);
});


test('Stop retires only Host-confirmed queued messages even without retraction events', async () => {
  for (const origin of ['local', 'restored'] as const) {
    const h = await mountController();
    let turnId = 'active-turn';
    if (origin === 'local') {
      let sent!: Promise<boolean>;
      await act(async () => { sent = h.controller.send('original request', []); });
      turnId = h.requests[0]!.turnId;
      h.admit(turnId);
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
    } else {
      h.admit(turnId);
      await act(() => h.emit({ type: 'text_delta', id: 'live', turnId, messageId: 'answer', ts: 1, text: 'Working' }));
    }
    const entries = ['steering', 'followup', 'retained'].map((messageId) => ({
      messageId, entryId: messageId, content: { text: messageId }, state: 'queued' as const,
      placement: messageId === 'steering' ? 'current_turn' as const : 'next_turn' as const,
    }));
    await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId, ts: 2,
      steering: ['steering'], followup: ['followup', 'retained'],
      steeringEntries: entries.slice(0, 1), followupEntries: entries.slice(1),
    }));
    h.setStopRetractions(['steering', 'followup']);
    await act(async () => { await h.controller.stop(); });
    assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), ['retained']);
    assert.deepEqual(h.controller.transientMessages.filter((message) => message.id !== turnId), []);
    assert.equal(h.controller.stopPending, false);
    cleanupFakeDom();
  }
});
test('WorkHub task inbox keeps coordinator input independent and answers the original request', async () => {
  const item: import('@maka/runtime-host/protocol').WorkHubPendingInteraction = {
    actionId: 'action', delegationId: 'delegation', targetSessionName: 'Release',
    interaction: { schemaVersion: 1, interactionId: 'question', sessionId: 'original-task',
      turnId: 'task-turn', runId: 'task-run', revision: 1, status: 'pending', outcome: null,
      request: { kind: 'question', toolUseId: 'ask', questions: [{ question: 'When?', options: [{ label: 'Monday' }] }] } },
  };
  let requests = [item];
  const answers: unknown[] = [];
  const h = await mountController(false, {
    queryTaskInteractions: async () => ({ requests, truncated: false }),
    answerTaskInteraction: async (owner, input) => {
      answers.push([owner, input]);
      requests = [];
      return { ...item.interaction, revision: 2, status: 'answered', outcome: { kind: 'question_answer', answers: ['Monday'], committedAt: 1 } };
    },
  });
  assert.equal(h.controller.taskInbox.requests.length, 1);
  assert.equal(h.controller.activeInteraction, undefined, 'worker input never becomes a coordinator modal');
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('Also inspect the docs', []); });
  assert.equal(h.requests[0]!.text, 'Also inspect the docs');
  await act(async () => { h.admission.resolve({ turnId: h.requests[0]!.turnId }); await sent; });
  await act(async () => { await h.controller.taskInbox.respond(item, { kind: 'question', answers: ['Monday'] }); });
  assert.deepEqual(answers, [[h.sessionId, {
    actionId: 'action', interactionId: 'question', expectedTurnId: 'task-turn', expectedRunId: 'task-run',
    answer: { kind: 'question', answers: ['Monday'] },
  }]]);
  assert.equal(h.controller.taskInbox.requests.length, 0);
  assert.equal(h.requests.length, 1, 'no blocking relay prompt is added');
});

test('native task approval uses task scope and a lost revoke receipt cannot replay or keep its grant', async () => {
  const item: import('@maka/runtime-host/protocol').WorkHubPendingInteraction = {
    actionId: 'action', delegationId: 'delegation', targetSessionName: 'Task',
    interaction: {schemaVersion: 1, interactionId: 'boundary', sessionId: 'original-task', turnId: 'task-turn', runId: 'task-run', revision: 1, status: 'pending', outcome: null,
      request: {kind: 'sandbox_boundary', justification: 'Read this task input', expansion: {network: {enabled: true}}}},
  };
  const grant: import('@maka/runtime-host/protocol').WorkHubTaskGrant = {actionId: 'action', targetSessionName: 'Task', grant: {
    version: 1, grantId: 'boundary', delegationId: 'delegation', rootSessionId: 'original-task', rootTurnId: 'task-turn', rootRunId: 'task-run',
    sourceSessionId: 'original-task', sourceTurnId: 'task-turn', sourceRunId: 'task-run', sourceRequestId: 'boundary',
    rootBoundaryRevision: 0, sourceBoundaryRevision: 0, grantedAt: 1, expiresAt: 3600001,
    resource: {kind: 'sandbox', expansion: {network: {enabled: true}}},
  }};
  let requests = [item];
  let grants: typeof grant[] = [];
  const writes: unknown[] = [];
  const receipt = deferred<void>();
  const h = await mountController(false, {
    queryTaskInteractions: async () => ({requests, grants, truncated: false}),
    answerTaskInteraction: async (owner, input) => {
      writes.push([owner, input]); requests = []; grants = [grant];
      return {...item.interaction, revision: 2, status: 'answered', outcome: {kind: 'sandbox_boundary_decision', decision: 'allow', status: 'approved', committedAt: 1}};
    },
    revokeTaskGrant: async (owner, input) => {writes.push([owner, input]); grants = []; await receipt.promise; throw new Error('Acknowledgement lost');},
  });
  await act(async () => {await h.controller.taskInbox.respond(item, {kind: 'sandbox_boundary', decision: 'allow'}, 'task');});
  assert.deepEqual(writes[0], [h.sessionId, {actionId: 'action', interactionId: 'boundary', expectedTurnId: 'task-turn', expectedRunId: 'task-run', answer: {kind: 'sandbox_boundary', decision: 'allow'}, grantScope: 'task'}]);
  assert.equal(h.controller.taskInbox.grants?.[0], grant);
  let revocation!: Promise<void>;
  await act(async () => {revocation = h.controller.taskInbox.revoke(grant);});
  assert.equal(h.controller.taskInbox.isRevoking(grant), true);
  await act(async () => {await h.controller.taskInbox.revoke(grant);});
  assert.equal(writes.length, 2, 'duplicate clicks never replay native mutations');
  await act(async () => {receipt.resolve(); await assert.rejects(revocation, /Acknowledgement lost/);});
  assert.deepEqual(writes[1], [h.sessionId, {actionId: 'action', grantId: 'boundary'}]);
  assert.deepEqual(h.controller.taskInbox.grants, []);
  assert.equal(h.controller.taskInbox.isRevoking(grant), false);
  await assert.rejects(h.controller.taskInbox.revoke(grant), /unavailable/);
});

test('WorkHub task inbox drops old Host reads and rebuilds a lost answer acknowledgement', async () => {
  const first = JSON.stringify(['host-1', 'workhub-coordination']);
  const second = JSON.stringify(['host-2', 'workhub-coordination']);
  let selected = first;
  let hostChange!: Parameters<WorkHubServices['subscribeHosts']>[0];
  const oldRead = deferred<import('@maka/runtime-host/protocol').WorkHubInteractionsQueryResult>();
  const pending: import('@maka/runtime-host/protocol').WorkHubPendingInteraction = {
    actionId: 'action', delegationId: 'delegation', targetSessionName: 'Task',
    interaction: { schemaVersion: 1, interactionId: 'question', sessionId: 'host-2-task', turnId: 'turn', runId: 'run',
      revision: 1, status: 'pending', outcome: null,
      request: { kind: 'question', toolUseId: 'ask', questions: [{ question: 'Go?', options: [{ label: 'Yes' }] }] } },
  };
  let current = [pending];
  let calls = 0;
  const h = await mountController(false, {
    resolve: async () => selected,
    subscribeHosts: (listener) => { hostChange = listener; return () => {}; },
    queryTaskInteractions: async (owner) => owner === first ? oldRead.promise : { requests: current, truncated: false },
    answerTaskInteraction: async () => { calls++; current = []; throw new Error('Acknowledgement lost'); },
  });
  selected = second;
  await act(async () => { hostChange({ hostId: 'host-2', isDefault: true, readiness: 'ready' }); });
  assert.equal(h.controller.taskInbox.requests[0], pending);
  await act(async () => { oldRead.resolve({ requests: [{ ...pending, targetSessionName: 'Wrong Host' }], truncated: false }); });
  assert.equal(h.controller.taskInbox.requests[0]!.targetSessionName, 'Task');
  await act(async () => { await assert.rejects(h.controller.taskInbox.respond(pending, { kind: 'question', answers: ['Yes'] }), /Acknowledgement lost/); });
  assert.equal(calls, 1);
  assert.deepEqual(h.controller.taskInbox.requests, [], 'canonical completion wins over a lost receipt');
  await assert.rejects(h.controller.taskInbox.respond(pending, { kind: 'question', answers: ['Yes'] }), /unavailable/);
  assert.equal(calls, 1);
});

test('WorkHub task inbox coalesces catalog bursts and ignores the invalidated read', async () => {
  const firstRead = deferred<import('@maka/runtime-host/protocol').WorkHubInteractionsQueryResult>();
  const listeners = new Set<() => void>();
  let calls = 0;
  let active = 0;
  let maximum = 0;
  const h = await mountController(false, {
    subscribeSessions: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    queryTaskInteractions: async () => {
      calls++;
      maximum = Math.max(maximum, ++active);
      try {
        return calls === 1 ? await firstRead.promise : { requests: [], truncated: true };
      } finally { active--; }
    },
  });
  assert.equal(calls, 1);
  await act(async () => {
    for (let i = 0; i < 10; i++) for (const listener of listeners) listener();
  });
  assert.equal(calls, 1, 'events do not fan out parallel Host reads');
  await act(async () => { firstRead.resolve({ requests: [], truncated: false }); });
  assert.equal(calls, 2, 'one fresh read drains all invalidations');
  assert.equal(maximum, 1);
  assert.equal(h.controller.taskInbox.truncated, true, 'only the canonical post-burst result is rendered');
});
