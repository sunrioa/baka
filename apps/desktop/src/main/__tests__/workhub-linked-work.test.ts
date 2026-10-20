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

import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useEffect, useState } from "react";
import { deferred } from '@maka/core/test-only/async-primitives';
import { parseHTML } from 'linkedom';
import { ChatSurfaceLayout, LocaleProvider } from '@maka/ui';
import { WorkHubConversation, WorkHubHighlightContext, WorkHubTaskView, useWorkHubLinkedWork, workHubLinkedWork } from '../../renderer/features/workhub/testing.js';
import { renderTranscriptMarkup } from './transcript-test-dom.js';
import type { ToolCallMessage, ToolResultMessage } from '@maka/core/session';
import type { WorkHubTask, WorkHubTaskAssignment } from '@maka/runtime-host/protocol';
import type { WorkHubServices } from '../../renderer/features/workhub/index.js';

test('task history waits for its first transcript and Session identity before mounting scroll placement', async () => {
  const sessionId = JSON.stringify(['host', 'task']);
  const assignment: WorkHubTaskAssignment = { workId: 'work', generationId: 'work', actionId: 'action', delegationId: 'delegation', targetSessionId: sessionId, targetSessionName: 'Task', targetMessageId: 'message', text: 'Do the task', createdAt: 1, state: 'owned', superseded: false };
  for (const [ready, sessionReady] of [[false, true], [true, false], [true, true]]) {
    const services = {
      getTaskSession: async () => {
        if (!sessionReady) await new Promise(() => {});
        return { id: sessionId, name: 'Task', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' };
      },
      observe: (_id, _event, _error, phase) => { phase('ready'); return () => {}; },
      openTranscript: async (_id, accept) => {
        accept({ messages: ready ? [{ type: 'user', id: 'message', turnId: 'turn', ts: 1, text: 'Original task history' }] : [], ready, hasOlder: false });
        return { observationChanged() {}, async loadEarlier() {}, async close() {} };
      },
    } satisfies Pick<WorkHubServices, 'getTaskSession' | 'observe' | 'openTranscript'>;
    const snapshot = { assignments: [assignment], historyCursor: null, ready: true, loadingEarlier: false, executions: [], executionsReady: true };
    const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
      createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubTaskView, {
        services: services as unknown as WorkHubServices, owner: 'owner', workId: 'work', name: 'Task',
        view: { ...snapshot, currentSnapshot: () => snapshot, async refresh() {}, async loadEarlier() {}, selectAssignment() {}, selectExecution() {}, followLatest() {} },
      })),
    ));
    const { document } = parseHTML(markup);
    assert.equal(!!document.querySelector('.agents-chat-view-root'), ready && sessionReady, 'a pending reader must not settle the scroll position before history and Session identity arrive');
    if (ready && sessionReady) assert.match(document.querySelector('.workHubExecutionTranscript')!.textContent!, /Original task history/);
    else assert.equal(document.querySelector('.workHubExecutionTranscript')!.textContent!.includes('No public'), false);
  }
});

test('dispatch cards group canonical works, use exact latest facts and retain the complete receipt', async () => {
  const works = ['a', 'b', 'missing'].map(workId => ({ workId, id: `link-${workId}`, coordinationTurnId: 'turn', targetSessionId: 'shared-session', targetSessionName: workId, workspaceName: 'Workspace' }));
  const task = (actionId: string, workId: string, status: WorkHubTask['status'], createdAt: number): WorkHubTask => ({ actionId, workId, delegationId: `delegation-${actionId}`, targetSessionId: 'shared-session', targetSessionName: workId, targetMessageId: `message-${actionId}`, text: 'Task requirement', status, createdAt });
  const tasks = [task('a-old', 'a', 'pending_acceptance', 1), { ...task('a-new', 'a', 'queued', 3), targetSessionId: 'new-session' }, task('b', 'b', 'running', 2), task('unrelated', 'other-work', 'failed', 4)];
  for (const ready of [true, false]) {
    const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
      createElement(WorkHubHighlightContext.Provider, { value: {
        sessionId: undefined, selectedWork: { sessionId: 'shared-session', name: 'b', workId: 'b' }, highlight() {}, selectWork() {}, toggleWork() {},
      }, children: null }, createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
        activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
        messages: [
          { type: 'user', id: 'ask', turnId: 'turn', ts: 1, text: 'Do these tasks' },
          { type: 'assistant', id: 'answer', turnId: 'turn', ts: 2, modelId: 'model', text: 'Full technical receipt: all original identifiers remain readable.' },
          { type: 'turn_state', id: 'done', turnId: 'turn', ts: 3, status: 'completed' },
        ],
        workLinks: [...works, { ...works[0]!, id: 'duplicate-a' }], taskFacts: { tasks, ready },
        onNew() {}, onOpenWork() {}, scrollBehavior: 'auto',
      }))),
    ));
    const { document } = parseHTML(markup);
    const card = document.querySelector('.workhub-dispatch-card')!;
    assert.equal(card.querySelectorAll('.workhub-dispatch-row').length, 3, 'a shared turn has one row per work, not per assignment or Session');
    assert.equal(card.querySelector('[data-work-id="a"]')!.getAttribute('data-status'), ready ? 'queued' : 'unknown');
    assert.equal(card.querySelector('[data-work-id="b"]')!.getAttribute('data-status'), ready ? 'running' : 'unknown');
    assert.equal(card.querySelector('[data-work-id="missing"]')!.getAttribute('data-status'), 'unknown', 'a task in the same Session cannot supply another work’s state');
    assert.equal(card.querySelector('[data-work-id="a"]')!.getAttribute('aria-pressed'), 'false');
    assert.equal(card.querySelector('[data-work-id="b"]')!.getAttribute('aria-pressed'), 'true');
    const receipt = document.querySelector('.maka-turn-response-details')!;
    assert.equal(receipt.hasAttribute('open'), false);
    assert.match(receipt.textContent!, /Full technical receipt: all original identifiers remain readable/);
    assert.match(card.textContent!, /Status awaiting refresh/);
  }
});

test('WorkHub uses the common answer footer and failure presentation without prompt status or branch actions', async () => {
  const ts = 1_800_000_000_000;
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: [
        { type: 'user', id: 'ask', turnId: 'turn', ts, text: 'Check the task' },
        { type: 'assistant', id: 'answer', turnId: 'turn', ts: ts + 1000, modelId: 'model', text: 'Partial answer' },
        { type: 'turn_state', id: 'failed', turnId: 'turn', ts: ts + 2000, status: 'failed', errorClass: 'auth', failureMessage: 'Provider rejected this credential' },
      ],
      workLinks: [{ id: 'link', coordinationTurnId: 'turn', targetSessionId: 'target', targetSessionName: 'Target task' }],
      onNew: () => {}, onOpenWork: () => {}, scrollBehavior: 'auto',
    })),
  ));
  const { document } = parseHTML(markup);
  const user = document.querySelector('.maka-user-message')!;
  assert.equal(user.querySelectorAll('.workhub-delegation-status, .maka-message-status-time').length, 0);
  assert.ok(user.querySelector('[data-message-id="ask"]'));
  const footer = document.querySelector('.maka-turn-footer')!;
  assert.ok(footer.querySelector('[data-action="copy"]'));
  assert.ok(footer.querySelector('time'));
  assert.equal(footer.querySelectorAll('[data-action="branch"]').length, 0);
  assert.match(document.querySelector('.maka-turn-failed-banner')!.textContent!, /authentication|sign in|credential/i);
});

test('durable task results restore Host-scoped work links without treating failed or unrelated tools as delegations', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const call: ToolCallMessage = { type: 'tool_call', id: 'task-call', turnId: 'turn', ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: {} };
  const result: ToolResultMessage = { type: 'tool_result', id: 'task-result', turnId: 'turn', ts: 2, toolUseId: call.id, isError: false, content: { kind: 'json', value: { disposition: 'create_new', targetSessionKey: target } } };
  const expected = [{ id: result.id, coordinationTurnId: call.turnId, targetSessionId: target, targetSessionName: 'Renamed task', workspaceName: undefined }];
  assert.deepEqual(workHubLinkedWork([call, result], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  for (const cwd of ['/projects/payments/', 'C:\\projects\\payments\\']) {
    assert.deepEqual(workHubLinkedWork([call, result], [{ id: target, name: 'Renamed task', cwd }], 'Work'), [{ ...expected[0], workspaceName: 'payments' }]);
  }
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'json', value: { content: [], structuredContent: { disposition: 'create_new', targetSessionKey: target } } } }], [{ id: target, name: 'Renamed task' }], 'Work'), expected);
  assert.deepEqual(workHubLinkedWork([call, { ...result, content: { kind: 'text', text: JSON.stringify({ disposition: 'delegate_existing', targetSessionKey: target }) } }], [], 'Work'), [{ ...expected[0], targetSessionName: 'Work' }]);
  assert.deepEqual(workHubLinkedWork([
    call,
    { ...result, isError: true },
    { ...result, toolUseId: 'other-tool' },
    { ...result, content: { kind: 'json', value: { disposition: 'stop_work', targetSessionKey: target } } },
  ], [], 'Work'), []);
});

test('reused tool call IDs cannot attach another Turn’s result or classify a different tool as delegation', () => {
  const call = (turnId: string): ToolCallMessage => ({ type: 'tool_call', id: 'reused', turnId, ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation: 'stop' } } });
  const result = (turnId: string, targetSessionKey: string): ToolResultMessage => ({ type: 'tool_result', id: `result-${turnId}`, turnId, ts: 2, toolUseId: 'reused', isError: false, content: { kind: 'json', value: { targetSessionKey } } });
  const targets = ['first', 'second'].map(sessionId => JSON.stringify(['host', sessionId]));
  const stopped = workHubLinkedWork([call('one'), result('one', targets[0]!), call('two'), result('two', targets[1]!)], [], 'Work');
  assert.deepEqual(stopped.map(link => [link.coordinationTurnId, link.targetSessionId]), [['one', targets[0]], ['two', targets[1]]]);
  const unrelated = { ...call('two'), toolName: 'Read', args: {} };
  const misleading = result('two', targets[1]!);
  misleading.content = { kind: 'json', value: { disposition: 'create_new', targetSessionKey: targets[1] } };
  assert.deepEqual(workHubLinkedWork([call('one'), unrelated, misleading], [], 'Work'), []);
});

test('flat task receipts restore links by exact task projection without exposing Session IDs in model output', () => {
  const target = desktopSession('host-a', 'current-segment');
  const coordination = desktopSession('host-a', 'maka_workhub_coordination');
  const task: WorkHubTask & { title: string } = { actionId: 'assignment', workId: 'task-a', delegationId: 'delegation', targetSessionId: target,
    title: 'Current task title', targetSessionName: 'Renamed underlying conversation', targetMessageId: 'message', text: 'Exact requirement', createdAt: 2, status: 'running' };
  const call: ToolCallMessage = { type: 'tool_call', id: 'opaque-call', turnId: 'current-turn', ts: 3, toolName: 'mcp__desktop_workhub__continue', args: { taskId: 'task-a', text: 'Correct it' } };
  const result: ToolResultMessage = { type: 'tool_result', id: 'native-result', turnId: call.turnId, ts: 4, toolUseId: call.id, isError: false,
    content: { kind: 'json', value: { taskId: 'task-a', container: 'reuse', mode: 'steering', delivery: 'queued' } } };
  const links = () => workHubLinkedWork([call, result], [], 'Work', coordination, [task]);
  assert.deepEqual(links(), [{ workId: 'task-a', operation: 'continue', id: 'native-result', coordinationTurnId: 'current-turn',
    targetSessionId: target, targetSessionName: 'Current task title', workspaceName: undefined }]);
  assert.equal('targetSessionId' in (result.content.kind === 'json' ? result.content.value as object : {}), false);
  assert.deepEqual(workHubLinkedWork([call, result], [], 'Work', coordination), [], 'no guessed Session when a canonical task has not arrived');
  assert.deepEqual(workHubLinkedWork([call, { ...result, turnId: 'other-turn' }], [], 'Work', coordination, [task]), []);
  assert.deepEqual(workHubLinkedWork([call, { ...result, isError: true }], [], 'Work', coordination, [task]), []);
  assert.deepEqual(workHubLinkedWork([{ ...call, toolName: 'Read' }, result], [], 'Work', coordination, [task]), []);
  assert.deepEqual(workHubLinkedWork([{ ...call, args: { taskId: 'another-task' } }, result], [], 'Work', coordination, [task]), []);
  assert.deepEqual(workHubLinkedWork([call, result], [], 'Work', coordination, [{ ...task, targetSessionId: desktopSession('another-host', 'current-segment') }]), []);
  const startedCall = { ...call, toolName: 'mcp__desktop_workhub__start', args: { title: 'Title is not task identity', text: 'Independent goal' } };
  const started = { ...result, content: { kind: 'json' as const, value: { content: [], structuredContent: { taskId: 'task-a', admission: 'admitted' } } } };
  assert.equal(workHubLinkedWork([startedCall, started], [], 'Work', coordination, [task])[0]?.operation, 'start');
});

test('flat stop links keep each requested task and do not present stopping as a new dispatch', async () => {
  const target = desktopSession('host-a', 'segment');
  const coordination = desktopSession('host-a', 'maka_workhub_coordination');
  const task: WorkHubTask = { actionId: 'assignment', workId: 'task-a', delegationId: 'delegation', targetSessionId: target,
    targetSessionName: 'A', targetMessageId: 'message', text: 'Requirement', createdAt: 2, status: 'stopped' };
  const call: ToolCallMessage = { type: 'tool_call', id: 'stop-call', turnId: 'stop-turn', ts: 3, toolName: 'mcp__desktop_workhub__stop', args: { taskIds: ['task-a'] } };
  const result: ToolResultMessage = { type: 'tool_result', id: 'stop-result', turnId: call.turnId, ts: 4, toolUseId: call.id, isError: false,
    content: { kind: 'json', value: { kind: 'result', targets: [{ taskId: 'task-a', outcome: 'not_owned' }, { taskId: 'not-requested', outcome: 'stop_delivered' }] } } };
  const links = workHubLinkedWork([call, result], [], 'Work', coordination, [task, { ...task, workId: 'not-requested' }]);
  assert.equal(links.length, 1); assert.equal(links[0]?.workId, 'task-a'); assert.equal(links[0]?.operation, 'stop');
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: coordination, name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: [{ type: 'assistant', id: 'answer', turnId: 'stop-turn', ts: 5, modelId: 'test', text: 'The original execution is not owned.' }],
      scrollBehavior: 'auto', onNew() {},
      workLinks: links, taskFacts: { tasks: [task], ready: true }, onOpenWork() {},
    }))),
  );
  const { document } = parseHTML(markup);
  assert.equal(document.querySelectorAll('.workhub-dispatch').length, 0);
  assert.equal(document.querySelectorAll('[data-work-session-id]').length > 0, true, 'the task remains navigable');
});

test('flat continuation links use exact task lookup when the actual transcript has no control-plane facts', async () => {
  const target = desktopSession('host-a', 'old-segment');
  const coordination = desktopSession('host-a', 'maka_workhub_coordination');
  const call: ToolCallMessage = { type: 'tool_call', id: 'continue-old', turnId: 'current-turn', ts: 3,
    toolName: 'mcp__desktop_workhub__continue', args: { taskId: 'old-task', text: 'Continue it' } };
  for (const mode of ['steering', 'queued_supplement', 'continuation'] as const) {
    const assignment: WorkHubTaskAssignment = { workId: 'old-task', generationId: 'old-generation', actionId: 'old-action', delegationId: 'old-delegation',
      targetSessionId: target, targetSessionName: 'Original task', targetMessageId: 'target-message', text: 'Original requirement',
      createdAt: 1, state: 'queued', superseded: false };
    const result: ToolResultMessage = { type: 'tool_result', id: 'continued', turnId: call.turnId, ts: 5,
      toolUseId: call.id, isError: false, content: { kind: 'json', value: { taskId: 'old-task', container: 'reuse', mode, delivery: 'queued' } } };
    const reads: unknown[] = [];
    const services: Pick<WorkHubServices, 'readTask'> = { readTask: async (owner, input) => {
      assert.ok('workId' in input); reads.push({ owner, input }); return { task: taskFromAssignment(assignment, 'pending_acceptance') };
    } };
    function Probe() {
      const links = useWorkHubLinkedWork(services, coordination, [call, result], [], 'Work', [], 1);
      return createElement('output', null, links.map(link => createElement('span', { key: link.id, 'data-target': link.targetSessionId }, link.targetSessionName)));
    }
    const { document } = parseHTML(await renderTranscriptMarkup(createElement(Probe)));
    assert.equal(document.querySelector('output span')?.getAttribute('data-target'), target, mode);
    assert.equal(document.querySelector('output span')?.textContent, 'Original task', 'canonical lookup works without a loaded Session catalog');
    assert.deepEqual(reads, [{ owner: coordination, input: { workId: 'old-task' } }], 'one exact task read, not the recent overview or global history pages');
    for (const changed of [
      { ...assignment, targetSessionId: desktopSession('other-host', 'old-segment') },
      { ...assignment, targetSessionId: 'unscoped-model-session' },
      { ...assignment, workId: 'another-task' },
    ]) assert.deepEqual(workHubLinkedWork([call, result], [], 'Work', coordination, [], [changed]), []);
    assert.deepEqual(workHubLinkedWork([call, { ...result, turnId: 'another-turn' }], [], 'Work', coordination, [], [assignment]), []);
    assert.deepEqual(workHubLinkedWork([call, { ...result, isError: true }], [], 'Work', coordination, [], [assignment]), []);
  }
});

test('flat stop links recover every requested old task by exact identity without transcript stop claims', async () => {
  const coordination = desktopSession('host-a', 'maka_workhub_coordination');
  const call: ToolCallMessage = { type: 'tool_call', id: 'stop-old', turnId: 'stop-turn', ts: 3,
    toolName: 'mcp__desktop_workhub__stop', args: { taskIds: ['old-a', 'old-b'] } };
  const assignments: WorkHubTaskAssignment[] = ['old-a', 'old-b'].map(workId => ({ workId, generationId: workId,
    actionId: `assignment-${workId}`, delegationId: `delegation-${workId}`, targetSessionId: desktopSession('host-a', workId),
    targetMessageId: `message-${workId}`, targetSessionName: `Title ${workId}`, text: 'Original requirement', createdAt: 1, state: 'unavailable', superseded: false }));
  const result: ToolResultMessage = { type: 'tool_result', id: 'stopped', turnId: call.turnId, ts: 5, toolUseId: call.id, isError: false,
    content: { kind: 'json', value: { kind: 'result', targets: ['old-a', 'old-b', 'not-requested'].map(taskId => ({ taskId, outcome: 'already_terminal' })) } } };
  const reads: string[] = [];
  const services: Pick<WorkHubServices, 'readTask'> = { readTask: async (owner, input) => {
    assert.ok('workId' in input); assert.equal(owner, coordination); reads.push(input.workId);
    const assignment = assignments.find(item => item.workId === input.workId); assert.ok(assignment);
    return { task: taskFromAssignment(assignment, 'stopped') };
  } };
  function Probe() {
    const links = useWorkHubLinkedWork(services, coordination, [call, result], [], 'Work', [], 1);
    return createElement('output', null, links.map(link => createElement('span', { key: link.workId, 'data-target': link.targetSessionId, 'data-operation': link.operation }, link.targetSessionName)));
  }
  const { document } = parseHTML(await renderTranscriptMarkup(createElement(Probe)));
  assert.deepEqual(Array.from(document.querySelectorAll('output span'), element => [element.getAttribute('data-target'), element.getAttribute('data-operation'), element.textContent]),
    assignments.map(item => [item.targetSessionId, 'stop', item.targetSessionName]));
  assert.deepEqual(reads, ['old-a', 'old-b'], 'an unrequested target in a result does not cause a history read or navigation');
  assert.deepEqual(workHubLinkedWork([call, result], [], 'Work', coordination, [], assignments.map(item => ({ ...item, targetSessionId: desktopSession('other-host', 'target') }))), []);
  assert.deepEqual(workHubLinkedWork([call, { ...result, isError: true }], [], 'Work', coordination, [], assignments), []);
});

test('late exact-task reads cannot publish another Host target after an owner switch', async () => {
  const owners = ['host-a', 'host-b'].map(host => desktopSession(host, 'maka_workhub_coordination'));
  const assignment = (host: string): WorkHubTaskAssignment => ({ workId: 'old-task', generationId: 'generation', actionId: 'action', delegationId: 'delegation',
    targetSessionId: desktopSession(host, 'task'), targetSessionName: host, targetMessageId: 'message', text: 'Requirement', createdAt: 1, state: 'unavailable', superseded: false });
  const first = deferred<Awaited<ReturnType<WorkHubServices['readTask']>>>();
  const reads: string[] = [], displayed: Array<{ owner: string; targets: string[] }> = [];
  const services: Pick<WorkHubServices, 'readTask'> = { readTask: async (owner) => {
    reads.push(owner); return owner === owners[0] ? first.promise : { task: taskFromAssignment(assignment('host-b'), 'stopped') };
  } };
  const call: ToolCallMessage = { type: 'tool_call', id: 'continue', turnId: 'turn', ts: 1, toolName: 'mcp__desktop_workhub__continue', args: { taskId: 'old-task', text: 'Continue' } };
  const result: ToolResultMessage = { type: 'tool_result', id: 'receipt', turnId: call.turnId, ts: 2, toolUseId: call.id, isError: false,
    content: { kind: 'json', value: { taskId: 'old-task', container: 'fresh', admission: 'admitted' } } };
  function Probe() {
    const [owner, setOwner] = useState(owners[0]!);
    const links = useWorkHubLinkedWork(services, owner, [call, result], [], 'Work', [], 1);
    displayed.push({ owner, targets: links.map(link => link.targetSessionId) });
    useEffect(() => {
      setOwner(owners[1]!);
      first.resolve({ task: taskFromAssignment(assignment('host-a'), 'stopped') });
    }, []);
    return createElement('output', null, links.map(link => createElement('span', { key: link.id, 'data-target': link.targetSessionId }, link.targetSessionName)));
  }
  const { document } = parseHTML(await renderTranscriptMarkup(createElement(Probe)));
  assert.equal(document.querySelector('span')?.getAttribute('data-target'), desktopSession('host-b', 'task'));
  assert.deepEqual(reads, owners);
  assert.ok(displayed.every(value => value.owner !== owners[1] || value.targets.every(target => target === desktopSession('host-b', 'task'))));
});

test('invalid or failed native receipts never trigger exact-task lookup', async () => {
  const call: ToolCallMessage = { type: 'tool_call', id: 'continue', turnId: 'turn', ts: 1, toolName: 'mcp__desktop_workhub__continue', args: { taskId: 'old-task', text: 'Continue' } };
  const result: ToolResultMessage = { type: 'tool_result', id: 'receipt', turnId: call.turnId, ts: 2, toolUseId: call.id, isError: false,
    content: { kind: 'json', value: { taskId: 'old-task', mode: 'steering' } } };
  let reads = 0;
  const services: Pick<WorkHubServices, 'readTask'> = { readTask: async () => { reads++; return assert.fail('No accepted exact task receipt exists'); } };
  for (const [input, output] of [
    [call, { ...result, isError: true }], [call, { ...result, turnId: 'other-turn' }],
    [{ ...call, args: { taskId: 'unrelated' } }, result], [{ ...call, toolName: 'Read' }, result],
  ] as const) {
    function Probe() {
      const links = useWorkHubLinkedWork(services, desktopSession('host-a', 'maka_workhub_coordination'), [input, output], [], 'Work', [], 1);
      return createElement('output', { 'data-count': links.length });
    }
    const { document } = parseHTML(await renderTranscriptMarkup(createElement(Probe)));
    assert.equal(document.querySelector('output')?.getAttribute('data-count'), '0');
    assert.equal(reads, 0, 'failure and unrelated call/result identities do not cause even a read');
  }
});

function desktopSession(hostId: string, sessionId: string) { return JSON.stringify([hostId, sessionId]); }
function taskFromAssignment(item: WorkHubTaskAssignment, status: WorkHubTask['status']): WorkHubTask {
  return Object.assign({ workId: item.workId, actionId: item.actionId, delegationId: item.delegationId, targetSessionId: item.targetSessionId,
    targetSessionName: item.targetSessionName, targetMessageId: item.targetMessageId, text: item.text, createdAt: item.createdAt, status }, { title: item.targetSessionName });
}

test('a shared coordination turn divides its clickable identity rail equally between Works', async () => {
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: [{ type: 'user', id: 'user', turnId: 'shared', text: 'Do both tasks', ts: 1 }],
      scrollBehavior: 'auto', onNew: () => {}, onOpenWork: () => {},
      workLinks: ['Alpha', 'Beta'].map((name) => ({ id: name, coordinationTurnId: 'shared', targetSessionId: name, targetSessionName: name, workspaceName: 'Workspace' })),
    })),
  ));
  const { document } = parseHTML(markup);
  assert.deepEqual([...document.querySelectorAll('.workhub-turn-label')].map(item => item.textContent), ['Alpha', 'Beta']);
  assert.doesNotMatch(markup, /Workspace \/ (Alpha|Beta)/, 'WorkHub task labels do not expose the project hierarchy');
  assert.match(markup, /data-turn-accent="true"/);
  assert.match(markup, /inset-block-start:0%;inset-block-end:auto;height:50%/);
  assert.match(markup, /inset-block-start:50%;inset-block-end:auto;height:50%/);
  assert.match(markup, /View task execution: Alpha/);
  assert.match(markup, /View task execution: Beta/);
});

test('selecting a task never filters unrelated coordinator turns out of the main conversation', async () => {
  const markup = await renderTranscriptMarkup(createElement(LocaleProvider, { locale: 'en', children: null },
    createElement(WorkHubHighlightContext.Provider, { value: {
      sessionId: undefined, selectedWork: { sessionId: 'target', name: 'A', workId: 'a' },
      highlight() {}, selectWork() {}, toggleWork() {},
    }, children: null }, createElement(ChatSurfaceLayout, { composer: null, children: null }, createElement(WorkHubConversation, {
      activeSession: { id: 'coordination', name: 'WorkHub', status: 'active', labels: [], isFlagged: false, isArchived: false, hasUnread: false, backend: 'ai-sdk', llmConnectionSlug: 'test', connectionLocked: false, model: 'test', permissionMode: 'ask' },
      messages: ['A request', 'Unrelated B request', 'A follow-up'].map((text, index) => ({ type: 'user' as const, id: `user-${index}`, turnId: `turn-${index}`, ts: index + 1, text })),
      workLinks: [0, 2].map(index => ({ id: `link-${index}`, workId: 'a', coordinationTurnId: `turn-${index}`, targetSessionId: 'target', targetSessionName: 'A' })),
      onNew() {}, onOpenWork() {}, scrollBehavior: 'auto',
    }))),
  ));
  assert.match(markup, /A request/);
  assert.match(markup, /Unrelated B request/);
  assert.match(markup, /A follow-up/);
  assert.doesNotMatch(markup, /workhub-conversation-filter/);
});


test('WorkHub workspace display names handle Host paths independently of renderer platform', async () => {
  const { workspaceNameFromCwd } = await import('../../renderer/features/workhub/testing.js');
  assert.equal(workspaceNameFromCwd('/projects/maka/'), 'maka');
  assert.equal(workspaceNameFromCwd('C:\\projects\\maka\\'), 'maka');
  assert.equal(workspaceNameFromCwd(undefined), undefined);
  assert.equal(workspaceNameFromCwd('/'), undefined);
});


test('stop and resume keep their scoped Session identity through pending, success and failure', () => {
  const target = JSON.stringify(['host-a', 'task-a']);
  const coordination = JSON.stringify(['host-a', 'maka_workhub_coordination']);
  const catalog = [{ id: target, name: 'Login UI', cwd: '/projects/login' }, { id: JSON.stringify(['host-b', 'task-a']), name: 'Other host' }];
  for (const operation of ['stop', 'resume'] as const) {
    const call: ToolCallMessage = { type: 'tool_call', id: operation, turnId: 'control-turn', ts: 1, toolName: 'mcp__desktop_workhub__tasks', args: { request: { operation, targetSessionId: 'task-a' } } };
    const pending = workHubLinkedWork([call], catalog, 'Work', coordination);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.targetSessionId, target);
    const failed: ToolResultMessage = { type: 'tool_result', id: 'failure', turnId: call.turnId, ts: 2, toolUseId: call.id, isError: true, content: { kind: 'text', text: 'Safe-boundary resume is disabled' } };
    const link = workHubLinkedWork([call, failed], catalog, 'Work', coordination)[0]!;
    assert.equal(link.targetSessionId, target);
    const success: ToolResultMessage = { ...failed, isError: false, content: { kind: 'json', value: { disposition: `${operation}_work`, targetSessionKey: target, outcome: operation === 'stop' ? 'stop_delivered' : 'resume_started' } } };
    const links = workHubLinkedWork([call, success], catalog, 'Work', coordination);
    assert.equal(links.length, 1);
    assert.equal(links[0]?.targetSessionId, target);
    assert.deepEqual(workHubLinkedWork([call, failed], catalog, 'Work'), []);
    assert.deepEqual(workHubLinkedWork([{ ...call, toolName: 'unrelated' }, success], catalog, 'Work', coordination), []);
  }
});
