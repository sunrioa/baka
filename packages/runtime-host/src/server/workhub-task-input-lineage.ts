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
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { HostedExecutionRef } from './hosted-execution-authority.js';

function belongsTo(input: WorkHubTaskInputMessage, a: WorkHubDelegationAssignedMessage) {
  return (
    input.sourceActionId === a.actionId &&
    input.sourceDelegationId === a.delegationId &&
    input.workId === (a.work?.id ?? a.actionId) &&
    input.generationId === (a.work?.generationId ?? a.actionId) &&
    input.targetSessionId === a.targetSessionId &&
    input.turnId === a.coordinationTurnId
  );
}

/** Binding follows the accepted Message identity, including a later user queue edit. */
export async function readWorkHubTaskInputBinding(
  stores: ExecutionStoresWriter<'interactive'>,
  sessionId: string,
  messageId: string,
) {
  if (!/^whtm_[a-f0-9]{48}$/u.test(messageId)) return undefined;
  const input = await stores.sessionStore.readWorkHubTaskInputByMessage(messageId);
  if (!input || input.mode !== 'steering' || input.targetSessionId !== sessionId) return undefined;
  const source = await stores.sessionStore.readWorkHubAssignment(input.sourceActionId);
  return source && belongsTo(input, source) ? input : undefined;
}

/**
 * An unconsumed native steering batch is one same-work successor, not a new
 * execution lineage or renewed grants. Never claim a mixed/manual batch.
 */
export async function readWorkHubTaskInputContinuation(
  stores: ExecutionStoresWriter<'interactive'>,
  assignment: WorkHubDelegationAssignedMessage,
  previous: HostedExecutionRef,
): Promise<HostedExecutionRef | undefined> {
  const inputs = await stores.sessionStore.readWorkHubTaskInputSuccessors(previous);
  let next: HostedExecutionRef | undefined;
  for (const input of inputs) {
    if (!belongsTo(input, assignment)) continue;
    const proof = await stores.agentRunStore.readRootTurnSourceMessageReceipt(
      previous.sessionId,
      input.targetMessageId,
    );
    const root = proof?.admission;
    if (
      !root ||
      root.sessionId !== previous.sessionId ||
      root.turnId === previous.turnId ||
      root.execution.kind !== 'external_message'
    )
      continue;
    let exclusive = root.sourceMessages.length > 0;
    for (const message of root.sourceMessages) {
      const bound = await readWorkHubTaskInputBinding(stores, root.sessionId, message.messageId);
      if (
        !bound ||
        !belongsTo(bound, assignment) ||
        bound.execution?.turnId !== previous.turnId ||
        bound.execution.runId !== previous.runId
      ) {
        exclusive = false;
        break;
      }
    }
    if (!exclusive) continue;
    const ref = { sessionId: root.sessionId, turnId: root.turnId, runId: root.runId };
    if (next && (next.turnId !== ref.turnId || next.runId !== ref.runId))
      throw new Error('WorkHub input successor identity conflict');
    next = ref;
  }
  return next;
}
