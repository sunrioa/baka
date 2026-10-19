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
import { test } from 'node:test';
import { normalizeMessageContent } from '@maka/core/events';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type { WorkHubTaskInputMessage } from '@maka/core/workhub-task-input';
import type { RootTurnAdmission } from '@maka/storage/agent-run-store';
import { readCurrentWorkHubTaskSource } from '../server/workhub-task-source.js';

type Options = Parameters<typeof readCurrentWorkHubTaskSource>[0];
const active = { sessionId: 'target', turnId: 'active-turn', runId: 'resumed-run' };
const original = { ...active, runId: 'original-run' };
const assignment = (id: string, generation = 'first', workId = 'work') =>
  ({
    actionId: id,
    delegationId: `delegation-${id}`,
    targetMessageId: `message-${id}`,
    targetSessionId: 'target',
    work: { id: workId, generationId: generation },
  }) as WorkHubDelegationAssignedMessage;

function fixture() {
  const first = assignment('first');
  const running = assignment('running');
  const latest = assignment('withdrawn');
  const f = {
    first,
    running,
    latest,
    active: true,
    bound: running as WorkHubDelegationAssignedMessage | undefined,
    members: 1,
    input: undefined as WorkHubTaskInputMessage | undefined,
    proofMatches: true,
  };
  const options: Options = {
    stores: {
      sessionStore: {
        readLatestWorkHubAssignment: async () => f.latest,
        readWorkHubAssignment: async (id) =>
          [f.first, f.running, f.latest].find((a) => a.actionId === id),
        readWorkHubAssignmentByMessage: async () => f.bound,
        readWorkHubTaskInputByMessage: async () => f.input,
      },
      agentRunStore: {
        readRootTurnAdmission: async () =>
          ({
            schemaVersion: 1,
            userMessageId: null,
            execution: { kind: 'external_message' },
            previousRootTurnId: null,
            normalizedInput: null,
            admittedAt: 1,
            sessionId: 'target',
            turnId: active.turnId,
            runId: original.runId,
            sourceMessages: Array.from({ length: f.members }, (_, n) => ({
              messageId: `message-${n}`,
              content: normalizeMessageContent({ text: 'Original' }),
              placement: 'current_turn',
              disposition: 'turn_started',
            })),
          }) satisfies RootTurnAdmission,
      },
    },
    messages: {
      readMessageExecutionDisposition: async (_sessionId, messageId) =>
        messageId === f.running.targetMessageId
          ? { kind: 'owned_root', ...original }
          : { kind: 'cancelled' },
    },
    executions: {
      readRootState: () => (f.active ? { kind: 'active', ...active } : { kind: 'idle' }),
      readLatestRootTurnLineage: async () => (f.proofMatches ? active : original),
    },
    evidence: {
      taskExecution: async () => ({ ...(f.proofMatches ? active : original), round: 0 }),
    },
  };
  return { f, options };
}

test('task source resolves the actually running Message rather than a later withdrawn same-task input, including resumed Runs', async () => {
  const { f, options } = fixture();
  assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.running);
  f.active = false;
  assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.latest);
  assert.equal(await readCurrentWorkHubTaskSource(options, 'other'), undefined);
});

test('task source never substitutes a foreign generation, task, shared batch or unproven lineage', async () => {
  for (const change of ['task', 'generation', 'batch', 'lineage'] as const) {
    const { f, options } = fixture();
    if (change === 'task') f.bound = assignment('running', 'first', 'other');
    if (change === 'generation') f.bound = assignment('running', 'old');
    if (change === 'batch') f.members = 2;
    if (change === 'lineage') f.proofMatches = false;
    assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.latest, change);
  }
});

test('task source resolves accepted native-input Message provenance only within the current generation', async () => {
  const { f, options } = fixture();
  f.bound = undefined;
  f.input = {
    workId: 'work',
    generationId: 'first',
    sourceActionId: 'running',
    sourceDelegationId: 'delegation-running',
  } as WorkHubTaskInputMessage;
  assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.running);
  f.input = { ...f.input, sourceDelegationId: 'other' };
  assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.latest);
  f.input = { ...f.input, sourceDelegationId: 'delegation-running', generationId: 'old' };
  assert.equal(await readCurrentWorkHubTaskSource(options, 'work'), f.latest);
});
