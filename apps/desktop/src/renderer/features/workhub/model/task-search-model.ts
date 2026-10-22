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

import type { WorkHubTaskFindItem, WorkHubTaskFindResult, WorkHubTasksQueryResult } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';
import { orderWorkHubTasks } from './task-presentation.js';

interface TaskSearchSnapshot {
  readonly mode: 'indexed' | 'recent_only' | 'index_not_authorized';
  readonly items: readonly WorkHubTaskFindItem[];
  readonly recent?: WorkHubTasksQueryResult;
  readonly cursor: string | null;
  readonly match?: WorkHubTaskFindResult['match'];
  readonly ready: boolean;
  readonly loadingMore: boolean;
  readonly error?: string;
}

/** One query and its loaded pages only. Preview selection is never an input to discovery. */
export function createWorkHubTaskSearchModel(services: Pick<WorkHubServices, 'findTasks'>, owner: string, query: string) {
  let state: TaskSearchSnapshot = { mode: 'indexed', items: [], cursor: null, ready: false, loadingMore: false };
  let closed = false;
  let version = 0;
  let reading: Promise<void> | undefined;
  let dirty = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<TaskSearchSnapshot>) => {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const input = query.trim() ? { query: query.trim() } : {};
  const taskItems = (page: WorkHubTaskFindResult) => page.items.filter(item => item.kind === 'task');
  const present = (items: readonly WorkHubTaskFindItem[]) => query.trim() ? [...items] : orderWorkHubTasks(items);
  const fail = (reason: unknown) => publish({ error: reason instanceof Error ? reason.message : String(reason) });
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    dirty = true;
    ++version;
    if (reading) return reading;
    const pending = (async () => {
      while (dirty && !closed) {
        dirty = false;
        const generation = version;
        try {
          const page = await services.findTasks(owner, input);
          if (closed || generation !== version) continue;
          if ('kind' in page) {
            if (page.kind === 'recent_only' && query.trim()) throw new Error('Recent tasks cannot answer an indexed search');
            publish({ mode: page.kind, recent: page.kind === 'recent_only' ? page.result : undefined,
              items: [], cursor: null, match: undefined, ready: true, loadingMore: false, error: undefined });
          } else {
            publish({ mode: 'indexed', recent: undefined, items: present(taskItems(page)), cursor: page.nextCursor, match: page.match, ready: true, loadingMore: false, error: undefined });
          }
        } catch (reason) {
          if (!closed && generation === version) { publish({ ready: false, loadingMore: false }); fail(reason); }
        }
      }
    })().finally(() => { if (reading === pending) reading = undefined; });
    reading = pending;
    return pending;
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    invalidate() { ++version; publish({ ready: false }); void refresh(); },
    async loadMore() {
      if (closed || !state.ready || state.mode !== 'indexed' || state.loadingMore || !state.cursor) return;
      const generation = version, cursor = state.cursor;
      publish({ loadingMore: true });
      try {
        const page = await services.findTasks(owner, { ...input, cursor });
        if (closed || generation !== version) return;
        if ('kind' in page) {
          if (page.kind === 'recent_only') throw new Error('Recent tasks cannot answer an indexed page');
          publish({ mode: page.kind, items: [], recent: undefined, cursor: null, match: undefined, error: undefined });
          return;
        }
        if (page.nextCursor === cursor) throw new Error('Task search did not advance');
        const items = new Map(state.items.map(item => [item.id, item]));
        for (const item of taskItems(page)) items.set(item.id, item);
        publish({ items: present([...items.values()]), cursor: page.nextCursor, match: page.match, error: undefined });
      } catch (reason) { if (!closed && generation === version) fail(reason); }
      finally { if (!closed && generation === version) publish({ loadingMore: false }); }
    },
    close() { closed = true; ++version; listeners.clear(); },
  };
}
