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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createSessionStore } from '../session-store.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';
import {
  SqliteWorkHubTaskIndex,
  WORKHUB_TASK_INDEX_SCHEMA_SQL,
  WorkHubTaskIndexCursorError,
  type WorkHubTaskIndexDocument,
} from '../sqlite-workhub-task-index.js';

function document(
  id: string,
  patch: Partial<WorkHubTaskIndexDocument> = {},
): WorkHubTaskIndexDocument {
  return {
    kind: 'task',
    id,
    title: `Task ${id}`,
    summary: 'An excerpt',
    state: 'ended',
    activityAt: 1,
    cwd: '/workspace/a',
    available: true,
    currentSessionId: `session-${id}`,
    sourceActionId: `action-${id}`,
    originActionId: `origin-${id}`,
    sessionIds: [`session-${id}`],
    requests: 'Original requirements',
    brief: '',
    sessionNames: 'Session',
    ...patch,
  };
}

function memory() {
  const db = new DatabaseSync(':memory:');
  db.exec(WORKHUB_TASK_INDEX_SCHEMA_SQL);
  return { db, index: new SqliteWorkHubTaskIndex(db) };
}

test('task index pages all ages, ranks active work first and returns bounded excerpts only', () => {
  const { db, index } = memory();
  try {
    assert.equal(index.watermark(), -1, 'the first canonical fact can have sequence zero');
    for (let n = 0; n < 35; n++)
      index.upsert(document(`task-${String(n).padStart(2, '0')}`, { activityAt: n }));
    index.upsert(
      document('old-active', {
        activityAt: 0,
        state: 'running',
        summary: '😀'.repeat(240),
        requests: 'private full source',
      }),
    );
    const first = index.query({});
    assert.equal(first.items.length, 10);
    assert.equal(first.items[0]!.id, 'old-active');
    assert.equal(Array.from(first.items[0]!.summary).length, 200);
    assert.equal('requests' in first.items[0]!, false);
    assert.equal('sessionIds' in first.items[0]!, false);
    const ids = first.items.map((hit) => hit.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = index.query({ cursor });
      assert.ok(next.items.length <= 10);
      ids.push(...next.items.map((hit) => hit.id));
      cursor = next.nextCursor;
    }
    assert.equal(ids.length, 36);
    assert.equal(new Set(ids).size, 36);
    assert.ok(ids.includes('task-00'), 'no time or 32-candidate cutoff');
  } finally {
    db.close();
  }
});

test('search uses NFC/lowercase, trigram long terms and LIKE Chinese short terms with field weighting', () => {
  const { db, index } = memory();
  try {
    index.upsert(
      document('request-match', { title: 'Other', requests: 'CAFÉ 登录', activityAt: 90 }),
    );
    index.upsert(document('title-match', { title: 'Café 登录', requests: 'none', activityAt: 1 }));
    index.upsert(
      document('brief-match', {
        title: 'Other',
        requests: 'none',
        brief: 'café 登录',
        activityAt: 200,
      }),
    );
    const result = index.query({ query: 'CAFE\u0301 登录' });
    assert.equal(result.match, 'all');
    assert.deepEqual(
      result.items.map((hit) => hit.id),
      ['title-match', 'request-match', 'brief-match'],
    );
    assert.equal(
      result.items[0]!.title,
      'Café 登录',
      'display text is not normalized or lowercased',
    );
  } finally {
    db.close();
  }
});

test('directory filtering precedes AND/OR relaxation and unmatched recent fallback', () => {
  const { db, index } = memory();
  try {
    index.upsert(document('a-login', { title: '登录', cwd: '/workspace/a' }));
    index.upsert(document('a-limit', { title: '限流', cwd: '/workspace/a' }));
    index.upsert(document('outside-exact', { title: '登录 限流', cwd: '/workspace/b' }));
    const relaxed = index.query({ query: '登录 限流', cwd: '/workspace/a' });
    assert.equal(relaxed.match, 'any');
    assert.deepEqual(relaxed.items.map((hit) => hit.id).sort(), ['a-limit', 'a-login']);
    const missing = index.query({ query: '没有匹配', cwd: '/workspace/a' });
    assert.equal(missing.match, 'unmatched');
    assert.equal(missing.items.length, 2);
    assert.ok(missing.items.every((hit) => hit.cwd === '/workspace/a'));
    assert.equal(index.query({ query: '登录 限流', cwd: '/workspace/b' }).match, 'all');
  } finally {
    db.close();
  }
});

test('full requirements and corrections remain searchable beyond the display excerpt', () => {
  const { db, index } = memory();
  try {
    index.upsert(
      document('long', {
        summary: 'No matching word here',
        requests: `${'x'.repeat(100_000)}\n用户纠正 needle-correction-xyz`,
      }),
    );
    const result = index.query({ query: 'needle-correction-xyz' });
    assert.equal(result.match, 'all');
    assert.equal(result.items[0]!.id, 'long');
    assert.ok(!JSON.stringify(result).includes('x'.repeat(100)));
  } finally {
    db.close();
  }
});

test('FTS quotes, LIKE wildcards, backslashes and SQL-looking terms are literal data', () => {
  const { db, index } = memory();
  try {
    index.upsert(document('special', { title: '% _ \\ file"name.ts café' }));
    index.upsert(document('ordinary', { title: 'Ordinary task' }));
    for (const query of ['%', '_', '\\', 'file"name.ts']) {
      const page = index.query({ query });
      assert.equal(page.match, 'all', query);
      assert.deepEqual(
        page.items.map((hit) => hit.id),
        ['special'],
        query,
      );
    }
    assert.equal(index.query({ query: '"\';DROP_TABLE_WTF;--' }).match, 'unmatched');
    assert.equal(index.query({}).items.length, 2, 'query text cannot execute SQL');
  } finally {
    db.close();
  }
});

test('upsert and delete keep trigram data current; dirty membership includes old segments', () => {
  const { db, index } = memory();
  try {
    index.upsert(
      document('same', {
        title: 'Previous description',
        sessionIds: ['old-session', 'new-session'],
        currentSessionId: 'new-session',
      }),
    );
    index.upsert(
      document('same', {
        title: 'Replacement description',
        sessionIds: ['old-session', 'new-session'],
        currentSessionId: 'new-session',
      }),
    );
    assert.equal(index.query({ query: 'Previous' }).match, 'unmatched');
    assert.equal(index.query({ query: 'Replacement' }).items.length, 1);
    index.markDirty('old-session');
    assert.deepEqual(index.dirty(), [{ kind: 'task', id: 'same', dirtyRevision: 1 }]);
    const dirty = index.read('task', 'same')!;
    assert.deepEqual(dirty.sessionIds, ['old-session', 'new-session']);
    assert.equal(index.containsSession('old-session'), true);
    index.markDirty('new-session');
    assert.equal(
      index.upsert(dirty, dirty.dirtyRevision),
      false,
      'a newer event cannot lose its dirty marker',
    );
    assert.equal(index.read('task', 'same')?.dirtyRevision, 2);
    assert.equal(index.upsert(dirty, 2), true);
    index.upsert(document('same'));
    assert.deepEqual(index.dirty(), []);
    index.advance(42);
    assert.equal(index.watermark(), 42);
    assert.throws(() => index.advance(41));
    index.remove('task', 'same');
    assert.equal(index.query({ query: 'Replacement' }).items.length, 0);
  } finally {
    db.close();
  }
});

test('cursors survive a SQLite reopen and a projection rebuild, bind query/directory/mode and reject tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-task-index-'));
  const path = join(root, 'index.sqlite');
  let db = new DatabaseSync(path);
  try {
    db.exec(WORKHUB_TASK_INDEX_SCHEMA_SQL);
    let index = new SqliteWorkHubTaskIndex(db);
    const docs = Array.from({ length: 25 }, (_, n) =>
      document(`task-${String(n).padStart(2, '0')}`, {
        title: 'Compiler diagnostics',
        activityAt: n,
      }),
    );
    for (const doc of docs) index.upsert(doc);
    const first = index.query({ query: 'compiler', cwd: '/workspace/a' });
    assert.ok(first.nextCursor);
    db.exec(WORKHUB_TASK_INDEX_SCHEMA_SQL);
    assert.deepEqual(
      index.query({ query: 'compiler', cwd: '/workspace/a' }),
      first,
      'a converged migration retains both searchable data and its cursor signing key',
    );
    db.close();
    db = new DatabaseSync(path);
    index = new SqliteWorkHubTaskIndex(db);
    const second = index.query({
      query: 'compiler',
      cwd: '/workspace/a',
      cursor: first.nextCursor,
    });
    assert.equal(second.items.length, 10);
    assert.equal(new Set([...first.items, ...second.items].map((hit) => hit.id)).size, 20);
    index.rebuild();
    assert.equal(index.watermark(), -1);
    for (const doc of [...docs].reverse()) index.upsert(doc);
    const rebuilt = index.query({
      query: 'compiler',
      cwd: '/workspace/a',
      cursor: first.nextCursor,
    });
    assert.deepEqual(rebuilt, second, 'cursor uses stable task order, not SQLite rowids');
    assert.throws(
      () => index.query({ query: 'other', cwd: '/workspace/a', cursor: first.nextCursor! }),
      WorkHubTaskIndexCursorError,
    );
    assert.throws(
      () => index.query({ query: 'compiler', cwd: '/workspace/b', cursor: first.nextCursor! }),
      WorkHubTaskIndexCursorError,
    );
    const [payload, signature] = first.nextCursor.split('.');
    const forged = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    forged.match = 'unmatched';
    const token = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    assert.throws(
      () => index.query({ query: 'compiler', cwd: '/workspace/a', cursor: token }),
      WorkHubTaskIndexCursorError,
    );
    assert.throws(() => index.query({ cursor: 'not-a-cursor' }), WorkHubTaskIndexCursorError);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('the production store migrates, scans sequence-zero facts and keeps projection writes separate from task authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-index-store-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const session = await store.create({
      cwd: root,
      name: 'Container',
      model: 'model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    const request = assignmentRequest('index-original', session.id, session.name, 'worker-turn');
    request.assignment.taskTitle = 'Stable objective';
    await store.assignWorkHubMessage(request);
    await store.appendMessage(WORKHUB_COORDINATION_SESSION_ID, {
      type: 'assistant',
      id: 'unrelated-large-output',
      turnId: 'other',
      ts: 20,
      text: 'x'.repeat(300_000),
      modelId: 'model',
    });
    const hash = createHash('sha256').update('native-index-input').digest('hex').slice(0, 48);
    const content = normalizeMessageContent({ text: 'Prepared correction' });
    const fact = {
      type: 'workhub_coordination' as const,
      kind: 'task_input' as const,
      schemaVersion: 1 as const,
      id: `whti_${hash}`,
      turnId: request.assignment.coordinationTurnId,
      ts: 30,
      inputId: 'native-index-input',
      workId: request.assignment.actionId,
      generationId: request.assignment.actionId,
      sourceActionId: request.assignment.actionId,
      sourceDelegationId: request.assignment.delegationId,
      text: content.text,
      originalUserText: '原始用户纠正',
      inputOrigin: 'user' as const,
      sourceMessageId: 'source-user',
      targetSessionId: session.id,
      targetMessageId: `whtm_${hash}`,
      targetContentDigest: messageContentDigest(content),
      mode: 'steering' as const,
      execution: { turnId: request.admission.turnId, runId: request.admission.runId },
    };
    await store.commitWorkHubTaskInput({
      input: fact,
      admission: {
        ...request.admission,
        messageId: fact.targetMessageId,
        content,
        submittedContentDigest: messageContentDigest(content),
        admittedAt: 30,
      },
    });
    const first = await store.readWorkHubTaskFactsPage({
      afterSequence: -1,
      maxMessages: 1,
      maxStoredBytes: 1,
    });
    assert.equal(first.records[0]?.sequence, 0);
    assert.deepEqual(first.records[0]?.message, request.assignment);
    const next = await store.readWorkHubTaskFactsPage({
      afterSequence: 0,
      maxMessages: 64,
      maxStoredBytes: 1024,
    });
    assert.equal(next.records.length, 1, 'large non-task output does not consume the page');
    assert.deepEqual(next.records[0]?.message, fact);
    assert.equal(
      (await store.readWorkHubAssignmentByMessage(request.assignment.targetMessageId))?.actionId,
      'index-original',
    );
    assert.equal(await store.readWorkHubAssignmentByMessage('whm_invalid'), undefined);
    const index = store.workHubTaskIndex!;
    assert.equal(await index.watermark(), -1);
    const doc = document('index-original', {
      currentSessionId: session.id,
      sessionIds: [session.id],
      sourceActionId: request.assignment.actionId,
      originActionId: request.assignment.actionId,
    });
    await index.put(doc, 0);
    await assert.rejects(index.put({ ...doc, title: 'must roll back' }, -1), /watermark/);
    assert.equal((await index.read('task', doc.id))?.title, doc.title);
    await index.put({ ...doc, kind: 'session', id: session.id });
    assert.equal(
      (await index.query({})).items.length,
      1,
      'a manual item cannot duplicate a task segment',
    );
    await index.put({ ...doc, currentSessionId: 'forged-index-target', available: true });
    assert.equal(
      (await store.readWorkHubAssignment('index-original'))?.targetSessionId,
      session.id,
      'an advisory row cannot rewrite ownership',
    );
    assert.equal((await store.readHeaderSnapshot(session.id)).permissionMode, 'ask');
    await index.rebuild();
    assert.equal(await index.watermark(), -1);
    assert.equal((await index.query({})).items.length, 0);
    assert.deepEqual(await store.readWorkHubAssignment('index-original'), request.assignment);
    assert.ok(store.close);
    await store.close();
    const legacy = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      legacy.exec(`
        DROP TABLE workhub_task_search;
        DROP TABLE workhub_task_index;
        DROP TABLE workhub_task_index_state;
        UPDATE session_metadata_schema SET version = 42 WHERE scope = 'session_metadata';
      `);
    } finally {
      legacy.close();
    }
    store = createSessionStore(root);
    assert.deepEqual(await store.readWorkHubTaskInput(fact.inputId), fact);
    assert.deepEqual(await store.readWorkHubAssignment('index-original'), request.assignment);
    assert.equal(await store.workHubTaskIndex!.watermark(), -1);
    assert.equal((await store.readHeaderSnapshot(session.id)).permissionMode, 'ask');
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
