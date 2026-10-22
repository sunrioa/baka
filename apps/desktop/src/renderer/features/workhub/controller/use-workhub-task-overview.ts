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
import type { WorkHubTasksQueryResult } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';

const empty: WorkHubTasksQueryResult = { tasks: [], truncated: false };
export function useWorkHubTaskOverview(services: WorkHubServices, sessionId: string | undefined) {
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const [state, setState] = useState<{ owner?: string; data: WorkHubTasksQueryResult; ready: boolean; error?: string }>({ data: empty, ready: false });
  const displayed = state.owner === sessionId ? state : { data: empty, ready: false };
  useEffect(() => {
    ++generation.current;
    let disposed = false;
    let revision = 0;
    let reading: Promise<void> | undefined;
    let dirty = false;
    setState({ owner: sessionId, data: empty, ready: false });
    if (!sessionId) return;
    function read(): Promise<void> {
      dirty = true; ++revision;
      if (reading) return reading;
      const pending = (async () => {
        while (dirty && !disposed) {
          dirty = false;
          const version = revision;
          try {
            const data = await services.queryTasks(sessionId!);
            if (!disposed && version === revision) setState({ owner: sessionId, data, ready: true });
          } catch (reason) {
            if (!disposed && version === revision) setState(previous => ({ owner: sessionId, data: previous.owner === sessionId ? previous.data : empty, ready: false, error: reason instanceof Error ? reason.message : String(reason) }));
          }
        }
      })().finally(() => { if (reading === pending) reading = undefined; });
      reading = pending;
      return pending;
    }
    refresh.current = read;
    const invalidate = () => {
      ++generation.current; ++revision;
      // Keep presentation mounted, but remove stale projection authority
      // until the same Host has supplied a fresh projection.
      setState(previous => ({ owner: sessionId, data: previous.owner === sessionId ? previous.data : empty, ready: false }));
      void read();
    };
    const unsubscribes = [services.subscribeSessions(() => { void read(); }), services.subscribeActiveInteractions(() => { void read(); }), services.subscribeAvailability(invalidate)];
    void read();
    return () => {
      disposed = true; ++generation.current; ++revision;
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (refresh.current === read) refresh.current = async () => {};
    };
  }, [services, sessionId]);

  return {
    ...displayed.data, ready: displayed.ready, error: displayed.error, generation: generation.current,
    refresh: () => refresh.current(),
  };
}
