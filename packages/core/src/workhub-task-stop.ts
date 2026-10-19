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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';
import type {
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
} from './session.js';

export const WORKHUB_TASK_STOP_MAX_TARGETS = 8;

/** A Host-captured execution binding, not a model-selected replacement target. */
export interface WorkHubTaskStopTarget {
  readonly workId: string;
  readonly generationId: string;
  readonly sourceActionId: string;
  readonly sourceDelegationId: string;
  readonly targetSessionId: string;
  readonly targetMessageId: string;
  readonly executionBinding: string;
}

/**
 * The first existing stop-request fact carries the complete confirmed set.
 * Later requests use deterministic child identities. There is no separate
 * parent journal or authority to recapture a newer generation on replay.
 */
export interface WorkHubTaskStopSet {
  readonly actionId: string;
  readonly targets: readonly WorkHubTaskStopTarget[];
}

export interface WorkHubTaskStopFields {
  readonly taskStop?: true;
  readonly stopSet?: WorkHubTaskStopSet;
}

const targetShape = defineObjectShape<WorkHubTaskStopTarget>()(
  [
    'workId',
    'generationId',
    'sourceActionId',
    'sourceDelegationId',
    'targetSessionId',
    'targetMessageId',
    'executionBinding',
  ],
  [],
);
const setShape = defineObjectShape<WorkHubTaskStopSet>()(['actionId', 'targets'], []);
const entity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const binding = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 4096 &&
  !value.includes('\0') &&
  new TextEncoder().encode(value).length <= 4096;

export function isWorkHubTaskStopTarget(value: unknown): value is WorkHubTaskStopTarget {
  return (
    isRecord(value) &&
    hasExactShape(value, targetShape) &&
    [
      'workId',
      'generationId',
      'sourceActionId',
      'sourceDelegationId',
      'targetSessionId',
      'targetMessageId',
    ].every((key) => entity(value[key])) &&
    binding(value.executionBinding)
  );
}

export function isWorkHubTaskStopSet(value: unknown): value is WorkHubTaskStopSet {
  return (
    isRecord(value) &&
    hasExactShape(value, setShape) &&
    entity(value.actionId) &&
    Array.isArray(value.targets) &&
    value.targets.length > 0 &&
    value.targets.length <= WORKHUB_TASK_STOP_MAX_TARGETS &&
    value.targets.every(isWorkHubTaskStopTarget) &&
    new Set(value.targets.map((target) => target.workId)).size === value.targets.length
  );
}

/** Validate this optional extension after validating the existing v3 stop envelope. */
export function isWorkHubTaskStopFields(value: Record<string, unknown>): boolean {
  if (value.taskStop === undefined) return value.stopSet === undefined;
  if (value.taskStop !== true || !entity(value.workId) || !binding(value.executionBinding))
    return false;
  if (value.stopSet === undefined) return true;
  if (!isWorkHubTaskStopSet(value.stopSet) || value.stopSet.actionId !== value.actionId)
    return false;
  const first = value.stopSet.targets[0]!;
  return (
    first.workId === value.workId &&
    first.sourceActionId === value.stopsActionId &&
    first.sourceDelegationId === value.stopsDelegationId &&
    first.targetSessionId === value.targetSessionId &&
    first.targetMessageId === value.targetMessageId &&
    first.executionBinding === value.executionBinding
  );
}

/** Projection policy only, never permission to cancel a Message or stop a Root. */
export function workHubStopRetiresDelegation(
  request: Pick<
    WorkHubDelegationStopRequestedMessage,
    'actionId' | 'stopsDelegationId' | 'taskStop'
  >,
  resolution?: Pick<
    WorkHubDelegationStopResolvedMessage,
    'actionId' | 'stopsDelegationId' | 'outcome' | 'cancelledWaitRequestId'
  >,
): boolean {
  if (resolution?.outcome === 'not_owned') return false;
  return !(
    request.taskStop === true &&
    resolution?.outcome === 'already_terminal' &&
    resolution.cancelledWaitRequestId === undefined &&
    resolution.actionId === request.actionId &&
    resolution.stopsDelegationId === request.stopsDelegationId
  );
}
