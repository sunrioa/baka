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
import test from 'node:test';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { createWorkHubContextObserver } from '../server/workhub-context-observation.js';
import { HOST_OPERATION_SPECS } from '../protocol/index.js';

test('work context keeps the latest request on its own route and never presents it as current remaining capacity', async () => {
  const header = {
    model: 'current-model',
    llmConnectionId: 'current-connection',
    llmConnectionSlug: 'current',
  };
  const catalog = {
    connections: [
      {
        connectionId: 'current-connection',
        slug: 'current',
        providerType: 'ollama',
        models: [{ id: 'current-model', contextWindow: 128000, inputLimit: 100000 }],
      },
    ],
  } as unknown as ConnectionCatalogSnapshot;
  const observed = {
    status: 'observed' as const,
    eventId: 'latest-usage',
    runId: 'latest-run',
    observedAt: 123,
    modelId: 'previous-model',
    connectionId: 'previous-connection',
    connectionSlug: 'previous',
    inputTokens: 900000,
    outputTokens: 20,
  };
  let reads = 0;
  const observe = createWorkHubContextObserver({
    sessions: { readHeaderSnapshot: async () => header },
    runtime: {
      readLatestSessionRequestObservation: async () => {
        reads++;
        return observed;
      },
    },
    catalog: { getSnapshot: async () => catalog },
  });
  const context = await observe('session');
  assert.equal(reads, 1, 'no older matching usage query or transcript query exists in this seam');
  assert.equal(context.configuredInputLimit, 100000);
  assert.deepEqual(context.lastRequest, { ...observed, matchesCurrentRoute: false });
  assert.equal('remainingTokens' in context, false);
  assert.equal(context.currentModelId, 'current-model');
  assert.equal(context.estimates?.compaction.status, 'unknown');
  assert.equal(context.estimates?.compaction.reason, 'route_changed');
  assert.equal(context.estimates?.costs.reuseInputBaseline.uncachedUsd, null);
  const work = {
    workId: 'work',
    sourceActionId: 'source',
    sourceDelegationId: 'delegation',
    targetSessionId: 'session',
    targetSessionName: 'Task',
    coordinationTurnId: 'turn',
    createdAt: 1,
    originalRequest: 'Original objective',
    requestTruncated: false,
    objective: 'Objective',
    objectiveTruncated: false,
    available: true,
    context,
  };
  const spec = HOST_OPERATION_SPECS['workhub.coordination.works'];
  assert.deepEqual(spec.decodeOutput({ works: [work], nextCursor: null }), {
    works: [work],
    nextCursor: null,
  });
  for (const invalid of [
    { ...context, configuredInputLimit: 0 },
    { ...context, lastRequest: { ...observed, matchesCurrentRoute: 'yes' } },
    { ...context, lastRequest: { status: 'unknown', reason: 'invented' } },
    { ...context, lastRequest: { ...observed, matchesCurrentRoute: true, inputTokens: -1 } },
    { ...context, remainingTokens: 0 },
  ])
    assert.throws(() =>
      spec.decodeOutput({ works: [{ ...work, context: invalid }], nextCursor: null }),
    );
  const unknown = await createWorkHubContextObserver({
    sessions: {
      readHeaderSnapshot: async () => ({
        ...header,
        llmConnectionId: undefined,
        llmConnectionSlug: 'missing',
      }),
    },
    runtime: {},
    catalog: { getSnapshot: async () => catalog },
  })('session');
  assert.equal(unknown.currentConnectionId, null);
  assert.equal(unknown.configuredInputLimit, null);
  assert.deepEqual(unknown.lastRequest, { status: 'unknown', reason: 'unsupported_store' });
  const windowConflict = await createWorkHubContextObserver({
    sessions: { readHeaderSnapshot: async () => header },
    runtime: {
      readLatestSessionRequestObservation: async () => ({
        status: 'unknown',
        reason: 'scan_limit',
      }),
    },
    catalog: {
      getSnapshot: async () => ({
        ...catalog,
        connections: catalog.connections.map((connection) => ({
          ...connection,
          models: [{ id: 'current-model', contextWindow: 100, inputLimit: 101 }],
        })),
      }),
    },
  })('session');
  assert.equal(windowConflict.configuredInputLimit, null);
  assert.deepEqual(windowConflict.lastRequest, { status: 'unknown', reason: 'scan_limit' });
});

test('context estimates use the runtime window/reserve and explicit connection pricing without forcing a fresh route', async () => {
  const header = {
    model: 'current-model',
    llmConnectionId: 'current-connection',
    llmConnectionSlug: 'proxy',
  };
  const observe = createWorkHubContextObserver({
    sessions: { readHeaderSnapshot: async () => header },
    catalog: {
      getSnapshot: async () =>
        ({
          connections: [
            {
              connectionId: header.llmConnectionId,
              slug: 'proxy',
              providerType: 'ollama',
              models: [{ id: header.model, contextWindow: 128000, inputLimit: 100000 }],
              modelOverrides: { [header.model]: { compactionThreshold: 128000 } },
            },
          ],
        }) as unknown as ConnectionCatalogSnapshot,
    },
    readPricing: async () => [
      {
        modelKey: 'proxy:current-model',
        inputUsdPer1M: 2,
        outputUsdPer1M: 3,
        cacheReadUsdPer1M: 0.2,
      },
    ],
    runtime: {
      readLatestSessionRequestObservation: async () => ({
        status: 'observed',
        eventId: 'usage',
        runId: 'run',
        observedAt: 200,
        requestedAt: 100,
        modelId: header.model,
        connectionId: header.llmConnectionId,
        connectionSlug: 'proxy',
        inputTokens: 125000,
        outputTokens: 1000,
        cacheReadInputTokens: 120000,
        cacheMissInputTokens: 5000,
        cacheWriteInputTokens: 0,
      }),
    },
  });
  const result = await observe('source');
  assert.equal(result.configuredInputLimit, 100000);
  assert.deepEqual(result.estimates?.compaction, {
    status: 'estimated',
    reason: 'baseline_only',
    baselineTokens: 126000,
    replyReserveTokens: 2000,
    configuredThreshold: 128000,
    baselineAtOrOverThreshold: true,
    nextRequest: 'unknown',
  });
  assert.deepEqual(result.estimates?.cache, {
    status: 'unknown',
    reason: 'provider_state_not_observable',
  });
  assert.equal(result.lastRequest.status, 'observed');
  assert.ok(result.lastRequest.status === 'observed');
  assert.equal(
    result.lastRequest.requestedAt,
    100,
    'activity/observation time is not request time',
  );
  assert.equal(result.lastRequest.cacheReadInputTokens, 120000);
  assert.equal(result.estimates?.costs.pricingSource, 'configured_connection_override');
  assert.equal(result.estimates?.costs.reuseInputBaseline.uncachedUsd, 0.252);
  assert.equal(result.estimates?.costs.reuseInputBaseline.allCachedUsd, 0.0252);
  assert.equal(result.estimates?.costs.compactionTotal, 'unknown');
  assert.equal(result.estimates?.costs.freshWithSelectiveReadsTotal, 'unknown');
  assert.equal('recommendedContainer' in result, false);
});
