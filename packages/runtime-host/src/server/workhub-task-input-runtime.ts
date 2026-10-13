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
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import {
  workHubTaskInputMatches,
  type WorkHubTaskInputMessage,
  type WorkHubTaskInputRequest,
} from '@maka/core/workhub-task-input';
import {
  SessionMetadataConflictError,
  isSessionNotFoundError,
  type ExecutionStoresWriter,
  type PendingMessageAdmission,
} from '@maka/storage/execution-stores';
import type { WorkHubTaskInputResult } from '../protocol/workhub-task-input.js';
import type { OperationHandlerMap, ConnectionContext } from './operation-dispatcher.js';
import type { SessionAdmissionGate } from './session-admission-gate.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostWorkHubCoordinationCoordinator } from './workhub-coordination-coordinator.js';
import type { createWorkHubEvidenceRuntime } from './workhub-evidence-runtime.js';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
} from './workhub-coordination-action-gate.js';

class InputFailure extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'operation_conflict'
      | 'operation_unavailable'
      | 'session_busy'
      | 'host_draining'
      | 'host_not_ready'
      | 'session_archived'
      | 'internal_failure'
      | 'commit_outcome_unknown',
    message: string,
  ) {
    super(message);
  }
}

/** Native user input is resolved from work ownership; the coordinator model is not on this path. */
export function createWorkHubTaskInputRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  admission: SessionAdmissionGate;
  messages: HostMessageCoordinator;
  executions: RootTurnCoordinator;
  evidence: Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'taskExecution'>;
  coordination: Pick<HostWorkHubCoordinationCoordinator, 'continueTaskInput'>;
  requestDrain(): void;
  onError(error: unknown): void;
}) {
  const { stores, admission, messages, executions } = options;
  const sessions = stores.sessionStore;

  async function receipt(input: WorkHubTaskInputMessage): Promise<WorkHubTaskInputResult> {
    const base: WorkHubTaskInputResult = {
      inputId: input.inputId,
      workId: input.workId,
      generationId: input.generationId,
      sourceActionId: input.sourceActionId,
      sourceDelegationId: input.sourceDelegationId,
      acceptedAt: input.ts,
      mode: input.mode,
      targetSessionId: input.targetSessionId,
      targetMessageId: input.targetMessageId,
      delivery: 'unproven',
    };
    // Indexed canonical facts only. Do not consume pending admissions, wake a
    // cold worker or infer delivery merely because its queue row disappeared.
    const root = await stores.agentRunStore.readRootTurnSourceMessageReceipt(
      input.targetSessionId,
      input.targetMessageId,
    );
    if (
      root?.admission.sessionId === input.targetSessionId &&
      root.sourceMessage.messageId === input.targetMessageId &&
      messageContentDigest(root.sourceMessage.content) === input.targetContentDigest
    )
      return {
        ...base,
        delivery: 'delivered',
        execution: { turnId: root.admission.turnId, runId: root.admission.runId },
      };
    const steering = await stores.runtimeEventStore.readImmutableSteeringMessageProof(
      input.targetSessionId,
      input.targetMessageId,
    );
    const event = steering?.event;
    if (
      event?.sessionId === input.targetSessionId &&
      event.refs?.providerEventId === input.targetMessageId &&
      event.content?.kind === 'text' &&
      messageContentDigest(normalizeMessageContent(event.content)) === input.targetContentDigest
    )
      return {
        ...base,
        delivery: 'delivered',
        execution: { turnId: event.turnId, runId: event.runId },
      };
    if (await sessions.hasCancelledMessageAdmission(input.targetSessionId, input.targetMessageId))
      return { ...base, delivery: 'cancelled' };
    const pending = await sessions.readMessageAdmission(
      input.targetSessionId,
      input.targetMessageId,
    );
    return pending && messageContentDigest(pending.content) === input.targetContentDigest
      ? { ...base, delivery: 'queued' }
      : base;
  }
  function assertRetry(existing: WorkHubTaskInputMessage, input: WorkHubTaskInputRequest) {
    if (!workHubTaskInputMatches(existing, input))
      throw new InputFailure(
        'operation_conflict',
        'WorkHub input identity has different content or source',
      );
  }
  async function source(input: WorkHubTaskInputRequest): Promise<WorkHubDelegationAssignedMessage> {
    const a = await sessions.readWorkHubAssignment(input.sourceActionId);
    const latest = await sessions.readLatestWorkHubAssignment(input.workId);
    if (
      !a ||
      a.delegationId !== input.sourceDelegationId ||
      (a.work?.id ?? a.actionId) !== input.workId ||
      (a.work?.generationId ?? a.actionId) !== input.generationId ||
      !latest ||
      (latest.work?.generationId ?? latest.actionId) !== input.generationId
    )
      throw new InputFailure(
        'operation_conflict',
        'The selected work generation changed; return to its current task',
      );
    if (
      (await sessions.readWorkHubReplacement(a.delegationId)) ||
      (await sessions.readWorkHubSupersession(a.delegationId)) ||
      (await sessions.readWorkHubReplacementAbort(a.delegationId)) ||
      ((await sessions.readWorkHubStopRequest(a.delegationId)) &&
        (await sessions.readWorkHubStopResolution(a.delegationId))?.outcome !== 'not_owned')
    )
      throw new InputFailure('operation_conflict', 'The selected task is being retired');
    const header = await sessions.readHeaderSnapshot(a.targetSessionId);
    if (
      header.isArchived ||
      header.subagentParent ||
      header.role !== undefined ||
      header.labels.includes('mode:side_conversation')
    )
      throw new InputFailure('operation_unavailable', 'The selected task is unavailable');
    if (header.backend === 'plugin-executor')
      throw new InputFailure(
        'operation_unavailable',
        'Direct task input currently requires a native executor; live steering is not supported by this backend',
      );
    return a;
  }

  async function send(
    input: WorkHubTaskInputRequest,
    context: ConnectionContext,
  ): Promise<WorkHubTaskInputResult> {
    let committing = false;
    try {
      const previous = await sessions.readWorkHubTaskInput(input.inputId);
      if (previous) {
        assertRetry(previous, input);
        return receipt(previous);
      }
      const resolved = await sessions.readWorkHubAssignment(input.sourceActionId);
      if (!resolved) throw new InputFailure('not_found', 'The selected task does not exist');
      const accepted = await admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, resolved.targetSessionId],
        async (lease) => {
          const replay = await sessions.readWorkHubTaskInput(input.inputId);
          if (replay) {
            assertRetry(replay, input);
            return replay;
          }
          const a = await source(input);
          if (a.targetSessionId !== resolved.targetSessionId)
            throw new InputFailure('operation_conflict', 'The target Session changed');
          const disposition = await messages.readMessageExecutionDispositionAdmitted(
            a.targetSessionId,
            a.targetMessageId,
            lease,
          );
          const hash = createHash('sha256').update(input.inputId).digest('hex').slice(0, 48);
          const fact = (
            after: PendingMessageAdmission,
            mode: 'steering' | 'queued_supplement',
          ): WorkHubTaskInputMessage => ({
            ...input,
            type: 'workhub_coordination',
            kind: 'task_input',
            schemaVersion: 1,
            id: `whti_${hash}`,
            turnId: a.coordinationTurnId,
            ts: Date.now(),
            targetSessionId: a.targetSessionId,
            targetMessageId: after.messageId,
            targetContentDigest: messageContentDigest(after.content),
            mode,
            ...(mode === 'steering'
              ? { execution: { turnId: after.turnId, runId: after.runId } }
              : {}),
          });
          if (disposition.kind === 'pending') {
            let committed: WorkHubTaskInputMessage | undefined;
            const result = await messages.supplementWorkHubMessageAdmitted(
              {
                sessionId: a.targetSessionId,
                messageId: a.targetMessageId,
                inputId: input.inputId,
                text: input.text,
              },
              lease,
              async (after, before) => {
                committing = true;
                committed = await sessions.commitWorkHubTaskInput({
                  input: fact(after, 'queued_supplement'),
                  admission: after,
                  expectedAdmission: before,
                });
              },
            );
            if (!result.ok)
              throw new InputFailure(
                result.error.code === 'outcome_unknown'
                  ? 'commit_outcome_unknown'
                  : result.error.code,
                result.error.message,
              );
            if (!committed) throw new Error('Queued supplementation did not commit its input');
            return committed;
          }
          if (disposition.kind === 'cancelled' || disposition.kind === 'recovering')
            throw new InputFailure(
              'operation_unavailable',
              'The selected task admission is cancelled or still recovering',
            );
          if (disposition.kind === 'owned_root') {
            const owned = await options.evidence.taskExecution(a, {
              sessionId: a.targetSessionId,
              turnId: disposition.turnId,
              runId: disposition.runId,
            });
            if (owned.request)
              throw new InputFailure(
                'operation_unavailable',
                'This task is waiting for evidence; resolve its dependency before continuing',
              );
            const active = executions.readRootState(a.targetSessionId);
            if (active.kind === 'reserved')
              throw new InputFailure('session_busy', 'The task is reserving its next execution');
            if (
              active.kind === 'active' &&
              active.turnId === owned.turnId &&
              active.runId === owned.runId
            ) {
              const content = normalizeMessageContent({ text: input.text });
              const prepared = await executions.prepareMessage({
                sessionId: a.targetSessionId,
                turnId: active.turnId,
                placement: 'current_turn',
                content,
              });
              if (prepared.kind !== 'ready')
                throw new InputFailure('operation_unavailable', prepared.error);
              const after: PendingMessageAdmission = {
                sessionId: a.targetSessionId,
                turnId: active.turnId,
                runId: active.runId,
                messageId: `whtm_${hash}`,
                content: prepared.content,
                submittedContentDigest: messageContentDigest(content),
                submittedPlacement: 'current_turn',
                placement: 'current_turn',
                disposition: 'steering',
                skillInvocation: prepared.skillInvocation,
                admittedAt: Date.now(),
              };
              const capacity = await messages.preflightQueuedAdmissionAdmitted(after, lease);
              if (!capacity.ok)
                throw new InputFailure(
                  capacity.error.code === 'outcome_unknown'
                    ? 'commit_outcome_unknown'
                    : capacity.error.code,
                  capacity.error.message,
                );
              committing = true;
              const committed = await sessions.commitWorkHubTaskInput({
                input: fact(after, 'steering'),
                admission: after,
              });
              await messages.consumePendingAdmissionsAdmitted(a.targetSessionId, lease);
              return committed;
            }
          }
          // Ended or shared work cannot steer the Session's unrelated root. The
          // existing assignment gate revalidates this source again at admission.
          return undefined;
        },
      );
      if (accepted) return receipt(accepted);
      committing = true;
      await options.coordination.continueTaskInput(input, context);
      const committed = await sessions.readWorkHubTaskInput(input.inputId);
      if (!committed) throw new Error('Task continuation has no accepted input receipt');
      assertRetry(committed, input);
      return receipt(committed);
    } catch (error) {
      if (committing) {
        try {
          const committed = await sessions.readWorkHubTaskInput(input.inputId);
          if (committed) {
            assertRetry(committed, input);
            // The durable input remains accepted, but a failed post-commit
            // hydration must recover in a fresh Host rather than lose it in
            // this process's queue projection.
            options.onError(error);
            options.requestDrain();
            return await receipt(committed);
          }
        } catch (proofError) {
          if (proofError instanceof InputFailure) throw proofError;
          options.requestDrain();
          options.onError(proofError);
          throw new InputFailure(
            'commit_outcome_unknown',
            'Task input outcome is unknown; retain the same input ID for recovery',
          );
        }
      }
      throw error;
    }
  }
  function failure(error: unknown) {
    if (error instanceof InputFailure)
      return { ok: false as const, error: { code: error.code, message: error.message } };
    if (error instanceof WorkHubActionEffectFailure)
      return {
        ok: false as const,
        error: {
          code: error.code === 'unauthorized' ? ('operation_unavailable' as const) : error.code,
          message: error.message,
        },
      };
    if (error instanceof SessionMetadataConflictError || error instanceof WorkHubActionGateFailure)
      return {
        ok: false as const,
        error: { code: 'operation_conflict' as const, message: error.message },
      };
    if (isSessionNotFoundError(error))
      return {
        ok: false as const,
        error: { code: 'not_found' as const, message: 'The selected task is unavailable' },
      };
    options.onError(error);
    return {
      ok: false as const,
      error: {
        code: 'persistence_failed' as const,
        message: 'Task input state could not be read or committed',
      },
    };
  }
  return {
    handlers: {
      'workhub.tasks.send': async (input, context) => {
        try {
          return { ok: true, result: await send(input, context) };
        } catch (error) {
          return failure(error);
        }
      },
      'workhub.tasks.input.read': async (input) => {
        try {
          const accepted = await sessions.readWorkHubTaskInput(input.inputId);
          if (!accepted || accepted.workId !== input.workId)
            throw new InputFailure('not_found', 'The accepted work input does not exist');
          return { ok: true, result: await receipt(accepted) };
        } catch (error) {
          return failure(error);
        }
      },
    } satisfies Pick<OperationHandlerMap, 'workhub.tasks.send' | 'workhub.tasks.input.read'>,
  };
}
