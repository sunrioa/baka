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
  type WorkHubTaskInputProvenance,
  type WorkHubTaskInputRequest,
} from '@maka/core/workhub-task-input';
import {
  SessionMetadataConflictError,
  isSessionNotFoundError,
  type ExecutionStoresWriter,
  type PendingMessageAdmission,
} from '@maka/storage/execution-stores';
import type {
  WorkHubTaskInputResult,
  WorkHubTaskSendInput,
} from '../protocol/workhub-task-input.js';
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
import { readCurrentWorkHubTaskSource } from './workhub-task-source.js';

type BoundInput = WorkHubTaskInputRequest & WorkHubTaskInputProvenance;
type ModelAuthority = NonNullable<
  Awaited<ReturnType<RootTurnCoordinator['readActiveWorkHubRoutingRequest']>>
> & { readonly turnId: string };

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
      | 'persistence_failed'
      | 'commit_outcome_unknown',
    message: string,
  ) {
    super(message);
  }
}

/** Both entry points use canonical task ownership; a preview is never routing authority. */
export function createWorkHubTaskInputRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  admission: SessionAdmissionGate;
  messages: HostMessageCoordinator;
  executions: RootTurnCoordinator;
  evidence: Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'taskExecution'>;
  coordination: Pick<HostWorkHubCoordinationCoordinator, 'continueTaskInput'> & {
    handlers: Pick<
      HostWorkHubCoordinationCoordinator['handlers'],
      'workhub.coordination.actFromTurn'
    >;
  };
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
  function provenance(
    input: WorkHubTaskSendInput,
    authority?: ModelAuthority,
  ): WorkHubTaskInputProvenance {
    // A saved legacy attempt may already own a pre-upgrade action claim.
    // Preserve its exact six-field fingerprint; new task-aware inputs
    // persist explicit provenance instead of rewriting that old payload.
    if (!authority && 'sourceActionId' in input) return {};
    return {
      originalUserText: authority?.content.text ?? input.text,
      inputOrigin: authority?.origin ?? 'user',
      ...(authority?.sourceMessageId ? { sourceMessageId: authority.sourceMessageId } : {}),
    };
  }
  function assertRetry(
    existing: WorkHubTaskInputMessage,
    input: WorkHubTaskSendInput,
    authority?: ModelAuthority,
  ) {
    const exact: BoundInput = {
      ...input,
      sourceActionId: 'sourceActionId' in input ? input.sourceActionId : existing.sourceActionId,
      sourceDelegationId:
        'sourceDelegationId' in input ? input.sourceDelegationId : existing.sourceDelegationId,
      ...provenance(input, authority),
    };
    if (!workHubTaskInputMatches(existing, exact))
      throw new InputFailure(
        'operation_conflict',
        'WorkHub input identity has different content or source',
      );
  }
  async function assertModelCurrent(authority: ModelAuthority) {
    const root = executions.readRootState(WORKHUB_COORDINATION_SESSION_ID);
    if (
      root.kind !== 'active' ||
      root.turnId !== authority.turnId ||
      root.runId !== authority.runId
    )
      throw new InputFailure(
        'operation_conflict',
        'WorkHub input belongs to a previous coordinator execution',
      );
    const snapshot = await executions.read(root);
    if (!['created', 'admitted', 'running', 'waiting_for_user'].includes(snapshot.status))
      throw new InputFailure('session_busy', 'The coordinator execution is stopping or recovering');
  }
  async function claimModelInput(input: BoundInput, authority: ModelAuthority) {
    await assertModelCurrent(authority);
    const suffix = createHash('sha256').update(input.inputId).digest('hex').slice(0, 48);
    const actionFingerprint = `sha256:${createHash('sha256')
      .update(
        JSON.stringify([
          'task_input',
          authority.turnId,
          input.workId,
          input.generationId,
          input.sourceActionId,
          input.sourceDelegationId,
          input.text,
          input.originalUserText,
          input.inputOrigin,
          input.sourceMessageId ?? null,
          authority.content.attachments ?? [],
        ]),
      )
      .digest('hex')}` as const;
    if (
      (await sessions.claimWorkHubAction({
        actionId: input.inputId,
        operation: 'delegate_existing',
        actionFingerprint,
        subject: `whti_${suffix}`,
      })) === 'conflict'
    )
      throw new InputFailure(
        'operation_conflict',
        'WorkHub action already owns a different operation or task input',
      );
  }
  async function source(
    input: WorkHubTaskInputRequest,
    taskAware: boolean,
  ): Promise<WorkHubDelegationAssignedMessage> {
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
    const stop = await sessions.readWorkHubStopRequest(a.delegationId);
    const resolution = stop ? await sessions.readWorkHubStopResolution(a.delegationId) : undefined;
    if (
      (await sessions.readWorkHubReplacement(a.delegationId)) ||
      (await sessions.readWorkHubSupersession(a.delegationId)) ||
      (await sessions.readWorkHubReplacementAbort(a.delegationId)) ||
      (stop && (!resolution || (!taskAware && resolution.outcome !== 'not_owned')))
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
    if (!taskAware && header.backend === 'plugin-executor')
      throw new InputFailure(
        'operation_unavailable',
        'Saved legacy direct inputs do not support this executor',
      );
    return a;
  }

  async function send(
    input: WorkHubTaskSendInput,
    context: ConnectionContext,
    authority?: ModelAuthority,
  ): Promise<WorkHubTaskInputResult> {
    let committing = false;
    try {
      const previous = await sessions.readWorkHubTaskInput(input.inputId);
      if (previous) {
        assertRetry(previous, input, authority);
        if (authority)
          await admission.run(WORKHUB_COORDINATION_SESSION_ID, () =>
            claimModelInput(
              {
                ...input,
                sourceActionId: previous.sourceActionId,
                sourceDelegationId: previous.sourceDelegationId,
                ...provenance(input, authority),
              },
              authority,
            ),
          );
        return receipt(previous);
      }
      const resolved =
        'sourceActionId' in input
          ? await sessions.readWorkHubAssignment(input.sourceActionId)
          : await sessions.readLatestWorkHubAssignment(input.workId);
      if (!resolved) throw new InputFailure('not_found', 'The selected task does not exist');
      let continuation: BoundInput | undefined;
      let validateTaskInput: (() => Promise<void>) | undefined;
      const accepted = await admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, resolved.targetSessionId],
        async (lease) => {
          const replay = await sessions.readWorkHubTaskInput(input.inputId);
          if (replay) {
            assertRetry(replay, input, authority);
            if (authority)
              await claimModelInput(
                {
                  ...input,
                  sourceActionId: replay.sourceActionId,
                  sourceDelegationId: replay.sourceDelegationId,
                  ...provenance(input, authority),
                },
                authority,
              );
            return replay;
          }
          const current =
            'sourceActionId' in input
              ? resolved
              : await readCurrentWorkHubTaskSource(
                  {
                    stores,
                    executions,
                    evidence: options.evidence,
                    messages: {
                      readMessageExecutionDisposition: (sessionId, messageId) =>
                        messages.readMessageExecutionDispositionAdmitted(
                          sessionId,
                          messageId,
                          lease,
                        ),
                    },
                  },
                  input.workId,
                );
          if (!current) throw new InputFailure('not_found', 'The selected task does not exist');
          const bound: BoundInput = {
            ...input,
            sourceActionId: 'sourceActionId' in input ? input.sourceActionId : current.actionId,
            sourceDelegationId:
              'sourceDelegationId' in input ? input.sourceDelegationId : current.delegationId,
            ...provenance(input, authority),
          };
          const a = await source(bound, !('sourceActionId' in input));
          if (a.targetSessionId !== resolved.targetSessionId)
            throw new InputFailure('operation_conflict', 'The target Session changed');
          if (authority) await claimModelInput(bound, authority);
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
            ...bound,
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
            if (authority?.content.attachments?.length)
              throw new InputFailure(
                'operation_unavailable',
                'Queued task supplements with attachments are not supported; no input was appended',
              );
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
          if (disposition.kind === 'recovering')
            throw new InputFailure(
              'operation_unavailable',
              'The selected task admission is still recovering',
            );
          if (disposition.kind === 'cancelled' && 'sourceActionId' in input)
            throw new InputFailure(
              'operation_unavailable',
              'The saved legacy task admission is cancelled',
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
              const snapshot = await executions.read(active);
              if (!['created', 'admitted', 'running', 'waiting_for_user'].includes(snapshot.status))
                throw new InputFailure(
                  'session_busy',
                  'The task execution is stopping, recovering or settling',
                );
              const header = await sessions.readHeaderSnapshot(a.targetSessionId);
              if (header.backend === 'plugin-executor' || authority?.content.attachments?.length)
                throw new InputFailure(
                  'operation_unavailable',
                  'Live task Steering is not supported for this executor or attachment input; no later Turn was substituted',
                );
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
          const root = executions.readRootState(a.targetSessionId);
          if (root.kind === 'reserved')
            throw new InputFailure(
              'session_busy',
              'The task is admitting or recovering an execution',
            );
          continuation = bound;
          validateTaskInput = async () => {
            if (authority) await assertModelCurrent(authority);
            const now = executions.readRootState(a.targetSessionId);
            if (
              now.kind === 'reserved' ||
              (now.kind === 'active' &&
                (root.kind !== 'active' || now.turnId !== root.turnId || now.runId !== root.runId))
            )
              throw new InputFailure(
                'session_busy',
                'The target execution changed before task input admission; no later Turn was substituted',
              );
          };
          return undefined;
        },
      );
      if (accepted) return receipt(accepted);
      if (!continuation || !validateTaskInput) throw new Error('Task input has no admitted source');
      committing = true;
      await options.coordination.continueTaskInput(continuation, context, {
        validateTaskInput,
        ...(authority
          ? { coordinationTurnId: authority.turnId, attachments: authority.content.attachments }
          : {}),
      });
      const committed = await sessions.readWorkHubTaskInput(input.inputId);
      if (!committed) throw new Error('Task continuation has no accepted input receipt');
      assertRetry(committed, input, authority);
      return receipt(committed);
    } catch (error) {
      if (committing) {
        try {
          const committed = await sessions.readWorkHubTaskInput(input.inputId);
          if (committed) {
            assertRetry(committed, input, authority);
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
      'workhub.tasks.continue': async (input, context) => {
        try {
          const request = await executions.readActiveWorkHubRoutingRequest(input.turnId);
          if (!request)
            throw new InputFailure(
              'operation_conflict',
              'Task continuation requires its active WorkHub model Turn',
            );
          const authority: ModelAuthority = { ...request, turnId: input.turnId };
          await assertModelCurrent(authority);
          const previous = await sessions.readWorkHubTaskInput(input.actionId);
          if (input.container === 'fresh') {
            if (previous)
              throw new InputFailure(
                'operation_conflict',
                'This action already owns a reused task input',
              );
            const committed = await sessions.readWorkHubAssignment(input.actionId);
            const source = committed?.work?.continuesActionId
              ? await sessions.readWorkHubAssignment(committed.work.continuesActionId)
              : await sessions.readLatestWorkHubAssignment(input.taskId);
            if (!source || (source.work?.id ?? source.actionId) !== input.taskId)
              throw new InputFailure('not_found', 'The selected task does not exist');
            const outcome = await options.coordination.handlers['workhub.coordination.actFromTurn'](
              {
                turnId: input.turnId,
                actionId: input.actionId,
                delegationText: input.text,
                proposal: {
                  disposition: 'continue_work',
                  workId: input.taskId,
                  sourceActionId: source.actionId,
                  container: 'fresh',
                },
              },
              context,
            );
            if (!outcome.ok)
              throw new InputFailure(
                outcome.error.code === 'candidate_set_stale'
                  ? 'operation_conflict'
                  : outcome.error.code === 'unauthorized'
                    ? 'operation_unavailable'
                    : outcome.error.code,
                outcome.error.message,
              );
            if (
              outcome.result.disposition !== 'create_new' ||
              outcome.result.workId !== input.taskId
            )
              throw new Error('Fresh task continuation returned a different task');
            return { ok: true, result: { container: 'fresh', action: outcome.result } };
          }
          const latest = previous
            ? undefined
            : await sessions.readLatestWorkHubAssignment(input.taskId);
          const generationId =
            previous?.generationId ?? latest?.work?.generationId ?? latest?.actionId;
          if (!generationId)
            throw new InputFailure('not_found', 'The selected task does not exist');
          const result = await send(
            { inputId: input.actionId, workId: input.taskId, generationId, text: input.text },
            context,
            authority,
          );
          return { ok: true, result: { container: 'reuse', input: result } };
        } catch (error) {
          return failure(error);
        }
      },
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
    } satisfies Pick<
      OperationHandlerMap,
      'workhub.tasks.send' | 'workhub.tasks.input.read' | 'workhub.tasks.continue'
    >,
  };
}
