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

import { isDeepStrictEqual } from 'node:util';
import { tmpdir } from 'node:os';
import {
  applySandboxBoundaryExpansion,
  assessSandboxBoundaryExpansion,
} from '@maka/core/sandbox-boundary';
import {
  decodeTaskExecutionGrant,
  TASK_GRANT_DEFAULT_LIFETIME_MS,
  type TaskExecutionGrant,
  type TaskGrantClosureReason,
} from '@maka/core/task-execution-grant';
import type { WorkHubDelegationAssignedMessage } from '@maka/core/session';
import { readLogicalRuntimeExecutionForRun } from '@maka/core/runtime-logical-execution';
import { isSessionNotFoundError, type ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { ToolExecutionScope, ToolExecutionAuthority } from '@maka/runtime/tool-runtime';
import type { RootTurnCoordinator } from './root-turn-coordinator.js';

/** Rebuildable resource fences over canonical grants and execution facts, not a task database. */
export class HostTaskGrantCoordinator {
  private readonly fences = new Map<
    string,
    {
      controller: AbortController;
      timer: ReturnType<typeof setTimeout>;
      expiresAt: number;
      cleanup: Set<() => void | Promise<void>>;
      draining?: Promise<void>;
    }
  >();
  private reconciliation: Promise<void> = Promise.resolve();
  private dirty = false;
  private closing = false;
  constructor(
    private readonly input: {
      stores: ExecutionStoresWriter<'interactive'>;
      executions: Pick<RootTurnCoordinator, 'readLatestRootTurnLineage' | 'read'>;
      onError(error: unknown): void;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  async create(
    assignment: WorkHubDelegationAssignedMessage,
    root: { sessionId: string; turnId: string; runId: string },
    source: { sessionId: string; turnId: string; runId: string; requestId: string },
    resource: TaskExecutionGrant['resource'],
  ): Promise<TaskExecutionGrant> {
    if (this.closing) throw new Error('Task authority is closing');
    const rootBoundary = await this.input.stores.sessionStore.readExecutionBoundary(root.sessionId);
    const sourceBoundary = await this.input.stores.sessionStore.readExecutionBoundary(
      source.sessionId,
    );
    const candidate = decodeTaskExecutionGrant({
      version: 1,
      grantId: source.requestId,
      rootSessionId: root.sessionId,
      rootTurnId: root.turnId,
      rootRunId: root.runId,
      delegationId: assignment.delegationId,
      sourceSessionId: source.sessionId,
      sourceRequestId: source.requestId,
      sourceTurnId: source.turnId,
      sourceRunId: source.runId,
      rootBoundaryRevision: rootBoundary.revision,
      sourceBoundaryRevision: sourceBoundary.revision,
      grantedAt: this.now(),
      expiresAt: this.now() + TASK_GRANT_DEFAULT_LIFETIME_MS,
      resource,
    });
    if (!(await this.belongs(source, candidate)) || !(await this.valid(candidate)) || this.closing)
      throw new Error('Task grant source is not a live execution of the assigned task');
    return candidate;
  }

  /** A client/request identity alone is not sufficient: follow authenticated invocation lineage. */
  async belongs(scope: ToolExecutionScope, grant: TaskExecutionGrant): Promise<boolean> {
    return this.belongsToRoot(scope, {
      sessionId: grant.rootSessionId,
      turnId: grant.rootTurnId,
      runId: grant.rootRunId,
    });
  }

  async belongsToRoot(
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
      const invocation = await this.input.stores.runtimeEventStore.readRunInvocation(
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
        this.input.stores.runtimeEventStore,
        current,
      );
      if (!logical || logical.tip.terminalEvent) return false;
      if (current.sessionId === root.sessionId) {
        const latest = await this.input.executions.readLatestRootTurnLineage(root);
        const rootLogical = await readLogicalRuntimeExecutionForRun(
          this.input.stores.runtimeEventStore,
          latest,
        );
        return rootLogical?.runIds.includes(current.runId) === true;
      }
      const header = await this.input.stores.sessionStore.readHeaderSnapshot(current.sessionId);
      const spawned = header.subagentParent;
      const spawn = header.subagentSpawn;
      if (spawned?.kind !== 'subagent' || !spawn) return false;
      // Linked Sessions deliberately have no cross-Session invocation lineage.
      // Prove this Run through its Host admission and immutable spawn identity,
      // not merely the child's display ancestry or a later manual Turn.
      if (spawned.graph) {
        const admission = await this.input.stores.agentRunStore.readRootTurnAdmission(
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
        const initial = await this.input.stores.agentRunStore.readRootTurnAdmission(
          current.sessionId,
          spawn.initialTurnId,
        );
        if (
          initial?.runId !== spawn.initialRunId ||
          initial.execution.kind !== 'linked_child_initial'
        )
          return false;
        const latest = await this.input.executions.readLatestRootTurnLineage({
          sessionId: current.sessionId,
          turnId: spawn.initialTurnId,
          runId: spawn.initialRunId,
        });
        const childLogical = await readLogicalRuntimeExecutionForRun(
          this.input.stores.runtimeEventStore,
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
  }

  private async valid(grant: TaskExecutionGrant): Promise<boolean> {
    try {
      if (this.now() >= grant.expiresAt || this.now() < grant.grantedAt) return false;
      const store = this.input.stores.sessionStore;
      const root = await store.readHeaderSnapshot(grant.rootSessionId);
      const source = await store.readHeaderSnapshot(grant.sourceSessionId);
      if (root.isArchived || source.isArchived) return false;
      const assignments = await store.readActiveWorkHubAssignmentsByTarget([grant.rootSessionId]);
      if (!assignments.some((a) => a.delegationId === grant.delegationId && a.returnResults))
        return false;
      if (await store.readWorkHubReplacement(grant.delegationId)) return false;
      if (
        (await store.readWorkHubStopRequest(grant.delegationId)) &&
        (await store.readWorkHubStopResolution(grant.delegationId))?.outcome !== 'not_owned'
      )
        return false;
      if (
        (await store.readExecutionBoundary(grant.rootSessionId)).revision !==
          grant.rootBoundaryRevision ||
        (await store.readExecutionBoundary(grant.sourceSessionId)).revision !==
          grant.sourceBoundaryRevision
      )
        return false;
      const latest = await this.input.executions.readLatestRootTurnLineage({
        sessionId: grant.rootSessionId,
        turnId: grant.rootTurnId,
        runId: grant.rootRunId,
      });
      const snapshot = await this.input.executions.read(latest);
      return snapshot.status === 'running' || snapshot.status === 'waiting_for_user';
    } catch (error) {
      if (isSessionNotFoundError(error)) return false;
      throw error;
    }
  }

  private fence(grant: TaskExecutionGrant): AbortController {
    if (this.closing || this.now() >= grant.expiresAt) throw new Error('Task grant has expired');
    let fence = this.fences.get(grant.grantId);
    if (!fence) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => {
          void this.revoke(grant.grantId, 'expired').catch(this.input.onError);
        },
        Math.max(1, grant.expiresAt - this.now()),
      );
      timer.unref();
      fence = { controller, timer, expiresAt: grant.expiresAt, cleanup: new Set() };
      this.fences.set(grant.grantId, fence);
    }
    return fence.controller;
  }

  async read(scope: ToolExecutionScope): Promise<ToolExecutionAuthority> {
    if (this.closing) throw new Error('Task authority is closing');
    const boundary = await this.input.stores.sessionStore.readExecutionBoundary(scope.sessionId);
    const matching: TaskExecutionGrant[] = [];
    for (const { grant } of await this.input.stores.sessionStore.listTaskExecutionGrants()) {
      const valid = await this.valid(grant);
      if (this.closing) throw new Error('Task authority is closing');
      if (!valid) {
        const { drained } = await this.invalidate(
          grant.grantId,
          this.now() >= grant.expiresAt ? 'expired' : 'authority_changed',
        );
        // A tool can reread authority during its own call. Abort and durably
        // deny first, but never wait here for that same tool to settle.
        void drained.catch(() => {});
        continue;
      }
      if (await this.belongs(scope, grant)) matching.push(grant);
    }
    let effective = boundary;
    const header = await this.input.stores.sessionStore.readHeaderSnapshot(scope.sessionId);
    if (this.closing) throw new Error('Task authority is closing');
    const applied = matching.filter((grant) => {
      if (grant.resource.kind !== 'sandbox' || effective.kind !== 'managed') return false;
      if (
        assessSandboxBoundaryExpansion(effective.profile, grant.resource.expansion, {
          root: header.cwd,
          workspaceRoots: [header.cwd],
          tmpdir: tmpdir(),
          slashTmp: '/tmp',
        }).outcome === 'conflict'
      )
        return false;
      effective = {
        ...effective,
        profile: applySandboxBoundaryExpansion(effective.profile, grant.resource.expansion),
      };
      return true;
    });
    return {
      boundary: effective,
      ...(applied.length
        ? {
            signal: AbortSignal.any(applied.map((g) => this.fence(g).signal)),
            registerCleanup: (cleanup: () => void | Promise<void>) =>
              this.register(applied, cleanup),
          }
        : {}),
    };
  }

  private register(
    grants: readonly TaskExecutionGrant[],
    cleanup: () => void | Promise<void>,
  ): () => void {
    const fences = grants.map((grant) => {
      this.fence(grant);
      return this.fences.get(grant.grantId)!;
    });
    if (fences.some((f) => f.controller.signal.aborted))
      throw new Error('Task grant was revoked before resource admission');
    for (const fence of fences) fence.cleanup.add(cleanup);
    return () => {
      for (const fence of fences) fence.cleanup.delete(cleanup);
    };
  }

  async permitsCapability(
    scope: ToolExecutionScope,
    target: Extract<TaskExecutionGrant['resource'], { kind: 'client_capability' }>['target'],
    cancel: () => void | Promise<void>,
  ): Promise<(() => void) | undefined> {
    for (const { grant } of await this.input.stores.sessionStore.listTaskExecutionGrants()) {
      if (
        grant.resource.kind !== 'client_capability' ||
        !isDeepStrictEqual(grant.resource.target, target)
      )
        continue;
      if (!(await this.valid(grant)) || !(await this.belongs(scope, grant))) continue;
      return this.register([grant], cancel);
    }
    return undefined;
  }

  async revoke(grantId: string, reason: TaskGrantClosureReason = 'revoked'): Promise<void> {
    const { drained } = await this.invalidate(grantId, reason);
    await drained;
  }

  private async invalidate(
    grantId: string,
    reason: TaskGrantClosureReason,
  ): Promise<{ drained: Promise<void> }> {
    // Durable denial precedes cancellation. A failed cleanup must never re-enable the grant.
    const existing = (await this.input.stores.sessionStore.listTaskExecutionGrants()).find(
      (r) => r.grant.grantId === grantId,
    );
    if (existing && !this.fences.has(grantId)) {
      const timer = setTimeout(() => {}, 1);
      timer.unref();
      this.fences.set(grantId, {
        controller: new AbortController(),
        timer,
        expiresAt: existing.grant.expiresAt,
        cleanup: new Set(),
      });
    }
    await this.input.stores.sessionStore.closeTaskExecutionGrant(grantId, reason, this.now());
    const fence = this.fences.get(grantId);
    if (!fence) return { drained: Promise.resolve() };
    if (fence.draining) return { drained: fence.draining };
    clearTimeout(fence.timer);
    fence.controller.abort(new Error('Task execution grant is no longer valid'));
    fence.draining = (async () => {
      const settled = await Promise.allSettled(
        [...fence.cleanup].map((cleanup) => Promise.resolve().then(cleanup)),
      );
      fence.cleanup.clear();
      const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => r.reason),
          'Task grant cleanup failed',
        );
      // An in-flight read may have captured the old row. Keep its aborted
      // fence until expiry so it cannot recreate authority after revocation.
      fence.timer = setTimeout(
        () => {
          this.fences.delete(grantId);
        },
        Math.max(1, fence.expiresAt - this.now()),
      );
      fence.timer.unref();
    })();
    void fence.draining.catch(this.input.onError);
    return { drained: fence.draining };
  }

  notify(): void {
    if (this.dirty || this.closing) return;
    this.dirty = true;
    this.reconciliation = this.reconciliation
      .then(async () => {
        this.dirty = false;
        if (!this.closing) await this.reconcile();
      })
      .catch(this.input.onError);
  }
  async reconcile(): Promise<void> {
    if (this.closing) return;
    const records = await this.input.stores.sessionStore.listTaskExecutionGrants();
    for (const { grant } of records) {
      const valid = await this.valid(grant);
      if (this.closing) return;
      if (!valid || this.now() >= grant.expiresAt)
        await this.revoke(
          grant.grantId,
          this.now() >= grant.expiresAt ? 'expired' : 'authority_changed',
        );
      else this.fence(grant);
    }
    // Root retirement can cascade-delete the row. Live fences still need
    // cancellation; absence is never permission to keep a resource running.
    const activeIds = new Set(records.map((r) => r.grant.grantId));
    for (const [id, fence] of this.fences)
      if (!activeIds.has(id) && !fence.controller.signal.aborted)
        await this.revoke(id, 'authority_changed');
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.reconciliation;
    for (const fence of this.fences.values()) {
      clearTimeout(fence.timer);
      fence.controller.abort(new Error('Runtime Host is closing'));
      if (fence.draining) await fence.draining;
      else {
        const settled = await Promise.allSettled(
          [...fence.cleanup].map((cleanup) => Promise.resolve().then(cleanup)),
        );
        const failures = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            'Task authority close failed',
          );
      }
      clearTimeout(fence.timer);
    }
    this.fences.clear();
  }
}
