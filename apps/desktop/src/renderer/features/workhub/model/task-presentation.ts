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

import type { WorkHubTask, WorkHubTaskAssignment, WorkHubTaskFindItem } from '@maka/runtime-host/protocol';

export type WorkHubTaskCategory = 'attention' | 'running' | 'queued' | 'ended' | 'stopped';

/** Display categories do not add an acceptance transition or execution authority. */
export function workHubTaskCategory(status: WorkHubTask['status'] | WorkHubTaskFindItem['state']): WorkHubTaskCategory {
  if (status === 'waiting_for_user' || status === 'waiting_for_dependency') return 'attention';
  if (status === 'running' || status === 'stopping') return 'running';
  if (status === 'queued' || status === 'waiting_resource' || status === 'available') return 'queued';
  if (status === 'pending_acceptance' || status === 'ended') return 'ended';
  return 'stopped';
}

/** Old task records have instructions but no independent title. Never use an opaque ID as a title. */
export function workHubTaskTitle(task: Pick<WorkHubTask, 'text' | 'targetSessionName'> & { readonly title?: string }): string {
  return task.title?.trim() || Array.from(task.text.trim().split(/\r?\n/u)[0] ?? '').slice(0, 80).join('') || task.targetSessionName;
}

export function orderWorkHubTasks<T extends { readonly id: string; readonly state: WorkHubTaskFindItem['state']; readonly lastActivityAt: number }>(items: readonly T[]): T[] {
  const priority: Record<WorkHubTaskCategory, number> = { attention: 0, running: 1, queued: 2, ended: 3, stopped: 3 };
  return [...items].sort((a, b) => priority[workHubTaskCategory(a.state)] - priority[workHubTaskCategory(b.state)] || b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
}

/** Full conversations stay mounted once per execution container. Paging must not invent segment numbers. */
export function workHubTaskSegments(assignments: readonly WorkHubTaskAssignment[], complete: boolean) {
  const sessions = new Map<string, { sessionId: string; number?: number }>();
  for (const assignment of [...assignments].reverse()) {
    const previous = sessions.get(assignment.targetSessionId);
    const projected = (assignment as WorkHubTaskAssignment & { readonly segment?: number }).segment;
    sessions.delete(assignment.targetSessionId);
    sessions.set(assignment.targetSessionId, { sessionId: assignment.targetSessionId, number: projected ?? previous?.number });
  }
  return [...sessions.values()].map((segment, index) => ({ ...segment, number: segment.number ?? (complete ? index + 1 : undefined) }));
}
