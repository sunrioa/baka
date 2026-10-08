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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGenesisExecutionBoundary } from '@maka/core/sandbox-boundary';
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { SessionHeader, WorkHubDelegationAssignedMessage } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { TaskExecutionGrantRecord } from '@maka/core/task-execution-grant';
import { HostTaskGrantCoordinator } from '../server/task-grant-coordinator.js';

function fixture() {
  let now = 100,
    status = 'running',
    retired = false,
    revision = 0;
  let graphClaim:
    | {
        graphId: string;
        targetOperatorId: string;
        targetSessionId: string;
        targetTurnId: string;
        targetRunId: string;
      }
    | undefined;
  const records: TaskExecutionGrantRecord[] = [];
  const headers = new Map<string, Partial<SessionHeader>>([
    ['root', { id: 'root', cwd: '/workspace' }],
    [
      'child',
      {
        id: 'child',
        cwd: '/workspace',
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'spawn-fingerprint',
          initialRunId: 'child-run',
          initialTurnId: 'child-turn',
        },
        subagentParent: {
          kind: 'subagent',
          parentSessionId: 'root',
          spawnedBy: { parentRunId: 'run', parentTurnId: 'turn', toolCallId: 'spawn' },
          lifecycle: 'foreground',
        },
      },
    ],
  ]);
  const invocation = (sessionId: string, runId: string, turnId: string, lineage?: unknown) =>
    ({
      sessionId,
      runId,
      turnId,
      invocationId: 'inv-' + runId,
      opening: { source: { kind: 'fresh' }, ...(lineage ? { lineage } : {}) },
    }) as RuntimeInvocationRecord;
  const runs = new Map([
    ['run', invocation('root', 'run', 'turn')],
    ['manual', invocation('root', 'manual', 'manual-turn')],
    ['child-run', invocation('child', 'child-run', 'child-turn')],
    ['child-manual', invocation('child', 'child-manual', 'manual-turn')],
  ]);
  const assignment = {
    delegationId: 'delegation',
    returnResults: true,
  } as WorkHubDelegationAssignedMessage;
  const store = {
    readHeaderSnapshot: async (id: string) => headers.get(id),
    readExecutionBoundary: async () => ({ ...createGenesisExecutionBoundary('ask'), revision }),
    readActiveWorkHubAssignmentsByTarget: async () => (retired ? [] : [assignment]),
    readWorkHubReplacement: async () => undefined,
    readWorkHubStopRequest: async () => undefined,
    listTaskExecutionGrants: async () => records.filter((r) => !r.closure),
    closeTaskExecutionGrant: async (id: string, reason: string, closedAt: number) => {
      const index = records.findIndex((r) => r.grant.grantId === id);
      if (index >= 0 && !records[index]!.closure)
        records[index] = {
          ...records[index]!,
          closure: { reason, closedAt },
        } as TaskExecutionGrantRecord;
    },
  };
  const coordinator = () =>
    new HostTaskGrantCoordinator({
      stores: {
        sessionStore: store,
        agentRunStore: {
          readRootTurnAdmission: async (sessionId: string, turnId: string) =>
            sessionId === 'child' && turnId === 'child-turn'
              ? {
                  sessionId,
                  turnId,
                  runId: 'child-run',
                  execution: graphClaim
                    ? { kind: 'claimed_agent_graph_intent', claim: graphClaim }
                    : {
                        kind: 'linked_child_initial',
                        agentId: 'worker',
                        agentName: 'Worker',
                      },
                }
              : undefined,
        },
        runtimeEventStore: {
          readRunInvocation: async (sessionId: string, runId: string) => {
            const run = runs.get(runId);
            return run?.sessionId === sessionId ? run : undefined;
          },
          readImmutableRuntimeEvents: async () => [],
        },
      } as unknown as ExecutionStoresWriter<'interactive'>,
      executions: {
        readLatestRootTurnLineage: async (identity) => identity,
        read: async () =>
          ({ status }) as Awaited<
            ReturnType<import('../server/root-turn-coordinator.js').RootTurnCoordinator['read']>
          >,
      },
      now: () => now,
      onError: (error) => {
        throw error;
      },
    });
  return {
    records,
    coordinator,
    assignment,
    headers,
    runs,
    store,
    setTime: (time: number) => {
      now = time;
    },
    setStatus: (value: string) => {
      status = value;
    },
    retire: () => {
      retired = true;
    },
    changeBoundary: () => {
      revision++;
    },
    setGraphClaim: (claim: typeof graphClaim) => {
      graphClaim = claim;
    },
  };
}
const root = { sessionId: 'root', turnId: 'turn', runId: 'run', invocationId: 'inv-run' };
const sandbox = {
  kind: 'sandbox' as const,
  expansion: {
    filesystem: {
      entries: [{ path: '/outside', scope: 'subtree' as const, access: 'read' as const }],
    },
    network: { enabled: true as const },
  },
};

test('task authority follows exact root and authenticated child runs, never Session ancestry alone', async () => {
  const f = fixture(),
    c = f.coordinator();
  try {
    const grant = await c.create(f.assignment, root, { ...root, requestId: 'request' }, sandbox);
    f.records.push({ grant });
    const authority = await c.read(root);
    assert.notDeepEqual(authority.boundary, await f.store.readExecutionBoundary());
    assert.equal(authority.boundary.revision, 0);
    const child = {
      sessionId: 'child',
      turnId: 'child-turn',
      runId: 'child-run',
      invocationId: 'inv-child-run',
    };
    assert.equal(await c.belongs(child, grant), true);
    assert.notDeepEqual((await c.read(child)).boundary, await f.store.readExecutionBoundary());
    const childHeader = f.headers.get('child')!;
    for (const scope of [
      { ...root, runId: 'manual', turnId: 'manual-turn', invocationId: 'inv-manual' },
      { ...root, invocationId: 'forged' },
      { ...root, turnId: 'forged' },
      { sessionId: 'child', runId: 'child-manual', turnId: 'manual-turn' },
    ])
      assert.equal(await c.belongs(scope, grant), false);
    f.headers.set('child', {
      ...f.headers.get('child'),
      subagentParent: {
        kind: 'subagent',
        parentSessionId: 'root',
        spawnedBy: { parentRunId: 'manual', parentTurnId: 'manual-turn', toolCallId: 'spawn' },
        lifecycle: 'foreground',
      },
    });
    assert.equal(await c.belongs(child, grant), false);
    f.headers.set('child', {
      ...childHeader,
      subagentParent: {
        ...childHeader.subagentParent!,
        graph: { graphId: 'graph', operatorId: 'worker', workId: 'work' },
      },
    });
    const claim = {
      graphId: 'graph',
      targetOperatorId: 'worker',
      targetSessionId: child.sessionId,
      targetTurnId: child.turnId,
      targetRunId: child.runId,
    };
    f.setGraphClaim(claim);
    assert.equal(await c.belongs(child, grant), true, 'graph children need their exact Host claim');
    for (const patch of [
      { graphId: 'another-graph' },
      { targetOperatorId: 'another-operator' },
      { targetSessionId: 'another-session' },
      { targetTurnId: 'another-turn' },
      { targetRunId: 'another-run' },
    ]) {
      f.setGraphClaim({ ...claim, ...patch });
      assert.equal(await c.belongs(child, grant), false);
    }
    f.setGraphClaim(undefined);
    assert.equal(await c.belongs(child, grant), false, 'display ancestry is not a graph claim');
    assert.deepEqual(await f.store.readExecutionBoundary(), createGenesisExecutionBoundary('ask'));
  } finally {
    await c.close();
  }
});

test('task grants restore only a still-valid scope and revoke before waiting for resource cleanup', async () => {
  const f = fixture(),
    original = f.coordinator();
  const grant = await original.create(
    f.assignment,
    root,
    { ...root, requestId: 'request' },
    sandbox,
  );
  f.records.push({ grant });
  await original.close();
  const c = f.coordinator();
  try {
    await c.reconcile();
    const authority = await c.read(root);
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    authority.registerCleanup!(() => cleanup);
    const revoked = c.revoke(grant.grantId);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authority.signal!.aborted, true);
    assert.equal(f.records[0]!.closure?.reason, 'revoked');
    assert.deepEqual((await c.read(root)).boundary, await f.store.readExecutionBoundary());
    assert.throws(() => authority.registerCleanup!(() => {}), /revoked/);
    release();
    await revoked;
    const restarted = f.coordinator();
    try {
      assert.deepEqual(
        (await restarted.read(root)).boundary,
        await f.store.readExecutionBoundary(),
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await c.close();
  }
});

test('expiry, task termination, cancellation, retirement and changed defaults invalidate supplemental grants', async () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.setTime(3600100),
    (f: ReturnType<typeof fixture>) => f.setStatus('completed'),
    (f: ReturnType<typeof fixture>) => f.setStatus('cancelled'),
    (f: ReturnType<typeof fixture>) => f.retire(),
    (f: ReturnType<typeof fixture>) => f.changeBoundary(),
  ]) {
    const f = fixture(),
      c = f.coordinator();
    try {
      const grant = await c.create(f.assignment, root, { ...root, requestId: 'request' }, sandbox);
      f.records.push({ grant });
      const authority = await c.read(root);
      let cleaned = false;
      authority.registerCleanup!(() => {
        cleaned = true;
      });
      invalidate(f);
      await c.reconcile();
      assert.ok(f.records[0]!.closure);
      assert.equal(authority.signal!.aborted, true);
      assert.equal(cleaned, true);
      assert.deepEqual((await c.read(root)).boundary, await f.store.readExecutionBoundary());
    } finally {
      await c.close();
    }
  }
});

test('client capability grants are task-bound, evidence-scoped and unregister completed calls', async () => {
  const f = fixture(),
    c = f.coordinator();
  const target = {
    providerId: 'provider',
    contractId: 'contract',
    serverId: 'server',
    toolName: 'navigate',
    capability: 'browser' as const,
    scope: { kind: 'browser_origin' as const, origin: 'https://example.com' },
  };
  try {
    const grant = await c.create(
      f.assignment,
      root,
      { ...root, requestId: 'cap-request' },
      { kind: 'client_capability', target },
    );
    f.records.push({ grant });
    let cancelled = 0;
    assert.equal(
      await c.permitsCapability(
        { ...root, runId: 'manual', turnId: 'manual-turn', invocationId: 'inv-manual' },
        target,
        () => {
          cancelled++;
        },
      ),
      undefined,
    );
    assert.equal(
      await c.permitsCapability(root, { ...target, providerId: 'another-provider' }, () => {
        cancelled++;
      }),
      undefined,
    );
    const release = await c.permitsCapability(root, target, () => {
      cancelled++;
    });
    assert.ok(release);
    release();
    await c.revoke(grant.grantId);
    assert.equal(cancelled, 0);
    assert.equal(
      await c.permitsCapability(root, target, () => {
        cancelled++;
      }),
      undefined,
    );
  } finally {
    await c.close();
  }
});

test('a live tool rereading invalid authority does not wait for its own cleanup', {
  timeout: 1000,
}, async () => {
  const f = fixture(),
    c = f.coordinator();
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.records.push({
      grant: await c.create(f.assignment, root, { ...root, requestId: 'request' }, sandbox),
    });
    const authority = await c.read(root);
    authority.registerCleanup!(() => settled);
    f.changeBoundary();
    const current = await c.read(root);
    assert.deepEqual(current.boundary, await f.store.readExecutionBoundary());
    assert.equal(authority.signal!.aborted, true);
    assert.ok(f.records[0]!.closure);
    release();
  } finally {
    release();
    await c.close();
  }
});
