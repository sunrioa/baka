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
import type { InteractionAnswer, WorkHubPendingInteraction, WorkHubInteractionsQueryResult } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';

const empty: WorkHubInteractionsQueryResult = { requests: [], truncated: false };
const emptyWorkIds: ReadonlyMap<string, string> = new Map();
const assignmentKey = (item: WorkHubPendingInteraction) => JSON.stringify([item.actionId, item.delegationId]);
export function useWorkHubTaskInbox(services: WorkHubServices, sessionId: string | undefined) {
  const current = useRef(sessionId);
  current.current = sessionId;
  const [state, setState] = useState<{ sessionId?: string; data: WorkHubInteractionsQueryResult; workIds: ReadonlyMap<string, string>; ready: boolean; error?: string }>({ data: empty, workIds: emptyWorkIds, ready: false });
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const generation = useRef(0);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const displayed = state.sessionId === sessionId ? state : { data: empty, workIds: emptyWorkIds, ready: false };
  const latest = useRef(displayed); latest.current = displayed;
  const renderedGeneration = generation.current;

  useEffect(() => {
    ++generation.current;
    let disposed = false;
    let revision = 0;
    setState({ sessionId, data: empty, workIds: emptyWorkIds, ready: false });
    setAnswering(new Set());
    inFlight.current.clear();
    if (!sessionId) return;
    let reading: Promise<void> | undefined;
    let dirty = false;
    function read(): Promise<void> {
      dirty = true;
      ++revision;
      if (reading) return reading;
      // Catalog/interaction bursts invalidate one in-flight read; never start
      // an unbounded number of Host queries for the same inbox.
      const pending = (async () => {
        while (dirty && !disposed) {
          dirty = false;
          const readRevision = revision;
          try {
            const data = await services.queryTaskInteractions(sessionId!);
            if (disposed || readRevision !== revision) continue;
            // Exact canonical ownership is independent of the reader's history
            // page. Resolve once per source in this refresh, retaining the
            // original request objects and the existing answer lifecycle.
            const sources = new Map<string, Promise<string>>();
            for (const item of data.requests) {
              const key = assignmentKey(item);
              if (!sources.has(key)) sources.set(key, (async () => {
                const { task } = await services.readTask(sessionId!, { actionId: item.actionId, delegationId: item.delegationId });
                // The Host inbox already proves child-run ancestry. Its original
                // child snapshot need not share the task's root Session.
                if (task.actionId !== item.actionId || task.delegationId !== item.delegationId)
                  throw new Error('The original task request changed identity');
                return task.workId ?? task.actionId;
              })());
            }
            const workIds = new Map(await Promise.all([...sources].map(async ([key, source]) => [key, await source] as const)));
            if (!disposed && readRevision === revision) setState({ sessionId, data, workIds, ready: true });
          } catch (reason) {
            if (!disposed && readRevision === revision) setState((previous) => ({
              ...previous, sessionId, ready: false, error: reason instanceof Error ? reason.message : String(reason),
            }));
          }
        }
      })().finally(() => { if (reading === pending) reading = undefined; });
      reading = pending;
      return pending;
    }
    function invalidate() {
      ++generation.current;
      inFlight.current.clear();
      setAnswering(new Set());
      ++revision;
      setState({ sessionId, data: empty, workIds: emptyWorkIds, ready: false });
      void read();
    }
    refresh.current = read;
    const unsubscribes = [
      services.subscribeSessions(() => { void read(); }),
      services.subscribeActiveInteractions(() => { void read(); }),
      services.subscribeAvailability(invalidate),
    ];
    void read();
    return () => {
      ++generation.current;
      disposed = true;
      ++revision;
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (refresh.current === read) refresh.current = async () => {};
    };
  }, [services, sessionId]);

  async function respond(item: WorkHubPendingInteraction, answer: InteractionAnswer) {
    const owner = sessionId;
    const contextGeneration = generation.current;
    const { interaction } = item;
    const key = JSON.stringify([owner, interaction.interactionId, interaction.runId]);
    if (!owner || current.current !== owner || renderedGeneration !== generation.current || latest.current !== displayed || !displayed.ready ||
        !displayed.data.requests.some((pending) => pending === item)) throw new Error('The original task request is unavailable');
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setAnswering(new Set(inFlight.current));
    try {
      await services.answerTaskInteraction(owner, {
        actionId: item.actionId, interactionId: interaction.interactionId,
        expectedTurnId: interaction.turnId, expectedRunId: interaction.runId, answer,
      });
    } finally {
      // A failed/lost receipt is not proof the answer failed. Rebuild from the
      // original Host; never optimistically remove a request or replay it.
      if (current.current === owner && generation.current === contextGeneration) {
        await refresh.current();
        if (current.current === owner && generation.current === contextGeneration) {
          inFlight.current.delete(key);
          setAnswering(new Set(inFlight.current));
        }
      }
    }
  }
  return {
    ...displayed.data, ready: displayed.ready, error: displayed.error, respond,
    requestsForWork: (workId: string) => displayed.data.requests.filter(item => displayed.workIds.get(assignmentKey(item)) === workId),
    refresh: () => refresh.current(),
    isAnswering: (item: WorkHubPendingInteraction) => answering.has(JSON.stringify([sessionId, item.interaction.interactionId, item.interaction.runId])),
  };
}
