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
import { LocaleProvider, useToast, useUiLocale } from '@maka/ui';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  WorkHubServicesProvider,
  WorkHubSurfaceSwitch,
  type WorkHubServices,
} from '../../renderer/features/workhub/index.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import { useWorkHubTaskSelection, WorkHubDock } from '../../renderer/features/workhub/testing.js';
import { WorkHubEnablementProvider } from '../../renderer/application/contracts/workhub-workspace/workhub-enablement.js';
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

test('closing the workbar removes task highlights without clearing selection or changing the task input target', async () => {
  const { root } = installReactRenderer();
  const initial = deferred<WorkHubPresentationSnapshot>();
  let notify!: (snapshot: WorkHubPresentationSnapshot) => void;
  let selectionCalls = 0;
  const owner = desktopSessionKey({ hostId: 'host', sessionId: 'coordination' });
  const work = { sessionId: desktopSessionKey({ hostId: 'host', sessionId: 'shared-session' }), name: 'A', workId: 'a' };
  const base: WorkHubPresentationSnapshot = { placement: 'docked', floatingVisible: false, rendererCrashed: false, shortcutRegistered: true, taskSelection: { ownerSessionId: owner, work } };
  const services = { presentation: {
    getSnapshot: () => initial.promise,
    subscribe: (handler: typeof notify) => { notify = handler; return () => {}; },
    selectTask: async () => { selectionCalls += 1; },
  } } as unknown as WorkHubServices;
  let selection!: ReturnType<typeof useWorkHubTaskSelection>;
  function Reader({ currentOwner = owner }: { currentOwner?: string }) { selection = useWorkHubTaskSelection(services, currentOwner); return null; }
  try {
    await act(async () => root.render(createElement(Reader)));
    assert.equal(selection.highlighted, undefined, 'unknown workbar visibility cannot imply an open preview');
    await act(async () => notify({ ...base, workbar: { collapsed: false, placement: 'right', taskPanelVisible: true } }));
    assert.deepEqual(selection.highlighted, work);
    await act(async () => notify({ ...base, workbar: { collapsed: true, placement: 'right', taskPanelVisible: false } }));
    assert.equal(selection.highlighted, undefined, 'the main card must lose its highlight on manual close');
    assert.deepEqual(selection.selected, work, 'closing is presentation-only and must not redirect or discard the task reader');
    await act(async () => initial.resolve({ ...base, workbar: { collapsed: false, placement: 'right', taskPanelVisible: true } }));
    assert.equal(selection.highlighted, undefined, 'a delayed initial snapshot must not restore a closed highlight');
    await act(async () => notify({ ...base, workbar: { collapsed: false, placement: 'bottom', taskPanelVisible: false } }));
    assert.equal(selection.highlighted, undefined, 'an unrelated bottom tool cannot keep a closed right task preview highlighted');
    assert.deepEqual(selection.selected, work);
    await act(async () => notify({ ...base, workbar: { collapsed: false, placement: 'right', taskPanelVisible: false } }));
    assert.equal(selection.highlighted, undefined, 'switching to another tab or the launcher also hides the task highlight');
    await act(async () => notify({ ...base, workbar: { collapsed: false, placement: 'bottom', taskPanelVisible: true } }));
    assert.deepEqual(selection.highlighted, work, 'an expanded bottom workbar follows the same selection');
    const second = { ...work, name: 'B', workId: 'b' };
    await act(async () => notify({ ...base, taskSelection: { ownerSessionId: owner, work: second }, workbar: { collapsed: false, placement: 'right', taskPanelVisible: true } }));
    assert.deepEqual(selection.highlighted, second, 'different tasks sharing a Session still highlight by work identity');
    await act(async () => notify({ ...base, taskSelection: { ownerSessionId: owner }, workbar: { collapsed: false, placement: 'right', taskPanelVisible: true } }));
    assert.equal(selection.highlighted, undefined, 'the task list has no selected task card');
    await act(async () => notify({ ...base, workbar: { collapsed: false, placement: 'right', taskPanelVisible: true } }));
    await act(async () => root.render(createElement(Reader, { currentOwner: desktopSessionKey({ hostId: 'other', sessionId: 'coordination' }) })));
    assert.equal(selection.highlighted, undefined, 'another owner cannot inherit the visible highlight');
    assert.equal(selection.selected, undefined);
    assert.equal(selectionCalls, 0, 'visibility notifications never issue task selection or dispatch commands');
  } finally { await act(async () => root.unmount()); }
});

test('a floating WorkHub still receives task visibility updates without a docked native surface observer', async () => {
  const { root } = installReactRenderer();
  const prototype = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, 'getBoundingClientRect');
  Object.defineProperty(prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, width: 800, height: 600 }) });
  const owner = desktopSessionKey({ hostId: 'host', sessionId: 'coordination' });
  const work = { sessionId: desktopSessionKey({ hostId: 'host', sessionId: 'task' }), name: 'A', workId: 'a' };
  let snapshot: WorkHubPresentationSnapshot = { placement: 'floating', floatingVisible: true, rendererCrashed: false, shortcutRegistered: true, taskSelection: { ownerSessionId: owner, work } };
  const subscribers = new Set<(snapshot: WorkHubPresentationSnapshot) => void>();
  const services = { presentation: {
    getSnapshot: async () => snapshot,
    subscribe: (notify: (snapshot: WorkHubPresentationSnapshot) => void) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    setHost: async (host: import('../../shared/workhub-presentation.js').WorkHubHost) => {
      if (host.workbar) {
        snapshot = { ...snapshot, workbar: host.workbar };
        for (const notify of subscribers) notify(snapshot);
      }
    },
  } } as unknown as WorkHubServices;
  const enablement = { isEnabled: () => true, subscribe: () => () => {} };
  let selection!: ReturnType<typeof useWorkHubTaskSelection>;
  function Reader() { selection = useWorkHubTaskSelection(services, owner); return null; }
  const render = (taskPanelVisible: boolean, rightCollapsed: boolean) => root.render(createElement(LocaleProvider, { locale: 'en', children: null }, createElement(WorkHubServicesProvider, { services },
    createElement(WorkHubEnablementProvider, { value: enablement }, createElement('div', null,
      createElement(Reader), createElement(WorkHubDock, { workbar: { bottomOpen: true, rightCollapsed, taskPanelVisible } }))))));
  try {
    await act(async () => render(true, false));
    assert.deepEqual(selection.highlighted, work);
    await act(async () => render(false, true));
    assert.equal(snapshot.workbar?.taskPanelVisible, false, 'closing the right task must publish even with the bottom browser open');
    assert.equal(selection.highlighted, undefined);
    assert.deepEqual(selection.selected, work);
    await act(async () => render(true, false));
    assert.deepEqual(selection.highlighted, work, 'reopening still selects the same task');
    await act(async () => render(false, false));
    assert.equal(snapshot.workbar?.taskPanelVisible, false, 'tab-only visibility changes cannot depend on native bounds or collapse changes');
    assert.equal(selection.highlighted, undefined);
  } finally {
    await act(async () => root.unmount());
    if (original) Object.defineProperty(prototype, 'getBoundingClientRect', original);
    else Reflect.deleteProperty(prototype, 'getBoundingClientRect');
  }
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
