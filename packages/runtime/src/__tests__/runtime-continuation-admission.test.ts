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
import {
  createRuntimeContinuationStartAdmissionProof,
  consumeRuntimeContinuationStartAdmissionProof,
  type RuntimeContinuationStartAdmissionIdentity,
} from '../runtime-continuation-admission.js';

function identity(): RuntimeContinuationStartAdmissionIdentity {
  return {
    startEventId: 'start-event',
    claimId: 'claim',
    boundaryDigest: `sha256:${'a'.repeat(64)}`,
    providerProjectionVersion: 6,
    providerReplayDigest: `sha256:${'b'.repeat(64)}`,
    target: { sessionId: 'session', invocationId: 'invocation', runId: 'run', turnId: 'turn' },
  };
}

test('released and WorkHub v6 continuation-start proofs retain exact identity and remain one-shot', () => {
  for (const providerProjectionVersion of [1, 2, 3, 4, 5, 6] as const) {
    const source = { ...identity(), providerProjectionVersion };
    const expected = structuredClone(source);
    const proof = createRuntimeContinuationStartAdmissionProof(source);
    source.target.runId = 'later-mutation';
    assert.deepEqual(consumeRuntimeContinuationStartAdmissionProof(proof), expected);
    assert.throws(() => consumeRuntimeContinuationStartAdmissionProof(proof), /already consumed/);
  }
});

test('unknown continuation projections are not admitted or silently downgraded', () => {
  assert.throws(
    () =>
      createRuntimeContinuationStartAdmissionProof({
        ...identity(),
        providerProjectionVersion: 7,
      } as unknown as RuntimeContinuationStartAdmissionIdentity),
    /identity is incomplete/,
  );
});
