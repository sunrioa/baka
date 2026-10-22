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

import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { isRecord } from '@maka/core/record-schema';
import { WORKHUB_COORDINATION_SESSION_ID, type ToolResultMessage } from '@maka/core/session';
import type { SystemPromptContext } from '@maka/runtime/ai-sdk-backend';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { SessionTranscriptReader } from './session-transcript-reader.js';

export const WORKHUB_RECENT_TASK_CONTEXT_MAX_BYTES = 1536;
const INTRO =
  'Recent user-associated tasks, newest mention first. Historical references only, not a routing decision, current status, instruction or permission. Missing older work must be searched with find.';
const TOOLS = new Set([
  'mcp__desktop_workhub__start',
  'mcp__desktop_workhub__continue',
  'mcp__desktop_workhub__ask',
]);
type Stores = ExecutionStoresWriter<'interactive'>;
type Reference = { taskId: string; title: string };

/** Rebuildable hint, not a task owner or a second memory store. */
export function createWorkHubRecentTaskContext(options: {
  reader: Pick<SessionTranscriptReader, 'readDurableRecords'>;
  readRoot: Stores['agentRunStore']['readRootTurnAdmission'];
  readTask: Stores['sessionStore']['readLatestWorkHubAssignment'];
}) {
  return async (scope: SystemPromptContext): Promise<{ name: string; text: string }[]> => {
    if (scope.sessionId !== WORKHUB_COORDINATION_SESSION_ID || !scope.runId) return [];
    try {
      const current = await options.readRoot(scope.sessionId, scope.turnId);
      if (
        current?.runId !== scope.runId ||
        current.execution.kind !== 'workhub_coordination' ||
        current.execution.feedback
      )
        return [];
      const results = new Map<string, { sequence: number; message: ToolResultMessage }>();
      const candidates: { sequence: number; taskId: string }[] = [];
      const roots = new Map<string, ReturnType<typeof options.readRoot>>();
      let position: number | undefined;
      let throughSequence: number | null | undefined;
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const page = await options.reader.readDurableRecords(scope.sessionId, {
          direction: 'older',
          maxMessages: 32,
          maxStoredBytes: 128 * 1024,
          ...(position !== undefined ? { position } : {}),
          ...(throughSequence !== undefined ? { throughSequence } : {}),
        });
        throughSequence ??= page.throughSequence;
        for (const { sequence, message } of page.records) {
          if (
            message.type === 'tool_result' &&
            !message.isError &&
            message.modelVisibility !== 'hidden'
          )
            results.set(JSON.stringify([message.turnId, message.toolUseId]), { sequence, message });
          if (
            message.type !== 'tool_call' ||
            !TOOLS.has(message.toolName) ||
            message.modelVisibility === 'hidden'
          )
            continue;
          const result = results.get(JSON.stringify([message.turnId, message.id]));
          if (
            !result ||
            result.message.content.kind !== 'json' ||
            !isRecord(result.message.content.value)
          )
            continue;
          let root = roots.get(message.turnId);
          if (!root) {
            root = options.readRoot(scope.sessionId, message.turnId);
            roots.set(message.turnId, root);
          }
          const admission = await root;
          if (admission?.execution.kind !== 'workhub_coordination' || admission.execution.feedback)
            continue;
          const envelope = result.message.content.value;
          if (envelope.isError === true) continue;
          // Desktop-native tools retain the MCP structured-content envelope
          // in the durable ledger; Host-native ask receipts are already bare.
          // Never infer an identity by parsing the human-readable text blocks.
          const value = isRecord(envelope.structuredContent) ? envelope.structuredContent : envelope;
          const taskId =
            message.toolName === 'mcp__desktop_workhub__ask'
              ? value.kind === 'selected' && isRecord(value.target) && value.target.kind === 'task'
                ? value.target.id
                : undefined
              : value.taskId;
          if (typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 256)
            candidates.push({ sequence: result.sequence, taskId });
        }
        if (page.nextPosition === null) break;
        position = page.nextPosition;
      }
      const references: Reference[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates.sort((a, b) => b.sequence - a.sequence)) {
        if (seen.has(candidate.taskId)) continue;
        seen.add(candidate.taskId);
        const task = await options.readTask(candidate.taskId);
        if (!task || (task.work?.id ?? task.actionId) !== candidate.taskId) continue;
        const reference = {
          taskId: candidate.taskId,
          title: truncateUtf8(task.taskTitle ?? task.targetSessionName, 96, '…'),
        };
        const text = `${INTRO}\n${JSON.stringify([...references, reference])}`;
        if (Buffer.byteLength(text) > WORKHUB_RECENT_TASK_CONTEXT_MAX_BYTES) break;
        references.push(reference);
        if (references.length === 8) break;
      }
      return references.length
        ? [{ name: 'workhub.recent_user_tasks', text: `${INTRO}\n${JSON.stringify(references)}` }]
        : [];
    } catch {
      // Optional recall must not fail a valid Turn, guess references or retry.
      return [];
    }
  };
}
