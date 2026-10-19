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
import { WORKHUB_TASK_INPUT_OPERATION_SPECS as specs } from '../protocol/workhub-task-input.js';

const modern = {
  workId: 'task',
  generationId: 'generation',
  inputId: 'input',
  text: 'Use this correction',
};
const legacy = { ...modern, sourceActionId: 'source', sourceDelegationId: 'delegation' };
const receipt = {
  ...legacy,
  acceptedAt: 1,
  mode: 'steering',
  targetSessionId: 'session',
  targetMessageId: 'message',
  delivery: 'queued',
};
const { text: _text, ...output } = receipt;

test('task sends accept only the closed modern or complete saved-legacy shape', () => {
  const send = specs['workhub.tasks.send'];
  const assertSend = send.assertOutputForInput;
  assert.ok(assertSend);
  assert.deepEqual(send.decodeInput(modern), modern);
  assert.deepEqual(send.decodeInput(legacy), legacy);
  for (const invalid of [
    { ...modern, sourceActionId: 'partial' },
    { ...modern, sourceDelegationId: 'partial' },
    { ...modern, originalUserText: 'forged' },
    { ...modern, inputOrigin: 'user' },
    { ...modern, sourceMessageId: 'forged' },
    { ...modern, text: '' },
    { ...modern, text: '中'.repeat(17000) },
  ])
    assert.throws(() => send.decodeInput(invalid));
  const actual = send.decodeOutput(output);
  assertSend(modern, actual);
  assertSend(legacy, actual);
  assertSend(modern, { ...actual, sourceActionId: 'actual-running-source' });
  assert.throws(() => assertSend(legacy, { ...actual, sourceActionId: 'other' }));
  assert.throws(() => assertSend(modern, { ...actual, generationId: 'other' }));
});

test('model continuation names a task and keeps reuse/fresh receipts and provenance closed', () => {
  const operation = specs['workhub.tasks.continue'];
  const assertContinuation = operation.assertOutputForInput;
  assert.ok(assertContinuation);
  const input = { turnId: 'turn', actionId: 'input', taskId: 'task', text: modern.text };
  assert.deepEqual(operation.decodeInput(input), input);
  assert.deepEqual(operation.decodeInput({ ...input, container: 'fresh' }), {
    ...input,
    container: 'fresh',
  });
  for (const extra of [
    { container: 'auto' },
    { inputOrigin: 'user' },
    { sourceActionId: 'historical' },
    { generationId: 'claimed' },
    { userText: 'forged' },
  ])
    assert.throws(() => operation.decodeInput({ ...input, ...extra }));
  const reused = operation.decodeOutput({ container: 'reuse', input: output });
  assertContinuation(input, reused);
  const fresh = operation.decodeOutput({
    container: 'fresh',
    action: {
      disposition: 'create_new',
      workId: 'task',
      targetSessionId: 'new-session',
      targetMessageId: 'new-message',
    },
  });
  assertContinuation({ ...input, container: 'fresh' }, fresh);
  assert.throws(() => assertContinuation(input, fresh));
  assert.throws(() => assertContinuation({ ...input, taskId: 'foreign' }, reused));
  assert.throws(() => operation.decodeOutput({ container: 'reuse', input: output, action: {} }));
  assert.throws(() =>
    operation.decodeOutput({
      container: 'fresh',
      action: {
        disposition: 'stop_work',
        outcome: 'already_terminal',
        targetSessionId: 'new-session',
      },
    }),
  );
});
