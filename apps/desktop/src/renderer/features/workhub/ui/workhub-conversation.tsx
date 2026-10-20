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
import type { CSSProperties } from 'react';

import { useContext, useMemo, type ComponentProps } from 'react';
import { ChatView, useUiLocale } from '@maka/ui';
import { Button, Link } from '@astryxdesign/core';
import { WorkHubHighlightContext, useWorkHubIdentityHue } from './workhub-work-identity.js';
import type { WorkHubLinkedWork } from '../model/linked-work.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';
import type { WorkHubTask } from '@maka/runtime-host/protocol';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';
import { WorkHubDispatchCard } from './workhub-dispatch-card.js';
import { workHubTaskTitle } from '../model/task-presentation.js';

export function WorkHubConversation(props: ComponentProps<typeof ChatView> & { workLinks: readonly WorkHubLinkedWork[]; taskFacts?: { tasks: readonly WorkHubTask[]; ready: boolean }; onOpenWork(sessionId: string): void }) {
  const { onOpenWork, workLinks: assignments, taskFacts, ...chat } = props;
  const highlight = useContext(WorkHubHighlightContext);
  const workHubIdentityHue = useWorkHubIdentityHue(assignments.map((work) => work.targetSessionId));
  const locale = useUiLocale();
  const deriveTurnPresentation = useAppShellTurnPresentation({ uiLocale: locale, allowBranch: false });
  const copy = workHubLiveCopy[locale];
  const taskCopy = workHubTaskViewCopy[locale];
  // A coordination turn can delegate to several Works. Keep every label and
  // divide its rail evenly, keeping every segment linked to its own Session.
  const worksByTurn = useMemo(() => {
    const grouped = new Map<string, WorkHubLinkedWork[]>();
    const titles = new Map((taskFacts?.tasks ?? []).map(task => [task.workId ?? task.actionId, workHubTaskTitle(task)]));
    for (const work of assignments) {
      const works = grouped.get(work.coordinationTurnId) ?? [];
      if (!works.some((item) => (item.workId ?? item.targetSessionId) === (work.workId ?? work.targetSessionId))) works.push({ ...work, targetSessionName: work.workId ? titles.get(work.workId) ?? work.targetSessionName : work.targetSessionName });
      grouped.set(work.coordinationTurnId, works);
    }
    return grouped;
  }, [assignments, taskFacts?.tasks]);
  const workByTurn = useMemo(() => new Map([...worksByTurn].flatMap(([turnId, works]) =>
    works.length === 1 ? [[turnId, works[0]!.targetSessionId] as const] : [])), [worksByTurn]);
  const promptRailDecorations = useMemo(() => new Map([...worksByTurn].map(([turnId, works]) => {
    const colors = works.map((work) => `oklch(var(--workhub-${highlight.sessionId === work.targetSessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(work.targetSessionId)})`);
    return [turnId, {
      accentColor: works.length === 1 ? colors[0] : undefined,
      accentBackground: works.length > 1 ? `linear-gradient(to right, ${colors.map((color, index) => `${color} ${index * 100 / colors.length}% ${(index + 1) * 100 / colors.length}%`).join(', ')})` : undefined,
      highlighted: works.some((work) => highlight.sessionId === work.targetSessionId),
    }];
  })), [worksByTurn, highlight.sessionId, workHubIdentityHue]);
  const promptTextByTurn = new Map(chat.messages?.flatMap((message) => message.type === 'user' ? [[message.turnId, message.text.slice(0, 80)] as const] : []));
  const turnDecorations = new Map<string, NonNullable<ComponentProps<typeof ChatView>['turnDecorations']> extends ReadonlyMap<string, infer V> ? V : never>([...worksByTurn].map(([turnId, works]) => [turnId, {
    assistantDetailsLabel: works.some(work => work.workId && work.operation !== 'stop') ? taskCopy.dispatchDetails : undefined,
    assistantSummary: works.some(work => work.workId && work.operation !== 'stop')
      ? <WorkHubDispatchCard works={works.filter(work => work.workId && work.operation !== 'stop')} tasks={taskFacts?.tasks ?? []} ready={taskFacts?.ready ?? false} promptText={promptTextByTurn.get(turnId) ?? taskCopy.dispatchedTasks} />
      : undefined,
    accentColor: promptRailDecorations.get(turnId)?.accentColor ?? 'transparent',
    messageRail: <>{works.map((work, index) => <Button key={work.workId ?? work.targetSessionId}
      variant="ghost" isIconOnly icon={<span aria-hidden="true" />} className="workhub-message-rail"
      style={{ insetBlockStart: `${index * 100 / works.length}%`, insetBlockEnd: 'auto', height: `${100 / works.length}%`,
        '--maka-turn-accent': `oklch(var(--workhub-${highlight.sessionId === work.targetSessionId ? 'highlight' : 'tone'}) ${workHubIdentityHue(work.targetSessionId)})`,
      } as CSSProperties}
      data-work-session-id={work.targetSessionId}
      label={`${copy.filterConversation}: ${work.targetSessionName}${promptTextByTurn.get(turnId) ? ` · ${promptTextByTurn.get(turnId)}` : ''}${works.length > 1 ? ` · ${index + 1}/${works.length}` : ''}`}
      tooltip={`${copy.filterConversation}: ${work.targetSessionName}`}
      aria-pressed={Boolean(highlight.selectedWork) && (highlight.selectedWork?.workId ?? highlight.selectedWork?.sessionId) === (work.workId ?? work.targetSessionId)}
      data-work-highlighted={highlight.sessionId === work.targetSessionId}
      onMouseEnter={() => highlight.highlight(work.targetSessionId)}
      onMouseLeave={() => highlight.highlight(undefined)}
      onFocus={() => highlight.highlight(work.targetSessionId)}
      onBlur={() => highlight.highlight(undefined)}
      onClick={() => highlight.toggleWork({ sessionId: work.targetSessionId, name: work.targetSessionName, workId: work.workId })}
    />)}</>,
    header: <div className="workhub-turn-heading">
      {works.map((work) => <Link
        key={work.workId ?? work.targetSessionId}
        type="supporting" color="secondary"
        className="workhub-turn-label"
        data-work-session-id={work.targetSessionId}
        data-work-highlighted={highlight.sessionId === work.targetSessionId}
        aria-label={`${work.targetSessionName}${promptTextByTurn.get(turnId) ? ` · ${promptTextByTurn.get(turnId)}` : ''}`}
        onMouseEnter={() => highlight.highlight(work.targetSessionId)}
        onMouseLeave={() => highlight.highlight(undefined)}
        onFocus={() => highlight.highlight(work.targetSessionId)}
        onBlur={() => highlight.highlight(undefined)}
        onClick={() => work.workId
          ? highlight.selectWork({ sessionId: work.targetSessionId, name: work.targetSessionName, workId: work.workId })
          : onOpenWork(work.targetSessionId)}
      >{work.targetSessionName}</Link>)}
    </div>,
  }]));
  return <ChatView {...chat}
    deriveTurnPresentation={deriveTurnPresentation}
    turnDecorations={turnDecorations}
    promptRailDecorations={promptRailDecorations}
    onPromptRailHighlight={(turnId) => highlight.highlight(turnId ? workByTurn.get(turnId) : undefined)}

  />;
}
