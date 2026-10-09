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
import type { WorkHubTasksQueryResult, WorkHubTask, WorkHubTaskDetail, WorkHubTaskContinueInput } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';

const empty: WorkHubTasksQueryResult = { tasks: [], truncated: false };
export function useWorkHubTaskOverview(services: WorkHubServices, sessionId: string | undefined) {
  const current = useRef(sessionId);
  current.current = sessionId;
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const [state, setState] = useState<{ owner?: string; data: WorkHubTasksQueryResult; ready: boolean; error?: string }>({ data: empty, ready: false });
  const attempts = useRef(new Map<string, WorkHubTaskContinueInput>());
  const inFlight = useRef(new Map<string, WorkHubTaskContinueInput>());
  const [drafts, setDrafts] = useState(new Map<string, string>());
  const retainedOwner = useRef<{ services: WorkHubServices; owner?: string }>({ services });
  const displayed = state.owner === sessionId ? state : { data: empty, ready: false };
  const renderedGeneration = generation.current;
  const liveProjection = useRef(displayed);
  liveProjection.current = displayed;
  useEffect(() => {
    ++generation.current;
    let disposed = false;
    let revision = 0;
    let reading: Promise<void> | undefined;
    let dirty = false;
    setState({ owner: sessionId, data: empty, ready: false });
    // Same-Host re-resolution remounts task cards. Keep both unsent drafts and
    // unknown submissions here; a different Host or bridge cannot inherit them.
    if (retainedOwner.current.services !== services || (sessionId && retainedOwner.current.owner && retainedOwner.current.owner !== sessionId)) {
      attempts.current.clear(); inFlight.current.clear();
      setDrafts(new Map());
    }
    retainedOwner.current = { services, owner: sessionId ?? retainedOwner.current.owner };
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
      // Keep presentation and unsent drafts mounted, but remove all authority
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

  function requireTask(task: WorkHubTask) {
    if (!sessionId || current.current !== sessionId || renderedGeneration !== generation.current || !liveProjection.current.ready ||
        !liveProjection.current.data.tasks.some(t => t.actionId === task.actionId && t.delegationId === task.delegationId && t.targetSessionId === task.targetSessionId))
      throw new Error('The original task is unavailable; refresh WorkHub');
    return { owner: sessionId, epoch: generation.current };
  }
  function continuationKey(task: WorkHubTask) {
    if (!sessionId || current.current !== sessionId || retainedOwner.current.services !== services) return undefined;
    return JSON.stringify([sessionId, task.actionId, task.delegationId]);
  }
  return {
    ...displayed.data, ready: displayed.ready, error: displayed.error, generation: generation.current,
    refresh: () => refresh.current(),
    continuationDraft: (task: WorkHubTask) => {
      const key = continuationKey(task);
      return key ? attempts.current.get(key)?.text ?? drafts.get(key) ?? '' : '';
    },
    setContinuationDraft: (task: WorkHubTask, text: string) => {
      const key = continuationKey(task);
      if (!key || renderedGeneration !== generation.current || attempts.current.has(key)) return;
      setDrafts(previous => {
        const next = new Map(previous);
        if (text) next.set(key, text); else next.delete(key);
        return next;
      });
    },
    pendingContinuation: (task: WorkHubTask) => sessionId ? attempts.current.get(JSON.stringify([sessionId, task.actionId, task.delegationId])) : undefined,
    async read(task: WorkHubTask): Promise<WorkHubTaskDetail | undefined> {
      const { owner, epoch } = requireTask(task);
      const result = await services.readTask(owner, { actionId: task.actionId, delegationId: task.delegationId });
      if (current.current !== owner || epoch !== generation.current) return undefined;
      if (result.task.actionId !== task.actionId || result.task.delegationId !== task.delegationId || result.task.targetSessionId !== task.targetSessionId) throw new Error('The task detail changed identity');
      return result;
    },
    async continue(task: WorkHubTask, text: string) {
      const { owner, epoch } = requireTask(task);
      const key = JSON.stringify([owner, task.actionId, task.delegationId]);
      if (inFlight.current.has(key)) return false;
      let input = attempts.current.get(key);
      if (input && input.text !== text) throw new Error('Resolve the original continuation before changing its text');
      input ??= { actionId: task.actionId, delegationId: task.delegationId, turnId: crypto.randomUUID(), text };
      attempts.current.set(key, input); inFlight.current.set(key, input);
      try {
        const result = await services.continueTask(owner, input);
        if (current.current !== owner || epoch !== generation.current) return false;
        if (result.disposition !== 'delegate_existing' || result.targetSessionId !== task.targetSessionId) throw new Error('The continuation changed its target');
        attempts.current.delete(key);
        setDrafts(previous => { const next = new Map(previous); next.delete(key); return next; });
        // A read failure after a confirmed admission cannot turn it back into
        // an unknown send and invite a second delegation.
        void refresh.current();
        return true;
      } finally { if (inFlight.current.get(key) === input) inFlight.current.delete(key); }
    },
  };
}
