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

import { useEffect, useId, useState } from 'react';
import { Button, TextArea, useUiLocale } from '@maka/ui';
import type { WorkHubTask, WorkHubTaskDetail } from '@maka/runtime-host/protocol';
import type { useWorkHubTaskOverview } from '../controller/use-workhub-task-overview.js';
import { workHubTaskCopy } from '../locales/workhub-task-copy.js';

type Overview = ReturnType<typeof useWorkHubTaskOverview>;
export function WorkHubTaskOverview({ overview, onOpen }: { overview: Overview; onOpen(sessionId: string): void }) {
  const t = workHubTaskCopy[useUiLocale()];
  if (overview.ready && !overview.tasks.length && !overview.truncated) return null;
  const ended = (task: WorkHubTask) => ['pending_acceptance', 'failed', 'cancelled', 'stopped', 'unavailable'].includes(task.status);
  const groups = [{ label: t.progress, tasks: overview.tasks.filter(task => !ended(task)) }, { label: t.delivery, tasks: overview.tasks.filter(ended) }];
  return <details className="workHubTaskOverview" open aria-label={t.title} aria-busy={!overview.ready} data-maka-assistant-exclude>
    <summary>{t.title}{overview.ready && <span> · {overview.tasks.length}</span>}</summary>
    {!overview.ready && <p role={overview.error ? 'alert' : 'status'}>{overview.tasks.length ? t.stale : overview.error ? t.unavailable : t.loading}</p>}
    <>
      <p className="workHubTaskHint">{t.hint}</p>
      <div className="workHubTaskRows">
        {groups.flatMap(group => group.tasks.map((task, index) => <div key={JSON.stringify([task.actionId, task.delegationId])}>
          {index === 0 && <h3>{group.label}</h3>}
          <TaskCard task={task} overview={overview} onOpen={onOpen} />
        </div>))}
      </div>
      {overview.truncated && <p role="status">{t.truncated}</p>}
    </>
    <Button size="sm" variant="ghost" label={t.refresh} onClick={() => { void overview.refresh(); }} />
  </details>;
}
function TaskCard({ task, overview, onOpen }: { task: WorkHubTask; overview: Overview; onOpen(sessionId: string): void }) {
  const t = workHubTaskCopy[useUiLocale()];
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<WorkHubTaskDetail>();
  const [readError, setReadError] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [text, setText] = useState(() => overview.pendingContinuation(task)?.text ?? '');
  const [sending, setSending] = useState(false);
  const [unknown, setUnknown] = useState(() => Boolean(overview.pendingContinuation(task)));
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let active = true;
    setDetail(undefined); setReadError(undefined);
    if (expanded && overview.ready) void overview.read(task).then(result => { if (active) setDetail(result); }, () => { if (active) setReadError(t.unavailable); });
    return () => { active = false; };
  }, [expanded, task, overview.ready, overview.generation, t.unavailable]);
  const shown = detail?.task ?? task;
  const error = sendError ?? readError;
  const canContinue = !['stopping', 'stopped', 'cancelled', 'unavailable'].includes(shown.status) && !shown.execution?.sharedTurn;
  return <article className="workHubTaskCard" data-status={shown.status}>
    <Button variant="ghost" size="sm" width="100%" className="workHubTaskHeading" label={`${shown.targetSessionName} ${t.status[shown.status]}`} aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
      <span className="workHubTaskHeadingContent"><span className="workHubTaskName">{shown.targetSessionName}</span><span className="workHubTaskStatus">{t.status[shown.status]}</span></span>
    </Button>
    <p className="workHubTaskText">{shown.text}</p>
    {shown.waitReason && <p className="workHubTaskHint">{t[shown.waitReason]}</p>}
    {shown.dependency && <p className="workHubTaskHint">{t.dependency}: {shown.dependency.question}</p>}
    {shown.failure && <p className="workHubTaskFailure">{shown.failure}</p>}
    {expanded && <div id={id} className="workHubTaskDetails">
      <h4>{t.source}</h4>
      <dl>
        <dt>Action / Delegation</dt><dd><code>{shown.actionId} / {shown.delegationId}</code></dd>
        <dt>Message</dt><dd><code>{shown.targetMessageId}</code></dd>
        {shown.execution && <><dt>Turn / Run</dt><dd><code>{shown.execution.turnId} / {shown.execution.runId}</code></dd></>}
        {shown.dependency && <><dt>{t.dependency}</dt><dd><code>{shown.dependency.requestId}{shown.dependency.sourceActionId && ' → ' + shown.dependency.sourceActionId}</code></dd></>}
      </dl>
      {!detail && !error && <p role="status">{overview.ready ? t.loading : t.stale}</p>}
      {detail?.delivery && <section aria-label={t.excerpt}>
        <h4>{t.excerpt}</h4><p className="workHubTaskHint">{t.unverified}</p>
        <pre>{detail.delivery.text}</pre>
        <p><code>{detail.delivery.terminalEventId}</code></p>
        {detail.delivery.truncated && <p>{t.deliveryTruncated}</p>}
      </section>}
      {error && <p role="alert">{error}</p>}
      <Button size="sm" variant="ghost" label={t.open} isDisabled={!overview.ready} onClick={() => onOpen(shown.targetSessionId)} />
      {canContinue && <form onSubmit={event => {
        event.preventDefault(); if (sending || !text.trim()) return;
        setSending(true); setSendError(undefined); setSent(false);
        void overview.continue(shown, text).then(accepted => {
          if (accepted) { setText(''); setUnknown(false); setSent(true); }
          else { setUnknown(true); setSendError(t.error); }
        }, () => { setUnknown(true); setSendError(t.error); }).finally(() => setSending(false));
      }}>
        <TextArea label={t.continuation} value={text} isReadOnly={sending || unknown || !overview.ready} onChange={value => setText(value.slice(0, 8000))} rows={2} />
        <Button type="submit" size="sm" variant="ghost" label={unknown ? t.retry : t.submit} isDisabled={sending || !overview.ready || !text.trim()} />
        {sent && <p role="status">{t.sent}</p>}
      </form>}
    </div>}
  </article>;
}
