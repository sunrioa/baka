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
import { ToolOutcomeUnknownError } from '@maka/core/events';
import { createBypassExecutionBoundary } from '@maka/core/sandbox-boundary';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import {
  RuntimeInteractionClosedError,
  RuntimeInteractionFailStopError,
  RuntimeInteractionInvariantError,
} from '@maka/runtime/interaction-authority';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { clientCapabilityEntityId } from '../client-capability-entity-id.js';
import { createWorkHubCoordinatorTools } from '../server/workhub-coordinator-tools.js';

const ask = { question: 'Which work?', choices: [{ kind: 'session', id: 'manual' }] };
const context = (): MakaToolContext => ({
  sessionId: WORKHUB_COORDINATION_SESSION_ID,
  turnId: 'current-turn',
  runId: 'current-run',
  invocationId: 'current-invocation',
  toolCallId: 'opaque.call/id',
  cwd: '/not-used',
  executionBoundary: createBypassExecutionBoundary(0),
  permissionMode: 'bypass',
  abortSignal: new AbortController().signal,
  emitOutput() {},
});

function fixture() {
  const authorized: MakaToolContext[] = [];
  const calls: { kind: string; input: unknown }[] = [];
  const options: Parameters<typeof createWorkHubCoordinatorTools>[0] = {
    authorize: async (ctx) => {
      authorized.push(ctx);
    },
    ask: async (input) => {
      calls.push({ kind: 'ask', input });
      return { ok: true, result: { kind: 'new_task' } };
    },
    stop: async (input) => {
      calls.push({ kind: 'stop', input });
      return {
        ok: true,
        result: {
          actionId: input.actionId,
          kind: 'result',
          targets: [
            {
              workId: 'task',
              generationId: 'generation',
              sourceActionId: 'source',
              sourceDelegationId: 'delegation',
              targetSessionId: 'worker',
              outcome: 'not_owned',
            },
          ],
        },
      };
    },
  };
  const tools = createWorkHubCoordinatorTools(options);
  const invoke = async (name: 'ask' | 'stop', input: unknown, ctx = context()) =>
    tools.find((tool) => tool.name === `mcp__desktop_workhub__${name}`)!.impl(input, ctx);
  return { options, tools, authorized, calls, invoke };
}

test('native confirmations retain names, original action identity and visible receipts without a CC admission', async () => {
  const f = fixture();
  assert.deepEqual(
    f.tools.map((tool) => tool.name),
    ['mcp__desktop_workhub__ask', 'mcp__desktop_workhub__stop'],
  );
  for (const tool of f.tools) {
    assert.equal(tool.hostAdmission, undefined);
    assert.equal(tool.recoveryMode, 'outcome_unknown');
  }
  const ctx = context();
  assert.deepEqual(await f.invoke('ask', ask, ctx), { kind: 'new_task' });
  assert.equal(f.authorized[0], ctx);
  const actionId = clientCapabilityEntityId(
    JSON.stringify(['workhub-task', ctx.turnId, ctx.toolCallId]),
  );
  assert.deepEqual(f.calls[0], { kind: 'ask', input: { ...ask, turnId: ctx.turnId, actionId } });
  await f.invoke('ask', ask, ctx);
  assert.deepEqual(
    f.calls[1],
    f.calls[0],
    'repeated original tool identity keeps the same durable action',
  );
  await f.invoke('ask', ask, { ...ctx, turnId: 'later-turn' });
  assert.notDeepEqual(f.calls[2], f.calls[0]);
  assert.deepEqual(await f.invoke('stop', { taskIds: ['task'] }), {
    kind: 'result',
    targets: [{ taskId: 'task', outcome: 'not_owned' }],
  });
  f.options.stop = async (input) => ({
    ok: true,
    result: {
      actionId: input.actionId,
      kind: 'cancelled',
      taskIds: input.taskIds,
    },
  });
  assert.deepEqual(await f.invoke('stop', { taskIds: ['task'] }), {
    kind: 'cancelled',
    taskIds: ['task'],
  });
});

test('native confirmations reject foreign, missing, stale and restricted Runtime authority before invoking commands', async () => {
  for (const changed of [
    { sessionId: 'ordinary-session' },
    { runId: undefined },
    { turnId: '' },
    { invocationId: undefined },
    { toolCallId: '' },
    { executionBoundary: undefined },
    { permissionMode: 'ask' as const },
  ]) {
    const f = fixture();
    await assert.rejects(f.invoke('ask', ask, { ...context(), ...changed }));
    assert.equal(f.calls.length, 0);
  }
  const stale = fixture();
  const failure = new Error('not the actual current Run');
  stale.options.authorize = async () => {
    throw failure;
  };
  await assert.rejects(stale.invoke('ask', ask), (error) => error === failure);
  assert.equal(stale.calls.length, 0);
  const controller = new AbortController();
  controller.abort(failure);
  await assert.rejects(
    stale.invoke('stop', { taskIds: ['task'] }, { ...context(), abortSignal: controller.signal }),
    (error) => error === failure,
  );
});

test('native waiting does not use an execution deadline or manufacture an answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let answer!: () => void;
  f.options.ask = () =>
    new Promise((resolve) => {
      answer = () => resolve({ ok: true, result: { kind: 'cancelled' } });
    });
  let settled = false;
  const pending = f.invoke('ask', ask).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(150_001);
  await Promise.resolve();
  assert.equal(settled, false);
  answer();
  assert.deepEqual(await pending, { kind: 'cancelled' });
});

for (const name of ['ask', 'stop'] as const)
  test(`${name} preserves original closure/fatal control errors and observes abort after waiting`, async () => {
    for (const failure of [
      new RuntimeInteractionClosedError('original-request', 'turn_stopped'),
      new RuntimeInteractionInvariantError('canonical conflict'),
      new RuntimeInteractionFailStopError('write failed', new Error('storage failure')),
    ]) {
      const f = fixture();
      f.options[name] = async () => {
        throw failure;
      };
      await assert.rejects(
        f.invoke(name, name === 'ask' ? ask : { taskIds: ['task'] }),
        (error) => error === failure,
      );
    }
    const f = fixture();
    const controller = new AbortController();
    const failure = new RuntimeInteractionClosedError('original-request', 'turn_stopped');
    f.options[name] = async () => {
      controller.abort(failure);
      return { ok: true, result: { kind: 'cancelled', actionId: 'action', taskIds: ['task'] } };
    };
    await assert.rejects(
      f.invoke(name, name === 'ask' ? ask : { taskIds: ['task'] }, {
        ...context(),
        abortSignal: controller.signal,
      }),
      (error) => error === failure,
    );
  });

test('native parameters reject model-supplied authority and preserve unknown outcomes', async () => {
  const f = fixture();
  for (const key of ['turnId', 'actionId', 'runId', 'actor', 'confirmed', 'permissionMode']) {
    await assert.rejects(f.invoke('ask', { ...ask, [key]: 'forged' }));
    await assert.rejects(f.invoke('stop', { taskIds: ['task'], [key]: 'forged' }));
  }
  assert.equal(f.calls.length, 0);
  f.options.stop = async () => ({
    ok: false,
    error: { code: 'commit_outcome_unknown', message: 'Original target may have stopped' },
  });
  await assert.rejects(f.invoke('stop', { taskIds: ['task'] }), ToolOutcomeUnknownError);
});
