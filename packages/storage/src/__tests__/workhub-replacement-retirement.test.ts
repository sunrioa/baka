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
import test from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID as HUB,
  type StoredMessage,
  type WorkHubDelegationReplacementAbortedMessage,
  type WorkHubDelegationReplacementRequestedMessage,
  type WorkHubDelegationSupersededMessage,
} from '@maka/core/session';
import { createSessionStore } from '../session-store.js';
import { SessionMetadataConflictError } from '../session-store-contract.js';
import { createMemorySessionStore } from '../test-only/memory-execution-session.js';
import { MemoryExecutionAuthority } from '../test-only/memory-execution-state.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

type Backend = 'sqlite' | 'memory';
const suffix = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 48);

async function fixture(
  backend: Backend,
  intentPatch: Partial<WorkHubDelegationReplacementRequestedMessage> | false = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'maka-replacement-intent-retirement-'));
  const memory = new MemoryExecutionAuthority();
  const open = () =>
    backend === 'sqlite' ? createSessionStore(root) : createMemorySessionStore(memory, root);
  let store = open();
  try {
    await createCoordinationSession(store, root);
    const source = await store.create({
      cwd: root,
      name: 'Original task',
      llmConnectionSlug: 'original',
      model: 'original-model',
      permissionMode: 'ask',
    });
    const target = await store.create({
      cwd: root,
      name: 'Old replacement target',
      llmConnectionSlug: 'replacement',
      model: 'replacement-model',
      permissionMode: 'explore',
    });
    const original = assignmentRequest('original-task', source.id, source.name, 'original-turn');
    await store.assignWorkHubMessage(original);
    const base = assignmentRequest('old-replacement', target.id, target.name, 'replacement-turn');
    const assignment = {
      ...base.assignment,
      schemaVersion: 2 as const,
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
    };
    const {
      kind: _kind,
      delegationId: _delegation,
      targetTurnId: _turn,
      targetMessageId: _message,
      ...envelope
    } = base.assignment;
    const intent: WorkHubDelegationReplacementRequestedMessage = {
      ...envelope,
      id: 'whp_' + suffix(original.assignment.delegationId),
      schemaVersion: 2,
      kind: 'delegation_replacement_requested',
      replacesActionId: original.assignment.actionId,
      replacesDelegationId: original.assignment.delegationId,
      replacedTargetSessionId: source.id,
      replacedTargetMessageId: original.admission.messageId,
      ...(intentPatch || {}),
    };
    const abort: WorkHubDelegationReplacementAbortedMessage = {
      type: 'workhub_coordination',
      id: 'whb_' + suffix(original.assignment.delegationId),
      turnId: intent.turnId,
      ts: 20,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: intent.actionId,
      actionFingerprint: intent.actionFingerprint,
      coordinationTurnId: intent.coordinationTurnId,
      abortedActionId: intent.replacesActionId,
      abortedDelegationId: intent.replacesDelegationId,
      targetSessionId: intent.targetSessionId,
      reason: 'legacy_protocol_retirement',
    };
    const supersession: WorkHubDelegationSupersededMessage = {
      type: 'workhub_coordination',
      id: 'whx_' + suffix(original.assignment.delegationId),
      turnId: assignment.turnId,
      ts: 30,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: assignment.actionId,
      actionFingerprint: assignment.actionFingerprint,
      coordinationTurnId: assignment.coordinationTurnId,
      supersededActionId: original.assignment.actionId,
      supersededDelegationId: original.assignment.delegationId,
      replacementDelegationId: assignment.delegationId,
    };
    if (intentPatch !== false) await store.appendMessage(HUB, intent);
    return {
      get store() {
        return store;
      },
      source,
      target,
      original,
      intent,
      abort,
      supersession,
      replacement: { ...base, assignment, supersession },
      async reopen() {
        await store.close?.();
        store = open();
      },
      async close() {
        await store.close?.();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await store.close?.();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function originalState(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    source: await f.store.readHeaderSnapshot(f.source.id),
    target: await f.store.readHeaderSnapshot(f.target.id),
    admission: await f.store.readMessageAdmission(f.source.id, f.original.admission.messageId),
  };
}

for (const backend of ['sqlite', 'memory'] as const) {
  test(`${backend}: protocol retirement closes only the legacy intent and survives reopen without changing its task`, async () => {
    const f = await fixture(backend);
    try {
      const before = await originalState(f);
      assert.deepEqual(
        await f.store.readWorkHubReplacement(f.original.assignment.delegationId),
        f.intent,
      );
      assert.deepEqual(
        await f.store.readWorkHubReplacement(f.original.assignment.delegationId, true),
        f.intent,
      );
      await f.store.appendMessage(HUB, f.abort);
      for (const reopen of [false, true]) {
        if (reopen) await f.reopen();
        assert.deepEqual(
          await f.store.readWorkHubReplacement(f.original.assignment.delegationId),
          f.intent,
          'raw immutable intent remains readable',
        );
        assert.deepEqual(
          await f.store.readWorkHubReplacementAbort(f.original.assignment.delegationId),
          f.abort,
        );
        assert.equal(
          await f.store.readWorkHubReplacement(f.original.assignment.delegationId, true),
          undefined,
        );
        assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id]), [
          f.original.assignment,
        ]);
        assert.deepEqual(
          await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id], 32, true),
          [f.original.assignment],
        );
        assert.deepEqual(await originalState(f), before);
        await assert.rejects(
          f.store.assignWorkHubMessage(f.replacement),
          SessionMetadataConflictError,
        );
        assert.equal(
          await f.store.readWorkHubAssignment(f.replacement.assignment.actionId),
          undefined,
        );
        assert.equal(
          await f.store.readWorkHubSupersession(f.original.assignment.delegationId),
          undefined,
        );
        assert.equal(
          await f.store.readMessageAdmission(f.target.id, f.replacement.admission.messageId),
          undefined,
        );
        assert.deepEqual(
          await originalState(f),
          before,
          'late replacement admission must not mutate either target',
        );
      }
    } finally {
      await f.close();
    }
  });

  const mismatches: ReadonlyArray<
    readonly [string, Partial<WorkHubDelegationReplacementAbortedMessage>]
  > = [
    ['ordinary unavailable abort', { reason: 'target_unavailable' }],
    ['ordinary waiting abort', { reason: 'target_waiting_for_user' }],
    ['foreign action', { actionId: 'other-action' }],
    ['foreign fingerprint', { actionFingerprint: `sha256:${'d'.repeat(64)}` }],
    ['foreign coordinator Turn', { turnId: 'other-turn', coordinationTurnId: 'other-turn' }],
    ['foreign replaced action', { abortedActionId: 'other-original' }],
    ['foreign delegation', { abortedDelegationId: 'other-delegation' }],
    ['foreign replacement target', { targetSessionId: 'other-target' }],
  ];
  for (const [name, mismatch] of mismatches)
    test(`${backend}: ${name} cannot release the pending replacement or original link`, async () => {
      const f = await fixture(backend);
      try {
        const marker = { ...f.abort, ...mismatch };
        const before = await originalState(f);
        await f.store.appendMessage(HUB, marker);
        await f.reopen();
        assert.deepEqual(
          await f.store.readWorkHubReplacement(f.original.assignment.delegationId),
          f.intent,
        );
        assert.deepEqual(
          await f.store.readWorkHubReplacement(f.original.assignment.delegationId, true),
          f.intent,
        );
        assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id]), []);
        await assert.rejects(
          f.store.assignWorkHubMessage(f.replacement),
          SessionMetadataConflictError,
        );
        assert.deepEqual(await originalState(f), before);
      } finally {
        await f.close();
      }
    });

  test(`${backend}: unknown retirement reasons fail decoding and cannot unlock an intent`, async () => {
    const f = await fixture(backend);
    try {
      await assert.rejects(
        f.store.appendMessage(HUB, {
          ...f.abort,
          reason: 'unknown_retirement',
        } as unknown as StoredMessage),
        /Invalid stored message schema/u,
      );
      await f.reopen();
      assert.deepEqual(
        await f.store.readWorkHubReplacement(f.original.assignment.delegationId, true),
        f.intent,
      );
      assert.equal(
        await f.store.readWorkHubReplacementAbort(f.original.assignment.delegationId),
        undefined,
      );
    } finally {
      await f.close();
    }
  });

  test(`${backend}: an orphan retirement abort cannot make an original assignment active`, async () => {
    const f = await fixture(backend, false);
    try {
      await f.store.appendMessage(HUB, f.abort);
      await f.reopen();
      assert.equal(
        await f.store.readWorkHubReplacement(f.original.assignment.delegationId),
        undefined,
      );
      assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id]), []);
      await assert.rejects(
        f.store.assignWorkHubMessage(f.replacement),
        SessionMetadataConflictError,
      );
    } finally {
      await f.close();
    }
  });

  const foreignSources: ReadonlyArray<
    readonly [string, Partial<WorkHubDelegationReplacementRequestedMessage>]
  > = [
    ['source action', { replacesActionId: 'foreign-source-action' }],
    ['source delegation', { replacesDelegationId: 'foreign-source-delegation' }],
    ['source Session', { replacedTargetSessionId: 'foreign-source-session' }],
    ['source Message', { replacedTargetMessageId: 'foreign-source-message' }],
  ];
  for (const [name, patch] of foreignSources)
    test(`${backend}: a matching pair with a foreign ${name} cannot revive the original assignment`, async () => {
      const f = await fixture(backend, patch);
      try {
        await f.store.appendMessage(HUB, f.abort);
        await f.reopen();
        assert.deepEqual(
          await f.store.readWorkHubReplacement(f.original.assignment.delegationId),
          f.intent,
        );
        if (patch.replacesDelegationId)
          assert.deepEqual(
            await f.store.readWorkHubReplacement(f.original.assignment.delegationId, true),
            f.intent,
            'a foreign delegation in the request does not match the lookup key',
          );
        assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id]), []);
      } finally {
        await f.close();
      }
    });

  test(`${backend}: an intent-retirement marker cannot undo a committed replacement`, async () => {
    const f = await fixture(backend);
    try {
      await f.store.assignWorkHubMessage(f.replacement);
      await f.store.appendMessage(HUB, f.abort);
      await f.reopen();
      assert.deepEqual(
        await f.store.readWorkHubSupersession(f.original.assignment.delegationId),
        f.supersession,
      );
      assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.source.id]), []);
      assert.deepEqual(await f.store.readActiveWorkHubAssignmentsByTarget([f.target.id]), [
        f.replacement.assignment,
      ]);
      assert.deepEqual(
        await f.store.readMessageAdmission(f.target.id, f.replacement.admission.messageId),
        f.replacement.admission,
      );
      assert.equal(
        (await f.store.assignWorkHubMessage(f.replacement)).kind,
        'existing',
        'completed replacement replay stays idempotent, never resurrecting the original',
      );
    } finally {
      await f.close();
    }
  });
}
