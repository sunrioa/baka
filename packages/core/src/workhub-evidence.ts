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

import { isRecord } from './record-schema.js';

export const WORKHUB_EVIDENCE_TOOL = 'WorkHubEvidence' as const;
export const WORKHUB_EVIDENCE_MAX_ROUNDS = 8;
export const WORKHUB_EVIDENCE_LIFETIME_MS = 60 * 60 * 1000;

/** Original Host-authenticated request, never an agent-authored user message. */
export interface WorkHubEvidenceRequestMessage {
  readonly type: 'workhub_evidence';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly expiresAt: number;
  readonly senderSessionId: string;
  readonly senderRunId: string;
  readonly senderInvocationId: string;
  readonly toolCallId: string;
  readonly actionId: string;
  readonly delegationId: string;
  readonly rootMessageId: string;
  readonly question: string;
  readonly round: number;
}

/** One immutable WorkHub reply binds a request to a visible task, not arbitrary agent text. */
export interface WorkHubEvidenceResolutionMessage {
  readonly type: 'workhub_evidence_resolution';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly requestId: string;
  readonly requesterSessionId: string;
  readonly senderRunId: string;
  readonly senderInvocationId: string;
  readonly toolCallId: string;
  readonly sourceActionId: string | null;
  readonly sourceDelegationId: string | null;
  readonly sourceSessionId: string | null;
  readonly sourceMessageId: string | null;
}

export interface WorkHubEvidenceOrigin {
  readonly kind: 'workhub_evidence';
  readonly requestId: string;
  readonly delegationId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
}

export interface WorkHubEvidenceWaitResult {
  readonly kind: 'workhub_evidence_waiting';
  readonly requestId: string;
}

export function isWorkHubEvidenceWaitResult(value: unknown): value is WorkHubEvidenceWaitResult {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.kind === 'workhub_evidence_waiting' &&
    typeof value.requestId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId)
  );
}

export function isWorkHubEvidenceRequest(value: unknown): value is WorkHubEvidenceRequestMessage {
  if (!isRecord(value)) return false;
  const ids = [
    'id',
    'turnId',
    'senderSessionId',
    'senderRunId',
    'senderInvocationId',
    'actionId',
    'delegationId',
    'rootMessageId',
  ];
  const keys = [
    'type',
    'schemaVersion',
    'ts',
    'expiresAt',
    'question',
    'round',
    'toolCallId',
    ...ids,
  ];
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.type === 'workhub_evidence' &&
    value.schemaVersion === 1 &&
    ids.every(
      (key) =>
        typeof value[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value[key] as string),
    ) &&
    typeof value.toolCallId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/u.test(value.toolCallId) &&
    typeof value.ts === 'number' &&
    Number.isSafeInteger(value.ts) &&
    value.ts >= 0 &&
    typeof value.expiresAt === 'number' &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > value.ts &&
    value.expiresAt - value.ts <= WORKHUB_EVIDENCE_LIFETIME_MS &&
    typeof value.round === 'number' &&
    Number.isSafeInteger(value.round) &&
    value.round >= 1 &&
    value.round <= WORKHUB_EVIDENCE_MAX_ROUNDS &&
    typeof value.question === 'string' &&
    value.question.trim().length > 0 &&
    value.question.length <= 4000
  );
}

export function isWorkHubEvidenceResolution(
  value: unknown,
): value is WorkHubEvidenceResolutionMessage {
  if (!isRecord(value)) return false;
  const ids = [
    'id',
    'turnId',
    'requestId',
    'requesterSessionId',
    'senderRunId',
    'senderInvocationId',
  ];
  const sourceIds = ['sourceActionId', 'sourceDelegationId', 'sourceSessionId', 'sourceMessageId'];
  const keys = ['type', 'schemaVersion', 'ts', 'toolCallId', ...ids, ...sourceIds];
  const validId = (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(id);
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    value.type === 'workhub_evidence_resolution' &&
    value.schemaVersion === 1 &&
    ids.every((key) => validId(value[key])) &&
    typeof value.ts === 'number' &&
    typeof value.toolCallId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/u.test(value.toolCallId) &&
    Number.isSafeInteger(value.ts) &&
    value.ts >= 0 &&
    (sourceIds.every((key) => value[key] === null) || sourceIds.every((key) => validId(value[key])))
  );
}
