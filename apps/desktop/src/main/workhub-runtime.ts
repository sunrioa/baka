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

import { WORKHUB_COORDINATION_SESSION_ID, type WorkHubCreateDefaults } from '@maka/core/session';
import type { WorkHubActionResult } from '@maka/core/workhub-action-result';
import { clientCapabilityEntityId } from '@maka/runtime-host/client-capability-entity-id';
import type { WorkHubCoordinationProposal, ProjectCatalogProjectDetails } from '@maka/runtime-host/protocol';
import { desktopSessionKey, type DesktopTargetScope } from '../shared/runtime-host-identity.js';
import type { WorkHubTasksInput } from '../shared/workhub-tool-schema.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

interface WorkHubRuntimeDeps {
  client(scope: DesktopTargetScope): Pick<DesktopRuntimeHostClient, 'queryTurn' | 'queryMessageExecutions' | 'stopTurn' | 'listProjects' | 'listWorkHubCoordinationCandidates' | 'actWorkHubCoordinationFromTurn' | 'selectAndDelegateWorkHubTarget'>;
  isCurrent(scope: DesktopTargetScope): boolean;
  createDefaults(scope: DesktopTargetScope): Promise<WorkHubCreateDefaults>;
  changed(scope: DesktopTargetScope, reason: 'created' | 'status-change', sessionId: string): void;
}

function executionEvidence(result: WorkHubActionResult) {
  return result.disposition === 'create_new' || result.disposition === 'delegate_existing' || result.disposition === 'replace'
    ? { executionEvidence: { status: 'admitted' as const, completionVerified: false, artifactsVerified: false } }
    : {};
}

/** Keep task authority in the Host; Desktop supplies scoped project references and preferences. */
export function createWorkHubRuntime(deps: WorkHubRuntimeDeps) {
  const requireCurrent = (scope: DesktopTargetScope) => {
    if (!deps.isCurrent(scope)) throw new Error('Runtime Host changed');
  };
  const queryTurn = async (client: ReturnType<WorkHubRuntimeDeps['client']>, turnId: string) => {
    const turn = await client.queryTurn({ sessionId: WORKHUB_COORDINATION_SESSION_ID, turnId });
    if (turn.sessionId !== WORKHUB_COORDINATION_SESSION_ID || turn.turnId !== turnId) throw new Error('WorkHub turn identity changed');
    return turn;
  };
  const isLive = (turn: Awaited<ReturnType<typeof queryTurn>>) =>
    turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'cancelled';
  const projects = async (scope: DesktopTargetScope, client: ReturnType<WorkHubRuntimeDeps['client']>) => {
    const records = await client.listProjects();
    requireCurrent(scope);
    return records.filter((project): project is ProjectCatalogProjectDetails =>
      project.archivedAt === null && project.available && 'preferredPath' in project && !!project.preferredPath,
    ).map((project) => ({
      projectRef: clientCapabilityEntityId(JSON.stringify(['workhub-project', scope.hostId, project.id, project.preferredPath])),
      project,
    }));
  };

  return {
    async assertTurn(scope: DesktopTargetScope, turnId: string): Promise<void> {
      requireCurrent(scope);
      const turn = await queryTurn(deps.client(scope), turnId);
      requireCurrent(scope);
      if (!isLive(turn)) throw new Error('WorkHub turn is no longer active');
    },
    async interrupt(scope: DesktopTargetScope, turnId: string): Promise<void> {
      const client = deps.client(scope);
      const turn = await queryTurn(client, turnId);
      if (isLive(turn)) await client.stopTurn({ sessionId: turn.sessionId, turnId: turn.turnId, runId: turn.runId });
    },
    async actTasks(scope: DesktopTargetScope, turnId: string, toolCallId: string, input: WorkHubTasksInput) {
      requireCurrent(scope);
      const client = deps.client(scope);
      if (input.operation === 'projects') {
        const matches = (await projects(scope, client)).filter(({ project }) =>
          !input.query || project.name.toLowerCase().includes(input.query.toLowerCase()),
        );
        return { operation: 'projects' as const, projects: matches.slice(0, 32).map(({ projectRef, project }) => ({
          projectRef, name: Array.from(project.name).slice(0, 512).join(''),
        })), truncated: matches.length > 32 };
      }
      if (input.operation === 'candidates') {
        const candidates = await client.listWorkHubCoordinationCandidates();
        requireCurrent(scope);
        return { ...candidates, observedAt: Date.now(), stateMeaning: 'Session availability only: active is idle/available, not running. Use status with the returned targetMessageId for delegation progress, or targetTurnId for linked resume.' };
      }
      if (input.operation === 'status') {
        const candidates = await client.listWorkHubCoordinationCandidates();
        requireCurrent(scope);
        if (!candidates.candidates.some((candidate) => candidate.sessionId === input.targetSessionId))
          throw new Error('Target Session is outside current WorkHub discovery');
        let targetTurnId = input.targetTurnId;
        let targetRunId: string | undefined;
        if (input.targetMessageId) {
          const execution = await client.queryMessageExecutions({ sessionId: input.targetSessionId, messageIds: [input.targetMessageId] });
          requireCurrent(scope);
          const resolution = execution.resolutions[0];
          if (execution.resolutions.length !== 1 || resolution?.messageId !== input.targetMessageId)
            throw new Error('WorkHub status Message identity is unresolved');
          if (resolution.state !== 'owned') {
            return { operation: 'status' as const, targetSessionId: input.targetSessionId, targetMessageId: input.targetMessageId,
              targetSessionKey: desktopSessionKey({ hostId: scope.hostId, sessionId: input.targetSessionId }), observedAt: Date.now(),
              executionEvidence: { status: resolution.state, scope: 'exact_message' as const, completionVerified: false, artifactsVerified: false } };
          }
          targetTurnId = resolution.turnId;
          targetRunId = resolution.runId;
        }
        if (!targetTurnId) throw new Error('WorkHub status requires a Message or Turn identity');
        const turn = await client.queryTurn({ sessionId: input.targetSessionId, turnId: targetTurnId });
        requireCurrent(scope);
        if (turn.sessionId !== input.targetSessionId || turn.turnId !== targetTurnId || (targetRunId && turn.runId !== targetRunId))
          throw new Error('WorkHub status target identity changed');
        return { operation: 'status' as const, targetSessionId: turn.sessionId, targetTurnId: turn.turnId,
          ...(input.targetMessageId ? { targetMessageId: input.targetMessageId } : {}),
          targetSessionKey: desktopSessionKey({ hostId: scope.hostId, sessionId: turn.sessionId }),
          observedAt: Date.now(), executionEvidence: { status: turn.status, scope: input.targetMessageId ? 'exact_message' as const : 'exact_turn' as const,
            completionVerified: turn.status === 'completed', artifactsVerified: false },
        };
      }
      // WorkHub persists actions as entities; capability tool-call IDs are opaque.
      const actionId = clientCapabilityEntityId(toolCallId);
      if (input.operation === 'select_and_delegate') {
        const outcome = await client.selectAndDelegateWorkHubTarget({ turnId, actionId,
          candidateSetId: input.candidateSetId, candidateRefs: input.candidateRefs, delegationText: input.text });
        if (outcome.kind === 'cancelled') return outcome;
        const result = outcome.result;
        if ('targetSessionId' in result) deps.changed(scope, 'status-change', result.targetSessionId);
        return { ...result, actionId, ...executionEvidence(result), ...('targetSessionId' in result ? {
          targetSessionKey: desktopSessionKey({ hostId: scope.hostId, sessionId: result.targetSessionId }),
        } : {}) };
      }
      let proposal: WorkHubCoordinationProposal;
      switch (input.operation) {
        case 'delegate_existing': proposal = { disposition: 'delegate_existing', candidateRef: input.candidateRef }; break;
        case 'create_new': proposal = { disposition: 'create_new', title: input.title }; break;
        case 'correct': proposal = { operation: 'correct', replacesActionId: input.replacesActionId, target: input.target.disposition === 'create_new'
          ? { disposition: 'create_new', title: input.target.title } : input.target }; break;
        case 'stop': proposal = { operation: 'stop', expects: { targetSessionId: input.targetSessionId } }; break;
        case 'resume': proposal = { operation: 'resume', resumesActionId: input.resumesActionId, expects: { targetSessionId: input.targetSessionId } }; break;
      }
      const createsTarget =
        ('disposition' in proposal && proposal.disposition === 'create_new') ||
        ('operation' in proposal &&
          proposal.operation === 'correct' &&
          proposal.target.disposition === 'create_new');
      let context;
      if (createsTarget) {
        const projectRef = input.operation === 'create_new' ? input.projectRef
          : input.operation === 'correct' && input.target.disposition === 'create_new' ? input.target.projectRef : undefined;
        const project = projectRef ? (await projects(scope, client)).find((item) => item.projectRef === projectRef)?.project : undefined;
        if (projectRef && !project) throw new Error('WorkHub project reference is unavailable; discover projects again');
        context = { workspace: project ? { kind: 'project' as const, projectId: project.id } : { kind: 'isolated' as const },
          defaults: await deps.createDefaults(scope) };
      }
      requireCurrent(scope);
      const result = await client.actWorkHubCoordinationFromTurn({
        turnId, actionId, proposal,
        ...('text' in input ? { delegationText: input.text } : {}),
        ...('candidateSetId' in input && input.candidateSetId ? { candidateSetId: input.candidateSetId } : {}),
        ...(context ? { create: { workspace: context.workspace }, newWorkDefaults: context.defaults } : {}),
      });
      if (result.disposition === 'create_new' || (result.disposition === 'replace' && result.replacementDisposition === 'create_new')) {
        deps.changed(scope, 'created', result.targetSessionId);
      } else if (result.disposition === 'delegate_existing' || result.disposition === 'replace') {
        deps.changed(scope, 'status-change', result.targetSessionId);
      }
      return { ...result, actionId, ...executionEvidence(result), ...('targetSessionId' in result ? { targetSessionKey: desktopSessionKey({ hostId: scope.hostId, sessionId: result.targetSessionId }) } : {}) };
    },
  };
}
