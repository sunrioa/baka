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

import { useState } from 'react';
import { Button, IconButton, TextInput, useUiLocale } from '@maka/ui';
import { PanelRightClose, RefreshCcw } from '@maka/ui/icons';
import type { WorkHubTaskFindItem } from '@maka/runtime-host/protocol';
import type { useWorkHubTaskSearch } from '../controller/use-workhub-task-search.js';
import { workHubTaskCategory } from '../model/task-presentation.js';
import { workHubTaskCopy } from '../locales/workhub-task-copy.js';

export function WorkHubTaskOverview({ search, onView, onClose }: {
  search: ReturnType<typeof useWorkHubTaskSearch>; onView(task: WorkHubTaskFindItem): Promise<void>; onClose?(): void;
}) {
  const t = workHubTaskCopy[useUiLocale()];
  const [error, setError] = useState<string>();
  const label = (item: WorkHubTaskFindItem) => {
    const category = workHubTaskCategory(item.state);
    return category === 'attention' ? t.status.waiting_for_user : category === 'running' ? t.status.running
      : category === 'queued' ? t.status.queued : category === 'ended' ? t.status.pending_acceptance : t.status.stopped;
  };
  return <section className="workHubTaskOverview" aria-label={t.title} aria-busy={!search.ready} data-maka-assistant-exclude>
    <header className="workHubTaskRailHeader"><h2>{t.title}</h2>
      <IconButton size="sm" variant="ghost" icon={<RefreshCcw size={14} />} label={t.refresh} onClick={() => { void search.refresh(); }} />
      {onClose && <IconButton size="sm" variant="ghost" icon={<PanelRightClose size={16} />} label={t.close} onClick={onClose} />}
    </header>
    <TextInput size="sm" label={t.search} value={search.query} onChange={search.setQuery} />
    {!search.ready && <p role={search.error ? 'alert' : 'status'}>{search.items.length ? t.stale : search.error ? t.unavailable : t.loading}</p>}
    {search.ready && search.error && <p role="alert">{t.unavailable}</p>}
    {error && <p role="alert">{error}</p>}
    {search.ready && !search.items.length && <p>{search.query ? t.noMatches : t.empty}</p>}
    {search.match === 'any' && <p role="status">{t.searchRelaxed}</p>}
    {search.match === 'unmatched' && <p role="status">{t.searchUnmatched}</p>}
    <div className="workHubTaskRows">
      {search.items.map(item => <article key={item.id} className="workHubTaskCard" data-status={workHubTaskCategory(item.state)}>
        <Button variant="ghost" size="sm" width="100%" className="workHubTaskHeading" label={`${item.title} · ${label(item)}`} isDisabled={!search.ready}
          onClick={() => { setError(undefined); void onView(item).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }}>
          <span className="workHubTaskHeadingContent"><span className="workHubTaskName">{item.title}</span><span className="workHubTaskStatus">{label(item)}</span></span>
        </Button>
        {item.summary && <p className="workHubTaskText">{item.summary}</p>}
      </article>)}
    </div>
    {search.cursor && <Button size="sm" variant="ghost" label={t.loadMore} isDisabled={!search.ready || search.loadingMore} onClick={() => { void search.loadMore(); }} />}
  </section>;
}
