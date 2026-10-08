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
import { decodeTaskExecutionGrant, TASK_GRANT_MAX_LIFETIME_MS } from '../task-execution-grant.js';

const value = {
  version: 1,
  grantId: 'request',
  rootSessionId: 'root',
  rootTurnId: 'turn',
  rootRunId: 'run',
  delegationId: 'delegation',
  sourceSessionId: 'root',
  sourceRequestId: 'request',
  sourceTurnId: 'turn',
  sourceRunId: 'run',
  rootBoundaryRevision: 0,
  sourceBoundaryRevision: 0,
  grantedAt: 10,
  expiresAt: 100,
  resource: {
    kind: 'sandbox',
    expansion: {
      filesystem: { entries: [{ path: '/outside', scope: 'subtree', access: 'read' }] },
    },
  },
};
test('task grants are closed, immutable and bounded authority records', () => {
  const decoded = decodeTaskExecutionGrant(value);
  assert.deepEqual(decoded, value);
  assert.ok(Object.isFrozen(decoded.resource));
  for (const patch of [
    { version: 2 },
    { rootRunId: '' },
    { grantId: '../escape' },
    { rootBoundaryRevision: -1 },
    { expiresAt: 10 },
    { expiresAt: 11 + TASK_GRANT_MAX_LIFETIME_MS },
    { grantedAt: NaN },
    { permissionMode: 'bypass' },
    { resource: { kind: 'all_tools' } },
    { resource: { ...value.resource, inherited: true } },
  ])
    assert.throws(() => decodeTaskExecutionGrant({ ...value, ...patch }));
});
test('client task grants retain the exact provider, capability and evidence scope', () => {
  const target = {
    providerId: 'provider',
    contractId: 'contract',
    serverId: 'server',
    toolName: 'navigate',
    capability: 'browser',
    scope: { kind: 'browser_origin', origin: 'https://example.com' },
  };
  assert.deepEqual(
    decodeTaskExecutionGrant({ ...value, resource: { kind: 'client_capability', target } })
      .resource,
    { kind: 'client_capability', target },
  );
  assert.throws(() =>
    decodeTaskExecutionGrant({
      ...value,
      resource: { kind: 'client_capability', target: { ...target, capability: '*' } },
    }),
  );
});
