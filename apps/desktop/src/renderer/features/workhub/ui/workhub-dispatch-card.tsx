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

import { useContext } from 'react';
import { Button } from '@astryxdesign/core';
import { useUiLocale } from '@maka/ui';
import { ChevronRight, Circle } from '@maka/ui/icons';
import type { WorkHubTask } from '@maka/runtime-host/protocol';
import type { WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubTaskCopy } from '../locales/workhub-task-copy.js';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';
import { WorkHubHighlightContext } from './workhub-work-identity.js';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';

export function WorkHubDispatchCard({ works, tasks, ready, promptText }: {
  works: readonly WorkHubLinkedWork[]; tasks: readonly WorkHubTask[]; ready: boolean; promptText: string;
}) {
  const locale = useUiLocale();
  const copy = workHubTaskViewCopy[locale];
  const taskCopy = workHubTaskCopy[locale];
  const highlight = useContext(WorkHubHighlightContext);
  return <section className="workhub-dispatch" aria-label={`${copy.dispatchedTasks}: ${promptText}`}>
    <p className="workhub-dispatch-summary">{copy.dispatchSummary}</p>
    <div className="workhub-dispatch-card">
      {works.map((work, index) => {
        // A work may continue in a new Session. Only its exact work identity,
        // never a name or shared Session, can supply the latest task facts.
        const task = tasks.filter(item => (item.workId ?? item.actionId) === work.workId)
          .reduce<WorkHubTask | undefined>((latest, item) => !latest || item.createdAt > latest.createdAt ? item : latest, undefined);
        const target = { workId: work.workId!, sessionId: task?.targetSessionId ?? work.targetSessionId, name: task?.targetSessionName ?? work.targetSessionName };
        const status = ready ? task?.status : undefined;
        const label = status ? status === 'pending_acceptance' ? copy.executionEnded : taskCopy.status[status] : copy.taskStatePending;
        let workspace = target.sessionId === work.targetSessionId ? work.workspaceName : undefined;
        try {
          if (workspace === parseDesktopSessionKey(target.sessionId).sessionId) workspace = undefined;
        } catch { /* Legacy display identities may not contain a Host key. */ }
        const detail = status && task?.waitReason ? taskCopy[task.waitReason] : label;
        const selected = highlight.selectedWork?.workId === work.workId;
        return <Button key={work.workId} type="button" variant="ghost" width="100%" className="workhub-dispatch-row"
          label={`${copy.open}: ${target.name}${works.length > 1 ? ` · ${index + 1}/${works.length}` : ''}`} aria-pressed={selected} data-work-id={work.workId} data-status={status ?? 'unknown'}
          onClick={() => highlight.selectWork(target)}>
          <span className="workhub-dispatch-row-content">
            <Circle className="workhub-dispatch-dot" size={7} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            <span className="workhub-dispatch-name">{target.name}<small>{[workspace, detail].filter(Boolean).join(' · ')}</small></span>
            <span className="workhub-dispatch-status">{label}</span>
            <ChevronRight size={15} aria-hidden="true" />
          </span>
        </Button>;
      })}
    </div>
  </section>;
}
