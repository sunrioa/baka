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
import { useWorkHubTaskView, useWorkHubExecutionView } from '../controller/use-workhub-task-view.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';

export function WorkHubTaskView({ services, owner, workId, name, onClose }: {
  services: WorkHubServices; owner: string; workId: string; name: string; onClose(): void;
}) {
  const zh = useUiLocale() === 'zh-CN';
  const view = useWorkHubTaskView(services, owner, workId);
  const groups = useMemo(() => {
    const result = new Map<string, WorkHubTaskAssignment[]>();
    for (const assignment of view.assignments) {
      const rows = result.get(assignment.generationId) ?? [];
      rows.push(assignment); result.set(assignment.generationId, rows);
    }
    return [...result];
  }, [view.assignments]);
  const stateLabel = (state: WorkHubTaskAssignment['state']) => ({
    owned: zh ? '独立执行' : 'Owned execution', queued: zh ? '排队中' : 'Queued', cancelled: zh ? '已取消' : 'Cancelled',
    shared: zh ? '共享 Turn，不能作为独占执行展示' : 'Shared Turn; not an exclusive task execution',
    unavailable: zh ? '执行归属不可用' : 'Execution ownership unavailable',
  })[state];
  return <section className="workHubTaskView" aria-label={zh ? '任务实时执行' : 'Task execution'} data-work-id={workId}>
    <header className="workHubTaskViewHeader">
      <div><h2>{name}</h2><p>{zh ? '展示任务的真实公开执行记录；执行结束不代表目标已验收。' : 'Public worker execution, not a coordinator summary. Execution ending is not verified goal completion.'}</p></div>
      <Button size="sm" variant="ghost" label={zh ? '返回 WorkHub' : 'Back to WorkHub'} onClick={onClose} />
    </header>
    <div className="workHubTaskViewActions">
      <Button size="sm" variant="ghost" label={zh ? '跟随最新执行' : 'Follow latest execution'} onClick={view.followLatest} />
      <Button size="sm" variant="ghost" label={zh ? '刷新' : 'Refresh'} onClick={() => { void view.refresh(); }} />
    </div>
    {view.error && <p role="alert">{view.error}</p>}
    {!view.ready && <p role="status">{zh ? '任务事实正在刷新或暂不可用。' : 'Refreshing task facts or waiting for the Host.'}</p>}
    <details className="workHubTaskAttempts" open>
      <summary>{zh ? '派发与执行记录' : 'Assignments and executions'}</summary>
      {groups.map(([generationId, rows], index) => <section key={generationId} data-work-generation={generationId}>
        <h3>{index === 0 ? zh ? '当前阶段' : 'Current generation' : zh ? '历史阶段' : 'Earlier generation'}</h3>
        {rows.map(assignment => <Button key={assignment.actionId} size="sm" variant="ghost" className="workHubTaskAttempt"
          label={`${assignment.targetSessionName} · ${stateLabel(assignment.state)}${assignment.superseded ? zh ? ' · 已替换' : ' · Superseded' : ''}`}
          aria-pressed={view.assignment?.actionId === assignment.actionId} data-action-id={assignment.actionId}
          onClick={() => view.selectAssignment(assignment.actionId)} />)}
      </section>)}
      {view.historyCursor && <Button size="sm" variant="ghost" label={zh ? '加载更早派发' : 'Load earlier assignments'} isDisabled={view.loadingEarlier} onClick={() => { void view.loadEarlier(); }} />}
      {view.executions.length > 0 && <nav className="workHubTaskExecutionChoices" aria-label={zh ? '选择执行尝试' : 'Choose execution'}>
        {view.executions.map((execution, index) => <Button key={execution.turnId} size="sm" variant="ghost"
          label={`${zh ? '执行' : 'Execution'} ${index + 1} · ${execution.status}`}
          aria-pressed={view.execution?.turnId === execution.turnId} onClick={() => view.selectExecution(execution.turnId)} />)}
      </nav>}
    </details>
    {view.assignment && <p className="workHubTaskSource">{view.assignment.text}</p>}
    {!view.executionsReady && view.assignment?.execution && <p role="status">{zh ? '正在读取执行沿革，尚不能确定最新尝试。' : 'Reading execution lineage; the latest attempt is not confirmed yet.'}</p>}
    {view.assignment && !view.assignment.execution && <p role="status">{stateLabel(view.assignment.state)}</p>}
    {view.ready && !view.assignments.length && <p role="status">{zh ? '此工作没有可读取的派发记录。' : 'No readable assignments for this work.'}</p>}
    {view.assignment && view.execution && <WorkHubExecutionTranscript
      key={JSON.stringify([owner, view.assignment.targetSessionId, view.execution.turnId, view.execution.runId])}
      services={services} sessionId={view.assignment.targetSessionId} scope={view.execution} />}
  </section>;
}

export function WorkHubExecutionTranscript({ services, sessionId, scope }: { services: WorkHubServices; sessionId: string; scope: SessionExecutionScope }) {
  const locale = useUiLocale();
  const zh = locale === 'zh-CN';
  const view = useWorkHubExecutionView(services, sessionId, scope);
  const deriveTurnPresentation = useAppShellTurnPresentation({ uiLocale: locale, allowBranch: false });
  return <div className="workHubExecutionTranscript" data-task-turn-id={scope.turnId} data-task-run-id={scope.runId}>
    {view.error && <p role="alert">{view.error}</p>}
    {!view.ready && <p role="status">{zh ? '实时连接暂未就绪；保留已读取的记录。' : 'Live observation is not ready; previously read records are retained.'}</p>}
    <ChatView activeSession={view.session} messages={[...view.transcript.messages]} liveTurns={view.liveTurns} activeTurn={view.activeTurn}
      messageLoading={!view.transcript.ready} hasEarlierHistory={view.transcript.hasOlder}
      onLoadEarlierHistory={() => { void view.loadEarlier(); }} onStreamingSettled={view.streamingSettled}
      onReadAttachmentBytes={services.readAttachmentBytes} deriveTurnPresentation={deriveTurnPresentation}
      onNew={() => {}} scrollBehavior="auto"
      emptyOverride={<p>{zh ? '该执行尚无公开输出。' : 'This execution has no public output yet.'}</p>} />
  </div>;
}
