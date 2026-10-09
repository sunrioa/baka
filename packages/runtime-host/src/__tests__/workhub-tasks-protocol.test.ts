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
import { HOST_OPERATION_SPECS } from '../protocol/index.js';
const task = {
  actionId: 'action',
  delegationId: 'delegation',
  targetSessionId: 'target',
  targetSessionName: 'Task',
  targetMessageId: 'message',
  text: 'Do work',
  createdAt: 1,
  status: 'pending_acceptance',
  execution: { turnId: 'turn', runId: 'run', sharedTurn: false },
};
test('WorkHub task reads are bounded, unique and reject fabricated execution state', () => {
  const spec = HOST_OPERATION_SPECS['workhub.tasks.query'];
  assert.deepEqual(spec.decodeInput({}), {});
  assert.throws(() => spec.decodeInput({ hostId: 'foreign' }));
  assert.deepEqual(spec.decodeOutput({ tasks: [task], truncated: false }), {
    tasks: [task],
    truncated: false,
  });
  for (const patch of [
    { status: 'goal_completed' },
    { createdAt: -1 },
    { execution: { ...task.execution, runId: '' } },
    { waitReason: 'workspace' },
    { text: '😀'.repeat(257) },
    { dependency: { requestId: 'request', question: 'Why?' } },
  ])
    assert.throws(() => spec.decodeOutput({ tasks: [{ ...task, ...patch }], truncated: false }));
  assert.throws(() => spec.decodeOutput({ tasks: [task, task], truncated: false }));
  assert.throws(() =>
    spec.decodeOutput({
      tasks: Array.from({ length: 33 }, (_, i) => ({
        ...task,
        actionId: 'a' + i,
        delegationId: 'd' + i,
      })),
      truncated: false,
    }),
  );
});
test('WorkHub deliveries belong to an exact owned terminal task, not a shared or active Turn', () => {
  const spec = HOST_OPERATION_SPECS['workhub.tasks.read'];
  const input = spec.decodeInput({ actionId: 'action', delegationId: 'delegation' });
  const result = spec.decodeOutput({
    task,
    delivery: {
      text: 'Test claims, not verification',
      truncated: false,
      terminalEventId: 'terminal',
    },
  });
  spec.assertOutputForInput!(input, result);
  assert.throws(() => spec.assertOutputForInput!({ ...input, delegationId: 'other' }, result));
  assert.throws(() => spec.decodeInput({ ...input, targetSessionId: 'injected' }));
  for (const changed of [
    { ...task, status: 'running' },
    { ...task, execution: { ...task.execution, sharedTurn: true } },
  ])
    assert.throws(() => spec.decodeOutput({ ...result, task: changed }));
  assert.throws(() =>
    spec.decodeOutput({
      ...result,
      delivery: { ...result.delivery, text: 'x'.repeat(16 * 1024 + 1) },
    }),
  );
});
test('native task continuation accepts only the exact source and new user text, not permissions or a target override', () => {
  const spec = HOST_OPERATION_SPECS['workhub.coordination.continue'];
  const input = {
    turnId: 'continuation',
    actionId: 'action',
    delegationId: 'delegation',
    text: 'Continue tests',
  };
  assert.deepEqual(spec.decodeInput(input), input);
  for (const patch of [
    { targetSessionId: 'manual' },
    { permissionMode: 'bypass' },
    { grantId: 'old' },
    { delegationId: '' },
    { text: '' },
  ])
    assert.throws(() => spec.decodeInput({ ...input, ...patch }));
});
