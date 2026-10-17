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

const commonJs = createRequire(import.meta.url)('virtua') as { Virtualizer: typeof Virtualizer };

// Exercise the dependency's native observer path through both shipped public
// entry points. Chromium stories separately establish real scroll geometry.
for (const [name, Component] of [['ESM', Virtualizer], ['CJS', commonJs.Virtualizer]] as const) {
  test(`${name}: resize updates viewport and rows, and detach removes targets`, async () => {
    const dom = installTranscriptDom();
    const observers: NativeObserver[] = [];
    class NativeObserver {
      readonly targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    }
    Object.assign(globalThis, { ResizeObserver: NativeObserver });
    Object.assign(dom.window, { ResizeObserver: NativeObserver });
    const handle = createRef<VirtualizerHandle>(), scroll = createRef<HTMLDivElement>();
    const notify = async (target: Element, height: number) => {
      const observer = observers.find(o => o.targets.has(target));
      assert.ok(observer);
      await act(() => observer.callback([
        { target, contentRect: { width: 800, height } } as ResizeObserverEntry,
      ], observer as unknown as ResizeObserver));
    };
    try {
      await dom.render(<div ref={scroll}><Component ref={handle} scrollRef={scroll} data={[1, 2, 3]}>
        {id => <div key={id}>{id}</div>}
      </Component></div>);
      await notify(scroll.current!, 200);
      const rows = [...observers[0]!.targets].filter(target => target !== scroll.current);
      assert.equal(rows.length, 3);
      await notify(rows[0]!, 40.5);
      await notify(rows[1]!, 50.25);
      assert.equal(handle.current!.viewportSize, 200);
      assert.equal(handle.current!.getItemSize(0), 40.5);
      assert.equal(handle.current!.getItemSize(1), 50.25);
      await notify(scroll.current!, 300);
      assert.equal(handle.current!.viewportSize, 300);
      await dom.render(<></>);
      assert.ok(observers.every(observer => observer.targets.size === 0));
    } finally { await dom.cleanup(); }
  });
}
