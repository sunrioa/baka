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
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import { createWorkHubTaskHistoryRuntime } from '../server/workhub-task-history-runtime.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';

test('task history pages sparse canonical assignments with bounded reads and preserves superseded generations', async () => {
  const f = fixture();
  const read = (cursor?: string) =>
    f.runtime.handlers['workhub.tasks.history']({ workId: 'work', ...(cursor ? { cursor } : {}) });
  const actions: string[] = [];
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  do {
    const result = await read(cursor);
    assert.ok(result.ok, JSON.stringify(result));
    assert.ok(result.result.assignments.length <= 8);
    for (const item of result.result.assignments) {
      assert.equal(item.workId, 'work');
      actions.push(item.actionId);
    }
    cursor = result.result.nextCursor ?? undefined;
    firstCursor ??= cursor;
  } while (cursor);
  assert.deepEqual(
    actions,
    f.rows.filter((row) => row.message.work?.id === 'work').map((row) => row.message.actionId),
  );
  assert.equal(new Set(actions).size, actions.length);
  assert.ok(f.reads.length > 1);
  assert.ok(
    f.reads.every((input) => input.maxMessages === 64 && input.maxStoredBytes === 256 * 1024),
  );
  assert.ok(firstCursor);
  for (const [runtime, input] of [
    [f.runtime, { workId: 'different', cursor: firstCursor }],
    [fixture().runtime, { workId: 'work', cursor: firstCursor }],
    [f.runtime, { workId: 'work', cursor: firstCursor.slice(0, -3) + 'bad' }],
  ] as const) {
    const result = await runtime.handlers['workhub.tasks.history'](input);
    assert.ok(!result.ok && result.error.code === 'operation_conflict', JSON.stringify(result));
  }
  const first = await read();
  assert.ok(first.ok);
  assert.ok(first.result.assignments.some((item) => item.superseded));
  const pageReads = f.reads.length;
  const exact = await f.runtime.handlers['workhub.tasks.history']({
    workId: 'work',
    actionId: 'action-10',
  });
  assert.ok(exact.ok, JSON.stringify(exact));
  assert.equal(exact.result.assignments[0]!.actionId, 'action-10');
  assert.equal(
    exact.result.assignments[0]!.superseded,
    true,
    'an old generation is read-only even without a correction record',
  );
  assert.equal(exact.result.assignments.length, 1);
  assert.equal(exact.result.nextCursor, null);
  assert.equal(
    f.reads.length,
    pageReads,
    'refreshing a selected assignment does not scan global pages',
  );
  const wrongWork = await f.runtime.handlers['workhub.tasks.history']({
    workId: 'work',
    actionId: 'action-11',
  });
  assert.ok(!wrongWork.ok && wrongWork.error.code === 'not_found');
});

test('task history never exposes an exclusive execution for queued, shared, cancelled or unavailable messages', async () => {
  const f = fixture();
  for (const kind of ['pending', 'shared_turn', 'cancelled', 'unowned'] as const) {
    f.setDisposition(kind);
    const result = await f.runtime.handlers['workhub.tasks.executions']({
      actionId: 'work',
      delegationId: 'delegation-work',
    });
    assert.ok(!result.ok && result.error.code === 'not_found', JSON.stringify(result));
  }
  f.setArchived();
  const result = await f.runtime.handlers['workhub.tasks.history']({ workId: 'work' });
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(
    result.result.assignments.every(
      (item) => item.state === 'unavailable' && item.execution === undefined,
    ),
  );
});

function fixture() {
  type Options = Parameters<typeof createWorkHubTaskHistoryRuntime>[0];
  const admission = new SessionAdmissionGate();
  let kind: 'pending' | 'shared_turn' | 'cancelled' | 'unowned' = 'pending';
  let archived = false;
  const message = (sequence: number): WorkHubDelegationAssignedMessage => ({
    type: 'workhub_coordination',
    kind: 'delegation_assigned',
    id: `row-${sequence}`,
    turnId: `coord-${sequence}`,
    coordinationTurnId: `coord-${sequence}`,
    schemaVersion: 4,
    ts: sequence,
    actionId: sequence === 0 ? 'work' : `action-${sequence}`,
    delegationId: sequence === 0 ? 'delegation-work' : `delegation-${sequence}`,
    actionFingerprint: `sha256:${'0'.repeat(64)}`,
    disposition: 'delegate_existing',
    userText: 'Same topic',
    targetSessionId: 'target',
    targetSessionName: 'Task',
    targetMessageId: `message-${sequence}`,
    targetTurnId: `target-${sequence}`,
    work: {
      id: sequence % 10 === 0 ? 'work' : `other-${sequence}`,
      generationId: sequence < 100 ? 'original' : 'replacement',
    },
  });
  const rows = Array.from({ length: 181 }, (_, sequence) => ({
    sequence,
    message: message(sequence),
  })).reverse();
  const reads: Array<{ beforeSequence: number; maxMessages: number; maxStoredBytes: number }> = [];
  const runtime = createWorkHubTaskHistoryRuntime({
    admission,
    stores: {
      sessionStore: {
        readWorkHubAssignment: async (id: string) =>
          rows.find((row) => row.message.actionId === id)?.message,
        readLatestWorkHubAssignment: async (id: string) =>
          rows.find((row) => (row.message.work?.id ?? row.message.actionId) === id)?.message,
        readWorkHubAssignmentsPage: async (input: (typeof reads)[number]) => {
          reads.push(input);
          return {
            highWaterSequence: 180,
            records: rows
              .filter((row) => row.sequence < input.beforeSequence)
              .slice(0, input.maxMessages),
          };
        },
        readWorkHubSupersession: async (id: string) => (id === 'delegation-180' ? {} : undefined),
        readHeaderSnapshot: async () => ({
          id: 'target',
          labels: [],
          name: 'Task',
          isArchived: archived,
        }),
      },
      runtimeEventStore: {
        readRunInvocation: async () => {
          throw new Error('A history read must not read an unrelated Run');
        },
      },
    } as unknown as Options['stores'],
    messages: {
      readMessageExecutionDispositionAdmitted: (
        id: string,
        _message: string,
        lease: SessionAdmissionLease,
      ) => admission.runAdmitted(id, lease, async () => ({ kind })),
    } as unknown as Options['messages'],
    onError: (reason) => {
      throw reason;
    },
  });
  return {
    rows,
    reads,
    runtime,
    setDisposition(value: typeof kind) {
      kind = value;
    },
    setArchived() {
      archived = true;
    },
  };
}
