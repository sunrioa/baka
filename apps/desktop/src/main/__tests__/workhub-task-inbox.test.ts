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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { WorkHubPendingInteraction, WorkHubTask, WorkHubTaskAssignment } from '@maka/runtime-host/protocol';
import { WorkHubServicesProvider, type WorkHubServices } from '../../renderer/features/workhub/index.js';
import { useWorkHubTaskInbox, useWorkHubTaskSelection, useWorkHubTaskView, WorkHubTaskInbox, WorkHubTaskView } from '../../renderer/features/workhub/testing.js';
import type { WorkHubPresentationSnapshot } from '../../shared/workhub-presentation.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

test('opening an inbox approval resolves its task independently of the first eight history assignments', async () => {
  const owner = desktopSessionKey({ hostId: 'host', sessionId: 'maka_workhub_coordination' });
  const target = desktopSessionKey({ hostId: 'host', sessionId: 'shared-session' });
  const original: WorkHubTask = { workId: 'work', actionId: 'original', delegationId: 'original-link',
    targetSessionId: target, targetSessionName: 'Task', targetMessageId: 'original-message', text: 'Original task',
    createdAt: 1, status: 'waiting_for_user', execution: { turnId: 'waiting-turn', runId: 'waiting-run', sharedTurn: false } };
  const foreign: WorkHubTask = { ...original, workId: 'other-work', actionId: 'other', delegationId: 'other-link' };
  const pending = (task: WorkHubTask, toolName: string): WorkHubPendingInteraction => ({
    actionId: task.actionId, delegationId: task.delegationId, targetSessionName: task.targetSessionName,
    interaction: { schemaVersion: 1, interactionId: `request-${task.actionId}`, sessionId: target,
      turnId: 'waiting-turn', runId: 'waiting-run', revision: 1, status: 'pending', outcome: null,
      request: { kind: 'permission', toolUseId: `tool-${task.actionId}`,
        prompt: { kind: 'tool_permission', toolName, category: 'shell_unsafe', reason: 'shell_dangerous',
          review: { kind: 'command', command: 'npm test' }, rememberForTurnAllowed: true } } },
  });
  const request = pending(original, 'Original tool');
  const unrelated = pending(foreign, 'Other task tool');
  const recent: WorkHubTaskAssignment[] = Array.from({ length: 8 }, (_, index) => ({
    workId: 'work', generationId: 'work', actionId: `later-${index}`, delegationId: `later-link-${index}`,
    targetSessionId: target, targetSessionName: 'Task', targetMessageId: `later-message-${index}`, text: 'Later continuation',
    createdAt: 20 - index, state: index % 2 ? 'cancelled' : 'queued', superseded: false,
  }));
  const taskReads: Array<Parameters<WorkHubServices['readTask']>[1]> = [];
  const historyReads: Array<Parameters<WorkHubServices['taskHistory']>[1]> = [];
  const answers: Array<Parameters<WorkHubServices['answerTaskInteraction']>> = [];
  let answered = false;
  let snapshot: WorkHubPresentationSnapshot = { placement: 'docked', floatingVisible: false, shortcutRegistered: true, rendererCrashed: false };
  const subscribers = new Set<(value: WorkHubPresentationSnapshot) => void>();
  const services = {
    presentation: {
      getSnapshot: async () => snapshot,
      subscribe(notify: (value: WorkHubPresentationSnapshot) => void) { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
      async selectTask(selection: NonNullable<WorkHubPresentationSnapshot['taskSelection']>) {
        snapshot = { ...snapshot, taskSelection: selection };
        for (const notify of subscribers) notify(snapshot);
      },
    },
    async readTask(sessionId, ref) {
      assert.equal(sessionId, owner); taskReads.push(ref);
      assert.ok('actionId' in ref, 'the original request uses an exact assignment read, not the latest task');
      const task = ref.actionId === original.actionId ? original : foreign;
      assert.equal(ref.delegationId, task.delegationId);
      return { task };
    },
    async taskHistory(sessionId, input) {
      assert.equal(sessionId, owner); assert.equal(input.workId, 'work'); historyReads.push(input);
      assert.equal(input.cursor, undefined, 'approval membership must not walk older history');
      assert.equal(input.actionId, undefined, 'do not insert the original assignment into the first page');
      return { workId: 'work', assignments: recent, nextCursor: 'original-on-next-page' };
    },
    taskExecutions: async () => assert.fail('the first page has no owned execution'),
    queryTaskInteractions: async () => ({ requests: answered ? [unrelated] : [request, unrelated], truncated: false }),
    async answerTaskInteraction(sessionId, input) { answers.push([sessionId, input]); answered = true; throw new Error('Answer receipt was lost'); },
    subscribeSessions: () => () => {}, subscribeAvailability: () => () => {}, subscribeActiveInteractions: () => () => {},
    getTaskSession: async () => null,
    observe(_id, _event, _error, phase) { phase('ready'); return () => {}; },
    async openTranscript(_id, accept) {
      accept({ messages: [], ready: true, hasOlder: false });
      return { observationChanged() {}, loadEarlier: async () => {}, close: async () => {} };
    },
  } satisfies Pick<WorkHubServices, 'readTask' | 'taskHistory' | 'taskExecutions' | 'queryTaskInteractions' |
    'answerTaskInteraction' | 'subscribeSessions' | 'subscribeAvailability' | 'subscribeActiveInteractions' |
    'getTaskSession' | 'observe' | 'openTranscript'> & { presentation: Pick<WorkHubServices['presentation'], 'getSnapshot' | 'subscribe' | 'selectTask'> };
  const ports = services as unknown as WorkHubServices;
  let selection!: ReturnType<typeof useWorkHubTaskSelection>;
  let inbox!: ReturnType<typeof useWorkHubTaskInbox>;
  let view!: ReturnType<typeof useWorkHubTaskView>;
  let openRequest!: (item: WorkHubPendingInteraction) => Promise<void>;
  function Probe() {
    selection = useWorkHubTaskSelection(ports, owner);
    inbox = useWorkHubTaskInbox(ports, owner);
    view = useWorkHubTaskView(ports, owner, selection.selected?.workId);
    openRequest = item => selection.open({ actionId: item.actionId, delegationId: item.delegationId });
    return selection.selected
      ? createElement(WorkHubTaskView, { services: ports, owner, workId: selection.selected.workId, name: selection.selected.name, view, inbox })
      : createElement(WorkHubTaskInbox, { inbox, onView: openRequest });
  }
  const { root, container } = installReactRenderer();
  await act(async () => { root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkHubServicesProvider, { services: ports, children: createElement(Probe) }) })); });
  assert.equal(inbox.ready, true);
  assert.equal(Boolean(selection.selected), false);
  await act(async () => { await openRequest(request); });
  assert.equal(selection.selected?.workId, 'work');
  assert.equal(view.assignments.length, 8);
  assert.equal(view.assignments.some(item => item.actionId === original.actionId), false);
  assert.equal(view.historyCursor, 'original-on-next-page');
  assert.deepEqual(historyReads, [{ workId: 'work' }]);
  assert.match(container.textContent, /Original tool/);
  assert.match(container.textContent, /Allow once/);
  assert.match(container.textContent, /Allow for this turn/);
  assert.doesNotMatch(container.textContent, /Other task tool/);
  assert.ok(taskReads.some(ref => 'actionId' in ref && ref.actionId === original.actionId));
  const actual = inbox.requests.find(item => item.actionId === original.actionId)!;
  assert.equal(actual, request, 'the original interaction identity and options remain the responder input');
  await act(async () => {
    await assert.rejects(inbox.respond(actual, { kind: 'permission', decision: 'allow', rememberForTurn: false }), /Answer receipt was lost/);
  });
  assert.deepEqual(answers, [[owner, { actionId: original.actionId, interactionId: request.interaction.interactionId,
    expectedTurnId: 'waiting-turn', expectedRunId: 'waiting-run', answer: { kind: 'permission', decision: 'allow', rememberForTurn: false } }]]);
  assert.equal(inbox.ready, true);
  assert.deepEqual(inbox.requests, [unrelated], 'a lost answer receipt is reconciled from the original Host inbox');
  assert.doesNotMatch(container.textContent, /Allow once|Other task tool/);
});

test('Host-proven child approvals retain their own Session and execution while sharing the parent task lookup', async () => {
  const { owner, task: source, request } = inboxFixture('host');
  const task: WorkHubTask = { ...source, execution: { turnId: 'turn', runId: 'run', sharedTurn: false } };
  const rootRequest: WorkHubPendingInteraction = { ...request, interaction: { ...request.interaction,
    request: { kind: 'permission', toolUseId: 'root-tool',
      prompt: { kind: 'tool_permission', toolName: 'Parent tool', category: 'shell_unsafe', reason: 'shell_dangerous',
        review: { kind: 'command', command: 'npm test' }, rememberForTurnAllowed: false } } } };
  const childRequest: WorkHubPendingInteraction = { ...request, interaction: { ...request.interaction,
    sessionId: desktopSessionKey({ hostId: 'host', sessionId: 'graph-child' }),
    interactionId: 'child-request', turnId: 'child-turn', runId: 'child-run',
    request: { kind: 'permission', toolUseId: 'child-tool',
      prompt: { kind: 'tool_permission', toolName: 'Child tool', category: 'shell_unsafe', reason: 'shell_dangerous',
        review: { kind: 'command', command: 'npm test -- child' }, rememberForTurnAllowed: false } } } };
  let requests = [rootRequest, childRequest];
  const reads: Array<Parameters<WorkHubServices['readTask']>> = [];
  const answers: Array<Parameters<WorkHubServices['answerTaskInteraction']>> = [];
  const assignment: WorkHubTaskAssignment = { workId: 'work', generationId: 'work', actionId: task.actionId,
    delegationId: task.delegationId, targetSessionId: task.targetSessionId, targetSessionName: task.targetSessionName,
    targetMessageId: task.targetMessageId, text: task.text, createdAt: 1, state: 'owned', superseded: false,
    execution: { turnId: rootRequest.interaction.turnId, runId: rootRequest.interaction.runId } };
  const services = {
    async readTask(sessionId, ref) {
      reads.push([sessionId, ref]);
      assert.equal(sessionId, owner);
      assert.deepEqual(ref, { actionId: task.actionId, delegationId: task.delegationId });
      return { task };
    },
    // This port preserves the Host's belongsToRoot-proven original snapshots;
    // the child Session is not rewritten to the task's root Session.
    queryTaskInteractions: async () => ({ requests, truncated: false }),
    async answerTaskInteraction(sessionId, input) {
      answers.push([sessionId, input]);
      const original = requests.find(item => item.interaction.interactionId === input.interactionId);
      assert.ok(original);
      assert.equal(input.actionId, task.actionId);
      assert.equal(input.expectedTurnId, original.interaction.turnId);
      assert.equal(input.expectedRunId, original.interaction.runId);
      assert.equal(input.answer.kind, 'permission');
      if (input.answer.kind !== 'permission') assert.fail('Expected the original permission answer');
      requests = requests.filter(item => item !== original);
      return { ...original.interaction, status: 'answered' as const, revision: 2,
        outcome: { ...input.answer, kind: 'permission_answer' as const, reviewer: 'user' as const, committedAt: 2 } };
    },
    taskHistory: async () => ({ workId: 'work', assignments: [assignment], nextCursor: null }),
    taskExecutions: async () => ({ actionId: task.actionId, delegationId: task.delegationId, targetSessionId: task.targetSessionId,
      executions: [{ sessionId: task.targetSessionId, turnId: 'turn', runId: 'run', status: 'waiting_for_user' as const }], nextCursor: null }),
    subscribeSessions: () => () => {}, subscribeAvailability: () => () => {}, subscribeActiveInteractions: () => () => {},
    getTaskSession: async () => null,
    observe(_id, _event, _error, phase) { phase('ready'); return () => {}; },
    async openTranscript(_id, accept) {
      accept({ messages: [], ready: true, hasOlder: false });
      return { observationChanged() {}, loadEarlier: async () => {}, close: async () => {} };
    },
  } satisfies Pick<WorkHubServices, 'readTask' | 'queryTaskInteractions' | 'answerTaskInteraction' | 'taskHistory' |
    'taskExecutions' | 'subscribeSessions' | 'subscribeAvailability' | 'subscribeActiveInteractions' | 'getTaskSession' | 'observe' | 'openTranscript'>;
  const ports = services as unknown as WorkHubServices;
  let inbox!: ReturnType<typeof useWorkHubTaskInbox>;
  function Probe() {
    inbox = useWorkHubTaskInbox(ports, owner);
    const view = useWorkHubTaskView(ports, owner, 'work');
    return createElement(WorkHubTaskView, { services: ports, owner, workId: 'work', name: 'Task', view, inbox });
  }
  const { root, container } = installReactRenderer();
  await act(async () => { root.render(createElement(LocaleProvider, { locale: 'en', children:
    createElement(WorkHubServicesProvider, { services: ports, children: createElement(Probe) }) })); });
  assert.equal(inbox.error, undefined, 'Host-proven child ancestry is not rejected by a same-Session rule');
  assert.equal(inbox.ready, true);
  assert.deepEqual(reads, [[owner, { actionId: task.actionId, delegationId: task.delegationId }]], 'one exact assignment lookup per refresh, including root and child requests');
  assert.notEqual(childRequest.interaction.sessionId, task.targetSessionId);
  assert.deepEqual(inbox.requestsForWork('work'), [rootRequest, childRequest]);
  assert.equal(inbox.requests[0], rootRequest);
  assert.equal(inbox.requests[1], childRequest);
  assert.match(container.textContent, /Parent tool/);
  assert.match(container.textContent, /Child tool/);
  assert.equal(container.textContent.match(/Allow once/g)?.length, 2);
  await act(async () => { await inbox.respond(childRequest, { kind: 'permission', decision: 'allow', rememberForTurn: false }); });
  assert.deepEqual(inbox.requestsForWork('work'), [rootRequest]);
  assert.match(container.textContent, /Parent tool/);
  assert.doesNotMatch(container.textContent, /Child tool/);
  await act(async () => { await inbox.respond(rootRequest, { kind: 'permission', decision: 'deny', rememberForTurn: false }); });
  assert.deepEqual(answers, [
    [owner, { actionId: task.actionId, interactionId: 'child-request', expectedTurnId: 'child-turn', expectedRunId: 'child-run',
      answer: { kind: 'permission', decision: 'allow', rememberForTurn: false } }],
    [owner, { actionId: task.actionId, interactionId: rootRequest.interaction.interactionId, expectedTurnId: 'turn', expectedRunId: 'run',
      answer: { kind: 'permission', decision: 'deny', rememberForTurn: false } }],
  ]);
  assert.equal(reads.length, 2, 'answer reconciliation reads the remaining source once; an empty inbox reads no task');
  assert.deepEqual(inbox.requests, []);
});

for (const failure of ['read', 'action', 'delegation'] as const)
  test(`inbox ownership fails closed after ${failure} failure and refresh deduplicates the original source`, async () => {
    const { owner, task, request } = inboxFixture('host');
    const another = { ...request, interaction: { ...request.interaction, interactionId: 'second-request' } };
    let healthy = false, reads = 0, answers = 0;
    const services = {
      queryTaskInteractions: async () => ({ requests: [request, another], truncated: false }),
      readTask: async () => {
        ++reads;
        if (!healthy && failure === 'read') throw new Error('Original task lookup failed');
        const bad = !healthy ? {
          ...(failure === 'action' ? { actionId: 'foreign-action' } : {}),
          ...(failure === 'delegation' ? { delegationId: 'foreign-delegation' } : {}),
        } : {};
        return { task: { ...task, ...bad } };
      },
      answerTaskInteraction: async () => { ++answers; throw new Error('No answer is expected'); },
      subscribeSessions: () => () => {}, subscribeAvailability: () => () => {}, subscribeActiveInteractions: () => () => {},
    } as unknown as WorkHubServices;
    let inbox!: ReturnType<typeof useWorkHubTaskInbox>;
    function Probe() { inbox = useWorkHubTaskInbox(services, owner); return null; }
    const { root } = installReactRenderer();
    await act(async () => { root.render(createElement(Probe)); });
    assert.equal(inbox.ready, false);
    assert.ok(inbox.error);
    assert.deepEqual(inbox.requestsForWork('work'), []);
    assert.equal(reads, 1, 'two requests for one exact source share one canonical lookup');
    await act(async () => {
      await assert.rejects(inbox.respond(request, { kind: 'permission', decision: 'deny', rememberForTurn: false }), /unavailable/);
    });
    assert.equal(answers, 0);
    healthy = true;
    await act(async () => { await inbox.refresh(); });
    assert.equal(reads, 2, 'an explicit refresh rechecks ownership without scanning history');
    assert.equal(inbox.ready, true);
    assert.equal(inbox.error, undefined);
    assert.deepEqual(inbox.requestsForWork('work'), [request, another]);
    assert.equal(inbox.requestsForWork('work')[0], request);
    const prior = inbox;
    healthy = false;
    await act(async () => { await inbox.refresh(); });
    assert.equal(inbox.ready, false);
    assert.ok(inbox.error);
    await act(async () => {
      await assert.rejects(prior.respond(request, { kind: 'permission', decision: 'allow', rememberForTurn: false }), /unavailable/);
    });
    assert.equal(answers, 0, 'a formerly ready responder cannot reuse ownership after a failed refresh');
  });

test('an availability change clears inbox ownership before a replacement proof arrives', async () => {
  const { owner, task, request } = inboxFixture('host');
  const pending = deferred<{ task: WorkHubTask }>();
  let invalidate!: () => void;
  let reads = 0, answers = 0;
  const services = {
    queryTaskInteractions: async () => ({ requests: [request], truncated: false }),
    readTask: async () => ++reads === 1 ? { task } : pending.promise,
    answerTaskInteraction: async () => { ++answers; throw new Error('No answer is expected'); },
    subscribeSessions: () => () => {}, subscribeActiveInteractions: () => () => {},
    subscribeAvailability: (handler: () => void) => { invalidate = handler; return () => {}; },
  } as unknown as WorkHubServices;
  let inbox!: ReturnType<typeof useWorkHubTaskInbox>;
  function Probe() { inbox = useWorkHubTaskInbox(services, owner); return null; }
  const { root } = installReactRenderer();
  await act(async () => { root.render(createElement(Probe)); });
  assert.deepEqual(inbox.requestsForWork('work'), [request]);
  const prior = inbox;
  await act(async () => { invalidate(); });
  assert.equal(inbox.ready, false);
  assert.deepEqual(inbox.requestsForWork('work'), []);
  await act(async () => {
    await assert.rejects(prior.respond(request, { kind: 'permission', decision: 'allow', rememberForTurn: false }), /unavailable/);
    pending.resolve({ task });
  });
  assert.equal(inbox.ready, true);
  assert.deepEqual(inbox.requestsForWork('work'), [request]);
  assert.equal(answers, 0);
});

for (const lateFailure of [false, true]) test(`a former Host's late ownership ${lateFailure ? 'failure' : 'proof'} cannot replace the new inbox`, async () => {
  const first = inboxFixture('first'), second = inboxFixture('second');
  const late = deferred<{ task: WorkHubTask }>();
  let firstReads = 0, answers = 0;
  const services = {
    queryTaskInteractions: async (owner: string) => ({ requests: [owner === first.owner ? first.request : second.request], truncated: false }),
    readTask: async (owner: string) => owner === first.owner
      ? ++firstReads === 1 ? { task: first.task } : late.promise
      : { task: second.task },
    answerTaskInteraction: async () => { ++answers; throw new Error('No answer is expected'); },
    subscribeSessions: () => () => {}, subscribeAvailability: () => () => {}, subscribeActiveInteractions: () => () => {},
  } as unknown as WorkHubServices;
  let inbox!: ReturnType<typeof useWorkHubTaskInbox>;
  function Probe({ owner }: { owner: string }) { inbox = useWorkHubTaskInbox(services, owner); return null; }
  const { root } = installReactRenderer();
  await act(async () => { root.render(createElement(Probe, { owner: first.owner })); });
  assert.deepEqual(inbox.requestsForWork('work'), [first.request]);
  const old = inbox;
  let refreshing!: Promise<void>;
  await act(async () => { refreshing = inbox.refresh(); });
  assert.equal(firstReads, 2);
  await act(async () => { root.render(createElement(Probe, { owner: second.owner })); });
  assert.equal(inbox.ready, true);
  assert.deepEqual(inbox.requestsForWork('work'), [second.request], 'identical action/interaction IDs do not share proof across Hosts');
  await act(async () => {
    if (lateFailure) late.reject(new Error('Former Host failed'));
    else late.resolve({ task: first.task });
    await refreshing;
    await assert.rejects(old.respond(first.request, { kind: 'permission', decision: 'allow', rememberForTurn: false }), /unavailable/);
  });
  assert.equal(inbox.ready, true);
  assert.equal(inbox.error, undefined);
  assert.deepEqual(inbox.requestsForWork('work'), [second.request]);
  assert.equal(answers, 0);
});

function inboxFixture(hostId: string) {
  const owner = desktopSessionKey({ hostId, sessionId: 'maka_workhub_coordination' });
  const target = desktopSessionKey({ hostId, sessionId: 'worker' });
  const task: WorkHubTask = { workId: 'work', actionId: 'source', delegationId: 'link',
    targetSessionId: target, targetSessionName: 'Task', targetMessageId: 'message', text: 'Original task', createdAt: 1, status: 'waiting_for_user' };
  const request: WorkHubPendingInteraction = { actionId: task.actionId, delegationId: task.delegationId, targetSessionName: 'Task',
    interaction: { schemaVersion: 1, interactionId: 'request', sessionId: target, turnId: 'turn', runId: 'run',
      revision: 1, status: 'pending', outcome: null, request: { kind: 'permission', toolUseId: 'tool',
        prompt: { kind: 'tool_permission', toolName: 'Bash', category: 'shell_unsafe', reason: 'shell_dangerous',
          review: { kind: 'command', command: 'npm test' }, rememberForTurnAllowed: false } } } };
  return { owner, task, request };
}
