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

import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type {
  ExecutionAgentRunWriter,
  ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { createWorkHubEvidenceRuntime } from './workhub-evidence-runtime.js';

/**
 * Resolve a task, not the Session's last input. Legacy data may have a later
 * queued/withdrawn input while an earlier input of this same task still runs.
 * Only immutable Message provenance can select that earlier source.
 * This read does not replace the admission-time ownership checks.
 */
export async function readCurrentWorkHubTaskSource(
  options: {
    stores: {
      sessionStore: Pick<
        ExecutionSessionWriter,
        | 'readLatestWorkHubAssignment'
        | 'readWorkHubAssignment'
        | 'readWorkHubAssignmentByMessage'
        | 'readWorkHubTaskInputByMessage'
      >;
      agentRunStore: Pick<
        ExecutionAgentRunWriter,
        'readRootTurnAdmission' | 'readRootTurnContinuationAdmission'
      >;
    };
    messages: Pick<HostMessageCoordinator, 'readMessageExecutionDisposition'>;
    executions: Pick<RootTurnCoordinator, 'readRootState' | 'readLatestRootTurnLineage'>;
    evidence?: Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'taskExecution'>;
  },
  workId: string,
): Promise<WorkHubDelegationAssignedMessage | undefined> {
  const { stores, messages, executions } = options;
  const latest = await stores.sessionStore.readLatestWorkHubAssignment(workId);
  if (!latest || (latest.work?.id ?? latest.actionId) !== workId) return undefined;
  const active = executions.readRootState(latest.targetSessionId);
  if (active.kind !== 'active') return latest;
  const generation = latest.work?.generationId ?? latest.actionId;
  const candidates: WorkHubDelegationAssignedMessage[] = [];
  let root = await stores.agentRunStore.readRootTurnAdmission(
    latest.targetSessionId,
    active.turnId,
  );
  // Safe-boundary continuation admits a new Turn without another user Message.
  // Follow only its canonical source edge, never the merely previous chat Turn.
  const seen = new Set<string>();
  while (
    root?.sourceMessages.length === 0 &&
    root.execution.kind === 'safe_boundary_continuation'
  ) {
    if (seen.has(root.turnId)) throw new Error('WorkHub execution source contains a cycle');
    seen.add(root.turnId);
    const source = root.execution;
    const edge = await stores.agentRunStore.readRootTurnContinuationAdmission(
      active.sessionId,
      source.sourceTurnId,
      source.sourceRunId,
    );
    if (edge?.turnId !== root.turnId || edge.runId !== root.runId) break;
    root = await stores.agentRunStore.readRootTurnAdmission(active.sessionId, source.sourceTurnId);
  }
  // A resumed Run keeps the original Turn admission. Match its Message below
  // and require the exact lineage tip, rather than discarding the original
  // admission merely because the physical Run has changed.
  if (root?.sourceMessages.length === 1) {
    const messageId = root.sourceMessages[0]!.messageId;
    const assigned = await stores.sessionStore.readWorkHubAssignmentByMessage(messageId);
    if (assigned) candidates.push(assigned);
    const input = await stores.sessionStore.readWorkHubTaskInputByMessage(messageId);
    if (input?.workId === workId && input.generationId === generation) {
      const source = await stores.sessionStore.readWorkHubAssignment(input.sourceActionId);
      if (source?.delegationId === input.sourceDelegationId) candidates.push(source);
    }
  }
  const first = await stores.sessionStore.readWorkHubAssignment(generation);
  if (first) candidates.push(first);
  for (const source of candidates) {
    if (
      (source.work?.id ?? source.actionId) !== workId ||
      (source.work?.generationId ?? source.actionId) !== generation ||
      source.targetSessionId !== latest.targetSessionId
    )
      continue;
    const disposition = await messages.readMessageExecutionDisposition(
      source.targetSessionId,
      source.targetMessageId,
    );
    if (disposition.kind !== 'owned_root' && disposition.kind !== 'shared_turn') continue;
    const original = {
      sessionId: source.targetSessionId,
      turnId: disposition.turnId,
      runId: disposition.runId,
    };
    const current =
      options.evidence && disposition.kind === 'owned_root'
        ? await options.evidence.taskExecution(source, original)
        : await executions.readLatestRootTurnLineage(original);
    if (current.turnId === active.turnId && current.runId === active.runId) return source;
  }
  return latest;
}
