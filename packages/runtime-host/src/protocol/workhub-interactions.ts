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
  assertExactKeys,
  requireEntityId,
  requireRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
import { decodeTaskExecutionGrant, type TaskExecutionGrant } from '@maka/core/task-execution-grant';
import {
  decodeInteractionAnswer,
  decodeInteractionSnapshot,
  INTERACTION_OPERATION_SPECS,
  type InteractionAnswer,
  type InteractionPendingSnapshot,
} from './interaction.js';

export const WORKHUB_INBOX_MAX_ITEMS = 32;

export interface WorkHubPendingInteraction {
  readonly actionId: string;
  readonly delegationId: string;
  readonly targetSessionName: string;
  readonly interaction: InteractionPendingSnapshot;
}

export interface WorkHubInteractionsQueryResult {
  readonly requests: readonly WorkHubPendingInteraction[];
  readonly grants?: readonly WorkHubTaskGrant[];
  readonly truncated: boolean;
}

export interface WorkHubTaskGrant {
  readonly actionId: string;
  readonly targetSessionName: string;
  readonly grant: TaskExecutionGrant;
}

export interface WorkHubInteractionAnswerInput {
  readonly actionId: string;
  readonly interactionId: string;
  readonly expectedTurnId: string;
  readonly expectedRunId: string;
  readonly answer: InteractionAnswer;
  readonly grantScope?: 'task';
}

export const WORKHUB_INTERACTION_OPERATION_SPECS = {
  'workhub.interactions.query': defineOperation({
    mode: 'query',
    availability: 'ready',
    decodeInput(value: unknown): Record<string, never> {
      assertExactKeys(requireRecord(value, 'WorkHub inbox query'), 'WorkHub inbox query', []);
      return {};
    },
    decodeOutput(value: unknown): WorkHubInteractionsQueryResult {
      const result = requireShapedRecord(
        value,
        'WorkHub inbox',
        ['requests', 'truncated'],
        ['grants'],
      );
      if (
        !Array.isArray(result.requests) ||
        result.requests.length > WORKHUB_INBOX_MAX_ITEMS ||
        typeof result.truncated !== 'boolean'
      )
        throw invalidProtocolFrame('Invalid WorkHub inbox bounds');
      const seen = new Set<string>();
      const requests = result.requests.map((value): WorkHubPendingInteraction => {
        const item = requireRecord(value, 'WorkHub inbox item');
        assertExactKeys(item, 'WorkHub inbox item', [
          'actionId',
          'delegationId',
          'targetSessionName',
          'interaction',
        ]);
        const interaction = decodeInteractionSnapshot(item.interaction);
        const key = JSON.stringify([interaction.sessionId, interaction.interactionId]);
        if (interaction.status !== 'pending' || seen.has(key))
          throw invalidProtocolFrame('Invalid WorkHub pending request');
        seen.add(key);
        return {
          actionId: requireEntityId(item.actionId, 'WorkHub action ID'),
          delegationId: requireEntityId(item.delegationId, 'WorkHub delegation ID'),
          targetSessionName: requireUtf8String(item.targetSessionName, 'WorkHub task name', 512),
          interaction,
        };
      });
      if (
        result.grants !== undefined &&
        (!Array.isArray(result.grants) || result.grants.length > WORKHUB_INBOX_MAX_ITEMS)
      )
        throw invalidProtocolFrame('Invalid WorkHub grant bounds');
      const grants = ((result.grants as unknown[] | undefined) ?? []).map(
        (value): WorkHubTaskGrant => {
          const item = requireRecord(value, 'WorkHub task grant');
          assertExactKeys(item, 'WorkHub task grant', ['actionId', 'targetSessionName', 'grant']);
          let grant: TaskExecutionGrant;
          try {
            grant = decodeTaskExecutionGrant(item.grant);
          } catch {
            throw invalidProtocolFrame('Invalid WorkHub task grant');
          }
          return {
            actionId: requireEntityId(item.actionId, 'WorkHub action ID'),
            targetSessionName: requireUtf8String(item.targetSessionName, 'WorkHub task name', 512),
            grant,
          };
        },
      );
      if (new Set(grants.map((item) => item.grant.grantId)).size !== grants.length)
        throw invalidProtocolFrame('Duplicate task grants');
      return { requests, grants, truncated: result.truncated };
    },
    errors: [
      'host_not_ready',
      'host_draining',
      'operation_unavailable',
      'internal_failure',
    ] as const,
  }),
  'workhub.interactions.answer': defineOperation({
    mode: 'command',
    availability: 'ready',
    decodeInput(value: unknown): WorkHubInteractionAnswerInput {
      const input = requireShapedRecord(
        value,
        'WorkHub interaction answer',
        ['actionId', 'interactionId', 'expectedTurnId', 'expectedRunId', 'answer'],
        ['grantScope'],
      );
      const answer = decodeInteractionAnswer(input.answer);
      if (
        input.grantScope !== undefined &&
        (input.grantScope !== 'task' ||
          (answer.kind !== 'sandbox_boundary' && answer.kind !== 'client_capability') ||
          answer.decision !== 'allow')
      )
        throw invalidProtocolFrame('Invalid task grant answer');
      return {
        actionId: requireEntityId(input.actionId, 'WorkHub action ID'),
        interactionId: requireEntityId(input.interactionId, 'Interaction ID'),
        expectedTurnId: requireEntityId(input.expectedTurnId, 'Expected Turn ID'),
        expectedRunId: requireEntityId(input.expectedRunId, 'Expected Run ID'),
        answer,
        ...(input.grantScope === 'task' ? { grantScope: 'task' as const } : {}),
      };
    },
    decodeOutput: INTERACTION_OPERATION_SPECS['interaction.answer'].decodeOutput,
    errors: INTERACTION_OPERATION_SPECS['interaction.answer'].errors,
    assertOutputForInput(input, output) {
      if (
        output.interactionId !== input.interactionId ||
        output.turnId !== input.expectedTurnId ||
        output.runId !== input.expectedRunId
      )
        throw invalidProtocolFrame('WorkHub answer receipt identity mismatch');
    },
  }),
  'workhub.interactions.revoke': defineOperation({
    mode: 'command',
    availability: 'ready',
    decodeInput(value: unknown): { actionId: string; grantId: string } {
      const input = requireRecord(value, 'WorkHub grant revocation');
      assertExactKeys(input, 'WorkHub grant revocation', ['actionId', 'grantId']);
      return {
        actionId: requireEntityId(input.actionId, 'WorkHub action ID'),
        grantId: requireEntityId(input.grantId, 'Task grant ID'),
      };
    },
    decodeOutput(value: unknown): { grantId: string } {
      const result = requireRecord(value, 'WorkHub grant revocation');
      assertExactKeys(result, 'WorkHub grant revocation', ['grantId']);
      return { grantId: requireEntityId(result.grantId, 'Task grant ID') };
    },
    errors: INTERACTION_OPERATION_SPECS['interaction.answer'].errors,
    assertOutputForInput(input, output) {
      if (input.grantId !== output.grantId)
        throw invalidProtocolFrame('Task grant receipt mismatch');
    },
  }),
} as const;
