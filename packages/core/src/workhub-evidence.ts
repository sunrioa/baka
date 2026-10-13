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
  /** An explicit wait on an already accepted peer question; absent for legacy evidence. */
  readonly peerQuestionId?: string;
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
    Object.keys(value).every((key) => keys.includes(key) || key === 'peerQuestionId') &&
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
    value.question.length <= 4000 &&
    (value.peerQuestionId === undefined || isWorkHubPeerQuestionId(value.peerQuestionId))
  );
}

/** Fixed task lineage, not a permission or a mutable Session selection. */
export interface WorkHubPeerTaskRef {
  readonly workId: string;
  readonly generationId: string;
  readonly actionId: string;
  readonly delegationId: string;
  readonly sessionId: string;
  readonly messageId: string;
}

export interface WorkHubPeerQuestionMessage {
  readonly type: 'workhub_peer_question';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly expiresAt: number;
  readonly sender: WorkHubPeerTaskRef;
  readonly recipient: WorkHubPeerTaskRef;
  readonly senderRunId: string;
  readonly senderInvocationId: string;
  readonly toolCallId: string;
  readonly question: string;
  readonly round: number;
}

/** Small reference in B; the question body remains in A's existing store. */
export interface WorkHubPeerInboxMessage {
  readonly type: 'workhub_peer_inbox';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly expiresAt: number;
  readonly requesterSessionId: string;
  readonly questionId: string;
  readonly target: WorkHubPeerTaskRef;
}

/** Reply and cancellation compete for the same immutable terminal fact. */
export interface WorkHubPeerSettlementMessage {
  readonly type: 'workhub_peer_settlement';
  readonly schemaVersion: 1;
  readonly id: string;
  readonly turnId: string;
  readonly ts: number;
  readonly requesterSessionId: string;
  readonly questionId: string;
  readonly actor: WorkHubPeerTaskRef;
  readonly senderRunId: string;
  readonly senderInvocationId: string;
  readonly toolCallId: string;
  readonly outcome: 'reply' | 'cancelled';
  readonly answer?: string;
}

export type WorkHubPeerMessage =
  | WorkHubPeerQuestionMessage
  | WorkHubPeerInboxMessage
  | WorkHubPeerSettlementMessage;

export const WORKHUB_PEER_QUESTION_MAX_BYTES = 2048;
export const WORKHUB_PEER_ANSWER_MAX_BYTES = 3072;
const validPeerId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const validPeerTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const taskShape = defineObjectShape<WorkHubPeerTaskRef>()(
  ['workId', 'generationId', 'actionId', 'delegationId', 'sessionId', 'messageId'],
  [],
);
export function isWorkHubPeerTaskRef(value: unknown): value is WorkHubPeerTaskRef {
  return (
    isRecord(value) && hasExactShape(value, taskShape) && Object.values(value).every(validPeerId)
  );
}

export function isWorkHubPeerQuestionId(value: unknown): value is string {
  return typeof value === 'string' && /^whpq_[a-f0-9]{48}$/u.test(value);
}
export const workHubPeerInboxId = (questionId: string) => `whpi_${questionId.slice(5)}`;
export const workHubPeerSettlementId = (questionId: string) => `whps_${questionId.slice(5)}`;
/** The Host and storage hash this true invocation identity. Payload is deliberately excluded. */
export function workHubPeerQuestionIdentity(
  value: Pick<
    WorkHubPeerQuestionMessage,
    'sender' | 'turnId' | 'senderRunId' | 'senderInvocationId' | 'toolCallId'
  >,
): string {
  return JSON.stringify([
    value.sender.sessionId,
    value.turnId,
    value.senderRunId,
    value.senderInvocationId,
    value.toolCallId,
  ]);
}
export function isWorkHubPeerText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes
  );
}
const questionShape = defineObjectShape<WorkHubPeerQuestionMessage>()(
  [
    'type',
    'schemaVersion',
    'id',
    'turnId',
    'ts',
    'expiresAt',
    'sender',
    'recipient',
    'senderRunId',
    'senderInvocationId',
    'toolCallId',
    'question',
    'round',
  ],
  [],
);
const inboxShape = defineObjectShape<WorkHubPeerInboxMessage>()(
  [
    'type',
    'schemaVersion',
    'id',
    'turnId',
    'ts',
    'expiresAt',
    'requesterSessionId',
    'questionId',
    'target',
  ],
  [],
);
const settlementShape = defineObjectShape<WorkHubPeerSettlementMessage>()(
  [
    'type',
    'schemaVersion',
    'id',
    'turnId',
    'ts',
    'requesterSessionId',
    'questionId',
    'actor',
    'senderRunId',
    'senderInvocationId',
    'toolCallId',
    'outcome',
  ],
  ['answer'],
);
export function isWorkHubPeerMessage(value: unknown): value is WorkHubPeerMessage {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !validPeerId(value.turnId) ||
    !validPeerTime(value.ts)
  )
    return false;
  const lifetime = () =>
    validPeerTime(value.expiresAt) &&
    value.expiresAt > (value.ts as number) &&
    value.expiresAt - (value.ts as number) <= WORKHUB_EVIDENCE_LIFETIME_MS;
  const invocation = () =>
    validPeerId(value.senderRunId) &&
    validPeerId(value.senderInvocationId) &&
    typeof value.toolCallId === 'string' &&
    /^[A-Za-z0-9_.:-]{1,256}$/u.test(value.toolCallId);
  switch (value.type) {
    case 'workhub_peer_question':
      return (
        hasExactShape(value, questionShape) &&
        isWorkHubPeerQuestionId(value.id) &&
        lifetime() &&
        invocation() &&
        isWorkHubPeerTaskRef(value.sender) &&
        isWorkHubPeerTaskRef(value.recipient) &&
        value.sender.sessionId !== value.recipient.sessionId &&
        validPeerTime(value.round) &&
        value.round >= 1 &&
        value.round <= WORKHUB_EVIDENCE_MAX_ROUNDS &&
        isWorkHubPeerText(value.question, WORKHUB_PEER_QUESTION_MAX_BYTES)
      );
    case 'workhub_peer_inbox':
      return (
        hasExactShape(value, inboxShape) &&
        isWorkHubPeerQuestionId(value.questionId) &&
        value.id === workHubPeerInboxId(value.questionId) &&
        lifetime() &&
        validPeerId(value.requesterSessionId) &&
        isWorkHubPeerTaskRef(value.target) &&
        value.requesterSessionId !== value.target.sessionId
      );
    case 'workhub_peer_settlement':
      return (
        hasExactShape(value, settlementShape) &&
        isWorkHubPeerQuestionId(value.questionId) &&
        value.id === workHubPeerSettlementId(value.questionId) &&
        validPeerId(value.requesterSessionId) &&
        isWorkHubPeerTaskRef(value.actor) &&
        invocation() &&
        ((value.outcome === 'reply' &&
          isWorkHubPeerText(value.answer, WORKHUB_PEER_ANSWER_MAX_BYTES)) ||
          (value.outcome === 'cancelled' && value.answer === undefined))
      );
    default:
      return false;
  }
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
