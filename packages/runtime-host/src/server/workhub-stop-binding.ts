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

type StopSource = Pick<
  WorkHubDelegationAssignedMessage,
  'actionId' | 'delegationId' | 'targetSessionId' | 'targetMessageId'
>;

export interface WorkHubStopTarget {
  readonly binding: string;
  readonly execution?: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
  };
  readonly initialExecution?: WorkHubStopTarget['execution'];
}

export function workHubPendingStopBinding(source: StopSource): string {
  return JSON.stringify([
    'pending_message',
    source.actionId,
    source.delegationId,
    source.targetSessionId,
    source.targetMessageId,
  ]);
}

/** Same Message, including its first owned execution, never a later continuation. */
export function workHubStopBindingMatches(
  source: StopSource,
  expected: string,
  current: WorkHubStopTarget,
): boolean {
  if (current.binding === expected) return true;
  const pending = workHubPendingStopBinding(source);
  if (expected !== pending && expected !== '{"kind":"pending"}') return false;
  // Old durable pending claims remain valid while this same Message is queued.
  if (current.binding === pending && current.execution === undefined) return true;
  const { execution, initialExecution } = current;
  return (
    execution !== undefined &&
    initialExecution !== undefined &&
    execution.sessionId === source.targetSessionId &&
    execution.sessionId === initialExecution.sessionId &&
    execution.turnId === initialExecution.turnId &&
    execution.runId === initialExecution.runId
  );
}
