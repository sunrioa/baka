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
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import { createDefaultRuntimePolicy, type RuntimePolicy } from '@maka/core/runtime-policy';

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
  assert.equal(ordinary.has('workhub:answerInteraction'), true);
  assert.equal(reconnectable.has('workhub:answerInteraction'), false, 'lost approvals are not automatically replayed');
  assert.equal(ordinary.has('workhub:revokeTaskGrant'), true);
  assert.equal(reconnectable.has('workhub:revokeTaskGrant'), false, 'revocation receipts are rebuilt, never replayed');
});

test('stores new-work execution defaults separately from the coordination Session', async () => {
  const handlers = new Map<string, IpcHandler>();
  const client = { hostId: 'host-defaults' } as Parameters<
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
  assert.deepEqual(await read(event), {});
  const defaults = {
    executorId: 'codex.app-server',
    executorModel: 'gpt-6-astra',
    thinkingLevel: 'high',
  };
  await write(event, defaults);
  assert.deepEqual(await read(event), defaults);
  assert.throws(
    () => write(event, { ...defaults, permissionMode: 'bypass' }),
    /Invalid WorkHub new-work defaults/u,
  );

  const replacementHandlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc(
    { hostId: client.hostId } as Parameters<typeof registerRuntimeHostWorkHubIpc>[0],
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
