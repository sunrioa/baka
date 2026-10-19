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
  WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
  WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
  isWorkHubCoordinationSession,
  isWorkHubCoordinationSessionId,
  type SessionHeader,
  type StoredMessage,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationReplacementAbortedMessage,
  type WorkHubDelegationReplacementRequestedMessage,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import type { ExecutionSessionWriter, SessionHeaderSnapshot } from '@maka/storage/execution-stores';
import type {
  OperationOutcome,
  WorkHubCoordinationActResult,
  WorkHubCoordinationActFromTurnInput,
  WorkHubCoordinationAnswerInput,
  WorkHubCoordinationConfigureModelInput,
} from '../protocol/index.js';
import { WORKHUB_COORDINATION_TEXT_MAX_BYTES } from '../protocol/index.js';
import {
  WORKHUB_COORDINATION_DEFAULT_MODEL_REQUIRED_MESSAGE,
  type WorkHubCoordinationSelectAndDelegateInput,
  type WorkHubTaskContinueInput,
  type WorkHubWorksQueryInput,
  type WorkHubContextObservation,
} from '../protocol/workhub-coordination.js';
import { createWorkHubWorkIndex, WorkHubWorkCursorError } from './workhub-work-index.js';
import type {
  WorkHubTaskStartInput,
  WorkHubTaskAskInput,
  WorkHubTaskChoice,
} from '../protocol/workhub-task-actions.js';
import type {
  ConnectionContext,
  OperationHandlerMap,
  WorkHubCoordinationOperationHandlerMap,
} from './operation-dispatcher.js';
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
  | 'probeSessionRemoval'
  | 'probeStableSessionCreate'
  | 'readHeaderSnapshot'
  | 'readCatalogRecord'
  | 'readWorkHubAssignment'
  | 'readLatestWorkHubAssignment'
  | 'readWorkHubAssignmentsPage'
  | 'readActiveWorkHubAssignmentsByTarget'
  | 'readWorkHubReplacement'
  | 'readWorkHubReplacementAbort'
  | 'readWorkHubSupersession'
  | 'readWorkHubStopRequest'
  | 'hasOtherWorkHubStopTarget'
  | 'readWorkHubStopResolution'
  | 'readTranscriptHighWaterSnapshot'
  | 'readTranscriptMessagesSnapshot'
  | 'readMessagesAfter'
  | 'updateHeaderVersioned'
>;

type CoordinationExecutions = Pick<
  RootTurnCoordinator,
  | 'startWorkHubCoordinationMessage'
  | 'runWorkHubCoordinationOperation'
  | 'isSessionExecutionIdle'
  | 'readActiveWorkHubRoutingRequest'
>;

type WorkHubResumeResult =
  | {
      readonly outcome: 'resume_started';
      readonly targetTurnId: string;
    }
  | { readonly outcome: 'already_running' };

type CoordinationSessionActions = Pick<
  WorkHubActionGateEffects,
  'assign' | 'readDelegationRetirement' | 'retireDelegation' | 'withReplacementCapacity'
> & {
  resumeDelegation(
    assignment: WorkHubDelegationAssignedMessage,
    context: ConnectionContext,
    actionId: string,
    validateFreshTarget: () => Promise<void>,
    prepareTargetExecution?: () => Promise<void>,
    assertTargetExecutionReady?: () => Promise<void>,
  ): Promise<WorkHubResumeResult>;
};

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
  readonly handlers: WorkHubCoordinationOperationHandlerMap &
    Pick<OperationHandlerMap, 'workhub.tasks.start' | 'workhub.tasks.ask'> = {
    'workhub.tasks.start': (input, context) => this.#startTask(input, context),
    'workhub.tasks.ask': (input) => this.#askTask(input),
    'workhub.coordination.works': (input) => this.#works(input),
    'workhub.coordination.continue': (input, context) => this.#continueTask(input, context),
    'workhub.coordination.selectAndDelegate': (input, context) =>
      this.#selectAndDelegate(input, context),
    'workhub.coordination.resolve': () => this.#resolve(),
    'workhub.coordination.query': () => this.#query(),
    'workhub.coordination.configureModel': (input) => this.#configureModel(input),
    'workhub.coordination.answer': (input, context) => this.#answer(input, context),

    'workhub.coordination.candidates': () => this.#candidates(),

    'workhub.coordination.actFromTurn': (input, context) => this.#actFromTurn(input, context),
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
  readonly #workIndex: ReturnType<typeof createWorkHubWorkIndex>;
  readonly #readDelegationRetirement: HostWorkHubCoordinationCoordinatorOptions['sessionActions']['readDelegationRetirement'];
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
    this.#readDelegationRetirement = options.sessionActions.readDelegationRetirement;
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
      // Read without the admission lease: it is a durable point lookup by
      // primary key, and the claim it finds was committed under that lease.
      readActionClaim: (actionId) => this.#stores.readWorkHubActionClaim(actionId),
      probeTargetRemoval: async (sessionId) =>
        (await this.#stores.probeSessionRemoval(sessionId)).kind,
      readAssignment: (actionId) => this.#stores.readWorkHubAssignment(actionId),
      readLatestWorkAssignment: (workId) => this.#stores.readLatestWorkHubAssignment(workId),
      // This lookup is advisory. Stop and replacement both repeat their exact
      // proof under the Coordination and target admissions before writing.
      listActiveAssignments: (targetSessionId, includeStopped) =>
        this.#stores.readActiveWorkHubAssignmentsByTarget(
          [targetSessionId],
          undefined,
          includeStopped,
        ),
      readReplacement: (delegationId) => this.#stores.readWorkHubReplacement(delegationId),
      readReplacementAbort: (delegationId) =>
        this.#stores.readWorkHubReplacementAbort(delegationId),
      readSupersession: (delegationId) => this.#stores.readWorkHubSupersession(delegationId),
      readStopRequest: (delegationId, actionId) =>
        this.#stores.readWorkHubStopRequest(delegationId, actionId),
      readStopResolution: (delegationId, actionId) =>
        this.#stores.readWorkHubStopResolution(delegationId, actionId),

      assign: options.sessionActions.assign,
      withReplacementCapacity: options.sessionActions.withReplacementCapacity,
      prepareReplacement: (input) => this.#prepareReplacement(input),
      abortReplacement: (input) => this.#abortReplacement(input),
      prepareStop: (input) => this.#prepareStop(input),
      resolveStop: (input) => this.#resolveStop(input),
      readDelegationRetirement: options.sessionActions.readDelegationRetirement,
      retireDelegation: options.sessionActions.retireDelegation,
      resume: async (input, context) => ({
        disposition: 'resume_work',
        targetSessionId: input.source.targetSessionId,
        ...(await options.sessionActions.resumeDelegation(
          input.source,
          context,
          input.actionId,
          input.validateFreshTarget,
          input.prepareTargetExecution,
          input.assertTargetExecutionReady,
        )),
      }),
    });
    this.#workIndex = createWorkHubWorkIndex({
      stores: this.#stores,
      ...(options.readWorkContext ? { readContext: options.readWorkContext } : {}),
      isEligible: async (sessionId) =>
        Boolean(await this.#actionGate.nativeTaskCandidate(sessionId)),
    });
  }

  #prepareReplacement(
    input: Parameters<WorkHubActionGateEffects['prepareReplacement']>[0],
  ): Promise<WorkHubDelegationReplacementRequestedMessage> {
    const suffix = workHubDestructiveClaimIdentitySuffix(input.replacesDelegationId);
    return this.#commitCoordinationFact({
      admissionSessionIds: [WORKHUB_COORDINATION_SESSION_ID, input.replacedTargetSessionId],
      read: () => this.#stores.readWorkHubReplacement(input.replacesDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whp_${suffix}`,
        turnId: existing?.turnId ?? input.coordinationTurnId ?? input.actionId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
        kind: 'delegation_replacement_requested',
        actionId: input.actionId,
        actionFingerprint: input.actionFingerprint,
        coordinationTurnId:
          existing?.coordinationTurnId ?? input.coordinationTurnId ?? input.actionId,
        targetSessionId: input.targetSessionId,
        targetSessionName: input.targetSessionName,
        disposition: input.disposition,
        userText: input.userText,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
        replacesActionId: input.replacesActionId,
        replacesDelegationId: input.replacesDelegationId,
        replacedTargetSessionId: input.replacedTargetSessionId,
        replacedTargetMessageId: input.replacedTargetMessageId,
        ...(input.create ? { create: input.create } : {}),
      }),
      conflictMessage: 'WorkHub action identity belongs to a different replacement',
      beforeAppend: async () => {
        const latest = (
          await this.#stores.readActiveWorkHubAssignmentsByTarget(
            [input.replacedTargetSessionId],
            1,
          )
        )[0];
        if (
          latest?.actionId !== input.replacesActionId ||
          latest.delegationId !== input.replacesDelegationId
        ) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub correction source is no longer the latest active delegation',
          );
        }
        const head = await this.#stores.readLatestWorkHubAssignment(
          latest.work?.id ?? latest.actionId,
        );
        if (
          !head ||
          (head.work?.generationId ?? head.actionId) !==
            (latest.work?.generationId ?? latest.actionId)
        )
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub correction source belongs to a retired work generation',
          );
        const stopRequest = await this.#stores.readWorkHubStopRequest(input.replacesDelegationId);
        if (stopRequest) {
          const resolution = await this.#stores.readWorkHubStopResolution(
            input.replacesDelegationId,
          );
          if (resolution?.outcome !== 'not_owned') {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub delegation already has a stop claim',
            );
          }
        }
        const header = await this.#stores.readHeaderSnapshot(WORKHUB_COORDINATION_SESSION_ID);
        if (!validCoordinationHeader(header)) {
          throw new WorkHubActionEffectFailure(
            'operation_conflict',
            'WorkHub Coordination Session identity is unavailable',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub replacement intent outcome is unknown',
    });
  }

  async #prepareStop(
    input: Parameters<WorkHubActionGateEffects['prepareStop']>[0],
  ): Promise<WorkHubDelegationStopRequestedMessage> {
    let suffix: string;
    const source = await this.#stores.readWorkHubAssignment(input.stopsActionId);
    if (
      !source ||
      source.delegationId !== input.stopsDelegationId ||
      source.targetMessageId !== input.targetMessageId
    )
      throw new WorkHubActionGateFailure('action_conflict', 'WorkHub stop source changed');
    const workId = source.work?.id ?? source.actionId;
    const authority = input.coordinationTurnId
      ? await this.#executions.readActiveWorkHubRoutingRequest(input.coordinationTurnId)
      : undefined;
    let confirmed = false;
    let confirmedBinding: string | undefined;
    const commit = () =>
      this.#commitCoordinationFact<WorkHubDelegationStopRequestedMessage>({
        // Only the two Sessions this stop can change: the one whose delegation
        // ends, and the Coordination Session that records it. Holding a lane for
        // every Session with an active delegation would serialize unrelated
        // delegation traffic behind one stop, and the proof below needs no lane
        // it does not already hold.
        admissionSessionIds: [WORKHUB_COORDINATION_SESSION_ID, input.targetSessionId],
        read: async () => {
          // Choose the slot from the same admitted snapshot as the write.
          const first = await this.#stores.readWorkHubStopRequest(input.stopsDelegationId);
          suffix = workHubDestructiveClaimIdentitySuffix(
            first && first.actionId !== input.actionId
              ? JSON.stringify([input.stopsDelegationId, input.actionId])
              : input.stopsDelegationId,
          );
          return this.#stores.readWorkHubStopRequest(input.stopsDelegationId, input.actionId);
        },
        build: async (existing, lease) => {
          const executionBinding = existing
            ? existing.executionBinding
            : await this.#readStopBinding?.(source, lease);
          return {
            type: 'workhub_coordination',
            id: `whq_${suffix}`,
            turnId: existing?.turnId ?? input.coordinationTurnId ?? input.actionId,
            ts: existing?.ts ?? Date.now(),
            schemaVersion: WORKHUB_COORDINATION_STOP_SCHEMA_VERSION,
            kind: 'delegation_stop_requested',
            actionId: input.actionId,
            actionFingerprint: input.actionFingerprint,
            coordinationTurnId:
              existing?.coordinationTurnId ?? input.coordinationTurnId ?? input.actionId,
            stopsActionId: input.stopsActionId,
            stopsDelegationId: input.stopsDelegationId,
            targetSessionId: input.targetSessionId,
            targetMessageId: input.targetMessageId,
            targetSessionName: input.targetSessionName,
            userText: input.userText,
            ...(existing && existing.workId === undefined ? {} : { workId }),
            ...(executionBinding === undefined ? {} : { executionBinding }),
          };
        },
        conflictMessage: 'WorkHub delegation already has a different stop claim',
        beforeAppend: async (lease) => {
          if (
            confirmed &&
            (confirmedBinding === undefined ||
              !this.#readStopBinding ||
              !(this.#isStopBindingCurrent
                ? await this.#isStopBindingCurrent(source, confirmedBinding, lease)
                : (await this.#readStopBinding(source, lease)) === confirmedBinding))
          )
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'Stop confirmation belongs to a different target execution',
            );
          const head = await this.#stores.readLatestWorkHubAssignment(workId);
          if (
            !head ||
            (head.work?.generationId ?? head.actionId) !==
              (source.work?.generationId ?? source.actionId)
          )
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub stop source is no longer the current task generation',
            );
          // This count and the claim are in one admitted lane. Splitting stop
          // into concurrent tool calls cannot turn every target into the first one.
          if (
            !confirmed &&
            (authority?.origin !== 'user' ||
              (await this.#stores.hasOtherWorkHubStopTarget(
                input.coordinationTurnId ?? input.actionId,
                workId,
              )))
          )
            throw new WorkHubStopConfirmationRequired();
          const [replacement, supersession, activeAssignments] = await Promise.all([
            this.#stores.readWorkHubReplacement(input.stopsDelegationId),
            this.#stores.readWorkHubSupersession(input.stopsDelegationId),
            this.#stores.readActiveWorkHubAssignmentsByTarget(
              [input.targetSessionId],
              undefined,
              true,
            ),
          ]);
          if (replacement || supersession) {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub delegation is already being replaced',
            );
          }
          // Held lanes make this the last moment the one-target proof can change.
          // It is proved from opaque delegation identity, so a concurrent rename
          // is harmless while a concurrent delegation to the same Session is not.
          const currentSource = activeAssignments.find(
            (assignment) =>
              assignment.actionId === input.stopsActionId &&
              assignment.delegationId === input.stopsDelegationId,
          );
          if (!currentSource) {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'WorkHub stop target does not identify one active durable delegation',
            );
          }
          // A delegation whose work already finished stays linked but competes
          // for nothing; only work that could still be stopped makes the target
          // ambiguous.
          for (const competitor of activeAssignments) {
            if (competitor.delegationId === currentSource.delegationId) continue;
            if ((await this.#readDelegationRetirement(competitor, lease)) !== 'retired') {
              throw new WorkHubActionGateFailure(
                'action_conflict',
                'WorkHub stop target does not identify one active durable delegation',
              );
            }
          }
        },
        unknownOutcomeMessage: 'WorkHub stop request outcome is unknown',
      });
    try {
      return await commit();
    } catch (error) {
      if (!(error instanceof WorkHubStopConfirmationRequired)) throw error;
      if (!authority || !input.coordinationTurnId || !this.#requestForm || !this.#readStopBinding)
        throw new WorkHubActionEffectFailure(
          'operation_unavailable',
          'This stop requires user confirmation',
        );
      const binding = await this.#readStopBinding(source);
      const choice = await this.#requestForm({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.coordinationTurnId,
        runId: authority.runId,
        requestId: createHash('sha256')
          .update(JSON.stringify(['workhub-stop', authority.runId, input, workId, binding]))
          .digest('hex'),
        create: async () => ({
          kind: 'form',
          toolUseId: input.actionId,
          message: `确认停止任务「${Array.from(input.targetSessionName).slice(0, 64).join('')}」？这只针对当前受理或执行，不授权停止后来的执行。`,
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select',
              name: 'stop',
              label: '停止此任务',
              required: true,
              options: [
                { value: 'confirm', label: '确认停止' },
                { value: 'cancel', label: '保留任务' },
              ],
            },
          ],
        }),
      });
      if (choice.answer.action !== 'accept' || choice.answer.values.stop !== 'confirm')
        throw new WorkHubActionEffectFailure(
          'operation_conflict',
          'Stop was not confirmed; no task was stopped',
        );
      const current = await this.#executions.readActiveWorkHubRoutingRequest(
        input.coordinationTurnId,
      );
      if (current?.runId !== authority.runId)
        throw new WorkHubActionEffectFailure(
          'operation_conflict',
          'Stop confirmation belongs to a previous coordination execution',
        );
      confirmed = true;
      confirmedBinding = binding;
      return commit();
    }
  }

  #resolveStop(
    input: Parameters<WorkHubActionGateEffects['resolveStop']>[0],
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
        ...(input.targetTurnId ? { targetTurnId: input.targetTurnId } : {}),
      }),
      additionalMessages: async (resolved) => {
        const primary = await this.#stores.readWorkHubStopResolution(request.stopsDelegationId);
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

  #abortReplacement(
    input: Parameters<WorkHubActionGateEffects['abortReplacement']>[0],
  ): Promise<WorkHubDelegationReplacementAbortedMessage> {
    const replacement = input.replacement;
    const suffix = workHubDestructiveClaimIdentitySuffix(replacement.replacesDelegationId);
    return this.#commitCoordinationFact({
      read: () => this.#stores.readWorkHubReplacementAbort(replacement.replacesDelegationId),
      build: (existing) => ({
        type: 'workhub_coordination',
        id: `whb_${suffix}`,
        turnId: replacement.coordinationTurnId,
        ts: existing?.ts ?? Date.now(),
        schemaVersion: WORKHUB_COORDINATION_REPLACEMENT_SCHEMA_VERSION,
        kind: 'delegation_replacement_aborted',
        actionId: replacement.actionId,
        actionFingerprint: replacement.actionFingerprint,
        coordinationTurnId: replacement.coordinationTurnId,
        abortedActionId: replacement.replacesActionId,
        abortedDelegationId: replacement.replacesDelegationId,
        targetSessionId: replacement.targetSessionId,
        reason: input.reason,
      }),
      conflictMessage: 'WorkHub replacement already has a different abort outcome',
      beforeAppend: async () => {
        const supersession = await this.#stores.readWorkHubSupersession(
          replacement.replacesDelegationId,
        );
        if (supersession) {
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub replacement already committed its supersession',
          );
        }
      },
      unknownOutcomeMessage: 'WorkHub replacement abort outcome is unknown',
    });
  }

  #commitCoordinationFact<T extends StoredMessage>(options: {
    readonly admissionSessionIds?: readonly string[];
    readonly read: () => Promise<T | undefined>;
    readonly build: (existing: T | undefined, lease: SessionAdmissionLease) => T | Promise<T>;
    readonly additionalMessages?: (requested: T) => Promise<StoredMessage[]>;
    readonly conflictMessage: string;
    readonly beforeAppend: (lease: SessionAdmissionLease) => Promise<void>;
    readonly unknownOutcomeMessage: string;
  }): Promise<T> {
    return this.#admission.runMany(
      options.admissionSessionIds ?? [WORKHUB_COORDINATION_SESSION_ID],
      async (lease) => {
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
      },
    );
  }

  async #works(
    input: WorkHubWorksQueryInput,
  ): Promise<OperationOutcome<'workhub.coordination.works'>> {
    try {
      return { ok: true, result: await this.#workIndex(input) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof WorkHubWorkCursorError ? 'operation_conflict' : 'persistence_failed',
          message:
            error instanceof WorkHubWorkCursorError
              ? error.message
              : 'WorkHub work sources are unavailable',
        },
      };
    }
  }

  async #candidates(): Promise<OperationOutcome<'workhub.coordination.candidates'>> {
    try {
      const result = await this.#actionGate.candidates();
      // One bounded read for the whole page. The candidate set is already
      // capped, and a per-candidate lookup would rescan each target's history.
      const latestByTarget = new Map(
        (
          await this.#stores.readActiveWorkHubAssignmentsByTarget(
            result.candidates.map(({ sessionId }) => sessionId),
            1,
            true,
          )
        ).map((assignment) => [assignment.targetSessionId, assignment.actionId]),
      );
      return {
        ok: true,
        result: {
          candidateSetId: result.candidateSetId,
          candidates: result.candidates.map((candidate) => {
            const latestDelegationActionId = latestByTarget.get(candidate.sessionId);
            return latestDelegationActionId
              ? { ...candidate, latestDelegationActionId }
              : candidate;
          }),
        },
      };
    } catch {
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub Session candidates are unavailable',
        },
      };
    }
  }

  async #selectAndDelegate(
    input: WorkHubCoordinationSelectAndDelegateInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.selectAndDelegate'>> {
    try {
      const authority = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
      if (!authority || !this.#requestForm) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Target selection requires an active Coordination Turn',
          },
        };
      }
      // The interaction identity binds the complete operation and original user authority.
      // Its durable answer can be replayed without rebuilding (or interpreting) the offer.
      const requestId = createHash('sha256')
        .update(
          JSON.stringify({
            input,
            runId: authority.runId,
            content: authority.content,
          }),
        )
        .digest('hex');
      const choice = await this.#requestForm({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        runId: authority.runId,
        requestId,
        create: async () => {
          if (await this.#stores.readWorkHubAssignment(input.actionId)) {
            throw new WorkHubActionGateFailure(
              'action_conflict',
              'This action identity already belongs to another selection',
            );
          }
          const page = await this.#actionGate.candidates();
          if (page.candidateSetId !== input.candidateSetId) {
            throw new WorkHubActionGateFailure(
              'candidate_set_stale',
              'Discover fresh candidates before requesting a target choice',
            );
          }
          const options = input.candidateRefs.map((ref) => {
            const candidate = page.candidates.find((item) => item.candidateRef === ref);
            if (!candidate)
              throw new WorkHubActionGateFailure(
                'candidate_unavailable',
                'Target choice contains an unavailable candidate',
              );
            // Keep labels inside the shared form wire budget; identity is the opaque value.
            const label = `${candidate.sessionName} — ${candidate.workspace.hostCwd}`;
            let bounded = '';
            for (const character of label) {
              if (Buffer.byteLength(bounded + character, 'utf8') > 190) break;
              bounded += character;
            }
            return {
              // An opaque, durable binding: only an exact offered value is accepted by
              // the form authority. Names and model-written answers never resolve identity.
              value: JSON.stringify([ref, candidate.sessionId, digest(candidate.workspace)]),
              label: page.candidates.some(
                (other) =>
                  other.sessionId !== candidate.sessionId &&
                  other.sessionName === candidate.sessionName &&
                  other.workspace.hostCwd === candidate.workspace.hostCwd,
              )
                ? `${bounded} [${candidate.sessionId.slice(0, 12)}]`
                : bounded,
            };
          });
          return {
            kind: 'form',
            toolUseId: input.actionId,
            message: 'Choose the work to continue',
            requester: { name: 'WorkHub' },
            fields: [
              {
                kind: 'single_select',
                name: 'target',
                label: 'Work / Workspace',
                required: true,
                options,
              },
            ],
          };
        },
      });
      if (choice.answer.action !== 'accept') return { ok: true, result: { kind: 'cancelled' } };
      const value = choice.answer.values.target;
      const binding: unknown = typeof value === 'string' ? JSON.parse(value) : undefined;
      if (
        !Array.isArray(binding) ||
        binding.length !== 3 ||
        !binding.every((part) => typeof part === 'string') ||
        !input.candidateRefs.includes(binding[0])
      ) {
        return {
          ok: false,
          error: {
            code: 'operation_conflict',
            message: 'Target choice does not belong to this operation',
          },
        };
      }
      if (
        Date.now() - choice.createdAt > 10 * 60_000 &&
        !(await this.#stores.readWorkHubAssignment(input.actionId))
      ) {
        return {
          ok: false,
          error: {
            code: 'candidate_set_stale',
            message: 'Target choice expired; discover candidates and ask again',
          },
        };
      }
      const [offeredRef, sessionId, workspaceDigest] = binding as [string, string, string];
      const freshAuthority = await this.#executions.readActiveWorkHubRoutingRequest(input.turnId);
      if (freshAuthority?.runId !== authority.runId) {
        return {
          ok: false,
          error: { code: 'operation_conflict', message: 'The selecting Run is no longer active' },
        };
      }
      // Re-read active authority after waiting. The Gate performs fresh candidate validation
      // and durable action replay before it admits any target execution.
      const outcome = await this.#actFromTurn(
        {
          turnId: input.turnId,
          actionId: input.actionId,
          proposal: { disposition: 'delegate_existing', candidateRef: offeredRef },
          candidateSetId: input.candidateSetId,
          delegationText: input.delegationText,
        },
        context,
        { sessionId, workspaceDigest },
      );
      return outcome.ok
        ? { ok: true, result: { kind: 'delegated', result: outcome.result } }
        : outcome;
    } catch (error) {
      if (error instanceof RuntimeInteractionFailStopError) throw error;
      return {
        ok: false,
        error: {
          code:
            error instanceof WorkHubActionGateFailure
              ? error.code === 'candidate_set_stale'
                ? 'candidate_set_stale'
                : 'operation_conflict'
              : error instanceof RuntimeInteractionAdmissionRejectedError
                ? 'operation_conflict'
                : 'persistence_failed',
          message: error instanceof Error ? error.message : 'Target selection is unavailable',
        },
      };
    }
  }

  async #startTask(
    input: WorkHubTaskStartInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.tasks.start'>> {
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
      const outcome = await this.#actFromTurn(
        {
          turnId: input.turnId,
          actionId: input.actionId,
          proposal: input.sessionRef
            ? { disposition: 'delegate_existing', candidateRef: input.sessionRef }
            : { disposition: 'create_new', title: Array.from(input.title).slice(0, 64).join('') },
          delegationText: input.text,
          ...(!input.sessionRef
            ? { create: input.create, newWorkDefaults: input.newWorkDefaults }
            : {}),
        },
        context,
        target,
        input.title,
      );
      if (!outcome.ok)
        return {
          ok: false,
          error: {
            ...outcome.error,
            code:
              outcome.error.code === 'candidate_set_stale'
                ? 'operation_conflict'
                : outcome.error.code,
          },
        };
      if (
        (outcome.result.disposition !== 'create_new' &&
          outcome.result.disposition !== 'delegate_existing') ||
        outcome.result.workId !== input.actionId
      )
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'Task start did not admit independent work',
        );
      return { ok: true, result: outcome.result };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof WorkHubActionGateFailure ? 'operation_conflict' : 'persistence_failed',
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

  async #actFromTurn(
    input: WorkHubCoordinationActFromTurnInput,
    context: ConnectionContext,
    selectedTarget?: WorkHubAdmittedAction['selectedTarget'],
    taskTitle?: string,
  ): Promise<OperationOutcome<'workhub.coordination.actFromTurn'>> {
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
    if (!request) {
      return {
        ok: false,
        error: {
          code: 'operation_conflict',
          message: 'WorkHub action requires its currently active model Turn',
        },
      };
    }
    let proposal: WorkHubAdmittedAction['proposal'];
    let continuation: WorkHubAdmittedAction['continuation'];
    let continuationCreate: WorkHubAdmittedAction['create'];
    if ('disposition' in input.proposal && input.proposal.disposition === 'continue_work') {
      try {
        const source = await this.#stores.readWorkHubAssignment(input.proposal.sourceActionId);
        if (!source || (source.work?.id ?? source.actionId) !== input.proposal.workId)
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'The selected source does not belong to this work',
          );
        const target = await this.#actionGate.nativeTaskCandidate(source.targetSessionId);
        const committed = await this.#stores.readWorkHubAssignment(input.actionId);
        if (!target && !committed)
          throw new WorkHubActionGateFailure(
            'candidate_unavailable',
            'The selected work is unavailable; query its source instead of substituting a historical Session',
          );
        const fresh = input.proposal.container === 'fresh';
        continuation = {
          workId: input.proposal.workId,
          sourceActionId: source.actionId,
          ...(fresh ? { container: 'fresh' as const } : {}),
        };
        selectedTarget = {
          sessionId: source.targetSessionId,
          workspaceDigest: target ? digest(target.workspace) : digest({ replay: input.actionId }),
          sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
        };
        if (fresh) {
          const workspace = committed?.create?.workspace ?? target?.workspace.target;
          if (!workspace)
            throw new WorkHubActionGateFailure(
              'candidate_unavailable',
              'The original workspace is unavailable',
            );
          continuationCreate = { workspace };
          proposal = {
            disposition: 'create_new',
            title:
              committed?.create?.title ??
              (Array.from(source.targetSessionName).slice(0, 64).join('') || 'Continue work'),
          };
        } else proposal = { disposition: 'delegate_existing', candidateRef: source.actionId };
      } catch (error) {
        return {
          ok: false,
          error: {
            code:
              error instanceof WorkHubActionGateFailure
                ? 'operation_conflict'
                : 'persistence_failed',
            message: error instanceof Error ? error.message : 'WorkHub work resolution failed',
          },
        };
      }
    } else {
      proposal = input.proposal;
    }
    const { turnId: _turnId, create, ...fields } = input;
    const action = { ...fields, proposal };
    const carriesAttachments =
      'disposition' in action.proposal ||
      ('operation' in action.proposal && action.proposal.operation === 'correct');
    try {
      const resolvedCreate =
        continuationCreate ??
        (create === undefined
          ? undefined
          : {
              workspace:
                create.workspace.kind === 'isolated'
                  ? await this.#isolatedTaskWorkspace(input.actionId)
                  : create.workspace,
            });
      return {
        ok: true,
        result: await this.#actionGate.act(
          {
            ...action,
            ...(continuation ? { continuation } : {}),
            ...(request.sourceMessageId ? { sourceMessageId: request.sourceMessageId } : {}),
            ...(resolvedCreate ? { create: resolvedCreate } : {}),
            ...(selectedTarget ? { selectedTarget } : {}),
            ...(taskTitle === undefined
              ? {}
              : {
                  taskStart: { turnId: input.turnId, title: taskTitle },
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
                }),
            coordinationRunId: request.runId,
            inputOrigin: request.origin,
            userText: request.content.text,
            ...(carriesAttachments && request.content.attachments
              ? { attachments: request.content.attachments }
              : {}),
          },
          context,
          input.turnId,
        ),
      };
    } catch (error) {
      if (error instanceof WorkHubActionEffectFailure) {
        return {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        };
      }
      if (error instanceof WorkHubActionGateFailure) {
        return {
          ok: false,
          error: {
            code:
              error.code === 'target_waiting_for_user'
                ? 'session_busy'
                : error.code === 'candidate_set_stale'
                  ? 'candidate_set_stale'
                  : 'operation_conflict',
            message: error.message,
          },
        };
      }
      return {
        ok: false,
        error: {
          code: 'persistence_failed',
          message: 'WorkHub action authority is unavailable',
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
          candidateRef: `native_${createHash('sha256').update(target.sessionId).digest('hex').slice(0, 48)}`,
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

  async #continueTask(
    input: WorkHubTaskContinueInput,
    context: ConnectionContext,
  ): Promise<OperationOutcome<'workhub.coordination.continue'>> {
    const reject = (code: 'operation_conflict' | 'persistence_failed', message: string) => ({
      ok: false as const,
      error: { code, message },
    });
    if (!input.text.trim())
      return reject('operation_conflict', 'WorkHub continuation text is empty');
    const actionId = `whcontinue_${createHash('sha256').update(input.turnId).digest('hex').slice(0, 48)}`;
    try {
      const source = await this.#stores.readWorkHubAssignment(input.actionId);
      if (!source || source.delegationId !== input.delegationId)
        return reject('operation_conflict', 'The original task identity changed');
      const header = await this.#stores.readHeaderSnapshot(source.targetSessionId);
      if (header.isArchived || header.subagentParent)
        return reject('operation_conflict', 'The original task is unavailable');
      const target = await this.#actionGate.nativeTaskCandidate(source.targetSessionId);
      if (!target)
        return reject('operation_conflict', 'The original task is no longer eligible for WorkHub');
      // This is an explicit native user command, not agent output or an approval.
      // The existing root owner binds retries to the same text and source. The
      // Gate persists the new delegation and keeps busy targets on their FIFO.
      const outcome = await this.#executions.runWorkHubCoordinationOperation(
        {
          sessionId: WORKHUB_COORDINATION_SESSION_ID,
          turnId: input.turnId,
          execution: {
            kind: 'workhub_coordination',
            operation: 'action',
            actionId,
            inputDigest: digest({
              ...input,
              targetSessionId: target.sessionId,
              workspaceDigest: digest(target.workspace),
            }),
          },
          archivedMessage: 'WorkHub Coordination Session is unavailable',
          prepareFreshContent: async () => ({
            kind: 'ready',
            content: normalizeMessageContent({ text: input.text }),
          }),
          operation: async (turnId) => ({
            actionId,
            userText: input.text,
            result: await this.#actionGate.act(
              {
                actionId,
                userText: input.text,
                delegationText: input.text,
                // Native selection is fixed by selectedTarget, not the mutable candidate
                // set. A stable opaque ref also keeps partial-effect retries identical.
                proposal: {
                  disposition: 'delegate_existing',
                  candidateRef: `native_${createHash('sha256').update(target.sessionId).digest('hex').slice(0, 48)}`,
                },
                selectedTarget: {
                  sessionId: target.sessionId,
                  workspaceDigest: digest(target.workspace),
                  sourceTask: { actionId: source.actionId, delegationId: source.delegationId },
                },
              },
              context,
              turnId,
            ),
          }),
        },
        context,
      );
      return outcome.ok && outcome.result.result.disposition === 'delegate_existing'
        ? { ok: true, result: outcome.result.result }
        : outcome.ok
          ? reject('operation_conflict', 'The continuation did not delegate to its original task')
          : outcome;
    } catch (error) {
      return reject(
        error instanceof WorkHubActionGateFailure ? 'operation_conflict' : 'persistence_failed',
        error instanceof Error ? error.message : 'Task continuation is unavailable',
      );
    }
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

class WorkHubStopConfirmationRequired extends Error {}

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
