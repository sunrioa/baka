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
import { isChatDefaultPermissionMode, isWorkHubMaxConcurrentSessions, WORKHUB_DEFAULT_MAX_CONCURRENT_SESSIONS, type ChatDefaultPermissionMode } from '@maka/core/settings';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type WorkHubExecutionDefaults = Omit<WorkHubCreateDefaults, 'permissionMode'>;

// A transport reconnect replaces the client object but preserves the logical
// Host identity. Keep this Desktop-owned preference on that stable boundary so
// the renderer and the WorkHub creation path cannot disagree after reconnect.
// Model/executor preferences remain process-local. Permission defaults use the
// Host's durable policy below, rather than this Desktop cache.
const defaultsByHost = new Map<string, WorkHubExecutionDefaults>();

export function readWorkHubNewWorkDefaults(hostId: string): WorkHubExecutionDefaults {
  return defaultsByHost.get(hostId) ?? {};
}

export function writeWorkHubNewWorkDefaults(
  hostId: string,
  defaults: WorkHubExecutionDefaults,
): void {
  defaultsByHost.set(hostId, Object.freeze({ ...defaults }));
}

type WorkHubPermissionClient = Pick<DesktopRuntimeHostClient, 'queryRuntimePolicy' | 'updateRuntimePolicy'>;

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
