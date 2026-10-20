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

// Real executor event adapter, durable SQLite ledger, transcript projection and
// task reader. Caller/owned-execution identity is injected; no provider is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  decodeCanonicalMessage,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import { createSessionStore } from '@maka/storage/session-store';
import { createWorkspaceRuntimeStore } from '@maka/storage/runtime-event-persistence';
import { Context } from '@maka/runtime/plugin-kernel';
import { PluginExecutorBackend } from '@maka/runtime/plugin-executor-backend';
import { PluginExecutorService } from '@maka/runtime/plugin-executor-service';
import { seedInvocation } from '@maka/runtime/test-only/invocation-fixture';
import {
  createSessionEventMapMemory,
  mapSessionEventToRuntimeEvent,
} from '@maka/runtime/session-event-runtime-mapper';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import { createSessionTranscriptReader } from '../server/session-transcript-reader.js';
import { createWorkHubTaskHistoryReader } from '../server/workhub-task-history-reader.js';
import { createWorkHubReadTool } from '../server/workhub-read-tool.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const suffix = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 48);
function assignment(
  actionId: string,
  taskId: string,
  targetSessionId: string,
): WorkHubDelegationAssignedMessage {
  return {
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    schemaVersion: 4,
    id: 'wha_' + suffix(actionId),
    actionId,
    turnId: 'coord-' + actionId,
    coordinationTurnId: 'coord-' + actionId,
    actionFingerprint: `sha256:${'a'.repeat(64)}`,
    ts: 1,
    disposition: 'delegate_existing',
    delegationId: 'whd_' + suffix(actionId),
    targetMessageId: 'whm_' + suffix(actionId),
    targetSessionId,
    targetSessionName: 'Executor',
    targetTurnId: 'turn-' + actionId,
    userText: actionId === taskId ? '用户原始要求：编号作为字符串。' : '继续检查。',
    inputOrigin: 'user',
    returnResults: true,
    work: {
      id: taskId,
      generationId: actionId,
      ...(actionId !== taskId ? { continuesActionId: taskId } : {}),
    },
  };
}

test('executor-origin task history pages original requirements and recorded tools through the real ledger without importing provider history', async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-executor-task-history-'));
  // Keep the test's DB and lock files in this temp root. Production root-owner
  // authentication is covered by its owning tests, not replaced by this seam.
  const stores = {
    sessionStore: createSessionStore(base),
    runtimeEventStore: createWorkspaceRuntimeStore(base),
  };
  const kernel = new Context();
  const service = new PluginExecutorService(kernel);
  let backend: PluginExecutorBackend | undefined;
  try {
    for (const sessionId of [WORKHUB_COORDINATION_SESSION_ID, 'old-executor', 'new-executor']) {
      await stores.sessionStore.createStableSession({
        sessionId,
        requestFingerprint: `sha256:${'a'.repeat(64)}`,
        input: {
          cwd: base,
          model: 'fixture',
          llmConnectionSlug: 'executor:fixture',
          permissionMode: 'ask',
          ...(sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? {
                role: 'workhub_coordination' as const,
                toolProfile: 'workhub-coordination-v2' as const,
              }
            : { executorId: 'fixture' }),
        },
      });
    }
    const original = assignment('task', 'task', 'old-executor');
    const foreign = assignment('foreign', 'foreign', 'old-executor');
    const current = assignment('fresh', 'task', 'new-executor');
    const rawCorrection = '原始纠正：保留前导零，不要使用 Number。';
    const correction: WorkHubTaskInputMessage = {
      type: 'workhub_coordination',
      kind: 'task_input',
      schemaVersion: 1,
      id: 'whti_' + suffix('correction'),
      inputId: 'correction',
      ts: 2,
      turnId: original.coordinationTurnId,
      workId: 'task',
      generationId: 'task',
      sourceActionId: original.actionId,
      sourceDelegationId: original.delegationId,
      targetSessionId: original.targetSessionId,
      targetMessageId: 'correction-target',
      targetContentDigest: `sha256:${'b'.repeat(64)}`,
      mode: 'steering',
      execution: { turnId: original.targetTurnId, runId: 'run-task' },
      text: 'Prepared worker text',
      originalUserText: rawCorrection,
      inputOrigin: 'user',
      sourceMessageId: 'source-correction',
    };
    for (const fact of [original, correction, foreign, current])
      assert.doesNotThrow(() => decodeCanonicalMessage(fact), `valid fixture ${fact.id}`);
    await stores.sessionStore.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
      original,
      correction,
      foreign,
      current,
    ]);
    const originalToolArgs = { command: 'printf "%s" "001234"', cwd: base };
    // Within the executor's existing 8192-character event contract; escaped
    // UTF-8 still exceeds one task-history response page.
    const originalOutput = '001234\n' + 'visible tool output 😀\\\n'.repeat(280);
    kernel
      .extend({
        maka: { rootId: 'profile', packageId: 'fixture', entryId: 'executor', generation: 1 },
      })
      .executors.register({
        id: 'fixture',
        capabilities: { toolActivity: true },
        async execute(request, context) {
          assert.equal(request.text, original.userText);
          context.emit({
            type: 'tool_start',
            toolCallId: 'command',
            name: 'native.command',
            input: originalToolArgs,
          });
          context.emit({
            type: 'tool_result',
            toolCallId: 'command',
            content: { kind: 'text', text: originalOutput },
          });
          return {
            status: 'completed',
            text: 'Worker finished; this reply is not a substitute for user or tool records.',
          };
        },
      });
    backend = new PluginExecutorBackend({
      sessionId: 'old-executor',
      cwd: base,
      binding: service.bind('old-executor', 'fixture'),
    });
    for (const action of [original, foreign]) {
      const runId = 'run-' + action.actionId;
      const identity = await seedInvocation(stores.runtimeEventStore, {
        sessionId: action.targetSessionId,
        turnId: action.targetTurnId,
        runId,
        opening: {
          route: {
            provenance: 'runtime',
            backendKind: 'plugin-executor',
            executorId: 'fixture',
            modelId: 'fixture',
            llmConnectionSlug: 'executor:fixture',
            providerStateIdentity: `sha256:${'a'.repeat(64)}`,
          },
        },
      });
      await stores.runtimeEventStore.appendRuntimeEvent(action.targetSessionId, runId, {
        ...identity,
        id: 'user-event-' + action.actionId,
        ts: 2,
        partial: false,
        role: 'user',
        author: 'user',
        content: {
          kind: 'text',
          text: action === original ? original.userText : 'FOREIGN_EXECUTOR_USER_SECRET',
        },
        refs: { storedMessageId: action.targetMessageId },
      });
      if (action === original) {
        const memory = createSessionEventMapMemory();
        for await (const event of backend.send({
          text: original.userText,
          turnId: original.targetTurnId,
          runId,
        })) {
          assert.notEqual(
            event.type,
            'error',
            event.type === 'error' ? event.message : 'executor event',
          );
          await stores.runtimeEventStore.appendRuntimeEvent(
            'old-executor',
            runId,
            mapSessionEventToRuntimeEvent(event, identity, memory),
          );
        }
      } else {
        await stores.runtimeEventStore.appendRuntimeEvent(action.targetSessionId, runId, {
          ...identity,
          id: 'foreign-reply',
          ts: 3,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'FOREIGN_EXECUTOR_ASSISTANT_SECRET' },
          refs: { providerEventId: 'foreign-message' },
        });
      }
    }
    const admission = new SessionAdmissionGate();
    const reader = createSessionTranscriptReader({
      stores: stores as unknown as Parameters<typeof createSessionTranscriptReader>[0]['stores'],
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const readHistory = createWorkHubTaskHistoryReader({
      stores: stores.sessionStore,
      reader,
      admission,
      authorize: async (source, ctx) =>
        ctx.sessionId === current.targetSessionId && (source.work?.id ?? source.actionId) === 'task'
          ? current
          : undefined,
      history: {
        readAssignmentState: async () => 'owned',
        readExecutions: async (actionId, delegationId) => ({
          actionId,
          delegationId,
          targetSessionId: 'old-executor',
          executions: [
            {
              sessionId: 'old-executor',
              turnId: 'turn-' + actionId,
              runId: 'run-' + actionId,
              status: 'completed',
              terminalEventId: 'terminal-' + actionId,
            },
          ],
          nextCursor: null,
        }),
      },
    });
    const unexpected = async () => {
      throw new Error('Unexpected non-history read');
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
      history: (input, ctx) =>
        readHistory(
          {
            operation: 'read',
            view: 'task_history',
            ...input,
            kinds: input.kinds && [...input.kinds],
          },
          ctx,
        ),
    });
    const ctx = {
      sessionId: current.targetSessionId,
      turnId: 'turn-fresh',
      runId: 'run-fresh',
      invocationId: 'invocation-fresh',
      toolCallId: 'read-call',
      cwd: base,
      emitOutput() {},
      abortSignal: new AbortController().signal,
    } as MakaToolContext;
    const records: Array<Record<string, unknown>> = [];
    let cursor: string | undefined;
    let count = 0;
    do {
      const page = (await tool.impl(
        { taskId: 'task', view: 'history', ...(cursor ? { cursor } : {}) },
        ctx,
      )) as {
        status: string;
        history: { records: Array<Record<string, unknown>> };
        nextCursor: string | null;
      };
      assert.equal(page.status, 'ok');
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= READ_PAGE_MAX_BYTES + 2_000);
      records.push(...page.history.records);
      cursor = page.nextCursor ?? undefined;
      assert.ok(++count < 30, 'native paging makes progress');
    } while (cursor);
    assert.ok(count > 1, 'actual escaped executor output requires paging');
    const all = JSON.stringify(records);
    assert.match(all, /用户原始要求：编号作为字符串/);
    assert.match(all, /原始纠正：保留前导零/);
    assert.doesNotMatch(all, /Prepared worker text|FOREIGN_EXECUTOR_/);
    const toolCall = records.find((record) => record.kind === 'tool_call');
    assert.ok(toolCall);
    assert.deepEqual(JSON.parse(toolCall.text as string), originalToolArgs);
    const outputParts = records
      .filter((record) => record.kind === 'tool_result')
      .sort((a, b) => (a.textOffset as number) - (b.textOffset as number));
    const output = JSON.parse(outputParts.map((record) => record.text).join(''));
    assert.equal(output.text, originalOutput);
    assert.equal(
      (await stores.sessionStore.readHeaderSnapshot('old-executor')).permissionMode,
      'ask',
    );
  } finally {
    await backend?.dispose();
    await kernel.fiber.dispose();
    await stores.sessionStore.close?.();
    stores.runtimeEventStore.close();
    await rm(base, { recursive: true, force: true });
  }
});
