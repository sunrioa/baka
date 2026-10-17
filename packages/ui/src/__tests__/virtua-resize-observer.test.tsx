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
import test from 'node:test';
import { act, createRef } from 'react';
import { Virtualizer, type VirtualizerHandle } from 'virtua';
import { installTranscriptDom } from './transcript-test-dom.js';

// Public-component tests of the installed dependency patch, for both shipped
// entry points. Chromium stories separately protect actual scroll geometry.
const commonJs = createRequire(import.meta.url)('virtua') as { Virtualizer: typeof Virtualizer };

function installResizeHarness() {
  const dom = installTranscriptDom();
  const frames = new Map<number, FrameRequestCallback>();
  const observers: NativeObserver[] = [];
  let nextFrame = 0;
  class NativeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
    observe(target: Element) { this.targets.add(target); }
    unobserve(target: Element) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const schedule = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  };
  const cancel = (id: number) => { frames.delete(id); };
  Object.assign(globalThis, { ResizeObserver: NativeObserver, requestAnimationFrame: schedule, cancelAnimationFrame: cancel });
  Object.assign(dom.window, { ResizeObserver: NativeObserver, requestAnimationFrame: schedule, cancelAnimationFrame: cancel });
  return {
    ...dom,
    frames,
    observers,
    notify(target: Element, height: number, read?: () => void) {
      const observer = observers.find(candidate => candidate.targets.has(target));
      assert.ok(observer, 'the real virtualizer must observe this element');
      observer.callback([{
        target,
        get contentRect() { read?.(); return { width: 800, height }; },
      } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    },
    async frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      await act(() => { for (const callback of callbacks) callback(performance.now()); });
    },
  };
}

for (const [name, Component] of [['ESM', Virtualizer], ['CJS', commonJs.Virtualizer]] as const) {
  test(`${name}: DOM commits measure before paint without replaying a stale native batch`, async () => {
    const dom = installResizeHarness();
    const handle = createRef<VirtualizerHandle>();
    const scroll = createRef<HTMLDivElement>();
    let viewportHeight = 200.5, rowHeight = 40.5;
    let measurements = 0;
    Object.assign(dom.window, {
      getComputedStyle: (target: Element) => { measurements++; return target === scroll.current ? {
        width: '800.25px', height: `${viewportHeight}px`, boxSizing: 'border-box',
        paddingLeft: '10.25px', paddingRight: '10.25px', paddingTop: '5.25px', paddingBottom: '5.25px',
        borderLeftWidth: '1px', borderRightWidth: '1px', borderTopWidth: '1px', borderBottomWidth: '1px',
      } : { width: '700.25px', height: `${rowHeight}px`, boxSizing: 'content-box' }; },
    });
    try {
      await dom.render(<div ref={scroll}><Component ref={handle} scrollRef={scroll} data={[1, 2]}>{id => <div>{id}</div>}</Component></div>);
      assert.equal(handle.current!.viewportSize, 188, 'border-box padding and borders are not viewport content');
      assert.equal(handle.current!.getItemSize(0), 40.5);
      assert.equal(dom.frames.size, 0, 'the initial DOM commit must not wait an extra paint');
      dom.notify(scroll.current!, 188);
      assert.equal(dom.frames.size, 1);
      viewportHeight = 400.5; rowHeight = 80.5;
      // Use LinkeDOM's actual MutationObserver rather than replacing its
      // special window accessor: the public component must see the DOM commit.
      await act(async () => { scroll.current!.setAttribute('style', 'height:400.5px'); });
      assert.equal(handle.current!.viewportSize, 388);
      assert.equal(handle.current!.getItemSize(0), 80.5);
      assert.equal(dom.frames.size, 0, 'fresh DOM measurements cancel a pending old native delivery');
      await dom.frame();
      assert.equal(handle.current!.viewportSize, 388, 'an old native rectangle must not undo the current commit');
      const oldRoot = scroll.current!;
      await dom.render(<></>);
      const readsAfterUnmount = measurements;
      await act(async () => { oldRoot.setAttribute('style', 'height:600px'); });
      assert.equal(measurements, readsAfterUnmount, 'unmount disconnects DOM commit measurement too');
    } finally { await dom.cleanup(); }
  });

  test(`${name}: virtualizer defers and coalesces resize delivery outside the observer cycle`, async () => {
    const dom = installResizeHarness();
    const handle = createRef<VirtualizerHandle>();
    const scroll = createRef<HTMLDivElement>();
    try {
      await dom.render(<div ref={scroll}><Component ref={handle} scrollRef={scroll} data={[1, 2, 3]}>
        {id => <div key={id}>{id}</div>}
      </Component></div>);
      assert.ok(scroll.current);
      assert.ok(handle.current);
      dom.notify(scroll.current, 100);
      dom.notify(scroll.current, 200);
      assert.equal(handle.current.viewportSize, 0, 'ResizeObserver delivery must not synchronously reflow the list');
      assert.equal(dom.frames.size, 1, 'one frame owns all notifications for this virtualizer');
      await dom.frame();
      assert.equal(handle.current.viewportSize, 200, 'the newest measurement wins');
      const rows = [...dom.observers[0]!.targets].filter(target => target !== scroll.current);
      assert.equal(rows.length, 3);
      dom.notify(rows[0]!, 40);
      dom.notify(rows[1]!, 50);
      dom.notify(rows[0]!, 60);
      await dom.frame();
      assert.equal(handle.current.getItemSize(0), 60);
      assert.equal(handle.current.getItemSize(1), 50, 'coalescing retains other rows, not just the last batch');
    } finally { await dom.cleanup(); }
  });

  test(`${name}: unobserved rows discard queued measurements`, async () => {
    const dom = installResizeHarness();
    const handle = createRef<VirtualizerHandle>();
    const scroll = createRef<HTMLDivElement>();
    const render = (data: number[]) => dom.render(<div ref={scroll}><Component ref={handle} scrollRef={scroll} data={data}>
      {id => <div key={id}>{id}</div>}
    </Component></div>);
    try {
      await render([1, 2, 3]);
      dom.notify(scroll.current!, 200);
      await dom.frame();
      const row = [...dom.observers[0]!.targets].find(target => target !== scroll.current)!;
      let reads = 0;
      dom.notify(row, 700, () => { reads++; });
      await render([3]);
      assert.equal(dom.observers[0]!.targets.has(row), false);
      await dom.frame();
      assert.equal(reads, 0, 'a removed row must not resize its former index after reuse');
    } finally { await dom.cleanup(); }
  });

  test(`${name}: unmount cancels pending resize work, including frame id zero`, async () => {
    const dom = installResizeHarness();
    const scroll = createRef<HTMLDivElement>();
    try {
      await dom.render(<div ref={scroll}><Component scrollRef={scroll}><div>row</div></Component></div>);
      dom.notify(scroll.current!, 200);
      assert.equal(dom.frames.has(0), true);
      await dom.render(<></>);
      assert.equal(dom.frames.size, 0, 'disconnect must cancel the pending animation frame');
      assert.equal(dom.observers[0]!.targets.size, 0);
      await dom.frame();
    } finally { await dom.cleanup(); }
  });
}
