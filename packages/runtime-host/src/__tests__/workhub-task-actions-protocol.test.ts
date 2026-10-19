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
import { HOST_OPERATION_SPECS, operationAllowsRemoteOwner } from '../protocol/index.js';

const start = HOST_OPERATION_SPECS['workhub.tasks.start'];
const ask = HOST_OPERATION_SPECS['workhub.tasks.ask'];
const fields = {
  turnId: 'turn',
  actionId: 'action',
  title: 'Independent task',
  text: 'Do only this task',
};
const defaults = {
  model: { llmConnectionId: 'connection', llmConnectionSlug: 'connection', model: 'model' },
  permissionMode: 'ask' as const,
};

test('task start requires explicit creation settings or an exact existing Session without overrides', () => {
  const manual = { ...fields, sessionRef: 'manual' };
  assert.deepEqual(start.decodeInput(manual), manual);
  const create = start.decodeInput({ ...fields, newWorkDefaults: defaults });
  assert.deepEqual(create, {
    ...fields,
    newWorkDefaults: defaults,
    create: { workspace: { kind: 'isolated' } },
  });
  assert.equal(start.usesHostPaths?.(create), false);
  assert.equal(start.usesHostPaths?.(manual), false);
  const path = start.decodeInput({
    ...fields,
    newWorkDefaults: defaults,
    create: { workspace: { kind: 'host_path', path: '/workspace' } },
  });
  assert.equal(start.usesHostPaths?.(path), true);
  assert.deepEqual(
    start.decodeInput({
      ...fields,
      newWorkDefaults: {
        executorId: 'example',
        executorModel: 'executor-model',
        permissionMode: 'ask',
      },
    }).newWorkDefaults,
    { executorId: 'example', executorModel: 'executor-model', permissionMode: 'ask' },
  );
  for (const invalid of [
    fields,
    { ...fields, newWorkDefaults: {} },
    { ...fields, newWorkDefaults: { model: defaults.model } },
    { ...fields, newWorkDefaults: { permissionMode: 'ask' } },
    { ...fields, newWorkDefaults: { ...defaults, executorId: 'example' } },
    { ...manual, newWorkDefaults: defaults },
    { ...manual, create: { workspace: { kind: 'isolated' } } },
    { ...manual, title: ' ' },
    { ...manual, title: '😀'.repeat(513) },
    { ...manual, title: 'bad\ntitle' },
    { ...manual, text: '中'.repeat(17_000) },
    { ...manual, inputOrigin: 'user' },
    { ...manual, sourceMessageId: 'forged' },
    { ...manual, taskId: 'existing' },
  ])
    assert.throws(() => start.decodeInput(invalid));
});

test('task start receipts cannot turn independent work into continuation, stop, or another target', () => {
  assert.ok(start.assertOutputForInput);
  const manual = start.decodeInput({ ...fields, sessionRef: 'manual' });
  const result = start.decodeOutput({
    disposition: 'delegate_existing',
    workId: 'action',
    targetSessionId: 'manual',
    targetMessageId: 'message',
  });
  start.assertOutputForInput(manual, result);
  assert.throws(() => start.assertOutputForInput!(manual, { ...result, workId: 'old-task' }));
  assert.throws(() => start.assertOutputForInput!(manual, { ...result, targetSessionId: 'other' }));
  assert.throws(() =>
    start.assertOutputForInput!(
      start.decodeInput({ ...fields, newWorkDefaults: defaults }),
      result,
    ),
  );
  assert.throws(() =>
    start.decodeOutput({
      disposition: 'stop_work',
      targetSessionId: 'manual',
      outcome: 'already_terminal',
    }),
  );
});

test('task selection is bounded and has closed task/Session targets; cancellation creates no work', () => {
  const input = {
    turnId: 'turn',
    actionId: 'select',
    question: 'Which work?',
    choices: [
      { kind: 'task', id: 'a' },
      { kind: 'session', id: 'b' },
    ],
  };
  assert.deepEqual(ask.decodeInput(input), input);
  assert.deepEqual(ask.decodeInput({ ...input, choices: [] }).choices, []);
  for (const invalid of [
    { ...input, choices: [...input.choices, input.choices[0]] },
    {
      ...input,
      choices: Array.from({ length: 7 }, (_, index) => ({ kind: 'task', id: 't' + index })),
    },
    { ...input, choices: [{ kind: 'project', id: 'b' }] },
    { ...input, choices: [{ kind: 'task', id: 'a', generationId: 'forged' }] },
    { ...input, delegationText: 'silently send' },
    { ...input, question: '中'.repeat(700) },
  ])
    assert.throws(() => ask.decodeInput(invalid));
  assert.ok(ask.assertOutputForInput);
  for (const kind of ['cancelled', 'new_task'] as const) {
    assert.deepEqual(ask.decodeOutput({ kind }), { kind });
    assert.throws(() => ask.decodeOutput({ kind, target: input.choices[0] }));
  }
  const selected = ask.decodeOutput({
    kind: 'selected',
    target: input.choices[0],
    generationId: 'generation',
  });
  ask.assertOutputForInput(ask.decodeInput(input), selected);
  assert.throws(() =>
    ask.assertOutputForInput!(ask.decodeInput({ ...input, choices: [] }), selected),
  );
  assert.throws(() => ask.decodeOutput({ kind: 'selected', target: input.choices[0] }));
  assert.throws(() =>
    ask.decodeOutput({ kind: 'selected', target: input.choices[1], generationId: 'generation' }),
  );
  for (const key of ['workhub.tasks.start', 'workhub.tasks.ask'] as const)
    assert.equal(
      operationAllowsRemoteOwner(key),
      false,
      'foundation does not broaden remote credentials',
    );
});
