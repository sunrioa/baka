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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { WORKHUB_COORDINATION_SESSION_ID, type WorkHubCreateDefaults } from '@maka/core/session';
import { createDefaultRuntimePolicy, decodeCanonicalRuntimePolicy, normalizeRuntimePolicyMutation } from '@maka/core/runtime-policy';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { DesktopRuntimeHostClient } from '../runtime-host-client.js';
import { createWorkHubTaskModelRuntime } from '../workhub-task-model-runtime.js';
import { readWorkHubNewWorkDefaults, readWorkHubCreationDefaults, writeWorkHubNewWorkDefaults, writeWorkHubNewWorkPermissionMode,
  readWorkHubCompactionThreshold, writeWorkHubCompactionThreshold } from '../workhub-new-work-defaults.js';

const executor = { executorId: 'codex.app-server', executorModel: 'gpt-6-astra', thinkingLevel: 'high' as const };
test('coordinator compaction setting survives reload, clears to inheritance, and preserves all task defaults', async () => {
  const f = fixture();
  await writeWorkHubNewWorkDefaults(f.client, executor);
  await writeWorkHubNewWorkPermissionMode(f.client, 'bypass');
  const previous = structuredClone(f.policy);
  assert.equal(await readWorkHubCompactionThreshold(f.client), null);
  assert.equal(await writeWorkHubCompactionThreshold(f.client, 127001), 127001);
  assert.equal(await readWorkHubCompactionThreshold(f.client), 127001);
  assert.deepEqual(f.policy, { ...previous, chatDefaults: { ...previous.chatDefaults, workHubCompactionThreshold: 127001 } });
  assert.equal(await writeWorkHubCompactionThreshold(f.client, null), null);
  assert.deepEqual(f.policy, previous);
  for (const value of [0, -1, 1.1, '1000', undefined, false, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(writeWorkHubCompactionThreshold(f.client, value));
    assert.deepEqual(f.policy, previous);
  }
});

function fixture() {
  let policy = createDefaultRuntimePolicy();
  let native = { id: WORKHUB_COORDINATION_SESSION_ID, revision: 1, llmConnectionId: 'saved-connection', llmConnectionSlug: 'saved-provider', model: 'saved-native', thinkingLevel: 'medium' as const };
  let configureCalls = 0, policyReads = 0;
  let conflict = false, failSave = false;
  const client = { hostId: 'same-host-across-restart', getWorkHubSession: async () => native,
    queryRuntimePolicy: async () => { policyReads++; return { revision: 1, policy: decodeCanonicalRuntimePolicy(JSON.parse(JSON.stringify(policy))) }; },
    updateRuntimePolicy: async (build: Parameters<Parameters<typeof writeWorkHubNewWorkDefaults>[0]['updateRuntimePolicy']>[0]) => {
      if (failSave) throw new Error('Policy unavailable');
      const operation = normalizeRuntimePolicyMutation({ expectedRevision: 1, operation: build(policy) }).operation;
      assert.equal(operation.kind, 'set_chat_defaults');
      if (operation.kind === 'set_chat_defaults') policy = decodeCanonicalRuntimePolicy({ ...policy, chatDefaults: operation.value });
      return { revision: 1, policy };
    },
    configureWorkHubModel: async (input: Parameters<Parameters<typeof writeWorkHubNewWorkDefaults>[0]['configureWorkHubModel']>[0]) => {
      configureCalls++;
      if (conflict) return { kind: 'revision_conflict' as const, expectedRevision: 1, actualRevision: 2 };
      native = { ...native, revision: native.revision + 1, llmConnectionId: input.modelTarget.connectionId, llmConnectionSlug: input.modelTarget.connectionSlug, model: input.modelTarget.model };
      return { kind: 'committed' as const, session: native };
    },
  } as Parameters<typeof writeWorkHubNewWorkDefaults>[0];
  return { client, get policy() { return policy; }, get native() { return native; }, get configureCalls() { return configureCalls; }, get policyReads() { return policyReads; }, fail() { failSave = true; }, conflict() { conflict = true; } };
}

test('executor creation preferences survive a fresh Main module without routing the coordinator or inheriting ordinary permissions', async () => {
  const f = fixture();
  const nativeBefore = structuredClone(f.native);
  await writeWorkHubNewWorkDefaults(f.client, executor);
  assert.deepEqual(f.policy.chatDefaults.workHubExecutor, executor);
  assert.deepEqual(f.native, nativeBefore);
  assert.equal(f.configureCalls, 0);
  // A fresh module has no process-local override Map to reuse, just as after restart.
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../../src/main/workhub-new-work-defaults.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} as Pick<typeof import('../workhub-new-work-defaults.js'), 'readWorkHubNewWorkDefaults' | 'readWorkHubCreationDefaults'> };
  runInNewContext(bundle.outputFiles[0]!.text, { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, TextEncoder, TextDecoder, Uint8Array });
  assert.deepEqual(structuredClone(await module.exports.readWorkHubNewWorkDefaults(f.client)), executor);
  const readsBefore = f.policyReads;
  assert.deepEqual(structuredClone(await module.exports.readWorkHubCreationDefaults(f.client)), { permissionMode: 'ask', ...executor });
  assert.equal(f.policyReads, readsBefore + 1, 'permission and executor choice come from one policy snapshot');
  const admissions: WorkHubCreateDefaults[] = [];
  const taskClient = { startWorkHubTask: async (input: Parameters<DesktopRuntimeHostClient['startWorkHubTask']>[0]) => {
    assert.ok(input.newWorkDefaults);
    admissions.push(input.newWorkDefaults);
    return { disposition: 'create_new' as const, workId: input.actionId, targetSessionId: 'new-task-session' };
  } } as unknown as ReturnType<Parameters<typeof createWorkHubTaskModelRuntime>[0]['client']>;
  const runtime = createWorkHubTaskModelRuntime({ client: () => taskClient, isCurrent: () => true,
    createDefaults: () => module.exports.readWorkHubCreationDefaults(f.client), changed() {} });
  await runtime.actTask({ hostId: f.client.hostId, targetEpoch: 'same-host-epoch' }, 'coordinator-turn', 'original-call', { kind: 'start', input: { title: 'Task', text: 'Do the original task' } });
  assert.deepEqual(structuredClone(admissions), [{ permissionMode: 'ask', ...executor }], 'the existing start adapter receives the persisted choice without new model arguments or permissions');
  await writeWorkHubNewWorkPermissionMode(f.client, 'bypass');
  assert.deepEqual(await readWorkHubCreationDefaults(f.client), { permissionMode: 'bypass', ...executor });
  assert.equal(f.policy.chatDefaults.permissionMode, 'bypass', 'ordinary chat permission was not changed');
  await writeWorkHubNewWorkDefaults(f.client, {});
  assert.equal(f.policy.chatDefaults.workHubExecutor, undefined);
  assert.deepEqual(await readWorkHubNewWorkDefaults(f.client), { model: { llmConnectionId: 'saved-connection', llmConnectionSlug: 'saved-provider', model: 'saved-native' }, thinkingLevel: 'medium' });
  assert.deepEqual(f.native, nativeBefore, 'returning to saved native defaults does not select another provider or model');
  assert.equal(f.configureCalls, 0);
});

test('unavailable or deleted executor choices are retained exactly, never replaced with an available native model', async () => {
  const f = fixture();
  const selected = { ...executor, executorId: 'deleted.executor', executorModel: 'saved-unavailable-model' };
  await writeWorkHubNewWorkDefaults(f.client, selected);
  f.client.getWorkHubSession = async () => assert.fail('Unavailable executors must not silently take native defaults');
  assert.deepEqual(await readWorkHubNewWorkDefaults(f.client), selected);
  assert.deepEqual(await readWorkHubCreationDefaults(f.client), { permissionMode: 'ask', ...selected });
  assert.equal(f.configureCalls, 0);
});

test('failed preference writes and native conflicts retain the executor choice, and injected fields are rejected', async () => {
  const f = fixture();
  await writeWorkHubNewWorkDefaults(f.client, executor);
  f.conflict();
  await assert.rejects(writeWorkHubNewWorkDefaults(f.client, { model: { llmConnectionId: 'other', llmConnectionSlug: 'other', model: 'other' } }), /WorkHub changed/u);
  assert.deepEqual(await readWorkHubNewWorkDefaults(f.client), executor);
  f.fail();
  await assert.rejects(writeWorkHubNewWorkDefaults(f.client, { ...executor, executorModel: 'not-saved' }), /Policy unavailable/u);
  assert.deepEqual(await readWorkHubNewWorkDefaults(f.client), executor);
  for (const extra of [{ permissionMode: 'bypass' }, { sourceActionId: 'forged' }, { model: { llmConnectionId: 'other', llmConnectionSlug: 'other', model: 'other' } }])
    await assert.rejects(writeWorkHubNewWorkDefaults(f.client, { ...executor, ...extra } as typeof executor), /Invalid WorkHub new-work defaults/u);
});

test('native configuration cannot report a successful switch when clearing the saved executor fails', async () => {
  const f = fixture();
  await writeWorkHubNewWorkDefaults(f.client, executor);
  f.fail();
  await assert.rejects(writeWorkHubNewWorkDefaults(f.client, { model: { llmConnectionId: 'other', llmConnectionSlug: 'other', model: 'other' } }), /Policy unavailable/u);
  assert.equal(f.configureCalls, 1, 'the original native configuration committed before the policy failure');
  assert.equal(f.native.model, 'other');
  assert.deepEqual(await readWorkHubNewWorkDefaults(f.client), executor, 'creation still uses the durable executor selection, not a falsely successful native default');
});

test('executor preference writes retry the existing policy revision without losing concurrent permission or chat defaults', async () => {
  let policy = createDefaultRuntimePolicy(), revision = 1, conflictNext = true;
  const attempts: number[] = [];
  const connection = { rootId: 'host-with-policy',
    request: async (operation: string, input: unknown) => {
      if (operation === 'runtime.policy.query') return { revision, policy: structuredClone(policy) };
      assert.equal(operation, 'runtime.policy.mutate');
      const mutation = normalizeRuntimePolicyMutation(input);
      attempts.push(mutation.expectedRevision);
      if (conflictNext) {
        conflictNext = false;
        policy = { ...policy, chatDefaults: { ...policy.chatDefaults, permissionMode: 'ask', workHubPermissionMode: 'bypass', workHubMaxConcurrentSessions: revision + 1, codeModeEnabled: true } };
        revision++;
        return { kind: 'revision_conflict', expectedRevision: mutation.expectedRevision, actualRevision: revision };
      }
      assert.equal(mutation.expectedRevision, revision);
      assert.equal(mutation.operation.kind, 'set_chat_defaults');
      if (mutation.operation.kind === 'set_chat_defaults') policy = decodeCanonicalRuntimePolicy({ ...policy, chatDefaults: mutation.operation.value });
      revision++;
      return { kind: 'committed', snapshot: { revision, policy: structuredClone(policy) } };
    },
  } as unknown as RuntimeHostConnection;
  const client = new DesktopRuntimeHostClient(connection);
  await writeWorkHubNewWorkDefaults(client, executor);
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(policy.chatDefaults, { permissionMode: 'ask', workHubPermissionMode: 'bypass', workHubMaxConcurrentSessions: 2, codeModeEnabled: true, workHubExecutor: executor });
  conflictNext = true;
  await writeWorkHubNewWorkDefaults(client, {});
  assert.deepEqual(attempts, [1, 2, 3, 4]);
  assert.deepEqual(policy.chatDefaults, { permissionMode: 'ask', workHubPermissionMode: 'bypass', workHubMaxConcurrentSessions: 4, codeModeEnabled: true });
});
