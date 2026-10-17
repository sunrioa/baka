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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ChatView, useUiLocale } from '@maka/ui';
import type { WorkHubServices } from '../ports.js';
import { useWorkHubSessionView, type useWorkHubTaskView } from '../controller/use-workhub-task-view.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';

export function WorkHubTaskView({ services, workId, name, view, onReady }: {
  services: WorkHubServices; owner: string; workId: string; name: string; view: ReturnType<typeof useWorkHubTaskView>; onReady?(): void;
}) {
  const copy = workHubTaskViewCopy[useUiLocale()];
  const sessions = useMemo(() => {
    const result = new Map<string, string>();
    // Canonical assignments are newest first. Keep each Session's complete
    // conversation once, including intervening work. Its most recent
    // assignment determines section order, so the current target is the tail.
    for (const assignment of [...view.assignments].reverse()) {
      result.delete(assignment.targetSessionId);
      result.set(assignment.targetSessionId, assignment.targetSessionName);
    }
    return [...result];
  }, [view.assignments]);
  const [placed, setPlaced] = useState<ReadonlySet<string>>(() => new Set());
  const sessionPlaced = useCallback((id: string) => setPlaced(previous => previous.has(id) ? previous : new Set([...previous, id])), []);
  useEffect(() => {
    if (view.error || (view.ready && sessions.every(([id]) => placed.has(id)))) onReady?.();
  }, [view.error, view.ready, sessions, placed, onReady]);
  const execution = view.executions.find(item => item.turnId === view.execution?.turnId && item.runId === view.execution.runId);
  const status = execution?.status ?? view.assignment?.state;
  return <section className="workHubTaskView" aria-label={copy.title} data-work-id={workId}>
    <span className="maka-visually-hidden" data-status={status} role="status">
      {execution ? copy.status[execution.status] : view.assignment ? copy.state[view.assignment.state] : copy.loading}
    </span>
    {view.error && <div role="alert">{view.error}<Button size="sm" variant="ghost" label={copy.refresh} onClick={() => { void view.refresh(); }} /></div>}
    {!view.ready && <p role="status">{copy.loading}</p>}
    {view.ready && !view.assignments.length && <p role="status">{copy.noAssignments}</p>}
    {view.historyCursor && <Button size="sm" variant="ghost" label={copy.loadEarlier} isDisabled={view.loadingEarlier} onClick={() => { void view.loadEarlier(); }} />}
    {sessions.map(([sessionId, sessionName], index) => <WorkHubSessionTranscript key={sessionId}
      services={services} sessionId={sessionId} name={sessionName} scrollOwner={index === sessions.length - 1} onReady={sessionPlaced} />)}
  </section>;
}

function WorkHubSessionTranscript({ services, sessionId, name, scrollOwner, onReady }: { services: WorkHubServices; sessionId: string; name: string; scrollOwner: boolean; onReady(id: string): void }) {
  const locale = useUiLocale();
  const copy = workHubTaskViewCopy[locale];
  const view = useWorkHubSessionView(services, sessionId);
  const deriveTurnPresentation = useAppShellTurnPresentation({ uiLocale: locale, allowBranch: false });
  const positioned = useCallback(() => onReady(sessionId), [onReady, sessionId]);
  const ready = view.ready && view.sessionReady && view.transcript.ready;
  useEffect(() => { if (view.error || (ready && !view.session)) positioned(); }, [view.error, ready, view.session, positioned]);
  return <section className="workHubExecutionTranscript" data-task-session-id={sessionId} aria-label={name}>
    <div className="workHubTaskSessionLabel"><span>{name}</span><code title={sessionId}>Session · {parseDesktopSessionKey(sessionId).sessionId.slice(-8)}</code></div>
    {view.error && <p role="alert">{view.error}</p>}
    {!ready && <p role="status">{copy.livePending}</p>}
    {/* Settle the first scroll position from real history, not an empty reader
        whose already-visible list would jump when the initial batch arrives. */}
    {ready && view.session && <ChatView activeSession={view.session} messages={[...view.transcript.messages]} liveTurns={view.liveTurns} activeTurn={view.activeTurn}
      onInitialPositioned={positioned}
      scrollOwner={scrollOwner} messageLoading={!view.transcript.ready} hasEarlierHistory={view.transcript.hasOlder}
      onLoadEarlierHistory={() => { void view.loadEarlier(); }} onStreamingSettled={view.streamingSettled}
      onReadAttachmentBytes={services.readAttachmentBytes} deriveTurnPresentation={deriveTurnPresentation}
      onNew={() => {}} scrollBehavior="auto" emptyOverride={<p>{copy.noPublicOutput}</p>} />}
    {ready && !view.session && <p role="status">{copy.noPublicOutput}</p>}
  </section>;
}
