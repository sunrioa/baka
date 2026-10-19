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
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationReplacementAbortedMessage,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
  type WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import { createSqliteAgentRunStore } from '../agent-run-store.js';
import { createSessionStore, isSessionNotFoundError } from '../session-store.js';
import {
  createCoordinationSession,
  assignmentRequest,
  type AssignmentRequest,
} from './fixtures/workhub-assignment.js';

test('persists exact work relationships atomically and pages assignments without reading unrelated output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-work-binding-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Same title',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('work-a', target.id, target.name, 'turn-a');
    original.assignment.schemaVersion = 4;
    original.assignment.work = {
      id: 'work-a',
      generationId: 'work-a',
      sourceMessageId: 'source-user-message',
    };
    await store.appendMessage(WORKHUB_COORDINATION_SESSION_ID, {
      type: 'user',
      id: 'source-user-message',
      turnId: 'work-a',
      ts: 1,
      text: original.assignment.userText,
    });
    await store.assignWorkHubMessage(original);
    const independent = assignmentRequest('work-b', target.id, target.name, 'turn-b');
    independent.assignment.schemaVersion = 4;
    independent.assignment.work = { id: 'work-b', generationId: 'work-b' };
    await store.assignWorkHubMessage(independent);
    await store.appendMessage(WORKHUB_COORDINATION_SESSION_ID, {
      type: 'assistant',
      id: 'large-unrelated-result',
      turnId: 'other-turn',
      ts: 20,
      text: 'x'.repeat(200_000),
      modelId: 'test',
    });
    const followup = assignmentRequest('followup-a', target.id, target.name, 'turn-followup');
    followup.assignment.schemaVersion = 4;
    followup.assignment.work = {
      id: 'work-a',
      generationId: 'work-a',
      continuesActionId: 'work-a',
    };
    await store.assignWorkHubMessage(followup);
    assert.equal((await store.readLatestWorkHubAssignment('work-a'))?.actionId, 'followup-a');
    assert.equal(await store.readLatestWorkHubAssignment('unknown-work'), undefined);
    assert.equal((await store.readWorkHubAssignment('work-b'))?.work?.id, 'work-b');
    const first = await store.readWorkHubAssignmentsPage({
      beforeSequence: Number.MAX_SAFE_INTEGER,
      maxMessages: 1,
      maxStoredBytes: 1024,
    });
    assert.deepEqual(
      first.records.map(({ message }) => message.id),
      [followup.assignment.id],
    );
    const older = await store.readWorkHubAssignmentsPage({
      beforeSequence: first.records[0]!.sequence,
      maxMessages: 2,
      maxStoredBytes: 4096,
    });
    assert.deepEqual(
      older.records.map(({ message }) => message.id),
      [independent.assignment.id, original.assignment.id],
    );
    for (const [actionId, work] of [
      ['wrong-work', { id: 'work-b', generationId: 'work-b', continuesActionId: 'work-a' }],
      ['missing-source', { id: 'work-a', generationId: 'work-a', continuesActionId: 'unknown' }],
      ['wrong-generation', { id: 'work-a', generationId: 'work-b', continuesActionId: 'work-a' }],
    ] as const) {
      const bad = assignmentRequest(actionId, target.id, target.name, 'rejected-turn');
      bad.assignment.schemaVersion = 4;
      bad.assignment.work = work;
      await assert.rejects(store.assignWorkHubMessage(bad), /WorkHub continuation source/);
      assert.equal(await store.readWorkHubAssignment(actionId), undefined);
      assert.equal(await store.readMessageAdmission(target.id, bad.admission.messageId), undefined);
    }
    await store.close?.();
    store = createSessionStore(root);
    assert.deepEqual(
      (await store.assignWorkHubMessage(followup)).assignment.work,
      followup.assignment.work,
    );
    await assert.rejects(
      store.assignWorkHubMessage({
        ...followup,
        assignment: {
          ...followup.assignment,
          work: { id: 'work-b', generationId: 'work-b', continuesActionId: 'work-b' },
        },
      }),
      /different assignment/,
    );
    assert.equal((await store.readHeaderSnapshot(target.id)).permissionMode, 'ask');
    assert.equal((await store.readHeaderSnapshot(target.id)).model, 'test');
    assert.equal((await store.readHeaderSnapshot(target.id)).cwd, root);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically creates a fresh container for the same work and retires only its previous generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-fresh-container-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Original',
      llmConnectionSlug: 'old',
      model: 'old-model',
      permissionMode: 'explore',
    });
    const original = assignmentRequest('original-work', target.id, target.name, 'original-turn');
    original.assignment.schemaVersion = 4;
    original.assignment.work = { id: 'original-work', generationId: 'original-work' };
    await store.assignWorkHubMessage(original);
    const unrelated = assignmentRequest('independent-b', target.id, target.name, 'b-turn');
    unrelated.assignment.schemaVersion = 4;
    unrelated.assignment.work = { id: 'independent-b', generationId: 'independent-b' };
    await store.assignWorkHubMessage(unrelated);
    const fresh = (actionId: string) => {
      const request = assignmentRequest(
        actionId,
        `target-${actionId}`,
        'Fresh',
        `turn-${actionId}`,
      );
      request.assignment.schemaVersion = 4;
      request.assignment.disposition = 'create_new';
      request.assignment.create = { title: 'Fresh', workspace: { kind: 'host_path', path: root } };
      request.assignment.work = {
        id: 'original-work',
        generationId: actionId,
        continuesActionId: original.assignment.actionId,
      };
      return {
        ...request,
        create: {
          sessionId: request.assignment.targetSessionId,
          requestFingerprint: `sha256:${'b'.repeat(64)}` as const,
          input: {
            cwd: root,
            name: 'Fresh',
            llmConnectionSlug: 'new',
            model: 'new-model',
            permissionMode: 'ask' as const,
          },
        },
      };
    };
    const request = fresh('fresh-generation');
    const result = await store.assignWorkHubMessage(request);
    assert.equal(result.targetCreated, true);
    assert.deepEqual(result.assignment.work, request.assignment.work);
    assert.deepEqual(
      (await store.readActiveWorkHubAssignmentsByTarget([target.id])).map((a) => a.actionId),
      ['independent-b'],
    );
    assert.equal(
      (await store.readLatestWorkHubAssignment('original-work'))?.actionId,
      'fresh-generation',
    );
    assert.equal((await store.readHeaderSnapshot(target.id)).model, 'old-model');
    assert.equal((await store.readHeaderSnapshot(target.id)).permissionMode, 'explore');
    assert.equal(
      (await store.readHeaderSnapshot(request.assignment.targetSessionId)).model,
      'new-model',
    );
    const stale = fresh('stale-generation');
    await assert.rejects(store.assignWorkHubMessage(stale), /WorkHub continuation source/);
    await assert.rejects(
      store.readHeaderSnapshot(stale.assignment.targetSessionId),
      isSessionNotFoundError,
    );
    assert.equal(
      await store.readMessageAdmission(stale.assignment.targetSessionId, stale.admission.messageId),
      undefined,
    );
    await store.close?.();
    store = createSessionStore(root);
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'existing');
    assert.deepEqual(
      (await store.readWorkHubAssignment(original.assignment.actionId))?.work,
      original.assignment.work,
    );
    const retired = assignmentRequest(
      'old-follow-up',
      target.id,
      target.name,
      'old-follow-up-turn',
    );
    retired.assignment.schemaVersion = 4;
    retired.assignment.work = {
      id: 'original-work',
      generationId: 'original-work',
      continuesActionId: 'original-work',
    };
    await assert.rejects(store.assignWorkHubMessage(retired), /WorkHub continuation source/);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically commits one WorkHub assignment and target admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const request = assignmentRequest('action-one', target.id, 'Payments', 'target-turn');
    const first = await store.assignWorkHubMessage(request);
    const replay = await store.assignWorkHubMessage({
      ...request,
      assignment: {
        ...request.assignment,
        ts: request.assignment.ts + 10,
        targetTurnId: 'recomputed-turn',
        targetSessionName: 'Recomputed name',
      },
      admission: {
        ...request.admission,
        turnId: 'recomputed-turn',
        runId: 'recomputed-run',
      },
    });

    assert.equal(first.kind, 'assigned');
    assert.equal(replay.kind, 'existing');
    assert.equal(replay.assignment.targetTurnId, 'target-turn');
    assert.deepEqual(
      await store.readMessageAdmission(target.id, request.admission.messageId),
      request.admission,
    );
    assert.deepEqual(
      (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID)).filter(
        (message) => message.type === 'workhub_coordination',
      ),
      [request.assignment],
    );
    assert.deepEqual(await store.readActiveWorkHubAssignmentsByTarget([target.id]), [
      request.assignment,
    ]);
    const coordination = await store.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
    assert.equal(coordination.lastMessageAt, request.assignment.ts);
    await handOffToRootTurn(store, root, request);
    const replayAfterConsumption = await store.assignWorkHubMessage(request);
    assert.equal(replayAfterConsumption.kind, 'existing');
    assert.deepEqual(replayAfterConsumption.assignment, request.assignment);
    assert.deepEqual(await store.readActiveWorkHubAssignmentsByTarget([target.id]), [
      request.assignment,
    ]);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically binds delegated text and copied attachments while preserving source authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-delegated-content-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const base = assignmentRequest('delegated-content', target.id, 'Payments', 'target-turn');
    const sourceAttachment = {
      kind: 'other' as const,
      name: 'requirements.txt',
      mimeType: 'text/plain',
      bytes: 12,
      ref: {
        kind: 'session_file' as const,
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        relativePath: 'source-file',
      },
    };
    const targetAttachment = {
      ...sourceAttachment,
      ref: { kind: 'session_file' as const, sessionId: target.id, relativePath: 'copied-file' },
    };
    const content = normalizeMessageContent({
      text: 'Fix the payment retry state',
      attachments: [targetAttachment],
    });
    const request = {
      ...base,
      assignment: {
        ...base.assignment,
        userText: 'Continue Payments and explain the result here',
        delegationText: content.text,
        attachments: [sourceAttachment],
        targetAttachments: [targetAttachment],
      },
      admission: {
        ...base.admission,
        content,
        submittedContentDigest: messageContentDigest(content),
      },
    };
    const wrongContent = normalizeMessageContent({
      text: request.assignment.userText,
      attachments: [targetAttachment],
    });
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        admission: {
          ...request.admission,
          content: wrongContent,
          submittedContentDigest: messageContentDigest(wrongContent),
        },
      }),
      /Invalid WorkHub assignment identity/,
    );
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, targetAttachments: [sourceAttachment] },
      }),
      /Invalid WorkHub assignment identity/,
    );
    assert.equal(await store.readWorkHubAssignment(request.assignment.actionId), undefined);
    assert.equal(
      await store.readMessageAdmission(target.id, request.admission.messageId),
      undefined,
    );
    assert.equal((await store.assignWorkHubMessage(request)).kind, 'assigned');
    assert.deepEqual(
      (await store.readMessageAdmission(target.id, request.admission.messageId))?.content,
      content,
    );
    await store.close?.();
    store = createSessionStore(root);
    assert.deepEqual((await store.assignWorkHubMessage(request)).assignment, request.assignment);
    const changed = normalizeMessageContent({ ...content, text: 'Different delegated work' });
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: { ...request.assignment, delegationText: changed.text },
        admission: {
          ...request.admission,
          content: changed,
          submittedContentDigest: messageContentDigest(changed),
        },
      }),
      /different assignment/,
    );
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: {
          ...request.assignment,
          attachments: [
            {
              ...sourceAttachment,
              ref: { ...sourceAttachment.ref, relativePath: 'another-source' },
            },
          ],
        },
      }),
      /different assignment/,
    );
    assert.deepEqual(
      await store.readWorkHubAssignment(request.assignment.actionId),
      request.assignment,
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('scans every target Message lifecycle once and preserves Coordination order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-target-linkage-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const unrelated = await store.create({
      cwd: root,
      name: 'Login',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const oldest = assignmentRequest('target-oldest', target.id, 'Payments', 'oldest-turn');
    const middle = assignmentRequest('target-middle', target.id, 'Payments', 'middle-turn');
    const newest = assignmentRequest('target-newest', target.id, 'Payments', 'newest-turn');
    await store.assignWorkHubMessage(oldest);
    await store.assignWorkHubMessage(
      assignmentRequest('unrelated-action', unrelated.id, 'Login', 'unrelated-turn'),
    );
    await store.assignWorkHubMessage(middle);
    await handOffToRootTurn(store, root, middle);
    await store.assignWorkHubMessage(newest);
    assert.equal(
      await store.claimMessageAdmissionCancellation(
        target.id,
        newest.admission.messageId,
        'newest-cancellation-claim',
      ),
      'cancelled_by_claim',
    );

    assert.deepEqual(await store.readActiveWorkHubAssignmentsByTarget([target.id]), [
      newest.assignment,
      middle.assignment,
      oldest.assignment,
    ]);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps target assignments reachable when their Message lifecycle changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-target-linkage-transition-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const requests = ['transition-first', 'transition-second', 'transition-third']
      .map((actionId) => assignmentRequest(actionId, target.id, target.name, `${actionId}-turn`))
      .sort((left, right) => left.admission.messageId.localeCompare(right.admission.messageId));
    for (const request of requests) await store.assignWorkHubMessage(request);

    await handOffToRootTurn(store, root, requests[1]!);
    assert.equal(
      await store.claimMessageAdmissionCancellation(
        target.id,
        requests[0]!.admission.messageId,
        'transition-cancellation-claim',
      ),
      'cancelled_by_claim',
    );

    assert.deepEqual(
      (await store.readActiveWorkHubAssignmentsByTarget([target.id])).map(
        ({ actionId }) => actionId,
      ),
      [...requests].reverse().map(({ assignment }) => assignment.actionId),
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores ordinary WorkHub-shaped Message ids without hiding a real linkage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-target-linkage-namespace-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const unrelated = await store.create({
      cwd: root,
      name: 'Login',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const real = assignmentRequest('real-target-action', target.id, target.name, 'real-turn');
    const other = assignmentRequest(
      'other-target-action',
      unrelated.id,
      unrelated.name,
      'other-turn',
    );
    await store.assignWorkHubMessage(real);
    await store.assignWorkHubMessage(other);
    const ordinaryContent = normalizeMessageContent({ text: 'An ordinary pending Message' });
    const ordinaryIds = [
      ...Array.from(
        { length: 33 },
        (_, index) => `whm_${(index + 1).toString(16).padStart(48, '0')}`,
      ),
      other.admission.messageId,
    ];
    assert.equal(
      ordinaryIds.slice(0, -1).every((id) => id < real.admission.messageId),
      true,
    );
    for (const [index, messageId] of ordinaryIds.entries()) {
      await store.commitMessageAdmission({
        sessionId: target.id,
        turnId: `ordinary-turn-${index}`,
        runId: `ordinary-run-${index}`,
        messageId,
        content: ordinaryContent,
        submittedContentDigest: messageContentDigest(ordinaryContent),
        submittedPlacement: 'current_turn',
        placement: 'current_turn',
        disposition: 'steering',
        skillInvocation: { loaded: [], failed: [], receipts: [] },
        admittedAt: index,
      });
    }

    assert.deepEqual(
      (await store.readActiveWorkHubAssignmentsByTarget([target.id])).map(
        ({ actionId }) => actionId,
      ),
      [real.assignment.actionId],
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('retires a link on every terminal record and on no other outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-terminal-matrix-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const requests = Object.fromEntries(
      ['plain', 'superseded', 'aborted', 'stopped', 'not-owned'].map((actionId) => [
        actionId,
        assignmentRequest(actionId, target.id, 'Payments', `${actionId}-turn`),
      ]),
    ) as Record<'plain' | 'superseded' | 'aborted' | 'stopped' | 'not-owned', AssignmentRequest>;
    for (const request of Object.values(requests)) await store.assignWorkHubMessage(request);

    const superseded = requests.superseded.assignment;
    const aborted = requests.aborted.assignment;
    const stopped = requests.stopped.assignment;
    const notOwned = requests['not-owned'].assignment;
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${terminalSuffix(superseded.delegationId)}`,
      turnId: 'terminal-matrix',
      ts: 20,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: 'terminal-matrix-supersede',
      actionFingerprint: `sha256:${'d'.repeat(64)}`,
      coordinationTurnId: 'terminal-matrix',
      supersededActionId: superseded.actionId,
      supersededDelegationId: superseded.delegationId,
      replacementDelegationId: 'whd_terminal_matrix_replacement',
    };
    const replacementAbort: WorkHubDelegationReplacementAbortedMessage = {
      type: 'workhub_coordination',
      id: `whb_${terminalSuffix(aborted.delegationId)}`,
      turnId: 'terminal-matrix',
      ts: 21,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: 'terminal-matrix-abort',
      actionFingerprint: `sha256:${'e'.repeat(64)}`,
      coordinationTurnId: 'terminal-matrix',
      abortedActionId: aborted.actionId,
      abortedDelegationId: aborted.delegationId,
      targetSessionId: target.id,
      reason: 'target_unavailable',
    };
    const stopResolution = (
      assignment: WorkHubDelegationAssignedMessage,
      outcome: WorkHubDelegationStopResolvedMessage['outcome'],
      ts: number,
    ): WorkHubDelegationStopResolvedMessage => ({
      type: 'workhub_coordination',
      id: `whz_${terminalSuffix(assignment.delegationId)}`,
      turnId: 'terminal-matrix',
      ts,
      schemaVersion: 3,
      kind: 'delegation_stop_resolved',
      actionId: `terminal-matrix-stop-${outcome}`,
      actionFingerprint: `sha256:${'f'.repeat(64)}`,
      coordinationTurnId: 'terminal-matrix',
      stopsActionId: assignment.actionId,
      stopsDelegationId: assignment.delegationId,
      targetSessionId: target.id,
      targetTurnId: assignment.targetTurnId,
      outcome,
    });
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
      supersession,
      replacementAbort,
      stopResolution(stopped, 'stop_delivered', 22),
      // `not_owned` means WorkHub never held the work, so the link survives.
      stopResolution(notOwned, 'not_owned', 23),
    ]);

    assert.deepEqual(
      (await store.readActiveWorkHubAssignmentsByTarget([target.id])).map(
        ({ actionId }) => actionId,
      ),
      ['not-owned', 'plain'],
    );
    assert.deepEqual(
      (await store.readActiveWorkHubAssignmentsByTarget([target.id], undefined, true)).map(
        ({ actionId }) => actionId,
      ),
      ['not-owned', 'stopped', 'plain'],
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls create_new Session back when assignment validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-create-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const request = assignmentRequest(
      'create-action',
      'created-target',
      'Wrong name',
      'target-turn',
    );
    await assert.rejects(
      store.assignWorkHubMessage({
        ...request,
        assignment: {
          ...request.assignment,
          disposition: 'create_new',
          create: {
            title: 'Actual name',
            workspace: { kind: 'host_path', path: root },
          },
        },
        create: {
          sessionId: 'created-target',
          requestFingerprint: `sha256:${'b'.repeat(64)}`,
          input: {
            cwd: root,
            name: 'Actual name',
            llmConnectionSlug: 'test',
            model: 'test',
            permissionMode: 'ask',
          },
        },
      }),
      /display identity changed/u,
    );
    await assert.rejects(store.readHeaderSnapshot('created-target'), (error) =>
      isSessionNotFoundError(error),
    );
    assert.deepEqual(await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID), []);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a stale display identity for a new delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stale-assignment-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const request = assignmentRequest('stale-action', target.id, 'Old name', 'target-turn');

    await assert.rejects(store.assignWorkHubMessage(request), /display identity changed/u);
    assert.equal(await store.readWorkHubAssignment(request.assignment.actionId), undefined);
    assert.equal(
      await store.readMessageAdmission(target.id, request.assignment.targetMessageId),
      undefined,
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('atomically commits a replacement generation and refuses stale legacy sources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-replacement-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destination = await store.create({
      cwd: root,
      name: 'Login before rename',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('original-action', source.id, 'Payments', 'source-turn');
    await store.assignWorkHubMessage(original);

    const base = assignmentRequest(
      'replacement-action',
      destination.id,
      'Login before rename',
      'destination-turn',
    );
    const assignment: WorkHubDelegationAssignedMessage = {
      ...base.assignment,
      schemaVersion: 4,
      work: { id: original.assignment.actionId, generationId: base.assignment.actionId },
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    await store.rename(destination.id, 'Login');

    const committed = await store.assignWorkHubMessage({
      ...base,
      assignment,
      supersession,
    });
    const committedAssignment = { ...assignment, targetSessionName: 'Login' };

    const stale = assignmentRequest('stale-legacy-source', source.id, source.name, 'stale-turn');
    stale.assignment.schemaVersion = 4;
    stale.assignment.work = {
      id: original.assignment.actionId,
      generationId: original.assignment.actionId,
      continuesActionId: original.assignment.actionId,
    };
    await assert.rejects(store.assignWorkHubMessage(stale), /continuation source/);
    assert.equal(await store.readWorkHubAssignment(stale.assignment.actionId), undefined);
    assert.equal(await store.readMessageAdmission(source.id, stale.admission.messageId), undefined);
    assert.equal((await store.assignWorkHubMessage(original)).kind, 'existing');

    assert.equal(committed.kind, 'assigned');
    assert.deepEqual(committed.assignment, committedAssignment);
    assert.deepEqual(
      await store.readWorkHubSupersession(original.assignment.delegationId),
      supersession,
    );
    assert.deepEqual(await store.readWorkHubAssignment(assignment.actionId), committedAssignment);
    assert.deepEqual(
      await store.readMessageAdmission(destination.id, assignment.targetMessageId),
      base.admission,
    );
    assert.deepEqual(
      (await store.readMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID))
        .filter((message) => message.type === 'workhub_coordination')
        .map((message) => message.kind),
      ['delegation_assigned', 'delegation_assigned', 'delegation_superseded'],
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an aborted replacement cannot later commit a supersession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-aborted-replacement-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destination = await store.create({
      cwd: root,
      name: 'Login',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('original-aborted', source.id, 'Payments', 'source-turn');
    await store.assignWorkHubMessage(original);
    const base = assignmentRequest(
      'replacement-after-abort',
      destination.id,
      'Login',
      'destination-turn',
    );
    const assignment: WorkHubDelegationAssignedMessage = {
      ...base.assignment,
      schemaVersion: 2,
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    const abort: WorkHubDelegationReplacementAbortedMessage = {
      type: 'workhub_coordination',
      id: `whb_${createHash('sha256')
        .update(original.assignment.delegationId)
        .digest('hex')
        .slice(0, 48)}`,
      turnId: assignment.actionId,
      ts: assignment.ts - 1,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      abortedActionId: original.assignment.actionId,
      abortedDelegationId: original.assignment.delegationId,
      targetSessionId: destination.id,
      reason: 'target_unavailable',
    };
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [abort]);

    await assert.rejects(
      store.assignWorkHubMessage({ ...base, assignment, supersession }),
      /replacement is aborted/u,
    );
    assert.equal(await store.readWorkHubAssignment(assignment.actionId), undefined);
    assert.equal(await store.readWorkHubSupersession(original.assignment.delegationId), undefined);
    assert.equal(
      await store.readMessageAdmission(destination.id, assignment.targetMessageId),
      undefined,
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('old and task-bound stop requests retain exact set snapshots across SQLite reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-task-stop-record-'));
  let store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const target = await store.create({
      cwd: root,
      name: 'Task stop record fixture',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const assignments = ['a', 'b', 'legacy'].map((key) =>
      assignmentRequest('stop-contract-' + key, target.id, target.name, 'turn-' + key),
    );
    for (const input of assignments) await store.assignWorkHubMessage(input);
    const [a, b, old] = assignments.map((input) => input.assignment);
    assert.ok(a && b && old);
    const request = (source: WorkHubDelegationAssignedMessage, actionId: string) => ({
      type: 'workhub_coordination' as const,
      kind: 'delegation_stop_requested' as const,
      schemaVersion: 3 as const,
      id: 'whq_' + createHash('sha256').update(source.delegationId).digest('hex').slice(0, 48),
      turnId: 'coordinator-turn',
      coordinationTurnId: 'coordinator-turn',
      ts: 20,
      actionId,
      actionFingerprint: `sha256:${'d'.repeat(64)}` as const,
      stopsActionId: source.actionId,
      stopsDelegationId: source.delegationId,
      targetSessionId: source.targetSessionId,
      targetMessageId: source.targetMessageId,
      targetSessionName: source.targetSessionName,
      userText: 'Stop the captured tasks',
    });
    const legacy = request(old, 'legacy-stop');
    const targets = [a, b].map((source) => ({
      workId: source.actionId,
      generationId: source.actionId,
      sourceActionId: source.actionId,
      sourceDelegationId: source.delegationId,
      targetSessionId: source.targetSessionId,
      targetMessageId: source.targetMessageId,
      executionBinding: JSON.stringify([
        'pending_message',
        source.actionId,
        source.delegationId,
        source.targetSessionId,
        source.targetMessageId,
      ]),
    }));
    const first = targets[0]!;
    const modern: WorkHubDelegationStopRequestedMessage = {
      ...request(a, 'set-stop'),
      workId: first.workId,
      executionBinding: first.executionBinding,
      taskStop: true,
      stopSet: { actionId: 'set-stop', targets },
    };
    const claim = {
      actionId: modern.actionId,
      actionFingerprint: modern.actionFingerprint,
      operation: 'stop' as const,
      subject: a.delegationId,
    };
    await store.claimWorkHubAction(claim);
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [legacy, modern]);
    const pending = await store.listMessageAdmissions(target.id);
    await store.close?.();
    store = createSessionStore(root);
    assert.deepEqual(await store.readWorkHubStopRequest(old.delegationId), legacy);
    assert.deepEqual(await store.readWorkHubStopRequest(a.delegationId, modern.actionId), modern);
    assert.deepEqual(await store.readWorkHubActionClaim(modern.actionId), claim);
    assert.deepEqual(await store.listMessageAdmissions(target.id), pending);
    const header = await store.readHeaderSnapshot(target.id);
    assert.equal(header.permissionMode, 'ask');
    assert.equal(header.model, 'test');
    assert.equal(header.cwd, target.cwd);
    // This is record compatibility only: no stop effect, Form or execution is
    // invoked, and acceptance of a manifest is not execution authorization.
    assert.equal(await store.hasCancelledMessageAdmission(target.id, a.targetMessageId), false);
    assert.equal(await store.hasCancelledMessageAdmission(target.id, b.targetMessageId), false);
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unresolved stop claim blocks replacement while not_owned releases the link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-stop-arbitration-'));
  const store = createSessionStore(root);
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Payments',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const destination = await store.create({
      cwd: root,
      name: 'Login',
      llmConnectionSlug: 'test',
      model: 'test',
      permissionMode: 'ask',
    });
    const original = assignmentRequest('stop-source', source.id, 'Payments', 'source-turn');
    await store.assignWorkHubMessage(original);
    const delegationSuffix = createHash('sha256')
      .update(original.assignment.delegationId)
      .digest('hex')
      .slice(0, 48);
    const request: WorkHubDelegationStopRequestedMessage = {
      type: 'workhub_coordination',
      id: `whq_${delegationSuffix}`,
      turnId: 'stop-action',
      ts: 11,
      schemaVersion: 3,
      kind: 'delegation_stop_requested',
      actionId: 'stop-action',
      actionFingerprint: `sha256:${'d'.repeat(64)}`,
      coordinationTurnId: 'stop-action',
      stopsActionId: original.assignment.actionId,
      stopsDelegationId: original.assignment.delegationId,
      targetSessionId: source.id,
      targetMessageId: original.assignment.targetMessageId,
      targetSessionName: 'Payments',
      userText: 'Stop Payments',
    };
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [request]);
    assert.deepEqual(await store.readWorkHubStopRequest(original.assignment.delegationId), request);

    const base = assignmentRequest('after-stop', destination.id, 'Login', 'destination-turn');
    const assignment: WorkHubDelegationAssignedMessage = {
      ...base.assignment,
      schemaVersion: 2,
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: `whx_${delegationSuffix}`,
      turnId: assignment.actionId,
      ts: assignment.ts,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    await assert.rejects(
      store.assignWorkHubMessage({ ...base, assignment, supersession }),
      /stop claim/u,
    );

    const resolution: WorkHubDelegationStopResolvedMessage = {
      type: 'workhub_coordination',
      id: `whz_${delegationSuffix}`,
      turnId: 'stop-action',
      ts: 12,
      schemaVersion: 3,
      kind: 'delegation_stop_resolved',
      actionId: 'stop-action',
      actionFingerprint: request.actionFingerprint,
      coordinationTurnId: 'stop-action',
      stopsActionId: original.assignment.actionId,
      stopsDelegationId: original.assignment.delegationId,
      targetSessionId: source.id,
      targetTurnId: 'shared-turn',
      outcome: 'not_owned',
    };
    await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [resolution]);
    assert.deepEqual(
      await store.readWorkHubStopResolution(original.assignment.delegationId),
      resolution,
    );
    assert.equal(
      (await store.assignWorkHubMessage({ ...base, assignment, supersession })).kind,
      'assigned',
    );
  } finally {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

function terminalSuffix(delegationId: string): string {
  return createHash('sha256').update(delegationId, 'utf8').digest('hex').slice(0, 48);
}

/**
 * Hand a Message off the way a Turn does: the Root admission that consumed it
 * is what keeps its identity durable once the pending admission is retired.
 */
async function handOffToRootTurn(
  store: ReturnType<typeof createSessionStore>,
  root: string,
  request: AssignmentRequest,
): Promise<void> {
  const runStore = createSqliteAgentRunStore(root);
  try {
    await runStore.admitRootTurn({
      sessionId: request.admission.sessionId,
      turnId: request.admission.turnId,
      proposedRunId: request.admission.runId,
      proposedUserMessageId: request.admission.messageId,
      execution: {
        kind: 'external_message',
        inputDigest: request.admission.submittedContentDigest,
      },
      previousRootTurnId: null,
      normalizedInput: request.admission.content,
      sourceMessages: [
        {
          messageId: request.admission.messageId,
          content: request.admission.content,
          submittedContentDigest: request.admission.submittedContentDigest,
          placement: request.admission.placement,
          disposition: request.admission.disposition,
        },
      ],
      admittedAt: request.admission.admittedAt,
    });
  } finally {
    runStore.close?.();
  }
  await store.markMessagesHandedOff({
    sessionId: request.admission.sessionId,
    messageIds: [request.admission.messageId],
    turnId: request.admission.turnId,
  });
}
