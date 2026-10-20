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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCanonicalMessage, deriveTurnRecords } from '../session.js';
import { decodeTurnOrigin } from '../turn-origin.js';
import { threadSearchMatchKind } from '../transcript-search.js';
import {
  isWorkHubEvidenceRequest,
  isWorkHubEvidenceResolution,
  isWorkHubEvidenceWaitResult,
} from '../workhub-evidence.js';

const request = {
  type: 'workhub_evidence',
  schemaVersion: 1,
  id: 'request',
  turnId: 'turn',
  ts: 1,
  expiresAt: 3600001,
  senderSessionId: 'task',
  senderRunId: 'run',
  senderInvocationId: 'invocation',
  toolCallId: 'exec:nested:call',
  actionId: 'action',
  delegationId: 'delegation',
  rootMessageId: 'message',
  question: 'Need evidence',
  round: 1,
};
const reply = {
  type: 'workhub_evidence_resolution',
  schemaVersion: 1,
  id: 'reply',
  turnId: 'coordination-turn',
  ts: 2,
  requestId: 'request',
  requesterSessionId: 'task',
  senderRunId: 'coordination-run',
  senderInvocationId: 'coordination-invocation',
  toolCallId: 'resolve',
  sourceActionId: 'source-action',
  sourceDelegationId: 'source-delegation',
  sourceSessionId: 'source',
  sourceMessageId: 'source-message',
};

test('evidence records decode strict fixed identities, bounded rounds/lifetime and all-or-none source provenance', () => {
  assert.equal(isWorkHubEvidenceRequest(request), true);
  assert.deepEqual(decodeCanonicalMessage(request), request);
  assert.deepEqual(decodeCanonicalMessage(reply), reply);
  assert.equal(isWorkHubEvidenceResolution({ ...reply, sourceActionId: null }), false);
  for (const change of [
    { round: 9 },
    { round: 0 },
    { expiresAt: 3600002 },
    { ts: NaN },
    { question: '' },
    { senderRunId: '' },
    { hostId: 'foreign' },
  ])
    assert.equal(
      isWorkHubEvidenceRequest({ ...request, ...change }),
      false,
      JSON.stringify(change),
    );
  assert.equal(
    isWorkHubEvidenceWaitResult({ kind: 'workhub_evidence_waiting', requestId: 'request' }),
    true,
  );
  assert.equal(
    isWorkHubEvidenceWaitResult({
      kind: 'workhub_evidence_waiting',
      requestId: 'request',
      extra: true,
    }),
    false,
  );
  const origin = {
    kind: 'workhub_evidence',
    requestId: 'request',
    delegationId: 'delegation',
    sourceTurnId: 'turn',
    sourceRunId: 'run',
  };
  assert.deepEqual(decodeTurnOrigin(origin), origin);
  assert.equal(decodeTurnOrigin({ ...origin, sourceRunId: '' }), undefined);
  assert.equal(decodeTurnOrigin({ ...origin, permissionMode: 'bypass' }), undefined);
});

test('legacy evidence retirement is a distinct Host-origin fact with no selected source authority', () => {
  const retirement = {
    ...reply,
    id: 'retirement',
    origin: 'legacy_protocol_retirement',
    turnId: request.turnId,
    senderRunId: request.senderRunId,
    senderInvocationId: request.senderInvocationId,
    toolCallId: request.toolCallId,
    sourceActionId: null,
    sourceDelegationId: null,
    sourceSessionId: null,
    sourceMessageId: null,
  };
  assert.deepEqual(decodeCanonicalMessage(retirement), retirement);
  assert.deepEqual(deriveTurnRecords([decodeCanonicalMessage(retirement)]), []);
  assert.equal(
    isWorkHubEvidenceResolution({ ...reply, origin: 'legacy_protocol_retirement' }),
    false,
  );
  assert.equal(isWorkHubEvidenceResolution({ ...retirement, origin: 'model' }), false);
  assert.deepEqual(
    decodeCanonicalMessage(reply),
    reply,
    'ordinary old source selections stay readable',
  );
});

test('peer question, inbox and terminal settlement are strict bounded operational facts', () => {
  const sender = {
    workId: 'work-a',
    generationId: 'generation-a',
    actionId: 'action-a',
    delegationId: 'delegation-a',
    sessionId: 'a',
    messageId: 'message-a',
  };
  const recipient = {
    workId: 'work-b',
    generationId: 'generation-b',
    actionId: 'action-b',
    delegationId: 'delegation-b',
    sessionId: 'b',
    messageId: 'message-b',
  };
  const suffix = 'a'.repeat(48);
  const question = {
    type: 'workhub_peer_question',
    schemaVersion: 1,
    id: `whpq_${suffix}`,
    turnId: 'turn-a',
    ts: 1,
    expiresAt: 3600001,
    sender,
    recipient,
    senderRunId: 'run-a',
    senderInvocationId: 'invocation-a',
    toolCallId: 'exec:nested:ask',
    question: 'Which checksum?',
    round: 1,
  };
  const inbox = {
    type: 'workhub_peer_inbox',
    schemaVersion: 1,
    id: `whpi_${suffix}`,
    turnId: 'turn-b',
    ts: 1,
    expiresAt: question.expiresAt,
    requesterSessionId: 'a',
    questionId: question.id,
    target: recipient,
  };
  const answer = {
    type: 'workhub_peer_settlement',
    schemaVersion: 1,
    id: `whps_${suffix}`,
    turnId: 'turn-b',
    ts: 2,
    requesterSessionId: 'a',
    questionId: question.id,
    actor: recipient,
    senderRunId: 'run-b',
    senderInvocationId: 'invocation-b',
    toolCallId: 'reply',
    outcome: 'reply',
    answer: 'Checksum abc123.',
  };
  const retired = {
    ...answer,
    actor: sender,
    outcome: 'cancelled',
    answer: undefined,
    origin: 'legacy_protocol_retirement',
    turnId: question.turnId,
    senderRunId: question.senderRunId,
    senderInvocationId: question.senderInvocationId,
    toolCallId: question.toolCallId,
  };
  assert.deepEqual(decodeCanonicalMessage(retired), retired);
  assert.deepEqual(deriveTurnRecords([decodeCanonicalMessage(retired)]), []);
  assert.throws(() => decodeCanonicalMessage({ ...answer, origin: 'legacy_protocol_retirement' }));
  assert.throws(() => decodeCanonicalMessage({ ...retired, origin: 'model' }));
  for (const fact of [
    question,
    inbox,
    answer,
    { ...answer, actor: sender, outcome: 'cancelled', answer: undefined },
  ]) {
    assert.deepEqual(decodeCanonicalMessage(fact), fact);
    assert.throws(() => threadSearchMatchKind(decodeCanonicalMessage(fact)), /not searchable/);
    assert.deepEqual(
      deriveTurnRecords([decodeCanonicalMessage(fact)]),
      [],
      'inbox publication cannot manufacture a completed legacy Turn',
    );
    assert.throws(() => decodeCanonicalMessage({ ...fact, permissionMode: 'bypass' }));
    assert.throws(() => decodeCanonicalMessage({ ...fact, senderRunId: '' }));
  }
  for (const change of [
    { round: 9 },
    { expiresAt: 3600002 },
    { recipient: sender },
    { question: '\u0000'.repeat(4000) },
    { question: '' },
  ])
    assert.throws(() => decodeCanonicalMessage({ ...question, ...change }));
  assert.throws(() => decodeCanonicalMessage({ ...answer, answer: '\u0000'.repeat(4000) }));
  assert.throws(() => decodeCanonicalMessage({ ...answer, outcome: 'cancelled' }));
  assert.throws(() => decodeCanonicalMessage({ ...inbox, questionId: 'wrong-prefix' }));
});

test('peer dependency binding extends the existing wait without weakening legacy validation', () => {
  const value = { ...request, peerQuestionId: `whpq_${'a'.repeat(48)}` };
  assert.deepEqual(decodeCanonicalMessage(value), value);
  assert.throws(() => decodeCanonicalMessage({ ...value, peerQuestionId: 'arbitrary' }));
  assert.throws(() => decodeCanonicalMessage({ ...value, peerTargetSessionId: 'foreign' }));
});
