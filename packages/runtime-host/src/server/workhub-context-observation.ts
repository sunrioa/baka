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
import { resolveSelectedModelContextWindow } from '@maka/runtime/context-budget-policy';
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
      } catch {
        // Contradictory configured limits are not a usable window.
      }
    }
    const observation = (await options.runtime.readLatestSessionRequestObservation?.(
      sessionId,
    )) ?? { status: 'unknown' as const, reason: 'unsupported_store' as const };
    return {
      currentModelId: header.model,
      currentConnectionId,
      currentConnectionSlug: header.llmConnectionSlug,
      configuredInputLimit,
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
