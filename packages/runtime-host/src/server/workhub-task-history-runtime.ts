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

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import { WORKHUB_EVIDENCE_MAX_ROUNDS } from '@maka/core/workhub-evidence';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import {
  WORKHUB_EXECUTION_PAGE_MAX_ITEMS,
  WORKHUB_TASK_TEXT_MAX_BYTES,
  type WorkHubTaskAssignment,
  type WorkHubTaskHistoryResult,
  type WorkHubTaskExecutionsResult,
} from '../protocol/workhub-tasks.js';
import type { TurnSnapshot } from '../protocol/turn.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import type { createWorkHubEvidenceRuntime } from './workhub-evidence-runtime.js';
import { readHostedExecutionMembership } from './hosted-execution-membership.js';
import { readCanonicalTurnSnapshot } from './canonical-turn-snapshot.js';
import type { HostedExecutionRef } from './hosted-execution-authority.js';
import { readWorkHubTaskInputContinuation } from './workhub-task-input-lineage.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const cursorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('assignments'),
      workId: id,
      before: z.number().int().nonnegative(),
      through: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('executions'),
      actionId: id,
      delegationId: id,
      next: z.object({ turnId: id, runId: id }).strict(),
      evidenceRounds: z.number().int().min(0).max(WORKHUB_EVIDENCE_MAX_ROUNDS),
    })
    .strict(),
]);
class HistoryCursorError extends Error {}
class HistoryUnavailableError extends Error {}

/** Read-only projections of existing work records and their admitted lineage. */
export function createWorkHubTaskHistoryRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  messages: HostMessageCoordinator;
  admission: SessionAdmissionGate;
  evidence?: Partial<
    Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'readEvidenceContinuation'>
  >;
  onError(error: unknown): void;
}) {
  const { stores, messages, admission } = options;
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  const encode = (cursor: z.infer<typeof cursorSchema>) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  };
  function decode(cursor: string | undefined) {
    if (!cursor) return undefined;
    try {
      const [payload, signature, extra] = cursor.split('.');
      if (!payload || !signature || extra) throw new Error('Invalid cursor');
      const supplied = Buffer.from(signature, 'base64url'),
        expected = sign(payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new Error('Invalid signature');
      return cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    } catch {
      throw new HistoryCursorError(
        'Invalid or expired task history cursor; refresh without a cursor',
      );
    }
  }
  async function projectAssignment(
    a: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
  ): Promise<WorkHubTaskAssignment> {
    const base = {
      workId: a.work?.id ?? a.actionId,
      generationId: a.work?.generationId ?? a.actionId,
      actionId: a.actionId,
      delegationId: a.delegationId,
      targetSessionId: a.targetSessionId,
      targetMessageId: a.targetMessageId,
      targetSessionName: truncateUtf8(a.targetSessionName, 512, '…'),
      createdAt: a.ts,
      text: truncateUtf8(a.delegationText ?? a.userText, WORKHUB_TASK_TEXT_MAX_BYTES, '…'),
      superseded: !!(await stores.sessionStore.readWorkHubSupersession(a.delegationId)),
    };
    try {
      const h = await stores.sessionStore.readHeaderSnapshot(a.targetSessionId);
      if (
        h.isArchived ||
        h.subagentParent ||
        h.role !== undefined ||
        h.labels.includes('mode:side_conversation') ||
        h.id === WORKHUB_COORDINATION_SESSION_ID
      )
        return { ...base, state: 'unavailable' };
      const disposition = await messages.readMessageExecutionDispositionAdmitted(
        a.targetSessionId,
        a.targetMessageId,
        lease,
      );
      return {
        ...base,
        targetSessionName: truncateUtf8(h.name || base.targetSessionName, 512, '…'),
        state:
          disposition.kind === 'owned_root'
            ? 'owned'
            : disposition.kind === 'shared_turn'
              ? 'shared'
              : disposition.kind === 'pending'
                ? 'queued'
                : disposition.kind === 'cancelled'
                  ? 'cancelled'
                  : 'unavailable',
        ...(disposition.kind === 'owned_root'
          ? { execution: { turnId: disposition.turnId, runId: disposition.runId } }
          : {}),
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return { ...base, state: 'unavailable' };
      throw error;
    }
  }
  async function readHistory(
    workId: string,
    token?: string,
    actionId?: string,
  ): Promise<WorkHubTaskHistoryResult> {
    if (actionId !== undefined) {
      if (token !== undefined)
        throw new HistoryCursorError('Exact assignment reads cannot use a history cursor');
      const assignment = await admission.run(WORKHUB_COORDINATION_SESSION_ID, async () => {
        const origin = await stores.sessionStore.readWorkHubAssignment(workId);
        if (!origin || (origin.work?.id ?? origin.actionId) !== workId)
          throw new HistoryUnavailableError('The original work is unavailable');
        const source =
          actionId === workId ? origin : await stores.sessionStore.readWorkHubAssignment(actionId);
        if (!source || (source.work?.id ?? source.actionId) !== workId)
          throw new HistoryUnavailableError('The selected assignment does not belong to this work');
        return source;
      });
      const projected = await admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
        (lease) => projectAssignment(assignment, lease),
      );
      return { workId, assignments: [projected], nextCursor: null };
    }
    const cursor = decode(token);
    if (cursor && (cursor.kind !== 'assignments' || cursor.workId !== workId))
      throw new HistoryCursorError('Task history cursor changed work');
    if (cursor?.kind === 'assignments' && cursor.before > cursor.through + 1)
      throw new HistoryCursorError('Invalid task history bounds');
    const page = await admission.run(WORKHUB_COORDINATION_SESSION_ID, async () => {
      const origin = await stores.sessionStore.readWorkHubAssignment(workId);
      if (!origin || (origin.work?.id ?? origin.actionId) !== workId)
        throw new HistoryUnavailableError('The original work is unavailable');
      return stores.sessionStore.readWorkHubAssignmentsPage({
        beforeSequence: cursor?.kind === 'assignments' ? cursor.before : Number.MAX_SAFE_INTEGER,
        maxMessages: 64,
        maxStoredBytes: 256 * 1024,
      });
    });
    const through = cursor?.kind === 'assignments' ? cursor.through : page.highWaterSequence;
    if (through === null || !page.records.length)
      return { workId, assignments: [], nextCursor: null };
    const assignments: WorkHubTaskAssignment[] = [];
    let before = 0;
    for (const row of page.records) {
      before = row.sequence;
      const a = row.message;
      if (
        row.sequence > through ||
        a.type !== 'workhub_coordination' ||
        a.kind !== 'delegation_assigned' ||
        (a.work?.id ?? a.actionId) !== workId
      )
        continue;
      assignments.push(
        await admission.runMany([WORKHUB_COORDINATION_SESSION_ID, a.targetSessionId], (lease) =>
          projectAssignment(a, lease),
        ),
      );
      if (assignments.length === 8) break;
    }
    return {
      workId,
      assignments,
      nextCursor: before > 0 ? encode({ kind: 'assignments', workId, before, through }) : null,
    };
  }
  async function readExecutions(
    actionId: string,
    delegationId: string,
    token?: string,
  ): Promise<WorkHubTaskExecutionsResult> {
    const cursor = decode(token);
    if (
      cursor &&
      (cursor.kind !== 'executions' ||
        cursor.actionId !== actionId ||
        cursor.delegationId !== delegationId)
    )
      throw new HistoryCursorError('Execution cursor changed assignment');
    const a = await stores.sessionStore.readWorkHubAssignment(actionId);
    if (!a || a.delegationId !== delegationId)
      throw new HistoryUnavailableError('The original assignment is unavailable');
    return admission.runMany(
      [WORKHUB_COORDINATION_SESSION_ID, a.targetSessionId],
      async (lease) => {
        const assignment = await projectAssignment(a, lease);
        if (assignment.state !== 'owned' || !assignment.execution)
          throw new HistoryUnavailableError('This message has no exclusively owned execution');
        let current: typeof assignment.execution | undefined =
          cursor?.kind === 'executions' ? cursor.next : assignment.execution;
        let evidenceRounds = cursor?.kind === 'executions' ? cursor.evidenceRounds : 0;
        const executions: TurnSnapshot[] = [],
          seen = new Set<string>();
        while (current && executions.length < WORKHUB_EXECUTION_PAGE_MAX_ITEMS) {
          if (seen.has(current.turnId)) throw new Error('Task execution lineage contains a cycle');
          seen.add(current.turnId);
          const root = await stores.agentRunStore.readRootTurnAdmission(
            a.targetSessionId,
            current.turnId,
          );
          if (!root || root.runId !== current.runId)
            throw new HistoryUnavailableError('The admitted execution is unavailable');
          const ref: HostedExecutionRef = { sessionId: a.targetSessionId, ...current };
          const logical = await readHostedExecutionMembership(stores.runtimeEventStore, ref);
          executions.push(
            await readCanonicalTurnSnapshot(stores, ref, logical?.root, { mode: 'summary' }),
          );
          const next = await stores.agentRunStore.readRootTurnContinuationAdmission(
            a.targetSessionId,
            current.turnId,
            logical?.tip.runId ?? current.runId,
          );
          if (next) {
            if (
              next.execution.kind !== 'safe_boundary_continuation' ||
              next.execution.sourceTurnId !== current.turnId ||
              next.execution.sourceRunId !== (logical?.tip.runId ?? current.runId)
            )
              throw new Error('Task continuation changed source');
            current = { turnId: next.turnId, runId: next.runId };
          } else {
            const input = await readWorkHubTaskInputContinuation(stores, a, ref);
            const evidence: { readonly next?: HostedExecutionRef } | undefined = input
              ? undefined
              : await options.evidence?.readEvidenceContinuation?.(a, ref);
            if (evidence?.next && ++evidenceRounds > WORKHUB_EVIDENCE_MAX_ROUNDS)
              throw new Error('Task evidence lineage exceeds its bound');
            current = input
              ? { turnId: input.turnId, runId: input.runId }
              : evidence?.next
                ? { turnId: evidence.next.turnId, runId: evidence.next.runId }
                : undefined;
          }
        }
        return {
          actionId,
          delegationId,
          targetSessionId: a.targetSessionId,
          executions,
          nextCursor: current
            ? encode({ kind: 'executions', actionId, delegationId, next: current, evidenceRounds })
            : null,
        };
      },
    );
  }
  async function query<T>(read: () => Promise<T>) {
    try {
      return { ok: true as const, result: await read() };
    } catch (error) {
      if (error instanceof HistoryCursorError)
        return {
          ok: false as const,
          error: { code: 'operation_conflict' as const, message: error.message },
        };
      if (error instanceof HistoryUnavailableError || isSessionNotFoundError(error))
        return {
          ok: false as const,
          error: {
            code: 'not_found' as const,
            message: 'The original task execution is unavailable',
          },
        };
      options.onError(error);
      return {
        ok: false as const,
        error: { code: 'persistence_failed' as const, message: 'Task history could not be read' },
      };
    }
  }
  return {
    handlers: {
      'workhub.tasks.history': (input) =>
        query(() => readHistory(input.workId, input.cursor, input.actionId)),
      'workhub.tasks.executions': (input) =>
        query(() => readExecutions(input.actionId, input.delegationId, input.cursor)),
    } satisfies Pick<OperationHandlerMap, 'workhub.tasks.history' | 'workhub.tasks.executions'>,
  };
}
