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
  workHubStopRetiresDelegation,
  type WorkHubTaskStopSet,
  type WorkHubTaskStopTarget,
} from '@maka/core/workhub-task-stop';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import type {
  WorkHubTaskInputRequest,
  WorkHubTaskInputProvenance,
} from '@maka/core/workhub-task-input';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeMessageContent, type AttachmentRef } from '@maka/core/events';
import type { SessionConfigurationTransitionRequest } from '@maka/runtime/session-manager';
import type { CreateSessionInput } from '@maka/core/runtime-inputs';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  WORKHUB_COORDINATION_SESSION_ROLE,
  WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  type SessionHeader,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import type { ExecutionSessionWriter, SessionHeaderSnapshot } from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
  WorkHubCoordinationActResult,
  WorkHubCoordinationAnswerInput,
  WorkHubCoordinationConfigureModelInput,
} from '../protocol/index.js';
import { WORKHUB_COORDINATION_TEXT_MAX_BYTES } from '../protocol/index.js';
import {
  WORKHUB_COORDINATION_DEFAULT_MODEL_REQUIRED_MESSAGE,
  type WorkHubContextObservation,
} from '../protocol/workhub-coordination.js';
import type {
  WorkHubTaskStartInput,
  WorkHubTaskAskInput,
  WorkHubTaskChoice,
} from '../protocol/workhub-task-actions.js';
import type { WorkHubTaskContinueFromTurnInput } from '../protocol/workhub-task-input.js';
import type { ConnectionContext, OperationHandlerMap } from './operation-dispatcher.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import { SessionAdmissionGate, type SessionAdmissionLease } from './session-admission-gate.js';
import {
  SessionOperationFailure,
  WorkHubDefaultModelRequiredError,
  projectSessionCatalogRecord,
} from './session-catalog-coordinator.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionFailStopError,
} from '@maka/runtime/interaction-authority';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { SessionContinuityCoordinator } from './session-continuity-coordinator.js';
import type { WorkHubTargetExecutionAuthority } from './workhub-target-execution-authority.js';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  WorkHubCoordinationActionGate,
  type WorkHubActionGateEffects,
  type WorkHubAdmittedAction,
  type WorkHubDelegationStopResolutionInput,
  workHubCreatedSessionId,
} from './workhub-coordination-action-gate.js';

const CREATE_FINGERPRINT = `sha256:${createHash('sha256')
  .update('maka:workhub-coordination-session:v1', 'utf8')
  .digest('hex')}`;
const COORDINATION_CWD_DIRECTORY = 'workhub-coordination';
const COORDINATION_TOOL_PROFILE = 'workhub-coordination-v2' as const;
const COORDINATION_PERMISSION_MODE = 'bypass' as const;
const COORDINATION_COLLABORATION_MODE = 'agent' as const;
const COORDINATION_ORCHESTRATION_MODE = 'default' as const;
const COORDINATION_SUMMARY_MESSAGE_KINDS = ['user', 'assistant', 'state'] as const;
const TURN_IDENTITY_CONFLICT_MESSAGE =
  'WorkHub Coordination Turn identity belongs to a different operation';
// A one-byte control character can occupy six bytes as a JSON `\u0000` escape.
const JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE = 6;
const COORDINATION_SUMMARY_READ_MAX_BYTES =
  JSON_ESCAPE_MAX_BYTES_PER_INPUT_BYTE * (WORKHUB_COORDINATION_TEXT_MAX_BYTES + 8 * 1024) +
  16 * 1024;

type CoordinationStores = Pick<
  ExecutionSessionWriter,
  | 'appendMessages'
  | 'createStableSession'
  | 'listHeaders'
  | 'claimWorkHubAction'
  | 'readWorkHubActionClaim'
  | 'probeStableSessionCreate'
  | 'readHeaderSnapshot'
  | 'readCatalogRecord'
  | 'readWorkHubAssignment'
  | 'readLatestWorkHubAssignment'
  | 'readActiveWorkHubAssignmentsByTarget'
  | 'readWorkHubReplacement'
  | 'readWorkHubStopRequest'
  | 'readWorkHubStopResolution'
  | 'readTranscriptHighWaterSnapshot'
  | 'readTranscriptMessagesSnapshot'
  | 'updateHeaderVersioned'
>;

type CoordinationExecutions = Pick<
  RootTurnCoordinator,
  'startWorkHubCoordinationMessage' | 'isSessionExecutionIdle' | 'readActiveWorkHubRoutingRequest'
>;

type CoordinationSessionActions = Pick<WorkHubActionGateEffects, 'assign'>;

export type CoordinationCreateTarget = Omit<CreateSessionInput, 'cwd' | 'name' | 'projectId'>;

export interface HostWorkHubCoordinationCoordinatorOptions {
  readonly stateRoot: string;
  readonly stores: CoordinationStores;
  readonly admission: SessionAdmissionGate;
  readonly continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly executions: CoordinationExecutions;
  readonly sessionActions: CoordinationSessionActions;
  readonly resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly requestDrain: () => void;
  readonly transitionConfiguration: (
    input: SessionConfigurationTransitionRequest,
  ) => Promise<SessionHeaderSnapshot>;
  readonly configureModel: (
    input: WorkHubCoordinationConfigureModelInput,
  ) => Promise<OperationOutcome<'workhub.coordination.configureModel'>>;
  readonly requestForm?: HostInteractionCoordinator['requestForm'];
  readonly targetExecution?: WorkHubTargetExecutionAuthority;
  readonly readWorkContext?: (sessionId: string) => Promise<WorkHubContextObservation>;
  readonly readStopBinding?: (
    source: WorkHubDelegationAssignedMessage,
    lease?: SessionAdmissionLease,
  ) => Promise<string>;
  readonly isStopBindingCurrent?: (
    source: WorkHubDelegationAssignedMessage,
    expected: string,
    lease: SessionAdmissionLease,
  ) => Promise<boolean>;
}

/** Resolves the one durable Coordination Session owned by this Runtime Host. */
export class HostWorkHubCoordinationCoordinator {
  readonly #requestForm: HostWorkHubCoordinationCoordinatorOptions['requestForm'];
  readonly handlers: Pick<
    OperationHandlerMap,
    | 'workhub.tasks.start'
    | 'workhub.tasks.ask'
    | 'workhub.coordination.resolve'
    | 'workhub.coordination.query'
    | 'workhub.coordination.configureModel'
    | 'workhub.coordination.answer'
  > = {
    'workhub.tasks.start': (input, context) => this.#startTask(input, context),
    'workhub.tasks.ask': (input) => this.#askTask(input),
    'workhub.coordination.resolve': () => this.#resolve(),
    'workhub.coordination.query': () => this.#query(),
    'workhub.coordination.configureModel': (input) => this.#configureModel(input),
    'workhub.coordination.answer': (input, context) => this.#answer(input, context),
  };

  readonly #transitionConfiguration: HostWorkHubCoordinationCoordinatorOptions['transitionConfiguration'];
  readonly #configureModel: HostWorkHubCoordinationCoordinatorOptions['configureModel'];
  readonly #coordinationCwd: string;
  readonly #taskCwdRoot: string;
  readonly #stores: CoordinationStores;
  readonly #admission: SessionAdmissionGate;
  readonly #continuity: Pick<SessionContinuityCoordinator, 'refreshCanonical'>;
  readonly #executions: CoordinationExecutions;
  readonly #resolveCreateTarget: () => Promise<CoordinationCreateTarget>;
  readonly #requestDrain: () => void;
  readonly #actionGate: WorkHubCoordinationActionGate;
  readonly #readStopBinding: HostWorkHubCoordinationCoordinatorOptions['readStopBinding'];
  readonly #isStopBindingCurrent: HostWorkHubCoordinationCoordinatorOptions['isStopBindingCurrent'];
  readonly #readWorkContext: HostWorkHubCoordinationCoordinatorOptions['readWorkContext'];

  constructor(options: HostWorkHubCoordinationCoordinatorOptions) {
    this.#requestForm = options.requestForm;
    this.#configureModel = options.configureModel;
    this.#transitionConfiguration = options.transitionConfiguration;
    this.#coordinationCwd = join(options.stateRoot, COORDINATION_CWD_DIRECTORY);
    this.#taskCwdRoot = join(options.stateRoot, 'workhub-tasks');
    this.#stores = options.stores;
    this.#readStopBinding = options.readStopBinding;
    this.#isStopBindingCurrent = options.isStopBindingCurrent;
    this.#readWorkContext = options.readWorkContext;
    this.#admission = options.admission;
    this.#continuity = options.continuity;
    this.#executions = options.executions;
    this.#resolveCreateTarget = options.resolveCreateTarget;
    this.#requestDrain = options.requestDrain;
    this.#actionGate = new WorkHubCoordinationActionGate({
      listSessions: () => this.#stores.listHeaders(),
      ...(options.targetExecution ? { targetExecution: options.targetExecution } : {}),
      // The global action owner is committed under the same Coordination
      // admission that serializes every durable Coordination fact, so a
      // concurrent action cannot slip between the claim and the fact it owns.
      claimAction: (claim) =>
        this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, () =>
          this.#stores.claimWorkHubAction(claim),
        ),
      readAssignment: (actionId) => this.#stores.readWorkHubAssignment(actionId),
      readLatestWorkAssignment: (workId) => this.#stores.readLatestWorkHubAssignment(workId),
      // Continuation rechecks the exact source at final admission.
      listActiveAssignments: (targetSessionId, includeStopped) =>
        this.#stores.readActiveWorkHubAssignmentsByTarget(
          [targetSessionId],
          undefined,
          includeStopped,
        ),
      readReplacement: (delegationId) => this.#stores.readWorkHubReplacement(delegationId),
      readStopRequest: (delegationId, actionId, latest) =>
        this.#stores.readWorkHubStopRequest(delegationId, actionId, latest),
      readStopResolution: (delegationId, actionId) =>
        this.#stores.readWorkHubStopResolution(delegationId, actionId),

      assign: options.sessionActions.assign,
    });
  }

  /** Server-only task snapshots; the caller already owns the complete set's admission. */
  prepareTaskStop(
    input: {
      readonly source: WorkHubDelegationAssignedMessage;
      readonly target: WorkHubTaskStopTarget;
      readonly actionId: string;
      readonly actionFingerprint: `sha256:${string}`;
      readonly coordinationTurnId: string;
      readonly userText: string;
      readonly stopSet?: WorkHubTaskStopSet;
      /** Only a verified, already-committed anchor permits historical no-op receipts. */
      readonly replay: boolean;
    },
    admission: SessionAdmissionLease,
  ): Promise<WorkHubDelegationStopRequestedMessage> {
    const { source, target } = input;
    let suffix: string;
    return this.#commitCoordinationFact({
      admission,
      admissionSessionIds: [WORKHUB_COORDINATION_SESSION_ID, target.targetSessionId],
      read: async () => {
        const first = await this.#stores.readWorkHubStopRequest(source.delegationId);
        suffix = workHubDestructiveClaimIdentitySuffix(
          first && first.actionId !== input.actionId
            ? JSON.stringify([source.delegationId, input.actionId])
            : source.delegationId,
        );
        return this.#stores.readWorkHubStopRequest(source.delegationId, input.actionId);
      },
      build: (existing) => ({
        type: 'workhub_coordination',
        kind: 'delegation_stop_requested',
        schemaVersion: WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
        id: `whq_${suffix}`,
        turnId: input.coordinationTurnId,
        ts: existing?.ts ?? Date.now(),
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId: input.coordinationTurnId,
        stopsActionId: target.sourceActionId,
        stopsDelegationId: target.sourceDelegationId,
        targetSessionId: target.targetSessionId,
        targetMessageId: target.targetMessageId,
        targetSessionName: source.targetSessionName,
        userText: input.userText,
        workId: target.workId,
        executionBinding: target.executionBinding,
        taskStop: true,
        ...(input.stopSet ? { stopSet: input.stopSet } : {}),
      }),
      beforeAppend: async (lease) => {
        const canonical = await this.#stores.readWorkHubAssignment(target.sourceActionId);
        const claim = await this.#stores.readWorkHubActionClaim(input.actionId);
        if (
          !canonical ||
          !isDeepStrictEqual(canonical, source) ||
          (source.work?.id ?? source.actionId) !== target.workId ||
          (source.work?.generationId ?? source.actionId) !== target.generationId ||
          source.actionId !== target.sourceActionId ||
          source.delegationId !== target.sourceDelegationId ||
          source.targetSessionId !== target.targetSessionId ||
          source.targetMessageId !== target.targetMessageId ||
          claim?.operation !== 'stop' ||
          claim.actionFingerprint !== input.actionFingerprint ||
          claim.subject !== source.delegationId
        )
          throw new WorkHubActionGateFailure('action_conflict', 'Task stop snapshot changed');
        if (target.targetSessionId === WORKHUB_COORDINATION_SESSION_ID)
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'The coordinator is not a task target',
          );
        if (!input.replay) {
          const [head, header] = await Promise.all([
            this.#stores.readLatestWorkHubAssignment(target.workId),
            this.#stores.readHeaderSnapshot(target.targetSessionId),
          ]);
          if (
            header.isArchived ||
            !head ||
            (head.work?.generationId ?? head.actionId) !== target.generationId ||
            !this.#readStopBinding ||
            !(this.#isStopBindingCurrent
              ? await this.#isStopBindingCurrent(source, target.executionBinding, lease)
              : (await this.#readStopBinding(source, lease)) === target.executionBinding)
          )
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'Task stop target is no longer current',
            );
        }
      },
      conflictMessage: 'Task stop action already owns a different snapshot',
      unknownOutcomeMessage: 'Task stop request outcome is unknown',
    });
  }

  resolveTaskStop(input: WorkHubDelegationStopResolutionInput) {
    return this.#resolveStop(input);
  }

  #resolveStop(
    input: WorkHubDelegationStopResolutionInput,
  ): Promise<WorkHubDelegationStopResolvedMessage> {
    const request = input.request;
    const suffix = workHubDestructiveClaimIdentitySuffix(
      JSON.stringify([request.stopsDelegationId, request.actionId]),
    );
    return this.#commitCoordinationFact({
      read: () =>
        this.#stores.readWorkHubStopResolution(request.stopsDelegationId, request.actionId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whz_${suffix}`,
        turnId: request.coordinationTurnId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
        kind: 'delegation_stop_resolved',
        actionId: request.actionId,
        actionFingerprint: request.actionFingerprint,
        coordinationTurnId: request.coordinationTurnId,
        stopsActionId: request.stopsActionId,
        stopsDelegationId: request.stopsDelegationId,
        targetSessionId: request.targetSessionId,
        outcome: input.outcome,
        ...(request.taskStop === true ||
        (input.outcome === 'not_owned' && input.targetTurnId === undefined)
          ? { taskStop: true as const }
          : {}),
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
        ...(input.cancelledWaitRequestId
          ? { cancelledWaitRequestId: input.cancelledWaitRequestId }
          : {}),
      }),
      additionalMessages: async (resolved) => {
        const primary = await this.#stores.readWorkHubStopResolution(request.stopsDelegationId);
        const priorRequest =
          primary?.outcome === 'already_terminal'
            ? await this.#stores.readWorkHubStopRequest(request.stopsDelegationId, primary.actionId)
            : undefined;
        const priorNoop =
          primary !== undefined &&
          priorRequest !== undefined &&
          !workHubStopRetiresDelegation(priorRequest, primary);
        if (
          workHubStopRetiresDelegation(request, resolved) &&
          (request.taskStop === true || priorNoop)
        ) {
          // Retirements supersede observations without rewriting them. No-op
          // observations still settle older unresolved requests in the old slots.
          if (primary && primary.outcome !== 'not_owned' && !priorNoop) return [];
          return [
            {
              ...resolved,
              id: `whzs_${workHubDestructiveClaimIdentitySuffix(request.stopsDelegationId)}`,
            },
          ];
        }
        // Keep immutable per-action receipts; the delegation slot aggregates only
        // terminal knowledge. Upgrade not_owned at a distinct immutable identity;
        // appendMessages never replaces an existing identity.
        if (primary && (primary.outcome !== 'not_owned' || resolved.outcome === 'not_owned'))
          return [];
        return [
          {
            ...resolved,
            id: `${primary ? 'whzt_' : 'whz_'}${workHubDestructiveClaimIdentitySuffix(request.stopsDelegationId)}`,
          },
        ];
      },
      conflictMessage: 'WorkHub stop already has a different resolution',
      beforeAppend: async () => {
        const durable = await this.#stores.readWorkHubStopRequest(
          request.stopsDelegationId,
          request.actionId,
        );
        if (!durable || !isDeepStrictEqual(durable, request)) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub stop request identity changed',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub stop resolution outcome is unknown',
    });
  }

  #commitCoordinationFact<T extends StoredMessage>(options: {
    readonly admission?: SessionAdmissionLease;
    readonly admissionSessionIds?: readonly string[];
    readonly read: () => Promise<T | undefined>;
    readonly build: (existing: T | undefined, lease: SessionAdmissionLease) => T | Promise<T>;
    readonly additionalMessages?: (requested: T) => Promise<StoredMessage[]>;
    readonly conflictMessage: string;
    readonly beforeAppend: (lease: SessionAdmissionLease) => Promise<void>;
    readonly unknownOutcomeMessage: string;
  }): Promise<T> {
    const sessionIds = options.admissionSessionIds ?? [WORKHUB_COORDINATION_SESSION_ID];
    const commit = async (lease: SessionAdmissionLease) => {
      const existing = await options.read();
      const requested = await options.build(existing, lease);
      if (existing) {
        if (!isDeepStrictEqual(existing, requested)) {
          throw new WorkHubActionGateFailure('action_conflict', options.conflictMessage);
        }
        return existing;
      }
      await options.beforeAppend(lease);
      try {
        await this.#stores.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
          requested,
          ...((await options.additionalMessages?.(requested)) ?? []),
        ]);
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return requested;
      } catch {
        const replay = await options.read().catch(() => undefined);
        if (replay && isDeepStrictEqual(replay, requested)) return replay;
        this.#requestDrain();
        throw new WorkHubActionEffectFailure(
          'commit_outcome_unknown',
          options.unknownOutcomeMessage,
        );
      }
    };
    if (!options.admission) return this.#admission.runMany(sessionIds, commit);
    const lease = options.admission;
    return this.#admission.runAdmitted(WORKHUB_COORDINATION_SESSION_ID, lease, async () => {
      for (const sessionId of sessionIds)
        await this.#admission.runAdmitted(sessionId, lease, () => undefined);
      return commit(lease);
    });
  }

  async #startTask(
    input: WorkHubTaskStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.tasks.start'>> {
    let request;
    try {
      request = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
    } catch {
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub active Turn authority is unavailable',
        },
      };
    }
    if (!request)
      return {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'Task start requires its currently active WorkHub model Turn',
        },
      };
    try {
      let target: WorkHubAdmittedAction['selectedTarget'];
      if (input.sessionRef) {
        const candidate = await this.#actionGate.nativeTaskCandidate(input.sessionRef);
        if (!candidate && !(await this.#stores.readWorkHubAssignment(input.actionId)))
          throw new WorkHubActionGateFailure(
            'candidate_unavailable',
            'The selected Session is unavailable',
          );
        target = {
          sessionId: input.sessionRef,
          workspaceDigest: candidate
            ? digest(candidate.workspace)
            : digest({ replay: input.actionId }),
        };
      }
      if (!input.sessionRef && !input.create)
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task creation context is unavailable',
        );
      const create =
        input.create && !input.sessionRef
          ? {
              workspace:
                input.create.workspace.kind === 'isolated'
                  ? await this.#isolatedTaskWorkspace(input.actionId)
                  : input.create.workspace,
            }
          : undefined;
      const result = await this.#actionGate.act(
        {
          actionId: input.actionId,
          proposal: input.sessionRef
            ? { disposition: 'delegate_existing' }
            : { disposition: 'create_new', title: Array.from(input.title).slice(0, 64).join('') },
          delegationText: input.text,
          ...(create ? { create, newWorkDefaults: input.newWorkDefaults } : {}),
          ...(target ? { selectedTarget: target } : {}),
          taskStart: { turnId: input.turnId, title: input.title },
          validateAuthority: async () => {
            if (
              !isDeepStrictEqual(
                await this.#executions.readActiveWorkHubRoutingRequest(input.turnId),
                request,
              )
            )
              throw new WorkHubActionGateFailure(
                'action_conflict',
                'The dispatching Run is no longer active',
              );
          },
          ...(request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : {}),
          coordinationRunId: request.runId,
          inputOrigin: request.origin,
          userText: request.content.text,
          ...(request.content.attachments ? { attachments: request.content.attachments } : {}),
        },
        context,
        input.turnId,
      );
      if (
        (result.disposition !== 'create_new' && result.disposition !== 'delegate_existing') ||
        result.workId !== input.actionId
      )
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task start did not admit independent work',
        );
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof WorkHubActionEffectFailure
              ? error.code
              : error instanceof WorkHubActionGateFailure
                ? 'operation_conflict'
                : 'persistence_failed',
          message: error instanceof Error ? error.message : 'Task start is unavailable',
        },
      };
    }
  }

  async #taskChoice(target: WorkHubTaskChoice) {
    const source =
      target.kind === 'task'
        ? await this.#stores.readLatestWorkHubAssignment(target.id)
        : undefined;
    if (target.kind === 'task' && (!source || (source.work?.id ?? source.actionId) !== target.id))
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'The offered task is unavailable',
      );
    const candidate = await this.#actionGate.nativeTaskCandidate(
      source?.targetSessionId ?? target.id,
    );
    if (!candidate)
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'The offered task or Session is unavailable',
      );
    const generationId = source ? (source.work?.generationId ?? source.actionId) : undefined;
    return {
      candidate,
      generationId,
      title: source?.taskTitle ?? candidate.sessionName,
      value: JSON.stringify([target.kind, target.id, generationId ?? digest(candidate.workspace)]),
    };
  }

  async #askTask(input: WorkHubTaskAskInput): Promise<OperationOutcome<'workhub.tasks.ask'>> {
    try {
      const authority = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
      if (!authority || !this.#requestForm)
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task selection requires an active Coordination Turn',
        );
      // Reuse the existing global claim and Form authority. Selection never
      // assigns a Message, changes settings or authorizes another operation.
      await this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async () => {
        const current = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
        if (!isDeepStrictEqual(current, authority))
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'The selecting Run is no longer active',
          );
        const claim = await this.#stores.claimWorkHubAction({
          actionId: input.actionId,
          operation: 'clarify',
          actionFingerprint: digest({
            input,
            content: authority.content,
            origin: authority.origin,
          }),
          subject: input.turnId,
        });
        if (claim === 'conflict')
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'This action identity belongs to another operation',
          );
      });
      const choice = await this.#requestForm({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        runId: authority.runId,
        requestId: createHash('sha256').update(JSON.stringify({ input, authority })).digest('hex'),
        create: async () => ({
          kind: 'form',
          toolUseId: input.actionId,
          message: input.question,
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select',
              name: 'target',
              label: '选择任务 / Choose work',
              required: true,
              options: [
                ...(await Promise.all(
                  input.choices.map(async (target, index) => {
                    const offered = await this.#taskChoice(target);
                    return {
                      value: offered.value,
                      label: truncateUtf8(
                        `${index + 1}. ${offered.title} — ${basename(offered.candidate.workspace.hostCwd)}`,
                        190,
                      ),
                    };
                  }),
                )),
                { value: 'new_task', label: '新建任务 / New task' },
              ],
            },
          ],
        }),
      });
      const current = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
      if (!isDeepStrictEqual(current, authority))
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'The selecting Run is no longer active',
        );
      if (choice.answer.action !== 'accept') return { ok: true, result: { kind: 'cancelled' } };
      const value = choice.answer.values.target;
      if (value === 'new_task') return { ok: true, result: { kind: 'new_task' } };
      let binding: unknown;
      try {
        binding = typeof value === 'string' ? JSON.parse(value) : undefined;
      } catch {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task selection has no offered target',
        );
      }
      if (
        !Array.isArray(binding) ||
        binding.length !== 3 ||
        !binding.every((part) => typeof part === 'string')
      )
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task selection has no offered target',
        );
      const target = input.choices.find(
        (item) => item.kind === binding[0] && item.id === binding[1],
      );
      if (!target)
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task selection is outside its offer',
        );
      const selected = await this.#taskChoice(target);
      if (selected.value !== value)
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'The selected task generation or workspace changed; ask again',
        );
      const observation = await this.#readWorkContext?.(selected.candidate.sessionId);
      if (
        (await this.#taskChoice(target)).value !== value ||
        !isDeepStrictEqual(
          await this.#executions.readActiveWorkHubRoutingRequest(input.turnId),
          authority,
        )
      )
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'The selected task or selecting Run changed',
        );
      return {
        ok: true,
        result: {
          kind: 'selected',
          target,
          ...(selected.generationId ? { generationId: selected.generationId } : {}),
          ...(observation ? { context: observation } : {}),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeInteractionFailStopError) throw error;
      return {
        ok: false,
        error: {
          code:
            error instanceof WorkHubActionGateFailure ||
            error instanceof RuntimeInteractionAdmissionRejectedError
              ? 'operation_conflict'
              : 'persistence_failed',
          message: error instanceof Error ? error.message : 'Task selection is unavailable',
        },
      };
    }
  }

  async #isolatedTaskWorkspace(actionId: string) {
    // Names are Host-derived, not model paths. Do not follow a substituted
    // directory into another workspace or grant access to sibling tasks.
    const directory = join(this.#taskCwdRoot, workHubCreatedSessionId(actionId));
    for (const path of [this.#taskCwdRoot, directory]) {
      await mkdir(path, { recursive: true });
      const metadata = await lstat(path);
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
        throw new WorkHubActionEffectFailure(
          'operation_conflict',
          'WorkHub task workspace is unavailable',
        );
      }
    }
    return { kind: 'host_path' as const, path: directory };
  }

  async #query(): Promise<OperationOutcome<'workhub.coordination.query'>> {
    try {
      return {
        ok: true,
        result: projectSessionCatalogRecord(
          await this.#stores.readCatalogRecord(WORKHUB_COORDINATION_SESSION_ID, 'recoverable'),
        ),
      };
    } catch {
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub Coordination Session state is unavailable',
        },
      };
    }
  }

  #resolve(): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    return this.#admission.run(WORKHUB_COORDINATION_SESSION_ID, async (lease) => {
      // The workspace exists for provisioning and for reuse alike: a directory
      // that was pruned after creation must come back before anyone is handed
      // the identity, and mkdir is idempotent.
      try {
        await mkdir(this.#coordinationCwd, { recursive: true });
      } catch {
        return failure(
          'persistence_failed',
          'WorkHub Coordination Session workspace is unavailable',
        );
      }

      let probe;
      try {
        probe = await this.#stores.probeStableSessionCreate(
          WORKHUB_COORDINATION_SESSION_ID,
          CREATE_FINGERPRINT,
        );
      } catch {
        this.#requestDrain();
        return failure('persistence_failed', 'WorkHub Coordination Session state is unavailable');
      }

      if (probe.kind === 'existing') {
        return validCoordinationIdentityHeader(probe.record.header)
          ? await this.#alignSession(probe.record)
          : identityConflict();
      }
      if (probe.kind === 'conflict') return identityConflict();

      let target: CoordinationCreateTarget;
      try {
        target = await this.#resolveCreateTarget();
      } catch (error) {
        return createTargetFailure(error);
      }

      try {
        const result = await this.#stores.createStableSession({
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          requestFingerprint: CREATE_FINGERPRINT,
          input: {
            ...target,
            permissionMode: COORDINATION_PERMISSION_MODE,
            collaborationMode: COORDINATION_COLLABORATION_MODE,
            orchestrationMode: COORDINATION_ORCHESTRATION_MODE,
            cwd: this.#coordinationCwd,
            projectId: null,
            name: 'WorkHub',
            role: WORKHUB_COORDINATION_SESSION_ROLE,
            toolProfile: COORDINATION_TOOL_PROFILE,
          },
        });
        if (result.kind === 'conflict') return identityConflict();
        if (
          !validCoordinationHeader(result.record.header) ||
          result.record.header.cwd !== this.#coordinationCwd
        ) {
          return identityConflict();
        }
        await this.#continuity.refreshCanonical(WORKHUB_COORDINATION_SESSION_ID, lease);
        return success();
      } catch {
        this.#requestDrain();
        return failure(
          'commit_outcome_unknown',
          'WorkHub Coordination Session creation outcome is unknown',
        );
      }
    });
  }

  /** Resolve a task's current segment directly, without the retired routing RPC. */
  async continueTaskFresh(
    input: WorkHubTaskContinueFromTurnInput,
    context: ConnectionContext,
  ): Promise<Extract<WorkHubCoordinationActResult, { disposition: 'create_new' }>> {
    const request = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
    if (!request)
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'Task continuation requires its currently active WorkHub model Turn',
      );
    const committed = await this.#stores.readWorkHubAssignment(input.actionId);
    const source = committed?.work?.continuesActionId
      ? await this.#stores.readWorkHubAssignment(committed.work.continuesActionId)
      : await this.#stores.readLatestWorkHubAssignment(input.taskId);
    if (!source || (source.work?.id ?? source.actionId) !== input.taskId)
      throw new WorkHubActionEffectFailure('not_found', 'The selected task does not exist');
    const target = await this.#actionGate.nativeTaskCandidate(source.targetSessionId);
    if (!target && !committed)
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        'The current task segment is unavailable; do not substitute a historical Session',
      );
    if (
      !committed &&
      (await this.#stores.readHeaderSnapshot(source.targetSessionId)).backend === 'plugin-executor'
    )
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        'Fresh continuation is not supported for this executor: recorded history is readable, but its provider has no Host history-tool bridge. Reuse the current segment instead.',
      );
    const workspace = committed?.create?.workspace ?? target?.workspace.target;
    if (!workspace)
      throw new WorkHubActionEffectFailure(
        'operation_unavailable',
        'The current task workspace is unavailable',
      );
    const result = await this.#actionGate.act(
      {
        actionId: input.actionId,
        delegationText: input.text,
        proposal: {
          disposition: 'create_new',
          title:
            committed?.create?.title ??
            (Array.from(source.taskTitle ?? source.targetSessionName)
              .slice(0, 64)
              .join('') ||
              'Continue work'),
        },
        continuation: { workId: input.taskId, sourceActionId: source.actionId, container: 'fresh' },
        create: { workspace },
        selectedTarget: {
          sessionId: source.targetSessionId,
          workspaceDigest: target ? digest(target.workspace) : digest({ replay: input.actionId }),
          sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
        },
        validateAuthority: async () => {
          if (
            !isDeepStrictEqual(
              await this.#executions.readActiveWorkHubRoutingRequest(input.turnId),
              request,
            )
          )
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'The continuing WorkHub Run is no longer active',
            );
        },
        ...(request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : {}),
        coordinationRunId: request.runId,
        inputOrigin: request.origin,
        userText: request.content.text,
        ...(request.content.attachments ? { attachments: request.content.attachments } : {}),
      },
      context,
      input.turnId,
    );
    if (result.disposition !== 'create_new' || result.workId !== input.taskId)
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'Fresh continuation changed task identity',
      );
    return result;
  }

  /** The shared task-input path never allocates another coordinator model Turn. */
  async continueTaskInput(
    input: WorkHubTaskInputRequest & WorkHubTaskInputProvenance,
    context: ConnectionContext,
    origin?: {
      readonly coordinationTurnId?: string;
      readonly attachments?: AttachmentRef[];
      readonly validateTaskInput: () => Promise<void>;
    },
  ): Promise<WorkHubCoordinationActResult> {
    const source = await this.#stores.readWorkHubAssignment(input.sourceActionId);
    if (
      !source ||
      source.delegationId !== input.sourceDelegationId ||
      (source.work?.id ?? source.actionId) !== input.workId ||
      (source.work?.generationId ?? source.actionId) !== input.generationId
    )
      throw new WorkHubActionGateFailure('action_conflict', 'The selected work source changed');
    const target = await this.#actionGate.nativeTaskCandidate(source.targetSessionId);
    if (!target)
      throw new WorkHubActionGateFailure(
        'candidate_unavailable',
        'The selected work target is unavailable',
      );
    const suffix = createHash('sha256').update(input.inputId).digest('hex').slice(0, 48);
    return this.#actionGate.act(
      {
        actionId: `whtinput_${suffix}`,
        userText: input.originalUserText ?? input.text,
        inputOrigin: input.inputOrigin ?? 'user',
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(origin?.attachments ? { attachments: origin.attachments } : {}),
        ...(origin ? { validateTaskInput: origin.validateTaskInput } : {}),
        delegationText: input.text,
        taskInput: input,
        continuation: { workId: input.workId, sourceActionId: input.sourceActionId },
        proposal: {
          disposition: 'delegate_existing',
        },
        selectedTarget: {
          sessionId: target.sessionId,
          workspaceDigest: digest(target.workspace),
          sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
        },
      },
      context,
      origin?.coordinationTurnId ?? source.coordinationTurnId,
    );
  }

  async #answer(
    input: WorkHubCoordinationAnswerInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.answer'>> {
    if (!input.text.trim()) {
      return turnFailure('operation_conflict', 'WorkHub answer text is empty');
    }
    const outcome = await this.#executions.startWorkHubCoordinationMessage(
      {
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        execution: {
          kind: 'workhub_coordination',
          inputDigest: digest({
            text: input.text,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          }),
        },
        archivedMessage: 'WorkHub Coordination Session is unavailable',
        // Historical v1 summaries still own their Turn identities. Reject a
        // fresh answer that would reuse one, even though new summaries are no longer written.
        prepareFreshContent: async () => {
          let recorded: readonly StoredMessage[];
          try {
            recorded = await this.#readSummaryMessages(input.turnId);
          } catch {
            return {
              kind: 'rejected',
              outcome: operationUnavailable(
                'WorkHub Coordination Turn identity could not be verified',
              ),
            };
          }
          return recorded.length > 0
            ? { kind: 'rejected', outcome: turnIdentityConflict() }
            : {
                kind: 'ready',
                content: normalizeMessageContent({
                  text: input.text,
                  ...(input.attachments ? { attachments: input.attachments } : {}),
                }),
              };
        },
      },
      context,
    );
    return outcome.ok ? { ok: true, result: { turnId: input.turnId } } : outcome;
  }

  /** Reads a historical v1 summary to preserve its durable Turn identity. */
  async #readSummaryMessages(turnId: string): Promise<readonly StoredMessage[]> {
    const throughSequence = await this.#stores.readTranscriptHighWaterSnapshot(
      WORKHUB_COORDINATION_SESSION_ID,
    );
    if (throughSequence === null) return [];
    return this.#stores.readTranscriptMessagesSnapshot(WORKHUB_COORDINATION_SESSION_ID, {
      messageIds: COORDINATION_SUMMARY_MESSAGE_KINDS.map((kind) =>
        coordinationSummaryMessageId(turnId, kind),
      ),
      throughSequence,
      maxBytes: COORDINATION_SUMMARY_READ_MAX_BYTES,
      maxMessages: COORDINATION_SUMMARY_MESSAGE_KINDS.length,
    });
  }

  /**
   * The workspace path is derived from the Host state root, so it moves with the
   * installation. Identity stays in the id/role pair and the durable path is
   * repaired in place — rejecting the drift would strand the one Session no
   * ordinary lifecycle operation is allowed to relocate or retire.
   */
  async #alignSession(
    record: SessionHeaderSnapshot,
  ): Promise<OperationOutcome<'workhub.coordination.resolve'>> {
    if (
      record.header.toolProfile !== undefined &&
      record.header.toolProfile !== 'workhub-coordination-v1' &&
      record.header.toolProfile !== COORDINATION_TOOL_PROFILE
    ) {
      return identityConflict();
    }
    if (
      record.header.cwd === this.#coordinationCwd &&
      record.header.toolProfile === COORDINATION_TOOL_PROFILE &&
      validCoordinationHeader(record.header)
    ) {
      return success();
    }
    // Resolving an old Session is the explicit durable upgrade boundary. Active
    // or recovering v1 Turns must finish under their original zero-tool ceiling.
    if (!this.#executions.isSessionExecutionIdle(WORKHUB_COORDINATION_SESSION_ID)) {
      return validCoordinationHeader(record.header)
        ? success()
        : failure(
            'operation_unavailable',
            'WorkHub Coordination Session is still executing or recovering',
          );
    }
    let repaired: SessionHeaderSnapshot;
    try {
      // Permission mode is a projection of the execution boundary. Transition
      // through Runtime authority to update both and retire cached backends
      // before changing the profile. An interrupted upgrade remains closed to
      // execution until a later resolve completes this versioned repair.
      const configured = await this.#transitionConfiguration({
        expectedRevision: record.revision,
        clearConnectionBlock: false,
        permissionModeOnly: false,
        configuration: {
          backend: record.header.backend,
          llmConnectionId: record.header.llmConnectionId,
          llmConnectionSlug: record.header.llmConnectionSlug,
          connectionLocked: record.header.connectionLocked,
          model: record.header.model,
          thinkingLevel: record.header.thinkingLevel,
          permissionMode: COORDINATION_PERMISSION_MODE,
          collaborationMode: COORDINATION_COLLABORATION_MODE,
          orchestrationMode: COORDINATION_ORCHESTRATION_MODE,
        },
      });
      repaired = await this.#stores.updateHeaderVersioned(
        WORKHUB_COORDINATION_SESSION_ID,
        {
          ...(record.header.cwd === this.#coordinationCwd ? {} : { cwd: this.#coordinationCwd }),
          ...(record.header.toolProfile === COORDINATION_TOOL_PROFILE
            ? {}
            : { toolProfile: COORDINATION_TOOL_PROFILE }),
        },
        configured.revision,
      );
    } catch {
      return failure(
        'persistence_failed',
        'WorkHub Coordination Session configuration could not be aligned',
      );
    }
    return validCoordinationHeader(repaired.header) && repaired.header.cwd === this.#coordinationCwd
      ? success()
      : identityConflict();
  }
}

/** Keeps a model-authority gap distinguishable from a failed authority read. */
function createTargetFailure(error: unknown): OperationOutcome<'workhub.coordination.resolve'> {
  if (error instanceof WorkHubDefaultModelRequiredError) {
    return failure('model_required', WORKHUB_COORDINATION_DEFAULT_MODEL_REQUIRED_MESSAGE);
  }
  if (error instanceof SessionOperationFailure && error.code === 'persistence_failed') {
    return failure('persistence_failed', error.message);
  }
  return failure('operation_conflict', 'WorkHub Coordination Session target is unavailable');
}

function validCoordinationIdentityHeader(header: SessionHeader): boolean {
  return (
    isWorkHubCoordinationSessionId(header.id) &&
    isWorkHubCoordinationSession(header) &&
    header.projectId === null &&
    !header.isArchived &&
    header.parentSessionId === undefined &&
    header.subagentParent === undefined &&
    header.conversationCopy === undefined &&
    header.revisionRootSessionId === undefined
  );
}

function validCoordinationHeader(header: SessionHeader): boolean {
  return (
    validCoordinationIdentityHeader(header) &&
    ((header.toolProfile === COORDINATION_TOOL_PROFILE &&
      header.permissionMode === COORDINATION_PERMISSION_MODE) ||
      (header.toolProfile === 'workhub-coordination-v1' && header.permissionMode === 'explore')) &&
    (header.collaborationMode ?? 'agent') === COORDINATION_COLLABORATION_MODE &&
    (header.orchestrationMode ?? 'default') === COORDINATION_ORCHESTRATION_MODE
  );
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function workHubDestructiveClaimIdentitySuffix(delegationId: string): string {
  return createHash('sha256').update(delegationId, 'utf8').digest('hex').slice(0, 48);
}

function coordinationSummaryMessageId(
  turnId: string,
  kind: (typeof COORDINATION_SUMMARY_MESSAGE_KINDS)[number],
): string {
  return `workhub_${createHash('sha256')
    .update(`${turnId}\0${kind}`, 'utf8')
    .digest('hex')
    .slice(0, 48)}`;
}

function success(): OperationOutcome<'workhub.coordination.resolve'> {
  return {
    ok: true,
    result: { sessionId: WORKHUB_COORDINATION_SESSION_ID },
  };
}

function identityConflict(): OperationOutcome<'workhub.coordination.resolve'> {
  return failure('operation_conflict', 'WorkHub Coordination Session identity is unavailable');
}

function failure(
  code: Extract<
    OperationOutcome<'workhub.coordination.resolve'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'workhub.coordination.resolve'> {
  return { ok: false, error: { code, message } };
}

/** Fresh-admission rejections for the answer's lease-scoped identity probe. */
function turnIdentityConflict() {
  return {
    ok: false,
    error: { code: 'operation_conflict', message: TURN_IDENTITY_CONFLICT_MESSAGE },
  } as const;
}

function operationUnavailable(message: string) {
  return { ok: false, error: { code: 'operation_unavailable', message } } as const;
}

function turnFailure(
  code: Extract<
    OperationOutcome<'workhub.coordination.answer'>,
    { readonly ok: false }
  >['error']['code'],
  message: string,
): OperationOutcome<'workhub.coordination.answer'> {
  return { ok: false, error: { code, message } };
}
