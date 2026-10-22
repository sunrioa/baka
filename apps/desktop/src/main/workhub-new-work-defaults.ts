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

import { isWorkHubCreateDefaults, WORKHUB_COORDINATION_SESSION_ID, type WorkHubCreateDefaults } from '@maka/core/session';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import { isChatDefaultPermissionMode, isWorkHubMaxConcurrentSessions, isWorkHubExecutorDefaults, WORKHUB_DEFAULT_MAX_CONCURRENT_SESSIONS, type ChatDefaultPermissionMode } from '@maka/core/settings';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type WorkHubExecutionDefaults = Omit<WorkHubCreateDefaults, 'permissionMode'>;

type WorkHubModelClient = Pick<DesktopRuntimeHostClient, 'hostId' | 'getWorkHubSession' | 'configureWorkHubModel' | 'queryRuntimePolicy' | 'updateRuntimePolicy'>;
type WorkHubModelSession = Pick<SessionCatalogProjection, 'id' | 'llmConnectionId' | 'llmConnectionSlug' | 'model' | 'thinkingLevel'>;
async function readExecutionDefaults(client: { getWorkHubSession(): Promise<WorkHubModelSession | null> }, executor: unknown): Promise<WorkHubExecutionDefaults> {
  if (executor !== undefined) {
    if (!isWorkHubExecutorDefaults(executor)) throw new Error('Saved WorkHub executor defaults are unavailable');
    // Preserve the user's exact selection even if its provider is unavailable.
    // Catalog presentation and native Host admission report that; never fall back.
    return { ...executor };
  }
  const session = await client.getWorkHubSession();
  if (session?.id !== WORKHUB_COORDINATION_SESSION_ID || !session.llmConnectionId || !session.llmConnectionSlug || !session.model)
    throw new Error('Select an available model for newly created WorkHub tasks');
  return { model: { llmConnectionId: session.llmConnectionId, llmConnectionSlug: session.llmConnectionSlug, model: session.model },
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}) };
}

/** Native configuration stays on the coordinator; executor choice uses the same Host policy as permissions. */
export async function readWorkHubNewWorkDefaults(client: Pick<WorkHubModelClient, 'hostId' | 'queryRuntimePolicy'> & { getWorkHubSession(): Promise<WorkHubModelSession | null> }): Promise<WorkHubExecutionDefaults> {
  const { policy } = await client.queryRuntimePolicy();
  return readExecutionDefaults(client, policy.chatDefaults.workHubExecutor);
}

export async function writeWorkHubNewWorkDefaults(client: WorkHubModelClient, defaults: WorkHubExecutionDefaults): Promise<void> {
  if (!isWorkHubCreateDefaults(defaults) || defaults.permissionMode !== undefined)
    throw new Error('Invalid WorkHub new-work defaults');
  if (defaults.executorId) {
    const executor = { executorId: defaults.executorId, ...(defaults.executorModel ? { executorModel: defaults.executorModel } : {}), ...(defaults.thinkingLevel ? { thinkingLevel: defaults.thinkingLevel } : {}) };
    await client.updateRuntimePolicy(policy => ({ kind: 'set_chat_defaults', value: { ...policy.chatDefaults, workHubExecutor: executor } }));
    return;
  }
  if (defaults.model) {
    const current = await client.getWorkHubSession();
    if (current.id !== WORKHUB_COORDINATION_SESSION_ID) throw new Error('WorkHub model configuration is unavailable');
    const result = await client.configureWorkHubModel({ expectedRevision: current.revision,
      modelTarget: { kind: 'explicit', connectionId: defaults.model.llmConnectionId, connectionSlug: defaults.model.llmConnectionSlug, model: defaults.model.model },
      thinkingLevel: defaults.thinkingLevel ?? null });
    if (result.kind !== 'committed') throw new Error('WorkHub changed. Try selecting the model again.');
  }
  if ((await client.queryRuntimePolicy()).policy.chatDefaults.workHubExecutor !== undefined) {
    await client.updateRuntimePolicy(policy => {
      const { workHubExecutor: _executor, ...chatDefaults } = policy.chatDefaults;
      return { kind: 'set_chat_defaults', value: chatDefaults };
    });
  }
}

type WorkHubPermissionClient = Pick<DesktopRuntimeHostClient, 'queryRuntimePolicy' | 'updateRuntimePolicy'>;

export async function readWorkHubCreationDefaults(client: Pick<DesktopRuntimeHostClient, 'hostId' | 'queryRuntimePolicy'> & {
  getWorkHubSession(): Promise<WorkHubModelSession | null>;
}): Promise<WorkHubCreateDefaults> {
  const { policy } = await client.queryRuntimePolicy();
  return { permissionMode: policy.chatDefaults.workHubPermissionMode ?? 'ask', ...await readExecutionDefaults(client, policy.chatDefaults.workHubExecutor) };
}

// Permission defaults belong to the selected Host's durable policy, not the
// coordination Session's internal bypass boundary or the ordinary chat default.
export async function readWorkHubNewWorkPermissionMode(
  client: Pick<WorkHubPermissionClient, 'queryRuntimePolicy'>,
): Promise<ChatDefaultPermissionMode> {
  return (await client.queryRuntimePolicy()).policy.chatDefaults.workHubPermissionMode ?? 'ask';
}

export async function writeWorkHubNewWorkPermissionMode(
  client: WorkHubPermissionClient,
  mode: unknown,
): Promise<ChatDefaultPermissionMode> {
  if (!isChatDefaultPermissionMode(mode)) throw new Error('Invalid WorkHub new-work permission mode');
  const snapshot = await client.updateRuntimePolicy((policy) => ({
    kind: 'set_chat_defaults',
    value: { ...policy.chatDefaults, workHubPermissionMode: mode },
  }));
  return snapshot.policy.chatDefaults.workHubPermissionMode ?? 'ask';
}

export async function readWorkHubExecutionConcurrency(client: Pick<WorkHubPermissionClient, 'queryRuntimePolicy'>): Promise<number> {
  return (await client.queryRuntimePolicy()).policy.chatDefaults.workHubMaxConcurrentSessions ?? WORKHUB_DEFAULT_MAX_CONCURRENT_SESSIONS;
}

export async function writeWorkHubExecutionConcurrency(client: WorkHubPermissionClient, value: unknown): Promise<number> {
  if (!isWorkHubMaxConcurrentSessions(value)) throw new Error('Invalid WorkHub execution concurrency');
  const snapshot = await client.updateRuntimePolicy((policy) => ({
    kind: 'set_chat_defaults', value: { ...policy.chatDefaults, workHubMaxConcurrentSessions: value },
  }));
  return snapshot.policy.chatDefaults.workHubMaxConcurrentSessions ?? WORKHUB_DEFAULT_MAX_CONCURRENT_SESSIONS;
}

export async function readWorkHubCompactionThreshold(client: Pick<WorkHubPermissionClient, 'queryRuntimePolicy'>): Promise<number | null> {
  return (await client.queryRuntimePolicy()).policy.chatDefaults.workHubCompactionThreshold ?? null;
}

/** null explicitly restores inheritance; no numeric default is introduced. */
export async function writeWorkHubCompactionThreshold(client: WorkHubPermissionClient, value: unknown): Promise<number | null> {
  if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('WorkHub compaction target must be a positive safe integer');
  }
  const snapshot = await client.updateRuntimePolicy(policy => {
    const { workHubCompactionThreshold: _threshold, ...defaults } = policy.chatDefaults;
    return { kind: 'set_chat_defaults', value: value === null ? defaults : { ...defaults, workHubCompactionThreshold: value as number } };
  });
  return snapshot.policy.chatDefaults.workHubCompactionThreshold ?? null;
}
