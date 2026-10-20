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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RuntimePolicyDocumentOwner } from './policy-document.js';

test('WorkHub executor defaults reopen through the existing policy document without changing permissions or ordinary defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-workhub-executor-policy-'));
  try {
    const owner = new RuntimePolicyDocumentOwner();
    const before = await owner.read(root);
    const workHubExecutor = {
      executorId: 'codex.app-server',
      executorModel: 'gpt-6-astra',
      thinkingLevel: 'high' as const,
    };
    const chatDefaults = {
      ...before.policy.chatDefaults,
      workHubPermissionMode: 'ask' as const,
      workHubMaxConcurrentSessions: 2,
      codeModeEnabled: true,
      workHubExecutor,
    };
    const saved = await owner.mutate(root, {
      expectedRevision: before.revision,
      operation: { kind: 'set_chat_defaults', value: chatDefaults },
    });
    assert.equal(saved.kind, 'committed');
    const replacement = new RuntimePolicyDocumentOwner();
    const reopened = await replacement.read(root);
    assert.deepEqual(reopened.policy.chatDefaults, chatDefaults);
    assert.equal(
      reopened.policy.chatDefaults.permissionMode,
      before.policy.chatDefaults.permissionMode,
    );
    const { workHubExecutor: _executor, ...native } = reopened.policy.chatDefaults;
    const cleared = await replacement.mutate(root, {
      expectedRevision: reopened.revision,
      operation: { kind: 'set_chat_defaults', value: native },
    });
    assert.equal(cleared.kind, 'committed');
    assert.deepEqual(
      (await new RuntimePolicyDocumentOwner().read(root)).policy.chatDefaults,
      native,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
