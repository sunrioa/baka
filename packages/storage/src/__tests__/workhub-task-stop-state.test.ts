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
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationStopRequestedMessage,
  type WorkHubDelegationStopResolvedMessage,
} from '@maka/core/session';
import { createSessionStore } from '../session-store.js';
import { assignmentRequest, createCoordinationSession } from './fixtures/workhub-assignment.js';

const suffix = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 48);

for (const scenario of [
  'modern',
  'legacy',
  'mixed-modern',
  'mixed-legacy',
  'delivered',
  'retired-after-noop',
] as const)
  test(
    'active linkage pairs aggregate stop outcomes with their own request (' + scenario + ')',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-stop-linkage-'));
      let store = createSessionStore(root);
      try {
        await createCoordinationSession(store, root);
        const target = await store.create({
          cwd: root,
          name: 'Stop linkage fixture',
          llmConnectionSlug: 'test',
          model: 'test',
          permissionMode: 'ask',
        });
        const { assignment, ...rest } = assignmentRequest('work', target.id, target.name, 'turn');
        await store.assignWorkHubMessage({ assignment, ...rest });
        const delegationSuffix = suffix(assignment.delegationId);
        const append = async (
          actionId: string,
          modern: boolean,
          primary: boolean,
          outcome: WorkHubDelegationStopResolvedMessage['outcome'],
          retirementSlot = false,
        ) => {
          const actionSuffix = suffix(JSON.stringify([assignment.delegationId, actionId]));
          const request: WorkHubDelegationStopRequestedMessage = {
            type: 'workhub_coordination',
            kind: 'delegation_stop_requested',
            schemaVersion: 3,
            id: 'whq_' + (primary ? delegationSuffix : actionSuffix),
            turnId: 'coordinator-turn',
            coordinationTurnId: 'coordinator-turn',
            ts: primary ? 20 : 22,
            actionId,
            actionFingerprint: `sha256:${'d'.repeat(64)}`,
            stopsActionId: assignment.actionId,
            stopsDelegationId: assignment.delegationId,
            targetSessionId: target.id,
            targetMessageId: assignment.targetMessageId,
            targetSessionName: target.name,
            userText: 'Stop the selected task',
            ...(modern
              ? { taskStop: true, workId: assignment.actionId, executionBinding: 'root-binding' }
              : {}),
          };
          const resolution: WorkHubDelegationStopResolvedMessage = {
            type: 'workhub_coordination',
            kind: 'delegation_stop_resolved',
            schemaVersion: 3,
            id: 'whz_' + actionSuffix,
            turnId: 'coordinator-turn',
            coordinationTurnId: 'coordinator-turn',
            ts: request.ts + 1,
            actionId,
            actionFingerprint: request.actionFingerprint,
            stopsActionId: assignment.actionId,
            stopsDelegationId: assignment.delegationId,
            targetSessionId: target.id,
            outcome,
            targetTurnId: 'turn',
          };
          await store.appendMessages(WORKHUB_COORDINATION_SESSION_ID, [
            request,
            resolution,
            {
              ...resolution,
              id: (retirementSlot ? 'whzs_' : primary ? 'whz_' : 'whzt_') + delegationSuffix,
            },
          ]);
        };
        const modern =
          scenario === 'modern' || scenario === 'mixed-modern' || scenario === 'delivered';
        const mixed = scenario.startsWith('mixed-');
        if (mixed) await append('earlier-stop', !modern, true, 'not_owned');
        await append(
          'matched-stop',
          modern,
          !mixed,
          scenario === 'retired-after-noop'
            ? 'not_owned'
            : scenario === 'delivered'
              ? 'stop_delivered'
              : 'already_terminal',
        );
        if (scenario === 'retired-after-noop') {
          await append('modern-noop', true, false, 'already_terminal');
          await append('actual-retirement', true, false, 'stop_delivered', true);
        }
        await store.close?.();
        store = createSessionStore(root);
        // Persistence/projection fixture only: these facts do not execute Stop
        // or prove a Runtime outcome. The execution composition tests do that.
        const active = await store.readActiveWorkHubAssignmentsByTarget([target.id]);
        if (scenario === 'retired-after-noop')
          assert.equal(
            (await store.readWorkHubStopResolution(assignment.delegationId))?.actionId,
            'actual-retirement',
          );
        assert.deepEqual(
          active.map((item) => item.actionId),
          modern && scenario !== 'delivered' ? [assignment.actionId] : [],
        );
        assert.deepEqual(
          (await store.readActiveWorkHubAssignmentsByTarget([target.id], undefined, true)).map(
            (item) => item.actionId,
          ),
          [assignment.actionId],
          'explicit history still includes every stopped linkage',
        );
      } finally {
        await store.close?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
