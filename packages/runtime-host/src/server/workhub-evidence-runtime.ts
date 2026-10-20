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

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import {
  WORKHUB_EVIDENCE_MAX_ROUNDS,
  isWorkHubEvidenceRequest,
  isWorkHubEvidenceResolution,
  type WorkHubEvidenceRequestMessage,
  type WorkHubEvidenceResolutionMessage,
  type WorkHubPeerQuestionMessage,
} from '@maka/core/workhub-evidence';
import type { ToolResultArchiveEvidenceReader } from '@maka/core/tool-result-archive-evidence';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { HostedExecutionRef } from './hosted-execution-authority.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import type { WorkHubResultObservation } from './workhub-result-coordinator.js';
import { readHostedExecutionMembership } from './hosted-execution-membership.js';
import { readWorkHubStopProjection } from './workhub-stop-projection.js';
import {
  readWorkHubTaskInputBinding,
  readWorkHubTaskInputContinuation,
} from './workhub-task-input-lineage.js';
import {
  createWorkHubEvidenceReader,
  workHubEvidenceListParameters,
  workHubEvidenceReadParameters,
} from './workhub-evidence-reader.js';
import { createWorkHubPeerRuntime, workHubPeerTaskRef } from './workhub-peer-runtime.js';
import { createWorkHubTaskHistoryRuntime } from './workhub-task-history-runtime.js';
import { createWorkHubTaskHistoryReader } from './workhub-task-history-reader.js';
export { readHostedExecutionMembership as readWorkHubEvidenceExecution } from './hosted-execution-membership.js';

function identity(prefix: string, ...parts: string[]): string {
  return prefix + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 48);
}
export const workHubEvidenceRequestId = (turnId: string) => identity('whe_', turnId);
export const workHubEvidenceResolutionId = (requestId: string) => identity('wher_', requestId);
export const workHubEvidenceTurnId = (requestId: string) => identity('whet_', requestId);
/** Separate from the immutable old source selection, which remains readable. */
export const workHubEvidenceRetirementId = (requestId: string) => identity('wheret_', requestId);

interface TaskExecution extends HostedExecutionRef {
  readonly round: number;
  readonly request?: WorkHubEvidenceRequestMessage;
}
export class WorkHubFreshSourceUnavailableError extends Error {}

/** Read-only task evidence and old-lineage compatibility. No relay/wake producer remains. */
export function createWorkHubEvidenceRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  executions: RootTurnCoordinator;
  messages: HostMessageCoordinator;
  admission: SessionAdmissionGate;
  reader: Pick<SessionTranscriptReader, 'readDurableHighWater' | 'readDurableRecords'>;
  archiveEvidence?: ToolResultArchiveEvidenceReader;
  hasLiveResources(sessionId: string): Promise<boolean>;
  hasBlockingGoal(ref: Pick<HostedExecutionRef, 'sessionId' | 'turnId'>): boolean;
  onError(error: unknown): void;
  now?: () => number;
}) {
  const { stores, executions, messages, admission, reader } = options;
  const now = options.now ?? Date.now;
  const membership = (ref: HostedExecutionRef) =>
    readHostedExecutionMembership(stores.runtimeEventStore, ref);
  async function record(sessionId: string, messageId: string) {
    return (
      await stores.sessionStore.readTranscriptMessagesSnapshot(sessionId, {
        messageIds: [messageId],
        throughSequence: await stores.sessionStore.readTranscriptHighWaterSnapshot(sessionId),
        maxBytes: 32768,
        maxMessages: 1,
      })
    )[0];
  }
  async function requestFor(identity: HostedExecutionRef) {
    const value = await record(identity.sessionId, workHubEvidenceRequestId(identity.turnId));
    if (
      !isWorkHubEvidenceRequest(value) ||
      value.senderSessionId !== identity.sessionId ||
      value.turnId !== identity.turnId
    )
      return undefined;
    const logical = await membership(identity);
    if (!logical?.runIds.includes(value.senderRunId) || logical.tip.runId !== value.senderRunId)
      return undefined;
    const run = await stores.runtimeEventStore.readRunInvocation(
      identity.sessionId,
      value.senderRunId,
    );
    return run?.turnId === value.turnId &&
      run.invocationId === value.senderInvocationId &&
      run.opening.root.kind === 'user' &&
      run.terminalEvent?.status === 'completed' &&
      run.terminalEvent.actions?.stateDelta?.stopReason === 'dependency_wait'
      ? value
      : undefined;
  }
  async function active(assignment: WorkHubDelegationAssignedMessage) {
    try {
      const h = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
      if (
        h.isArchived ||
        h.subagentParent ||
        h.role !== undefined ||
        h.labels.includes('mode:side_conversation') ||
        !assignment.returnResults
      )
        return false;
      if (
        !(await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([h.id])).some(
          (a) => a.delegationId === assignment.delegationId && a.returnResults,
        )
      )
        return false;
      if (await stores.sessionStore.readWorkHubReplacement(assignment.delegationId, true))
        return false;
      return !(await readWorkHubStopProjection(stores.sessionStore, assignment.delegationId))
        ?.retires;
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    }
  }
  /** One authenticated evidence edge, also used by paginated read-only views. */
  async function readEvidenceContinuation(
    assignment: WorkHubDelegationAssignedMessage,
    tip: HostedExecutionRef,
  ) {
    const request = await requestFor(tip);
    if (
      !request ||
      request.delegationId !== assignment.delegationId ||
      request.actionId !== assignment.actionId ||
      request.rootMessageId !== assignment.targetMessageId
    )
      return undefined;
    const next = await stores.agentRunStore.readRootTurnAdmission(
      tip.sessionId,
      workHubEvidenceTurnId(request.id),
    );
    const origin = next?.execution.kind === 'external_message' ? next.execution.origin : undefined;
    if (!next || origin?.kind !== 'workhub_evidence') return { request };
    if (
      origin.requestId !== request.id ||
      origin.delegationId !== assignment.delegationId ||
      origin.sourceTurnId !== tip.turnId ||
      origin.sourceRunId !== request.senderRunId
    )
      throw new Error('WorkHub evidence continuation identity conflict');
    return { request, next: { sessionId: next.sessionId, turnId: next.turnId, runId: next.runId } };
  }
  async function taskExecution(
    assignment: WorkHubDelegationAssignedMessage,
    original: HostedExecutionRef,
  ): Promise<TaskExecution> {
    let tip = await executions.readLatestRootTurnLineage(original);
    let round = 0;
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(tip.turnId)) throw new Error('WorkHub task lineage contains a cycle');
      seen.add(tip.turnId);
      const input = await readWorkHubTaskInputContinuation(stores, assignment, tip);
      if (input) {
        tip = await executions.readLatestRootTurnLineage(input);
        continue;
      }
      const edge = await readEvidenceContinuation(assignment, tip);
      if (!edge) return { ...tip, round };
      if (!edge.next)
        return {
          ...tip,
          round,
          ...((await active(assignment)) && !(await retirementFor(edge.request))
            ? { request: edge.request }
            : {}),
        };
      if (++round > WORKHUB_EVIDENCE_MAX_ROUNDS)
        throw new Error('WorkHub evidence continuation identity conflict');
      tip = await executions.readLatestRootTurnLineage(edge.next);
    }
  }
  async function owned(assignment: WorkHubDelegationAssignedMessage, lease: SessionAdmissionLease) {
    const disposition = await messages.readMessageExecutionDispositionAdmitted(
      assignment.targetSessionId,
      assignment.targetMessageId,
      lease,
    );
    if (disposition.kind !== 'owned_root') return undefined;
    return taskExecution(assignment, {
      sessionId: assignment.targetSessionId,
      turnId: disposition.turnId,
      runId: disposition.runId,
    });
  }
  async function caller(
    ctx: MakaToolContext,
    current: readonly WorkHubDelegationAssignedMessage[],
    lease: SessionAdmissionLease,
  ) {
    ctx.abortSignal.throwIfAborted();
    if (!ctx.runId || !ctx.invocationId)
      throw new Error('Evidence requires a hosted root invocation');
    const run = await stores.runtimeEventStore.readRunInvocation(ctx.sessionId, ctx.runId);
    if (
      !run ||
      run.sessionId !== ctx.sessionId ||
      run.turnId !== ctx.turnId ||
      run.invocationId !== ctx.invocationId ||
      run.opening.root.kind !== 'user' ||
      run.terminalEvent
    )
      throw new Error('Evidence sender is not the current root invocation');
    if (ctx.sessionId === WORKHUB_COORDINATION_SESSION_ID) {
      const root = await stores.agentRunStore.readRootTurnAdmission(ctx.sessionId, ctx.turnId);
      if (
        root?.execution.kind !== 'workhub_coordination' ||
        (await membership(root))?.tip.runId !== ctx.runId
      )
        throw new Error('Evidence resolution requires WorkHub authority');
      return undefined;
    }
    for (const a of current.filter((a) => a.targetSessionId === ctx.sessionId)) {
      if (!(await active(a))) continue;
      const tip = await owned(a, lease);
      if (tip?.turnId === ctx.turnId && (await membership(tip))?.tip.runId === ctx.runId)
        return { assignment: a, tip };
    }
    throw new Error('Evidence sender is outside an active WorkHub task');
  }
  async function readable(
    source: WorkHubDelegationAssignedMessage,
    ctx: MakaToolContext,
    lease: SessionAdmissionLease,
  ) {
    if (await active(source)) return true;
    const workId = source.work?.id ?? source.actionId;
    const latest = await stores.sessionStore.readLatestWorkHubAssignment(workId);
    if (
      !latest ||
      (latest.work?.generationId ?? latest.actionId) ===
        (source.work?.generationId ?? source.actionId) ||
      !(await active(latest)) ||
      !source.returnResults
    )
      return false;
    const h = await stores.sessionStore.readHeaderSnapshot(source.targetSessionId);
    if (
      h.isArchived ||
      h.subagentParent ||
      h.role !== undefined ||
      h.labels.includes('mode:side_conversation')
    )
      return false;
    const actor = await caller(
      ctx,
      await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([ctx.sessionId]),
      lease,
    );
    return (
      ctx.sessionId === WORKHUB_COORDINATION_SESSION_ID ||
      (actor?.assignment.work?.id ?? actor?.assignment.actionId) === workId
    );
  }
  const pages = createWorkHubEvidenceReader({
    stores: stores.sessionStore,
    reader,
    admission,
    active,
    readable,
    authorize: async (ctx, lease) => {
      await caller(
        ctx,
        await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([ctx.sessionId]),
        lease,
      );
    },
    execution: async (source, lease) => {
      const tip = await owned(source, lease);
      if (!tip) return undefined;
      const snapshot = await executions.read(tip);
      return { ...tip, status: snapshot.status, waiting: !!tip.request };
    },
  });
  const history = createWorkHubTaskHistoryRuntime({
    stores,
    messages,
    admission,
    evidence: { readEvidenceContinuation },
    onError: options.onError,
  });
  const readHistoryPage = createWorkHubTaskHistoryReader({
    stores: stores.sessionStore,
    reader,
    admission,
    history,
    archiveEvidence: options.archiveEvidence,
    authorize: async (source, ctx, lease) => {
      const actor = await caller(
        ctx,
        await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([ctx.sessionId]),
        lease,
      );
      if (
        !actor ||
        (actor.assignment.work?.id ?? actor.assignment.actionId) !==
          (source.work?.id ?? source.actionId)
      )
        return undefined;
      return (await readable(source, ctx, lease)) ? actor.assignment : undefined;
    },
  });

  async function retirementFor(request: WorkHubEvidenceRequestMessage) {
    const value = await record(request.senderSessionId, workHubEvidenceRetirementId(request.id));
    if (!value) return undefined;
    if (
      !isWorkHubEvidenceResolution(value) ||
      value.origin !== 'legacy_protocol_retirement' ||
      value.requestId !== request.id ||
      value.requesterSessionId !== request.senderSessionId ||
      value.turnId !== request.turnId ||
      value.senderRunId !== request.senderRunId ||
      value.senderInvocationId !== request.senderInvocationId ||
      value.toolCallId !== request.toolCallId
    )
      throw new Error('Evidence retirement source identity conflict');
    return value;
  }
  async function authenticateOriginal(
    actionId: string,
    delegationId: string,
    sessionId: string,
    messageId: string,
    turnId: string,
    runId: string,
    invocationId: string,
  ) {
    const assignment = await stores.sessionStore.readWorkHubAssignment(actionId);
    if (
      !assignment ||
      assignment.delegationId !== delegationId ||
      assignment.targetSessionId !== sessionId ||
      assignment.targetMessageId !== messageId
    )
      return undefined;
    return admission.runMany([WORKHUB_COORDINATION_SESSION_ID, sessionId], async (lease) => {
      // Retirement authenticates immutable ownership, not present-day catalog
      // eligibility. Archived/superseded sources may still have old open facts.
      const disposition = await messages.readMessageExecutionDispositionAdmitted(
        sessionId,
        messageId,
        lease,
      );
      if (disposition.kind !== 'owned_root') return undefined;
      let root: HostedExecutionRef | undefined = {
        sessionId,
        turnId: disposition.turnId,
        runId: disposition.runId,
      };
      const seen = new Set<string>();
      let evidenceRounds = 0;
      while (root) {
        if (seen.has(root.turnId)) throw new Error('Task retirement lineage contains a cycle');
        seen.add(root.turnId);
        const admitted = await stores.agentRunStore.readRootTurnAdmission(sessionId, root.turnId);
        if (!admitted || admitted.runId !== root.runId) return undefined;
        const logical = await membership(root);
        if (!logical) return undefined;
        if (root.turnId === turnId) {
          const run = await stores.runtimeEventStore.readRunInvocation(sessionId, runId);
          if (
            !logical.runIds.includes(runId) ||
            run?.turnId !== turnId ||
            run.invocationId !== invocationId ||
            run.opening.root.kind !== 'user'
          )
            return undefined;
          return { assignment, root };
        }
        const next = await stores.agentRunStore.readRootTurnContinuationAdmission(
          sessionId,
          root.turnId,
          logical.tip.runId,
        );
        if (next) {
          if (
            next.execution.kind !== 'safe_boundary_continuation' ||
            next.execution.sourceTurnId !== root.turnId ||
            next.execution.sourceRunId !== logical.tip.runId
          )
            throw new Error('Task retirement continuation identity conflict');
          root = { sessionId, turnId: next.turnId, runId: next.runId };
          continue;
        }
        const input = await readWorkHubTaskInputContinuation(stores, assignment, root);
        const evidence: { readonly next?: HostedExecutionRef } | undefined = input
          ? undefined
          : await readEvidenceContinuation(assignment, root);
        if (evidence?.next && ++evidenceRounds > WORKHUB_EVIDENCE_MAX_ROUNDS)
          throw new Error('Task retirement evidence lineage exceeds its bound');
        root = input ?? evidence?.next;
      }
      return undefined;
    });
  }
  const peers = createWorkHubPeerRuntime({
    stores: stores.sessionStore,
    admission,
    now,
    authenticate: async (q: WorkHubPeerQuestionMessage) => {
      const proof = await authenticateOriginal(
        q.sender.actionId,
        q.sender.delegationId,
        q.sender.sessionId,
        q.sender.messageId,
        q.turnId,
        q.senderRunId,
        q.senderInvocationId,
      );
      return !!proof && isDeepStrictEqual(workHubPeerTaskRef(proof.assignment), q.sender);
    },
  });
  async function retireWait(request: WorkHubEvidenceRequestMessage) {
    if (await retirementFor(request)) return 'settled' as const;
    const proof = await authenticateOriginal(
      request.actionId,
      request.delegationId,
      request.senderSessionId,
      request.rootMessageId,
      request.turnId,
      request.senderRunId,
      request.senderInvocationId,
    );
    if (!proof) return 'unavailable' as const;
    const source = await requestFor(proof.root);
    if (!isDeepStrictEqual(source, request)) return 'unavailable' as const;
    if ((await readEvidenceContinuation(proof.assignment, proof.root))?.next)
      return 'settled' as const;
    // The generic Host-local primitive names the exact admitted old Root. It
    // never invents a renderer/user stop source, nor cancels later followups.
    await executions.stopRootPreservingFollowups(proof.root);
    return admission.runMany(
      [WORKHUB_COORDINATION_SESSION_ID, request.senderSessionId],
      async () => {
        if (await retirementFor(request)) return 'settled' as const;
        if (!isDeepStrictEqual(await requestFor(proof.root), request))
          return 'unavailable' as const;
        if ((await readEvidenceContinuation(proof.assignment, proof.root))?.next)
          return 'settled' as const;
        if (await options.hasLiveResources(request.senderSessionId)) return 'unavailable' as const;
        const marker: WorkHubEvidenceResolutionMessage = {
          type: 'workhub_evidence_resolution',
          schemaVersion: 1,
          id: workHubEvidenceRetirementId(request.id),
          origin: 'legacy_protocol_retirement',
          turnId: request.turnId,
          ts: now(),
          requestId: request.id,
          requesterSessionId: request.senderSessionId,
          senderRunId: request.senderRunId,
          senderInvocationId: request.senderInvocationId,
          toolCallId: request.toolCallId,
          sourceActionId: null,
          sourceDelegationId: null,
          sourceSessionId: null,
          sourceMessageId: null,
        };
        await stores.sessionStore.appendMessage(request.senderSessionId, marker);
        return 'retired' as const;
      },
    );
  }
  let draining = false;
  let retiring:
    | Promise<{ retiredWaits: number; retiredQuestions: number; unavailable: number }>
    | undefined;
  /** Startup only, after canonical root recovery and before new user admissions. */
  function retireLegacy() {
    if (retiring) return retiring;
    retiring = (async () => {
      const result = { retiredWaits: 0, retiredQuestions: 0, unavailable: 0 };
      for (const header of await stores.sessionStore.listHeaders()) {
        if (draining) break;
        if (header.id === WORKHUB_COORDINATION_SESSION_ID || header.subagentParent || header.role)
          continue;
        let before = Number.MAX_SAFE_INTEGER;
        let through: number | null | undefined;
        try {
          for (;;) {
            if (draining) break;
            const page = await stores.sessionStore.readMessagesAfter(header.id, {
              beforeSequence: before,
              maxMessages: 64,
              maxStoredBytes: 256 * 1024,
            });
            through ??= page.highWaterSequence;
            if (!page.records.length) break;
            for (const row of page.records) {
              before = row.sequence;
              if (through !== null && through !== undefined && row.sequence > through) continue;
              const value = row.message;
              try {
                if (value.type === 'workhub_evidence') {
                  const status = await retireWait(value);
                  if (status === 'retired') result.retiredWaits++;
                  if (status === 'unavailable') result.unavailable++;
                } else if (value.type === 'workhub_peer_question') {
                  const status = await peers.retireLegacy(value);
                  if (status === 'retired') result.retiredQuestions++;
                  if (status === 'unavailable') result.unavailable++;
                }
              } catch (error) {
                result.unavailable++;
                options.onError(error);
              }
            }
            if (before === 0) break;
          }
        } catch (error) {
          if (!isSessionNotFoundError(error)) options.onError(error);
          result.unavailable++;
        }
      }
      return result;
    })().finally(() => {
      retiring = undefined;
    });
    return retiring;
  }
  async function waitingObservation(
    assignment: WorkHubDelegationAssignedMessage,
    ref: HostedExecutionRef,
  ): Promise<WorkHubResultObservation | undefined> {
    const request = await requestFor(ref);
    if (!request || request.delegationId !== assignment.delegationId) return undefined;
    // An already admitted old child is lineage, not an unresolved wait.
    if ((await readEvidenceContinuation(assignment, ref))?.next) return undefined;
    const retired = await retirementFor(request);
    return {
      ...ref,
      status: retired ? 'cancelled' : 'waiting_for_dependency',
      eventKey: retired?.id ?? request.id,
      sharedTurn: false,
      notifyCoordinator: false,
      result: retired
        ? 'Legacy dependency wait retired by the Host; the task is stopped and may be continued by the user.'
        : 'Legacy dependency wait awaits Host retirement; it will not automatically resume.',
      details: {
        requestId: request.id,
        origin: retired?.origin ?? 'legacy_wait',
        expiresAt: request.expiresAt,
      },
    };
  }
  const readTaskHistory = async (
    raw: z.input<typeof workHubEvidenceReadParameters>,
    ctx: MakaToolContext,
  ) => readHistoryPage(workHubEvidenceReadParameters.parse(raw), ctx);
  const list = async (raw: z.input<typeof workHubEvidenceListParameters>, ctx: MakaToolContext) =>
    pages.list(workHubEvidenceListParameters.parse(raw), ctx);
  const read = async (raw: z.input<typeof workHubEvidenceReadParameters>, ctx: MakaToolContext) => {
    const input = workHubEvidenceReadParameters.parse(raw);
    if (input.view === 'task_history') return readTaskHistory(input, ctx);
    if (input.kinds) throw new Error('kinds requires view=task_history');
    return pages.read(input, ctx);
  };
  return {
    read,
    list,
    readTaskHistory,
    taskExecution,
    readEvidenceContinuation,
    history: {
      readExecutions: history.readExecutions,
      readAssignmentState: history.readAssignmentState,
    },
    retireLegacy,
    waitingObservation,
    async authorizeRead(ctx: MakaToolContext) {
      return admission.runMany([WORKHUB_COORDINATION_SESSION_ID, ctx.sessionId], async (lease) => {
        const current =
          ctx.sessionId === WORKHUB_COORDINATION_SESSION_ID
            ? []
            : await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([ctx.sessionId]);
        return (await caller(ctx, current, lease))?.assignment;
      });
    },
    async assertFreshContainerSource(
      source: WorkHubDelegationAssignedMessage,
      lease: SessionAdmissionLease,
    ) {
      function blocked(reason: string): never {
        throw new WorkHubFreshSourceUnavailableError(reason);
      }
      const header = await stores.sessionStore.readHeaderSnapshot(source.targetSessionId);
      if (
        header.isArchived ||
        header.subagentParent ||
        header.role !== undefined ||
        header.labels.includes('mode:side_conversation')
      )
        blocked('The source Session is not eligible for WorkHub continuation');
      const workId = source.work?.id ?? source.actionId;
      const generationId = source.work?.generationId ?? source.actionId;
      const current = (
        await stores.sessionStore.readActiveWorkHubAssignmentsByTarget(
          [source.targetSessionId],
          undefined,
          true,
        )
      ).filter(
        (a) =>
          (a.work?.id ?? a.actionId) === workId &&
          (a.work?.generationId ?? a.actionId) === generationId,
      );
      if (
        !current.some(
          (a) => a.actionId === source.actionId && a.delegationId === source.delegationId,
        )
      )
        blocked('The source work generation changed');
      // Metadata/owned execution queries only, never the cold Session transcript.
      // Every assignment in this generation matters, not just an old named Action.
      for (const assignment of current) {
        const disposition = await messages.readMessageExecutionDispositionAdmitted(
          assignment.targetSessionId,
          assignment.targetMessageId,
          lease,
        );
        // A withdrawn queue admission is settled, not an execution to resume.
        // The fresh admission still checks every sibling and all live resources.
        if (disposition.kind === 'cancelled') continue;
        const tip = await owned(assignment, lease);
        if (!tip || tip.request)
          blocked('The source work is queued, unproven or waiting for evidence');
        const snapshot = await executions.read(tip);
        if (
          !['completed', 'failed', 'cancelled'].includes(snapshot.status) ||
          options.hasBlockingGoal(tip)
        )
          blocked('The source work still owns an execution, question or Goal');
      }
      for (const input of await stores.sessionStore.listMessageAdmissions(source.targetSessionId)) {
        const binding = await readWorkHubTaskInputBinding(
          stores,
          source.targetSessionId,
          input.messageId,
        );
        if (!binding && /^whtm_[a-f0-9]{48}$/u.test(input.messageId))
          blocked('The source Session has unproven queued direct input');
        if (binding?.workId === workId && binding.generationId === generationId)
          blocked('The source work still owns queued direct input');
      }
      if (
        await stores.sessionStore.hasUnsettledWorkHubPeerCommunication({
          sessionId: source.targetSessionId,
          workId,
          generationId,
          now: now(),
        })
      )
        blocked('The source work still has a legacy peer question pending Host retirement');
      if (await options.hasLiveResources(source.targetSessionId))
        blocked('The source Session still has live resources; no work was stopped or moved');
    },

    async assertSafeTerminal(ref: HostedExecutionRef) {
      if ((await requestFor(ref)) && (await options.hasLiveResources(ref.sessionId)))
        throw new Error('Evidence wait reached an unsafe live resource boundary');
    },
    // Only the explicit startup retirement can have work in flight.
    beginDrain() {
      draining = true;
    },
    async close() {
      draining = true;
      await retiring;
    },
  };
}
