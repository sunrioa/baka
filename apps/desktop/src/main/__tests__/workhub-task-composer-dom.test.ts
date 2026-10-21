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
import { test, type TestContext } from 'node:test';
import { act, createElement, createRef, Profiler } from 'react';
import { parseHTML } from 'linkedom';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { ComposerHandle } from '@maka/ui';
import type { WorkHubTaskAssignment, WorkHubTaskDetail, WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

const owner = desktopSessionKey({ hostId: 'composer-host', sessionId: 'maka_workhub_coordination' });
const target = desktopSessionKey({ hostId: 'composer-host', sessionId: 'worker' });
const assignment: WorkHubTaskAssignment = { workId: 'work', generationId: 'generation', actionId: 'action', delegationId: 'delegation',
  targetSessionId: target, targetSessionName: 'Original task', targetMessageId: 'original-user', text: 'Original requirement', createdAt: 1, state: 'queued', superseded: false };
const fullRequirement = '请编写一个 Unicode CLI，正确处理中文、emoji 🧪 和组合字符 e\u0301。\n' +
  '保留原有权限与任务归属；提供测试，不要调用其他任务或改变模型设置。\n'.repeat(16) +
  '输出必须保留字面量 <script> 和引号 "，不把它们解释成 HTML。';

/**
 * A real Composer and its task controllers, not a fake onChange callback.
 * LinkeDOM has no OS IME/AX or editing transactions. Only insertHTML's native
 * DOM write + input event is modelled below; this cannot reproduce Cua or the
 * macOS preedit engine, selection geometry, or Chromium layout timing.
 */
async function mount(t: TestContext) {
  const original = {
    document: globalThis.document, window: globalThis.window, Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement, HTMLBRElement: globalThis.HTMLBRElement, HTMLIFrameElement: globalThis.HTMLIFrameElement,
    Node: globalThis.Node, Text: globalThis.Text, matchMedia: globalThis.matchMedia,
    CompositionEvent: globalThis.CompositionEvent,
    requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const storage = new Map<string, string>(), writes: string[] = [];
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const setAttribute = window.Element.prototype.setAttribute;
  window.Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttribute.call(this, name === 'contentEditable' ? 'contenteditable' : name, value);
  };
  Object.assign(window, {
    getSelection: () => null,
    getComputedStyle: () => ({ direction: 'ltr', writingMode: 'horizontal-tb', getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    CompositionEvent: class extends window.Event { data = ''; },
  });
  Object.assign(document, { getSelection: () => null });
  assert.equal('CompositionEvent' in window, true);
  Object.assign(globalThis, {
    document, window, Element: window.Element, HTMLElement: window.HTMLElement,
    HTMLBRElement: window.HTMLBRElement, HTMLIFrameElement: window.HTMLIFrameElement ?? class {}, Node: window.Node, Text: window.Text,
    matchMedia: window.matchMedia, requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle), IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(value); storage.set(key, value); },
  } });
  let unmount: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await unmount?.(); }
    finally {
      window.Element.prototype.setAttribute = setAttribute;
      Object.assign(globalThis, original);
      if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor);
      else Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });
  // Install the DOM before the client event plugins choose composition support.
  const { createRoot } = await import('react-dom/client');
  const { AstryxLocaleProvider, LocaleProvider, ToastProvider } = await import('@maka/ui');
  const { WorkHubTaskComposer, useWorkHubTaskView } = await import('../../renderer/features/workhub/testing.js');
  const pending = deferred<WorkHubTaskDetail>();
  const sends: Array<Parameters<WorkHubServices['sendTaskInput']>> = [];
  const counts = { overview: 0, history: 0, session: 0, commits: 0, compositionstart: 0, compositionend: 0 };
  const services = {
    async readTask(sessionId, input) {
      assert.equal(sessionId, owner); assert.deepEqual(input, { workId: 'work', includeBrief: true, briefLocale: 'zh-CN' });
      ++counts.overview; return pending.promise;
    },
    async taskHistory(sessionId, input) {
      assert.equal(sessionId, owner); assert.deepEqual(input, { workId: 'work' }); ++counts.history;
      return { workId: 'work', assignments: [assignment], nextCursor: null };
    },
    taskExecutions: async () => assert.fail('A queued source must not read execution history'),
    async getTaskSession(sessionId) {
      assert.equal(sessionId, target); ++counts.session;
      return { id: target, name: 'Actual worker', backend: 'ai-sdk' as const, model: 'worker-model', llmConnectionId: 'connection', llmConnectionSlug: 'worker',
        permissionMode: 'ask' as const, cwd: '/original-worker', isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active' as const, connectionLocked: false };
    },
    subscribeSessions: () => () => {}, subscribeAvailability: () => () => {},
    async sendTaskInput(sessionId, input) {
      assert.equal(sessionId, owner);
      assert.deepEqual(Object.keys(input).sort(), ['generationId', 'inputId', 'text', 'workId']);
      assert.equal(input.workId, 'work'); assert.equal(input.generationId, 'generation');
      sends.push([sessionId, input]);
      const receipt: WorkHubTaskInputResult = { workId: 'work', generationId: 'generation', inputId: input.inputId,
        sourceActionId: 'action', sourceDelegationId: 'delegation', targetSessionId: target, targetMessageId: 'accepted-input',
        acceptedAt: 2, mode: 'queued_supplement', delivery: 'queued' };
      return { kind: 'accepted' as const, receipt };
    },
    readTaskInput: async () => assert.fail('This send has no lost receipt to reconcile'),
    stop: async () => assert.fail('Typing must not stop work'),
  } satisfies Pick<WorkHubServices, 'readTask' | 'taskHistory' | 'taskExecutions' | 'getTaskSession' | 'subscribeSessions' | 'subscribeAvailability' | 'sendTaskInput' | 'readTaskInput' | 'stop'>;
  const composer = createRef<ComposerHandle>();
  let view!: ReturnType<typeof useWorkHubTaskView>;
  function Probe() {
    view = useWorkHubTaskView(services, owner, 'work');
    return createElement(WorkHubTaskComposer, { services: services as unknown as WorkHubServices, owner, workId: 'work', name: 'Task A', view, composerRef: composer });
  }
  const container = document.querySelector<HTMLElement>('#root')!;
  // LinkeDOM invokes capture listeners in registration/bubble order. React
  // delegates both phases to this root; replay its captured delegates first,
  // so a real onPasteCapture stopPropagation can prevent the input's handler.
  // No production handler is replaced or invoked directly by this fixture.
  const addEventListener = container.addEventListener.bind(container);
  const delegates = new Map<string, { capture: EventListenerOrEventListenerObject[]; bubble: EventListenerOrEventListenerObject[] }>();
  container.addEventListener = (name: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
    if (!listener) return;
    let entry = delegates.get(name);
    if (!entry) {
      entry = { capture: [], bubble: [] }; delegates.set(name, entry);
      const handlers = entry;
      addEventListener(name, event => {
        for (const callback of handlers.capture) typeof callback === 'function' ? callback.call(container, event) : callback.handleEvent(event);
        if (!event.cancelBubble) for (const callback of handlers.bubble) typeof callback === 'function' ? callback.call(container, event) : callback.handleEvent(event);
      });
    }
    const capture = typeof options === 'boolean' ? options : options?.capture;
    entry[capture ? 'capture' : 'bubble'].push(listener);
  };
  const root = createRoot(container);
  unmount = async () => { await act(() => root.unmount()); };
  const render = () => act(async () => root.render(createElement(LocaleProvider, { locale: 'zh-CN', children:
    createElement(AstryxLocaleProvider, { children: createElement(ToastProvider, { children:
      createElement('div', { onCompositionStart: () => { ++counts.compositionstart; }, onCompositionEnd: () => { ++counts.compositionend; } }, createElement(Profiler, { id: 'task-composer', onRender: () => {
        // Fail a runaway test rather than letting a passive-effect loop keep
        // printing warnings forever. This guard never schedules an update.
        assert.ok(++counts.commits <= 100, 'Real task Composer did not settle within 100 commits');
      } }, createElement(Probe))),
    }) }),
  })));
  const consoleError = console.error;
  const updateDepth: unknown[][] = [];
  const errorSpy = t.mock.method(console, 'error', (...args: unknown[]) => {
    if (args.some(arg => typeof arg === 'string' && arg.includes('Maximum update depth'))) updateDepth.push(args);
    consoleError(...args);
  });
  t.after(() => errorSpy.mock.restore());
  await render();
  const editable = document.querySelector<HTMLElement>('[contenteditable="true"]');
  assert.ok(editable); assert.equal(view.ready, true); assert.equal(view.briefLoading, true);
  assert.equal(composer.current?.getText(), '');
  const commands: string[] = [];
  Object.assign(document, { execCommand(command: string, _ui: boolean, value: string) {
    assert.equal(command, 'insertHTML'); commands.push(command);
    editable.insertAdjacentHTML('beforeend', value);
    editable.dispatchEvent(new window.Event('input', { bubbles: true }));
    return true;
  } });
  const event = (name: string, properties: object = {}) => Object.assign(new window.Event(name, { bubbles: true, cancelable: true }), properties);
  return {
    counts, sends, writes, commands, render, composer,
    get view() { return view; },
    draft() {
      const key = JSON.stringify(['workhub-task-input-v1', owner, 'work']);
      return (JSON.parse(storage.get(key) ?? '{"draft":""}') as { draft: string }).draft;
    },
    async input(text: string, composing = false) {
      await act(async () => {
        editable.textContent = text;
        editable.dispatchEvent(event('input', { inputType: composing ? 'insertCompositionText' : 'insertText', data: text, isComposing: composing }));
      });
      assert.equal(composer.current?.getText(), text); assert.equal(this.draft(), text); assert.equal(editable.textContent, text);
    },
    async composition(name: 'compositionstart' | 'compositionend') {
      await act(async () => editable.dispatchEvent(event(name, { data: '' })));
      assert.equal(counts[name], 1, 'React must receive the native composition event, not just ordinary input');
    },
    async paste(text: string) {
      const paste = event('paste', { clipboardData: { files: [], types: ['text/plain'], getData: (type: string) => type === 'text/plain' ? text : '' } });
      await act(async () => editable.dispatchEvent(paste));
      return paste;
    },
    async nativeClearAndClick() {
      await act(async () => { editable.textContent = ''; editable.click(); });
      assert.equal(editable.textContent, '');
    },
    async settleBrief(fail = false) {
      await act(async () => {
        if (fail) pending.reject(new Error('Overview independently unavailable'));
        else pending.resolve({ task: { ...assignment, execution: undefined, status: 'queued' },
          brief: { workId: 'work', actionId: 'action', delegationId: 'delegation', status: 'ok', text: 'Read-only task overview' } });
      });
      assert.equal(view.briefLoading, false); assert.equal(view.briefReady, true);
    },
    async submit(text: string) {
      await act(async () => { document.querySelector('form')!.dispatchEvent(event('submit')); });
      assert.equal(sends.length, 1); assert.equal(sends[0]![1].text, text);
      assert.equal(composer.current?.getText(), ''); assert.equal(this.draft(), '');
      assert.equal(editable.textContent, '');
    },
    assertStable() {
      assert.deepEqual({ overview: counts.overview, history: counts.history, session: counts.session }, { overview: 1, history: 1, session: 1 });
      assert.deepEqual(updateDepth, [], 'React reported a real update-depth loop');
    },
  };
}

test('real task Composer preserves ordinary Unicode input across its draft-sync effect and overview refresh', async t => {
  const h = await mount(t);
  const chunks = ['请编写', ' Unicode CLI，', '处理中文与 emoji 🧪。', '保留 e\u0301 和 <script>。'];
  let text = '';
  for (const chunk of chunks) { text += chunk; await h.input(text); }
  assert.equal(h.writes.length, chunks.length, 'draft synchronization must not write an unchanged draft again');
  for (let index = 0; index < 6; index++) await h.render();
  assert.equal(h.composer.current?.getText(), text); assert.equal(h.writes.length, chunks.length);
  await h.settleBrief();
  assert.equal(h.composer.current?.getText(), text); assert.equal(h.sends.length, 0);
  await h.submit(text); h.assertStable();
});

for (const failure of [false, true]) test(`real task Composer settles composition, native silent clear and full paste before overview ${failure ? 'failure' : 'success'}`, async t => {
  const h = await mount(t);
  await h.composition('compositionstart');
  await h.input('qing Unicode CLI，test', true);
  const composingPaste = await h.paste('未提交的组合文字');
  assert.equal(composingPaste.defaultPrevented, false, 'the real composition guard leaves browser-owned paste alone');
  assert.deepEqual(h.commands, []);
  await h.composition('compositionend');
  await h.nativeClearAndClick();
  assert.equal(h.composer.current?.getText(), 'qing Unicode CLI，test', 'silent AX-like writes do not pretend to emit React input');
  const paste = await h.paste(fullRequirement);
  assert.equal(paste.defaultPrevented, true); assert.deepEqual(h.commands, ['insertHTML']);
  assert.equal(h.composer.current?.getText(), fullRequirement); assert.equal(h.draft(), fullRequirement);
  assert.equal(h.writes.length, 2, 'one composing input and one actual paste publish two draft values');
  await h.render(); await h.settleBrief(failure); await h.render();
  assert.equal(h.composer.current?.getText(), fullRequirement); assert.equal(h.sends.length, 0);
  await h.submit(fullRequirement); h.assertStable();
});
