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
import { describe, test } from 'node:test';
import {
  decodeCanonicalMessage,
  snapshotWorkHubTaskSettings,
  isWorkHubTaskSettingsSnapshot,
} from '../session.js';
import {
  isWorkHubTaskStopSet,
  isWorkHubTaskStopTarget,
  WORKHUB_TASK_STOP_MAX_TARGETS,
} from '../workhub-task-stop.js';

const FINGERPRINT = `sha256:${'a'.repeat(64)}`;

describe('WorkHub Coordination stored records', () => {
  test('task input facts bind a source and distinguish acceptance from delivery', () => {
    const input = {
      type: 'workhub_coordination',
      kind: 'task_input',
      schemaVersion: 1,
      id: 'input-record',
      turnId: 'source-turn',
      ts: 1,
      inputId: 'client-input',
      workId: 'work',
      generationId: 'generation',
      sourceActionId: 'source-action',
      sourceDelegationId: 'source-delegation',
      text: 'Change only the selected task',
      targetSessionId: 'worker',
      targetMessageId: 'message',
      targetContentDigest: FINGERPRINT,
      mode: 'queued_supplement',
    } as const;
    assert.deepEqual(decodeCanonicalMessage(input), input);
    const prepared = {
      ...input,
      originalUserText: '只补刚才的边界，不改接口',
      inputOrigin: 'user',
      sourceMessageId: 'real-user-message',
    };
    assert.deepEqual(decodeCanonicalMessage(prepared), prepared);
    assert.deepEqual(decodeCanonicalMessage({ ...prepared, inputOrigin: 'feedback' }), {
      ...prepared,
      inputOrigin: 'feedback',
    });
    const steering = {
      ...input,
      mode: 'steering',
      execution: { turnId: 'worker-turn', runId: 'worker-run' },
    };
    assert.deepEqual(decodeCanonicalMessage(steering), steering);
    for (const invalid of [
      { ...input, text: ' ' },
      { ...input, text: '中'.repeat(17_000) },
      { ...input, generationId: undefined },
      { ...input, workId: '../foreign' },
      { ...input, targetContentDigest: 'not-a-digest' },
      { ...input, delivered: true },
      { ...prepared, originalUserText: ' ' },
      { ...prepared, originalUserText: '中'.repeat(17_000) },
      { ...prepared, inputOrigin: 'model_claimed_user' },
      { ...prepared, sourceMessageId: '../outside' },
      { ...input, execution: steering.execution },
      { ...steering, execution: undefined },
      { ...steering, execution: { ...steering.execution, permissionMode: 'bypass' } },
    ])
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
  });

  test('decodes one exact atomic delegation assignment', () => {
    const assigned = {
      type: 'workhub_coordination',
      id: 'assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'payments',
      disposition: 'delegate_existing',
      userText: 'Continue payment work',
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Payments',
      steered: true,
    } as const;

    assert.deepEqual(decodeCanonicalMessage(assigned), assigned);
    assert.deepEqual(decodeCanonicalMessage({ ...assigned, taskTitle: 'Initial objective' }), {
      ...assigned,
      taskTitle: 'Initial objective',
    });
    for (const taskTitle of ['', ' ', null, ['title'], 'bad\nname', 'x'.repeat(513)])
      assert.throws(
        () => decodeCanonicalMessage({ ...assigned, taskTitle }),
        /Invalid stored message schema/u,
      );
    const settings = snapshotWorkHubTaskSettings(
      {
        id: 'payments',
        cwd: '/work',
        backend: 'ai-sdk',
        model: 'user-selected',
        llmConnectionId: 'connection',
        llmConnectionSlug: 'proxy',
        permissionMode: 'ask',
        toolMode: 'code_mode',
        thinkingLevel: 'high',
      },
      'current_segment',
    );
    assert.equal(isWorkHubTaskSettingsSnapshot(settings), true);
    assert.deepEqual(decodeCanonicalMessage({ ...assigned, settings }), { ...assigned, settings });
    for (const extra of [
      { rememberForTurn: true },
      { sandboxGrants: ['/'] },
      { toolMode: 'invalid' },
      { permissionMode: undefined },
      { executorId: 'remote' },
    ]) {
      assert.throws(() =>
        decodeCanonicalMessage({ ...assigned, settings: { ...settings, ...extra } }),
      );
    }
    const executorConfig = { model: 'executor-model', mode: 'ask' };
    const executorSettings = snapshotWorkHubTaskSettings(
      {
        ...settings,
        id: 'executor',
        llmConnectionId: 'connection',
        thinkingLevel: 'high',
        backend: 'plugin-executor',
        executorId: 'remote',
        executorConfig,
      },
      'current_segment',
    );
    executorConfig.mode = 'auto';
    assert.equal(
      executorSettings.executorConfig?.mode,
      'ask',
      'snapshot is independent of later user edits',
    );
    assert.equal(isWorkHubTaskSettingsSnapshot(executorSettings), true);
    const delegated = { ...assigned, delegationText: 'Inspect the payment retry state' };
    assert.deepEqual(decodeCanonicalMessage(delegated), delegated);
    const original = {
      ...assigned,
      schemaVersion: 4,
      work: { id: assigned.actionId, generationId: assigned.actionId },
    };
    assert.deepEqual(decodeCanonicalMessage(original), original);
    const continuation = {
      ...original,
      actionId: 'follow-up',
      work: {
        id: assigned.actionId,
        generationId: assigned.actionId,
        continuesActionId: assigned.actionId,
        sourceMessageId: 'actual-message',
      },
    };
    assert.deepEqual(decodeCanonicalMessage(continuation), continuation);
    for (const invalid of [
      { ...original, schemaVersion: 1 },
      { ...original, work: undefined },
      { ...original, work: { ...original.work, generationId: 'different-generation' } },
      { ...original, work: { id: 'different-objective' } },
      { ...continuation, work: { ...continuation.work, continuesActionId: 'follow-up' } },
      { ...continuation, work: { ...continuation.work, sourceMessageId: '../foreign' } },
      { ...continuation, work: { ...continuation.work, permissionMode: 'bypass' } },
    ])
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    for (const delegationText of ['', '  ', 42, null]) {
      assert.throws(
        () => decodeCanonicalMessage({ ...assigned, delegationText }),
        /Invalid stored message schema/u,
      );
    }
  });

  test('rejects malformed or widened coordination records', () => {
    const base = {
      type: 'workhub_coordination',
      id: 'assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'payments',
      disposition: 'delegate_existing',
      userText: 'Continue payment work',
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Payments',
    } as const;

    for (const invalid of [
      { ...base, coordinationTurnId: 'different-turn' },
      { ...base, actionFingerprint: 'not-a-digest' },
      { ...base, disposition: 'replace' },
      { ...base, targetMessageId: undefined },
      { ...base, sourceSessionId: 'injected' },
      { ...base, kind: 'delegation_intent' },
      { ...base, schemaVersion: 2 },
    ]) {
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    }
  });

  test('requires a complete create payload only for create_new assignments', () => {
    const create = {
      type: 'workhub_coordination',
      id: 'create-assignment-id',
      turnId: 'coordination-turn',
      ts: 1,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'created-session',
      disposition: 'create_new',
      userText: 'Create a login audit',
      create: {
        title: 'Login audit',
        workspace: { kind: 'project', projectId: 'project-maka' },
      },
      delegationId: 'delegation-id',
      targetTurnId: 'target-turn',
      targetMessageId: 'target-message',
      targetSessionName: 'Login audit',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(create), create);
    assert.throws(
      () => decodeCanonicalMessage({ ...create, create: undefined }),
      /Invalid stored message schema/u,
    );
    assert.throws(
      () => decodeCanonicalMessage({ ...create, disposition: 'delegate_existing' }),
      /Invalid stored message schema/u,
    );
  });

  test('decodes the durable replacement intent and linked supersession proof', () => {
    const replacement = {
      type: 'workhub_coordination',
      id: 'replacement-intent-id',
      turnId: 'replacement-action',
      ts: 2,
      schemaVersion: 2,
      kind: 'delegation_replacement_requested',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      targetSessionId: 'login',
      targetSessionName: 'Login',
      disposition: 'delegate_existing',
      userText: 'No, use login instead',
      replacesActionId: 'original-action',
      replacesDelegationId: 'original-delegation',
      replacedTargetSessionId: 'payments',
      replacedTargetMessageId: 'payments-message',
    } as const;
    const assigned = {
      type: 'workhub_coordination',
      id: 'replacement-assignment-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_assigned',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      targetSessionId: 'login',
      targetSessionName: 'Login',
      disposition: 'delegate_existing',
      userText: 'No, use login instead',
      delegationId: 'replacement-delegation',
      targetTurnId: 'login-turn',
      targetMessageId: 'login-message',
      replacesActionId: 'original-action',
      replacesDelegationId: 'original-delegation',
    } as const;
    const superseded = {
      type: 'workhub_coordination',
      id: 'supersession-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_superseded',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      supersededActionId: 'original-action',
      supersededDelegationId: 'original-delegation',
      replacementDelegationId: 'replacement-delegation',
    } as const;
    const aborted = {
      type: 'workhub_coordination',
      id: 'replacement-aborted-id',
      turnId: 'replacement-action',
      ts: 3,
      schemaVersion: 2,
      kind: 'delegation_replacement_aborted',
      actionId: 'replacement-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'replacement-action',
      abortedActionId: 'original-action',
      abortedDelegationId: 'original-delegation',
      targetSessionId: 'login',
      reason: 'target_unavailable',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(replacement), replacement);
    const delegatedReplacement = { ...replacement, delegationText: 'Fix the login retry loop' };
    assert.deepEqual(decodeCanonicalMessage(delegatedReplacement), delegatedReplacement);
    assert.deepEqual(decodeCanonicalMessage(assigned), assigned);
    assert.deepEqual(decodeCanonicalMessage(superseded), superseded);
    assert.deepEqual(decodeCanonicalMessage(aborted), aborted);
    assert.throws(
      () => decodeCanonicalMessage({ ...superseded, replacementDelegationId: '' }),
      /Invalid stored message schema/u,
    );
    assert.throws(
      () => decodeCanonicalMessage({ ...aborted, reason: 'retry_later' }),
      /Invalid stored message schema/u,
    );
  });

  test('decodes exact direct-stop request and observed resolution records', () => {
    const requested = {
      type: 'workhub_coordination',
      id: 'stop-request-id',
      turnId: 'stop-action',
      ts: 4,
      schemaVersion: 3,
      kind: 'delegation_stop_requested',
      actionId: 'stop-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'stop-action',
      stopsActionId: 'original-action',
      stopsDelegationId: 'original-delegation',
      targetSessionId: 'payments',
      targetMessageId: 'payments-message',
      targetSessionName: 'Payments',
      userText: 'Stop Payments',
    } as const;
    const resolved = {
      type: 'workhub_coordination',
      id: 'stop-resolution-id',
      turnId: 'stop-action',
      ts: 5,
      schemaVersion: 3,
      kind: 'delegation_stop_resolved',
      actionId: 'stop-action',
      actionFingerprint: FINGERPRINT,
      coordinationTurnId: 'stop-action',
      stopsActionId: 'original-action',
      stopsDelegationId: 'original-delegation',
      targetSessionId: 'payments',
      targetTurnId: 'payments-turn',
      outcome: 'stop_delivered',
    } as const;

    assert.deepEqual(decodeCanonicalMessage(requested), requested);
    const bound = {
      ...requested,
      workId: 'original-action',
      executionBinding: '["payments","turn-1","run-1"]',
    };
    assert.deepEqual(decodeCanonicalMessage(bound), bound);
    const target = {
      workId: bound.workId,
      generationId: 'original-generation',
      sourceActionId: requested.stopsActionId,
      sourceDelegationId: requested.stopsDelegationId,
      targetSessionId: requested.targetSessionId,
      targetMessageId: requested.targetMessageId,
      executionBinding: bound.executionBinding,
    };
    const taskStop = {
      ...bound,
      taskStop: true,
      stopSet: { actionId: requested.actionId, targets: [target] },
    };
    assert.deepEqual(decodeCanonicalMessage(taskStop), taskStop);
    assert.deepEqual(decodeCanonicalMessage({ ...bound, taskStop: true }), {
      ...bound,
      taskStop: true,
    });
    for (const invalid of [
      { ...taskStop, taskStop: false },
      { ...taskStop, taskStop: undefined },
      { ...taskStop, workId: undefined },
      { ...taskStop, executionBinding: undefined },
      { ...taskStop, executionBinding: 'other-root' },
      { ...taskStop, targetMessageId: 'another-message' },
      { ...taskStop, stopSet: { ...taskStop.stopSet, actionId: 'different-action' } },
      { ...taskStop, stopSet: { ...taskStop.stopSet, targets: [] } },
      { ...taskStop, stopSet: { ...taskStop.stopSet, targets: [target, target] } },
      { ...taskStop, stopSet: { ...taskStop.stopSet, confirmed: true } },
      { ...taskStop, confirmed: true },
    ])
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    assert.deepEqual(decodeCanonicalMessage(resolved), resolved);
    for (const invalid of [
      { ...requested, candidateRef: 'injected' },
      { ...requested, schemaVersion: 2 },
      { ...requested, executionBinding: '' },
      { ...requested, executionBinding: 'x'.repeat(4097) },
      { ...requested, executionBinding: 1 },
      { ...requested, executionBinding: 'bad\0binding' },
      { ...resolved, outcome: 'stopped' },
      { ...resolved, runId: 'injected' },
      { ...resolved, targetTurnId: '' },
      { ...resolved, targetTurnId: undefined },
      { ...resolved, outcome: 'cancelled_pending' },
    ]) {
      assert.throws(() => decodeCanonicalMessage(invalid), /Invalid stored message schema/u);
    }
    assert.deepEqual(
      decodeCanonicalMessage({
        ...resolved,
        outcome: 'cancelled_pending',
        targetTurnId: undefined,
      }),
      {
        ...resolved,
        outcome: 'cancelled_pending',
        targetTurnId: undefined,
      },
    );
  });

  test('task-stop sets are bounded, exact and reject duplicate task identities', () => {
    const target = {
      workId: 'work',
      generationId: 'generation',
      sourceActionId: 'source',
      sourceDelegationId: 'delegation',
      targetSessionId: 'session',
      targetMessageId: 'message',
      executionBinding: 'binding',
    };
    const targets = Array.from({ length: WORKHUB_TASK_STOP_MAX_TARGETS }, (_, i) => ({
      ...target,
      workId: 'work-' + i,
    }));
    const set = { actionId: 'stop-action', targets };
    assert.equal(isWorkHubTaskStopSet(set), true);
    assert.equal(isWorkHubTaskStopTarget({ ...target, executionBinding: '😀'.repeat(1024) }), true);
    for (const invalid of [
      { ...set, targets: [] },
      { ...set, targets: [...targets, { ...target, workId: 'one-too-many' }] },
      { ...set, targets: [target, { ...target, generationId: 'newer-generation' }] },
      { ...set, targets: [{ ...target, permissionMode: 'bypass' }] },
      { ...set, targets: [{ ...target, workId: '../outside' }] },
      { ...set, targets: [{ ...target, generationId: '' }] },
      { ...set, targets: [{ ...target, sourceActionId: 'a'.repeat(129) }] },
      { ...set, targets: [{ ...target, executionBinding: 'bad\0binding' }] },
      { ...set, targets: [{ ...target, executionBinding: 'x'.repeat(4097) }] },
      { ...set, targets: [{ ...target, executionBinding: '😀'.repeat(1025) }] },
      { ...set, actionId: 'outside/path' },
      { ...set, handoffSummary: 'not part of stop authority' },
    ])
      assert.equal(isWorkHubTaskStopSet(invalid), false);
  });
});
