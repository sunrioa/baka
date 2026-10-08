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

import { assertExactKeys, requireEntityId, requireRecord, requireUtf8String } from './codec.js';
import { invalidProtocolFrame } from './errors.js';
import { defineOperation } from './operation-spec.js';
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
  readonly truncated: boolean;
}

export interface WorkHubInteractionAnswerInput {
  readonly actionId: string;
  readonly interactionId: string;
  readonly expectedTurnId: string;
  readonly expectedRunId: string;
  readonly answer: InteractionAnswer;
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
      const result = requireRecord(value, 'WorkHub inbox');
      assertExactKeys(result, 'WorkHub inbox', ['requests', 'truncated']);
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
      return { requests, truncated: result.truncated };
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
      const input = requireRecord(value, 'WorkHub interaction answer');
      assertExactKeys(input, 'WorkHub interaction answer', [
        'actionId',
        'interactionId',
        'expectedTurnId',
        'expectedRunId',
        'answer',
      ]);
      return {
        actionId: requireEntityId(input.actionId, 'WorkHub action ID'),
        interactionId: requireEntityId(input.interactionId, 'Interaction ID'),
        expectedTurnId: requireEntityId(input.expectedTurnId, 'Expected Turn ID'),
        expectedRunId: requireEntityId(input.expectedRunId, 'Expected Run ID'),
        answer: decodeInteractionAnswer(input.answer),
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
} as const;
