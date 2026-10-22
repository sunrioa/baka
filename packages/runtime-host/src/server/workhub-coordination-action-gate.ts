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

import type { AttachmentRef } from '@maka/core/events';
import { createHash } from 'node:crypto';
import type {
  SessionHeader,
  SessionStatus,
  WorkHubActionClaim,
  WorkHubActionClaimOutcome,
  WorkHubActionOperation,
  WorkHubCreateDefaults,
  WorkHubDelegationAssignedMessage,
  WorkHubDelegationCreateSpec,
  WorkHubDelegationDisposition,
  WorkHubDelegationReplacementRequestedMessage,
  WorkHubDelegationStopRequestedMessage,
  WorkHubDelegationStopResolvedMessage,
  WorkHubDelegationStopOutcome,
  WorkHubWorkBinding,
} from '@maka/core/session';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  isWorkHubCoordinationSessionTarget,
} from '@maka/core/session';
import type {
  WorkHubCoordinationActResult,
  WorkspaceTarget,
  WorkspaceProjection,
} from '../protocol/index.js';
import type { ConnectionContext } from './operation-dispatcher.js';
import { readWorkHubStopProjection } from './workhub-stop-projection.js';
import type {
  WorkHubTaskInputRequest,
  WorkHubTaskInputProvenance,
} from '@maka/core/workhub-task-input';
import type {
  WorkHubTargetExecutionAuthority,
  WorkHubTargetExecutionPreparationInput,
} from './workhub-target-execution-authority.js';

/** Host-admitted native start or same-task input; never a model routing proposal. */
export interface WorkHubAdmittedAction {
  readonly actionId: string;
  readonly proposal:
    | { readonly disposition: 'create_new'; readonly title: string }
    | { readonly disposition: 'delegate_existing' };
  readonly delegationText?: string;
  readonly newWorkDefaults?: WorkHubCreateDefaults;
  readonly sourceMessageId?: string;
  readonly inputOrigin?: 'user' | 'feedback';
  readonly taskStart?: { readonly turnId: string; readonly title: string };
  readonly validateAuthority?: () => Promise<void>;
  readonly continuation?: {
    readonly workId: string;
    readonly sourceActionId: string;
    readonly container?: 'fresh';
  };
  readonly taskInput?: WorkHubTaskInputRequest & WorkHubTaskInputProvenance;
  readonly validateTaskInput?: () => Promise<void>;
  readonly create?: { readonly workspace: WorkspaceTarget };
  readonly userText: string;
  readonly attachments?: AttachmentRef[];
  readonly coordinationRunId?: string;
  readonly selectedTarget?: {
    readonly sessionId: string;
    readonly workspaceDigest: string;
    readonly sourceTask?: { readonly actionId: string; readonly delegationId: string };
  };
}

type AdmittedWorkHubAction = WorkHubAdmittedAction & { readonly coordinationTurnId?: string };

const SIDE_CONVERSATION_LABEL = 'mode:side_conversation';
const ACTION_REPLAY_MAX_ITEMS = 256;

export type WorkHubActionGateSession = Pick<
  SessionHeader,
  | 'id'
  | 'role'
  | 'cwd'
  | 'projectId'
  | 'createdAt'
  | 'lastMessageAt'
  | 'name'
  | 'labels'
  | 'isArchived'
  | 'status'
  | 'statusUpdatedAt'
  | 'subagentParent'
>;

export interface WorkHubActionGateEffects {
  listSessions(): Promise<readonly WorkHubActionGateSession[]>;
  readonly targetExecution?: WorkHubTargetExecutionAuthority;
  claimAction(claim: WorkHubActionClaim): Promise<WorkHubActionClaimOutcome>;
  readAssignment(actionId: string): Promise<WorkHubDelegationAssignedMessage | undefined>;
  readLatestWorkAssignment(workId: string): Promise<WorkHubDelegationAssignedMessage | undefined>;
  listActiveAssignments(
    targetSessionId: string,
    includeStopped?: boolean,
  ): Promise<readonly WorkHubDelegationAssignedMessage[]>;
  /** Historical retirement facts remain read-only continuation preconditions. */
  readReplacement(
    delegationId: string,
  ): Promise<WorkHubDelegationReplacementRequestedMessage | undefined>;
  readStopRequest(
    delegationId: string,
    actionId?: string,
    latest?: true,
  ): Promise<WorkHubDelegationStopRequestedMessage | undefined>;
  readStopResolution(
    delegationId: string,
    actionId?: string,
  ): Promise<WorkHubDelegationStopResolvedMessage | undefined>;
  assign(
    input: WorkHubDelegationAssignmentInput,
    context: ConnectionContext,
  ): Promise<{ readonly turnId?: string; readonly messageId?: string; readonly steered?: true }>;
}

/** Existing native task Stop uses this claim; the Gate has no retirement writer. */
export interface WorkHubDelegationRetirementClaim {
  readonly cancellationClaimId: string;
  readonly cause: 'direct_stop';
  readonly executionBinding?: string;
}

export interface WorkHubRetirementResult {
  readonly outcome: WorkHubDelegationStopOutcome | 'recovering';
  readonly targetTurnId?: string;
  readonly cancelledWaitRequestId?: string;
}

export interface WorkHubDelegationAssignmentInput {
  readonly taskTitle?: string;
  readonly inputOrigin?: 'user' | 'feedback';
  readonly taskInput?: WorkHubTaskInputRequest & WorkHubTaskInputProvenance;
  readonly work?: WorkHubWorkBinding;
  /** Rechecked under the target admission lease, only before a fresh assignment. */
  readonly validateFreshTarget?: () => Promise<void>;
  /** Internal source proof/lane, never a caller-selected new execution identity. */
  readonly freshSource?: {
    readonly assignment: WorkHubDelegationAssignedMessage;
    readonly workspace: WorkspaceProjection;
  };
  readonly targetExecutionPreparation?: WorkHubTargetExecutionPreparationInput;
  readonly coordinationTurnId?: string;
  readonly actionId: string;
  readonly actionFingerprint: `sha256:${string}`;
  readonly targetSessionId: string;
  readonly targetSessionName: string;
  readonly disposition: WorkHubDelegationDisposition;
  readonly userText: string;
  readonly attachments?: AttachmentRef[];
  readonly delegationText?: string;
  readonly create?: WorkHubDelegationCreateSpec;
}

export interface WorkHubDelegationStopResolutionInput {
  readonly request: WorkHubDelegationStopRequestedMessage;
  readonly outcome: WorkHubDelegationStopOutcome;
  readonly targetTurnId?: string;
  readonly cancelledWaitRequestId?: string;
}

export type WorkHubActionEffectFailureCode =
  | 'host_not_ready'
  | 'host_draining'
  | 'operation_unavailable'
  | 'not_found'
  | 'session_archived'
  | 'session_busy'
  | 'operation_conflict'
  | 'persistence_failed'
  | 'commit_outcome_unknown'
  | 'internal_failure'
  | 'unauthorized';

export class WorkHubActionEffectFailure extends Error {
  constructor(
    readonly code: WorkHubActionEffectFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionEffectFailure';
  }
}

export type WorkHubActionGateFailureCode =
  | 'candidate_set_stale'
  | 'candidate_unavailable'
  | 'self_route'
  | 'action_conflict';

export class WorkHubActionGateFailure extends Error {
  constructor(
    readonly code: WorkHubActionGateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkHubActionGateFailure';
  }
}

interface ActionReplay {
  readonly requestFingerprint: string;
  readonly result: Promise<WorkHubCoordinationActResult>;
}

/** Native create/delegate/fresh admission, with durable replay and unchanged target authority. */
export class WorkHubCoordinationActionGate {
  readonly #effects: WorkHubActionGateEffects;
  readonly #actions = new Map<string, ActionReplay>();

  constructor(effects: WorkHubActionGateEffects) {
    this.#effects = effects;
  }

  /** Exact target projection; no bounded snapshot or opaque candidate-set reference. */
  async nativeTaskCandidate(sessionId: string): Promise<WorkHubTaskCandidate | undefined> {
    const session = (await this.#effects.listSessions()).find((item) => item.id === sessionId);
    return session ? workHubTaskCandidate(session) : undefined;
  }

  act(
    input: WorkHubAdmittedAction,
    context: ConnectionContext,
    admittedTurnId?: string,
  ): Promise<WorkHubCoordinationActResult> {
    const proposal = input.proposal;
    if (!input.userText.trim()) {
      return Promise.reject(
        new WorkHubActionGateFailure('action_conflict', 'WorkHub action text is empty'),
      );
    }
    if (
      !proposal ||
      (proposal.disposition !== 'create_new' && proposal.disposition !== 'delegate_existing') ||
      (proposal.disposition === 'delegate_existing' && !input.selectedTarget)
    )
      return Promise.reject(
        new WorkHubActionGateFailure(
          'action_conflict',
          'Native task assignment requires an exact target or creation',
        ),
      );
    if (input.delegationText !== undefined && !input.delegationText.trim())
      return Promise.reject(
        new WorkHubActionGateFailure('action_conflict', 'Invalid WorkHub delegation text'),
      );
    if (proposal.disposition === 'create_new' && !proposal.title.trim())
      return Promise.reject(
        new WorkHubActionGateFailure('action_conflict', 'WorkHub creation title is empty'),
      );
    const fingerprint = actionFingerprint(input);
    const requestFingerprint = actionRequestFingerprint(input);
    const replay = this.#actions.get(input.actionId);
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        return Promise.reject(
          new WorkHubActionGateFailure(
            'action_conflict',
            'WorkHub action identity belongs to a different proposal',
          ),
        );
      }
      return replay.result;
    }

    const result = this.#act(
      { ...input, ...(admittedTurnId ? { coordinationTurnId: admittedTurnId } : {}) },
      fingerprint,
      context,
    );
    const action = { requestFingerprint, result };
    this.#actions.set(input.actionId, action);
    // Successful actions remain a Host-lifetime fast path. Rejections release
    // the slot so admission can retry. Durable identity belongs to the
    // durable native assignment and its action claim.
    void result.catch(() => {
      if (this.#actions.get(input.actionId) === action) {
        this.#actions.delete(input.actionId);
      }
    });
    this.#boundReplays();
    return result;
  }

  async #act(
    input: AdmittedWorkHubAction,
    fingerprint: `sha256:${string}`,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    const proposal = input.proposal;

    const durable = await this.#effects.readAssignment(input.actionId);
    if (durable) {
      if (
        durable.replacesActionId ||
        durable.replacesDelegationId ||
        durable.actionFingerprint !== fingerprint
      )
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub action identity belongs to a different proposal',
        );
      return this.#assign(assignmentInputFromRecord(durable), context);
    }

    if (proposal.disposition === 'create_new') {
      if (!input.create) {
        throw new WorkHubActionGateFailure(
          'action_conflict',
          'WorkHub creation context is unavailable',
        );
      }
      const sessionId = workHubCreatedSessionId(input.actionId);
      if (input.continuation?.container === 'fresh') {
        const selected = input.selectedTarget;
        if (!selected)
          throw new WorkHubActionGateFailure(
            'action_conflict',
            'Fresh continuation requires its fixed source',
          );
        const validate = async () => {
          await input.validateAuthority?.();
          const source = await this.#continuedSource(input, selected.sessionId);
          const candidate = await this.nativeTaskCandidate(selected.sessionId);
          if (!source || !candidate || digest(candidate.workspace) !== selected.workspaceDigest)
            throw new WorkHubActionGateFailure(
              'candidate_set_stale',
              'The source workspace changed before fresh continuation',
            );
          return { assignment: source, workspace: candidate.workspace };
        };
        const freshSource = await validate();
        const source = freshSource.assignment;
        return this.#assign(
          {
            ...delegationAssignment(input, fingerprint, sessionId, proposal.title),
            taskTitle: await this.#taskTitle(source),
            work: {
              id: source.work?.id ?? source.actionId,
              generationId: input.actionId,
              continuesActionId: source.actionId,
              ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
            },
            freshSource,
            validateFreshTarget: async () => {
              await validate();
            },
          },
          context,
        );
      }
      return this.#assign(
        delegationAssignment(input, fingerprint, sessionId, proposal.title),
        context,
      );
    }

    const selected = input.selectedTarget!;
    const target = await this.nativeTaskCandidate(selected.sessionId);
    if (!target || digest(target.workspace) !== selected.workspaceDigest)
      throw new WorkHubActionGateFailure(
        'candidate_set_stale',
        'WorkHub target is no longer in the selected workspace',
      );
    this.#assertTarget(target);
    const validateSource = async () => {
      await input.validateAuthority?.();
      await this.#continuedSource(input, target.sessionId);
    };
    await validateSource();
    const sourceRef = input.selectedTarget?.sourceTask;
    const source = sourceRef ? await this.#effects.readAssignment(sourceRef.actionId) : undefined;
    if (sourceRef && !source)
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'The selected work source became unavailable',
      );

    return this.#assign(
      {
        ...delegationAssignment(input, fingerprint, target.sessionId, target.sessionName),
        ...(source
          ? {
              taskTitle: await this.#taskTitle(source),
              work: {
                id: source.work?.id ?? source.actionId,
                generationId: source.work?.generationId ?? source.actionId,
                continuesActionId: source.actionId,
                ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
              },
            }
          : {}),
        ...this.#targetExecutionPreparation(input, target.sessionId, target.sessionName),
        ...(input.selectedTarget
          ? {
              validateFreshTarget: async () => {
                await validateSource();
                const fresh = await this.nativeTaskCandidate(input.selectedTarget!.sessionId);
                if (!fresh || digest(fresh.workspace) !== input.selectedTarget!.workspaceDigest)
                  throw new WorkHubActionGateFailure(
                    'candidate_set_stale',
                    'The selected work changed before admission',
                  );
                this.#assertTarget(fresh);
              },
            }
          : {}),
      },
      context,
    );
  }

  async #taskTitle(source: WorkHubDelegationAssignedMessage): Promise<string> {
    const origin = await this.#effects.readAssignment(source.work?.id ?? source.actionId);
    return (
      origin?.taskTitle ?? origin?.targetSessionName ?? source.taskTitle ?? source.targetSessionName
    );
  }

  async #hasPendingStop(delegationId: string): Promise<boolean> {
    const stop = await readWorkHubStopProjection(
      {
        readWorkHubStopRequest: (id, actionId, latest) =>
          this.#effects.readStopRequest(id, actionId, latest),
        readWorkHubStopResolution: (id, actionId) => this.#effects.readStopResolution(id, actionId),
      },
      delegationId,
    );
    return stop?.retires === true && stop.resolution === undefined;
  }

  async #continuedSource(input: AdmittedWorkHubAction, targetSessionId: string) {
    await input.validateTaskInput?.();
    const ref = input.selectedTarget?.sourceTask;
    if (!ref) return undefined;
    const source = await this.#effects.readAssignment(ref.actionId);
    const latest = source
      ? await this.#effects.readLatestWorkAssignment(source.work?.id ?? source.actionId)
      : undefined;
    if (
      !source ||
      !latest ||
      (latest.work?.generationId ?? latest.actionId) !==
        (source.work?.generationId ?? source.actionId) ||
      (input.continuation &&
        (input.continuation.sourceActionId !== source.actionId ||
          input.continuation.workId !== (source.work?.id ?? source.actionId))) ||
      source.delegationId !== ref.delegationId ||
      source.targetSessionId !== targetSessionId ||
      !(await this.#effects.listActiveAssignments(targetSessionId, !!input.continuation)).some(
        (link) => link.actionId === ref.actionId && link.delegationId === ref.delegationId,
      ) ||
      (await this.#effects.readReplacement(source.delegationId)) ||
      (await this.#hasPendingStop(source.delegationId))
    )
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'The selected task was retired or changed before continuation',
      );
    return source;
  }

  async #claimAction(
    actionId: string,
    operation: WorkHubActionOperation,
    actionFingerprint: `sha256:${string}`,
    subject: string,
  ): Promise<void> {
    const outcome = await this.#effects.claimAction({
      actionId,
      operation,
      actionFingerprint,
      subject,
    });
    if (outcome === 'conflict') {
      throw new WorkHubActionGateFailure(
        'action_conflict',
        'WorkHub action identity already owns a different operation',
      );
    }
  }

  async #assign(
    assignment: WorkHubDelegationAssignmentInput,
    context: ConnectionContext,
  ): Promise<WorkHubCoordinationActResult> {
    await this.#claimAction(
      assignment.actionId,
      assignment.disposition,
      assignment.actionFingerprint,
      assignment.targetSessionId,
    );
    await this.#prepareTargetExecution(assignment, context);
    const validateFreshTarget =
      assignment.disposition === 'delegate_existing' && this.#effects.targetExecution
        ? async () => {
            await assignment.validateFreshTarget?.();
            await this.#effects.targetExecution!.assertReady(assignment.targetSessionId);
          }
        : assignment.validateFreshTarget;
    const admitted = await this.#effects.assign(
      validateFreshTarget ? { ...assignment, validateFreshTarget } : assignment,
      context,
    );
    return {
      disposition: assignment.disposition,
      ...(assignment.work ? { workId: assignment.work.id } : {}),
      targetSessionId: assignment.targetSessionId,
      ...(admitted.turnId ? { targetTurnId: admitted.turnId } : {}),
      ...(admitted.messageId ? { targetMessageId: admitted.messageId } : {}),
      ...(admitted.steered ? { steered: true as const } : {}),
    } as WorkHubCoordinationActResult;
  }

  #assertTarget(target: WorkHubTaskCandidate): void {
    if (target.sessionId === WORKHUB_COORDINATION_SESSION_ID)
      throw new WorkHubActionGateFailure('self_route', 'WorkHub cannot delegate to itself');
  }

  #targetExecutionPreparation(
    input: AdmittedWorkHubAction,
    targetSessionId: string,
    targetSessionName: string,
  ): Pick<WorkHubDelegationAssignmentInput, 'targetExecutionPreparation'> {
    return input.coordinationTurnId && input.coordinationRunId
      ? {
          targetExecutionPreparation: {
            actionId: input.actionId,
            coordinationTurnId: input.coordinationTurnId,
            coordinationRunId: input.coordinationRunId,
            targetSessionId,
            targetSessionName,
          },
        }
      : {};
  }

  async #prepareTargetExecution(
    input: Pick<WorkHubDelegationAssignmentInput, 'targetExecutionPreparation'> & {
      readonly actionId?: string;
      readonly targetSessionId?: string;
      readonly targetSessionName?: string;
      readonly coordinationTurnId?: string;
      readonly coordinationRunId?: string;
    },
    context: ConnectionContext | undefined,
  ): Promise<void> {
    const authority = this.#effects.targetExecution;
    const preparation =
      input.targetExecutionPreparation ??
      (input.actionId &&
      input.targetSessionId &&
      input.targetSessionName &&
      input.coordinationTurnId &&
      input.coordinationRunId
        ? {
            actionId: input.actionId,
            targetSessionId: input.targetSessionId,
            targetSessionName: input.targetSessionName,
            coordinationTurnId: input.coordinationTurnId,
            coordinationRunId: input.coordinationRunId,
          }
        : undefined);
    if (!authority || !preparation || !context) return;
    await authority.prepare(preparation, context);
  }

  #boundReplays(): void {
    while (this.#actions.size > ACTION_REPLAY_MAX_ITEMS) {
      const oldest = this.#actions.keys().next().value;
      if (oldest === undefined) return;
      this.#actions.delete(oldest);
    }
  }
}

export interface WorkHubTaskCandidate {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly workspace: WorkspaceProjection;
  readonly state: SessionStatus;
  readonly updatedAt: number;
}

/** Read-only single-Session eligibility, shared by native tasks and manual inspection. */
export function workHubTaskCandidate(
  session: WorkHubActionGateSession,
): WorkHubTaskCandidate | undefined {
  if (
    session.isArchived ||
    isWorkHubCoordinationSessionTarget(session) ||
    session.role !== undefined ||
    session.subagentParent !== undefined ||
    session.labels.includes(SIDE_CONVERSATION_LABEL)
  )
    return undefined;
  return {
    sessionId: session.id,
    sessionName: session.name,
    workspace: workspaceProjection(session),
    state: session.status,
    updatedAt: updatedAt(session),
  };
}

function delegationAssignment(
  input: AdmittedWorkHubAction,
  actionFingerprint: `sha256:${string}`,
  targetSessionId: string,
  targetSessionName: string,
): WorkHubDelegationAssignmentInput {
  const create = input.create;
  const base = {
    actionId: input.actionId,
    work: {
      id: input.actionId,
      generationId: input.actionId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    },
    coordinationTurnId: input.coordinationTurnId ?? input.actionId,
    actionFingerprint,
    ...(input.taskStart === undefined ? {} : { taskTitle: input.taskStart.title }),
    ...(input.validateAuthority ? { validateFreshTarget: input.validateAuthority } : {}),
    targetSessionId,
    targetSessionName,
    disposition: input.proposal.disposition,
    userText: input.userText,
    ...(input.taskInput ? { taskInput: input.taskInput } : {}),
    ...(input.inputOrigin ? { inputOrigin: input.inputOrigin } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
  } as const;
  if (input.proposal.disposition === 'delegate_existing') return base;
  if (!create) {
    throw new WorkHubActionGateFailure(
      'action_conflict',
      'WorkHub creation context is unavailable',
    );
  }
  return {
    ...base,
    create: {
      title: input.proposal.title,
      workspace: create.workspace,
      ...(input.newWorkDefaults ? { defaults: input.newWorkDefaults } : {}),
    },
  };
}

export function workHubCreatedSessionId(actionId: string): string {
  return `whs_${hash(`create\0${actionId}`).slice(0, 48)}`;
}

function workspaceProjection(session: WorkHubActionGateSession): WorkspaceProjection {
  return {
    target:
      typeof session.projectId === 'string'
        ? { kind: 'project', projectId: session.projectId }
        : { kind: 'host_path', path: session.cwd },
    hostCwd: session.cwd,
  };
}

function updatedAt(session: WorkHubActionGateSession): number {
  return session.lastMessageAt ?? session.statusUpdatedAt ?? session.createdAt;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${hash(JSON.stringify(value))}`;
}

function actionFingerprint(input: WorkHubAdmittedAction): `sha256:${string}` {
  const common = {
    ...(input.taskInput ? { taskInput: input.taskInput } : {}),
    ...(input.taskStart === undefined ? {} : { taskStart: input.taskStart }),
    ...(input.continuation
      ? { continuation: input.continuation }
      : input.selectedTarget
        ? { selectedTarget: taskStartReplayTarget(input) }
        : {}),
    userText: input.userText,
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.newWorkDefaults ? { newWorkDefaults: input.newWorkDefaults } : {}),
    ...(input.delegationText === undefined ? {} : { delegationText: input.delegationText }),
  };
  const proposal = input.proposal;
  return digest({
    ...common,
    disposition: proposal.disposition,
    ...(proposal.disposition === 'delegate_existing'
      ? {
          // Preserve already-admitted native fingerprints without a snapshot/ref protocol.
          candidateRef: input.taskStart
            ? input.selectedTarget!.sessionId
            : `native_${hash(input.selectedTarget!.sessionId).slice(0, 48)}`,
        }
      : { title: proposal.title, workspace: input.create?.workspace }),
  });
}

function actionRequestFingerprint(input: WorkHubAdmittedAction): `sha256:${string}` {
  // Coordination execution identity changes when the Host retries the same
  // durable action after a process failure. It authorizes where a repair Form
  // is shown, but is not part of the user's proposal or replay identity.
  // The retry's source Message is provenance, not a different durable action.
  const {
    coordinationRunId: _coordinationRunId,
    sourceMessageId: _sourceMessageId,
    inputOrigin: _inputOrigin,
    validateTaskInput: _validateTaskInput,
    validateAuthority: _validateAuthority,
    ...proposal
  } = input;
  if (input.continuation) {
    // The canonical work/source pair owns replay. Fresh workspace observations
    // are admission preconditions, not a new routing decision on every retry.
    const { selectedTarget: _selectedTarget, ...bound } = proposal;
    return digest(bound);
  }
  if (input.taskStart !== undefined && input.selectedTarget)
    return digest({ ...proposal, selectedTarget: taskStartReplayTarget(input) });
  return digest(proposal);
}

function taskStartReplayTarget(input: WorkHubAdmittedAction) {
  // A modern start fixes the Session identity. Its current workspace is still
  // revalidated before admission, but moving/renaming it after a committed
  // assignment must not turn a lost-response replay into another task.
  return input.taskStart !== undefined && !input.continuation && !input.selectedTarget?.sourceTask
    ? { sessionId: input.selectedTarget!.sessionId }
    : input.selectedTarget;
}

function assignmentInputFromRecord(
  assignment: WorkHubDelegationAssignedMessage,
): WorkHubDelegationAssignmentInput {
  return {
    actionId: assignment.actionId,
    ...(assignment.work ? { work: assignment.work } : {}),
    ...(assignment.taskTitle === undefined ? {} : { taskTitle: assignment.taskTitle }),
    ...(assignment.inputOrigin ? { inputOrigin: assignment.inputOrigin } : {}),
    coordinationTurnId: assignment.coordinationTurnId,
    actionFingerprint: assignment.actionFingerprint,
    targetSessionId: assignment.targetSessionId,
    targetSessionName: assignment.targetSessionName,
    disposition: assignment.disposition,
    userText: assignment.userText,
    ...(assignment.attachments ? { attachments: assignment.attachments } : {}),
    ...(assignment.delegationText === undefined
      ? {}
      : { delegationText: assignment.delegationText }),
    ...(assignment.create ? { create: assignment.create } : {}),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
