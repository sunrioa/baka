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
import { HOST_OPERATION_SPECS, WORKHUB_INBOX_MAX_ITEMS } from '../protocol/index.js';
const interaction = {
  schemaVersion: 1,
  interactionId: 'question',
  sessionId: 'target',
  turnId: 'turn',
  runId: 'run',
  request: {
    kind: 'question',
    toolUseId: 'ask',
    questions: [{ question: 'When?', options: [{ label: 'Monday' }, { label: 'Tuesday' }] }],
  },
  revision: 1,
  status: 'pending',
  outcome: null,
};
const item = {
  actionId: 'action',
  delegationId: 'delegation',
  targetSessionName: 'Task',
  interaction,
};
test('WorkHub inbox is bounded, closed, pending-only and deduplicated by original identity', () => {
  const spec = HOST_OPERATION_SPECS['workhub.interactions.query'];
  assert.deepEqual(spec.decodeInput({}), {});
  assert.throws(() => spec.decodeInput({ hostId: 'injected' }));
  assert.deepEqual(spec.decodeOutput({ requests: [item], truncated: false }), {
    requests: [item],
    grants: [],
    truncated: false,
  });
  for (const requests of [
    [item, item],
    Array.from({ length: WORKHUB_INBOX_MAX_ITEMS + 1 }, (_, i) => ({
      ...item,
      interaction: { ...interaction, interactionId: 'request-' + i },
    })),
    [
      {
        ...item,
        interaction: {
          ...interaction,
          status: 'answered',
          revision: 2,
          outcome: { kind: 'question_answer', answers: ['Monday'], committedAt: 1 },
        },
      },
    ],
    [{ ...item, targetSessionName: 'x'.repeat(513) }],
  ])
    assert.throws(() => spec.decodeOutput({ requests, truncated: false }));
  assert.throws(() => spec.decodeOutput({ requests: [], truncated: false, grants: ['injected'] }));
});
test('WorkHub answers cannot retarget a Session and receipts must match the exact request and Run', () => {
  const spec = HOST_OPERATION_SPECS['workhub.interactions.answer'];
  const input = {
    actionId: 'action',
    interactionId: 'question',
    expectedTurnId: 'turn',
    expectedRunId: 'run',
    answer: { kind: 'question', answers: ['Monday'] },
  };
  const decoded = spec.decodeInput(input);
  assert.deepEqual(decoded, input);
  assert.throws(() => spec.decodeInput({ ...input, sessionId: 'another-task' }));
  assert.throws(() => spec.decodeInput({ ...input, expectedRunId: '' }));
  assert.throws(() => spec.decodeInput({ ...input, grantScope: 'task' }));
  const grantAnswer = {
    ...input,
    answer: { kind: 'sandbox_boundary', decision: 'allow' },
    grantScope: 'task',
  };
  assert.deepEqual(spec.decodeInput(grantAnswer), grantAnswer);
  assert.throws(() => spec.decodeInput({ ...grantAnswer, grantScope: 'session' }));
  assert.throws(() =>
    spec.decodeInput({ ...grantAnswer, answer: { kind: 'sandbox_boundary', decision: 'deny' } }),
  );
  const output = spec.decodeOutput({
    ...interaction,
    status: 'answered',
    revision: 2,
    outcome: { kind: 'question_answer', answers: ['Monday'], committedAt: 1 },
  });
  spec.assertOutputForInput!(decoded, output);
  for (const patch of [{ runId: 'old' }, { turnId: 'manual' }, { interactionId: 'other' }])
    assert.throws(() => spec.assertOutputForInput!(decoded, { ...output, ...patch }));
});
