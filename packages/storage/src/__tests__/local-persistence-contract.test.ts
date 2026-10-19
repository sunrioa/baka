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
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  messageContentDigest,
  normalizeMessageContent,
  type AttachmentRef,
} from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import {
  SessionMetadataConflictError,
  SessionMetadataVersionConflictError,
  type WorkHubMessageAssignmentRequest,
} from '../session-store-contract.js';
import {
  SessionMetadataConflictError as SqliteConflict,
  SessionMetadataVersionConflictError as SqliteVersionConflict,
} from '../sqlite-session-metadata-store.js';
import { SessionMetadataConflictError as ExecutionConflict } from '../execution-stores.js';
import { acquireOperationalStateDatabase } from '../operational-state-store.js';
import {
  openStorageWriterComposition,
  type StorageWriterComposition,
} from '../storage-writer-composition.js';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type InteractiveRootOwner,
} from '../root-authority.js';
import {
  trackControlDirectory,
  removeTrackedControlDirectories,
} from './fixtures/control-directory-hygiene.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

after(removeTrackedControlDirectories);

test('contract errors retain instanceof identity through existing package seams', () => {
  assert.equal(SqliteConflict, SessionMetadataConflictError);
  assert.equal(ExecutionConflict, SessionMetadataConflictError);
  assert.equal(SqliteVersionConflict, SessionMetadataVersionConflictError);
  assert.ok(new SessionMetadataVersionConflictError('target', 1, 2) instanceof SqliteConflict);
});

test('leased WorkHub contract persists copied attachments and rejects inconsistent content or replay', async () => {
  await withComposition(async (storage, root) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const source: AttachmentRef = {
      kind: 'other',
      name: 'requirements.txt',
      mimeType: 'text/plain',
      bytes: 12,
      ref: {
        kind: 'session_file',
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        relativePath: 'source.txt',
      },
    };
    const copied: AttachmentRef = {
      ...source,
      ref: { kind: 'session_file', sessionId: target.id, relativePath: 'copied.txt' },
    };
    const base = assignmentRequest('attachments', target.id, 'Payments', 'target-turn');
    const content = normalizeMessageContent({
      text: base.assignment.userText,
      attachments: [copied],
    });
    const request: WorkHubMessageAssignmentRequest = {
      assignment: { ...base.assignment, attachments: [source], targetAttachments: [copied] },
      admission: {
        ...base.admission,
        content,
        submittedContentDigest: messageContentDigest(content),
      },
    };
    for (const attachments of [
      [],
      [source],
      [{ ...copied, bytes: 13 }],
      [copied, copied],
      [{ ...copied, name: 'different.txt' }],
    ]) {
      const invalid = normalizeMessageContent({ text: base.assignment.userText, attachments });
      await assert.rejects(
        store.assignWorkHubMessage({
          ...request,
          admission: {
            ...request.admission,
            content: invalid,
            submittedContentDigest: messageContentDigest(invalid),
          },
        }),
        SessionMetadataConflictError,
      );
      assert.equal(await store.readWorkHubAssignment(base.assignment.actionId), undefined);
      assert.deepEqual(await store.listMessageAdmissions(target.id), []);
    }
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, attachments: [copied] },
      }),
      SessionMetadataConflictError,
    );
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'assigned');
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'existing');
    assert.deepEqual(
      await store.readMessageAdmission(target.id, base.admission.messageId),
      request.admission,
    );
    // Same caller-supplied fingerprint cannot authorize replacing source content.
    const replacement = { ...source, ref: { ...source.ref, relativePath: 'different-source.txt' } };
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, attachments: [replacement] },
      }),
      SessionMetadataConflictError,
    );
    assert.deepEqual(
      await store.readWorkHubAssignment(base.assignment.actionId),
      request.assignment,
    );
  });
});

test('leased WorkHub transaction rolls back target, create claim, admission and linkage together', async () => {
  await withComposition(async (storage, root, owner) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    const base = assignmentRequest('rollback', 'new-target', 'Payments', 'target-turn');
    const request: WorkHubMessageAssignmentRequest = {
      ...base,
      assignment: {
        ...base.assignment,
        disposition: 'create_new',
        create: { title: 'Payments', workspace: { kind: 'host_path', path: root } },
      },
      create: {
        sessionId: 'new-target',
        requestFingerprint: `sha256:${'b'.repeat(64)}`,
        input: {
          cwd: root,
          name: 'Payments',
          llmConnectionSlug: 'test',
          model: 'test',
          permissionMode: 'ask',
        },
      },
    };
    // The adapter owns one shared connection. A test-only trigger aborts AFTER
    // target creation and admission insert, during the coordination insert.
    // The Host-facing contract exposes neither this connection nor SQL callbacks.
    const database = await runWithStorageRootLease(
      owner.lease,
      'interactive',
      'write',
      async (path) => acquireOperationalStateDatabase(path),
    );
    try {
      database.database.exec(`
        CREATE TEMP TRIGGER workhub_assignment_rollback BEFORE INSERT ON session_messages
        WHEN NEW.session_id = 'maka_workhub_coordination'
          AND json_extract(NEW.record_json, '$.kind') = 'delegation_assigned'
        BEGIN SELECT RAISE(ABORT, 'workhub_assignment_rollback'); END;
      `);
      await assert.rejects(store.assignWorkHubMessage(request), /workhub_assignment_rollback/);
      assert.equal(await store.readWorkHubAssignment(base.assignment.actionId), undefined);
      assert.equal(
        (await store.probeStableSessionCreate('new-target', request.create!.requestFingerprint))
          .kind,
        'absent',
      );
      assert.deepEqual(await store.listMessageAdmissions('new-target'), []);
      assert.deepEqual(
        (await store.listHeaders()).map((header) => header.id),
        [WORKHUB_COORDINATION_SESSION_ID],
      );
      database.database.exec('DROP TRIGGER workhub_assignment_rollback');
      assert.equal((await store.assignWorkHubMessage(request)).kind, 'assigned');
      assert.equal((await store.assignWorkHubMessage(request)).kind, 'existing');
      assert.deepEqual(
        await store.readWorkHubAssignment(base.assignment.actionId),
        request.assignment,
      );
      assert.deepEqual(await store.listMessageAdmissions('new-target'), [request.admission]);
    } finally {
      database.database.exec('DROP TRIGGER IF EXISTS workhub_assignment_rollback');
      database.close();
    }
  });
});

test('retained execution contract cannot read or assign after its root lease is closed', async () => {
  await withComposition(async (storage, root, owner) => {
    const store = storage.execution.sessionStore;
    await createCoordinationSession(store, root);
    await storage.close();
    await owner.close();
    const invalidLease = (error: unknown) =>
      error instanceof StorageRootAuthorityError && error.code === 'invalid_lease';
    await assert.rejects(store.listHeaders(), invalidLease);
    await assert.rejects(store.readWorkHubTaskInput('closed-input'), invalidLease);
    await assert.rejects(
      store.assignWorkHubMessage(assignmentRequest('closed', 'target', 'Payments', 'turn')),
      invalidLease,
    );
  });
});

for (const mode of ['queued_supplement', 'steering', 'continuation'] as const) {
  for (const stopState of (mode === 'continuation'
    ? ['none', 'modern_noop', 'modern_retired']
    : ['none', 'modern_noop']) as readonly string[])
    test(`leased task input ${mode} is atomic, source-bound and replayable without changing FIFO or defaults (${stopState})`, async () => {
      await withComposition(async (storage, root, owner) => {
        const store = storage.execution.sessionStore;
        await createCoordinationSession(store, root);
        const target = await store.create({
          cwd: root,
          name: 'Worker',
          llmConnectionSlug: 'test',
          model: 'original-model',
          permissionMode: 'ask',
        });
        const before = await store.readHeaderRecordSnapshot(target.id);
        const base = assignmentRequest('work-a', target.id, 'Worker', 'original-turn');
        const original: WorkHubMessageAssignmentRequest = {
          ...base,
          assignment: {
            ...base.assignment,
            schemaVersion: 4,
            work: { id: 'work-a', generationId: 'work-a' },
          },
          admission:
            mode === 'queued_supplement'
              ? {
                  ...base.admission,
                  placement: 'next_turn',
                  submittedPlacement: 'next_turn',
                  disposition: 'followup',
                }
              : base.admission,
        };
        await store.assignWorkHubMessage(original);
        if (stopState !== 'none') {
          // Constructed stop facts exercise the atomic input contract; they do
          // not claim this fixture executed or stopped a model Root.
          const source = original.assignment;
          const suffix = createHash('sha256')
            .update(source.delegationId)
            .digest('hex')
            .slice(0, 48);
          const q: WorkHubDelegationStopRequestedMessage = {
            type: 'workhub_coordination',
            kind: 'delegation_stop_requested',
            schemaVersion: 3,
            id: 'whq_' + suffix,
            turnId: 'stop-turn',
            ts: 10,
            actionId: 'stop-action',
            actionFingerprint: `sha256:${'a'.repeat(64)}`,
            coordinationTurnId: 'stop-turn',
            stopsActionId: source.actionId,
            stopsDelegationId: source.delegationId,
            targetSessionId: target.id,
            targetMessageId: source.targetMessageId,
            targetSessionName: target.name,
            userText: 'Stop',
            taskStop: true,
            workId: 'work-a',
            executionBinding: 'root-binding',
          };
          const r: WorkHubDelegationStopResolvedMessage = {
            type: 'workhub_coordination',
            kind: 'delegation_stop_resolved',
            schemaVersion: 3,
            id: (stopState === 'modern_retired' ? 'whzs_' : 'whz_') + suffix,
            turnId: q.turnId,
            ts: 11,
            actionId: q.actionId,
            actionFingerprint: q.actionFingerprint,
            coordinationTurnId: q.coordinationTurnId,
            stopsActionId: source.actionId,
            stopsDelegationId: source.delegationId,
            targetSessionId: target.id,
            outcome: stopState === 'modern_retired' ? 'stop_delivered' : 'already_terminal',
            targetTurnId: source.targetTurnId,
          };
          await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [q, r]);
        }
        const independent = assignmentRequest(
          'independent-c',
          target.id,
          'Worker',
          'original-turn',
        );
        await store.assignWorkHubMessage({
          ...independent,
          admission: {
            ...independent.admission,
            placement: 'next_turn',
            submittedPlacement: 'next_turn',
            disposition: 'followup',
          },
        });
        const clientId = `input-${mode}`;
        const hash = createHash('sha256').update(clientId).digest('hex').slice(0, 48);
        const text =
          mode === 'steering'
            ? 'Only A: ' + '\\'.repeat(32 * 1024 - 100)
            : 'Only supplement A; leave independent C alone';
        const content = normalizeMessageContent({
          text:
            mode === 'queued_supplement' ? `${original.admission.content.text}\n\n${text}` : text,
        });
        const next = assignmentRequest(`input-action-${mode}`, target.id, 'Worker', 'next-turn');
        const admission =
          mode === 'queued_supplement'
            ? {
                ...original.admission,
                content,
                submittedContentDigest: messageContentDigest(content),
              }
            : {
                ...(mode === 'continuation' ? next.admission : original.admission),
                messageId: mode === 'continuation' ? next.admission.messageId : `whtm_${hash}`,
                content,
                submittedContentDigest: messageContentDigest(content),
                admittedAt: 20,
              };
        const input: WorkHubTaskInputMessage = {
          type: 'workhub_coordination',
          kind: 'task_input',
          schemaVersion: 1,
          id: `whti_${hash}`,
          turnId: original.assignment.coordinationTurnId,
          ts: 20,
          inputId: clientId,
          workId: 'work-a',
          generationId: 'work-a',
          sourceActionId: original.assignment.actionId,
          sourceDelegationId: original.assignment.delegationId,
          text,
          targetSessionId: target.id,
          targetMessageId: admission.messageId,
          targetContentDigest: messageContentDigest(content),
          mode,
          ...(mode === 'steering'
            ? { execution: { turnId: admission.turnId, runId: admission.runId } }
            : {}),
        };
        const commit = (value = input) =>
          mode === 'continuation'
            ? store.assignWorkHubMessage({
                ...next,
                assignment: {
                  ...next.assignment,
                  schemaVersion: 4,
                  userText: text,
                  work: { id: 'work-a', generationId: 'work-a', continuesActionId: 'work-a' },
                },
                admission,
                taskInput: value,
              })
            : store.commitWorkHubTaskInput({
                input: value,
                admission,
                ...(mode === 'queued_supplement' ? { expectedAdmission: original.admission } : {}),
              });
        const pendingBefore = await store.listMessageAdmissions(target.id);
        for (const invalid of [
          { ...input, generationId: 'retired-generation' },
          { ...input, sourceDelegationId: 'foreign-delegation' },
          { ...input, workId: 'foreign-work' },
        ]) {
          await assert.rejects(commit(invalid), SessionMetadataConflictError);
          assert.equal(await store.readWorkHubTaskInput(clientId), undefined);
          assert.deepEqual(await store.listMessageAdmissions(target.id), pendingBefore);
        }
        const database = await runWithStorageRootLease(
          owner.lease,
          'interactive',
          'write',
          async (path) => acquireOperationalStateDatabase(path),
        );
        try {
          database.database.exec(`CREATE TEMP TRIGGER workhub_input_rollback BEFORE INSERT ON session_messages
          WHEN NEW.session_id = 'maka_workhub_coordination' AND NEW.message_id GLOB 'whti_*'
          BEGIN SELECT RAISE(ABORT, 'workhub_input_rollback'); END;`);
          await assert.rejects(commit(), /workhub_input_rollback/);
          assert.equal(await store.readWorkHubTaskInput(clientId), undefined);
          assert.deepEqual(await store.listMessageAdmissions(target.id), pendingBefore);
          if (mode === 'continuation')
            assert.equal(await store.readWorkHubAssignment(next.assignment.actionId), undefined);
          database.database.exec('DROP TRIGGER workhub_input_rollback');
          await commit();
          assert.deepEqual(await store.readWorkHubTaskInput(clientId), input);
          await commit({ ...input, ts: 30 });
          await assert.rejects(
            commit({ ...input, text: 'Different payload under the same input ID' }),
            SessionMetadataConflictError,
          );
          const after = await store.listMessageAdmissions(target.id);
          assert.deepEqual(
            after.map((item) => item.messageId),
            mode === 'queued_supplement'
              ? pendingBefore.map((item) => item.messageId)
              : [...pendingBefore.map((item) => item.messageId), admission.messageId],
          );
          assert.deepEqual(
            after.find((item) => item.messageId === independent.admission.messageId),
            pendingBefore.find((item) => item.messageId === independent.admission.messageId),
          );
          assert.deepEqual(await store.readHeaderRecordSnapshot(target.id), before);
          assert.equal(
            (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).filter(
              (item) => item.id === input.id,
            ).length,
            1,
          );
        } finally {
          database.database.exec('DROP TRIGGER IF EXISTS workhub_input_rollback');
          database.close();
        }
        if (mode === 'steering') {
          const execution = storage.execution.agentRunStore;
          for (const [item, turnId, runId, previousRootTurnId] of [
            [original.admission, original.admission.turnId, original.admission.runId, null],
            [admission, 'folded-input-turn', 'folded-input-run', original.admission.turnId],
          ] as const) {
            assert.equal(
              (
                await execution.admitRootTurn({
                  sessionId: target.id,
                  turnId,
                  proposedRunId: runId,
                  proposedUserMessageId: item.messageId,
                  previousRootTurnId,
                  execution: {
                    kind: 'external_message',
                    inputDigest: messageContentDigest(item.content),
                  },
                  normalizedInput: item.content,
                  sourceMessages: [
                    {
                      messageId: item.messageId,
                      content: item.content,
                      submittedContentDigest: item.submittedContentDigest,
                      placement: item.placement,
                      disposition: item.disposition,
                    },
                  ],
                  admittedAt: item.admittedAt,
                })
              ).kind,
              'admitted',
            );
          }
          const ref = {
            sessionId: target.id,
            turnId: original.admission.turnId,
            runId: original.admission.runId,
          };
          assert.deepEqual(await store.readWorkHubTaskInputByMessage(admission.messageId), input);
          assert.deepEqual(
            await store.readWorkHubTaskInputSuccessors(ref),
            [input],
            'chunked native input facts retain their successor binding',
          );
          assert.deepEqual(
            await store.readWorkHubTaskInputSuccessors({ ...ref, runId: 'foreign-run' }),
            [],
          );
        }
        await storage.close();
        const reopened = await openStorageWriterComposition(owner.lease);
        try {
          assert.deepEqual(
            await reopened.execution.sessionStore.readWorkHubTaskInput(clientId),
            input,
          );
          assert.deepEqual(
            await reopened.execution.sessionStore.readHeaderRecordSnapshot(target.id),
            before,
          );
          if (mode === 'steering')
            assert.deepEqual(
              await reopened.execution.sessionStore.readWorkHubTaskInputSuccessors({
                sessionId: target.id,
                turnId: original.admission.turnId,
                runId: original.admission.runId,
              }),
              [input],
            );
        } finally {
          await reopened.close();
        }
      });
    });
}

async function withComposition(
  run: (
    storage: StorageWriterComposition,
    root: string,
    owner: InteractiveRootOwner,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-local-persistence-contract-'));
  const capability = trackControlDirectory(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let storage: StorageWriterComposition | undefined;
  try {
    storage = await openStorageWriterComposition(owner.lease);
    await run(storage, root, owner);
  } finally {
    await storage?.close();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
