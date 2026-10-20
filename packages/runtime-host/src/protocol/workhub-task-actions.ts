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

import { isWorkHubCreateDefaults, type WorkHubCreateDefaults } from '@maka/core/session';
import { defineHostPathOperation, defineOperation } from './operation-spec.js';
import { invalidProtocolFrame } from './errors.js';
import {
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import {
  decodeWorkHubCoordinationCreateContext,
  decodeWorkHubCoordinationActResult,
  decodeWorkHubContextObservation,
  WORKHUB_COORDINATION_TEXT_MAX_BYTES,
  type WorkHubCoordinationActResult,
  type WorkHubCoordinationCreateContext,
  type WorkHubContextObservation,
} from './workhub-coordination.js';

interface StartFields {
  readonly turnId: string;
  readonly actionId: string;
  readonly title: string;
  readonly text: string;
}
/** Creation settings are supplied by the Desktop, not by the model tool schema. */
export type WorkHubTaskStartInput = StartFields &
  (
    | { readonly sessionRef: string; readonly create?: never; readonly newWorkDefaults?: never }
    | {
        readonly sessionRef?: never;
        readonly create: WorkHubCoordinationCreateContext;
        readonly newWorkDefaults: WorkHubCreateDefaults;
      }
  );
export type WorkHubTaskStartResult = Extract<
  WorkHubCoordinationActResult,
  { disposition: 'create_new' | 'delegate_existing' }
>;
export interface WorkHubTaskChoice {
  readonly kind: 'task' | 'session';
  readonly id: string;
}
export interface WorkHubTaskAskInput {
  readonly turnId: string;
  readonly actionId: string;
  readonly question: string;
  readonly choices: readonly WorkHubTaskChoice[];
}
export type WorkHubTaskAskResult =
  | { readonly kind: 'cancelled' | 'new_task' }
  | {
      readonly kind: 'selected';
      readonly target: WorkHubTaskChoice;
      readonly generationId?: string;
      readonly context?: WorkHubContextObservation;
    };

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
function text(value: unknown, label: string, bytes: number) {
  const result = requireUtf8String(value, label, bytes);
  if (!result.trim()) throw invalidProtocolFrame(`Empty ${label}`);
  return result;
}
function choice(value: unknown): WorkHubTaskChoice {
  const item = requireExactRecord(value, 'WorkHub task choice', ['kind', 'id']);
  if (item.kind !== 'task' && item.kind !== 'session')
    throw invalidProtocolFrame('Invalid task choice kind');
  return { kind: item.kind, id: requireEntityId(item.id, 'WorkHub choice identity') };
}

export const WORKHUB_TASK_ACTION_OPERATION_SPECS = {
  'workhub.tasks.start': defineHostPathOperation(
    {
      mode: 'command',
      availability: 'ready',
      errors,
      decodeInput(value: unknown): WorkHubTaskStartInput {
        const item = requireShapedRecord(
          value,
          'WorkHub task start',
          ['turnId', 'actionId', 'title', 'text'],
          ['sessionRef', 'create', 'newWorkDefaults'],
        );
        const title = text(item.title, 'WorkHub task title', 2048).trim();
        if (Array.from(title).length > 512 || /[\u0000-\u001f\u007f]/u.test(title))
          throw invalidProtocolFrame('Invalid task title');
        const base = {
          turnId: requireEntityId(item.turnId, 'WorkHub Turn'),
          actionId: requireEntityId(item.actionId, 'WorkHub action'),
          title,
          text: text(item.text, 'WorkHub task text', WORKHUB_COORDINATION_TEXT_MAX_BYTES),
        };
        if (item.sessionRef !== undefined) {
          if (item.create !== undefined || item.newWorkDefaults !== undefined)
            throw invalidProtocolFrame(
              'Existing Session settings cannot be overridden by task start',
            );
          return {
            ...base,
            sessionRef: requireEntityId(item.sessionRef, 'WorkHub Session reference'),
          };
        }
        if (item.newWorkDefaults === undefined)
          throw invalidProtocolFrame('Task start requires effective new-task settings');
        const defaults = item.newWorkDefaults;
        if (!isWorkHubCreateDefaults(defaults))
          throw invalidProtocolFrame('Invalid WorkHub creation defaults');
        if (!defaults.permissionMode || (!defaults.model && !defaults.executorId))
          throw invalidProtocolFrame(
            'Task start needs an explicit execution target and permission mode',
          );
        return {
          ...base,
          create: decodeWorkHubCoordinationCreateContext(
            item.create ?? { workspace: { kind: 'isolated' } },
          ),
          newWorkDefaults: defaults,
        };
      },
      decodeOutput(value: unknown): WorkHubTaskStartResult {
        const result = decodeWorkHubCoordinationActResult(value);
        if (result.disposition !== 'create_new' && result.disposition !== 'delegate_existing')
          throw invalidProtocolFrame('Task start did not admit independent work');
        return result;
      },
      assertOutputForInput(input, output) {
        if (
          output.workId !== input.actionId ||
          (input.sessionRef
            ? output.disposition !== 'delegate_existing' ||
              output.targetSessionId !== input.sessionRef
            : output.disposition !== 'create_new')
        )
          throw invalidProtocolFrame('Task start receipt changed its identity');
      },
    },
    (input) => input.create?.workspace.kind === 'host_path',
  ),
  'workhub.tasks.ask': defineOperation({
    mode: 'command',
    availability: 'ready',
    errors,
    decodeInput(value: unknown): WorkHubTaskAskInput {
      const item = requireExactRecord(value, 'WorkHub task selection', [
        'turnId',
        'actionId',
        'question',
        'choices',
      ]);
      if (!Array.isArray(item.choices) || item.choices.length > 6)
        throw invalidProtocolFrame('Invalid task selection offer');
      const choices = item.choices.map(choice);
      if (new Set(choices.map((x) => `${x.kind}:${x.id}`)).size !== choices.length)
        throw invalidProtocolFrame('Duplicate task choices');
      return {
        turnId: requireEntityId(item.turnId, 'WorkHub Turn'),
        actionId: requireEntityId(item.actionId, 'WorkHub action'),
        question: text(item.question, 'WorkHub question', 2048),
        choices,
      };
    },
    decodeOutput(value: unknown): WorkHubTaskAskResult {
      const item = requireShapedRecord(
        value,
        'WorkHub task selection result',
        ['kind'],
        ['target', 'generationId', 'context'],
      );
      if (item.kind === 'cancelled' || item.kind === 'new_task') {
        requireExactRecord(item, 'WorkHub selection without target', ['kind']);
        return { kind: item.kind };
      }
      if (item.kind !== 'selected') throw invalidProtocolFrame('Invalid task selection result');
      const target = choice(item.target);
      if ((target.kind === 'task') !== (item.generationId !== undefined))
        throw invalidProtocolFrame('Task selection needs its generation');
      return {
        kind: 'selected',
        target,
        ...(item.generationId === undefined
          ? {}
          : { generationId: requireEntityId(item.generationId, 'WorkHub generation') }),
        ...(item.context === undefined
          ? {}
          : { context: decodeWorkHubContextObservation(item.context) }),
      };
    },
    assertOutputForInput(input, output) {
      if (
        output.kind === 'selected' &&
        !input.choices.some((x) => x.kind === output.target.kind && x.id === output.target.id)
      )
        throw invalidProtocolFrame('Task selection is outside its offer');
    },
  }),
} as const;
