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

import { decodeModelCallAttempt, type ModelCallAttempt } from '@maka/core/model-call-attempt';

type Row = Record<string, unknown>;
const row = (v: unknown): Row => (v !== null && typeof v === 'object' ? (v as Row) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const nonnegative = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Existing collector SQL columns are preserved as observations, not padded into fictional attempts. */
export type WorkHubRequestObservation = Pick<
  ModelCallAttempt,
  | 'attemptId'
  | 'turnId'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadInputTokens'
  | 'cacheWriteInputTokens'
  | 'cacheMissInputTokens'
  | 'usageBasis'
  | 'costBasis'
  | 'costUsd'
> & {
  readonly source: 'model_call_attempt' | 'usage_model_call_attempts';
};

export function workHubRequestObservation(value: unknown): WorkHubRequestObservation | undefined {
  const r = row(value);
  if (!Object.hasOwn(r, 'attempt_id')) {
    try {
      return { ...decodeModelCallAttempt(value), source: 'model_call_attempt' };
    } catch {
      return undefined;
    }
  }
  if (
    ![
      'attempt_id',
      'logical_call_id',
      'session_id',
      'turn_id',
      'call_kind',
      'provider_id',
      'model_id',
    ].every((k) => str(r[k])) ||
    !['completed', 'failed', 'interrupted', 'aborted'].includes(str(r.status)) ||
    !['reported', 'partial', 'missing'].includes(str(r.usage_basis)) ||
    !['priced', 'unpriced'].includes(str(r.cost_basis)) ||
    !nonnegative(r.completed_at) ||
    !nonnegative(r.latency_ms)
  )
    return undefined;
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_miss_input_tokens',
    'cache_write_input_tokens',
  ]) {
    if (r[key] !== null && r[key] !== undefined && !nonnegative(r[key])) return undefined;
    if (r.usage_basis === 'missing' && r[key] !== null && r[key] !== undefined) return undefined;
  }
  if (
    r.cost_basis === 'priced'
      ? !nonnegative(r.cost_usd)
      : r.cost_usd !== null && r.cost_usd !== undefined
  )
    return undefined;
  return {
    attemptId: str(r.attempt_id),
    turnId: str(r.turn_id),
    usageBasis: r.usage_basis as ModelCallAttempt['usageBasis'],
    costBasis: r.cost_basis as ModelCallAttempt['costBasis'],
    source: 'usage_model_call_attempts',
    ...(nonnegative(r.input_tokens) ? { inputTokens: r.input_tokens } : {}),
    ...(nonnegative(r.output_tokens) ? { outputTokens: r.output_tokens } : {}),
    ...(nonnegative(r.cache_read_input_tokens)
      ? { cacheReadInputTokens: r.cache_read_input_tokens }
      : {}),
    ...(nonnegative(r.cache_miss_input_tokens)
      ? { cacheMissInputTokens: r.cache_miss_input_tokens }
      : {}),
    ...(nonnegative(r.cache_write_input_tokens)
      ? { cacheWriteInputTokens: r.cache_write_input_tokens }
      : {}),
    ...(nonnegative(r.cost_usd) ? { costUsd: r.cost_usd } : {}),
  };
}

/** Prefer immutable Root admissions; task-pane inputs already carry Host-authenticated provenance. */
export function workHubTrigger(value: unknown): Row {
  const original = row(value);
  const r = original.admission ? row(original.admission) : original;
  if (row(r.execution).kind === 'workhub_coordination')
    return {
      turnId: r.turnId,
      sourceMessageId: r.userMessageId,
      inputOrigin: row(r.execution).feedback ? 'feedback' : 'user',
      surface: 'main',
      userText: row(row(original.sourceMessage).content ?? r.normalizedInput).text,
    };
  if (r.kind === 'task_input')
    return {
      turnId: r.turnId,
      sourceMessageId: r.sourceMessageId ?? r.inputId,
      inputOrigin: r.inputOrigin,
      surface: 'task',
      userText: r.originalUserText ?? r.text,
    };
  return original;
}

/** Accept Desktop callbacks, raw visible function calls, or the existing collector's projection. */
export function workHubToolCall(value: unknown): Row | undefined {
  const r = row(value),
    content = row(r.content);
  if (r.kind === 'function_response' || content.kind === 'function_response') return undefined;
  if (row(r.request).kind) return r;
  const args = row(content.args),
    legacy = row(args.request);
  const name = str(r.name ?? content.name);
  const operation = str(
    r.operation ??
      legacy.operation ??
      (name.startsWith('mcp__desktop_workhub__')
        ? name.slice('mcp__desktop_workhub__'.length)
        : ''),
  );
  return {
    ...r,
    name,
    toolCallId: r.toolCallId ?? content.id,
    request: {
      kind:
        operation ||
        (name.startsWith('WorkHub') &&
        !['WorkHubRead', 'WorkHubResult', 'WorkHubInspect'].includes(name)
          ? `retired:${name}`
          : 'read'),
      input: {
        ...args,
        taskId: args.taskId ?? r.selectedWorkId ?? legacy.workId,
        text: args.text ?? legacy.text,
      },
    },
  };
}

export function isWorkHubWriteCall(call: Row): boolean {
  const kind = str(row(call.request).kind);
  return !['find', 'read', 'status', 'works', 'candidates', 'projects', 'list'].includes(kind);
}
