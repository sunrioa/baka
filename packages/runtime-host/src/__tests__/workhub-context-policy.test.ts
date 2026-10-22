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
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import {
  resolveDeclaredContextWindow,
  resolveSelectedModelContextWindow,
} from '@maka/runtime/context-budget-policy';
import { workHubContextConnection } from '../server/workhub-context-policy.js';
import { createWorkHubContextObserver } from '../server/workhub-context-observation.js';

test('the coordinator-only target overrides one activation without mutating a model, task or model window', async () => {
  const connection = {
    slug: 'proxy',
    providerType: 'ollama' as const,
    defaultModel: 'selected',
    models: [{ id: 'selected', contextWindow: 512000 }],
    modelOverrides: {
      selected: { compactionThreshold: 123456, maxOutputTokens: 2000 },
      other: { compactionThreshold: 111 },
    },
  };
  const before = structuredClone(connection);
  assert.equal(
    workHubContextConnection(connection, WORKHUB_COORDINATION_SESSION_ID, 'selected', {}),
    connection,
  );
  assert.equal(
    workHubContextConnection(connection, 'worker', 'selected', {
      workHubCompactionThreshold: 234567,
    }),
    connection,
  );
  const effective = workHubContextConnection(
    connection,
    WORKHUB_COORDINATION_SESSION_ID,
    'selected',
    { workHubCompactionThreshold: 234567 },
  );
  assert.equal(resolveDeclaredContextWindow(effective, 'selected'), 234567);
  assert.equal(resolveDeclaredContextWindow(effective, 'other'), 111);
  assert.equal(resolveSelectedModelContextWindow(effective, 'selected'), 512000);
  assert.equal(effective.modelOverrides.selected.maxOutputTokens, 2000);
  assert.deepEqual(connection, before);
  const policy = createDefaultRuntimePolicy();
  const observe = createWorkHubContextObserver({
    sessions: {
      readHeaderSnapshot: async () => ({
        model: 'selected',
        llmConnectionId: 'account',
        llmConnectionSlug: 'proxy',
      }),
    },
    catalog: {
      getSnapshot: async () =>
        ({
          revision: 1,
          connections: [{ ...connection, connectionId: 'account', name: 'Proxy' }],
        }) as never,
    },
    policy: {
      getSnapshot: async () => ({
        revision: 1,
        policy: {
          ...policy,
          chatDefaults: { ...policy.chatDefaults, workHubCompactionThreshold: 234567 },
        },
      }),
    },
    runtime: {},
  });
  assert.equal(
    (await observe(WORKHUB_COORDINATION_SESSION_ID)).estimates?.compaction.configuredThreshold,
    234567,
  );
  assert.equal((await observe('worker')).estimates?.compaction.configuredThreshold, 123456);
});

test('an unconfigured model stays unconfigured; neither model capacity nor an empty override supplies a target', () => {
  const connection = {
    slug: 'proxy',
    providerType: 'ollama' as const,
    defaultModel: 'selected',
    models: [{ id: 'selected', contextWindow: 512000 }],
  };
  const effective = workHubContextConnection(
    connection,
    WORKHUB_COORDINATION_SESSION_ID,
    'selected',
    {},
  );
  assert.equal(resolveSelectedModelContextWindow(effective, 'selected'), 512000);
  assert.equal(resolveDeclaredContextWindow(effective, 'selected'), undefined);
});
