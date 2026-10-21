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
import { z } from 'zod';
import { WORKHUB_TASK_INPUT_TEXT_MAX_BYTES } from '@maka/core/workhub-task-input';
import { parseWorkHubTaskToolRequest, workHubTaskToolSchemas, workHubTaskToolDescriptions, type WorkHubTaskToolRequest } from '../../shared/workhub-task-tool-schema.js';
import { createWorkHubTaskModelRuntime } from '../workhub-task-model-runtime.js';
import { createWorkHubCoordinatorTools } from '../../../../../packages/runtime-host/dist/server/workhub-coordinator-tools.js';

const scope = { hostId: 'host', targetEpoch: 'epoch' };
const calls: WorkHubTaskToolRequest[] = [
  { kind: 'find', input: { query: '登录 限流', cwd: '/workspace', cursor: 'cursor' } },
  { kind: 'start', input: { title: 'Login tests', text: 'Preserve requirements.' } },
  { kind: 'continue', input: { taskId: 'task', text: 'Only change validation.' } },
  { kind: 'ask', input: { question: 'Which previous task?', choices: [{ kind: 'task', id: 'task' }] } },
  { kind: 'stop', input: { taskIds: ['task'] } },
];

test('Host native confirmation parameters remain identical to the original flat Desktop contracts', () => {
  const tools = createWorkHubCoordinatorTools({
    authorize: async () => {},
    ask: async () => ({ ok: true, result: { kind: 'cancelled' } }),
    stop: async () => ({ ok: true, result: { actionId: 'action', kind: 'cancelled', taskIds: ['task'] } }),
  });
  for (const name of ['ask', 'stop'] as const) {
    const tool = tools.find((tool) => tool.name === `mcp__desktop_workhub__${name}`)!;
    assert.deepEqual(z.toJSONSchema(tool.parameters as z.ZodType, { unrepresentable: 'any' }), z.toJSONSchema(workHubTaskToolSchemas[name], { unrepresentable: 'any' }));
    assert.equal(tool.description, workHubTaskToolDescriptions[name]);
    const samples = name === 'ask' ? [
      { question: ' Which work? ', choices: [] },
      { question: 'Which?', choices: [{ kind: 'task', id: 'a' }, { kind: 'session', id: 'a' }] },
      { question: ' ', choices: [] },
      { question: '中'.repeat(683), choices: [] },
      { question: 'Which?', choices: [{ kind: 'task', id: 'a' }, { kind: 'task', id: 'a' }] },
      { question: 'Which?', choices: [], actionId: 'forged' },
    ] : [
      { taskIds: ['a'] }, { taskIds: ['a', 'b'] }, { taskIds: [] },
      { taskIds: ['a', 'a'] }, { taskIds: [''] }, { taskIds: ['a'], confirmed: true },
    ];
    for (const sample of samples) {
      const host = (tool.parameters as z.ZodType).safeParse(sample);
      const desktop = workHubTaskToolSchemas[name].safeParse(sample);
      assert.equal(host.success, desktop.success);
      if (host.success && desktop.success) assert.deepEqual(host.data, desktop.data);
    }
  }
});

function fixture() {
  let current = true;
  let defaultsCalls = 0;
  const requests: Array<{ name: string; input: Record<string, unknown> }> = [];
  const changes: unknown[] = [];
  const defaults = { permissionMode: 'ask' as const, model: { llmConnectionId: 'connection', llmConnectionSlug: 'command-code', model: 'deepseek' } };
  const receive = (name: string, input: Record<string, unknown>) => { requests.push({ name, input }); };
  const client = {
    findWorkHubTasks: async (input: Record<string, unknown>) => { receive('find', input); return { items: [], match: 'unmatched', nextCursor: null }; },
    startWorkHubTask: async (input: Record<string, unknown>) => { receive('start', input); return { disposition: input.sessionRef ? 'delegate_existing' : 'create_new', workId: input.actionId, targetSessionId: input.sessionRef ?? 'new-session' }; },
    continueWorkHubTaskFromTurn: async (input: Record<string, unknown>) => {
      receive('continue', input);
      return input.container === 'fresh'
        ? { container: 'fresh', action: { targetSessionId: 'fresh-session', workId: input.taskId } }
        : { container: 'reuse', input: { targetSessionId: 'original-session', acceptedAt: 42, mode: 'steering', delivery: 'queued' } };
    },
    askWorkHubTask: async (input: Record<string, unknown>) => { receive('ask', input); return { kind: 'new_task' }; },
    stopWorkHubTasks: async (input: Record<string, unknown>) => { receive('stop', input); return { kind: 'result', targets: [{ workId: 'task', targetSessionId: 'original-session', outcome: 'not_owned' }] }; },
  } as unknown as ReturnType<Parameters<typeof createWorkHubTaskModelRuntime>[0]['client']>;
  const runtime = createWorkHubTaskModelRuntime({
    client: () => client, isCurrent: () => current,
    createDefaults: async () => { defaultsCalls++; return defaults; },
    changed: (...args) => { changes.push(args); },
  });
  return { runtime, requests, changes, client, defaults, defaultsCalls: () => defaultsCalls, retire: () => { current = false; } };
}

test('six-tool model contracts have flat strict object roots and never accept authority or control status', () => {
  assert.deepEqual(Object.keys(workHubTaskToolSchemas), ['find', 'start', 'continue', 'ask', 'stop']);
  for (const call of calls) {
    const schema = workHubTaskToolSchemas[call.kind];
    assert.equal(schema.safeParse(call.input).success, true);
    assert.deepEqual(parseWorkHubTaskToolRequest(call.kind, call.input), call);
    const json = z.toJSONSchema(schema, { unrepresentable: 'any' });
    assert.equal(json.type, 'object'); assert.equal(json.additionalProperties, false);
    assert.equal('oneOf' in json || 'anyOf' in json, false);
    for (const key of ['status', 'turnId', 'actionId', 'actor', 'generationId', 'permissionMode', 'confirmed', 'executorId', 'model']) {
      assert.equal(schema.safeParse({ ...call.input, [key]: 'forged' }).success, false, `${call.kind} rejects ${key}`);
    }
  }
  assert.equal(workHubTaskToolSchemas.start.safeParse({ title: 'Task', text: 'x', sessionRef: 'manual', cwdHint: '/different' }).success, false);
  assert.equal(workHubTaskToolSchemas.stop.safeParse({ taskIds: ['task', 'task'] }).success, false);
  assert.equal(workHubTaskToolSchemas.ask.safeParse({ question: 'Which?', choices: [{ kind: 'task', id: 'task' }, { kind: 'task', id: 'task' }] }).success, false);
  assert.equal(workHubTaskToolSchemas.continue.safeParse({ taskId: 'task', text: '中'.repeat(Math.ceil(WORKHUB_TASK_INPUT_TEXT_MAX_BYTES / 3) + 1) }).success, false);
});

test('task descriptions retain original approvals and state backend limits without advertising retired tools', () => {
  const description = workHubTaskToolDescriptions.continue;
  assert.match(description, /Unsupported active backends or attachment input are rejected/u);
  assert.match(description, /never silently queued for a later Turn/u);
  assert.match(description, /Executor providers have no Host-native read bridge/u);
  assert.match(description, /fresh executor history recovery is not fully supported/u);
  assert.match(workHubTaskToolDescriptions.ask, /task approval interface for permissions/u);
  assert.doesNotMatch(Object.values(workHubTaskToolDescriptions).join(' '), /WorkHubEvidence|WorkHubResult|WorkHubInspect|ask_question|request\/resolve/u);
});

test('flat fields retain the native UTF-8 and Unicode character limits', () => {
  assert.equal(workHubTaskToolSchemas.ask.safeParse({ question: '中'.repeat(683), choices: [] }).success, false);
  assert.equal(workHubTaskToolSchemas.find.safeParse({ cwd: '中'.repeat(1366) }).success, false);
  assert.equal(workHubTaskToolSchemas.find.safeParse({ query: '😀'.repeat(256) }).success, true);
  assert.equal(workHubTaskToolSchemas.find.safeParse({ query: '😀'.repeat(257) }).success, false);
  assert.equal(workHubTaskToolSchemas.start.safeParse({ title: '😀'.repeat(512), text: 'Do it' }).success, true);
  assert.equal(workHubTaskToolSchemas.start.safeParse({ title: '😀'.repeat(513), text: 'Do it' }).success, false);
  for (const name of ['find', 'start', 'continue', 'ask', 'stop'] as const) {
    const json = z.toJSONSchema(workHubTaskToolSchemas[name], { unrepresentable: 'any' });
    assert.equal(json.type, 'object');
    const properties = json.properties as Record<string, { type?: string }>;
    if (name === 'start') assert.equal(properties.title?.type, 'string');
    if (name === 'ask') assert.equal(properties.question?.type, 'string');
  }
});

test('native model effects derive identity from the real Turn and tool call, not an old Session/action reference', async () => {
  const f = fixture();
  const request = calls[1]!;
  const first = await f.runtime.actTask(scope, 'real-turn', 'call-with.dot/opaque', request);
  assert.deepEqual(await f.runtime.actTask(scope, 'real-turn', 'call-with.dot/opaque', request), first);
  await f.runtime.actTask(scope, 'another-turn', 'call-with.dot/opaque', request);
  assert.equal(f.requests[0]!.input.actionId, f.requests[1]!.input.actionId);
  assert.notEqual(f.requests[0]!.input.actionId, f.requests[2]!.input.actionId);
  assert.equal(f.requests[0]!.input.turnId, 'real-turn');
  assert.deepEqual(f.requests[0]!.input.newWorkDefaults, f.defaults);
  assert.deepEqual(f.requests[0]!.input.create, { workspace: { kind: 'isolated' } });
  assert.deepEqual(Object.keys(first!).sort(), ['admission', 'taskId']);
});

test('start forwards only an intended location to existing Host admission and never overrides a manual Session', async () => {
  const f = fixture();
  await f.runtime.actTask(scope, 'turn', 'directory', { kind: 'start', input: { title: 'Code', text: 'Edit only the selected repo.', cwdHint: '/Users/test/My Repo' } });
  assert.deepEqual(f.requests[0]!.input.create, { workspace: { kind: 'host_path', path: '/Users/test/My Repo' } });
  await f.runtime.actTask(scope, 'turn', 'manual', { kind: 'start', input: { title: 'Adopt', text: 'Continue with existing settings.', sessionRef: 'manual' } });
  assert.equal(f.defaultsCalls(), 1);
  assert.equal(f.requests[1]!.input.sessionRef, 'manual');
  assert.equal('create' in f.requests[1]!.input || 'newWorkDefaults' in f.requests[1]!.input, false);
});

test('continue shares native task input and reports accepted steering without claiming consumption; fresh does not read new-work defaults', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.actTask(scope, 'turn', 'steer', calls[2]!), { taskId: 'task', container: 'reuse', acceptedAt: 42, mode: 'steering', delivery: 'queued' });
  assert.equal(f.requests[0]!.name, 'continue');
  assert.equal('sourceActionId' in f.requests[0]!.input, false);
  assert.deepEqual(await f.runtime.actTask(scope, 'turn', 'fresh', { kind: 'continue', input: { taskId: 'task', text: 'Read prior original evidence as needed.', container: 'fresh' } }), { taskId: 'task', container: 'fresh', admission: 'admitted' });
  assert.equal(f.defaultsCalls(), 0);
  assert.deepEqual(f.changes, [[scope, 'status-change', 'original-session'], [scope, 'created', 'fresh-session']]);
});

test('find returns exactly one page, ask does not delegate, and stop preserves not-owned/unknown outcomes', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.actTask(scope, 'turn', 'find', calls[0]!), { items: [], match: 'unmatched', nextCursor: null });
  assert.deepEqual(f.requests, [{ name: 'find', input: calls[0]!.input }]);
  assert.deepEqual(await f.runtime.actTask(scope, 'turn', 'ask', calls[3]!), { kind: 'new_task' });
  assert.deepEqual(f.changes, []);
  assert.deepEqual(await f.runtime.actTask(scope, 'turn', 'stop', calls[4]!), { kind: 'result', targets: [{ taskId: 'task', outcome: 'not_owned' }] });
  f.client.stopWorkHubTasks = async () => { throw new Error('commit_outcome_unknown'); };
  await assert.rejects(f.runtime.actTask(scope, 'turn', 'unknown', calls[4]!), /commit_outcome_unknown/);
  assert.equal(f.defaultsCalls(), 0);
});

test('a switched Host rejects all tool effects and late reads do not become current receipts', async () => {
  const f = fixture();
  f.retire();
  for (const call of calls) await assert.rejects(f.runtime.actTask(scope, 'turn', 'call', call), /Runtime Host changed/);
  assert.deepEqual(f.requests, []);
  const late = fixture();
  late.client.findWorkHubTasks = async () => { late.retire(); return { items: [], match: 'recent', nextCursor: null }; };
  await assert.rejects(late.runtime.actTask(scope, 'turn', 'read', { kind: 'find', input: {} }), /Runtime Host changed/);
});

test('a Host switch during defaults lookup prevents creation and a late committed receipt is not current evidence', async () => {
  const f = fixture(); let current = true;
  const runtime = createWorkHubTaskModelRuntime({ client: () => f.client, isCurrent: () => current,
    createDefaults: async () => { current = false; return f.defaults; }, changed() { assert.fail('No current receipt after a Host switch'); } });
  await assert.rejects(runtime.actTask(scope, 'turn', 'before-start', calls[1]!), /Runtime Host changed/);
  assert.deepEqual(f.requests, []);
  const committed = fixture(); let effects = 0;
  committed.client.startWorkHubTask = async input => {
    effects++; committed.retire();
    return { disposition: 'create_new', workId: input.actionId, targetSessionId: 'old-host-session' };
  };
  await assert.rejects(committed.runtime.actTask(scope, 'turn', 'after-start', calls[1]!), /Runtime Host changed/);
  assert.equal(effects, 1, 'the adapter never retries a possibly committed creation');
  assert.deepEqual(committed.changes, []);
});

test('busy fresh rejection propagates without creating a task or changing its input mode', async () => {
  const f = fixture(); let attempts = 0;
  f.client.continueWorkHubTaskFromTurn = async input => { attempts++; assert.equal(input.container, 'fresh'); throw Error('The task is still running'); };
  await assert.rejects(f.runtime.actTask(scope, 'turn', 'fresh', { kind: 'continue', input: { taskId: 'task', text: 'Continue', container: 'fresh' } }), /still running/);
  assert.equal(attempts, 1); assert.equal(f.defaultsCalls(), 0); assert.deepEqual(f.requests, []); assert.deepEqual(f.changes, []);
});
