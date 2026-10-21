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
import { useWorkHubWorkspace } from '../../renderer/application/contracts/workhub-workspace/use-workhub-workspace.js';
import { deferred } from '@maka/core/test-only/async-primitives';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { afterEach, test } from 'node:test';
import { act, createElement, useEffect } from 'react';
import { useToast, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  WorkHubServicesProvider,
  WorkHubSurfaceSwitch,
  type WorkHubServices,
} from '../../renderer/features/workhub/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useWorkHubTaskSelection } from '../../renderer/features/workhub/testing.js';
import type { WorkHubPresentationSnapshot } from '../../shared/workhub-presentation.js';

afterEach(cleanupFakeDom);

test('the coordinator and shell task reader share selection without accepting an older snapshot or another owner', async () => {
  const { root } = installReactRenderer();
  const initial = deferred<WorkHubPresentationSnapshot>();
  const subscribers = new Set<(snapshot: WorkHubPresentationSnapshot) => void>();
  const owner = desktopSessionKey({ hostId: 'host', sessionId: 'coordination' });
  const work = { sessionId: desktopSessionKey({ hostId: 'host', sessionId: 'shared-session' }), name: 'A', workId: 'a' };
  const base: WorkHubPresentationSnapshot = { placement: 'docked', floatingVisible: false, rendererCrashed: false, shortcutRegistered: true };
  const services = { presentation: {
    getSnapshot: () => initial.promise,
    subscribe: (notify: (snapshot: WorkHubPresentationSnapshot) => void) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    selectTask: async (selection: NonNullable<WorkHubPresentationSnapshot['taskSelection']>) => { for (const notify of subscribers) notify({ ...base, taskSelection: selection }); },
  } } as WorkHubServices;
  const readers: Array<ReturnType<typeof useWorkHubTaskSelection>> = [];
  function Reader({ index, owner }: { index: number; owner: string }) { readers[index] = useWorkHubTaskSelection(services, owner); return null; }
  const render = (secondOwner: string) => root.render(createElement('div', null, createElement(Reader, { index: 0, owner }), createElement(Reader, { index: 1, owner: secondOwner })));
  try {
    await act(async () => render(owner));
    await act(async () => readers[0]!.select(work));
    assert.equal(readers[1]!.selected?.workId, 'a');
    await act(async () => initial.resolve(base));
    assert.equal(readers[0]!.selected?.workId, 'a', 'an initial IPC read cannot overwrite a newer selection notification');
    await act(async () => readers[1]!.select({ ...work, name: 'B', workId: 'b' }));
    assert.equal(readers[0]!.selected?.workId, 'b', 'two works sharing a Session remain distinct');
    await act(async () => render(desktopSessionKey({ hostId: 'other-host', sessionId: 'coordination' })));
    assert.equal(readers[1]!.selected, undefined, 'switching Host hides the old owner before any new effect runs');
    await act(async () => readers[0]!.select(undefined));
    assert.equal(readers[0]!.selected, undefined);
  } finally { await act(async () => root.unmount()); }
  assert.equal(subscribers.size, 0);
});

test('closing the unified workbar hides task highlights and invalidates an older pending open', async () => {
  const { root } = installReactRenderer();
  const subscribers = new Set<(snapshot: WorkHubPresentationSnapshot) => void>();
  const owner = desktopSessionKey({ hostId: 'host', sessionId: 'coordination' });
  const work = { sessionId: desktopSessionKey({ hostId: 'host', sessionId: 'worker' }), name: 'A', workId: 'a' };
  const opened: WorkHubPresentationSnapshot = { placement: 'docked', floatingVisible: false, rendererCrashed: false,
    shortcutRegistered: true, workbar: { collapsed: false, placement: 'right' }, taskSelection: { ownerSessionId: owner, work } };
  const read = deferred<Awaited<ReturnType<WorkHubServices['readTask']>>>();
  const writes: NonNullable<WorkHubPresentationSnapshot['taskSelection']>[] = [];
  const services = { presentation: {
    getSnapshot: async () => opened,
    subscribe: (notify: (snapshot: WorkHubPresentationSnapshot) => void) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    selectTask: async (selection: NonNullable<WorkHubPresentationSnapshot['taskSelection']>) => { writes.push(selection); },
  }, readTask: () => read.promise } as unknown as WorkHubServices;
  const readers: Array<ReturnType<typeof useWorkHubTaskSelection>> = [];
  function Reader({ index }: { index: number }) { readers[index] = useWorkHubTaskSelection(services, owner); return null; }
  const publish = (snapshot: WorkHubPresentationSnapshot) => { for (const notify of subscribers) notify(snapshot); };
  try {
    await act(async () => root.render(createElement('div', null, createElement(Reader, { index: 0 }), createElement(Reader, { index: 1 }))));
    assert.ok(readers.every(reader => reader.selected?.workId === 'a'));
    let pending!: Promise<void>;
    await act(() => { pending = readers[0]!.open({ workId: 'b' }); });
    await act(() => publish({ ...opened, workbar: { collapsed: true, placement: 'right' } }));
    assert.ok(readers.every(reader => reader.selected === undefined), 'a hidden task pane must not leave its card pressed');
    assert.deepEqual(writes, [], 'visibility only changes presentation, not task authority or the retained selection');
    await act(async () => {
      read.resolve({ task: { actionId: 'b', workId: 'b', delegationId: 'delegation-b', targetSessionId: work.sessionId,
        targetSessionName: 'B', targetMessageId: 'message-b', text: 'B', createdAt: 1, status: 'pending_acceptance' } });
      await pending;
    });
    assert.deepEqual(writes, [], 'a read started before closure must not reopen the hidden pane');
    await act(() => publish(opened));
    assert.ok(readers.every(reader => reader.selected?.workId === 'a'), 'explicit reopening can still restore the retained exact selection');
    await act(() => publish({ ...opened, taskSelection: { ownerSessionId: owner } }));
    assert.ok(readers.every(reader => reader.selected === undefined), 'the generic task-list entry still clears the selection');
  } finally { await act(async () => root.unmount()); }
  assert.equal(subscribers.size, 0);
});

test('the main surface does not mount WorkHub or start its lifecycle', async () => {
  const { root, container } = installReactRenderer();
  const services = { surface: 'main' } as WorkHubServices;
  function UnexpectedWorkHub() {
    return assert.fail('WorkHub must not mount in the main surface');
  }
  try {
    await act(async () => root.render(createElement(WorkHubServicesProvider, {
      services,
      children: createElement(WorkHubSurfaceSwitch, {
        main: createElement('div', null, 'main'),
        workhub: createElement(UnexpectedWorkHub),
      }),
    })));
    assert.equal(container.textContent, 'main');
  } finally {
    await act(async () => root.unmount());
  }
});

test('the WorkHub slot retains its providers and mount across locale updates', async () => {
  const { root } = installReactRenderer();
  let emitLocale!: (locale: UiLocale) => void;
  let latestLocale: UiLocale | undefined;
  let mounts = 0;
  let unmounts = 0;
  let subscriptions = 0;
  let unsubscribes = 0;
  let readyCalls = 0;
  const services = {
    surface: 'workhub',
    initialLocale: 'en',
    subscribeAppearance: (handler: (locale: UiLocale) => void) => {
      subscriptions += 1;
      emitLocale = handler;
      return () => { unsubscribes += 1; };
    },
    presentation: { ready: async () => { readyCalls += 1; } },
  } as WorkHubServices;
  function WorkHubProbe() {
    latestLocale = useUiLocale();
    assert.equal(typeof useToast().toast, 'function');
    useEffect(() => {
      mounts += 1;
      return () => { unmounts += 1; };
    }, []);
    return null;
  }
  function UnexpectedMain() {
    return assert.fail('the main shell must not mount in the WorkHub surface');
  }
  try {
    await act(async () => root.render(createElement(WorkHubServicesProvider, {
      services,
      children: createElement(WorkHubSurfaceSwitch, {
        main: createElement(UnexpectedMain),
        workhub: createElement(WorkHubProbe),
      }),
    })));
    assert.equal(latestLocale, 'en');
    await act(async () => emitLocale('zh-CN'));
    assert.equal(latestLocale, 'zh-CN');
    assert.deepEqual({ mounts, unmounts, subscriptions, readyCalls }, {
      mounts: 1, unmounts: 0, subscriptions: 1, readyCalls: 1,
    });
  } finally {
    await act(async () => root.unmount());
  }
  assert.equal(unmounts, 1);
  assert.equal(unsubscribes, 1);
});

test('Main panels follow the resolved Host identity and retain Coordination in the catalog', async () => {
  const { root } = installReactRenderer();
  const first = desktopSessionKey({ hostId: 'first', sessionId: 'maka_workhub_coordination' });
  const second = desktopSessionKey({ hostId: 'second', sessionId: 'maka_workhub_coordination' });
  const oldResolve = deferred<string>();
  let selected = first;
  let resolves = 0;
  let hostChange!: Parameters<WorkHubServices['subscribeHosts']>[0];
  let latest!: ReturnType<typeof useWorkHubWorkspace>;
  const services = {
    resolve: async () => { resolves++; return selected === first ? oldResolve.promise : selected; },
    subscribeHosts: (handler: Parameters<WorkHubServices['subscribeHosts']>[0]) => { hostChange = handler; return () => {}; },
    subscribeAvailability: () => () => {},
  } as unknown as WorkHubServices;
  const workspace = () => latest;
  const ids = new Set(['ordinary']);
  function Probe({ enabled }: { enabled: boolean }) { latest = useWorkHubWorkspace(enabled, ids); return null; }
  const render = (enabled: boolean) => root.render(createElement(WorkHubServicesProvider, { services, children: createElement(Probe, { enabled }) }));
  try {
    await act(async () => render(false));
    assert.equal(resolves, 0);
    await act(async () => render(true));
    assert.equal(workspace().sessionId, undefined);
    selected = second;
    await act(async () => hostChange({ hostId: 'second', isDefault: true, readiness: 'ready' }));
    assert.equal(workspace().sessionId, second);
    await act(async () => oldResolve.resolve(first));
    assert.equal(workspace().sessionId, second);
    assert.deepEqual([...workspace().authoritativeSessionIds!], ['ordinary', second]);
    await act(async () => render(false));
    assert.equal(workspace().sessionId, undefined);
    assert.deepEqual([...workspace().authoritativeSessionIds!], ['ordinary']);
  } finally {
    await act(async () => root.unmount());
  }
});
