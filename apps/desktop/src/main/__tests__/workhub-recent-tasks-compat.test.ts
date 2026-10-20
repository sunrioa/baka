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
import { afterEach, test } from 'node:test';
import { build } from 'esbuild';
import { act, createElement, StrictMode, useState } from 'react';
import { LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { RuntimeHostOperationError } from '@maka/runtime-host/client';
import type { OperationInput, OperationKey, RequestFrame, WorkHubTasksQueryResult } from '@maka/runtime-host/protocol';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import { createDesktopWorkHubServices } from '../../renderer/platform/desktop/create-workhub-services.js';
import { createWorkHubTaskSearchModel, useWorkHubTaskSearch, WorkHubTaskOverview } from '../../renderer/features/workhub/testing.js';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';
import type { WorkHubTaskListResult } from '../../shared/workhub-conversation.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

type Client = Parameters<typeof registerRuntimeHostWorkHubIpc>[0];
const event = {} as Parameters<IpcHandler>[0];
const recent: WorkHubTasksQueryResult = { tasks: [{
  workId: 'original-work', actionId: 'original-action', delegationId: 'original-link', title: 'Original recent task',
  targetSessionId: 'original-session', targetSessionName: 'Conversation', targetMessageId: 'original-message',
  text: 'Original requirement', createdAt: 1, status: 'waiting_for_user',
}], truncated: true };

function register(client: Partial<Client>) {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostWorkHubIpc({ hostId: 'remote-host', hostEpoch: 'host-epoch', ...client } as Client,
    { handle: (channel, handler) => handlers.set(channel, handler) }, {});
  return handlers;
}

test('a missing find grant preserves only the independently authorized recent-task window', async () => {
  const calls: string[] = [];
  const handlers = register({
    findWorkHubTasks: async () => { calls.push('find'); throw new RuntimeHostOperationError('workhub.tasks.find', 'unauthorized', 'Not authorized'); },
    queryWorkHubTasks: async () => { calls.push('query'); return recent; },
  });
  assert.deepEqual(await handlers.get('workhub:findTasks')!(event, {}), { kind: 'recent_only', result: recent });
  assert.deepEqual(calls, ['find', 'query']);
});

test('an authorized indexed read is unchanged and does not also request the recent window', async () => {
  const page = { items: [], nextCursor: 'next', match: 'all' as const };
  const read = register({ findWorkHubTasks: async () => page, queryWorkHubTasks: async () => assert.fail('Indexed discovery needs no query fallback') }).get('workhub:findTasks')!;
  assert.equal(await read(event, { query: 'Original' }), page);
});

test('filtered or paginated find denial never reads recent data and path denial remains an error', async () => {
  let queryReads = 0;
  const denied = new RuntimeHostOperationError('workhub.tasks.find', 'unauthorized', 'Not authorized');
  const read = register({ findWorkHubTasks: async () => { throw denied; }, queryWorkHubTasks: async () => { queryReads++; return recent; } }).get('workhub:findTasks')!;
  for (const input of [{ query: 'Original' }, { query: '' }, { cursor: 'page' }]) {
    assert.deepEqual(await read(event, input), { kind: 'index_not_authorized' });
  }
  await assert.rejects(read(event, { cwd: '/host/private' }), error => error === denied);
  assert.equal(queryReads, 0);
});

test('query denial, unrelated operations and other find failures never become compatibility data', async () => {
  const queryDenied = new RuntimeHostOperationError('workhub.tasks.query', 'unauthorized', 'Query not authorized');
  let queryReads = 0;
  let failure: Error = new RuntimeHostOperationError('workhub.tasks.find', 'unauthorized', 'Not authorized');
  const read = register({ findWorkHubTasks: async () => { throw failure; }, queryWorkHubTasks: async () => { queryReads++; throw queryDenied; } }).get('workhub:findTasks')!;
  await assert.rejects(read(event, {}), error => error === queryDenied);
  assert.equal(queryReads, 1);
  for (const error of [new Error('unauthorized'), new RuntimeHostOperationError('workhub.tasks.query', 'unauthorized', 'Other operation'),
    ...(['operation_unavailable', 'operation_conflict', 'persistence_failed', 'internal_failure', 'host_draining'] as const).map(code => new RuntimeHostOperationError('workhub.tasks.find', code, code))]) {
    failure = error;
    await assert.rejects(read(event, {}), reason => reason === error);
  }
  assert.equal(queryReads, 1, 'only the exact find authorization failure may attempt query');
});

test('recent-only records stay distinct from indexed hits, have no cursor and do not trigger page reads', async () => {
  let reads = 0;
  const model = createWorkHubTaskSearchModel({ findTasks: async () => { reads++; return { kind: 'recent_only', result: recent }; } }, 'owner', '');
  await model.refresh();
  assert.equal(model.snapshot().mode, 'recent_only');
  assert.equal(model.snapshot().recent, recent);
  assert.deepEqual(model.snapshot().items, []);
  assert.equal(model.snapshot().match, undefined);
  assert.equal(model.snapshot().cursor, null);
  await model.loadMore();
  assert.equal(reads, 1);
  model.close();
});

test('an unauthorized index search or page cannot silently display unfiltered recent tasks', async () => {
  const model = createWorkHubTaskSearchModel({ findTasks: async () => ({ kind: 'index_not_authorized' }) }, 'owner', 'private query');
  await model.refresh();
  assert.equal(model.snapshot().mode, 'index_not_authorized');
  assert.equal(model.snapshot().recent, undefined);
  assert.deepEqual(model.snapshot().items, []);
  assert.equal(model.snapshot().cursor, null);
  assert.equal(model.snapshot().match, undefined);
  model.close();
  let reads = 0;
  const pages = createWorkHubTaskSearchModel({ findTasks: async () => ++reads === 1
    ? { items: [], nextCursor: 'restricted-page', match: 'recent' } : { kind: 'index_not_authorized' } }, 'owner', '');
  await pages.refresh();
  await pages.loadMore();
  assert.equal(pages.snapshot().mode, 'index_not_authorized');
  assert.equal(pages.snapshot().recent, undefined);
  assert.equal(pages.snapshot().cursor, null);
  pages.close();
});

for (const change of ['Host', 'availability'] as const) test(`StrictMode drops a late recent-only reply after ${change} changes`, async () => {
  const pending = deferred<WorkHubTaskListResult>();
  let current = false;
  const services = {
    findTasks: async () => current ? { items: [{ kind: 'task', id: 'current', title: 'Current task', state: 'running', lastActivityAt: 1, location: null, available: true, summary: '', segments: 1 }], match: 'recent', nextCursor: null } : pending.promise,
    subscribeSessions: () => () => {}, subscribeActiveInteractions: () => () => {}, subscribeAvailability: () => () => {},
  } as unknown as WorkHubServices;
  let search!: ReturnType<typeof useWorkHubTaskSearch>;
  function Probe({ owner, available }: { owner: string; available: boolean }) { search = useWorkHubTaskSearch(services, owner, available); return null; }
  const { root } = installReactRenderer();
  const render = (owner: string, available: boolean) => createElement(StrictMode, {}, createElement(Probe, { owner, available }));
  await act(async () => { root.render(render('old', true)); });
  if (change === 'availability') await act(async () => { root.render(render('old', false)); });
  current = true;
  await act(async () => { root.render(render(change === 'Host' ? 'new' : 'old', true)); });
  assert.deepEqual(search.rows.map(row => row.id), ['current']);
  await act(async () => { pending.resolve({ kind: 'recent_only', result: recent }); });
  assert.deepEqual(search.rows.map(row => row.id), ['current']);
  assert.equal(search.mode, 'indexed');
  assert.equal(search.recent, undefined);
});

for (const stage of ['find', 'query', 'indexed find'] as const) for (const field of ['hostId', 'hostEpoch'] as const) {
  test(`a ${field} change during ${stage} cannot return a former Host's recent tasks`, async () => {
    const paused = deferred<void>();
    const started = deferred<void>();
    let identity = { hostId: 'original-host', hostEpoch: 'original-epoch' };
    let queryReads = 0;
    const client = {
      get hostId() { return identity.hostId; }, get hostEpoch() { return identity.hostEpoch; },
      async findWorkHubTasks() {
        if (stage !== 'query') { started.resolve(); await paused.promise; }
        if (stage === 'indexed find') return { items: [], nextCursor: null, match: 'recent' as const };
        throw new RuntimeHostOperationError('workhub.tasks.find', 'unauthorized', 'Not authorized');
      },
      async queryWorkHubTasks() { queryReads++; started.resolve(); await paused.promise; return recent; },
    } as unknown as Client;
    const handlers = new Map<string, IpcHandler>();
    registerRuntimeHostWorkHubIpc(client, { handle: (channel, handler) => handlers.set(channel, handler) }, {});
    const reading = handlers.get('workhub:findTasks')!(event, {});
    await started.promise;
    identity = { ...identity, [field]: 'replacement' };
    paused.resolve();
    await assert.rejects(reading, /Runtime Host changed/u);
    assert.equal(queryReads, stage === 'query' ? 1 : 0);
  });
}

test('an old explicit remote grant list reaches Main, real preload and the recent-only task list without gaining find', async () => {
  // Load the real authority helper without starting a Host or touching its lock registry.
  const authorityBundle = await build({ entryPoints: [fileURLToPath(new URL('../../../../../packages/runtime-host/src/server/connection-authority.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs' });
  const module = { exports: {} as { createRuntimeHostConnectionAuthority(input: unknown): unknown; authorizeRuntimeHostOperation(authority: unknown, frame: RequestFrame): boolean } };
  runInNewContext(authorityBundle.outputFiles[0]!.text, { module, exports: module.exports, require: createRequire(import.meta.url), Buffer, TextEncoder, TextDecoder, Uint8Array });
  const oldGrants: readonly OperationKey[] = ['host.status', 'workhub.tasks.query', 'workhub.tasks.read', 'workhub.tasks.history'];
  const principal = { principalKind: 'remote_owner', principalId: 'old-owner', credentialId: 'old-credential', canPublishClientCapabilities: false, canUseHostPaths: false };
  let authority = module.exports.createRuntimeHostConnectionAuthority({ ...principal, operationGrants: oldGrants });
  const calls: string[] = [];
  function authorize(operation: OperationKey, input: unknown) {
    calls.push(operation);
    if (!module.exports.authorizeRuntimeHostOperation(authority, { requestId: String(calls.length), operation, input } as RequestFrame))
      throw new RuntimeHostOperationError(operation, 'unauthorized', 'Runtime Host operation is not authorized');
  }
  const handlers = register({
    findWorkHubTasks: async input => { authorize('workhub.tasks.find', input); assert.fail('The old credential must not gain indexed task or manual Session discovery'); },
    queryWorkHubTasks: async () => { authorize('workhub.tasks.query', {}); return recent; },
  });
  const owner = { hostId: 'remote-host', targetEpoch: 'desktop-epoch', epoch: 'desktop-epoch', profileId: 'old-remote', profileName: 'Old remote', profileKind: 'remote', profileAccess: 'owner', readiness: 'ready', isDefault: true };
  let bridge!: MakaBridge;
  const preloadBundle = await build({ entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] });
  const require = createRequire(import.meta.url);
  runInNewContext(preloadBundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) { if (name === 'maka') bridge = value; } },
      ipcRenderer: { on() {}, off() {}, send() {}, async invoke(channel: string, scope?: { hostId: string; targetEpoch: string }, input?: OperationInput<'workhub.tasks.find'>) {
        if (channel === 'app:bootstrapReady' || channel === 'runtime-host:awaitReady') return;
        if (channel === 'runtime-host:identities') return [owner];
        assert.equal(scope?.hostId, owner.hostId); assert.equal(scope?.targetEpoch, owner.targetEpoch);
        const handler = handlers.get(channel); assert.ok(handler, channel);
        try { return structuredClone(await handler(event, input)); }
        catch (error) { throw new Error((error as Error).message); } // Electron does not preserve custom error fields.
      } },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, crypto: globalThis.crypto,
  });
  const sessionId = desktopSessionKey({ hostId: owner.hostId, sessionId: WORKHUB_COORDINATION_SESSION_ID });
  const result = await bridge.workHub.findTasks(sessionId, {});
  assert.equal('kind' in result && result.kind, 'recent_only');
  assert.deepEqual(calls, ['workhub.tasks.find', 'workhub.tasks.query']);
  assert.ok('result' in result);
  const tasks = (result.result as WorkHubTasksQueryResult).tasks;
  assert.equal(tasks[0]!.targetSessionId, desktopSessionKey({ hostId: owner.hostId, sessionId: 'original-session' }));
  assert.equal('segments' in tasks[0]!, false);
  assert.equal('context' in tasks[0]!, false);
  let search!: ReturnType<typeof useWorkHubTaskSearch>;
  function Pane() {
    const [services] = useState(() => { Object.defineProperty(window, 'location', { configurable: true, value: { search: '?surface=workhub' } }); return createDesktopWorkHubServices(bridge); });
    search = useWorkHubTaskSearch(services, sessionId, true);
    return createElement(WorkHubTaskOverview, { search, onView: async () => {} });
  }
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null }, createElement(Pane)));
  assert.match(markup, /Original recent task/u);
  assert.match(markup, /32/u);
  assert.match(markup, /Indexed search and pagination are not authorized/u);
  assert.match(markup, /does not represent every task/u);
  assert.match(markup, /<input[^>]*disabled/u);
  assert.doesNotMatch(markup, /Load more tasks|original-(action|link|session|work)/u);
  assert.deepEqual(calls, ['workhub.tasks.find', 'workhub.tasks.query', 'workhub.tasks.find', 'workhub.tasks.query']);
  assert.deepEqual(oldGrants, ['host.status', 'workhub.tasks.query', 'workhub.tasks.read', 'workhub.tasks.history']);
  assert.equal(search.cursor, null);
  assert.equal(search.mode, 'recent_only');
  assert.equal(search.match, undefined);
  assert.deepEqual(search.items, [], 'query records are never disguised as new indexed tool hits');
  assert.deepEqual(search.rows[0]!.ref, { actionId: 'original-action', delegationId: 'original-link' });
  const beforeDenied = calls.length;
  assert.deepEqual(await bridge.workHub.findTasks(sessionId, { query: 'Original' }), { kind: 'index_not_authorized' });
  assert.deepEqual(calls.slice(beforeDenied), ['workhub.tasks.find']);
  authority = module.exports.createRuntimeHostConnectionAuthority({ ...principal, operationGrants: ['workhub.tasks.find', 'workhub.tasks.query'] });
  await assert.rejects(bridge.workHub.findTasks(sessionId, { cwd: '/host/private' }), /not authorized/u);
  assert.deepEqual(calls.slice(beforeDenied), ['workhub.tasks.find', 'workhub.tasks.find'], 'the real path gate does not fall back to query');
  authority = module.exports.createRuntimeHostConnectionAuthority({ ...principal, operationGrants: ['host.status'] });
  const denied = createWorkHubTaskSearchModel({ findTasks: bridge.workHub.findTasks }, sessionId, '');
  await denied.refresh();
  assert.equal(denied.snapshot().ready, false);
  assert.match(denied.snapshot().error!, /not authorized/u);
  assert.equal(denied.snapshot().recent, undefined);
  assert.deepEqual(denied.snapshot().items, []);
  denied.close();
});
