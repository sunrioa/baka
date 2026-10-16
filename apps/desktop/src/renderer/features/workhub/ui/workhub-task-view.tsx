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

import { useMemo } from 'react';
import { Button, ChatView, useUiLocale } from '@maka/ui';
import { ChevronDown, FileText, RefreshCw } from 'lucide-react';
import type { WorkHubServices } from '../ports.js';
import { useWorkHubSessionView, type useWorkHubTaskView } from '../controller/use-workhub-task-view.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';

export function WorkHubTaskView({ services, workId, name, view }: {
  services: WorkHubServices; owner: string; workId: string; name: string; view: ReturnType<typeof useWorkHubTaskView>;
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
  const execution = view.executions.find(item => item.turnId === view.execution?.turnId && item.runId === view.execution.runId);
  const status = execution?.status ?? view.assignment?.state;
  return <section className="workHubTaskView" aria-label={copy.title} data-work-id={workId}>
    <header className="workHubTaskViewHeader">
      <div className="workHubTaskHeadingRow">
        <p className="workHubTaskEyebrow">{copy.title}</p>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} label={copy.refresh} onClick={() => { void view.refresh(); }} />
      </div>
      <div className="workHubTaskTitleRow">
        <div><h2>{name}</h2></div>
        <span className="workHubTaskStatusBadge" data-status={status} role="status">
          {execution ? copy.status[execution.status] : view.assignment ? copy.state[view.assignment.state] : copy.loading}
        </span>
      </div>
      <p className="workHubTaskViewDescription">{copy.description}</p>
      {view.assignment && <details className="workHubTaskInstructions">
        <summary><FileText size={15} aria-hidden="true" /><span>{copy.source}</span><ChevronDown size={14} aria-hidden="true" /></summary>
        <p className="workHubTaskSource">{view.assignment.text}</p>
      </details>}
    </header>
    {view.error && <p role="alert">{view.error}</p>}
    {!view.ready && <p role="status">{copy.loading}</p>}
    {view.ready && !view.assignments.length && <p role="status">{copy.noAssignments}</p>}
    {view.historyCursor && <Button size="sm" variant="ghost" label={copy.loadEarlier} isDisabled={view.loadingEarlier} onClick={() => { void view.loadEarlier(); }} />}
    {sessions.map(([sessionId, sessionName], index) => <WorkHubSessionTranscript key={sessionId}
      services={services} sessionId={sessionId} name={sessionName} scrollOwner={index === sessions.length - 1} />)}
  </section>;
}

function WorkHubSessionTranscript({ services, sessionId, name, scrollOwner }: { services: WorkHubServices; sessionId: string; name: string; scrollOwner: boolean }) {
  const locale = useUiLocale();
  const copy = workHubTaskViewCopy[locale];
  const view = useWorkHubSessionView(services, sessionId);
  const deriveTurnPresentation = useAppShellTurnPresentation({ uiLocale: locale, allowBranch: false });
  return <section className="workHubExecutionTranscript" data-task-session-id={sessionId} aria-label={name}>
    <div className="workHubTaskSessionLabel"><span>{name}</span><code title={sessionId}>Session · {parseDesktopSessionKey(sessionId).sessionId.slice(-8)}</code></div>
    {view.error && <p role="alert">{view.error}</p>}
    {(!view.ready || !view.transcript.ready) && <p role="status">{copy.livePending}</p>}
    {/* Settle the first scroll position from real history, not an empty reader
        whose already-visible list would jump when the initial batch arrives. */}
    {view.transcript.ready && <ChatView activeSession={view.session} messages={[...view.transcript.messages]} liveTurns={view.liveTurns} activeTurn={view.activeTurn}
      scrollOwner={scrollOwner} messageLoading={!view.transcript.ready} hasEarlierHistory={view.transcript.hasOlder}
      onLoadEarlierHistory={() => { void view.loadEarlier(); }} onStreamingSettled={view.streamingSettled}
      onReadAttachmentBytes={services.readAttachmentBytes} deriveTurnPresentation={deriveTurnPresentation}
      onNew={() => {}} scrollBehavior="auto" emptyOverride={<p>{copy.noPublicOutput}</p>} />}
  </section>;
}
