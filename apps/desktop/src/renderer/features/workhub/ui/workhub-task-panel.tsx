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

import { Selector } from '@astryxdesign/core';
import { useCallback, useState } from 'react';
import { ChatSurfaceLayout, useUiLocale } from '@maka/ui';
import { useWorkHubServices } from '../services.js';
import { useWorkHubTaskSearch } from '../controller/use-workhub-task-search.js';
import { useWorkHubTaskView } from '../controller/use-workhub-task-view.js';
import { useWorkHubTaskSelection } from '../controller/use-workhub-task-selection.js';
import { useWorkHubTaskInbox } from '../controller/use-workhub-task-inbox.js';
import { WorkHubTaskView } from './workhub-task-view.js';
import { WorkHubTaskComposer } from './workhub-task-composer.js';
import { WorkHubTaskOverview } from './workhub-task-overview.js';
import { workHubTaskCopy } from '../locales/workhub-task-copy.js';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';
import type { WorkHubServices } from '../ports.js';
import type { WorkHubTaskSelection } from '../../../../shared/workhub-presentation.js';

type Task = NonNullable<WorkHubTaskSelection['work']>;

/** Shell-owned tool: no second sidebar controller or coordinator lifecycle. */
export function WorkHubTaskPanel({ owner, available = true }: { owner: string; available?: boolean }) {
  const services = useWorkHubServices();
  const selection = useWorkHubTaskSelection(services, owner, available);
  const selected = selection.selected;
  const search = useWorkHubTaskSearch(services, owner, available);
  const [error, setError] = useState<string>();
  const locale = useUiLocale();
  const choices = new Map(search.items.map(item => [item.id, item.title]));
  if (selected && !choices.has(selected.workId)) choices.set(selected.workId, selected.name);
  async function openTask(workId: string, title: string) {
    await selection.open({ workId }, title);
  }
  return <section className="workHubTaskPanel" aria-label={workHubTaskViewCopy[locale].panel} data-view={selected ? 'execution' : 'overview'}>
    {(error || selection.error) && <p role="alert">{error ?? selection.error}</p>}
    {selected ? <>
      <header className="workHubTaskPanelToolbar">
        <Selector label={workHubTaskViewCopy[locale].chooseTask} isLabelHidden variant="ghost" size="sm" width="100%" value={selected.workId}
          options={[{ value: '', label: workHubTaskCopy[locale].title }, ...[...choices].map(([value, label]) => ({ value, label }))]}
          onChange={id => {
            setError(undefined);
            if (!id) selection.select(undefined);
            else { const title = choices.get(id); if (title) void openTask(id, title).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }
          }} />
      </header>
      <TaskPreview key={owner} services={services} owner={owner} selected={selected} available={available} />
    </> : <WorkHubTaskOverview search={search} onView={task => openTask(task.id, task.title)} />}
  </section>;
}

/** At most two readers: keep the previous pixels until the next history is
 * positioned, then swap atomically. Neither staged nor stale inputs can send. */
function TaskPreview({ services, owner, selected, available }: { services: WorkHubServices; owner: string; selected: Task; available: boolean }) {
  const inbox = useWorkHubTaskInbox(services, available ? owner : undefined);
  const [shown, setShown] = useState<Task>();
  const copy = workHubTaskViewCopy[useUiLocale()];
  const ready = useCallback((task: Task) => {
    if (task.workId === selected.workId) setShown(previous => previous?.workId === task.workId ? previous : task);
  }, [selected]);
  const pending = shown?.workId !== selected.workId;
  const tasks = shown && pending ? [shown, selected] : [selected];
  return <div className="workHubTaskPreview" aria-busy={pending}>
    {!shown && <p role="status">{copy.loading}</p>}
    {tasks.map(task => <TaskPreviewScreen key={task.workId} services={services} owner={owner} task={task} available={available}
      staged={shown?.workId !== task.workId} interactive={!pending} inbox={inbox} onReady={ready} />)}
  </div>;
}

function TaskPreviewScreen({ services, owner, task, available, staged, interactive, inbox, onReady }: {
  services: WorkHubServices; owner: string; task: Task; available: boolean; staged: boolean; interactive: boolean; inbox: ReturnType<typeof useWorkHubTaskInbox>; onReady(task: Task): void;
}) {
  const view = useWorkHubTaskView(services, owner, task.workId, available);
  const ready = useCallback(() => { if (available) onReady(task); }, [available, onReady, task]);
  return <div className="workHubTaskScreen" data-staged={staged || undefined} inert={staged || !interactive} aria-hidden={staged || undefined}>
    <ChatSurfaceLayout composer={<WorkHubTaskComposer services={services} owner={owner} workId={task.workId} name={task.name} view={view} />}>
      <WorkHubTaskView services={services} owner={owner} workId={task.workId} name={task.name} view={view} inbox={inbox} onReady={ready} />
    </ChatSurfaceLayout>
  </div>;
}
