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
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextLoop } from 'node:timers/promises';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import { createSessionStore, type SessionAuthorityStore } from '@maka/storage/session-store';
import { createWorkHubTaskIndexProjection } from '../server/workhub-task-index-projection.js';
import { createWorkHubTaskDiscoveryRuntime } from '../server/workhub-task-discovery-runtime.js';
import { createWorkHubResultRuntime } from '../server/workhub-result-runtime.js';
import { createWorkHubEvidenceRuntime } from '../server/workhub-evidence-runtime.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import type { WorkHubTaskDetail, WorkHubTaskStatus } from '../protocol/workhub-tasks.js';
import { HOST_OPERATION_SPECS } from '../protocol/index.js';

function assigned(actionId: string, sessionId: string, text = 'Original request') {
  const suffix = createHash('sha256').update(actionId).digest('hex').slice(0, 48);
  const content = normalizeMessageContent({ text: 'Prepared task instruction' });
  const assignment: WorkHubDelegationAssignedMessage = {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 1,
    id: `wha_${suffix}`,
    turnId: actionId,
    coordinationTurnId: actionId,
    actionId,
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    ts: 10,
    targetSessionId: sessionId,
    targetSessionName: 'Container',
    targetTurnId: `turn-${actionId}`,
    targetMessageId: `whm_${suffix}`,
    delegationId: `whd_${suffix}`,
    disposition: 'delegate_existing',
    userText: text,
    delegationText: content.text,
  };
  return {
    assignment,
    admission: {
      sessionId,
      turnId: `turn-${actionId}`,
      runId: `run-${actionId}`,
      messageId: `whm_${suffix}`,
      content,
      submittedContentDigest: messageContentDigest(content),
      submittedPlacement: 'current_turn' as const,
      placement: 'current_turn' as const,
      disposition: 'steering' as const,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
      admittedAt: 10,
    },
  };
}

async function coordination(store: SessionAuthorityStore, root: string) {
  await store.createStableSession({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    requestFingerprint: `sha256:${'b'.repeat(64)}`,
    input: {
      cwd: root,
      name: 'WorkHub',
      role: WORKHUB_COORDINATION_SESSION_ROLE,
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
      toolProfile: 'workhub-coordination-v2',
    },
  });
}

function projection(store: SessionAuthorityStore, states: Map<string, WorkHubTaskStatus>) {
  return createWorkHubTaskIndexProjection({
    stores: store,
    index: store.workHubTaskIndex!,
    project: async (source) =>
      ({
        task: {
          workId: source.work?.id ?? source.actionId,
          actionId: source.actionId,
          delegationId: source.delegationId,
          targetSessionId: source.targetSessionId,
          targetSessionName: source.targetSessionName,
          targetMessageId: source.targetMessageId,
          text: 'Display excerpt',
          createdAt: source.ts,
          status: states.get(source.work?.id ?? source.actionId) ?? 'pending_acceptance',
        },
      }) satisfies WorkHubTaskDetail,
    activity: async () => undefined,
    onError: (error) => {
      throw error;
    },
  });
}

test('task discovery rebuilds all ages, full requests, corrections and stable titles without duplicating manual Sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-index-projection-'));
  let store = createSessionStore(root);
  const states = new Map<string, WorkHubTaskStatus>();
  let runtime = projection(store, states);
  try {
    await coordination(store, root);
    const sources: ReturnType<typeof assigned>[] = [];
    for (let n = 0; n < 35; n++) {
      const h = await store.create({
        cwd: root,
        name: `Container ${n}`,
        model: 'model',
        llmConnectionSlug: 'test',
        permissionMode: 'ask',
      });
      const request = assigned(
        `work-${n}`,
        h.id,
        n === 0 ? `${'x'.repeat(100_000)}\n原始要求 needle-original-xyz` : `Original ${n}`,
      );
      request.assignment.ts = n + 10;
      request.assignment.targetSessionName = h.name;
      request.assignment.taskTitle = `编译诊断 ${n}`;
      await store.assignWorkHubMessage(request);
      sources.push(request);
    }
    const manual = await store.create({
      cwd: root,
      name: 'Manual unclaimed work',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    const first = await runtime.query({});
    assert.equal(first.items.length, 10);
    const all = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await runtime.query({ cursor });
      all.push(...page.items);
      cursor = page.nextCursor;
    }
    assert.equal(all.length, 36);
    assert.equal(new Set(all.map((x) => `${x.kind}:${x.id}`)).size, 36);
    assert.equal(all.filter((x) => x.kind === 'session').length, 1);
    assert.equal(all.find((x) => x.kind === 'session')?.id, manual.id);
    assert.ok(
      all.some((x) => x.id === 'work-0'),
      'no age or recent-32 cutoff',
    );
    assert.ok(
      all.filter((x) => x.kind === 'task').every((x) => x.state === 'ended'),
      'state comes from execution projection, not assignment admission',
    );
    assert.equal((await runtime.query({ query: 'needle-original-xyz' })).items[0]?.id, 'work-0');
    const original = sources[0]!.assignment;
    await store.rename(original.targetSessionId, 'Renamed container');
    await runtime.notify(original.targetSessionId);
    const renamed = await runtime.query({ query: 'renamed' });
    assert.equal(
      renamed.items[0]?.title,
      '编译诊断 0',
      'task title does not follow the Session rename',
    );
    const correction = assigned(
      'correction',
      original.targetSessionId,
      '版本纠正 needle-correction-xyz',
    );
    correction.assignment.targetSessionName = 'Renamed container';
    correction.assignment.schemaVersion = 4;
    correction.assignment.work = {
      id: 'work-0',
      generationId: 'work-0',
      continuesActionId: 'work-0',
    };
    correction.assignment.ts = 90;
    await store.assignWorkHubMessage(correction);
    const corrected = await runtime.query({ query: '版本纠正' });
    assert.equal(corrected.items.length, 1);
    assert.equal(corrected.items[0]?.id, 'work-0');
    assert.equal(corrected.items[0]?.title, '编译诊断 0');
    states.set('work-0', 'running');
    await runtime.notify(original.targetSessionId);
    assert.equal(
      (await runtime.query({})).items[0]?.id,
      'work-0',
      'older running task sorts before newer ended tasks',
    );
    const stable = await runtime.query({ query: '编译' });
    assert.ok(stable.nextCursor);
    const expected = await runtime.query({ query: '编译', cursor: stable.nextCursor });
    await runtime.rebuild();
    assert.deepEqual(await runtime.query({ query: '编译', cursor: stable.nextCursor }), expected);
    await runtime.close();
    await store.close?.();
    store = createSessionStore(root);
    runtime = projection(store, states);
    assert.deepEqual(
      await runtime.query({ query: '编译', cursor: stable.nextCursor }),
      expected,
      'pagination resumes after reopening the production store',
    );
    assert.equal((await store.readHeaderSnapshot(original.targetSessionId)).permissionMode, 'ask');
    assert.deepEqual(await store.readWorkHubAssignment(original.actionId), original);
  } finally {
    await runtime.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('find protocol bounds pages, keeps manual availability distinct and makes unsupported discovery explicit', async () => {
  const spec = HOST_OPERATION_SPECS['workhub.tasks.find'];
  assert.deepEqual(spec.decodeInput({ query: '  登录   限流  ', cwd: '/repo' }), {
    query: '登录   限流',
    cwd: '/repo',
  });
  const item = {
    kind: 'task',
    id: 'work',
    title: 'Login',
    state: 'ended',
    lastActivityAt: 1,
    location: 'repo',
    available: true,
    summary: '',
    segments: 1,
  };
  const page = { items: [item], match: 'all', nextCursor: null };
  assert.deepEqual(spec.decodeOutput(page), page);
  assert.deepEqual(
    spec.decodeOutput({
      ...page,
      items: [{ ...item, kind: 'session', state: 'available', location: null }],
    }),
    { ...page, items: [{ ...item, kind: 'session', state: 'available', location: null }] },
  );
  for (const bad of [
    { ...page, items: Array.from({ length: 11 }, (_, n) => ({ ...item, id: `work-${n}` })) },
    { ...page, items: [item, item] },
    { ...page, items: [{ ...item, summary: '😀'.repeat(201) }] },
    { ...page, items: [{ ...item, kind: 'session' }] },
    { ...page, items: [{ ...item, kind: 'session', state: 'available', segments: 2 }] },
    { ...page, items: [{ ...item, state: 'available' }] },
    { ...page, items: [{ ...item, permissions: 'bypass' }] },
    { ...page, nextCursor: 0 },
  ])
    assert.throws(() => spec.decodeOutput(bad));
  const runtime = createWorkHubTaskDiscoveryRuntime({
    readContext: async () => {
      throw new Error('must not read');
    },
    onError: (error) => {
      throw error;
    },
  });
  const unavailable = await runtime.handlers['workhub.tasks.find']({});
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.error.code, 'operation_unavailable');
});

test('unused task discovery does not maintain an index for ordinary Session events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-index-lazy-'));
  const store = createSessionStore(root);
  const runtime = projection(store, new Map());
  try {
    const manual = await store.create({
      cwd: root,
      name: 'Manual',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    await runtime.notify(manual.id);
    assert.deepEqual(
      (await store.workHubTaskIndex!.query({})).items,
      [],
      'no observer is active before the first lookup',
    );
    assert.equal(
      (await runtime.query({})).items[0]?.id,
      manual.id,
      'first lookup backfills the latest catalog',
    );
  } finally {
    await runtime.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('child and nested-child notifications refresh the parent task when entering and leaving user waiting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-index-child-'));
  const store = createSessionStore(root);
  const states = new Map<string, WorkHubTaskStatus>([['parent-work', 'running']]);
  const runtime = projection(store, states);
  try {
    await coordination(store, root);
    const parent = await store.create({
      cwd: root,
      name: 'Parent work',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    const request = assigned('parent-work', parent.id);
    request.assignment.targetSessionName = parent.name;
    await store.assignWorkHubMessage(request);
    const child = await store.create({
      cwd: root,
      name: 'Child work',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: parent.id,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'spawn-child',
        },
        lifecycle: 'foreground',
      },
    });
    const nested = await store.create({
      cwd: root,
      name: 'Nested child',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
      subagentParent: {
        kind: 'subagent',
        parentSessionId: child.id,
        spawnedBy: {
          parentRunId: 'child-run',
          parentTurnId: 'child-turn',
          toolCallId: 'spawn-nested',
        },
        lifecycle: 'foreground',
      },
    });
    const status = async () => {
      const page = await runtime.query({});
      assert.deepEqual(
        page.items.map((item) => item.id),
        ['parent-work'],
      );
      return page.items[0]!.state;
    };
    assert.equal(await status(), 'running');
    for (const session of [child, nested]) {
      states.set('parent-work', 'waiting_for_user');
      await runtime.notify(session.id);
      assert.equal(await status(), 'waiting_for_user');
      states.set('parent-work', 'running');
      await runtime.notify(session.id);
      assert.equal(await status(), 'running');
    }
    states.set('parent-work', 'waiting_for_user');
    await runtime.notify(nested.id);
    assert.equal(await status(), 'waiting_for_user');
    await store.remove(nested.id);
    states.set('parent-work', 'running');
    await runtime.notify(nested.id);
    assert.equal(await status(), 'running', 'deletion cannot leave a stale parent wait');
  } finally {
    await runtime.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('index refresh uses the production result and evidence projections without rescanning target assignment ledgers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-index-ledger-scan-'));
  const store = createSessionStore(root);
  type ResultOptions = Parameters<typeof createWorkHubResultRuntime>[0];
  let targetScans = 0;
  let deliveryReads = 0;
  const observedStore = new Proxy(store, {
    get(target, property) {
      if (property === 'readActiveWorkHubAssignmentsByTarget')
        return (
          ...args: Parameters<SessionAuthorityStore['readActiveWorkHubAssignmentsByTarget']>
        ) => {
          targetScans++;
          return target.readActiveWorkHubAssignmentsByTarget(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const stores = { sessionStore: observedStore } as ResultOptions['stores'];
  const executions = {
    readRootState: () => ({ kind: 'idle' }),
    readLatestRootTurnLineage: async (ref: unknown) => ref,
    readWorkHubDispatchWait: () => undefined,
    read: async () => ({ status: 'completed', terminalEventId: 'terminal' }),
  } as unknown as ResultOptions['executions'];
  const messages = {
    readMessageExecutionDispositionAdmitted: async () => ({
      kind: 'owned_root',
      turnId: 'task-turn',
      runId: 'task-run',
    }),
  } as unknown as ResultOptions['messages'];
  const admission = new SessionAdmissionGate();
  const onError = (error: unknown) => {
    throw error;
  };
  const evidence = createWorkHubEvidenceRuntime({
    stores,
    executions,
    messages,
    admission,
    reader: {} as never,
    hasLiveResources: async () => false,
    hasBlockingGoal: () => false,
    onError,
  });
  const results = createWorkHubResultRuntime({
    stores,
    executions,
    messages,
    evidence,
    admission,
    interactions: {} as never,
    readTurnResult: async () => {
      deliveryReads++;
      return '';
    },
    readTurnInput: async () => {
      throw new Error('discovery must not read transcript inputs');
    },
    acquireResidency: () => ({ release() {} }),
    onError,
  });
  const runtime = createWorkHubTaskIndexProjection({
    stores: observedStore,
    index: store.workHubTaskIndex!,
    project: (source) => results.projectTask(source),
    activity: async () => undefined,
    onError,
  });
  try {
    await coordination(store, root);
    for (let n = 0; n < 35; n++) {
      const h = await store.create({
        cwd: root,
        name: `Work ${n}`,
        model: 'model',
        llmConnectionSlug: 'test',
        permissionMode: 'ask',
      });
      const request = assigned(`work-${n}`, h.id);
      request.assignment.targetSessionName = h.name;
      request.assignment.returnResults = true;
      await store.assignWorkHubMessage(request);
    }
    const all = [];
    let cursor: string | undefined;
    do {
      const page = await runtime.query({ cursor });
      all.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(all.length, 35);
    assert.ok(all.every((item) => item.state === 'ended'));
    assert.equal(deliveryReads, 0, 'discovery does not read deliveries');
    assert.equal(targetScans, 0, 'the full projection chain must not re-scan task ledgers');
    await runtime.rebuild();
    assert.equal(targetScans, 0, 'rebuild reuses the canonical watermark scan too');
    const source = await store.readWorkHubAssignment('work-0');
    assert.ok(source);
    await results.handlers['workhub.tasks.read'](
      { actionId: source.actionId, delegationId: source.delegationId },
      {} as never,
    );
    assert.ok(targetScans > 0, 'the non-index read path still revalidates current authority');
  } finally {
    await runtime.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an older manual refresh cannot reinsert an archived Session after its newer notification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-task-index-manual-race-'));
  const store = createSessionStore(root);
  let release = () => {};
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let pause = false,
    reads = 0;
  const runtime = createWorkHubTaskIndexProjection({
    stores: {
      readWorkHubTaskFactsPage: (request) => store.readWorkHubTaskFactsPage(request),
      readWorkHubAssignment: (id) => store.readWorkHubAssignment(id),
      readHeaderSnapshot: (id) => store.readHeaderSnapshot(id),
      listCatalogPage: (...args) => store.listCatalogPage(...args),
      readCatalogRecord: async (id) => {
        const record = await store.readCatalogRecord(id);
        reads++;
        if (pause) {
          pause = false;
          enter();
          await barrier;
        }
        return record;
      },
    },
    index: store.workHubTaskIndex!,
    project: async () => undefined,
    activity: async () => undefined,
    onError: (error) => {
      throw error;
    },
  });
  try {
    const manual = await store.create({
      cwd: root,
      name: 'Manual',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    await runtime.query({});
    pause = true;
    const older = runtime.notify(manual.id);
    await entered;
    const before = reads;
    const current = await store.readCatalogRecord(manual.id);
    await store.setSessionsArchivedVersioned(
      [{ sessionId: manual.id, expectedVersion: current.revision }],
      true,
    );
    const newer = runtime.notify(manual.id);
    await nextLoop();
    assert.equal(reads, before, 'newer refresh waits on the existing projection lane');
    release();
    await Promise.all([older, newer]);
    assert.deepEqual(
      (await runtime.query({})).items,
      [],
      'archived Session stays absent after the stale read completes',
    );
    assert.equal(await store.workHubTaskIndex!.read('session', manual.id), undefined);
  } finally {
    release();
    await runtime.close();
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
