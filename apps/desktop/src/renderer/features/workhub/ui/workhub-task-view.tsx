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
import type { SessionExecutionScope, WorkHubTaskAssignment } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../ports.js';
import { useWorkHubExecutionView, type useWorkHubTaskView } from '../controller/use-workhub-task-view.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';
import { formatUiMessage } from '@maka/core/ui-locale';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';

export function WorkHubTaskView({ services, owner, workId, name, view, onClose }: {
  services: WorkHubServices; owner: string; workId: string; name: string; view: ReturnType<typeof useWorkHubTaskView>; onClose(): void;
}) {
  const locale = useUiLocale();
  const copy = workHubTaskViewCopy[locale];
  const groups = useMemo(() => {
    const result = new Map<string, WorkHubTaskAssignment[]>();
    for (const assignment of view.assignments) {
      const rows = result.get(assignment.generationId) ?? [];
      rows.push(assignment); result.set(assignment.generationId, rows);
    }
    return [...result];
  }, [view.assignments]);
  const stateLabel = (state: WorkHubTaskAssignment['state']) => copy.state[state];
  return <section className="workHubTaskView" aria-label={copy.title} data-work-id={workId}>
    <header className="workHubTaskViewHeader">
      <div><h2>{name}</h2><p>{copy.description}</p></div>
      <Button size="sm" variant="ghost" label={copy.back} onClick={onClose} />
    </header>
    <div className="workHubTaskViewActions">
      <Button size="sm" variant="ghost" label={copy.follow} onClick={view.followLatest} />
      <Button size="sm" variant="ghost" label={copy.refresh} onClick={() => { void view.refresh(); }} />
    </div>
    {view.error && <p role="alert">{view.error}</p>}
    {!view.ready && <p role="status">{copy.loading}</p>}
    <details className="workHubTaskAttempts" open>
      <summary>{copy.attempts}</summary>
      {groups.map(([generationId, rows], index) => <section key={generationId} data-work-generation={generationId}>
        <h3>{index === 0 ? copy.currentGeneration : copy.earlierGeneration}</h3>
        {rows.map(assignment => <Button key={assignment.actionId} size="sm" variant="ghost" className="workHubTaskAttempt"
          label={`${assignment.targetSessionName} · ${stateLabel(assignment.state)}${assignment.superseded ? ` · ${copy.superseded}` : ''}`}
          aria-pressed={view.assignment?.actionId === assignment.actionId} data-action-id={assignment.actionId}
          onClick={() => view.selectAssignment(assignment.actionId)} />)}
      </section>)}
      {view.historyCursor && <Button size="sm" variant="ghost" label={copy.loadEarlier} isDisabled={view.loadingEarlier} onClick={() => { void view.loadEarlier(); }} />}
      {view.executions.length > 0 && <nav className="workHubTaskExecutionChoices" aria-label={copy.chooseExecution}>
        {view.executions.map((execution, index) => <Button key={execution.turnId} size="sm" variant="ghost"
          label={`${formatUiMessage(copy.executionNumber, { number: index + 1 }, locale)} · ${copy.status[execution.status]}`}
          aria-pressed={view.execution?.turnId === execution.turnId} onClick={() => view.selectExecution(execution.turnId)} />)}
      </nav>}
    </details>
    {view.assignment && <p className="workHubTaskSource">{view.assignment.text}</p>}
    {!view.executionsReady && view.assignment?.execution && <p role="status">{copy.lineagePending}</p>}
    {view.assignment && !view.assignment.execution && <p role="status">{stateLabel(view.assignment.state)}</p>}
    {view.ready && !view.assignments.length && <p role="status">{copy.noAssignments}</p>}
    {view.assignment && view.execution && <WorkHubExecutionTranscript
      key={JSON.stringify([owner, view.assignment.targetSessionId, view.execution.turnId, view.execution.runId])}
      services={services} sessionId={view.assignment.targetSessionId} scope={view.execution} />}
  </section>;
}

export function WorkHubExecutionTranscript({ services, sessionId, scope }: { services: WorkHubServices; sessionId: string; scope: SessionExecutionScope }) {
  const locale = useUiLocale();
  const copy = workHubTaskViewCopy[locale];
  const view = useWorkHubExecutionView(services, sessionId, scope);
  const deriveTurnPresentation = useAppShellTurnPresentation({ uiLocale: locale, allowBranch: false });
  return <div className="workHubExecutionTranscript" data-task-turn-id={scope.turnId} data-task-run-id={scope.runId}>
    {view.error && <p role="alert">{view.error}</p>}
    {!view.ready && <p role="status">{copy.livePending}</p>}
    <ChatView activeSession={view.session} messages={[...view.transcript.messages]} liveTurns={view.liveTurns} activeTurn={view.activeTurn}
      messageLoading={!view.transcript.ready} hasEarlierHistory={view.transcript.hasOlder}
      onLoadEarlierHistory={() => { void view.loadEarlier(); }} onStreamingSettled={view.streamingSettled}
      onReadAttachmentBytes={services.readAttachmentBytes} deriveTurnPresentation={deriveTurnPresentation}
      onNew={() => {}} scrollBehavior="auto"
      emptyOverride={<p>{copy.noPublicOutput}</p>} />
  </div>;
}
