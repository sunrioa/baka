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

import { defineOperation } from './operation-spec.js';
import { invalidProtocolFrame } from './errors.js';
import {
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';

export const WORKHUB_TASK_MAX_ITEMS = 32;
export const WORKHUB_TASK_TEXT_MAX_BYTES = 1024;
export const WORKHUB_DELIVERY_MAX_BYTES = 16 * 1024;
export const WORKHUB_TASK_STATUSES = [
  'queued',
  'waiting_resource',
  'running',
  'waiting_for_dependency',
  'waiting_for_user',
  'pending_acceptance',
  'failed',
  'cancelled',
  'stopping',
  'stopped',
  'unavailable',
] as const;
export type WorkHubTaskStatus = (typeof WORKHUB_TASK_STATUSES)[number];
export interface WorkHubTaskRef {
  readonly actionId: string;
  readonly delegationId: string;
}
export interface WorkHubTask extends WorkHubTaskRef {
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly targetMessageId: string;
  readonly text: string;
  readonly createdAt: number;
  readonly status: WorkHubTaskStatus;
  readonly execution?: {
    readonly turnId: string;
    readonly runId: string;
    readonly sharedTurn: boolean;
  };
  readonly waitReason?: 'concurrency' | 'workspace';
  readonly dependency?: {
    readonly requestId: string;
    readonly question: string;
    readonly sourceActionId?: string;
  };
  readonly failure?: string;
}
export interface WorkHubTaskDetail {
  readonly task: WorkHubTask;
  /** Committed assistant text, not verified artifacts or independent test results. */
  readonly delivery?: {
    readonly text: string;
    readonly truncated: boolean;
    readonly terminalEventId: string;
  };
}
export interface WorkHubTasksQueryResult {
  readonly tasks: readonly WorkHubTask[];
  readonly truncated: boolean;
}
export function decodeWorkHubTaskRef(value: unknown): WorkHubTaskRef {
  const item = requireExactRecord(value, 'WorkHub task reference', ['actionId', 'delegationId']);
  return {
    actionId: requireEntityId(item.actionId, 'WorkHub action'),
    delegationId: requireEntityId(item.delegationId, 'WorkHub delegation'),
  };
}
function decodeTask(value: unknown): WorkHubTask {
  const item = requireShapedRecord(
    value,
    'WorkHub task',
    [
      'actionId',
      'delegationId',
      'targetSessionId',
      'targetSessionName',
      'targetMessageId',
      'text',
      'createdAt',
      'status',
    ],
    ['execution', 'waitReason', 'dependency', 'failure'],
  );
  if (
    !WORKHUB_TASK_STATUSES.includes(item.status as WorkHubTaskStatus) ||
    typeof item.createdAt !== 'number' ||
    !Number.isSafeInteger(item.createdAt) ||
    item.createdAt < 0
  )
    throw invalidProtocolFrame('Invalid WorkHub task state');
  if (
    item.waitReason !== undefined &&
    (item.status !== 'waiting_resource' ||
      !['concurrency', 'workspace'].includes(String(item.waitReason)))
  )
    throw invalidProtocolFrame('Invalid WorkHub resource wait');
  let execution: WorkHubTask['execution'];
  if (item.execution !== undefined) {
    const ref = requireExactRecord(item.execution, 'WorkHub execution', [
      'turnId',
      'runId',
      'sharedTurn',
    ]);
    if (typeof ref.sharedTurn !== 'boolean')
      throw invalidProtocolFrame('Invalid WorkHub execution ownership');
    execution = {
      turnId: requireEntityId(ref.turnId, 'WorkHub Turn'),
      runId: requireEntityId(ref.runId, 'WorkHub Run'),
      sharedTurn: ref.sharedTurn,
    };
  }
  let dependency: WorkHubTask['dependency'];
  if (item.dependency !== undefined) {
    const ref = requireShapedRecord(
      item.dependency,
      'WorkHub dependency',
      ['requestId', 'question'],
      ['sourceActionId'],
    );
    if (item.status !== 'waiting_for_dependency')
      throw invalidProtocolFrame('Invalid WorkHub dependency state');
    dependency = {
      requestId: requireEntityId(ref.requestId, 'WorkHub evidence request'),
      question: requireUtf8String(ref.question, 'WorkHub evidence question', 2048),
      ...(ref.sourceActionId !== undefined
        ? { sourceActionId: requireEntityId(ref.sourceActionId, 'WorkHub evidence source') }
        : {}),
    };
  }
  return {
    actionId: requireEntityId(item.actionId, 'WorkHub action'),
    delegationId: requireEntityId(item.delegationId, 'WorkHub delegation'),
    targetSessionId: requireEntityId(item.targetSessionId, 'WorkHub Session'),
    targetMessageId: requireEntityId(item.targetMessageId, 'WorkHub Message'),
    targetSessionName: requireUtf8String(item.targetSessionName, 'WorkHub task name', 512),
    text: requireUtf8String(item.text, 'WorkHub task text', WORKHUB_TASK_TEXT_MAX_BYTES),
    createdAt: item.createdAt,
    status: item.status as WorkHubTaskStatus,
    ...(execution ? { execution } : {}),
    ...(dependency ? { dependency } : {}),
    ...(item.waitReason ? { waitReason: item.waitReason as WorkHubTask['waitReason'] } : {}),
    ...(item.failure !== undefined
      ? { failure: requireUtf8String(item.failure, 'WorkHub task failure', 2048) }
      : {}),
  };
}
const errors = [
  'host_not_ready',
  'host_draining',
  'operation_unavailable',
  'not_found',
  'persistence_failed',
  'internal_failure',
] as const;
export const WORKHUB_TASK_OPERATION_SPECS = {
  'workhub.tasks.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors,
    decodeInput(value: unknown): Record<string, never> {
      requireExactRecord(value, 'WorkHub task query', []);
      return {};
    },
    decodeOutput(value: unknown): WorkHubTasksQueryResult {
      const item = requireExactRecord(value, 'WorkHub tasks', ['tasks', 'truncated']);
      if (
        !Array.isArray(item.tasks) ||
        item.tasks.length > WORKHUB_TASK_MAX_ITEMS ||
        typeof item.truncated !== 'boolean'
      )
        throw invalidProtocolFrame('Invalid WorkHub task bounds');
      const tasks = item.tasks.map(decodeTask);
      if (
        new Set(tasks.map((t) => t.actionId)).size !== tasks.length ||
        new Set(tasks.map((t) => t.delegationId)).size !== tasks.length
      )
        throw invalidProtocolFrame('Duplicate WorkHub tasks');
      return { tasks, truncated: item.truncated };
    },
  }),
  'workhub.tasks.read': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors,
    decodeInput: decodeWorkHubTaskRef,
    decodeOutput(value: unknown): WorkHubTaskDetail {
      const item = requireShapedRecord(value, 'WorkHub task detail', ['task'], ['delivery']);
      const task = decodeTask(item.task);
      if (item.delivery === undefined) return { task };
      const delivery = requireExactRecord(item.delivery, 'WorkHub delivery', [
        'text',
        'truncated',
        'terminalEventId',
      ]);
      if (
        !task.execution ||
        task.execution.sharedTurn ||
        !['pending_acceptance', 'failed', 'cancelled'].includes(task.status) ||
        typeof delivery.truncated !== 'boolean'
      )
        throw invalidProtocolFrame('Invalid WorkHub delivery ownership');
      return {
        task,
        delivery: {
          text: requireUtf8String(delivery.text, 'WorkHub delivery', WORKHUB_DELIVERY_MAX_BYTES),
          truncated: delivery.truncated,
          terminalEventId: requireEntityId(delivery.terminalEventId, 'WorkHub terminal event'),
        },
      };
    },
    assertOutputForInput(input, output) {
      if (
        input.actionId !== output.task.actionId ||
        input.delegationId !== output.task.delegationId
      )
        throw invalidProtocolFrame('WorkHub task response changed identity');
    },
  }),
} as const;
