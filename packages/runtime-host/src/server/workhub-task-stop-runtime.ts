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
import { messageContentDigest, normalizeMessageContent } from '@maka/core/events';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
  type WorkHubDelegationStopRequestedMessage,
} from '@maka/core/session';
import { isWorkHubTaskStopSet, type WorkHubTaskStopTarget } from '@maka/core/workhub-task-stop';
import {
  isSessionNotFoundError,
  SessionMetadataConflictError,
  type ExecutionStoresWriter,
} from '@maka/storage/execution-stores';
import { WORKHUB_COORDINATION_TEXT_MAX_BYTES } from '../protocol/workhub-coordination.js';
import type {
  WorkHubTaskStopInput,
  WorkHubTaskStopResult,
  WorkHubTaskStopTargetResult,
} from '../protocol/workhub-task-stop.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import type { HostWorkHubCoordinationCoordinator } from './workhub-coordination-coordinator.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { createWorkHubEvidenceRuntime } from './workhub-evidence-runtime.js';
import {
  WorkHubActionEffectFailure,
  WorkHubActionGateFailure,
  type WorkHubRetirementResult,
} from './workhub-coordination-action-gate.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import { readCurrentWorkHubTaskSource } from './workhub-task-source.js';
import {
  workHubPendingStopBinding,
  workHubStopBindingMatches,
  type WorkHubStopTarget,
} from './workhub-stop-binding.js';

type Authority = NonNullable<
  Awaited<ReturnType<RootTurnCoordinator['readActiveWorkHubRoutingRequest']>>
>;
interface Captured {
  readonly source: WorkHubDelegationAssignedMessage;
  readonly target: WorkHubTaskStopTarget;
}
const digest = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const targetIdentity = (target: WorkHubTaskStopTarget) => [
  target.workId,
  target.generationId,
  target.sourceActionId,
  target.sourceDelegationId,
  target.targetSessionId,
  target.targetMessageId,
  target.executionBinding,
];
function conflict(message: string): never {
  throw new WorkHubActionEffectFailure('operation_conflict', message);
}

/** Complete an accepted exact stop set, never choose a new task or execution on replay. */
export function createWorkHubTaskStopRuntime(options: {
  readonly stores: ExecutionStoresWriter<'interactive'>;
  readonly admission: SessionAdmissionGate;
  readonly messages: HostMessageCoordinator;
  readonly executions: RootTurnCoordinator;
  readonly evidence?: Pick<ReturnType<typeof createWorkHubEvidenceRuntime>, 'taskExecution'>;
  readonly coordination: Pick<
    HostWorkHubCoordinationCoordinator,
    'prepareTaskStop' | 'resolveTaskStop'
  >;
  readonly readStopTarget: (
    source: WorkHubDelegationAssignedMessage,
    lease?: SessionAdmissionLease,
  ) => Promise<WorkHubStopTarget>;
  readonly retireTaskStop: (
    source: WorkHubDelegationAssignedMessage,
    request: WorkHubDelegationStopRequestedMessage,
    validate: (lease: SessionAdmissionLease) => Promise<boolean>,
  ) => Promise<WorkHubRetirementResult>;
  readonly requestForm?: HostInteractionCoordinator['requestForm'];
  readonly onError: (error: unknown) => void;
}) {
  const { stores, admission, executions } = options;
  const sessions = stores.sessionStore;

  function currentSource(workId: string, lease?: SessionAdmissionLease) {
    return readCurrentWorkHubTaskSource(
      {
        stores,
        executions,
        ...(options.evidence ? { evidence: options.evidence } : {}),
        messages: lease
          ? {
              readMessageExecutionDisposition: (sessionId, messageId) =>
                options.messages.readMessageExecutionDispositionAdmitted(
                  sessionId,
                  messageId,
                  lease,
                ),
            }
          : options.messages,
      },
      workId,
    );
  }
  function sourceMatches(source: WorkHubDelegationAssignedMessage, target: WorkHubTaskStopTarget) {
    return (
      (source.work?.id ?? source.actionId) === target.workId &&
      (source.work?.generationId ?? source.actionId) === target.generationId &&
      source.actionId === target.sourceActionId &&
      source.delegationId === target.sourceDelegationId &&
      source.targetSessionId === target.targetSessionId &&
      source.targetMessageId === target.targetMessageId
    );
  }
  async function eligible(item: Captured): Promise<boolean> {
    const head = await sessions.readLatestWorkHubAssignment(item.target.workId);
    if (
      !head ||
      (head.work?.id ?? head.actionId) !== item.target.workId ||
      (head.work?.generationId ?? head.actionId) !== item.target.generationId ||
      head.targetSessionId !== item.target.targetSessionId ||
      item.target.targetSessionId === WORKHUB_COORDINATION_SESSION_ID
    )
      return false;
    try {
      return !(await sessions.readHeaderSnapshot(item.target.targetSessionId)).isArchived;
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    }
  }
  async function validateFresh(items: readonly Captured[], lease: SessionAdmissionLease) {
    for (const item of items) {
      const current = await currentSource(item.target.workId, lease);
      if (
        !current ||
        !sourceMatches(current, item.target) ||
        !(await eligible(item)) ||
        !workHubStopBindingMatches(
          item.source,
          item.target.executionBinding,
          await options.readStopTarget(item.source, lease),
        )
      )
        conflict('The confirmed task set changed before Stop; no task was stopped');
    }
  }
  async function assertActive(input: WorkHubTaskStopInput, expected: Authority) {
    if (
      !isDeepStrictEqual(await executions.readActiveWorkHubRoutingRequest(input.turnId), expected)
    )
      conflict('Task stop belongs to a previous coordinator execution');
  }
  async function capture(workId: string): Promise<Captured> {
    const source = await currentSource(workId);
    if (!source)
      throw new WorkHubActionEffectFailure('not_found', 'The selected task does not exist');
    if (source.targetSessionId === WORKHUB_COORDINATION_SESSION_ID)
      conflict('The coordinator is not a task target');
    const target: WorkHubTaskStopTarget = {
      workId,
      generationId: source.work?.generationId ?? source.actionId,
      sourceActionId: source.actionId,
      sourceDelegationId: source.delegationId,
      targetSessionId: source.targetSessionId,
      targetMessageId: source.targetMessageId,
      executionBinding: (await options.readStopTarget(source)).binding,
    };
    return { source, target };
  }
  async function readReplayAuthority(turnId: string): Promise<Authority> {
    // A committed command may outlive the coordinator's model invocation. This
    // reads immutable origin facts only, and never authorizes a new dispatch.
    const root = await stores.agentRunStore.readRootTurnAdmission(
      WORKHUB_COORDINATION_SESSION_ID,
      turnId,
    );
    if (!root || root.execution.kind !== 'workhub_coordination' || root.normalizedInput === null)
      conflict('The original stop authority cannot be verified');
    let content = root.normalizedInput;
    const feedback = root.execution.feedback;
    if (feedback) {
      const source = await sessions.readWorkHubAssignment(feedback.actionId);
      if (
        !source ||
        source.delegationId !== feedback.delegationId ||
        source.targetSessionId !== feedback.targetSessionId
      )
        conflict('The original feedback source cannot be verified');
      content = normalizeMessageContent({
        text: source.userText,
        ...(source.attachments ? { attachments: source.attachments } : {}),
      });
    }
    return {
      content,
      runId: root.runId,
      origin: feedback ? 'feedback' : 'user',
      ...(root.userMessageId && !feedback ? { sourceMessageId: root.userMessageId } : {}),
    };
  }
  function fingerprint(
    input: WorkHubTaskStopInput,
    authority: Authority,
    items: readonly Captured[],
  ) {
    return digest([
      'task_stop_v1',
      input.turnId,
      authority.runId,
      authority.origin,
      authority.sourceMessageId ?? null,
      messageContentDigest(authority.content),
      input.taskIds,
      items.map((item) => targetIdentity(item.target)),
    ]);
  }
  async function claim(actionId: string, actionFingerprint: `sha256:${string}`, subject: string) {
    if (
      (await sessions.claimWorkHubAction({
        actionId,
        operation: 'stop',
        actionFingerprint,
        subject,
      })) === 'conflict'
    )
      conflict('This action identity already owns a different operation or stop set');
  }
  function child(
    input: WorkHubTaskStopInput,
    item: Captured,
    index: number,
    parent: `sha256:${string}`,
  ) {
    return index === 0
      ? { actionId: input.actionId, fingerprint: parent }
      : {
          actionId:
            'whts_' +
            createHash('sha256')
              .update(JSON.stringify([input.actionId, item.target.workId]))
              .digest('hex')
              .slice(0, 48),
          fingerprint: digest(['task_stop_child_v1', parent, targetIdentity(item.target)]),
        };
  }

  async function stop(input: WorkHubTaskStopInput): Promise<WorkHubTaskStopResult> {
    const existingClaim = await sessions.readWorkHubActionClaim(input.actionId);
    if (existingClaim && existingClaim.operation !== 'stop')
      conflict('Action identity belongs to another operation');
    const saved = existingClaim
      ? await sessions.readWorkHubStopRequest(existingClaim.subject, input.actionId)
      : undefined;
    let items: Captured[];
    let authority: Authority;
    if (saved) {
      if (
        saved.taskStop !== true ||
        !isWorkHubTaskStopSet(saved.stopSet) ||
        saved.stopSet.actionId !== input.actionId ||
        saved.coordinationTurnId !== input.turnId ||
        !isDeepStrictEqual(
          saved.stopSet.targets.map((target) => target.workId),
          input.taskIds,
        )
      )
        conflict('This action is not the requested committed task stop set');
      items = await Promise.all(
        saved.stopSet.targets.map(async (target) => {
          const source = await sessions.readWorkHubAssignment(target.sourceActionId);
          if (!source || !sourceMatches(source, target))
            conflict('The committed stop source cannot be verified');
          return { source, target };
        }),
      );
      authority = await readReplayAuthority(input.turnId);
    } else {
      const active = await executions.readActiveWorkHubRoutingRequest(input.turnId);
      if (!active) conflict('A new stop requires its active coordinator execution');
      authority = active;
      items = await Promise.all(input.taskIds.map(capture));
    }
    const parent = fingerprint(input, authority, items);
    if (
      saved &&
      (saved.actionFingerprint !== parent ||
        existingClaim?.actionFingerprint !== parent ||
        existingClaim.subject !== items[0]!.source.delegationId)
    )
      conflict('The committed stop manifest changed');
    const sessionIds = [
      WORKHUB_COORDINATION_SESSION_ID,
      ...items.map((item) => item.target.targetSessionId),
    ];
    let needsConfirmation = false;
    if (!saved)
      await admission.runMany(sessionIds, async (lease) => {
        await assertActive(input, authority);
        await validateFresh(items, lease);
        needsConfirmation = authority.origin !== 'user' || items.length > 1;
        for (const item of items)
          needsConfirmation ||= await sessions.hasOtherWorkHubStopTarget(
            input.turnId,
            item.target.workId,
          );
        if (needsConfirmation && !options.requestForm)
          throw new WorkHubActionEffectFailure(
            'operation_unavailable',
            'Stop confirmation is unavailable',
          );
        await claim(input.actionId, parent, items[0]!.source.delegationId);
      });
    if (needsConfirmation) {
      const answer = await options.requestForm!({
        sessionId: WORKHUB_COORDINATION_SESSION_ID,
        turnId: input.turnId,
        runId: authority.runId,
        requestId: createHash('sha256')
          .update(JSON.stringify(['workhub-task-stop-confirm-v1', input.actionId, parent]))
          .digest('hex'),
        create: async () => ({
          kind: 'form',
          toolUseId: input.actionId,
          message:
            '确认停止以下任务当前的受理或执行？\n' +
            items
              .map(
                (item, index) =>
                  `${index + 1}. ${Array.from(
                    item.source.taskTitle ?? item.source.targetSessionName,
                  )
                    .slice(0, 64)
                    .join('')}`,
              )
              .join('\n') +
            '\n只操作这组已捕获的执行，不授权停止后来的执行。',
          requester: { name: 'WorkHub' },
          fields: [
            {
              kind: 'single_select',
              name: 'stop',
              label: '确认目标集合',
              required: true,
              options: [
                { value: 'confirm', label: '确认停止以上任务' },
                { value: 'cancel', label: '保留任务' },
              ],
            },
          ],
        }),
      });
      if (answer.answer.action !== 'accept' || answer.answer.values.stop !== 'confirm')
        return { actionId: input.actionId, kind: 'cancelled', taskIds: input.taskIds };
    }
    const requests = await admission.runMany(sessionIds, async (lease) => {
      const raced = await sessions.readWorkHubStopRequest(
        items[0]!.source.delegationId,
        input.actionId,
      );
      const replay = saved !== undefined || raced !== undefined;
      if (
        raced &&
        (raced.actionFingerprint !== parent ||
          !isDeepStrictEqual(
            raced.stopSet?.targets.map(targetIdentity),
            items.map((item) => targetIdentity(item.target)),
          ))
      )
        conflict('The admitted task stop set changed');
      if (!replay) {
        await assertActive(input, authority);
        await validateFresh(items, lease);
      }
      for (const [index, item] of items.entries()) {
        const identity = child(input, item, index, parent);
        await claim(identity.actionId, identity.fingerprint, item.source.delegationId);
      }
      const userText =
        saved?.userText ??
        raced?.userText ??
        (authority.content.text.trim()
          ? truncateUtf8(authority.content.text, WORKHUB_COORDINATION_TEXT_MAX_BYTES, '…')
          : '[Host source reference: the original user message has no text; read its canonical source Turn.]');
      const prepared: WorkHubDelegationStopRequestedMessage[] = [];
      for (const [index, item] of items.entries()) {
        const identity = child(input, item, index, parent);
        prepared.push(
          await options.coordination.prepareTaskStop(
            {
              source: item.source,
              target: item.target,
              actionId: identity.actionId,
              actionFingerprint: identity.fingerprint,
              coordinationTurnId: input.turnId,
              userText,
              replay,
              ...(index === 0
                ? {
                    stopSet: {
                      actionId: input.actionId,
                      targets: items.map((entry) => entry.target),
                    },
                  }
                : {}),
            },
            lease,
          ),
        );
      }
      return prepared;
    });
    const results = new Map<string, WorkHubTaskStopTargetResult>();
    const queueFirst = [...items.entries()].sort(
      ([, a], [, b]) =>
        Number(b.target.executionBinding === workHubPendingStopBinding(b.source)) -
        Number(a.target.executionBinding === workHubPendingStopBinding(a.source)),
    );
    for (const [index, item] of queueFirst) {
      const request = requests[index]!;
      let resolved = await sessions.readWorkHubStopResolution(
        item.source.delegationId,
        request.actionId,
      );
      if (!resolved) {
        const removed =
          (await sessions.probeSessionRemoval(item.target.targetSessionId)).kind === 'removed';
        const result = removed
          ? { outcome: 'already_terminal' as const }
          : await options.retireTaskStop(item.source, request, () => eligible(item));
        if (result.outcome !== 'recovering')
          resolved = await options.coordination.resolveTaskStop({
            request,
            outcome: result.outcome,
            ...(result.targetTurnId ? { targetTurnId: result.targetTurnId } : {}),
          });
        else
          results.set(item.target.workId, {
            ...scope(item.target),
            outcome: 'recovering',
            ...(result.targetTurnId ? { targetTurnId: result.targetTurnId } : {}),
          });
      }
      if (resolved)
        results.set(item.target.workId, {
          ...scope(item.target),
          outcome: resolved.outcome,
          ...(resolved.targetTurnId ? { targetTurnId: resolved.targetTurnId } : {}),
        });
    }
    return {
      actionId: input.actionId,
      kind: 'result',
      targets: items.map((item) => results.get(item.target.workId)!),
    };
  }
  return {
    stop,
    handlers: {
      'workhub.tasks.stop': async (input) => {
        try {
          return { ok: true, result: await stop(input) };
        } catch (error) {
          if (error instanceof WorkHubActionEffectFailure)
            return {
              ok: false,
              error: {
                code: error.code === 'unauthorized' ? 'operation_unavailable' : error.code,
                message: error.message,
              },
            };
          if (
            error instanceof WorkHubActionGateFailure ||
            error instanceof SessionMetadataConflictError
          )
            return { ok: false, error: { code: 'operation_conflict', message: error.message } };
          if (isSessionNotFoundError(error))
            return {
              ok: false,
              error: { code: 'not_found', message: 'The selected task is unavailable' },
            };
          options.onError(error);
          return {
            ok: false,
            error: {
              code: 'commit_outcome_unknown',
              message:
                'Task stop state could not be confirmed; retry the same action, not a new target set',
            },
          };
        }
      },
    } satisfies Pick<OperationHandlerMap, 'workhub.tasks.stop'>,
  };
}

function scope(target: WorkHubTaskStopTarget) {
  return {
    workId: target.workId,
    generationId: target.generationId,
    sourceActionId: target.sourceActionId,
    sourceDelegationId: target.sourceDelegationId,
    targetSessionId: target.targetSessionId,
  };
}
