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

export const WORKHUB_TASK_INPUT_TEXT_MAX_BYTES = 48 * 1024;

export interface WorkHubTaskInputSource {
  readonly workId: string;
  readonly generationId: string;
  readonly sourceActionId: string;
  readonly sourceDelegationId: string;
}
export interface WorkHubTaskInputRequest extends WorkHubTaskInputSource {
  readonly inputId: string;
  readonly text: string;
}

/** An accepted user input, committed with its target admission/update, not a model acknowledgment. */
export interface WorkHubTaskInputMessage extends WorkHubTaskInputSource {
  readonly type: 'workhub_coordination';
  readonly kind: 'task_input';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly inputId: string;
  readonly text: string;
  readonly targetSessionId: string;
  readonly targetMessageId: string;
  /** The prepared target content at this commit. Later edits are not delivery proof. */
  readonly targetContentDigest: `sha256:${string}`;
  readonly mode: 'steering' | 'queued_supplement' | 'continuation';
  readonly execution?: { readonly turnId: string; readonly runId: string };
}

const shape = defineObjectShape<WorkHubTaskInputMessage>()(
  [
    'type',
    'kind',
    'schemaVersion',
    'id',
    'turnId',
    'ts',
    'inputId',
    'workId',
    'generationId',
    'sourceActionId',
    'sourceDelegationId',
    'text',
    'targetSessionId',
    'targetMessageId',
    'targetContentDigest',
    'mode',
  ],
  ['execution'],
);
const entity = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

export function isWorkHubTaskInputMessage(value: unknown): value is WorkHubTaskInputMessage {
  if (!isRecord(value) || !hasExactShape(value, shape)) return false;
  if (
    value.type !== 'workhub_coordination' ||
    value.kind !== 'task_input' ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.ts) ||
    (value.ts as number) < 0 ||
    ![
      'id',
      'turnId',
      'inputId',
      'workId',
      'generationId',
      'sourceActionId',
      'sourceDelegationId',
      'targetSessionId',
      'targetMessageId',
    ].every((key) => entity(value[key])) ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    new TextEncoder().encode(value.text).length > WORKHUB_TASK_INPUT_TEXT_MAX_BYTES ||
    typeof value.targetContentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.targetContentDigest)
  )
    return false;
  if (value.mode === 'steering')
    return (
      isRecord(value.execution) &&
      Object.keys(value.execution).length === 2 &&
      entity(value.execution.turnId) &&
      entity(value.execution.runId)
    );
  return (
    (value.mode === 'queued_supplement' || value.mode === 'continuation') &&
    value.execution === undefined
  );
}

/** Retry identity excludes delivery facts, which may advance after a committed input. */
export function workHubTaskInputMatches(
  a: WorkHubTaskInputMessage,
  b: WorkHubTaskInputSource & { readonly inputId: string; readonly text: string },
): boolean {
  return (
    a.inputId === b.inputId &&
    a.text === b.text &&
    a.workId === b.workId &&
    a.generationId === b.generationId &&
    a.sourceActionId === b.sourceActionId &&
    a.sourceDelegationId === b.sourceDelegationId
  );
}
