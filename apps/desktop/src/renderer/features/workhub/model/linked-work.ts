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


import { desktopSessionKey, parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import { workspaceNameFromCwd } from './workspace-name.js';

import type { StoredMessage } from '@maka/core/session';
import type { WorkHubTask } from '@maka/runtime-host/protocol';

export interface WorkHubLinkedWork {
  readonly workId?: string;
  readonly id: string;
  readonly coordinationTurnId: string;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly workspaceName?: string;
  readonly operation?: 'start' | 'continue' | 'stop';
}

/** Links come from successful tool results in the same durable conversation. */
export function workHubLinkedWork(
  messages: readonly StoredMessage[],
  sessions: readonly { id: string; name: string; cwd?: string }[],
  fallbackName: string,
  coordinationSessionKey?: string,
  tasks: readonly WorkHubTask[] = [],
): WorkHubLinkedWork[] {
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const workspaceName = (id: string) => workspaceNameFromCwd(sessionById.get(id)?.cwd);
  // Backport #6096 without adopting the upstream topic/dispatch redesign:
  // providers may reuse a call ID in another Turn, never another call's link.
  const callKey = (turnId: string, id: string) => JSON.stringify([turnId, id]);
  const taskCalls = new Set(messages.flatMap((message) =>
    message.type === 'tool_call' && message.toolName === 'mcp__desktop_workhub__tasks' ? [callKey(message.turnId, message.id)] : [],
  ));
  const nativeCalls = new Map(messages.flatMap(message => message.type === 'tool_call' &&
    ['mcp__desktop_workhub__start', 'mcp__desktop_workhub__continue', 'mcp__desktop_workhub__stop'].includes(message.toolName)
      ? [[callKey(message.turnId, message.id), message] as const] : []));
  // Model receipts contain task IDs, not Session IDs. Resolve their display
  // targets only through this Host's durable facts or task projection. A new
  // input/stop fact still identifies an old task outside the recent overview
  // when its original assignment has not been loaded into the transcript.
  const targets = new Map<string, { targetSessionId: string; targetSessionName: string; at: number }>();
  const remember = (workId: string, targetSessionId: string, targetSessionName: string | undefined, at: number) => {
    if (!coordinationSessionKey) return;
    try {
      if (parseDesktopSessionKey(targetSessionId).hostId !== parseDesktopSessionKey(coordinationSessionKey).hostId) return;
    } catch { return; }
    const previous = targets.get(workId);
    if ((previous?.at ?? -1) <= at) targets.set(workId, { targetSessionId,
      targetSessionName: sessionById.get(targetSessionId)?.name ?? targetSessionName ??
        (previous?.targetSessionId === targetSessionId ? previous.targetSessionName : undefined) ?? fallbackName, at });
  };
  for (const message of messages) {
    if (message.type !== 'workhub_coordination') continue;
    if (message.kind === 'delegation_assigned')
      remember(message.work?.id ?? message.actionId, message.targetSessionId, message.targetSessionName, message.ts);
    else if (message.kind === 'task_input')
      remember(message.workId, message.targetSessionId, undefined, message.ts);
    else if (message.kind === 'delegation_stop_requested' && message.taskStop === true && message.workId)
      remember(message.workId, message.targetSessionId, message.targetSessionName, message.ts);
  }
  for (const task of tasks) remember(task.workId ?? task.actionId, task.targetSessionId, task.targetSessionName, task.createdAt);
  const readResult = (message: StoredMessage | undefined): Record<string, unknown> | undefined => {
    if (message?.type !== 'tool_result') return undefined;
    let value: unknown;
    if (message.content.kind === 'json') value = message.content.value;
    else if (message.content.kind === 'text') {
      try { value = JSON.parse(message.content.text); } catch { return undefined; }
    }
    if (value && typeof value === 'object' && 'structuredContent' in value) value = value.structuredContent;
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  };
  const results = new Map(messages.flatMap((message) => message.type === 'tool_result' ? [[callKey(message.turnId, message.toolUseId), message] as const] : []));
  return messages.flatMap((message): WorkHubLinkedWork[] => {
    if (message.type === 'tool_result' && !message.isError) {
      const call = nativeCalls.get(callKey(message.turnId, message.toolUseId));
      if (call) {
        const result = readResult(message);
        const args = call.args;
        const operation = call.toolName === 'mcp__desktop_workhub__start' ? 'start'
          : call.toolName === 'mcp__desktop_workhub__continue' ? 'continue' : 'stop';
        let ids: string[] = [];
        if (operation === 'stop' && result?.kind === 'result' && Array.isArray(result.targets) &&
            args && typeof args === 'object' && 'taskIds' in args && Array.isArray(args.taskIds)) {
          const requested = new Set(args.taskIds);
          ids = result.targets.flatMap(target => target && typeof target === 'object' && typeof target.taskId === 'string' && requested.has(target.taskId) ? [target.taskId] : []);
        } else if (operation !== 'stop' && typeof result?.taskId === 'string') {
          if (operation === 'start' && result.admission === 'admitted') ids = [result.taskId];
          if (operation === 'continue' && args && typeof args === 'object' && 'taskId' in args && args.taskId === result.taskId &&
              (result.admission === 'admitted' || ['steering', 'queued_supplement', 'continuation'].includes(String(result.mode)))) ids = [result.taskId];
        }
        return [...new Set(ids)].flatMap(workId => {
          const target = targets.get(workId);
          return target ? [{ workId, operation, id: message.id, coordinationTurnId: message.turnId,
            targetSessionId: target.targetSessionId, targetSessionName: target.targetSessionName,
            workspaceName: workspaceName(target.targetSessionId) }] : [];
        });
      }
    }
    if (message.type === 'tool_call' && taskCalls.has(callKey(message.turnId, message.id))) {
      const args = message.args;
      const request = args && typeof args === 'object' && 'request' in args ? args.request : undefined;
      if (!request || typeof request !== 'object' || !('operation' in request) ||
        (request.operation !== 'stop' && request.operation !== 'resume')) return [];
      const resultMessage = results.get(callKey(message.turnId, message.id));
      const result = readResult(resultMessage);
      let target = typeof result?.targetSessionKey === 'string' && !resultMessage?.isError ? result.targetSessionKey : undefined;
      if (!target && coordinationSessionKey && 'targetSessionId' in request && typeof request.targetSessionId === 'string') {
        try {
          const key = desktopSessionKey({ hostId: parseDesktopSessionKey(coordinationSessionKey).hostId, sessionId: request.targetSessionId });
          if (sessionById.has(key)) target = key;
        } catch { /* An unscoped identity cannot identify a Host-owned Session. */ }
      }
      if (!target) return [];
      return [{ id: message.id, coordinationTurnId: message.turnId, targetSessionId: target,
        targetSessionName: sessionById.get(target)?.name ?? fallbackName, workspaceName: workspaceName(target),
      }];
    }

    if (message.type === 'workhub_coordination' && message.kind === 'delegation_assigned') return [{
      workId: message.work?.id ?? message.actionId,
      id: message.id,
      coordinationTurnId: message.coordinationTurnId,
      targetSessionId: message.targetSessionId,
      targetSessionName: sessionById.get(message.targetSessionId)?.name ?? message.targetSessionName,
      workspaceName: workspaceName(message.targetSessionId),
    }];
    if (message.type !== 'tool_result' || message.isError || !taskCalls.has(callKey(message.turnId, message.toolUseId))) return [];
    let result: unknown;
    if (message.content.kind === 'json') result = message.content.value;
    else if (message.content.kind === 'text') {
      try { result = JSON.parse(message.content.text); } catch { return []; }
    }
    if (result && typeof result === 'object' && 'structuredContent' in result) result = result.structuredContent;
    if (!result || typeof result !== 'object' || !('disposition' in result) ||
      !['create_new', 'delegate_existing', 'replace', 'continue_work'].includes(String(result.disposition)) ||
      !('targetSessionKey' in result) || typeof result.targetSessionKey !== 'string') return [];
    return [{
      ...('workId' in result && typeof result.workId === 'string' ? { workId: result.workId } : {}),
      id: message.id,
      coordinationTurnId: message.turnId,
      targetSessionId: result.targetSessionKey,
      targetSessionName: sessionById.get(result.targetSessionKey)?.name ?? fallbackName,
      workspaceName: workspaceName(result.targetSessionKey),
    }];
  });
}
