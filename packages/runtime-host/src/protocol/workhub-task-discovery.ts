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

import { defineHostPathOperation } from './operation-spec.js';
import { invalidProtocolFrame } from './errors.js';
import {
  requireCount,
  requireEntityId,
  requireExactRecord,
  requireShapedRecord,
  requireUtf8String,
} from './codec.js';
import {
  decodeWorkHubContextObservation,
  type WorkHubContextObservation,
} from './workhub-coordination.js';

export interface WorkHubTaskFindInput {
  readonly query?: string;
  readonly cwd?: string;
  readonly cursor?: string;
}
export const WORKHUB_FIND_STATES = [
  'queued',
  'running',
  'waiting_for_user',
  'ended',
  'failed',
  'stopped',
  'unavailable',
  'available',
] as const;
export interface WorkHubTaskFindItem {
  readonly kind: 'task' | 'session';
  readonly id: string;
  readonly title: string;
  readonly state: (typeof WORKHUB_FIND_STATES)[number];
  readonly lastActivityAt: number;
  readonly location: string | null;
  readonly available: boolean;
  readonly summary: string;
  readonly segments: number;
  readonly context?: WorkHubContextObservation;
}
export interface WorkHubTaskFindResult {
  readonly items: readonly WorkHubTaskFindItem[];
  readonly match: 'all' | 'any' | 'recent' | 'unmatched';
  readonly nextCursor: string | null;
}

export const WORKHUB_TASK_DISCOVERY_OPERATION_SPECS = {
  'workhub.tasks.find': defineHostPathOperation(
    {
      mode: 'query',
      availability: 'ready',
      errors: [
        'host_not_ready',
        'host_draining',
        'operation_unavailable',
        'operation_conflict',
        'persistence_failed',
        'internal_failure',
      ] as const,
      decodeInput(value: unknown): WorkHubTaskFindInput {
        const item = requireShapedRecord(
          value,
          'WorkHub task search',
          [],
          ['query', 'cwd', 'cursor'],
        );
        const query =
          item.query === undefined
            ? undefined
            : requireUtf8String(item.query, 'WorkHub query', 1024).trim();
        if (query !== undefined && (!query || Array.from(query).length > 256))
          throw invalidProtocolFrame('Invalid WorkHub query');
        return {
          ...(query === undefined ? {} : { query }),
          ...(item.cwd === undefined
            ? {}
            : { cwd: requireUtf8String(item.cwd, 'WorkHub directory', 4096) }),
          ...(item.cursor === undefined
            ? {}
            : { cursor: requireUtf8String(item.cursor, 'WorkHub search cursor', 2048) }),
        };
      },
      decodeOutput(value: unknown): WorkHubTaskFindResult {
        const page = requireExactRecord(value, 'WorkHub task page', [
          'items',
          'match',
          'nextCursor',
        ]);
        if (
          !Array.isArray(page.items) ||
          page.items.length > 10 ||
          !['all', 'any', 'recent', 'unmatched'].includes(String(page.match))
        )
          throw invalidProtocolFrame('Invalid WorkHub task page');
        const items = page.items.map((raw) => {
          const row = requireShapedRecord(
            raw,
            'WorkHub task hit',
            [
              'kind',
              'id',
              'title',
              'state',
              'lastActivityAt',
              'location',
              'available',
              'summary',
              'segments',
            ],
            ['context'],
          );
          if (
            (row.kind !== 'task' && row.kind !== 'session') ||
            !WORKHUB_FIND_STATES.includes(row.state as WorkHubTaskFindItem['state']) ||
            typeof row.available !== 'boolean'
          )
            throw invalidProtocolFrame('Invalid WorkHub task hit');
          const title = requireUtf8String(row.title, 'WorkHub title', 2048);
          const summary =
            row.summary === '' ? '' : requireUtf8String(row.summary, 'WorkHub summary', 800);
          const segments = requireCount(row.segments, 'WorkHub segment count');
          if (
            Array.from(title).length > 512 ||
            Array.from(summary).length > 200 ||
            segments < 1 ||
            (row.kind === 'session' &&
              (segments !== 1 || (row.state !== 'available' && row.state !== 'unavailable'))) ||
            (row.kind === 'task' && row.state === 'available')
          )
            throw invalidProtocolFrame('Invalid WorkHub task excerpt');
          return {
            kind: row.kind,
            id: requireEntityId(row.id, 'WorkHub task id'),
            title,
            state: row.state as WorkHubTaskFindItem['state'],
            lastActivityAt: requireCount(row.lastActivityAt, 'WorkHub task activity'),
            location:
              row.location === null
                ? null
                : requireUtf8String(row.location, 'WorkHub location', 4096),
            available: row.available,
            summary,
            segments,
            ...(row.context === undefined
              ? {}
              : { context: decodeWorkHubContextObservation(row.context) }),
          } satisfies WorkHubTaskFindItem;
        });
        if (new Set(items.map((x) => `${x.kind}:${x.id}`)).size !== items.length)
          throw invalidProtocolFrame('Duplicate task hits');
        return {
          items,
          match: page.match as WorkHubTaskFindResult['match'],
          nextCursor:
            page.nextCursor === null
              ? null
              : requireUtf8String(page.nextCursor, 'WorkHub search cursor', 2048),
        };
      },
    },
    (input) => input.cwd !== undefined,
  ),
} as const;
