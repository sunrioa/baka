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
import type { RuntimeInvocationRecord } from '@maka/core/runtime-invocation';
import type { SessionHeader } from '@maka/core/session';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import { createWorkHubInteractionOwnership } from '../server/workhub-result-runtime.js';

const root = { sessionId: 'root', turnId: 'turn', runId: 'run', invocationId: 'inv-run' };
const child = {
  sessionId: 'child',
  turnId: 'child-turn',
  runId: 'child-run',
  invocationId: 'inv-child-run',
};

function fixture() {
  let graphClaim: Record<string, string> | undefined;
  const headers = new Map<string, Partial<SessionHeader>>([
    ['root', { id: 'root' }],
    [
      'child',
      {
        id: 'child',
        subagentSpawn: {
          schemaVersion: 1,
          requestFingerprint: 'spawn',
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
  const invocation = (sessionId: string, runId: string, turnId: string) =>
    ({
      sessionId,
      runId,
      turnId,
      invocationId: 'inv-' + runId,
      opening: { source: { kind: 'fresh' } },
    }) as RuntimeInvocationRecord;
  const runs = new Map([
    ['run', invocation('root', 'run', 'turn')],
    ['manual', invocation('root', 'manual', 'manual-turn')],
    ['child-run', invocation('child', 'child-run', 'child-turn')],
    ['child-manual', invocation('child', 'child-manual', 'manual-turn')],
  ]);
  const belongs = createWorkHubInteractionOwnership({
    stores: {
      sessionStore: { readHeaderSnapshot: async (id: string) => headers.get(id) },
      agentRunStore: {
        readRootTurnAdmission: async (sessionId: string, turnId: string) =>
          sessionId === 'child' && turnId === 'child-turn'
            ? {
                sessionId,
                turnId,
                runId: 'child-run',
                execution: graphClaim
                  ? { kind: 'claimed_agent_graph_intent', claim: graphClaim }
                  : { kind: 'linked_child_initial' },
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
    executions: { readLatestRootTurnLineage: async (identity) => identity },
  });
  return {
    belongs,
    headers,
    runs,
    setGraphClaim: (claim: typeof graphClaim) => {
      graphClaim = claim;
    },
  };
}

test('interaction visibility follows exact root and authenticated child runs, never Session ancestry alone', async () => {
  const f = fixture();
  assert.equal(await f.belongs(root, root), true);
  assert.equal(await f.belongs(child, root), true);
  for (const scope of [
    { ...root, invocationId: 'forged' },
    { ...root, turnId: 'forged' },
    { ...root, runId: 'manual', turnId: 'manual-turn', invocationId: 'inv-manual' },
    { sessionId: 'child', turnId: 'manual-turn', runId: 'child-manual' },
    { ...child, runId: undefined },
  ])
    assert.equal(await f.belongs(scope, root), false);
  const original = f.headers.get('child')!;
  f.headers.set('child', {
    ...original,
    subagentParent: {
      ...original.subagentParent!,
      spawnedBy: { parentRunId: 'manual', parentTurnId: 'manual-turn', toolCallId: 'spawn' },
    },
  });
  assert.equal(await f.belongs(child, root), false);
});

test('graph children require the exact Host-admitted graph claim', async () => {
  const f = fixture(),
    h = f.headers.get('child')!;
  f.headers.set('child', {
    ...h,
    subagentParent: {
      ...h.subagentParent!,
      graph: { graphId: 'graph', operatorId: 'worker', workId: 'work' },
    },
  });
  const claim = {
    graphId: 'graph',
    targetOperatorId: 'worker',
    targetSessionId: 'child',
    targetTurnId: 'child-turn',
    targetRunId: 'child-run',
  };
  f.setGraphClaim(claim);
  assert.equal(await f.belongs(child, root), true);
  for (const patch of [
    { graphId: 'another' },
    { targetOperatorId: 'another' },
    { targetSessionId: 'another' },
    { targetTurnId: 'another' },
    { targetRunId: 'another' },
  ]) {
    f.setGraphClaim({ ...claim, ...patch });
    assert.equal(await f.belongs(child, root), false);
  }
  f.setGraphClaim(undefined);
  assert.equal(await f.belongs(child, root), false);
});

test('terminated, unproven and cyclic child executions confer no interaction rights', async () => {
  const terminal = fixture();
  terminal.runs.get('child-run')!.terminalEvent = {
    status: 'completed',
  } as RuntimeInvocationRecord['terminalEvent'];
  assert.equal(await terminal.belongs(child, root), false);
  const missing = fixture();
  missing.runs.delete('child-run');
  assert.equal(await missing.belongs(child, root), false);
  const cycle = fixture(),
    h = cycle.headers.get('child')!;
  cycle.headers.set('child', {
    ...h,
    subagentParent: {
      ...h.subagentParent!,
      parentSessionId: 'child',
      spawnedBy: { parentRunId: 'child-run', parentTurnId: 'child-turn', toolCallId: 'cycle' },
    },
  });
  assert.equal(await cycle.belongs(child, root), false);
});
