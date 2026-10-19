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

import type { SessionHeader } from '@maka/core/session';
import type { ExecutionRuntimeEventWriter } from '@maka/storage/execution-stores';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import {
  compactionReplyReserveTokens,
  resolveDeclaredContextWindow,
  resolveSelectedModelContextWindow,
} from '@maka/runtime/context-budget-policy';
import { pricingModelKey } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import type { WorkHubContextObservation } from '../protocol/workhub-coordination.js';

/** Advisory metadata only: no credentials, provider request or full transcript read. */
export function createWorkHubContextObserver(options: {
  sessions: {
    readHeaderSnapshot(
      sessionId: string,
    ): Promise<Pick<SessionHeader, 'model' | 'llmConnectionId' | 'llmConnectionSlug'>>;
  };
  runtime: Pick<ExecutionRuntimeEventWriter, 'readLatestSessionRequestObservation'>;
  catalog: Pick<RuntimePolicyStoresWriter['connectionCatalog'], 'getSnapshot'>;
  readPricing?(): Promise<readonly PricingConfig[]>;
}): (sessionId: string) => Promise<WorkHubContextObservation> {
  return async (sessionId) => {
    const header = await options.sessions.readHeaderSnapshot(sessionId);
    const catalog = await options.catalog.getSnapshot();
    const connection = catalog.connections.find(
      (entry) =>
        entry.slug === header.llmConnectionSlug &&
        (header.llmConnectionId === undefined || entry.connectionId === header.llmConnectionId),
    );
    const currentConnectionId = header.llmConnectionId ?? connection?.connectionId ?? null;
    let configuredInputLimit: number | null = null;
    let compactionWindow: number | null = null;
    if (connection) {
      // Use the execution policy's limit rule, but only public catalog facts.
      try {
        configuredInputLimit =
          resolveSelectedModelContextWindow(
            {
              slug: connection.slug,
              providerType: connection.providerType,
              defaultModel: header.model,
              models: [...connection.models],
              modelOverrides: connection.modelOverrides,
            },
            header.model,
          ) ?? null;
        compactionWindow =
          resolveDeclaredContextWindow(
            {
              slug: connection.slug,
              providerType: connection.providerType,
              defaultModel: header.model,
              models: [...connection.models],
              modelOverrides: connection.modelOverrides,
            },
            header.model,
          ) ?? null;
      } catch {
        // Contradictory configured limits are not a usable window.
      }
    }
    const observation = (await options.runtime.readLatestSessionRequestObservation?.(
      sessionId,
    )) ?? { status: 'unknown' as const, reason: 'unsupported_store' as const };
    const routeMatches =
      observation.status === 'observed' &&
      currentConnectionId !== null &&
      observation.modelId === header.model &&
      observation.connectionId === currentConnectionId;
    const baseline =
      routeMatches && observation.outputTokens !== undefined
        ? observation.inputTokens + observation.outputTokens
        : null;
    const reserve =
      baseline === null || observation.status !== 'observed'
        ? null
        : compactionReplyReserveTokens(observation.outputTokens);
    // A proxy's rates/TTL are not its upstream's advertised rates/TTL. Use an
    // explicit connection override only; absent price and future reads stay unknown.
    const pricing =
      connection && options.readPricing
        ? (await options.readPricing()).find(
            (entry) => entry.modelKey === pricingModelKey(connection.slug, header.model),
          )
        : undefined;
    return {
      currentModelId: header.model,
      currentConnectionId,
      currentConnectionSlug: header.llmConnectionSlug,
      configuredInputLimit,
      estimates: {
        compaction: {
          status: baseline !== null && compactionWindow !== null ? 'estimated' : 'unknown',
          reason:
            observation.status !== 'observed' || observation.outputTokens === undefined
              ? 'usage_unknown'
              : !routeMatches
                ? 'route_changed'
                : compactionWindow === null
                  ? 'threshold_unconfigured'
                  : 'baseline_only',
          baselineTokens: baseline,
          replyReserveTokens: reserve,
          configuredThreshold: compactionWindow,
          baselineAtOrOverWindow:
            baseline !== null && reserve !== null && compactionWindow !== null
              ? baseline + reserve >= compactionWindow
              : null,
          nextRequest: 'unknown',
        },
        cache: { status: 'unknown', reason: 'provider_state_not_observable' },
        costs: {
          pricingSource: pricing ? 'configured_connection_override' : 'unknown',
          reuseInputBaseline: {
            status: baseline !== null && pricing ? 'estimated' : 'unknown',
            inputTokens: baseline,
            uncachedUsd:
              baseline !== null && pricing ? (baseline * pricing.inputUsdPer1M) / 1_000_000 : null,
            allCachedUsd:
              baseline !== null && pricing?.cacheReadUsdPer1M !== undefined
                ? (baseline * pricing.cacheReadUsdPer1M) / 1_000_000
                : null,
            assumption: 'last_request_plus_output_excluding_new_input_and_future_output',
          },
          compactionTotal: 'unknown',
          freshWithSelectiveReadsTotal: 'unknown',
        },
      },
      lastRequest:
        observation.status === 'unknown'
          ? observation
          : {
              ...observation,
              matchesCurrentRoute:
                currentConnectionId === null
                  ? null
                  : observation.modelId === header.model &&
                    observation.connectionId === currentConnectionId,
            },
    };
  };
}
