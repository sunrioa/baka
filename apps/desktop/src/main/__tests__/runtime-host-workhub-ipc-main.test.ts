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
import { RuntimeHostOperationError, RuntimeHostRequestInterruptedError } from '@maka/runtime-host/client';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import { createDefaultRuntimePolicy, type RuntimePolicy } from '@maka/core/runtime-policy';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';

test('registers the WorkHub Session projection as a reconnectable read', () => {
  const ordinary = new Set<string>();
  const reconnectable = new Set<string>();
  registerRuntimeHostWorkHubIpc(
    {} as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel) {
        ordinary.add(channel);
      },
      handleReconnectableRead(channel) {
        reconnectable.add(channel);
      },
    },
    {},
  );

  assert.equal(reconnectable.has('workhub:getSession'), true);
  assert.equal(ordinary.has('workhub:getSession'), false);
  assert.equal(reconnectable.has('workhub:queryInteractions'), true);
  assert.equal(reconnectable.has('workhub:queryTasks'), true);
  assert.equal(reconnectable.has('workhub:findTasks'), true);
  assert.equal(reconnectable.has('workhub:getNewWorkDefaults'), true);
  assert.equal(reconnectable.has('workhub:readTask'), true);
  assert.equal(reconnectable.has('workhub:taskHistory'), true);
  assert.equal(reconnectable.has('workhub:taskExecutions'), true);
  assert.equal(reconnectable.has('workhub:readTaskInput'), true);
  assert.equal(ordinary.has('workhub:sendTaskInput'), true);
  assert.equal(reconnectable.has('workhub:sendTaskInput'), false, 'a lost task input is reconciled by ID, not blindly replayed');
  assert.equal(ordinary.has('workhub:continueTask'), false, 'the legacy continuation endpoint is retired');
  assert.equal(reconnectable.has('workhub:continueTask'), false);
  assert.equal(ordinary.has('workhub:answerInteraction'), true);
  assert.equal(reconnectable.has('workhub:answerInteraction'), false, 'lost approvals are not automatically replayed');
  assert.equal(ordinary.has('workhub:revokeTaskGrant'), false, 'task grants have no Desktop producer');
  assert.equal(reconnectable.has('workhub:revokeTaskGrant'), false);
});

test('native task input IPC preserves exact IDs and distinguishes rejected from unknown without another command', async () => {
  const handlers = new Map<string, IpcHandler>();
  const input = { inputId: 'input-1', workId: 'work-1', generationId: 'gen-1', sourceActionId: 'action-1', sourceDelegationId: 'delegation-1', text: 'Correction' };
  const { text: _text, ...identity } = input;
  const receipt = { ...identity, acceptedAt: 1, targetSessionId: 'worker', targetMessageId: 'message', mode: 'steering' as const, delivery: 'queued' as const };
  const sends: unknown[] = [], reads: unknown[] = [];
  let failure: Error | undefined;
  const client = {
    sendWorkHubTaskInput: async (value: unknown) => { sends.push(value); if (failure) throw failure; return receipt; },
    readWorkHubTaskInput: async (value: unknown) => { reads.push(value); return receipt; },
  } as Parameters<typeof registerRuntimeHostWorkHubIpc>[0];
  registerRuntimeHostWorkHubIpc(client, { handle: (channel, handler) => handlers.set(channel, handler) }, {});
  const send = handlers.get('workhub:sendTaskInput')!, read = handlers.get('workhub:readTaskInput')!;
  const event = {} as Parameters<IpcHandler>[0];
  assert.deepEqual(await send(event, input), { kind: 'accepted', receipt });
  for (const code of ['operation_unavailable', 'operation_conflict', 'commit_outcome_unknown', 'persistence_failed'] as const) {
    failure = new RuntimeHostOperationError('workhub.tasks.send', code, `specific ${code}`);
    const expected = ['operation_unavailable', 'operation_conflict'].includes(code)
      ? { kind: 'rejected', code, message: `specific ${code}` } : { kind: 'unknown' };
    assert.deepEqual(await send(event, input), expected);
  }
  failure = new RuntimeHostRequestInterruptedError('workhub.tasks.send', 'command', 'dispatched', 'connection_lost');
  assert.deepEqual(await send(event, input), { kind: 'unknown' });
  failure = new RuntimeHostRequestInterruptedError('workhub.tasks.send', 'command', 'not_dispatched', 'connection_lost');
  assert.deepEqual(await send(event, input), { kind: 'rejected', code: 'host_not_ready', message: failure.message });
  const beforeRead = sends.length;
  assert.deepEqual(await read(event, { workId: input.workId, inputId: input.inputId }), receipt);
  assert.equal(sends.length, beforeRead, 'receipt reads never resubmit a command');
  assert.deepEqual(reads, [{ workId: input.workId, inputId: input.inputId }]);
  assert.ok(sends.every(value => value === input), 'all explicit retries preserve the original payload');
});

test('persists the shared native WorkHub model in coordinator configuration while retaining executor choices', async () => {
  const handlers = new Map<string, IpcHandler>();
  let coordination = { id: WORKHUB_COORDINATION_SESSION_ID, revision: 1, llmConnectionId: 'first', llmConnectionSlug: 'provider', model: 'first-model' } as SessionCatalogProjection;
  const changes: unknown[] = [];
  const client = { hostId: 'host-defaults', getWorkHubSession: async () => coordination,
    configureWorkHubModel: async (input: import('@maka/runtime-host/protocol').OperationInput<'workhub.coordination.configureModel'>) => {
      changes.push(input);
      coordination = { ...coordination, revision: coordination.revision + 1, llmConnectionId: input.modelTarget.connectionId,
        model: input.modelTarget.model, ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}) };
      return { kind: 'committed', session: coordination };
    },
  } as Parameters<
    typeof registerRuntimeHostWorkHubIpc
  >[0];
  registerRuntimeHostWorkHubIpc(
    client,
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {},
  );
  const event = { sender: { id: 7 } } as Parameters<IpcHandler>[0];
  const read = handlers.get('workhub:getNewWorkDefaults');
  const write = handlers.get('workhub:setNewWorkDefaults');
  assert.ok(read);
  assert.ok(write);
  assert.deepEqual(await read(event), { model: { llmConnectionId: 'first', llmConnectionSlug: 'provider', model: 'first-model' } });
  const defaults = {
    executorId: 'codex.app-server',
    executorModel: 'gpt-6-astra',
    thinkingLevel: 'high',
  };
  await write(event, defaults);
  assert.deepEqual(await read(event), defaults);
  await assert.rejects(
    async () => write(event, { ...defaults, permissionMode: 'bypass' }),
    /Invalid WorkHub new-work defaults/u,
  );

  const replacementHandlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    { ...client } as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel, handler) {
        replacementHandlers.set(channel, handler);
      },
    },
    {},
  );
  const replacementRead = replacementHandlers.get('workhub:getNewWorkDefaults');
  assert.ok(replacementRead);
  assert.deepEqual(
    await replacementRead(event),
    defaults,
    'replacement clients for the same Host retain the execution defaults',
  );
  const native = { model: { llmConnectionId: 'selected', llmConnectionSlug: 'provider', model: 'selected-model' }, thinkingLevel: 'high' };
  await write(event, native);
  assert.deepEqual(changes, [{ expectedRevision: 1, modelTarget: { kind: 'explicit', connectionId: 'selected', connectionSlug: 'provider', model: 'selected-model' }, thinkingLevel: 'high' }]);
  assert.deepEqual(await replacementRead(event), native, 'replacement Desktop clients read the native preference from persistent coordinator settings');
  assert.equal(coordination.model, 'selected-model');
  client.configureWorkHubModel = async () => ({ kind: 'revision_conflict', expectedRevision: coordination.revision, actualRevision: coordination.revision + 1 });
  await assert.rejects(async () => write(event, { model: { ...native.model, model: 'conflicting-model' } }), /WorkHub changed/);
  assert.deepEqual(await read(event), native, 'a conflicting save cannot replace the persisted visible preference');
});

test('new-work permissions use Host policy, preserve other defaults and reject invalid writes', async () => {
  let policy = createDefaultRuntimePolicy();
  let writes = 0;
  function register(readPolicy: () => RuntimePolicy = () => policy) {
    const handlers = new Map<string, IpcHandler>();
    const client = {
      queryRuntimePolicy: async () => ({ revision: writes, policy: readPolicy() }),
      updateRuntimePolicy: async (build: Parameters<Parameters<typeof registerRuntimeHostWorkHubIpc>[0]['updateRuntimePolicy']>[0]) => {
        const operation = build(policy);
        assert.equal(operation.kind, 'set_chat_defaults');
        if (operation.kind === 'set_chat_defaults') policy = { ...policy, chatDefaults: operation.value };
        writes++;
        return { revision: writes, policy };
      },
    } as Parameters<typeof registerRuntimeHostWorkHubIpc>[0];
    registerRuntimeHostWorkHubIpc(client, { handle: (channel, handler) => handlers.set(channel, handler) }, {});
    return {
      read: () => handlers.get('workhub:getNewWorkPermissionMode')!({} as Parameters<IpcHandler>[0]),
      write: (mode: unknown) => handlers.get('workhub:setNewWorkPermissionMode')!({} as Parameters<IpcHandler>[0], mode),
      readConcurrency: () => handlers.get('workhub:getExecutionConcurrency')!({} as Parameters<IpcHandler>[0]),
      writeConcurrency: (value: unknown) => handlers.get('workhub:setExecutionConcurrency')!({} as Parameters<IpcHandler>[0], value),
    };
  }
  const original = register();
  assert.equal(await original.read(), 'ask', 'ordinary chat bypass is not inherited');
  assert.equal(await original.write('bypass'), 'bypass');
  assert.equal(policy.chatDefaults.permissionMode, 'bypass');
  assert.equal(await register().read(), 'bypass', 'replacement Desktop clients read the saved Host value');
  assert.equal(await register(createDefaultRuntimePolicy).read(), 'ask', 'another Host does not inherit the value');
  policy = { ...policy, chatDefaults: { ...policy.chatDefaults, codeModeEnabled: true } };
  assert.equal(await original.write('ask'), 'ask');
  assert.equal(policy.chatDefaults.codeModeEnabled, true);
  for (const mode of ['explore', 'invalid', true, null, { permissionMode: 'bypass' }]) {
    await assert.rejects(async () => original.write(mode), /Invalid WorkHub new-work permission mode/u);
  }
  assert.equal(writes, 2);
  assert.equal(await original.readConcurrency(), 3);
  assert.equal(await original.writeConcurrency(1), 1);
  assert.equal(await register().readConcurrency(), 1);
  assert.equal(await register(createDefaultRuntimePolicy).readConcurrency(), 3);
  assert.equal(policy.chatDefaults.workHubPermissionMode, 'ask');
  assert.equal(policy.chatDefaults.codeModeEnabled, true);
  for (const value of [0, -1, 1.5, 9, '3', null]) await assert.rejects(async () => original.writeConcurrency(value), /Invalid WorkHub execution concurrency/u);
  assert.equal(writes, 3);
});

test('returns a structured WorkHub attachment rejection across IPC', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    {} as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {
      attachmentIngest: {
        approvals: {} as never,
        stat: async () => ({ size: 0 }),
      },
    },
  );

  const prepareAttachments = handlers.get('workhub:prepareAttachments');
  assert.ok(prepareAttachments);
  const result = await prepareAttachments(
    { sender: { id: 7 } } as Parameters<IpcHandler>[0],
    Array.from({ length: 9 }, () => ({})),
  );
  assert.deepEqual(result, { ok: false, code: 'count_limit' });
});

test('returns a structured model setup state across IPC', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    {
      resolveWorkHubCoordinationSession: async () => {
        throw new RuntimeHostOperationError(
          'workhub.coordination.resolve',
          'model_required',
          'A default model must be selected',
        );
      },
    } as unknown as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {},
  );

  const resolve = handlers.get('workhub:resolveCoordinationSession');
  assert.ok(resolve);
  const result = await resolve({ sender: { id: 7 } } as Parameters<IpcHandler>[0]);
  assert.deepEqual(result, { kind: 'model_required' });
});

test('does not diagnose an ordinary WorkHub conflict as missing model setup', async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    {
      resolveWorkHubCoordinationSession: async () => {
        throw new RuntimeHostOperationError(
          'workhub.coordination.resolve',
          'operation_conflict',
          'WorkHub Coordination Session requires an available default model',
        );
      },
    } as unknown as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {},
  );

  const resolve = handlers.get('workhub:resolveCoordinationSession');
  assert.ok(resolve);
  await assert.rejects(
    resolve({ sender: { id: 7 } } as Parameters<IpcHandler>[0]),
    (error) =>
      error instanceof RuntimeHostOperationError && error.code === 'operation_conflict',
  );
});
