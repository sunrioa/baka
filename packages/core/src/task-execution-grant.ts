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
  decodeClientCapabilityGrantTarget,
  type ClientCapabilityGrantTarget,
} from './client-capability-grant.js';
import {
  validateSandboxBoundaryExpansion,
  type SandboxBoundaryExpansion,
} from './sandbox-boundary.js';
import { serializedByteLength } from './serialized-byte-length.js';

/** A supplemental grant is not a Session configuration or an execution owner. */
export interface TaskExecutionGrant {
  readonly version: 1;
  readonly grantId: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly rootRunId: string;
  readonly delegationId: string;
  readonly sourceSessionId: string;
  readonly sourceRequestId: string;
  readonly sourceTurnId: string;
  readonly sourceRunId: string;
  readonly rootBoundaryRevision: number;
  readonly sourceBoundaryRevision: number;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly resource:
    | { readonly kind: 'sandbox'; readonly expansion: SandboxBoundaryExpansion }
    | { readonly kind: 'client_capability'; readonly target: ClientCapabilityGrantTarget };
}

export type TaskGrantClosureReason =
  | 'revoked'
  | 'expired'
  | 'task_terminal'
  | 'task_cancelled'
  | 'authority_changed';
export interface TaskExecutionGrantRecord {
  readonly grant: TaskExecutionGrant;
  readonly closure?: { readonly reason: TaskGrantClosureReason; readonly closedAt: number };
}

export const TASK_GRANT_DEFAULT_LIFETIME_MS = 60 * 60 * 1000;
export const TASK_GRANT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const TASK_GRANT_MAX_ACTIVE_PER_ROOT = 32;

export function decodeTaskExecutionGrant(value: unknown): TaskExecutionGrant {
  const v = record(value);
  exact(v, [
    'version',
    'grantId',
    'rootSessionId',
    'rootTurnId',
    'rootRunId',
    'delegationId',
    'sourceSessionId',
    'sourceRequestId',
    'sourceTurnId',
    'sourceRunId',
    'rootBoundaryRevision',
    'sourceBoundaryRevision',
    'grantedAt',
    'expiresAt',
    'resource',
  ]);
  if (v.version !== 1 || serializedByteLength(value) > 128 * 1024)
    throw new Error('Invalid task grant version or size');
  const grantedAt = timestamp(v.grantedAt),
    expiresAt = timestamp(v.expiresAt);
  if (expiresAt <= grantedAt || expiresAt - grantedAt > TASK_GRANT_MAX_LIFETIME_MS)
    throw new Error('Invalid task grant lifetime');
  const r = record(v.resource);
  let resource: TaskExecutionGrant['resource'];
  if (r.kind === 'sandbox') {
    exact(r, ['kind', 'expansion']);
    const expansion = validateSandboxBoundaryExpansion(r.expansion);
    if (!expansion.ok) throw new Error(expansion.message);
    resource = { kind: 'sandbox', expansion: expansion.expansion };
  } else if (r.kind === 'client_capability') {
    exact(r, ['kind', 'target']);
    resource = { kind: 'client_capability', target: decodeClientCapabilityGrantTarget(r.target) };
  } else throw new Error('Invalid task grant resource');
  return freeze({
    version: 1,
    grantId: id(v.grantId),
    rootSessionId: id(v.rootSessionId),
    rootTurnId: id(v.rootTurnId),
    rootRunId: id(v.rootRunId),
    delegationId: id(v.delegationId),
    sourceSessionId: id(v.sourceSessionId),
    sourceRequestId: id(v.sourceRequestId),
    sourceTurnId: id(v.sourceTurnId),
    sourceRunId: id(v.sourceRunId),
    rootBoundaryRevision: timestamp(v.rootBoundaryRevision),
    sourceBoundaryRevision: timestamp(v.sourceBoundaryRevision),
    grantedAt,
    expiresAt,
    resource,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new Error('Invalid task grant record');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error('Invalid task grant fields');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new Error('Invalid task grant identity');
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid task grant timestamp');
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
