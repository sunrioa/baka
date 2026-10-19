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

import {
  WORKHUB_TASK_INPUT_TEXT_MAX_BYTES,
  type WorkHubTaskInputRequest,
  type WorkHubTaskInputSource,
  type WorkHubTaskInputMessage,
} from '@maka/core/workhub-task-input';
import { defineOperation } from './operation-spec.js';
import { invalidProtocolFrame } from './errors.js';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import type { SessionExecutionScope } from './session-continuity.js';
import {
  decodeWorkHubCoordinationActResult,
  type WorkHubCoordinationActResult,
} from './workhub-coordination.js';

/** New inputs name a task generation. Exact sources remain readable for saved legacy attempts. */
export type WorkHubTaskSendInput =
  | Pick<WorkHubTaskInputRequest, 'workId' | 'generationId' | 'inputId' | 'text'>
  | WorkHubTaskInputRequest;
export interface WorkHubTaskContinueFromTurnInput {
  readonly turnId: string;
  readonly actionId: string;
  readonly taskId: string;
  readonly text: string;
  readonly container?: 'reuse' | 'fresh';
}
export type WorkHubTaskContinueResult =
  | { readonly container: 'reuse'; readonly input: WorkHubTaskInputResult }
  | {
      readonly container: 'fresh';
      readonly action: Extract<WorkHubCoordinationActResult, { disposition: 'create_new' }>;
    };
export interface WorkHubTaskInputReadInput {
  readonly workId: string;
  readonly inputId: string;
}
export interface WorkHubTaskInputResult extends WorkHubTaskInputSource {
  readonly inputId: string;
  readonly acceptedAt: number;
  readonly mode: WorkHubTaskInputMessage['mode'];
  readonly targetSessionId: string;
  readonly targetMessageId: string;
  /** Delivery is proven by an immutable execution fact, not by this accepted receipt. */
  readonly delivery: 'queued' | 'delivered' | 'cancelled' | 'unproven';
  readonly execution?: SessionExecutionScope;
}
const sourceKeys = ['workId', 'generationId', 'sourceActionId', 'sourceDelegationId'] as const;
function source(item: Record<string, unknown>): WorkHubTaskInputSource {
  return {
    workId: requireEntityId(item.workId, 'WorkHub work'),
    generationId: requireEntityId(item.generationId, 'WorkHub generation'),
    sourceActionId: requireEntityId(item.sourceActionId, 'WorkHub source action'),
    sourceDelegationId: requireEntityId(item.sourceDelegationId, 'WorkHub source delegation'),
  };
}
function decodeResult(value: unknown): WorkHubTaskInputResult {
  const item = requireShapedRecord(
    value,
    'WorkHub input receipt',
    [
      ...sourceKeys,
      'inputId',
      'acceptedAt',
      'mode',
      'targetSessionId',
      'targetMessageId',
      'delivery',
    ],
    ['execution'],
  );
  if (
    !['steering', 'queued_supplement', 'continuation'].includes(String(item.mode)) ||
    !['queued', 'delivered', 'cancelled', 'unproven'].includes(String(item.delivery))
  )
    throw invalidProtocolFrame('Invalid WorkHub input delivery');
  let execution: SessionExecutionScope | undefined;
  if (item.execution !== undefined) {
    const scope = requireExactRecord(item.execution, 'WorkHub input execution', [
      'turnId',
      'runId',
    ]);
    execution = {
      turnId: requireEntityId(scope.turnId, 'WorkHub Turn'),
      runId: requireEntityId(scope.runId, 'WorkHub Run'),
    };
  }
  if ((item.delivery === 'delivered') !== !!execution)
    throw invalidProtocolFrame('WorkHub input delivery needs execution proof');
  return {
    ...source(item),
    inputId: requireEntityId(item.inputId, 'WorkHub input'),
    acceptedAt: requireCount(item.acceptedAt, 'WorkHub input time'),
    mode: item.mode as WorkHubTaskInputResult['mode'],
    targetSessionId: requireEntityId(item.targetSessionId, 'WorkHub target Session'),
    targetMessageId: requireEntityId(item.targetMessageId, 'WorkHub target Message'),
    delivery: item.delivery as WorkHubTaskInputResult['delivery'],
    ...(execution ? { execution } : {}),
  };
}
function inputText(value: unknown): string {
  const text = requireUtf8String(
    value,
    'WorkHub task input text',
    WORKHUB_TASK_INPUT_TEXT_MAX_BYTES,
  );
  if (!text.trim()) throw invalidProtocolFrame('Empty WorkHub task input');
  return text;
}
const errors = [
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
] as const;

export const WORKHUB_TASK_INPUT_OPERATION_SPECS = {
  'workhub.tasks.send': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors,
    decodeInput(value: unknown): WorkHubTaskSendInput {
      const item = requireShapedRecord(
        value,
        'WorkHub task input',
        ['workId', 'generationId', 'inputId', 'text'],
        ['sourceActionId', 'sourceDelegationId'],
      );
      const base = {
        workId: requireEntityId(item.workId, 'WorkHub work'),
        generationId: requireEntityId(item.generationId, 'WorkHub generation'),
        inputId: requireEntityId(item.inputId, 'WorkHub input'),
        text: inputText(item.text),
      };
      const exact =
        Object.hasOwn(item, 'sourceActionId') || Object.hasOwn(item, 'sourceDelegationId');
      return exact ? { ...base, ...source(item) } : base;
    },
    decodeOutput: decodeResult,
    assertOutputForInput(input, output) {
      if (
        input.inputId !== output.inputId ||
        input.workId !== output.workId ||
        input.generationId !== output.generationId ||
        ('sourceActionId' in input &&
          (input.sourceActionId !== output.sourceActionId ||
            input.sourceDelegationId !== output.sourceDelegationId))
      )
        throw invalidProtocolFrame('WorkHub input receipt changed source');
    },
  }),
  'workhub.tasks.continue': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors,
    decodeInput(value: unknown): WorkHubTaskContinueFromTurnInput {
      const item = requireShapedRecord(
        value,
        'WorkHub task continuation',
        ['turnId', 'actionId', 'taskId', 'text'],
        ['container'],
      );
      if (item.container !== undefined && !['reuse', 'fresh'].includes(String(item.container)))
        throw invalidProtocolFrame('Invalid WorkHub continuation container');
      return {
        turnId: requireEntityId(item.turnId, 'WorkHub coordinator Turn'),
        actionId: requireEntityId(item.actionId, 'WorkHub action'),
        taskId: requireEntityId(item.taskId, 'WorkHub task'),
        text: inputText(item.text),
        ...(item.container === undefined ? {} : { container: item.container as 'reuse' | 'fresh' }),
      };
    },
    decodeOutput(value: unknown): WorkHubTaskContinueResult {
      const item = requireShapedRecord(
        value,
        'WorkHub task continuation receipt',
        ['container'],
        ['input', 'action'],
      );
      if (
        item.container === 'reuse' &&
        Object.keys(item).length === 2 &&
        !Object.hasOwn(item, 'action')
      )
        return { container: 'reuse', input: decodeResult(item.input) };
      if (
        item.container === 'fresh' &&
        Object.keys(item).length === 2 &&
        !Object.hasOwn(item, 'input')
      ) {
        const action = decodeWorkHubCoordinationActResult(item.action);
        if (action.disposition === 'create_new' && action.workId)
          return { container: 'fresh', action };
      }
      throw invalidProtocolFrame('Invalid WorkHub task continuation receipt');
    },
    assertOutputForInput(input, output) {
      if (
        output.container !== (input.container ?? 'reuse') ||
        (output.container === 'reuse'
          ? output.input.inputId !== input.actionId || output.input.workId !== input.taskId
          : output.action.workId !== input.taskId)
      )
        throw invalidProtocolFrame('WorkHub task continuation changed identity');
    },
  }),
  'workhub.tasks.input.read': defineOperation({
    mode: 'query',
    availability: 'ready',
    errors,
    decodeInput(value: unknown): WorkHubTaskInputReadInput {
      const item = requireExactRecord(value, 'WorkHub input query', ['workId', 'inputId']);
      return {
        workId: requireEntityId(item.workId, 'WorkHub work'),
        inputId: requireEntityId(item.inputId, 'WorkHub input'),
      };
    },
    decodeOutput: decodeResult,
    assertOutputForInput(input, output) {
      if (input.workId !== output.workId || input.inputId !== output.inputId)
        throw invalidProtocolFrame('WorkHub input query changed identity');
    },
  }),
} as const;
