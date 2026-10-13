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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionSessionWriter } from '@maka/storage/execution-stores';
import type {
  WorkHubWorkSummary,
  WorkHubWorksQueryInput,
  WorkHubWorksQueryResult,
} from '../protocol/workhub-coordination.js';

const cursorSchema = z
  .object({
    version: z.literal(1),
    beforeSequence: z.number().int().nonnegative(),
    throughSequence: z.number().int().nonnegative(),
    queryHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

/** Projects the canonical assignment ledger, without another durable work database. */
export function createWorkHubWorkIndex(options: {
  stores: Pick<
    ExecutionSessionWriter,
    | 'readWorkHubAssignmentsPage'
    | 'readWorkHubAssignment'
    | 'readLatestWorkHubAssignment'
    | 'readActiveWorkHubAssignmentsByTarget'
  >;
  isEligible(sessionId: string): Promise<boolean>;
}) {
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  const encode = (cursor: z.infer<typeof cursorSchema>) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  };
  return async (input: WorkHubWorksQueryInput): Promise<WorkHubWorksQueryResult> => {
    const query = (input.query ?? '').normalize('NFC').toLowerCase();
    const queryHash = createHash('sha256').update(query).digest('hex');
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (input.cursor) {
      try {
        const [payload, signature, extra] = input.cursor.split('.');
        if (!payload || !signature || extra !== undefined) throw new Error('Invalid cursor');
        const expected = sign(payload);
        const supplied = Buffer.from(signature, 'base64url');
        if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied))
          throw new Error('Invalid signature');
        cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
        if (cursor.queryHash !== queryHash || cursor.beforeSequence > cursor.throughSequence + 1)
          throw new Error('Changed query');
      } catch {
        throw new WorkHubWorkCursorError(
          'Invalid or expired work cursor; query works again without a cursor',
        );
      }
    }
    const page = await options.stores.readWorkHubAssignmentsPage({
      beforeSequence: cursor?.beforeSequence ?? Number.MAX_SAFE_INTEGER,
      maxMessages: 64,
      maxStoredBytes: 256 * 1024,
    });
    const throughSequence = cursor?.throughSequence ?? page.highWaterSequence;
    if (throughSequence === null || page.records.length === 0)
      return { works: [], nextCursor: null };
    const works: WorkHubWorkSummary[] = [];
    const seen = new Set<string>();
    let beforeSequence = 0;
    for (const { sequence, message } of page.records) {
      beforeSequence = sequence;
      if (
        message.type !== 'workhub_coordination' ||
        message.kind !== 'delegation_assigned' ||
        sequence > throughSequence
      )
        continue;
      const workId = message.work?.id ?? message.actionId;
      if (seen.has(workId)) continue;
      seen.add(workId);
      const origin =
        workId === message.actionId ? message : await options.stores.readWorkHubAssignment(workId);
      if (!origin || (origin.work?.id ?? origin.actionId) !== workId)
        throw new Error('WorkHub work origin is unavailable');
      if (
        query &&
        !`${origin.userText}\n${origin.delegationText ?? ''}\n${message.targetSessionName}`
          .normalize('NFC')
          .toLowerCase()
          .includes(query)
      )
        continue;
      const original = Array.from(origin.userText);
      const objective = Array.from(origin.delegationText ?? origin.userText);
      const latest = await options.stores.readLatestWorkHubAssignment(workId);
      const available =
        !!latest &&
        (latest.work?.generationId ?? latest.actionId) ===
          (message.work?.generationId ?? message.actionId) &&
        (await options.isEligible(message.targetSessionId)) &&
        (await options.stores.readActiveWorkHubAssignmentsByTarget([message.targetSessionId])).some(
          (assignment) => assignment.actionId === message.actionId,
        );
      works.push({
        workId,
        sourceActionId: message.actionId,
        sourceDelegationId: message.delegationId,
        targetSessionId: message.targetSessionId,
        targetSessionName: message.targetSessionName,
        coordinationTurnId: origin.coordinationTurnId,
        ...(origin.work?.sourceMessageId ? { sourceMessageId: origin.work.sourceMessageId } : {}),
        createdAt: origin.ts,
        originalRequest: original.slice(0, 1024).join(''),
        requestTruncated: original.length > 1024,
        objective: objective.slice(0, 1024).join(''),
        objectiveTruncated: objective.length > 1024,
        available,
      });
      if (works.length >= (input.limit ?? 8)) break;
    }
    return {
      works,
      nextCursor:
        beforeSequence > 0
          ? encode({ version: 1, beforeSequence, throughSequence, queryHash })
          : null,
    };
  };
}

export class WorkHubWorkCursorError extends Error {}
