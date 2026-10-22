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
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { createWorkHubRuntime } from '../workhub-runtime.js';
import { readWorkHubCreationDefaults } from '../workhub-new-work-defaults.js';

const scope = { hostId: 'host', targetEpoch: 'epoch' };
function fixture() {
  let current = true;
  const stops: unknown[] = [];
  const deps: Parameters<typeof createWorkHubRuntime>[0] = {
    isCurrent: () => current,
    client: () => client,
  };
  const client = {
    queryTurn: async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'running' as const }),
    stopTurn: async (input: unknown) => { stops.push(input); },
  } as unknown as ReturnType<typeof deps.client>;
  return { deps, client, stops, retire: () => { current = false; }, runtime: createWorkHubRuntime(deps) };
}

test('creation defaults use the durable coordinator configuration and never substitute another model', async () => {
  const client = { hostId: 'shared-native-defaults-host', queryRuntimePolicy: async () => ({ revision: 1, policy: createDefaultRuntimePolicy() }),
    getWorkHubSession: async () => ({ id: WORKHUB_COORDINATION_SESSION_ID, llmConnectionId: 'selected', llmConnectionSlug: 'selected', model: 'selected-model', thinkingLevel: 'high' as const }) };
  assert.deepEqual(await readWorkHubCreationDefaults(client), { permissionMode: 'ask', model: { llmConnectionId: 'selected', llmConnectionSlug: 'selected', model: 'selected-model' }, thinkingLevel: 'high' });
  for (const session of [null, { id: WORKHUB_COORDINATION_SESSION_ID, llmConnectionId: null, llmConnectionSlug: 'unbound', model: 'unknown' },
    { id: 'foreign-session', llmConnectionId: 'foreign', llmConnectionSlug: 'foreign', model: 'foreign-model' }])
    await assert.rejects(readWorkHubCreationDefaults({ ...client, getWorkHubSession: async () => session }), /Select an available model/);
  await assert.rejects(readWorkHubCreationDefaults({ ...client, getWorkHubSession: async () => { throw new Error('Host unavailable'); } }), /Host unavailable/);
});

test('takeover stops the exact old turn and run even after selecting another Host', async () => {
  const f = fixture();
  f.retire();
  await f.runtime.interrupt(scope, 'turn');
  assert.deepEqual(f.stops, [{ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run' }]);
  await assert.rejects(f.runtime.assertTurn(scope, 'turn'), /Runtime Host changed/);
});

test('a changed turn identity cannot become the takeover target', async () => {
  const f = fixture();
  f.client.queryTurn = async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'new-turn', runId: 'new-run', status: 'running' });
  await assert.rejects(f.runtime.interrupt(scope, 'turn'), /turn identity changed/);
  assert.deepEqual(f.stops, []);
});

test('takeover retains its original client while a Host switches during the Turn read', async () => {
  const f = fixture();
  f.client.queryTurn = async () => {
    f.deps.client = () => { throw new Error('Do not reroute takeover to the current Host'); };
    return { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'running' };
  };
  await f.runtime.interrupt(scope, 'turn');
  assert.deepEqual(f.stops, [{ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run' }]);
});

test('native control checks current Host and exact live coordination identity', async () => {
  const f = fixture();
  await f.runtime.assertTurn(scope, 'turn');
  f.client.queryTurn = async () => { f.retire(); return { sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'running' }; };
  await assert.rejects(f.runtime.assertTurn(scope, 'turn'), /Runtime Host changed/);
  assert.equal('actTasks' in f.runtime, false, 'legacy tasks union is no longer a capability');

  const completed = fixture();
  completed.client.queryTurn = async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'completed', terminalEventId: 'completed-event' });
  await assert.rejects(completed.runtime.assertTurn(scope, 'turn'), /no longer active/);
  await completed.runtime.interrupt(scope, 'turn');
  assert.deepEqual(completed.stops, []);
});
