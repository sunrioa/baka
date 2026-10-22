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
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { analyzeContextSnapshot, collectContextSnapshot } from './workhub-context-baseline.mjs';
import { buildModelProjectionTransition } from '../packages/core/dist/model-projection-transition.js';
import { baseToolResultProjection } from '../packages/runtime/dist/model-projection-transition-ledger.js';

const sessionId = 'maka_workhub_coordination';
function event(id, content, role = 'tool', extra = {}) {
  return {
    id,
    sessionId,
    invocationId: 'inv',
    runId: 'run',
    turnId: 'turn',
    ts: 1,
    partial: false,
    role,
    author: role === 'tool' ? 'tool' : role === 'user' ? 'user' : 'model',
    content,
    ...extra,
  };
}
function snapshot(runtimeEvents, runEvents = []) {
  return {
    schemaVersion: 1,
    sessionId,
    runtimeEvents,
    runEvents,
    usage: [],
    storageByKind: {},
    sampledAt: '2026-10-22T00:00:00.000Z',
    throughOrdinal: runtimeEvents.length,
    session: { model: 'test-model', connection: 'test' },
  };
}
function exchange(name, id, result) {
  return [
    event(`${id}-call`, { kind: 'function_call', id, name, args: { taskId: 'task-a' } }, 'model'),
    event(`${id}-result`, { kind: 'function_response', id, name, result }),
  ];
}

test('separates real user input, notifications, replies, queries and action receipts', async () => {
  const report = await analyzeContextSnapshot(
    snapshot([
      event('user', { kind: 'text', text: 'PRIVATE_USER_TEXT' }, 'user'),
      event(
        'notice',
        {
          kind: 'text',
          text: 'PRIVATE_NOTIFICATION',
          origin: {
            kind: 'workhub_result',
            actionId: 'action-a',
            delegationId: 'delegation-a',
            targetSessionId: 'worker-a',
            targetTurnId: 'worker-turn-a',
          },
        },
        'user',
      ),
      ...exchange('mcp__desktop_workhub__find', 'find', { items: [{ title: 'PRIVATE_TITLE' }] }),
      ...exchange('WorkHubRead', 'read', { text: 'PRIVATE_TOOL_BODY' }),
      ...exchange('mcp__desktop_workhub__continue', 'continue', { admission: 'accepted' }),
      event('reply', { kind: 'text', text: 'PRIVATE_REPLY' }, 'model'),
    ]),
  );
  for (const key of [
    'user_inputs',
    'result_notifications',
    'coordinator_replies',
    'find_results',
    'workhub_read_results',
    'action_receipts',
  ])
    assert.equal(report.categories[key].items, 1, key);
  assert.equal(report.categories.tool_arguments.items, 3);
  assert.equal(report.stablePrompt.systemPromptBytes, null);
  assert.equal(report.lastRequest, null);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_/u);
  assert.equal(
    Object.values(report.categories).reduce((sum, item) => sum + item.utf8Bytes, 0),
    report.totals.utf8Bytes,
  );
});

test('measures the committed replacement rather than resurrecting the raw result', async () => {
  const events = exchange('WorkHubRead', 'read', { text: 'A'.repeat(20000) });
  const transition = buildModelProjectionTransition({
    sessionId,
    target: {
      runtimeEventId: 'read-result',
      part: 'tool_result',
      toolCallId: 'read',
      toolName: 'WorkHubRead',
    },
    sourceProjection: baseToolResultProjection(events[1]),
    replacement: { version: 1, kind: 'json', value: { text: 'bounded' } },
    now: 1,
  });
  const runEvent = {
    id: 'transition',
    sessionId,
    runId: 'run',
    type: 'model_projection_transition_recorded',
    data: { runtimeEventId: 'read-result', part: 'tool_result', transition },
  };
  const report = await analyzeContextSnapshot(snapshot(events, [runEvent]));
  assert.equal(report.projection.appliedTransitions, 1);
  assert.equal(report.projection.rejectedTransitions, 0);
  assert.ok(report.categories.workhub_read_results.utf8Bytes < 100);
});

test('counts UTF-8 bytes separately from token estimates and ignores partial/hidden bodies', async () => {
  const report = await analyzeContextSnapshot(
    snapshot([
      event('user', { kind: 'text', text: '中文' }, 'user'),
      event('hidden', { kind: 'text', text: 'SECRET_HIDDEN' }, 'user', {
        modelVisibility: 'hidden',
      }),
      event('partial', { kind: 'text', text: 'SECRET_PARTIAL' }, 'model', { partial: true }),
    ]),
  );
  assert.equal(report.categories.user_inputs.utf8Bytes, 6);
  assert.equal(report.categories.user_inputs.utf16Units, 2);
  assert.equal(report.categories.user_inputs.estimatedTokensAtFourUnits, 1);
  assert.equal(report.totals.items, 1);
});

test('rejects checkpointed and unreadable sources rather than publishing false active-context totals', async () => {
  await assert.rejects(
    analyzeContextSnapshot(snapshot([], [{ type: 'history_compact_checkpoint_recorded' }])),
    /Checkpoint-aware replay/u,
  );
  await assert.rejects(
    analyzeContextSnapshot(
      snapshot(
        [],
        [{ sessionId, runId: 'run', type: 'model_projection_transition_recorded', data: {} }],
      ),
    ),
    /Unreadable projection ledger/u,
  );
});

test('SQLite collection is ordered, consistent and leaves database state unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE session_metadata(session_id TEXT PRIMARY KEY, payload_json TEXT);
      CREATE TABLE runtime_events(event_id TEXT, event_kind TEXT, payload_json TEXT);
      CREATE TABLE runtime_session_event_ordinals(session_id TEXT, ordinal INTEGER, event_id TEXT);
      CREATE TABLE core_agent_run_events(session_id TEXT,event_type TEXT,record_json TEXT,event_ts INTEGER,sequence INTEGER,event_id TEXT);
      CREATE TABLE usage_model_call_attempts(session_id TEXT,attempt_id TEXT,completed_at INTEGER,call_kind TEXT,status TEXT,
        usage_basis TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,
        cache_miss_input_tokens INTEGER,cache_write_input_tokens INTEGER,connection_slug TEXT,model_id TEXT,cost_basis TEXT,cost_usd REAL);`);
    db.prepare('INSERT INTO session_metadata VALUES (?,?)').run(
      sessionId,
      JSON.stringify({ model: 'test' }),
    );
    for (const [ordinal, kind] of [
      [2, 'text'],
      [1, 'thinking'],
    ]) {
      const entry = event(
        `event-${ordinal}`,
        { kind, text: kind === 'thinking' ? 'PRIVATE_REASONING' : 'input' },
        'user',
      );
      db.prepare('INSERT INTO runtime_events VALUES (?,?,?)').run(
        entry.id,
        kind,
        JSON.stringify(entry),
      );
      db.prepare('INSERT INTO runtime_session_event_ordinals VALUES (?,?,?)').run(
        sessionId,
        ordinal,
        entry.id,
      );
    }
    const before = db.prepare('SELECT total_changes() AS n').get().n;
    const result = collectContextSnapshot(db, sessionId);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
    assert.equal(result.throughOrdinal, 2);
    assert.equal(result.storageByKind.thinking.records, 1);
    assert.equal(result.runtimeEvents.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING/u);
    assert.throws(() => collectContextSnapshot(db, 'absent'), /Session not found/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM session_metadata').get().n, 1);
  } finally {
    db.close();
  }
});
