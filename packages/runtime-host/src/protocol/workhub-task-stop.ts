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

import type { WorkHubDelegationStopOutcome } from '@maka/core/session';
import { WORKHUB_TASK_STOP_MAX_TARGETS } from '@maka/core/workhub-task-stop';
import { defineOperation } from './operation-spec.js';
import { invalidProtocolFrame } from './errors.js';
import { requireEntityId, requireExactRecord, requireShapedRecord } from './codec.js';

/** The actor/origin and exact execution are resolved by the Host, not accepted here. */
export interface WorkHubTaskStopInput {
  readonly turnId: string;
  readonly actionId: string;
  readonly taskIds: readonly string[];
}
export interface WorkHubTaskStopTargetResult {
  readonly workId: string;
  readonly generationId: string;
  readonly sourceActionId: string;
  readonly sourceDelegationId: string;
  readonly targetSessionId: string;
  readonly outcome: WorkHubDelegationStopOutcome | 'recovering';
  readonly targetTurnId?: string;
  readonly cancelledWaitRequestId?: string;
}
export type WorkHubTaskStopResult =
  | { readonly actionId: string; readonly kind: 'cancelled'; readonly taskIds: readonly string[] }
  | {
      readonly actionId: string;
      readonly kind: 'result';
      readonly targets: readonly WorkHubTaskStopTargetResult[];
    };

function taskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > WORKHUB_TASK_STOP_MAX_TARGETS)
    throw invalidProtocolFrame('Invalid task stop target count');
  const ids = value.map((id) => requireEntityId(id, 'WorkHub stop task'));
  if (new Set(ids).size !== ids.length) throw invalidProtocolFrame('Duplicate task stop target');
  return ids;
}

function targetResult(value: unknown): WorkHubTaskStopTargetResult {
  const item = requireShapedRecord(
    value,
    'WorkHub task stop outcome',
    [
      'workId',
      'generationId',
      'sourceActionId',
      'sourceDelegationId',
      'targetSessionId',
      'outcome',
    ],
    ['targetTurnId', 'cancelledWaitRequestId'],
  );
  const outcome = item.outcome;
  if (
    outcome !== 'cancelled_pending' &&
    outcome !== 'stop_delivered' &&
    outcome !== 'already_terminal' &&
    outcome !== 'not_owned' &&
    outcome !== 'recovering'
  )
    throw invalidProtocolFrame('Invalid task stop outcome');
  const targetTurnId =
    item.targetTurnId === undefined
      ? undefined
      : requireEntityId(item.targetTurnId, 'Stopped WorkHub Turn');
  if (
    (outcome === 'stop_delivered' && targetTurnId === undefined) ||
    (outcome === 'cancelled_pending' && targetTurnId !== undefined)
  )
    throw invalidProtocolFrame('Task stop outcome changed its execution scope');
  const cancelledWaitRequestId =
    item.cancelledWaitRequestId === undefined
      ? undefined
      : requireEntityId(item.cancelledWaitRequestId, 'Cancelled WorkHub wait');
  if (
    cancelledWaitRequestId !== undefined &&
    (outcome !== 'already_terminal' || targetTurnId === undefined)
  )
    throw invalidProtocolFrame('Only an ended execution fragment can cancel its pending wait');
  return {
    workId: requireEntityId(item.workId, 'Stopped work'),
    generationId: requireEntityId(item.generationId, 'Stopped generation'),
    sourceActionId: requireEntityId(item.sourceActionId, 'Stopped source action'),
    sourceDelegationId: requireEntityId(item.sourceDelegationId, 'Stopped delegation'),
    targetSessionId: requireEntityId(item.targetSessionId, 'Stopped Session'),
    outcome,
    ...(targetTurnId === undefined ? {} : { targetTurnId }),
    ...(cancelledWaitRequestId === undefined ? {} : { cancelledWaitRequestId }),
  };
}

export const WORKHUB_TASK_STOP_OPERATION_SPECS = {
  'workhub.tasks.stop': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'not_found',
      'session_archived',
      'session_busy',
      'operation_conflict',
      'persistence_failed',
      'commit_outcome_unknown',
      'internal_failure',
    ],
    decodeInput(value: unknown): WorkHubTaskStopInput {
      const item = requireExactRecord(value, 'WorkHub task stop', [
        'turnId',
        'actionId',
        'taskIds',
      ]);
      return {
        turnId: requireEntityId(item.turnId, 'WorkHub stop Turn'),
        actionId: requireEntityId(item.actionId, 'WorkHub stop action'),
        taskIds: taskIds(item.taskIds),
      };
    },
    decodeOutput(value: unknown): WorkHubTaskStopResult {
      const item = requireShapedRecord(
        value,
        'WorkHub task stop result',
        ['actionId', 'kind'],
        ['taskIds', 'targets'],
      );
      const actionId = requireEntityId(item.actionId, 'WorkHub stop action');
      if (item.kind === 'cancelled') {
        requireExactRecord(item, 'Cancelled task stop', ['actionId', 'kind', 'taskIds']);
        return { actionId, kind: 'cancelled', taskIds: taskIds(item.taskIds) };
      }
      if (item.kind !== 'result') throw invalidProtocolFrame('Invalid task stop result kind');
      requireExactRecord(item, 'Task stop outcomes', ['actionId', 'kind', 'targets']);
      if (
        !Array.isArray(item.targets) ||
        item.targets.length === 0 ||
        item.targets.length > WORKHUB_TASK_STOP_MAX_TARGETS
      )
        throw invalidProtocolFrame('Invalid task stop result count');
      const targets = item.targets.map(targetResult);
      if (new Set(targets.map((target) => target.workId)).size !== targets.length)
        throw invalidProtocolFrame('Duplicate task stop outcome');
      return { actionId, kind: 'result', targets };
    },
    assertOutputForInput(input, output) {
      const actual =
        output.kind === 'cancelled'
          ? output.taskIds
          : output.targets.map((target) => target.workId);
      if (
        output.actionId !== input.actionId ||
        actual.length !== input.taskIds.length ||
        actual.some((id, index) => id !== input.taskIds[index])
      )
        throw invalidProtocolFrame('Task stop receipt changed its action or target set');
    },
  }),
} as const;
