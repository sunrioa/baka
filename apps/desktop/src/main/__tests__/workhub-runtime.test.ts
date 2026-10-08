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
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { ProjectCatalogProjectDetails } from '@maka/runtime-host/protocol';
import { decodeWorkHubCoordinationActFromTurnInput, decodeWorkHubCoordinationSelectAndDelegateInput } from '@maka/runtime-host/protocol';
import { workHubTasksSchema } from '../../shared/workhub-tool-schema.js';
import { createWorkHubRuntime } from '../workhub-runtime.js';

const scope = { hostId: 'host', targetEpoch: 'epoch' };
function fixture() {
  let current = true;
  const requests: unknown[] = [];
  const stops: unknown[] = [];
  const changes: unknown[] = [];
  const deps: Parameters<typeof createWorkHubRuntime>[0] = {
    isCurrent: () => current,
    client: () => client,
    createDefaults: async () => ({ permissionMode: 'ask' }),
    changed: (...args) => { changes.push(args); },
  };
  const client = {
    listProjects: async () => [],
    queryTurn: async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run', status: 'running' as const }),
    stopTurn: async (input: unknown) => { stops.push(input); },
    listWorkHubCoordinationCandidates: async () => ({ candidateSetId: 'set', candidates: [] }),
    actWorkHubCoordinationFromTurn: async (input: unknown) => {
      requests.push(input);
      return { disposition: 'create_new' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
    },
  } as unknown as ReturnType<typeof deps.client>;
  return { deps, client, requests, stops, changes, retire: () => { current = false; }, runtime: createWorkHubRuntime(deps) };
}

test('task delegation binds the tool action to the Host turn and trusted creation context', async () => {
  const f = fixture();
  const result = await f.runtime.actTasks(scope, 'turn', 'tool-call', { operation: 'create_new', title: 'Fix login', text: 'Implement and test the login fix' });
  assert.deepEqual(f.requests, [{
    turnId: 'turn', actionId: 'tool-call', proposal: { disposition: 'create_new', title: 'Fix login' },
    delegationText: 'Implement and test the login fix', create: { workspace: { kind: 'isolated' } },
    newWorkDefaults: { permissionMode: 'ask' },
  }]);
  assert.ok('actionId' in result);
  assert.equal(result.actionId, 'tool-call');
  assert.deepEqual(f.changes, [[scope, 'created', 'target']]);
});

test('nested tool calls produce stable task identities accepted by both Host action paths', async () => {
  const f = fixture();
  const toolCallId = `${'p'.repeat(128)}:nested:00000000-0000-4000-8000-000000000001`;
  const actionIds: string[] = [];
  const result = { disposition: 'create_new' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
  f.client.actWorkHubCoordinationFromTurn = async (input) => {
    actionIds.push(decodeWorkHubCoordinationActFromTurnInput(input).actionId);
    return result;
  };
  f.client.selectAndDelegateWorkHubTarget = async (input) => {
    actionIds.push(decodeWorkHubCoordinationSelectAndDelegateInput(input).actionId);
    return { kind: 'delegated', result };
  };

  const create = { operation: 'create_new' as const, title: 'Work', text: 'Do work' };
  const created = await f.runtime.actTasks(scope, 'turn', toolCallId, create);
  const retried = await f.runtime.actTasks(scope, 'turn', toolCallId, create);
  const selected = await f.runtime.actTasks(scope, 'turn', toolCallId, {
    operation: 'select_and_delegate', candidateSetId: `sha256:${'a'.repeat(64)}`,
    candidateRefs: ['candidate'], text: 'Do work',
  });
  for (const outcome of [created, retried, selected]) {
    assert.ok('actionId' in outcome);
    assert.equal(outcome.actionId, actionIds[0]);
  }
  assert.deepEqual(actionIds, [actionIds[0], actionIds[0], actionIds[0]]);
  const next = await f.runtime.actTasks(scope, 'turn', toolCallId.replace(/1$/, '2'), create);
  assert.ok('actionId' in next);
  assert.equal(next.actionId, actionIds[3]);
  assert.notEqual(next.actionId, actionIds[0]);
});

test('linked task operations remain operations at the Host protocol boundary', async () => {
  const f = fixture();
  await f.runtime.actTasks(scope, 'turn', 'correct-action', {
    operation: 'correct',
    replacesActionId: 'old-action',
    candidateSetId: 'set',
    target: { disposition: 'delegate_existing', candidateRef: 'candidate' },
    text: 'Move the delegated work',
  });
  await f.runtime.actTasks(scope, 'turn', 'stop-action', {
    operation: 'stop',
    targetSessionId: 'target',
  });
  await f.runtime.actTasks(scope, 'turn', 'resume-action', {
    operation: 'resume',
    targetSessionId: 'target',
    resumesActionId: 'stop-action',
  });

  assert.deepEqual(f.requests, [
    {
      turnId: 'turn',
      actionId: 'correct-action',
      proposal: {
        operation: 'correct',
        replacesActionId: 'old-action',
        target: { disposition: 'delegate_existing', candidateRef: 'candidate' },
      },
      delegationText: 'Move the delegated work',
      candidateSetId: 'set',
    },
    {
      turnId: 'turn',
      actionId: 'stop-action',
      proposal: { operation: 'stop', expects: { targetSessionId: 'target' } },
    },
    {
      turnId: 'turn',
      actionId: 'resume-action',
      proposal: {
        operation: 'resume',
        resumesActionId: 'stop-action',
        expects: { targetSessionId: 'target' },
      },
    },
  ]);
});

test('the task tool exposes correction as a linked operation, not a disposition', () => {
  const correction = {
    operation: 'correct',
    replacesActionId: 'old-action',
    target: { disposition: 'create_new', title: 'Replacement' },
    text: 'Correct the earlier delegation',
  };
  assert.deepEqual(workHubTasksSchema.parse(correction), correction);
  assert.equal(
    workHubTasksSchema.safeParse({ ...correction, operation: 'replace' }).success,
    false,
  );
});

test('a Host switch while resolving creation defaults prevents delegation', async () => {
  const f = fixture();
  const original = f.deps.createDefaults;
  f.deps.createDefaults = async (target) => { const defaults = await original(target); f.retire(); return defaults; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'tool-call', { operation: 'create_new', title: 'Work', text: 'Do work' }), /Runtime Host changed/);
  assert.deepEqual(f.requests, []);
});

function project(index: number, overrides: Partial<ProjectCatalogProjectDetails> = {}): ProjectCatalogProjectDetails {
  return { id: `project-${index}`, name: `Project ${index}`, aliases: [], locationCount: 1,
    archivedAt: null, available: true, preferredPath: `/project-${index}`, locations: [], ...overrides };
}

test('project discovery is bounded, read-only and hides unavailable catalog entries and paths', async () => {
  const f = fixture();
  f.client.listProjects = async () => [
    ...Array.from({ length: 33 }, (_, index) => project(index)),
    project(90, { archivedAt: 1 }), project(91, { available: false }), project(92, { preferredPath: null }),
  ];
  const all = await f.runtime.actTasks(scope, 'turn', 'projects', { operation: 'projects' });
  assert.ok('projects' in all);
  assert.ok(all.projects);
  assert.equal(all.projects.length, 32);
  assert.equal(all.truncated, true);
  assert.deepEqual(Object.keys(all.projects[0]!).sort(), ['name', 'projectRef']);
  const filtered = await f.runtime.actTasks(scope, 'turn', 'query', { operation: 'projects', query: 'PROJECT 32' });
  assert.ok('projects' in filtered);
  assert.ok(filtered.projects);
  assert.equal(filtered.projects[0]?.name, 'Project 32');
  assert.equal(filtered.truncated, false);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.changes, []);
});

test('project references bind creation to the current Host catalog and preferred path', async () => {
  const f = fixture();
  let available = project(1);
  f.client.listProjects = async () => [available];
  const discovered = await f.runtime.actTasks(scope, 'turn', 'projects', { operation: 'projects' });
  assert.ok('projects' in discovered);
  assert.ok(discovered.projects);
  const projectRef = discovered.projects[0]!.projectRef;
  for (const request of [
    { operation: 'create_new' as const, title: 'Fix', text: 'Fix the registered project', projectRef },
    { operation: 'correct' as const, replacesActionId: 'previous', text: 'Fix the registered project',
      target: { disposition: 'create_new' as const, title: 'Fix', projectRef } },
  ]) {
    await f.runtime.actTasks(scope, 'turn', `tool-${request.operation}`, request);
    const input = decodeWorkHubCoordinationActFromTurnInput(f.requests.at(-1));
    assert.deepEqual(input.create, { workspace: { kind: 'project', projectId: 'project-1' } });
    assert.deepEqual(input.newWorkDefaults, { permissionMode: 'ask' });
    assert.equal(JSON.stringify(input.proposal).includes(projectRef), false);
  }
  f.requests.length = 0;
  const create = { operation: 'create_new' as const, title: 'Fix', text: 'Fix', projectRef };
  for (const next of [project(1, { archivedAt: 1 }), project(1, { available: false }), project(1, { preferredPath: '/relinked' })]) {
    available = next;
    await assert.rejects(f.runtime.actTasks(scope, 'turn', 'stale', create), /reference is unavailable/);
  }
  available = project(1);
  await assert.rejects(f.runtime.actTasks({ ...scope, hostId: 'foreign' }, 'turn', 'foreign', create), /reference is unavailable/);
  assert.deepEqual(f.requests, []);
  f.client.listProjects = async () => { f.retire(); return [available]; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'changed', { operation: 'projects' }), /Runtime Host changed/);
});

test('task creation never accepts a model-provided workspace or permission override', () => {
  const create = { operation: 'create_new', title: 'Work', text: 'Do work' };
  for (const extra of [{ path: '/arbitrary' }, { workspace: { kind: 'host_path', path: '/arbitrary' } }, { permissionMode: 'bypass' }])
    assert.equal(workHubTasksSchema.safeParse({ ...create, ...extra }).success, false);
});

test('takeover stops the exact old turn and run even after selecting another Host', async () => {
  const f = fixture();
  f.retire();
  await f.runtime.interrupt(scope, 'turn');
  assert.deepEqual(f.stops, [{ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'turn', runId: 'run' }]);
  await assert.rejects(f.runtime.assertTurn(scope, 'turn'), /Runtime Host changed/);
});

test('a changed turn identity cannot become the takeover target', async () => {
  const f = fixture();
  f.client.queryTurn = async () => ({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId: 'new-turn', runId: 'new-run', status: 'running' });
  await assert.rejects(f.runtime.interrupt(scope, 'turn'), /turn identity changed/);
  assert.deepEqual(f.stops, []);
});

test('delegation receipts explicitly distinguish admission from completion evidence', async () => {
  const f = fixture();
  const result = await f.runtime.actTasks(scope, 'turn', 'receipt', { operation: 'create_new', title: 'Work', text: 'Write a plan' });
  assert.deepEqual((result as unknown as Record<string, unknown>).executionEvidence, {
    status: 'admitted', completionVerified: false, artifactsVerified: false,
  });
});

test('task status can be checked without dispatching another task', () => {
  assert.equal(workHubTasksSchema.safeParse({ operation: 'status', targetSessionId: 'target', targetTurnId: 'target-turn' }).success, true);
  assert.equal(workHubTasksSchema.safeParse({ operation: 'status', targetSessionId: 'target', targetMessageId: 'message' }).success, true);
  assert.equal(workHubTasksSchema.safeParse({ operation: 'status', targetSessionId: 'target' }).success, false);
});

test('status reads exact turn facts without delegation and rejects stale Host or target identity', async () => {
  const f = fixture();
  f.client.listWorkHubCoordinationCandidates = async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'target' }] }) as unknown as Awaited<ReturnType<typeof f.client.listWorkHubCoordinationCandidates>>;
  f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'target-turn', runId: 'run', status: 'completed', terminalEventId: 'done' });
  const request = { operation: 'status' as const, targetSessionId: 'target', targetTurnId: 'target-turn' };
  const result = await f.runtime.actTasks(scope, 'turn', 'status-call', request);
  assert.ok('executionEvidence' in result);
  assert.deepEqual(result.executionEvidence, { status: 'completed', scope: 'exact_turn', completionVerified: true, artifactsVerified: false });
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.stops, []);
  assert.deepEqual(f.changes, []);
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'other', { ...request, targetSessionId: 'outside' }), /outside current WorkHub discovery/);
  f.client.queryTurn = async () => ({ sessionId: 'wrong', turnId: 'target-turn', runId: 'run', status: 'running' });
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'wrong', request), /identity changed/);
  f.client.queryTurn = async () => { f.retire(); return { sessionId: 'target', turnId: 'target-turn', runId: 'run', status: 'running' }; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'stale', request), /Host changed/);
});

test('status does not treat waiting, cancelled or failed execution as completed', async () => {
  const f = fixture();
  f.client.listWorkHubCoordinationCandidates = async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'target' }] }) as unknown as Awaited<ReturnType<typeof f.client.listWorkHubCoordinationCandidates>>;
  for (const status of ['waiting_for_user', 'cancelled', 'failed'] as const) {
    f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'target-turn', runId: 'run', status, terminalEventId: 'terminal', abortSource: 'user', failureClass: 'test' });
    const result = await f.runtime.actTasks(scope, 'turn', 'status', { operation: 'status', targetSessionId: 'target', targetTurnId: 'target-turn' });
    assert.ok('executionEvidence' in result);
    assert.equal(result.executionEvidence?.status, status);
    assert.equal(result.executionEvidence?.completionVerified, false);
  }
});

test('delegation status follows Message ownership, never the completed admission Turn', async () => {
  const f = fixture();
  f.client.listWorkHubCoordinationCandidates = async () => ({ candidateSetId: 'set', candidates: [{ sessionId: 'target' }] }) as unknown as Awaited<ReturnType<typeof f.client.listWorkHubCoordinationCandidates>>;
  const queriedTurns: string[] = [];
  f.client.queryTurn = async ({ turnId }) => {
    queriedTurns.push(turnId);
    return turnId === 'ancestor'
      ? { sessionId: 'target', turnId, runId: 'execution-run', status: 'completed', terminalEventId: 'done' }
      : { sessionId: 'target', turnId, runId: 'execution-run', status: 'running' };
  };
  let state: 'pending' | 'cancelled' | 'not_admitted' | 'owned' = 'pending';
  f.client.queryMessageExecutions = async () => ({ resolutions: [state === 'owned'
    ? { messageId: 'message', state, turnId: 'delegated-turn', runId: 'execution-run' }
    : { messageId: 'message', state }] });
  const request = { operation: 'status' as const, targetSessionId: 'target', targetMessageId: 'message', targetTurnId: 'ancestor' };
  for (state of ['pending', 'cancelled', 'not_admitted', 'owned'] as const) {
    const result = await f.runtime.actTasks(scope, 'turn', 'status', request);
    assert.ok('executionEvidence' in result);
    assert.equal(result.executionEvidence?.status, state === 'owned' ? 'running' : state);
    assert.equal(result.executionEvidence?.completionVerified, false);
  }
  assert.deepEqual(queriedTurns, ['delegated-turn']);
  assert.deepEqual(f.requests, []);
  f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'delegated-turn', runId: 'execution-run', status: 'completed', terminalEventId: 'done' });
  const completed = await f.runtime.actTasks(scope, 'turn', 'completed', request);
  assert.ok('executionEvidence' in completed);
  assert.equal(completed.executionEvidence?.completionVerified, true);
  f.client.queryTurn = async () => ({ sessionId: 'target', turnId: 'delegated-turn', runId: 'wrong-run', status: 'completed', terminalEventId: 'done' });
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'wrong-run', request), /identity changed/);
  f.client.queryMessageExecutions = async () => ({ resolutions: [{ messageId: 'other', state: 'pending' }] });
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'wrong-message', request), /identity is unresolved/);
  f.client.queryMessageExecutions = async () => { f.retire(); return { resolutions: [{ messageId: 'message', state: 'pending' }] }; };
  await assert.rejects(f.runtime.actTasks(scope, 'turn', 'stale', request), /Host changed/);
});

test('stop and resume receipts survive the client capability JSON boundary', async () => {
  const { decodeClientCapabilityResult } = await import('@maka/runtime-host/protocol');
  for (const disposition of ['stop_work', 'resume_work'] as const) {
    const f = fixture();
    f.client.actWorkHubCoordinationFromTurn = async () => ({
      disposition, outcome: disposition === 'stop_work' ? 'stop_delivered' : 'resume_started',
      targetSessionId: 'target', targetTurnId: 'target-turn',
    } as Awaited<ReturnType<typeof f.client.actWorkHubCoordinationFromTurn>>);
    const result = await f.runtime.actTasks(scope, 'turn', 'action', disposition === 'stop_work'
      ? { operation: 'stop', targetSessionId: 'target' }
      : { operation: 'resume', targetSessionId: 'target', resumesActionId: 'previous' });
    assert.deepEqual(decodeClientCapabilityResult({ content: [], structuredContent: result }).structuredContent, result);
    assert.equal(Object.hasOwn(result, 'executionEvidence'), false);
  }
});
