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

import { z } from 'zod';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { readLogicalRuntimeExecutionForRun } from '@maka/core/runtime-logical-execution';
import { readWorkHubStopProjection } from './workhub-stop-projection.js';
import {
  WORKHUB_INBOX_MAX_ITEMS,
  type WorkHubPendingInteraction,
} from '../protocol/workhub-interactions.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { MakaToolContext, ToolExecutionScope } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import { projectSessionInteractions } from './interaction-projection.js';
import {
  HostWorkHubResultCoordinator,
  type WorkHubResultObservation,
} from './workhub-result-coordinator.js';
import type { createWorkHubEvidenceRuntime } from './workhub-evidence-runtime.js';
import { createWorkHubTaskHistoryRuntime } from './workhub-task-history-runtime.js';
import { readCurrentWorkHubTaskSource } from './workhub-task-source.js';
import { readHostedExecutionMembership } from './hosted-execution-membership.js';
import {
  WORKHUB_TASK_MAX_ITEMS,
  WORKHUB_TASK_TEXT_MAX_BYTES,
  WORKHUB_DELIVERY_MAX_BYTES,
  type WorkHubTask,
  type WorkHubTaskDetail,
} from '../protocol/workhub-tasks.js';

const resultReadParameters = z
  .object({ actionId: z.string().min(1), offset: z.number().int().nonnegative().default(0) })
  .strict();

export type WorkHubResultRead =
  | { readonly status: 'pending'; readonly targetSessionId: string; readonly message: string }
  | { readonly status: 'obsolete'; readonly targetSessionId: string }
  | (WorkHubResultObservation & {
      readonly targetSessionId: string;
      readonly nextOffset: number | null;
    });

/** Read-only task ancestry; interaction visibility grants no additional execution authority. */
export function createWorkHubInteractionOwnership(input: {
  stores: ExecutionStoresWriter<'interactive'>;
  executions: Pick<RootTurnCoordinator, 'readLatestRootTurnLineage'>;
}) {
  return async function belongsToRoot(
    scope: ToolExecutionScope,
    root: { sessionId: string; turnId: string; runId: string },
  ): Promise<boolean> {
    if (!scope.runId) return false;
    let current = { sessionId: scope.sessionId, turnId: scope.turnId, runId: scope.runId };
    const seen = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      const key = JSON.stringify(current);
      if (seen.has(key)) return false;
      seen.add(key);
      const invocation = await input.stores.runtimeEventStore.readRunInvocation(
        current.sessionId,
        current.runId,
      );
      if (
        !invocation ||
        invocation.turnId !== current.turnId ||
        (depth === 0 &&
          scope.invocationId !== undefined &&
          invocation.invocationId !== scope.invocationId)
      )
        return false;
      const logical = await readLogicalRuntimeExecutionForRun(
        input.stores.runtimeEventStore,
        current,
      );
      if (!logical || logical.tip.terminalEvent) return false;
      if (current.sessionId === root.sessionId) {
        const latest = await input.executions.readLatestRootTurnLineage(root);
        const rootLogical = await readLogicalRuntimeExecutionForRun(
          input.stores.runtimeEventStore,
          latest,
        );
        return rootLogical?.runIds.includes(current.runId) === true;
      }
      const header = await input.stores.sessionStore.readHeaderSnapshot(current.sessionId);
      const spawned = header.subagentParent,
        spawn = header.subagentSpawn;
      if (spawned?.kind !== 'subagent' || !spawn) return false;
      if (spawned.graph) {
        const admission = await input.stores.agentRunStore.readRootTurnAdmission(
          current.sessionId,
          logical.root.turnId,
        );
        const execution = admission?.execution;
        if (
          admission?.runId !== logical.root.runId ||
          execution?.kind !== 'claimed_agent_graph_intent' ||
          execution.claim.graphId !== spawned.graph.graphId ||
          execution.claim.targetOperatorId !== spawned.graph.operatorId ||
          execution.claim.targetSessionId !== current.sessionId ||
          execution.claim.targetTurnId !== logical.root.turnId ||
          execution.claim.targetRunId !== logical.root.runId
        )
          return false;
      } else {
        const initial = await input.stores.agentRunStore.readRootTurnAdmission(
          current.sessionId,
          spawn.initialTurnId,
        );
        if (
          initial?.runId !== spawn.initialRunId ||
          initial.execution.kind !== 'linked_child_initial'
        )
          return false;
        const latest = await input.executions.readLatestRootTurnLineage({
          sessionId: current.sessionId,
          turnId: spawn.initialTurnId,
          runId: spawn.initialRunId,
        });
        const childLogical = await readLogicalRuntimeExecutionForRun(
          input.stores.runtimeEventStore,
          latest,
        );
        if (!childLogical?.runIds.includes(current.runId)) return false;
      }
      current = {
        sessionId: spawned.parentSessionId,
        turnId: spawned.spawnedBy.parentTurnId,
        runId: spawned.spawnedBy.parentRunId,
      };
    }
    return false;
  };
}

export function createWorkHubResultRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  executions: RootTurnCoordinator;
  messages: HostMessageCoordinator;
  interactions: HostInteractionCoordinator;
  evidence?: Pick<
    ReturnType<typeof createWorkHubEvidenceRuntime>,
    'taskExecution' | 'waitingObservation'
  > &
    Partial<Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'readEvidenceContinuation'>>;
  admission: SessionAdmissionGate;
  readTurnResult(sessionId: string, turnId: string): Promise<string>;
  readTurnInput(sessionId: string, turnId: string): Promise<string>;
  acquireResidency(): { release(): void };
  onError(error: unknown): void;
}) {
  const { stores, executions, messages, admission, readTurnResult } = options;
  const belongsToRoot = createWorkHubInteractionOwnership({ stores, executions });
  async function listAssignments() {
    const targets = (await stores.sessionStore.listHeaders())
      .filter((h) => h.id !== WORKHUB_COORDINATION_SESSION_ID && !h.isArchived)
      .map((h) => h.id);
    const result: WorkHubDelegationAssignedMessage[] = [];
    for (let i = 0; i < targets.length; i += 256)
      result.push(
        ...(await stores.sessionStore.readActiveWorkHubAssignmentsByTarget(
          targets.slice(i, i + 256),
        )),
      );
    return result.filter((a) => a.returnResults);
  }
  async function pending(sessionId: string) {
    return projectSessionInteractions(
      await stores.interactionStore.listSessionPending(sessionId),
      await stores.sessionStore.listPendingSandboxBoundaryRequests(sessionId),
    ).pending;
  }
  async function visible(
    assignment: WorkHubDelegationAssignedMessage,
    includeStopped: boolean,
    observedLatest?: WorkHubDelegationAssignedMessage,
  ) {
    if (!observedLatest)
      return (
        await stores.sessionStore.readActiveWorkHubAssignmentsByTarget(
          [assignment.targetSessionId],
          undefined,
          includeStopped,
        )
      ).some(
        (a) => a.actionId === assignment.actionId && a.delegationId === assignment.delegationId,
      );
    // Read-only discovery already located the canonical latest fact at its
    // watermark. Do not re-scan every task's target ledger to rediscover its
    // generation. Effect paths never pass this advisory observation.
    return (
      (observedLatest.work?.id ?? observedLatest.actionId) ===
        (assignment.work?.id ?? assignment.actionId) &&
      (observedLatest.work?.generationId ?? observedLatest.actionId) ===
        (assignment.work?.generationId ?? assignment.actionId) &&
      observedLatest.targetSessionId === assignment.targetSessionId &&
      !(await stores.sessionStore.readWorkHubSupersession(assignment.delegationId)) &&
      !(await stores.sessionStore.readWorkHubReplacementAbort(assignment.delegationId))
    );
  }
  async function isActive(
    assignment: WorkHubDelegationAssignedMessage,
    observedLatest?: WorkHubDelegationAssignedMessage,
  ): Promise<boolean> {
    try {
      const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
      if (header.isArchived) return false;
      if (!assignment.returnResults || !(await visible(assignment, false, observedLatest)))
        return false;
      // Retirement intent takes precedence even before its final receipt exists.
      if (await stores.sessionStore.readWorkHubReplacement(assignment.delegationId)) return false;
      if ((await readWorkHubStopProjection(stores.sessionStore, assignment.delegationId))?.retires)
        return false;
      return true;
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    }
  }
  async function inspectLocked(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
    includeResult = true,
  ): Promise<WorkHubResultObservation | undefined> {
    try {
      // The lightweight sweep receives active assignments from listAssignments.
      // Delivery and tool reads still revalidate under both Session admissions.
      if (includeResult && !(await isActive(assignment))) return undefined;
      const disposition = await messages.readMessageExecutionDispositionAdmitted(
        assignment.targetSessionId,
        assignment.targetMessageId,
        lease,
      );
      if (disposition.kind === 'cancelled') {
        return {
          turnId: assignment.targetTurnId,
          runId: `message:${assignment.targetMessageId}`,
          eventKey: 'message_cancelled_before_execution',
          status: 'cancelled',
          result: 'The delegated message was cancelled before execution.',
          details: { abortSource: 'message_cancelled_before_execution' },
          sharedTurn: false,
        };
      }
      if (disposition.kind !== 'owned_root' && disposition.kind !== 'shared_turn') return undefined;
      const original = {
        sessionId: assignment.targetSessionId,
        turnId: disposition.turnId,
        runId: disposition.runId,
      };
      const identity =
        options.evidence && disposition.kind === 'owned_root'
          ? await options.evidence.taskExecution(assignment, original)
          : await executions.readLatestRootTurnLineage(original);
      const waiting = await options.evidence?.waitingObservation(assignment, identity);
      if (waiting) return waiting;
      const snapshot = await executions.read(identity);
      const sharedTurn = disposition.kind === 'shared_turn';
      if (snapshot.status === 'waiting_for_user' || snapshot.status === 'running') {
        const requests = (await pending(assignment.targetSessionId)).filter(
          (p) => p.turnId === identity.turnId && p.runId === identity.runId,
        );
        if (!requests.length) return undefined;
        return {
          turnId: identity.turnId,
          runId: identity.runId,
          eventKey:
            'interaction:' +
            requests
              .map((p) => p.interactionId)
              .sort()
              .join(','),
          status: 'waiting_for_user',
          result:
            'The task needs user input. Open its task view to answer the original request. Acknowledge the notification and continue other work; do not copy the question or answer approvals through the coordinator model.',
          details: requests.map((p) => ({ interactionId: p.interactionId, kind: p.request.kind })),
          sharedTurn,
        };
      }
      if (
        snapshot.status !== 'completed' &&
        snapshot.status !== 'failed' &&
        snapshot.status !== 'cancelled'
      )
        return undefined;
      const answer = includeResult
        ? await readTurnResult(assignment.targetSessionId, identity.turnId)
        : '';
      const latestUserInput =
        includeResult && !sharedTurn
          ? await options.readTurnInput(assignment.targetSessionId, identity.turnId)
          : undefined;
      return {
        turnId: identity.turnId,
        runId: identity.runId,
        eventKey: snapshot.terminalEventId,
        status: snapshot.status,
        result: answer,
        ...(latestUserInput &&
        latestUserInput !== (assignment.delegationText ?? assignment.userText)
          ? { latestUserInput }
          : {}),
        details:
          snapshot.status === 'failed'
            ? {
                failureClass: snapshot.failureClass ?? null,
                message: snapshot.failureMessage ?? null,
              }
            : snapshot.status === 'cancelled'
              ? { abortSource: snapshot.abortSource ?? null }
              : null,
        sharedTurn,
      };
    } catch (error) {
      if (isSessionNotFoundError(error)) return undefined;
      throw error;
    }
  }
  async function inspect(
    assignment: WorkHubDelegationAssignedMessage,
    lease?: SessionAdmissionLease,
    includeResult = true,
  ) {
    return lease
      ? inspectLocked(assignment, lease, includeResult)
      : admission.runMany([WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId], (lane) =>
          inspectLocked(assignment, lane, includeResult),
        );
  }
  async function assertResultReader(ctx: MakaToolContext): Promise<void> {
    ctx.abortSignal.throwIfAborted();
    if (ctx.sessionId !== WORKHUB_COORDINATION_SESSION_ID || !ctx.runId || !ctx.invocationId)
      throw new Error('WorkHub result access requires a current coordination invocation');
    const run = await stores.runtimeEventStore.readRunInvocation(ctx.sessionId, ctx.runId);
    if (
      !run ||
      run.sessionId !== ctx.sessionId ||
      run.runId !== ctx.runId ||
      run.turnId !== ctx.turnId ||
      run.invocationId !== ctx.invocationId ||
      run.opening.root.kind !== 'user' ||
      run.terminalEvent
    )
      throw new Error('WorkHub result reader is not the current root invocation');
    const root = await stores.agentRunStore.readRootTurnAdmission(ctx.sessionId, ctx.turnId);
    const current = executions.readRootState(ctx.sessionId);
    if (
      root?.execution.kind !== 'workhub_coordination' ||
      current.kind !== 'active' ||
      current.turnId !== root.turnId ||
      current.runId !== root.runId ||
      (await readHostedExecutionMembership(stores.runtimeEventStore, root))?.tip.runId !== ctx.runId
    )
      throw new Error('WorkHub result access requires coordination authority');
  }
  /** Full coordinator results, not task-card excerpts or worker evidence envelopes. */
  async function readResult(
    raw: { actionId: string; offset?: number },
    ctx: MakaToolContext,
  ): Promise<WorkHubResultRead> {
    const input = resultReadParameters.parse(raw);
    const assignment = await admission.run(WORKHUB_COORDINATION_SESSION_ID, async () => {
      await assertResultReader(ctx);
      return stores.sessionStore.readWorkHubAssignment(input.actionId);
    });
    if (!assignment?.returnResults) throw new Error('Unknown WorkHub result assignment');
    return admission.runMany(
      [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
      async (lease) => {
        await assertResultReader(ctx);
        const observation = await inspectLocked(assignment, lease);
        ctx.abortSignal.throwIfAborted();
        if (!observation) {
          const active = await isActive(assignment);
          ctx.abortSignal.throwIfAborted();
          return active
            ? {
                status: 'pending',
                targetSessionId: assignment.targetSessionId,
                message:
                  'No result is ready yet. The Host will automatically notify WorkHub when a result or user question is available. Acknowledge the delegation and end this response; do not poll tools to wait.',
              }
            : { status: 'obsolete', targetSessionId: assignment.targetSessionId };
        }
        const chars = Array.from(observation.result);
        if (input.offset > chars.length) throw new Error('WorkHub result offset is out of bounds');
        const end = input.offset + 16000;
        return {
          ...observation,
          targetSessionId: assignment.targetSessionId,
          result: chars.slice(input.offset, end).join(''),
          nextOffset: end < chars.length ? end : null,
        };
      },
    );
  }
  async function taskRequests(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
    lanes: readonly string[] = [],
    observedLatest?: WorkHubDelegationAssignedMessage,
  ) {
    if (!(await isActive(assignment, observedLatest))) return [];
    const disposition = await messages.readMessageExecutionDispositionAdmitted(
      assignment.targetSessionId,
      assignment.targetMessageId,
      lease,
    );
    // A historical shared Turn does not confer authority over manual work.
    if (disposition.kind !== 'owned_root') return [];
    const original = {
      sessionId: assignment.targetSessionId,
      turnId: disposition.turnId,
      runId: disposition.runId,
    };
    const identity = options.evidence
      ? await options.evidence.taskExecution(assignment, original)
      : await executions.readLatestRootTurnLineage(original);
    const snapshot = await executions.read(identity);
    if (snapshot.status !== 'waiting_for_user' && snapshot.status !== 'running') return [];
    const requests = (await pending(assignment.targetSessionId)).filter(
      (p) =>
        p.sessionId === identity.sessionId &&
        p.turnId === identity.turnId &&
        p.runId === identity.runId,
    );
    for (const header of await stores.sessionStore.listHeaders()) {
      if (!header.subagentParent || header.isArchived || !lanes.includes(header.id)) continue;
      for (const request of await pending(header.id)) {
        if (requests.length > WORKHUB_INBOX_MAX_ITEMS) break;
        if (
          await belongsToRoot(
            { sessionId: request.sessionId, turnId: request.turnId, runId: request.runId },
            identity,
          )
        )
          requests.push(request);
      }
    }
    return requests;
  }
  async function taskLanes(assignment: WorkHubDelegationAssignedMessage) {
    // Child Sessions are immutable links, not names supplied by the caller.
    const lanes = new Set([WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId]);
    const headers = await stores.sessionStore.listHeaders();
    for (let depth = 0; depth < 32; depth++) {
      const before = lanes.size;
      for (const h of headers)
        if (h.subagentParent && !h.isArchived && lanes.has(h.subagentParent.parentSessionId))
          lanes.add(h.id);
      if (lanes.size === before) break;
    }
    return [...lanes];
  }
  async function taskProjection(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
    detail = false,
    lanes: readonly string[] = [],
    observedLatest?: WorkHubDelegationAssignedMessage,
  ): Promise<WorkHubTaskDetail | undefined> {
    try {
      return await taskProjectionLocked(assignment, lease, detail, lanes, observedLatest);
    } catch (error) {
      if (isSessionNotFoundError(error)) return undefined;
      throw error;
    }
  }
  async function taskProjectionLocked(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
    detail: boolean,
    lanes: readonly string[],
    observedLatest?: WorkHubDelegationAssignedMessage,
  ): Promise<WorkHubTaskDetail | undefined> {
    const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
    if (
      header.isArchived ||
      header.subagentParent ||
      header.role !== undefined ||
      header.labels?.includes('mode:side_conversation') ||
      header.id === WORKHUB_COORDINATION_SESSION_ID
    )
      return undefined;
    if (!(await visible(assignment, true, observedLatest))) return undefined;
    if (await stores.sessionStore.readWorkHubReplacement(assignment.delegationId)) return undefined;
    const task: WorkHubTask = {
      workId: assignment.work?.id ?? assignment.actionId,
      actionId: assignment.actionId,
      delegationId: assignment.delegationId,
      targetSessionId: assignment.targetSessionId,
      targetSessionName: truncateUtf8(
        header.name || assignment.targetSessionName || header.id,
        512,
        '…',
      ),
      ...(assignment.taskTitle !== undefined ? { title: assignment.taskTitle } : {}),
      targetMessageId: assignment.targetMessageId,
      text: truncateUtf8(
        assignment.delegationText || assignment.userText,
        WORKHUB_TASK_TEXT_MAX_BYTES,
        '…',
      ),
      createdAt: assignment.ts,
      status: 'queued',
    };
    const stopped = await readWorkHubStopProjection(stores.sessionStore, assignment.delegationId);
    if (stopped?.retires)
      return { task: { ...task, status: stopped.resolution ? 'stopped' : 'stopping' } };
    const disposition = await messages.readMessageExecutionDispositionAdmitted(
      assignment.targetSessionId,
      assignment.targetMessageId,
      lease,
    );
    if (disposition.kind === 'cancelled') return { task: { ...task, status: 'cancelled' } };
    if (disposition.kind === 'pending') return { task };
    if (disposition.kind !== 'owned_root' && disposition.kind !== 'shared_turn')
      return { task: { ...task, status: 'unavailable' } };
    const original = {
      sessionId: assignment.targetSessionId,
      turnId: disposition.turnId,
      runId: disposition.runId,
    };
    const identity =
      options.evidence && disposition.kind === 'owned_root'
        ? await options.evidence.taskExecution(assignment, original)
        : await executions.readLatestRootTurnLineage(original);
    const execution = {
      turnId: identity.turnId,
      runId: identity.runId,
      sharedTurn: disposition.kind === 'shared_turn',
    };
    const waiting = await options.evidence?.waitingObservation(assignment, identity);
    if (waiting) {
      if (waiting.status === 'cancelled')
        return { task: { ...task, execution, status: 'cancelled' } };
      const data = waiting.details as {
        requestId: string;
        question?: string;
        sourceActionId?: string | null;
      };
      return {
        task: {
          ...task,
          execution,
          status: 'waiting_for_dependency',
          dependency: {
            requestId: data.requestId,
            question: truncateUtf8(data.question ?? waiting.result, 2048, '…'),
            ...(data.sourceActionId ? { sourceActionId: data.sourceActionId } : {}),
          },
        },
      };
    }
    const waitReason = executions.readWorkHubDispatchWait(identity);
    if (waitReason) return { task: { ...task, execution, status: 'waiting_resource', waitReason } };
    const snapshot = await executions.read(identity);
    const requests = await taskRequests(assignment, lease, lanes, observedLatest);
    const status: WorkHubTask['status'] =
      snapshot.status === 'completed'
        ? 'pending_acceptance'
        : snapshot.status === 'created' || snapshot.status === 'admitted'
          ? 'queued'
          : requests.length &&
              (snapshot.status === 'running' || snapshot.status === 'waiting_for_user')
            ? 'waiting_for_user'
            : snapshot.status;
    const projected = {
      ...task,
      execution,
      status,
      ...(snapshot.status === 'failed'
        ? {
            failure: truncateUtf8(
              snapshot.failureMessage || snapshot.failureClass || 'Execution failed',
              2048,
              '…',
            ),
          }
        : {}),
    };
    if (
      !detail ||
      !assignment.returnResults ||
      execution.sharedTurn ||
      (snapshot.status !== 'completed' &&
        snapshot.status !== 'failed' &&
        snapshot.status !== 'cancelled')
    )
      return { task: projected };
    const text = await readTurnResult(assignment.targetSessionId, identity.turnId);
    return {
      task: projected,
      ...(text
        ? {
            delivery: {
              text: truncateUtf8(text, WORKHUB_DELIVERY_MAX_BYTES, '…'),
              truncated: Buffer.byteLength(text, 'utf8') > WORKHUB_DELIVERY_MAX_BYTES,
              terminalEventId: snapshot.terminalEventId,
            },
          }
        : {}),
    };
  }
  const handlers: Pick<
    OperationHandlerMap,
    | 'workhub.interactions.query'
    | 'workhub.interactions.answer'
    | 'workhub.tasks.query'
    | 'workhub.tasks.read'
    | 'workhub.tasks.history'
    | 'workhub.tasks.executions'
  > = {
    ...createWorkHubTaskHistoryRuntime({
      stores,
      messages,
      admission,
      evidence: options.evidence,
      onError: options.onError,
    }).handlers,
    'workhub.tasks.query': async () => {
      const targets = (await stores.sessionStore.listHeaders())
        .filter(
          (h) =>
            !h.isArchived &&
            !h.subagentParent &&
            h.role === undefined &&
            !h.labels.includes('mode:side_conversation') &&
            h.id !== WORKHUB_COORDINATION_SESSION_ID,
        )
        .map((h) => h.id);
      const candidates: WorkHubDelegationAssignedMessage[] = [];
      let truncated = false;
      for (let i = 0; i < targets.length; i += 256) {
        const page = await stores.sessionStore.readActiveWorkHubAssignmentsByTarget(
          targets.slice(i, i + 256),
          WORKHUB_TASK_MAX_ITEMS + 1,
          true,
        );
        candidates.push(...page);
        if (page.length > WORKHUB_TASK_MAX_ITEMS) truncated = true;
      }
      candidates.sort((a, b) => b.ts - a.ts || a.actionId.localeCompare(b.actionId));
      const tasks: WorkHubTask[] = [];
      // Bound the number of locked projections as well as the wire page. This is
      // explicitly a recent-task window, never a total count of all active work.
      if (candidates.length > 128) truncated = true;
      for (const assignment of candidates.slice(0, 128)) {
        const lanes = await taskLanes(assignment);
        const projected = await admission.runMany(lanes, (lease) =>
          taskProjection(assignment, lease, false, lanes),
        );
        if (projected) tasks.push(projected.task);
      }
      const priority = (task: WorkHubTask) =>
        [
          'waiting_for_user',
          'stopping',
          'failed',
          'waiting_for_dependency',
          'waiting_resource',
          'running',
          'queued',
          'pending_acceptance',
          'cancelled',
          'stopped',
          'unavailable',
        ].indexOf(task.status);
      tasks.sort(
        (a, b) =>
          priority(a) - priority(b) ||
          b.createdAt - a.createdAt ||
          a.actionId.localeCompare(b.actionId),
      );
      return {
        ok: true,
        result: {
          tasks: tasks.slice(0, WORKHUB_TASK_MAX_ITEMS),
          truncated: truncated || tasks.length > WORKHUB_TASK_MAX_ITEMS,
        },
      };
    },
    'workhub.tasks.read': async (input) => {
      const missing = {
        ok: false as const,
        error: { code: 'not_found' as const, message: 'The original WorkHub task is unavailable' },
      };
      const assignment =
        'workId' in input
          ? await stores.sessionStore.readLatestWorkHubAssignment(input.workId)
          : await stores.sessionStore.readWorkHubAssignment(input.actionId);
      if (
        !assignment ||
        ('workId' in input
          ? (assignment.work?.id ?? assignment.actionId) !== input.workId
          : assignment.delegationId !== input.delegationId)
      )
        return missing;
      const lanes = await taskLanes(assignment);
      return admission.runMany(lanes, async (lease) => {
        const result = await taskProjection(assignment, lease, true, lanes);
        return result ? { ok: true, result } : missing;
      });
    },
    'workhub.interactions.query': async () => {
      const requests: WorkHubPendingInteraction[] = [];
      const seen = new Set<string>();
      let truncated = false;
      for (const assignment of await listAssignments()) {
        const lanes = await taskLanes(assignment);
        const items = await admission.runMany(lanes, async (lease) => {
          const pendingRequests = await taskRequests(assignment, lease, lanes);
          if (!pendingRequests.length) return [];
          const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
          return pendingRequests.map((interaction) => ({
            actionId: assignment.actionId,
            delegationId: assignment.delegationId,
            targetSessionName: truncateUtf8(header.name || assignment.targetSessionId, 512, '…'),
            interaction,
          }));
        });
        for (const item of items) {
          const key = JSON.stringify([item.interaction.sessionId, item.interaction.interactionId]);
          if (seen.has(key)) continue;
          if (requests.length === WORKHUB_INBOX_MAX_ITEMS)
            return { ok: true, result: { requests, truncated: true } };
          seen.add(key);
          requests.push(item);
        }
      }
      return { ok: true, result: { requests, truncated } };
    },
    'workhub.interactions.answer': async (input) => {
      const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
      const notFound = {
        ok: false as const,
        error: {
          code: 'not_found' as const,
          message: 'The original task request is no longer pending',
        },
      };
      if (!assignment?.returnResults || assignment.actionId !== input.actionId) return notFound;
      const lanes = await taskLanes(assignment);
      return admission.runMany(lanes, async (lease) => {
        const request = (await taskRequests(assignment, lease, lanes)).find(
          (p) =>
            p.interactionId === input.interactionId &&
            p.turnId === input.expectedTurnId &&
            p.runId === input.expectedRunId,
        );
        if (!request) return notFound;
        if (request.request.kind !== input.answer.kind)
          return {
            ok: false,
            error: {
              code: 'operation_conflict',
              message: 'The answer kind does not match the original task request',
            },
          };
        const outcome = await options.interactions.answerAdmitted(
          {
            sessionId: request.sessionId,
            interactionId: request.interactionId,
            answer: input.answer,
          },
          lease,
        );
        if (outcome.ok) {
          notify(assignment.targetSessionId);
        }
        return outcome;
      });
    },
  };
  const coordinator = new HostWorkHubResultCoordinator({
    listAssignments,
    inspect,
    deliver: (origin, prepare) => executions.startWorkHubResult(origin, prepare),
    acquireResidency: options.acquireResidency,
    onError: options.onError,
  });
  function notify(sessionId: string): void {
    coordinator.notify(sessionId);
  }
  /** Startup-only retirement of copied coordinator questions, never worker originals. */
  async function retireLegacy(): Promise<{ closed: number }> {
    let closed = 0;
    const runs = new Map<string, readonly import('@maka/core/runtime-event').RuntimeEvent[]>();
    for (const pending of await stores.interactionStore.listSessionPending(
      WORKHUB_COORDINATION_SESSION_ID,
    )) {
      const question = pending.request;
      if (pending.sessionId !== WORKHUB_COORDINATION_SESSION_ID || question.kind !== 'question')
        continue;
      let events = runs.get(pending.runId);
      if (!events) {
        events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
          WORKHUB_COORDINATION_SESSION_ID,
          pending.runId,
        );
        runs.set(pending.runId, events);
      }
      const relays = events.filter((event) => {
        const call = event.content;
        if (
          event.sessionId !== pending.sessionId ||
          event.turnId !== pending.turnId ||
          event.runId !== pending.runId ||
          event.partial ||
          event.role !== 'model' ||
          call?.kind !== 'function_call' ||
          call.name !== 'WorkHubResult' ||
          call.id !== question.toolUseId ||
          !call.args ||
          typeof call.args !== 'object' ||
          Array.isArray(call.args)
        )
          return false;
        const args = call.args as Record<string, unknown>;
        return (
          args.operation === 'ask_question' &&
          typeof args.actionId === 'string' &&
          typeof args.interactionId === 'string'
        );
      });
      if (relays.length > 1) throw new Error('Ambiguous legacy WorkHub question producer');
      if (
        relays.length === 1 &&
        (await options.interactions.closeLegacyWorkHubRelay({
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          turnId: pending.turnId,
          runId: pending.runId,
          requestId: pending.requestId,
          toolUseId: question.toolUseId,
        }))
      )
        closed++;
    }
    return { closed };
  }
  async function projectTask(source: WorkHubDelegationAssignedMessage, detail = false) {
    const current = await readCurrentWorkHubTaskSource(
      options,
      source.work?.id ?? source.actionId,
      source,
    );
    if (!current) return undefined;
    const basic = await admission.runMany(
      [WORKHUB_COORDINATION_SESSION_ID, current.targetSessionId],
      (lease) => taskProjection(current, lease, detail, [], source),
    );
    if (!basic || !['running', 'waiting_for_user'].includes(basic.task.status)) return basic;
    const lanes = await taskLanes(current);
    if (lanes.length <= 2) return basic;
    return admission.runMany(lanes, (lease) =>
      taskProjection(current, lease, detail, lanes, source),
    );
  }
  return { coordinator, notify, handlers, projectTask, retireLegacy, readResult };
}
