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

import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeTaskExecutionGrant,
  TASK_GRANT_MAX_ACTIVE_PER_ROOT,
  type TaskExecutionGrant,
  type TaskExecutionGrantRecord,
  type TaskGrantClosureReason,
} from '@maka/core/task-execution-grant';

const REASONS: readonly TaskGrantClosureReason[] = [
  'revoked',
  'expired',
  'task_terminal',
  'task_cancelled',
  'authority_changed',
];

/** Caller holds the domain transaction; never commits independently of a request outcome. */
export function insertTaskExecutionGrant(db: DatabaseSync, value: TaskExecutionGrant): void {
  const grant = decodeTaskExecutionGrant(value);
  const existing = db
    .prepare('SELECT record_json FROM task_execution_grants WHERE grant_id = ?')
    .get(grant.grantId) as { record_json: string } | undefined;
  if (existing) {
    if (!isDeepStrictEqual(decodeTaskExecutionGrant(JSON.parse(existing.record_json)), grant))
      throw new Error('Task grant identity conflict');
    return;
  }
  const count = db
    .prepare(
      'SELECT COUNT(*) AS n FROM task_execution_grants WHERE root_session_id = ? AND root_turn_id = ? AND closed_at IS NULL',
    )
    .get(grant.rootSessionId, grant.rootTurnId) as { n: number };
  if (count.n >= TASK_GRANT_MAX_ACTIVE_PER_ROOT) throw new Error('Task grant capacity exceeded');
  db.prepare(
    'INSERT INTO task_execution_grants(grant_id, root_session_id, root_turn_id, expires_at, record_json) VALUES (?, ?, ?, ?, ?)',
  ).run(
    grant.grantId,
    grant.rootSessionId,
    grant.rootTurnId,
    grant.expiresAt,
    JSON.stringify(grant),
  );
}

export function readTaskExecutionGrants(
  db: DatabaseSync,
  rootSessionId?: string,
): TaskExecutionGrantRecord[] {
  const rows = (
    rootSessionId === undefined
      ? db.prepare('SELECT * FROM task_execution_grants WHERE closed_at IS NULL').all()
      : db
          .prepare(
            'SELECT * FROM task_execution_grants WHERE root_session_id = ? AND closed_at IS NULL',
          )
          .all(rootSessionId)
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    if (typeof row.record_json !== 'string') throw new Error('Invalid task grant record');
    const grant = decodeTaskExecutionGrant(JSON.parse(row.record_json));
    if (
      grant.grantId !== row.grant_id ||
      grant.rootSessionId !== row.root_session_id ||
      grant.rootTurnId !== row.root_turn_id ||
      grant.expiresAt !== row.expires_at
    )
      throw new Error('Task grant index identity conflict');
    return { grant };
  });
}

export function closeTaskExecutionGrant(
  db: DatabaseSync,
  grantId: string,
  reason: TaskGrantClosureReason,
  closedAt: number,
): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(grantId) ||
    !REASONS.includes(reason) ||
    !Number.isSafeInteger(closedAt) ||
    closedAt < 0
  )
    throw new Error('Invalid task grant closure');
  db.prepare(
    'UPDATE task_execution_grants SET closed_at = ?, closure_reason = ? WHERE grant_id = ? AND closed_at IS NULL',
  ).run(closedAt, reason, grantId);
}
