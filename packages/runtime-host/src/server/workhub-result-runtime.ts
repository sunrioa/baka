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
import {
  WORKHUB_INBOX_MAX_ITEMS,
  type WorkHubPendingInteraction,
} from '../protocol/workhub-interactions.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';
import type { HostMessageCoordinator } from './message-coordinator.js';
import type { HostInteractionCoordinator } from './interaction-coordinator.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import { projectSessionInteractions } from './interaction-projection.js';
import type { HostTaskGrantCoordinator } from './task-grant-coordinator.js';
import {
  HostWorkHubResultCoordinator,
  type WorkHubResultObservation,
} from './workhub-result-coordinator.js';

export function createWorkHubResultRuntime(options: {
  stores: ExecutionStoresWriter<'interactive'>;
  executions: RootTurnCoordinator;
  messages: HostMessageCoordinator;
  interactions: HostInteractionCoordinator;
  taskGrants?: HostTaskGrantCoordinator;
  admission: SessionAdmissionGate;
  readTurnResult(sessionId: string, turnId: string): Promise<string>;
  acquireResidency(): { release(): void };
  onError(error: unknown): void;
}) {
  const { stores, executions, messages, admission, readTurnResult } = options;
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
  async function isActive(assignment: WorkHubDelegationAssignedMessage): Promise<boolean> {
    try {
      const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
      if (header.isArchived) return false;
      const active = await stores.sessionStore.readActiveWorkHubAssignmentsByTarget([
        assignment.targetSessionId,
      ]);
      if (!active.some((a) => a.delegationId === assignment.delegationId && a.returnResults))
        return false;
      // Retirement intent takes precedence even before its final receipt exists.
      if (await stores.sessionStore.readWorkHubReplacement(assignment.delegationId)) return false;
      if (await stores.sessionStore.readWorkHubStopRequest(assignment.delegationId)) {
        const resolution = await stores.sessionStore.readWorkHubStopResolution(
          assignment.delegationId,
        );
        if (resolution?.outcome !== 'not_owned') return false;
      }
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
      const identity = await executions.readLatestRootTurnLineage({
        sessionId: assignment.targetSessionId,
        turnId: disposition.turnId,
        runId: disposition.runId,
      });
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
            'The delegated task needs user input. Desktop users can handle the original request in the WorkHub task inbox. Acknowledge it and continue other work; do not relay a blocking question by default. Session-wide grants remain at the original task.',
          details: requests.map((p) => ({ interactionId: p.interactionId, request: p.request })),
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
      return {
        turnId: identity.turnId,
        runId: identity.runId,
        eventKey: snapshot.terminalEventId,
        status: snapshot.status,
        result: answer,
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
  async function taskRequests(
    assignment: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
    lanes: readonly string[] = [],
  ) {
    if (!(await isActive(assignment))) return [];
    const disposition = await messages.readMessageExecutionDispositionAdmitted(
      assignment.targetSessionId,
      assignment.targetMessageId,
      lease,
    );
    // A historical shared Turn does not confer authority over manual work.
    if (disposition.kind !== 'owned_root') return [];
    const identity = await executions.readLatestRootTurnLineage({
      sessionId: assignment.targetSessionId,
      turnId: disposition.turnId,
      runId: disposition.runId,
    });
    const snapshot = await executions.read(identity);
    if (snapshot.status !== 'waiting_for_user' && snapshot.status !== 'running') return [];
    const requests = (await pending(assignment.targetSessionId)).filter(
      (p) =>
        p.sessionId === identity.sessionId &&
        p.turnId === identity.turnId &&
        p.runId === identity.runId,
    );
    if (options.taskGrants)
      for (const header of await stores.sessionStore.listHeaders()) {
        if (!header.subagentParent || header.isArchived || !lanes.includes(header.id)) continue;
        for (const request of await pending(header.id)) {
          if (requests.length > WORKHUB_INBOX_MAX_ITEMS) break;
          if (
            await options.taskGrants.belongsToRoot(
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
  const handlers: Pick<
    OperationHandlerMap,
    'workhub.interactions.query' | 'workhub.interactions.answer' | 'workhub.interactions.revoke'
  > = {
    'workhub.interactions.query': async () => {
      const requests: WorkHubPendingInteraction[] = [];
      const seen = new Set<string>();
      const grants: import('../protocol/workhub-interactions.js').WorkHubTaskGrant[] = [];
      let truncated = false;
      await options.taskGrants?.reconcile();
      for (const assignment of await listAssignments()) {
        if (options.taskGrants && (await isActive(assignment))) {
          const header = await stores.sessionStore.readHeaderSnapshot(assignment.targetSessionId);
          for (const { grant } of await stores.sessionStore.listTaskExecutionGrants(
            assignment.targetSessionId,
          )) {
            if (grant.delegationId !== assignment.delegationId) continue;
            if (grants.length === WORKHUB_INBOX_MAX_ITEMS) truncated = true;
            else
              grants.push({
                actionId: assignment.actionId,
                targetSessionName: truncateUtf8(header.name || header.id, 512, '…'),
                grant,
              });
          }
        }
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
            return { ok: true, result: { requests, grants, truncated: true } };
          seen.add(key);
          requests.push(item);
        }
      }
      return { ok: true, result: { requests, grants, truncated } };
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
      if (!assignment?.returnResults) return notFound;
      const lanes = await taskLanes(assignment);
      return admission.runMany(lanes, async (lease) => {
        const request = (await taskRequests(assignment, lease, lanes)).find(
          (p) =>
            p.interactionId === input.interactionId &&
            p.turnId === input.expectedTurnId &&
            p.runId === input.expectedRunId,
        );
        if (!request) return notFound;
        if (
          request.request.kind !== input.answer.kind ||
          input.answer.kind === 'permission' ||
          ((input.answer.kind === 'sandbox_boundary' ||
            input.answer.kind === 'client_capability') &&
            input.answer.decision !== 'deny' &&
            (input.grantScope !== 'task' || !options.taskGrants))
        )
          return {
            ok: false,
            error: {
              code: 'operation_conflict',
              message:
                'WorkHub cannot grant Session-wide permissions or bypass the original approval authority',
            },
          };
        let taskGrant: import('@maka/core/task-execution-grant').TaskExecutionGrant | undefined;
        if (input.grantScope === 'task' && options.taskGrants) {
          if (
            (request.request.kind !== 'sandbox_boundary' &&
              request.request.kind !== 'client_capability') ||
            (input.answer.kind !== 'sandbox_boundary' &&
              input.answer.kind !== 'client_capability') ||
            input.answer.decision !== 'allow'
          )
            return {
              ok: false,
              error: { code: 'operation_conflict', message: 'Invalid task grant decision' },
            };
          const disposition = await messages.readMessageExecutionDispositionAdmitted(
            assignment.targetSessionId,
            assignment.targetMessageId,
            lease,
          );
          if (disposition.kind !== 'owned_root') return notFound;
          taskGrant = await options.taskGrants.create(
            assignment,
            {
              sessionId: assignment.targetSessionId,
              turnId: disposition.turnId,
              runId: disposition.runId,
            },
            {
              sessionId: request.sessionId,
              turnId: request.turnId,
              runId: request.runId,
              requestId: request.interactionId,
            },
            request.request.kind === 'sandbox_boundary'
              ? { kind: 'sandbox', expansion: request.request.expansion }
              : { kind: 'client_capability', target: request.request.target },
          );
        }
        const outcome = await options.interactions.answerAdmitted(
          {
            sessionId: request.sessionId,
            interactionId: request.interactionId,
            answer: input.answer,
          },
          lease,
          taskGrant,
        );
        if (outcome.ok) {
          notify(assignment.targetSessionId);
          options.taskGrants?.notify();
        }
        return outcome;
      });
    },
    'workhub.interactions.revoke': async (input) => {
      const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
      if (!assignment?.returnResults || !options.taskGrants)
        return { ok: false, error: { code: 'not_found', message: 'Task grant unavailable' } };
      const grant = (
        await stores.sessionStore.listTaskExecutionGrants(assignment.targetSessionId)
      ).find(
        (r) =>
          r.grant.grantId === input.grantId && r.grant.delegationId === assignment.delegationId,
      );
      if (!grant)
        return { ok: false, error: { code: 'not_found', message: 'Task grant unavailable' } };
      // Do not hold Session admission while waiting for resource settlement.
      await options.taskGrants.revoke(input.grantId);
      notify(assignment.targetSessionId);
      return { ok: true, result: { grantId: input.grantId } };
    },
  };
  const coordinator = new HostWorkHubResultCoordinator({
    listAssignments,
    inspect,
    deliver: (origin, prepare) => executions.startWorkHubResult(origin, prepare),
    acquireResidency: options.acquireResidency,
    onError: options.onError,
  });
  const relayWatchers = new Map<string, Set<() => void>>();
  function notify(sessionId: string): void {
    coordinator.notify(sessionId);
    for (const wake of relayWatchers.get(sessionId) ?? []) wake();
  }
  const parameters = z
    .object({
      actionId: z.string().min(1),
      operation: z.enum(['read', 'ask_question']).default('read'),
      interactionId: z.string().optional(),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict();
  const tool: MakaTool<z.infer<typeof parameters>> = {
    name: 'WorkHubResult',
    description:
      'Read a delegated task result in pages, or present its exact pending question to the user here and forward their actual answer. Use actionId from a Host result notification. Never use this tool to approve permissions. The read operation returns Unicode character offsets.',
    parameters,
    categoryHint: 'read',
    recoveryMode: 'never_auto_retry',
    async impl(raw, ctx) {
      const input = parameters.parse(raw);
      if (ctx.sessionId !== WORKHUB_COORDINATION_SESSION_ID)
        throw new Error('WorkHub result access requires the coordination Session');
      const assignment = await stores.sessionStore.readWorkHubAssignment(input.actionId);
      if (!assignment?.returnResults) throw new Error('Unknown WorkHub result assignment');
      const observation = await inspect(assignment);
      if (!observation) {
        if (input.operation !== 'read') throw new Error('No pending delegated question');
        const active = await admission.runMany(
          [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
          () => isActive(assignment),
        );
        return active
          ? {
              status: 'pending',
              targetSessionId: assignment.targetSessionId,
              message:
                'No result is ready yet. The Host will automatically notify WorkHub when a result or user question is available. Acknowledge the delegation and end this response; do not poll tools to wait.',
            }
          : { status: 'obsolete', targetSessionId: assignment.targetSessionId };
      }
      if (input.operation === 'read') {
        const chars = Array.from(observation.result),
          end = input.offset + 16000;
        return {
          ...observation,
          result: chars.slice(input.offset, end).join(''),
          nextOffset: end < chars.length ? end : null,
        };
      }
      if (!input.interactionId || !ctx.askUserQuestion)
        throw new Error('A pending question and interactive WorkHub are required');
      const request = await admission.run(assignment.targetSessionId, async () =>
        (await pending(assignment.targetSessionId)).find(
          (p) => p.interactionId === input.interactionId && p.turnId === observation.turnId,
        ),
      );
      if (!request || request.request.kind !== 'question')
        throw new Error('Only pending user questions can be relayed');
      const relayState: { closed: boolean; status: 'question_settled_in_target' | 'obsolete' } = {
        closed: false,
        status: 'obsolete',
      };
      let checking = false;
      const checkOriginal = () => {
        if (checking || relayState.closed) return;
        checking = true;
        void admission
          .run(assignment.targetSessionId, async () => ({
            active: await isActive(assignment),
            questionPending: (await pending(assignment.targetSessionId)).some(
              (item) => item.interactionId === request.interactionId,
            ),
          }))
          .then(async ({ active, questionPending }) => {
            if (active && questionPending) return;
            relayState.status = active ? 'question_settled_in_target' : 'obsolete';
            relayState.closed = true;
            if (!(await options.interactions.closeRelayedQuestion(ctx.turnId, ctx.toolCallId)))
              relayState.closed = false;
          })
          .catch((error) => {
            relayState.closed = false;
            try {
              options.onError(error);
            } catch {
              // The relay watcher must not leave an unhandled timer rejection.
            }
          })
          .finally(() => {
            checking = false;
          });
      };
      let watchers = relayWatchers.get(assignment.targetSessionId);
      if (!watchers) {
        watchers = new Set();
        relayWatchers.set(assignment.targetSessionId, watchers);
      }
      watchers.add(checkOriginal);
      const timer = setInterval(checkOriginal, 5000);
      timer.unref();
      let answer: Awaited<ReturnType<NonNullable<typeof ctx.askUserQuestion>>>;
      try {
        answer = await ctx.askUserQuestion(
          request.request.questions.map((q) => ({
            question: q.question,
            options: q.options.map((o) => ({ ...o })),
          })),
        );
      } catch (error) {
        if (relayState.closed)
          return {
            status: relayState.status,
            targetSessionId: assignment.targetSessionId,
            message:
              relayState.status === 'question_settled_in_target'
                ? 'The original task question has settled. Wait for the automatic task result; do not ask again.'
                : 'The delegated task is no longer active.',
          };
        throw error;
      } finally {
        clearInterval(timer);
        watchers.delete(checkOriginal);
        if (watchers.size === 0) relayWatchers.delete(assignment.targetSessionId);
      }
      ctx.abortSignal.throwIfAborted();
      // Recheck the original delegation after the human responds. A late answer
      // must not revive a cancelled/replaced task or answer another interaction.
      const outcome = await admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, assignment.targetSessionId],
        async (lease) => {
          const current = await inspectLocked(assignment, lease);
          if (!current || current.turnId !== request.turnId) return undefined;
          return options.interactions.answerDelegatedQuestion(
            {
              sessionId: assignment.targetSessionId,
              interactionId: request.interactionId,
              answer: { kind: 'question', answers: answer.answers.map((a) => a.answer) },
            },
            lease,
          );
        },
      );
      if (!outcome) return { status: 'obsolete' };
      if (!outcome.ok) throw new Error(outcome.error.message);
      notify(assignment.targetSessionId);
      return { status: outcome.result.status, targetSessionId: assignment.targetSessionId };
    },
  };
  return { coordinator, tool, notify, handlers };
}
