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

import { z } from 'zod';
import { ToolOutcomeUnknownError } from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { MakaTool, MakaToolContext } from '@maka/runtime/tool-runtime';
import type { OperationInput, OperationKey, OperationOutcome } from '../protocol/index.js';
import { clientCapabilityEntityId } from '../client-capability-entity-id.js';

export const WORKHUB_HOST_CONFIRMATION_TOOL_NAMES: readonly string[] = Object.freeze([
  'mcp__desktop_workhub__ask',
  'mcp__desktop_workhub__stop',
]);

const identity = z.string().min(1).max(128);
const question = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => value.trim().length > 0 && new TextEncoder().encode(value).length <= 2048,
    'Text must be nonempty and within the Host UTF-8 budget',
  )
  .trim();
const schemas = {
  ask: z
    .object({
      question,
      choices: z
        .array(z.object({ kind: z.enum(['task', 'session']), id: identity }).strict())
        .max(6),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.choices.map((choice) => `${choice.kind}:${choice.id}`)).size ===
        value.choices.length,
      'Duplicate task choices',
    ),
  stop: z
    .object({ taskIds: z.array(identity).min(1).max(8) })
    .strict()
    .refine(
      (value) => new Set(value.taskIds).size === value.taskIds.length,
      'Duplicate stop targets',
    ),
};

function result<K extends OperationKey>(outcome: OperationOutcome<K>) {
  if (outcome.ok) return outcome.result;
  if (outcome.error.code === 'commit_outcome_unknown')
    throw new ToolOutcomeUnknownError(outcome.error.message);
  throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
}

/** Host-owned Forms wait on their original Run, not an outer Desktop execution deadline. */
export function createWorkHubCoordinatorTools(options: {
  authorize(ctx: MakaToolContext): Promise<void>;
  ask(input: OperationInput<'workhub.tasks.ask'>): Promise<OperationOutcome<'workhub.tasks.ask'>>;
  stop(
    input: OperationInput<'workhub.tasks.stop'>,
  ): Promise<OperationOutcome<'workhub.tasks.stop'>>;
}): readonly MakaTool[] {
  async function authority(ctx: MakaToolContext) {
    ctx.abortSignal.throwIfAborted();
    if (
      ctx.sessionId !== WORKHUB_COORDINATION_SESSION_ID ||
      !ctx.runId ||
      !ctx.turnId ||
      !ctx.invocationId ||
      !ctx.toolCallId
    )
      throw new Error('WorkHub confirmations require the actual coordinator Root');
    // The retired Desktop native offer had no managed WorkHub admission policy.
    // Moving its Host operation must not open a restricted execution boundary.
    if (ctx.executionBoundary?.kind !== 'bypass' || ctx.permissionMode !== 'bypass')
      throw new Error('WorkHub confirmations require the existing bypass execution boundary');
    await options.authorize(ctx);
    ctx.abortSignal.throwIfAborted();
    return {
      turnId: ctx.turnId,
      actionId: clientCapabilityEntityId(
        JSON.stringify(['workhub-task', ctx.turnId, ctx.toolCallId]),
      ),
    };
  }
  return [
    {
      name: WORKHUB_HOST_CONFIRMATION_TOOL_NAMES[0]!,
      categoryHint: 'custom_tool',
      recoveryMode: 'outcome_unknown',
      parameters: schemas.ask,
      description:
        'Ask the user which task or eligible manual Session is intended, using choices from find. The Host always adds a new-task option. This only records a selection: it does not delegate, steer or grant approval. After selection, act only within the user request; cancellation has no effect. Use AskUserQuestion for ordinary requirements, and the task approval interface for permissions.',
      async impl(raw, ctx) {
        const input = schemas.ask.parse(raw);
        const outcome = await options.ask({ ...input, ...(await authority(ctx)) });
        ctx.abortSignal.throwIfAborted();
        return result(outcome);
      },
    },
    {
      name: WORKHUB_HOST_CONFIRMATION_TOOL_NAMES[1]!,
      categoryHint: 'custom_tool',
      recoveryMode: 'outcome_unknown',
      parameters: schemas.stop,
      description:
        'Stop or withdraw only the named tasks. The Host proves actual origin and execution, not natural-language intent. A user-started Turn may stop one distinct task directly; automatic feedback, a known multi-task set, or a second different target in the same Turn require the existing native confirmation. Bypass does not skip it. Results can be stopped, already terminal, not owned or recovering: report each exact outcome, never claim every target stopped. Do not retry an unknown outcome with a different identity or target.',
      async impl(raw, ctx) {
        const input = schemas.stop.parse(raw);
        const outcome = await options.stop({ ...input, ...(await authority(ctx)) });
        ctx.abortSignal.throwIfAborted();
        const stopped = result(outcome);
        return stopped.kind === 'cancelled'
          ? { kind: stopped.kind, taskIds: stopped.taskIds }
          : {
              kind: stopped.kind,
              targets: stopped.targets.map((target) => ({
                taskId: target.workId,
                outcome: target.outcome,
              })),
            };
      },
    },
  ];
}
