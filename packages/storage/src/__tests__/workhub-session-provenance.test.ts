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
import { test } from 'node:test';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { createSessionStore } from '../session-store.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

test('catalog provenance requires a canonical create fact and survives queue lifecycle changes and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-session-provenance-'));
  let store = createSessionStore(root);
  try {
    const input = {
      cwd: root,
      name: 'WorkHub',
      labels: ['workhub', 'task:created'],
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask' as const,
    };
    await createCoordinationSession(store, root);
    await store.createStableSession({
      sessionId: 'whs_manual-lookalike',
      requestFingerprint: `sha256:${'b'.repeat(64)}`,
      input,
    });
    const adopted = assignmentRequest(
      'adopted-task',
      'whs_manual-lookalike',
      input.name,
      'adopted',
    );
    await store.assignWorkHubMessage(adopted);
    const created = assignmentRequest('created-task', 'plain-session-id', input.name, 'created');
    const create = {
      ...created,
      assignment: {
        ...created.assignment,
        disposition: 'create_new' as const,
        create: { title: input.name, workspace: { kind: 'host_path' as const, path: root } },
      },
      create: {
        sessionId: created.assignment.targetSessionId,
        requestFingerprint: `sha256:${'c'.repeat(64)}` as const,
        input,
      },
    };
    await store.assignWorkHubMessage(create);
    // A copied-looking target identity is only a lookup candidate. The
    // canonical create fact belongs to another Session and must not mark this one.
    await store.commitMessageAdmission({
      ...created.admission,
      sessionId: adopted.assignment.targetSessionId,
    });
    await assertCatalog();
    assert.equal('workHubCreated' in (await store.readHeaderSnapshot('plain-session-id')), false);

    const runStore = createSqliteAgentRunStore(root);
    try {
      await runStore.admitRootTurn({
        sessionId: created.admission.sessionId,
        turnId: created.admission.turnId,
        proposedRunId: created.admission.runId,
        proposedUserMessageId: created.admission.messageId,
        execution: {
          kind: 'external_message',
          inputDigest: created.admission.submittedContentDigest,
        },
        previousRootTurnId: null,
        normalizedInput: created.admission.content,
        sourceMessages: [
          {
            messageId: created.admission.messageId,
            content: created.admission.content,
            submittedContentDigest: created.admission.submittedContentDigest,
            placement: created.admission.placement,
            disposition: created.admission.disposition,
          },
        ],
        admittedAt: created.admission.admittedAt,
      });
    } finally {
      runStore.close?.();
    }
    await store.markMessagesHandedOff({
      sessionId: created.admission.sessionId,
      messageIds: [created.admission.messageId],
      turnId: created.admission.turnId,
    });
    await assertCatalog();

    const cancelled = assignmentRequest(
      'cancelled-create',
      'cancelled-container',
      input.name,
      'cancelled',
    );
    await store.assignWorkHubMessage({
      ...cancelled,
      assignment: {
        ...create.assignment,
        ...cancelled.assignment,
        disposition: 'create_new',
        create: create.assignment.create,
      },
      create: { ...create.create, sessionId: cancelled.assignment.targetSessionId },
    });
    await store.cancelMessageAdmissions(cancelled.admission.sessionId, [
      cancelled.admission.messageId,
    ]);
    assert.equal(
      (await store.readCatalogRecord('cancelled-container')).summary.workHubCreated,
      true,
    );
    await store.updateHeader('plain-session-id', { name: 'Renamed ordinary title', labels: [] });
    await store.close?.();
    store = createSessionStore(root);
    await assertCatalog();
    assert.equal(
      (await store.readCatalogRecord('cancelled-container')).summary.workHubCreated,
      true,
    );

    async function assertCatalog() {
      assert.equal(
        (await store.readCatalogRecord('plain-session-id')).summary.workHubCreated,
        true,
      );
      assert.equal(
        Object.hasOwn(
          (await store.readCatalogRecord('whs_manual-lookalike')).summary,
          'workHubCreated',
        ),
        false,
      );
      const list = await store.list();
      assert.equal(list.find((session) => session.id === 'plain-session-id')?.workHubCreated, true);
      assert.equal(
        list.find((session) => session.id === 'whs_manual-lookalike')?.workHubCreated,
        undefined,
      );
      const page = await store.listCatalogPage(undefined, undefined, 32);
      assert.equal(page.kind, 'page');
      if (page.kind !== 'page') assert.fail('Expected a catalog page');
      assert.equal(
        page.records.find((record) => record.header.id === 'plain-session-id')?.summary
          .workHubCreated,
        true,
      );
      assert.equal(
        page.records.find((record) => record.header.id === 'whs_manual-lookalike')?.summary
          .workHubCreated,
        undefined,
      );
    }
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy transcript identities locate canonical create provenance without a pending admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-legacy-provenance-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Imported ordinary container',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const { assignment } = assignmentRequest(
      'legacy-create',
      target.id,
      target.name,
      'legacy-turn',
    );
    assignment.disposition = 'create_new';
    assignment.create = { title: target.name, workspace: { kind: 'host_path', path: root } };
    assignment.userText = 'Historical request '.repeat(12_000);
    await store.appendMessage(WORKHUB_COORDINATION_SESSION_ID, assignment);
    await store.appendMessage(target.id, {
      type: 'user',
      id: assignment.targetMessageId,
      turnId: assignment.targetTurnId,
      ts: assignment.ts,
      text: assignment.userText,
    });
    assert.equal(
      await store.readMessageAdmission(target.id, assignment.targetMessageId),
      undefined,
    );
    assert.equal((await store.readCatalogRecord(target.id)).summary.workHubCreated, true);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
