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
import test from 'node:test';
import { RuntimeHostProtocolError } from '../protocol/errors.js';
import {
  decodeWorkHubCoordinationConfigureModelInput,
  decodeWorkHubCoordinationActResult,
  decodeWorkHubCoordinationAnswerInput,
  decodeWorkHubCoordinationResolveInput,
  decodeWorkHubCoordinationResolveResult,
  isOperationKey,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
} from '../protocol/index.js';

test('retired candidate, correction and old continuation APIs are not published or remotely granted', () => {
  const grants = new Set<string>(REMOTE_OWNER_OPERATION_GRANTS);
  for (const operation of [
    'workhub.coordination.candidates',
    'workhub.coordination.selectAndDelegate',
    'workhub.coordination.actFromTurn',
    'workhub.coordination.continue',
    'workhub.coordination.works',
  ]) {
    assert.equal(isOperationKey(operation), false, operation);
    assert.equal(Object.hasOwn(HOST_OPERATION_SPECS, operation), false, operation);
    assert.equal(grants.has(operation), false, operation);
  }
  for (const operation of [
    'workhub.coordination.query',
    'workhub.coordination.resolve',
    'workhub.coordination.answer',
    'workhub.coordination.configureModel',
    'workhub.tasks.find',
    'workhub.tasks.start',
    'workhub.tasks.ask',
    'workhub.tasks.continue',
    'workhub.tasks.stop',
    'workhub.tasks.read',
    'workhub.tasks.send',
    'workhub.tasks.history',
  ])
    assert.equal(isOperationKey(operation), true, operation);
});

test('WorkHub Coordination resolve has a closed empty input and bounded identity result', () => {
  assert.deepEqual(decodeWorkHubCoordinationResolveInput({}), {});
  assert.deepEqual(decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination' }), {
    sessionId: 'coordination',
  });
  assert.equal(HOST_OPERATION_SPECS['workhub.coordination.resolve'].mode, 'command');
  assert.ok(RUNTIME_HOST_COMPATIBILITY_EPOCH > 86);
  assert.throws(
    () => decodeWorkHubCoordinationResolveInput({ sessionId: 'caller-selected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
  assert.throws(
    () => decodeWorkHubCoordinationResolveResult({ sessionId: 'coordination', role: 'injected' }),
    (error) => error instanceof RuntimeHostProtocolError,
  );
});

test('WorkHub model configuration accepts thinking levels without widening its authority', () => {
  const input = {
    expectedRevision: 3,
    thinkingLevel: null,
    modelTarget: {
      kind: 'explicit',
      connectionId: 'connection-1',
      connectionSlug: 'test',
      model: 'model-1',
    },
  };
  assert.deepEqual(decodeWorkHubCoordinationConfigureModelInput(input), input);
  for (const thinkingLevel of ['high', null]) {
    assert.deepEqual(decodeWorkHubCoordinationConfigureModelInput({ ...input, thinkingLevel }), {
      ...input,
      thinkingLevel,
    });
  }
  for (const invalid of [
    { expectedRevision: input.expectedRevision, modelTarget: input.modelTarget },
    { ...input, thinkingLevel: undefined },
    { ...input, sessionId: 'another-session' },
    { ...input, permissionMode: 'bypass' },
    { ...input, thinkingLevel: 'extreme' },
    { ...input, expectedRevision: -1 },
    { ...input, modelTarget: { kind: 'default' } },
    { expectedRevision: 3, thinkingLevel: null },
    { ...input, executorTarget: { executorId: 'codex.app-server' } },
    {
      expectedRevision: 4,
      thinkingLevel: 'xhigh',
      executorTarget: { executorId: 'codex.app-server', model: 'gpt-6-astra' },
    },
  ])
    assert.throws(
      () => decodeWorkHubCoordinationConfigureModelInput(invalid),
      RuntimeHostProtocolError,
    );
});

test('native coordination answers retain bounded attachment content without user authority fields', () => {
  const attachments = [
    {
      name: 'brief.txt',
      kind: 'other',
      mimeType: 'text/plain',
      bytes: 4,
      ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'brief' },
    },
  ];
  const answer = { turnId: 'answer', text: 'Review file', attachments };
  assert.deepEqual(decodeWorkHubCoordinationAnswerInput(answer), answer);
  for (const invalid of [
    { ...answer, extra: true },
    { ...answer, text: 'x'.repeat(48 * 1024 + 1) },
    { ...answer, attachments: Array(9).fill(attachments[0]) },
  ])
    assert.throws(() => decodeWorkHubCoordinationAnswerInput(invalid));
  assert.throws(() =>
    decodeWorkHubCoordinationAnswerInput({ ...answer, proposal: { operation: 'correct' } }),
  );
});

test('action outcomes cannot invent a target Turn or revive removed local dispositions', () => {
  for (const result of [
    {
      disposition: 'delegate_existing',
      targetSessionId: 'target',
      targetTurnId: 'turn',
      steered: true,
    },
    { disposition: 'create_new', targetSessionId: 'target', targetTurnId: 'turn' },
    {
      disposition: 'replace',
      replacementDisposition: 'create_new',
      targetSessionId: 'target',
      targetTurnId: 'turn',
    },
    { disposition: 'stop_work', outcome: 'cancelled_pending', targetSessionId: 'target' },
    {
      disposition: 'stop_work',
      outcome: 'not_owned',
      targetSessionId: 'target',
      targetTurnId: 'user-turn',
    },
    {
      disposition: 'resume_work',
      outcome: 'resume_started',
      targetSessionId: 'target',
      targetTurnId: 'turn',
    },
    { disposition: 'resume_work', outcome: 'already_running', targetSessionId: 'target' },
  ])
    assert.deepEqual(decodeWorkHubCoordinationActResult(result), result);
  for (const result of [
    { disposition: 'answer_here', coordinationTurnId: 'turn' },
    { disposition: 'clarify', coordinationTurnId: 'turn' },
    {
      disposition: 'stop_work',
      outcome: 'cancelled_pending',
      targetSessionId: 'target',
      targetTurnId: 'forged',
    },
    { disposition: 'stop_work', outcome: 'not_owned', targetSessionId: 'target' },
    {
      disposition: 'resume_work',
      outcome: 'already_running',
      targetSessionId: 'target',
      targetTurnId: 'forged',
    },
    { disposition: 'resume_work', outcome: 'resume_started', targetSessionId: 'target' },
  ])
    assert.throws(() => decodeWorkHubCoordinationActResult(result));
});
