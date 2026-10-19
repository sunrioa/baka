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
import { HOST_OPERATION_SPECS, REMOTE_OWNER_OPERATION_GRANTS } from '../protocol/index.js';

const spec = HOST_OPERATION_SPECS['workhub.tasks.stop'];
const input = {
  turnId: 'coordinator-turn',
  actionId: 'stop-action',
  taskIds: ['work-a', 'work-b'],
};
const target = {
  workId: 'work-a',
  generationId: 'generation',
  sourceActionId: 'source',
  sourceDelegationId: 'delegation',
  targetSessionId: 'worker',
  outcome: 'already_terminal',
  targetTurnId: 'turn',
};
const result = {
  actionId: input.actionId,
  kind: 'result',
  targets: [target, { ...target, workId: 'work-b' }],
};

test('task stop accepts a bounded task set, not model-provided origin or execution authority', () => {
  assert.equal(
    (REMOTE_OWNER_OPERATION_GRANTS as readonly string[]).includes('workhub.tasks.stop'),
    false,
  );
  assert.deepEqual(spec.decodeInput(input), input);
  assert.equal(
    spec.decodeInput({ ...input, taskIds: Array.from({ length: 8 }, (_, i) => 'work-' + i) })
      .taskIds.length,
    8,
  );
  for (const invalid of [
    { ...input, taskIds: [] },
    { ...input, taskIds: ['work-a', 'work-a'] },
    { ...input, taskIds: Array.from({ length: 9 }, (_, i) => 'work-' + i) },
    { ...input, taskIds: ['../foreign'] },
    { ...input, origin: 'user' },
    { ...input, permissionMode: 'bypass' },
    { ...input, executionBinding: 'another-root' },
    { ...input, generationId: 'newer' },
    { ...input, confirmed: true },
    { ...input, targetSessionId: 'historical-session' },
  ])
    assert.throws(() => spec.decodeInput(invalid));
});

test('stop outcomes distinguish pending recovery, cancellation and exact execution receipts', () => {
  assert.deepEqual(spec.decodeOutput(result), result);
  const cancelled = { actionId: input.actionId, kind: 'cancelled', taskIds: input.taskIds };
  assert.deepEqual(spec.decodeOutput(cancelled), cancelled);
  const recovering = { ...result, targets: [{ ...target, outcome: 'recovering' }] };
  assert.deepEqual(spec.decodeOutput(recovering), recovering);
  for (const invalid of [
    { ...result, kind: 'all_stopped' },
    { ...result, targets: [] },
    { ...result, targets: [target, target] },
    { ...result, targets: [{ ...target, generationId: '' }] },
    { ...result, targets: [{ ...target, outcome: 'completed' }] },
    { ...result, targets: [{ ...target, outcome: 'stop_delivered', targetTurnId: undefined }] },
    { ...result, targets: [{ ...target, outcome: 'cancelled_pending' }] },
    { ...result, targets: [{ ...target, confirmed: true }] },
    { ...cancelled, targets: [target] },
  ])
    assert.throws(() => spec.decodeOutput(invalid));
});

test('stop response cannot silently change the action, target set or target order', () => {
  assert.ok(spec.assertOutputForInput);
  const request = spec.decodeInput(input);
  spec.assertOutputForInput(request, spec.decodeOutput(result));
  for (const invalid of [
    { ...result, actionId: 'another-action' },
    { ...result, targets: [...result.targets].reverse() },
    { ...result, targets: [target] },
  ])
    assert.throws(() => spec.assertOutputForInput!(request, spec.decodeOutput(invalid)));
});
