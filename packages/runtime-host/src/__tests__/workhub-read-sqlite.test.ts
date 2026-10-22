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

// Projection test: real SQLite and Gate, injected caller identity only.
// Not production Root authorization or provider/model/usage evidence.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionStore } from '@maka/storage/session-store';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openToolResultArchiveEvidenceReader } from '@maka/storage/tool-result-archive-evidence';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import { encodeDurableToolResultOutput } from '@maka/runtime/durable-tool-result-projection';
import { createLedgerArchiveResourceReader } from '@maka/runtime/ledger-tool-result-archive-reader';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import { shapeTerminalResult } from '@maka/runtime/shell-tools';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';
import { createWorkHubReadTool } from '../server/workhub-read-tool.js';
import { createWorkHubTaskHistoryReader } from '../server/workhub-task-history-reader.js';

const coordination = 'maka_workhub_coordination';
const suffix = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 48);
function source(actionId: string, text: string): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    schemaVersion: 4,
    kind: 'delegation_assigned',
    id: 'wha_' + suffix(actionId),
    actionId,
    turnId: 'source-turn',
    coordinationTurnId: 'source-turn',
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    ts: 1,
    disposition: 'delegate_existing',
    delegationId: 'whd_' + suffix(actionId),
    targetSessionId: 'worker',
    targetSessionName: 'Worker',
    targetTurnId: 'worker-turn',
    targetMessageId: 'whm_' + suffix(actionId),
    userText: text,
    delegationText: 'Prepared instruction is not original text',
    returnResults: true,
    work: { id: actionId, generationId: actionId },
  };
}
function correction(
  assignment: WorkHubDelegationAssignedMessage,
  inputId: string,
  raw: string,
): WorkHubTaskInputMessage {
  return {
    type: 'workhub_coordination',
    kind: 'task_input',
    schemaVersion: 1,
    id: 'whti_' + suffix(inputId),
    turnId: 'source-turn',
    ts: 2,
    inputId,
    workId: assignment.work?.id ?? assignment.actionId,
    generationId: assignment.work?.generationId ?? assignment.actionId,
    sourceActionId: assignment.actionId,
    sourceDelegationId: assignment.delegationId,
    targetSessionId: assignment.targetSessionId,
    targetMessageId: 'input-' + inputId,
    text: 'Prepared reminder',
    originalUserText: raw,
    inputOrigin: 'user',
    sourceMessageId: 'user-' + inputId,
    targetContentDigest: `sha256:${'b'.repeat(64)}`,
    mode: 'queued_supplement',
  };
}
const ctx: MakaToolContext = {
  sessionId: coordination,
  turnId: 'read-turn',
  runId: 'read-run',
  invocationId: 'read-invocation',
  toolCallId: 'read-call',
  cwd: '/workspace',
  emitOutput() {},
  abortSignal: new AbortController().signal,
};
test('requirements page actual SQLite across unrelated records, Unicode and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wh-read-sqlite-'));
  let store = createSessionStore(root);
  try {
    for (const sessionId of [coordination, 'worker']) {
      await store.createStableSession({
        sessionId,
        requestFingerprint: `sha256:${'a'.repeat(64)}`,
        input: {
          cwd: root,
          name: sessionId,
          model: 'test',
          llmConnectionSlug: 'test',
          permissionMode: 'explore',
          ...(sessionId === coordination
            ? { role: 'workhub_coordination', toolProfile: 'workhub-coordination-v2' }
            : {}),
        },
      });
    }
    const original = 'x'.repeat(7999) + '😀原始用户要求'.repeat(400);
    const assignment = source('task-a', original);
    const raw = '保留前导零；不要 Number。'.repeat(600);
    const changed = correction(assignment, 'correction', raw);
    await store.appendMessages(coordination, [
      assignment,
      ...Array.from({ length: 150 }, (_, n) => source('unrelated-' + n, 'OTHER_TASK_SECRET_' + n)),
      changed,
    ]);
    const scans: Parameters<
      ReturnType<typeof createSessionStore>['readWorkHubTaskFactsPage']
    >[0][] = [];
    const unavailable = async () => {
      throw Error('Unexpected non-requirements reader');
    };
    const tool = createWorkHubReadTool({
      sessions: {
        readWorkHubAssignment: (actionId) => store.readWorkHubAssignment(actionId),
        readLatestWorkHubAssignment: (taskId) => store.readLatestWorkHubAssignment(taskId),
        readHeaderSnapshot: (sessionId) => store.readHeaderSnapshot(sessionId),
        readWorkHubTaskFactsPage: (request) => {
          scans.push(request);
          return store.readWorkHubTaskFactsPage(request);
        },
      },
      admission: new SessionAdmissionGate(),
      authorize: async () => undefined,
      status: unavailable,
      result: unavailable,
      evidence: unavailable,
      history: unavailable,
      inspect: unavailable,
      catalog: unavailable,
    });
    const projected = new Map<string, Array<[number, string]>>();
    let cursor: string | undefined;
    let count = 0,
      empty = false;
    do {
      const page = (await tool.impl(
        { taskId: 'task-a', view: 'requirements', ...(cursor ? { cursor } : {}) },
        ctx,
      )) as {
        entries: { messageId: string; text: string; textOffset: number }[];
        nextCursor: string | null;
      };
      assert.ok(Array.isArray(page.entries));
      assert.ok(JSON.stringify(page).length < 14000, 'one bounded page, not the full task context');
      for (const entry of page.entries) {
        assert.ok([assignment.id, changed.id].includes(entry.messageId));
        assert.equal(entry.text.includes('OTHER_TASK_SECRET_'), false);
        assert.equal(entry.text.includes('Prepared'), false);
        const pieces = projected.get(entry.messageId) ?? [];
        pieces.push([entry.textOffset, entry.text]);
        projected.set(entry.messageId, pieces);
      }
      if (!page.entries.length && page.nextCursor) empty = true;
      cursor = page.nextCursor ?? undefined;
      if (count++ === 0) {
        await store.appendMessage(
          coordination,
          correction(assignment, 'after-first-page', 'LATER_INPUT_MUST_NOT_ENTER_SNAPSHOT'),
        );
        await store.close?.();
        store = createSessionStore(root);
      }
      assert.ok(count < 35, 'paging must make progress');
    } while (cursor);
    for (const [messageId, expected] of [
      [assignment.id, original],
      [changed.id, raw],
    ]) {
      const pieces = projected.get(messageId);
      assert.ok(pieces);
      assert.equal(
        pieces
          .sort((a, b) => a[0] - b[0])
          .map((row) => row[1])
          .join(''),
        expected,
      );
    }
    assert.ok(empty, 'unrelated pages do not become fabricated empty history');
    assert.ok(
      scans.every((request) => request.maxMessages === 64 && request.maxStoredBytes === 256 * 1024),
    );
  } finally {
    await store.close?.();
    const stat = await lstat(root);
    if (
      !root.startsWith(join(tmpdir(), 'wh-read-sqlite-')) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    )
      throw new Error('Refusing cleanup outside the exact temporary test directory');
    await rm(root, { recursive: true });
  }
});

test('WorkHubRead pages retained terminal bytes from the source SQLite Session without widening ordinary resource access', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wh-read-sqlite-terminal-'));
  const capability = await resolveStorageRoot({ path: join(base, 'root'), kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>> | undefined;
  let evidence: Awaited<ReturnType<typeof openToolResultArchiveEvidenceReader>> | undefined;
  try {
    stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    for (const sessionId of [coordination, 'worker', 'new-worker']) {
      await stores.sessionStore.createStableSession({
        sessionId,
        requestFingerprint: `sha256:${'a'.repeat(64)}`,
        input: {
          cwd: base,
          model: 'test',
          llmConnectionSlug: 'test',
          permissionMode: 'ask',
          ...(sessionId === coordination
            ? { role: 'workhub_coordination', toolProfile: 'workhub-coordination-v2' }
            : {}),
        },
      });
    }
    const original = source('task-a', 'Generate the retained terminal output');
    const current: WorkHubDelegationAssignedMessage = {
      ...source('fresh', 'Read the original output, without copying context'),
      targetSessionId: 'new-worker',
      work: { id: 'task-a', generationId: 'fresh', continuesActionId: 'task-a' },
    };
    await stores.sessionStore.appendMessages(coordination, [original, current]);
    await seedInvocation(stores.runtimeEventStore, {
      sessionId: 'worker',
      runId: 'worker-run',
      turnId: 'worker-turn',
      openedAt: 1,
    });
    const terminal = shapeTerminalResult({
      cwd: base,
      command: 'synthetic output; never executed',
      result: {
        stdout: 'BEGIN\n' + '中文😀\"\\\n'.repeat(4000) + 'END\n',
        stderr: 'ERROR_BEGIN\n' + 'error\n'.repeat(1000) + 'ERROR_END\n',
        exitCode: 1,
      },
    });
    const identity = {
      sessionId: 'worker',
      turnId: 'worker-turn',
      runId: 'worker-run',
      invocationId: 'worker-run',
      ts: 2,
      partial: false,
    };
    await stores.runtimeEventStore.appendRuntimeEvent('worker', 'worker-run', {
      ...identity,
      id: 'terminal-call-event',
      role: 'model',
      author: 'agent',
      content: { kind: 'function_call', id: 'terminal-call', name: 'Bash', args: {} },
    });
    await stores.runtimeEventStore.appendRuntimeEvent('worker', 'worker-run', {
      ...identity,
      id: 'retained-terminal',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'terminal-call',
        name: 'Bash',
        result: terminal,
        modelProjection: encodeDurableToolResultOutput(
          { type: 'json', value: JSON.parse(JSON.stringify(terminal)) },
          'worker',
        ),
      },
    });
    await stores.runtimeEventStore.appendRuntimeEvent('worker', 'worker-run', {
      ...identity,
      id: 'worker-completed',
      ts: 3,
      role: 'system',
      author: 'system',
      status: 'completed',
    });
    const reader = createSessionTranscriptReader({
      stores,
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const projected = await reader.readDurableRecords('worker', {
      direction: 'older',
      maxMessages: 10,
      maxStoredBytes: 256 * 1024,
    });
    assert.match(JSON.stringify(projected), /truncated\. Read/);
    evidence = await openToolResultArchiveEvidenceReader(owner.lease);
    const admission = new SessionAdmissionGate();
    const history = createWorkHubTaskHistoryReader({
      stores: stores.sessionStore,
      reader,
      admission,
      archiveEvidence: evidence,
      authorize: async (assignment, caller) =>
        caller.sessionId === 'new-worker' && assignment.work?.id === 'task-a' ? current : undefined,
      history: {
        readAssignmentState: async () => 'owned',
        readExecutions: async (actionId, delegationId) => ({
          actionId,
          delegationId,
          targetSessionId: 'worker',
          executions: [
            {
              sessionId: 'worker',
              turnId: 'worker-turn',
              runId: 'worker-run',
              status: 'completed',
              terminalEventId: 'worker-completed',
            },
          ],
          nextCursor: null,
        }),
      },
    });
    const unexpected = async () => {
      throw Error('Unexpected non-history read');
    };
    const tool = createWorkHubReadTool({
      sessions: stores.sessionStore,
      admission,
      authorize: async () => current,
      status: unexpected,
      result: unexpected,
      evidence: unexpected,
      catalog: unexpected,
      inspect: unexpected,
      history: (input, caller) =>
        history(
          { operation: 'read', view: 'task_history', ...input, kinds: [...(input.kinds ?? [])] },
          caller,
        ),
    });
    const records: Array<{ messageId: string; text: string; textOffset: number }> = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = (await tool.impl(
        {
          taskId: 'task-a',
          view: 'history',
          kinds: ['tool_result'],
          ...(cursor ? { cursor } : {}),
        },
        { ...ctx, sessionId: 'new-worker' },
      )) as {
        status: string;
        history: { records: typeof records };
        nextCursor: string | null;
      };
      assert.equal(page.status, 'ok');
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES + 2000);
      records.push(...page.history.records);
      cursor = page.nextCursor ?? undefined;
      assert.ok(++pages < 80, 'bounded pages must make progress');
    } while (cursor);
    assert.ok(pages > 1);
    let offset = 0;
    for (const record of records) {
      assert.equal(record.messageId, 'retained-terminal');
      assert.equal(record.textOffset, offset);
      offset += record.text.length;
    }
    const recovered = JSON.parse(records.map((record) => record.text).join(''));
    assert.deepEqual(recovered.output, terminal.output);
    assert.deepEqual(
      await createLedgerArchiveResourceReader(evidence)({
        storage: 'event',
        sessionId: 'new-worker',
        runtimeEventId: 'retained-terminal',
        maxBytes: 256 * 1024,
      }),
      { ok: false, reason: 'not_found' },
      'ordinary resource addresses still do not grant cross-Session access',
    );
    for (const sessionId of ['worker', 'new-worker'])
      assert.equal((await stores.sessionStore.readHeaderSnapshot(sessionId)).permissionMode, 'ask');
  } finally {
    evidence?.close();
    await stores?.sessionStore.close?.();
    await owner.close();
    const stat = await lstat(base);
    if (
      !base.startsWith(join(tmpdir(), 'wh-read-sqlite-terminal-')) ||
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    )
      throw Error('Refusing cleanup outside the exact temporary test directory');
    await rm(base, { recursive: true });
  }
});
