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
import { decodeCanonicalMessage } from '../session.js';
import { decodeTurnOrigin } from '../turn-origin.js';
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
