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
import { applyLiveTurnBufferEvent, reconcileLiveTurnBuffer, settleLiveTurnBufferStep, useUiLocale, type LiveTurnBuffer } from '@maka/ui';
import type { SessionSummary } from '@maka/core/session';
import { chatTurnActivity, type SessionExecutionProjection } from '../../../application/contracts/session-execution.js';
import { createWorkHubTaskViewModel, type WorkHubTaskViewSnapshot } from '../model/task-view-model.js';
import type { WorkHubServices, WorkHubTranscript, WorkHubTranscriptSnapshot } from '../ports.js';

const emptyTranscript: WorkHubTranscriptSnapshot = { messages: [], ready: false, hasOlder: false };
const emptyView: WorkHubTaskViewSnapshot = { assignments: [], historyCursor: null, ready: false, loadingEarlier: false, executions: [], executionsReady: false };
type TaskViewServices = Pick<WorkHubServices, 'taskHistory' | 'taskExecutions' | 'subscribeSessions' | 'subscribeAvailability'>;

export function useWorkHubTaskView(services: TaskViewServices, owner: string | undefined, workId: string | undefined, available = true) {
  const [state, setState] = useState<{ services?: TaskViewServices; owner?: string; workId?: string; value: WorkHubTaskViewSnapshot }>({ value: emptyView });
  const model = useRef<{ services: TaskViewServices; owner: string; workId: string; value: ReturnType<typeof createWorkHubTaskViewModel> }>(undefined);
  const rendered = useRef({ services, owner, workId, available }); rendered.current = { services, owner, workId, available };
  const currentModel = () => {
    const a = model.current, b = rendered.current;
    return a && a.services === services && a.owner === owner && a.workId === workId && b.services === services && b.owner === owner && b.workId === workId ? a.value : undefined;
  };
  useEffect(() => {
    if (!owner || !workId) return;
    const current = createWorkHubTaskViewModel(services, owner, workId);
    model.current = { services, owner, workId, value: current };
    const update = () => setState({ services, owner, workId, value: current.snapshot() });
    update();
    const unsubscribes = [current.subscribe(update),
      services.subscribeSessions(() => { void current.refresh(); }),
      services.subscribeAvailability(() => current.invalidate())];
    void current.refresh();
    return () => {
      current.close();
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (model.current?.value === current) model.current = undefined;
    };
  }, [services, owner, workId]);
  const displayed = state.services === services && state.owner === owner && state.workId === workId ? state.value : emptyView;
  return { ...displayed, ready: available && displayed.ready, currentSnapshot: () => {
    const current = currentModel()?.snapshot() ?? emptyView;
    return available && rendered.current.available ? current : { ...current, ready: false };
  },
    refresh: () => currentModel()?.refresh(), loadEarlier: () => currentModel()?.loadEarlier(),
    selectAssignment: (id: string) => currentModel()?.selectAssignment(id), selectExecution: (id: string) => currentModel()?.selectExecution(id),
    followLatest: () => currentModel()?.followLatest() };
}

/** User-facing full Session history; it is not coordinator context or execution authority. */
export function useWorkHubSessionView(services: Pick<WorkHubServices, 'getTaskSession' | 'observe' | 'openTranscript'>, sessionId: string) {
  const locale = useUiLocale();
  const localeRef = useRef(locale); localeRef.current = locale;
  const [session, setSession] = useState<SessionSummary>();
  const [transcript, setTranscript] = useState(emptyTranscript);
  const transcriptRef = useRef(emptyTranscript);
  const settled = useRef(new Set<string>());
  const [liveTurns, setLiveTurns] = useState<LiveTurnBuffer>();
  const [execution, setExecution] = useState<SessionExecutionProjection>();
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const range = useRef<WorkHubTranscript | undefined>(undefined);
  useEffect(() => {
    const abort = new AbortController();
    let handle: WorkHubTranscript | undefined;
    let phase: 'pending' | 'ready' = 'pending';
    transcriptRef.current = emptyTranscript; settled.current.clear();
    setSession(undefined); setTranscript(emptyTranscript); setLiveTurns(undefined); setExecution(undefined); setReady(false); setError(undefined);
    const report = (reason: unknown) => { if (!abort.signal.aborted) { setReady(false); setError(reason instanceof Error ? reason.message : String(reason)); } };
    void services.getTaskSession(sessionId).then(value => { if (!abort.signal.aborted) setSession(value ?? undefined); }).catch(report);
    const unsubscribe = services.observe(sessionId, event => {
      if (abort.signal.aborted) return;
      setLiveTurns(previous => {
        const next = applyLiveTurnBufferEvent(previous, event, localeRef.current);
        return next ? reconcileLiveTurnBuffer(next, transcriptRef.current.messages) : next;
      });
    }, reason => { phase = 'pending'; handle?.observationChanged(phase); report(reason); }, next => {
      if (abort.signal.aborted) return;
      phase = next; handle?.observationChanged(next); setReady(next === 'ready');
      if (next === 'ready') setError(undefined);
    }, projection => { if (!abort.signal.aborted) setExecution(projection); });
    void services.openTranscript(sessionId, snapshot => {
      if (abort.signal.aborted) return;
      transcriptRef.current = snapshot; setTranscript(snapshot);
      setLiveTurns(previous => {
        let next = previous;
        for (const message of snapshot.messages) {
          if (next && message.type === 'assistant' && settled.current.delete(message.id)) next = settleLiveTurnBufferStep(next, message.id);
        }
        return next ? reconcileLiveTurnBuffer(next, snapshot.messages) : next;
      });
    }, abort.signal, report).then(value => {
      if (abort.signal.aborted) { void value.close(); return; }
      handle = value; range.current = value; value.observationChanged(phase);
    }).catch(report);
    return () => { abort.abort(); unsubscribe(); range.current = undefined; void handle?.close(); };
  }, [services, sessionId]);
  return { session, transcript, liveTurns, activeTurn: chatTurnActivity(execution), ready, error,
    loadEarlier: async () => {
      const handle = range.current;
      try { await handle?.loadEarlier(); }
      catch (reason) { if (handle && range.current === handle) setError(reason instanceof Error ? reason.message : String(reason)); }
    },
    streamingSettled: (stepId: string) => {
      if (!transcriptRef.current.messages.some(message => message.type === 'assistant' && message.id === stepId)) settled.current.add(stepId);
      setLiveTurns(previous => {
        const next = previous ? settleLiveTurnBufferStep(previous, stepId) : previous;
        return next ? reconcileLiveTurnBuffer(next, transcriptRef.current.messages) : next;
      });
    } };
}
