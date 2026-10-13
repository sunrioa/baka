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
import { DatabaseSync } from 'node:sqlite';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import {
  workHubPeerQuestionIdentity,
  workHubPeerInboxId,
  workHubPeerSettlementId,
  type WorkHubPeerQuestionMessage,
  type WorkHubPeerSettlementMessage,
} from '@maka/core/workhub-evidence';
import { createSessionStore } from '../session-store.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

const task = (a: WorkHubDelegationAssignedMessage) => ({
  workId: a.work?.id ?? a.actionId,
  generationId: a.work?.generationId ?? a.actionId,
  actionId: a.actionId,
  delegationId: a.delegationId,
  sessionId: a.targetSessionId,
  messageId: a.targetMessageId,
});

test('peer publication is atomic, scoped, bounded and durable without changing admission or permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-peer-store-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const a = await store.create({
      cwd: root,
      name: 'A',
      model: 'a-model',
      llmConnectionSlug: 'test',
      permissionMode: 'ask',
    });
    const b = await store.create({
      cwd: root,
      name: 'B',
      model: 'b-model',
      llmConnectionSlug: 'test',
      permissionMode: 'explore',
    });
    const assignments = [
      assignmentRequest('a', a.id, a.name, 'turn-a'),
      assignmentRequest('b', b.id, b.name, 'turn-b'),
    ];
    for (const assignment of assignments) {
      assignment.assignment.returnResults = true;
      await store.assignWorkHubMessage(assignment);
    }
    const headerA = await store.readHeaderSnapshot(a.id),
      headerB = await store.readHeaderSnapshot(b.id);
    const make = (toolCallId: string): WorkHubPeerQuestionMessage => {
      const ts = Date.now();
      const q: WorkHubPeerQuestionMessage = {
        type: 'workhub_peer_question',
        schemaVersion: 1,
        id: '',
        turnId: 'turn-a',
        ts,
        expiresAt: ts + 3600000,
        sender: task(assignments[0]!.assignment),
        recipient: task(assignments[1]!.assignment),
        senderRunId: 'run-a',
        senderInvocationId: 'invocation-a',
        toolCallId,
        question: 'Which checksum? 中文 😀',
        round: 1,
      };
      return {
        ...q,
        id:
          'whpq_' +
          createHash('sha256').update(workHubPeerQuestionIdentity(q)).digest('hex').slice(0, 48),
      };
    };
    const scan = () =>
      store.readWorkHubPeerInboxPage(b.id, 'b', Date.now(), {
        beforeSequence: Number.MAX_SAFE_INTEGER,
        maxMessages: 64,
        maxStoredBytes: 256 * 1024,
      });
    const q = make('ask');
    assert.deepEqual(await store.commitWorkHubPeerQuestion(q), q);
    assert.deepEqual(
      await store.commitWorkHubPeerQuestion({ ...q, ts: q.ts + 1, expiresAt: q.expiresAt + 1 }),
      q,
      'retry does not renew expiry',
    );
    await assert.rejects(
      store.commitWorkHubPeerQuestion({ ...q, question: 'Changed question' }),
      /identity conflict/,
    );
    assert.equal((await scan()).records.length, 1);
    assert.equal(
      (
        await store.readWorkHubPeerInboxPage(b.id, 'unrelated-c', Date.now(), {
          maxMessages: 64,
          maxStoredBytes: 4096,
        })
      ).records.length,
      0,
    );
    assert.equal(
      (
        await store.readWorkHubPeerInboxPage(b.id, 'b', q.expiresAt, {
          maxMessages: 64,
          maxStoredBytes: 4096,
        })
      ).records.length,
      0,
    );
    await store.appendMessage(b.id, {
      type: 'assistant',
      id: 'unrelated-large-result',
      turnId: 'c',
      ts: Date.now(),
      text: 'x'.repeat(1024 * 1024),
      modelId: 'b-model',
    });
    assert.equal((await scan()).records.length, 1, 'large unrelated result never enters peer page');

    const reply: WorkHubPeerSettlementMessage = {
      type: 'workhub_peer_settlement',
      schemaVersion: 1,
      id: workHubPeerSettlementId(q.id),
      turnId: 'turn-b',
      ts: Date.now(),
      requesterSessionId: a.id,
      questionId: q.id,
      actor: q.recipient,
      senderRunId: 'run-b',
      senderInvocationId: 'invocation-b',
      toolCallId: 'reply',
      outcome: 'reply',
      answer: 'abc123',
    };
    assert.deepEqual(await store.commitWorkHubPeerSettlement(reply), reply);
    assert.deepEqual(
      await store.commitWorkHubPeerSettlement({ ...reply, toolCallId: 'retry' }),
      reply,
    );
    await assert.rejects(
      store.commitWorkHubPeerSettlement({ ...reply, answer: 'different' }),
      /identity conflict/,
    );
    assert.deepEqual(
      await store.commitWorkHubPeerSettlement({
        ...reply,
        actor: q.sender,
        outcome: 'cancelled',
        answer: undefined,
      }),
      reply,
      'a later cancellation cannot erase the committed answer',
    );
    assert.equal((await scan()).records.length, 0);
    const cancelled = make('cancel-first');
    await store.commitWorkHubPeerQuestion(cancelled);
    const cancel: WorkHubPeerSettlementMessage = {
      ...reply,
      id: workHubPeerSettlementId(cancelled.id),
      questionId: cancelled.id,
      actor: cancelled.sender,
      ts: Date.now(),
      outcome: 'cancelled',
      answer: undefined,
    };
    await store.commitWorkHubPeerSettlement(cancel);
    assert.equal(
      (
        await store.commitWorkHubPeerSettlement({
          ...reply,
          id: cancel.id,
          questionId: cancelled.id,
          ts: Date.now(),
        })
      ).outcome,
      'cancelled',
      'late reply cannot resurrect cancellation',
    );

    const collision = make('atomic-collision');
    await store.appendMessage(b.id, {
      type: 'assistant',
      id: workHubPeerInboxId(collision.id),
      turnId: 'unrelated',
      ts: Date.now(),
      text: 'identity collision',
      modelId: 'b-model',
    });
    await assert.rejects(store.commitWorkHubPeerQuestion(collision), /identity conflict/);
    assert.equal(
      (await store.readMessagesSnapshot(a.id)).some((m) => m.id === collision.id),
      false,
      'question rolls back when inbox insert fails',
    );
    const rollback = make('atomic-rollback');
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    try {
      db.exec(
        "CREATE TRIGGER fail_peer_inbox BEFORE INSERT ON session_messages WHEN NEW.message_type = 'workhub_peer_inbox' BEGIN SELECT RAISE(ABORT, 'inbox write failed'); END",
      );
      await assert.rejects(store.commitWorkHubPeerQuestion(rollback), /inbox write failed/);
      assert.equal(
        (await store.readMessagesSnapshot(a.id)).some((m) => m.id === rollback.id),
        false,
        'A write rolls back on a genuine B write failure',
      );
    } finally {
      db.exec('DROP TRIGGER fail_peer_inbox');
      db.close();
    }
    for (let i = 0; i < 6; i++) await store.commitWorkHubPeerQuestion(make(`bounded-${i}`));
    await assert.rejects(store.commitWorkHubPeerQuestion(make('ninth')), /limit reached/);
    await assert.rejects(
      store.readWorkHubPeerInboxPage(b.id, 'b', Date.now(), {
        maxMessages: 65,
        maxStoredBytes: 4096,
      }),
      /bound/,
    );
    await store.close?.();
    store = createSessionStore(root);
    assert.deepEqual(await store.commitWorkHubPeerQuestion(q), q);
    assert.deepEqual(await store.commitWorkHubPeerSettlement(reply), reply);
    assert.deepEqual(
      await store.readMessageAdmission(a.id, assignments[0]!.admission.messageId),
      assignments[0]!.admission,
    );
    for (const [id, header] of [
      [a.id, headerA],
      [b.id, headerB],
    ] as const) {
      const actual = await store.readHeaderSnapshot(id);
      for (const field of ['model', 'permissionMode', 'cwd', 'connectionLocked'] as const)
        assert.deepEqual(actual[field], header[field]);
    }
    await store.setSessionsArchivedVersioned(
      [{ sessionId: b.id, expectedVersion: (await store.readHeaderRecordSnapshot(b.id)).revision }],
      true,
    );
    await assert.rejects(store.commitWorkHubPeerQuestion(make('retired')), /identity|retired/);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
