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

export type WorkHubTaskSendInput = WorkHubTaskInputRequest;
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
      const item = requireExactRecord(value, 'WorkHub task input', [
        ...sourceKeys,
        'inputId',
        'text',
      ]);
      const text = requireUtf8String(
        item.text,
        'WorkHub task input text',
        WORKHUB_TASK_INPUT_TEXT_MAX_BYTES,
      );
      if (!text.trim()) throw invalidProtocolFrame('Empty WorkHub task input');
      return { ...source(item), inputId: requireEntityId(item.inputId, 'WorkHub input'), text };
    },
    decodeOutput: decodeResult,
    assertOutputForInput(input, output) {
      if (input.inputId !== output.inputId || sourceKeys.some((key) => input[key] !== output[key]))
        throw invalidProtocolFrame('WorkHub input receipt changed source');
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
