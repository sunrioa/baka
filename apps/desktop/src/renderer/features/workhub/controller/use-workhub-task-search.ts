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

import { useEffect, useRef, useState } from 'react';
import type { WorkHubServices } from '../ports.js';
import { createWorkHubTaskSearchModel } from '../model/task-search-model.js';

export function useWorkHubTaskSearch(services: WorkHubServices, owner: string, available: boolean) {
  const [query, setQuery] = useState('');
  type Model = ReturnType<typeof createWorkHubTaskSearchModel>;
  const [state, setState] = useState<{ services?: WorkHubServices; owner?: string; query?: string; value?: ReturnType<Model['snapshot']> }>({});
  const model = useRef<{ services: WorkHubServices; owner: string; query: string; value: Model }>(undefined);
  const rendered = useRef({ services, owner, query, available }); rendered.current = { services, owner, query, available };
  useEffect(() => {
    if (!available) return;
    const current = createWorkHubTaskSearchModel(services, owner, query);
    model.current = { services, owner, query, value: current };
    const update = () => setState({ services, owner, query, value: current.snapshot() });
    update();
    const unsubscribes = [current.subscribe(update), services.subscribeSessions(() => { void current.refresh(); }), services.subscribeActiveInteractions(() => { void current.refresh(); }), services.subscribeAvailability(current.invalidate)];
    void current.refresh();
    return () => { current.close(); for (const unsubscribe of unsubscribes) unsubscribe(); if (model.current?.value === current) model.current = undefined; };
  }, [services, owner, query, available]);
  const current = () => {
    const a = model.current, b = rendered.current;
    return a && a.services === services && a.owner === owner && a.query === query && b.services === services && b.owner === owner && b.query === query && b.available ? a.value : undefined;
  };
  const value = state.services === services && state.owner === owner && state.query === query ? state.value : undefined;
  return { items: value?.items ?? [], cursor: value?.cursor ?? null, match: value?.match ?? 'recent', error: value?.error,
    ready: available && Boolean(value?.ready), loadingMore: Boolean(value?.loadingMore), query, setQuery: (text: string) => setQuery(Array.from(text).slice(0, 256).join('')),
    refresh: async () => { await current()?.refresh(); }, loadMore: async () => { await current()?.loadMore(); } };
}
