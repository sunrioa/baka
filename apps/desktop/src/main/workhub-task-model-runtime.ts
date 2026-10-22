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

import type { WorkHubCreateDefaults } from '@maka/core/session';
import { clientCapabilityEntityId } from '@maka/runtime-host/client-capability-entity-id';
import type { WorkHubTaskToolRequest } from '../shared/workhub-task-tool-schema.js';
import type { DesktopTargetScope } from '../shared/runtime-host-identity.js';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

interface WorkHubTaskModelDeps {
  client(scope: DesktopTargetScope): Pick<DesktopRuntimeHostClient, 'findWorkHubTasks' | 'startWorkHubTask' | 'askWorkHubTask' | 'continueWorkHubTaskFromTurn' | 'stopWorkHubTasks'>;
  isCurrent(scope: DesktopTargetScope): boolean;
  createDefaults(scope: DesktopTargetScope): Promise<WorkHubCreateDefaults>;
  changed(scope: DesktopTargetScope, reason: 'created' | 'status-change', sessionId: string): void;
}

/** Thin Desktop adapters: the Host keeps source proof, confirmation and queue ownership. */
export function createWorkHubTaskModelRuntime(deps: WorkHubTaskModelDeps) {
  const requireCurrent = (scope: DesktopTargetScope) => {
    if (!deps.isCurrent(scope)) throw new Error('Runtime Host changed');
  };
  return {
    async actTask(scope: DesktopTargetScope, turnId: string, toolCallId: string, request: WorkHubTaskToolRequest) {
      requireCurrent(scope);
      const client = deps.client(scope);
      // Scope by the actual execution Turn. Identical opaque tool-call ids in
      // later Turns must not replay earlier effects. No identity comes from arguments.
      const actionId = clientCapabilityEntityId(JSON.stringify(['workhub-task', turnId, toolCallId]));
      switch (request.kind) {
        case 'find': {
          const result = await client.findWorkHubTasks(request.input);
          requireCurrent(scope);
          // Candidate discovery is not a metering report. Detailed context is
          // available on demand through WorkHubRead(status) for the chosen task.
          // Keep the Host/UI page untouched, including its opaque cursor.
          return { ...result, items: result.items.map(({ context: _context, ...item }) => item) };
        }
        case 'start': {
          const { title, text, sessionRef, cwdHint } = request.input;
          const target = sessionRef
            ? { sessionRef }
            : { create: { workspace: cwdHint ? { kind: 'host_path' as const, path: cwdHint } : { kind: 'isolated' as const } }, newWorkDefaults: await deps.createDefaults(scope) };
          requireCurrent(scope);
          const result = await client.startWorkHubTask({ turnId, actionId, title, text, ...target });
          requireCurrent(scope);
          if (result.workId !== actionId) throw Error('Task start receipt changed its identity');
          deps.changed(scope, result.disposition === 'create_new' ? 'created' : 'status-change', result.targetSessionId);
          return { taskId: actionId, admission: 'admitted' as const };
        }
        case 'continue': {
          const result = await client.continueWorkHubTaskFromTurn({ turnId, actionId, ...request.input });
          requireCurrent(scope);
          if (result.container === 'fresh') {
            deps.changed(scope, 'created', result.action.targetSessionId);
            return { taskId: request.input.taskId, container: 'fresh' as const, admission: 'admitted' as const };
          }
          deps.changed(scope, 'status-change', result.input.targetSessionId);
          return { taskId: request.input.taskId, container: 'reuse' as const, acceptedAt: result.input.acceptedAt, mode: result.input.mode, delivery: result.input.delivery };
        }
        case 'ask': {
          const result = await client.askWorkHubTask({ turnId, actionId, ...request.input });
          requireCurrent(scope);
          return result;
        }
        case 'stop': {
          const result = await client.stopWorkHubTasks({ turnId, actionId, ...request.input });
          requireCurrent(scope);
          if (result.kind === 'cancelled') return { kind: result.kind, taskIds: result.taskIds };
          for (const target of result.targets) deps.changed(scope, 'status-change', target.targetSessionId);
          return { kind: result.kind, targets: result.targets.map(target => ({ taskId: target.workId, outcome: target.outcome })) };
        }
      }
    },
  };
}
