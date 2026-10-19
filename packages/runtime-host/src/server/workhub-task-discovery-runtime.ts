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

import {
  isSessionNotFoundError,
  WorkHubTaskIndexCursorError,
} from '@maka/storage/execution-stores';
import type { WorkHubContextObservation } from '../protocol/workhub-coordination.js';
import type { OperationHandlerMap } from './operation-dispatcher.js';
import type { createWorkHubTaskIndexProjection } from './workhub-task-index-projection.js';

export function createWorkHubTaskDiscoveryRuntime(options: {
  projection?: ReturnType<typeof createWorkHubTaskIndexProjection>;
  readContext(sessionId: string): Promise<WorkHubContextObservation>;
  onError(error: unknown): void;
}) {
  return {
    handlers: {
      'workhub.tasks.find': async (input) => {
        const projection = options.projection;
        if (!projection)
          return {
            ok: false as const,
            error: {
              code: 'operation_unavailable' as const,
              message: 'This storage provider does not support task discovery',
            },
          };
        try {
          const page = await projection.query(input);
          const items = await Promise.all(
            page.items.map(async (hit) => {
              let available = hit.available;
              let context: WorkHubContextObservation | undefined;
              try {
                if (available) context = await options.readContext(hit.currentSessionId);
              } catch (error) {
                if (!isSessionNotFoundError(error)) throw error;
                available = false;
              }
              return {
                kind: hit.kind,
                id: hit.id,
                title: hit.title,
                state: !available
                  ? ('unavailable' as const)
                  : hit.kind === 'session'
                    ? ('available' as const)
                    : hit.state,
                lastActivityAt: hit.activityAt,
                location: projection.location(hit) || null,
                available,
                summary: hit.summary,
                segments: hit.segmentCount,
                ...(context ? { context } : {}),
              };
            }),
          );
          return {
            ok: true as const,
            result: { items, match: page.match, nextCursor: page.nextCursor },
          };
        } catch (error) {
          if (error instanceof WorkHubTaskIndexCursorError)
            return {
              ok: false as const,
              error: { code: 'operation_conflict' as const, message: error.message },
            };
          options.onError(error);
          return {
            ok: false as const,
            error: {
              code: 'persistence_failed' as const,
              message: 'Task discovery could not read its source records',
            },
          };
        }
      },
    } satisfies Pick<OperationHandlerMap, 'workhub.tasks.find'>,
  };
}
