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

import { basename } from 'node:path';
import { sanitizeUnicodeText } from '@maka/core/text-sanitize';
import {
  isWorkHubCoordinationSessionTarget,
  type SessionHeader,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import {
  isSessionNotFoundError,
  type ExecutionSessionWriter,
} from '@maka/storage/execution-stores';
import type {
  WorkHubTaskIndexDocument,
  WorkHubTaskIndexEntry,
  WorkHubTaskIndexQuery,
  WorkHubTaskIndexStore,
} from '@maka/storage/execution-stores';
import type { WorkHubTaskDetail } from '../protocol/workhub-tasks.js';

const SCAN = { maxMessages: 64, maxStoredBytes: 256 * 1024 } as const;
const key = (entry: { kind: string; id: string }) => `${entry.kind}:${entry.id}`;
const title = (text: string) =>
  sanitizeUnicodeText(text, { maxCodePoints: 512, truncatedSuffix: '' }) || 'WorkHub task';
const excerpt = (text: string) =>
  Array.from(text.replace(/\s+/gu, ' ').trim()).slice(0, 200).join('');
const names = (...texts: string[]) =>
  [
    ...new Set(
      texts
        .flatMap((text) => text.split('\n'))
        .filter(Boolean)
        .map((text) => text.normalize('NFC').toLowerCase()),
    ),
  ].join('\n');
const eligible = (header: SessionHeader) =>
  !header.isArchived &&
  !header.subagentParent &&
  header.role === undefined &&
  !header.labels.includes('mode:side_conversation') &&
  !isWorkHubCoordinationSessionTarget(header);
const state = (detail: WorkHubTaskDetail | undefined): WorkHubTaskIndexDocument['state'] => {
  switch (detail?.task.status) {
    case 'queued':
    case 'waiting_resource':
      return 'queued';
    case 'running':
    case 'stopping':
      return 'running';
    case 'waiting_for_user':
      return 'waiting_for_user';
    case 'waiting_for_dependency':
      // Legacy dependency waits are not unanswered human approvals. They are
      // retired separately before the old peer protocol is removed.
      return 'unavailable';
    case 'pending_acceptance':
      return 'ended';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'stopped':
      return 'stopped';
    default:
      return 'unavailable';
  }
};

/** One bounded page at a time; the projection is never used to authorize sending or stopping. */
export function createWorkHubTaskIndexProjection(options: {
  stores: Pick<
    ExecutionSessionWriter,
    | 'readWorkHubTaskFactsPage'
    | 'readWorkHubAssignment'
    | 'readHeaderSnapshot'
    | 'readCatalogRecord'
    | 'listCatalogPage'
  >;
  index: WorkHubTaskIndexStore;
  project(source: WorkHubDelegationAssignedMessage): Promise<WorkHubTaskDetail | undefined>;
  activity(detail: WorkHubTaskDetail): Promise<number | undefined>;
  onError(error: unknown): void;
}) {
  const { stores, index } = options;
  let initialized = false;
  let observing = false;
  let closing = false;
  let tail = Promise.resolve();
  const notifications = new Set<Promise<void>>();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = tail.then(run);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  async function header(sessionId: string) {
    try {
      return await stores.readHeaderSnapshot(sessionId);
    } catch (error) {
      if (isSessionNotFoundError(error)) return undefined;
      throw error;
    }
  }

  async function manual(sessionId: string) {
    if (await index.containsSession(sessionId)) {
      await index.remove('session', sessionId);
      return;
    }
    let record;
    try {
      record = await stores.readCatalogRecord(sessionId);
    } catch (error) {
      if (!isSessionNotFoundError(error)) throw error;
    }
    if (!record || !eligible(record.header)) {
      await index.remove('session', sessionId);
      return;
    }
    const h = record.header;
    await index.put({
      kind: 'session',
      id: h.id,
      title: title(h.name),
      summary: '',
      state: 'ended',
      activityAt: record.activityAt,
      cwd: h.cwd,
      available: true,
      currentSessionId: h.id,
      sourceActionId: null,
      originActionId: null,
      sessionIds: [h.id],
      requests: '',
      brief: '',
      sessionNames: h.name,
    });
    // Manual items expose availability, not a claim about a delegated task's completion.
    const entry = await index.read('session', h.id);
    if (entry) await index.refresh(entry, entry.dirtyRevision);
  }

  async function syncFacts() {
    let through = await index.watermark();
    for (;;) {
      let page;
      try {
        page = await stores.readWorkHubTaskFactsPage({ ...SCAN, afterSequence: through });
      } catch (error) {
        if (isSessionNotFoundError(error)) return;
        throw error;
      }
      if (!page.records.length) {
        if (page.highWaterSequence !== null && page.highWaterSequence > through)
          await index.advance(page.highWaterSequence);
        return;
      }
      for (const { sequence, message } of page.records) {
        if (message.type !== 'workhub_coordination')
          throw new Error('Unexpected task index source');
        if (message.kind === 'delegation_assigned') {
          const workId = message.work?.id ?? message.actionId;
          const origin =
            workId === message.actionId ? message : await stores.readWorkHubAssignment(workId);
          const old = await index.read('task', workId);
          const h = await header(message.targetSessionId);
          const original = origin ?? message;
          const doc: WorkHubTaskIndexDocument = {
            kind: 'task',
            id: workId,
            title: title(original.taskTitle ?? original.targetSessionName),
            summary: old?.summary || excerpt(original.delegationText ?? original.userText),
            state: old?.state ?? 'unavailable',
            activityAt: Math.max(old?.activityAt ?? 0, message.ts),
            cwd: h?.cwd ?? message.settings?.cwd ?? old?.cwd ?? '',
            available: false,
            currentSessionId: message.targetSessionId,
            sourceActionId: message.actionId,
            originActionId: origin?.actionId ?? null,
            sessionIds: [...new Set([...(old?.sessionIds ?? []), message.targetSessionId])],
            requests: [
              old?.requests ?? '',
              message.inputOrigin === 'feedback' ? '' : message.userText,
            ]
              .filter(Boolean)
              .join('\n'),
            brief: old?.brief ?? '',
            sessionNames: names(old?.sessionNames ?? '', message.targetSessionName),
          };
          await index.put(doc, sequence);
        } else if (message.kind === 'task_input') {
          const old = await index.read('task', message.workId);
          if (!old) throw new Error('Task input has no original indexed assignment');
          await index.put(
            {
              ...old,
              activityAt: Math.max(old.activityAt, message.ts),
              requests: [
                old.requests,
                message.inputOrigin === 'feedback'
                  ? ''
                  : (message.originalUserText ?? message.text),
              ]
                .filter(Boolean)
                .join('\n'),
            },
            sequence,
          );
        } else throw new Error('Unexpected task index fact');
        through = sequence;
      }
    }
  }

  async function scanManualCatalog() {
    let cursor;
    for (;;) {
      const page = await stores.listCatalogPage(undefined, cursor, 64);
      if (page.kind !== 'page')
        throw new Error('Task index catalog scan unexpectedly changed revision');
      for (const record of page.records) await manual(record.header.id);
      const last = page.records.at(-1);
      if (!page.hasMore || !last) return;
      cursor = { activityAt: last.activityAt, sessionId: last.header.id };
    }
  }

  async function refresh(entry: WorkHubTaskIndexEntry) {
    if (entry.kind === 'session') {
      await manual(entry.id);
      return;
    }
    const source = entry.sourceActionId
      ? await stores.readWorkHubAssignment(entry.sourceActionId)
      : undefined;
    if (!source || (source.work?.id ?? source.actionId) !== entry.id) {
      await index.refresh(
        { ...entry, state: 'unavailable', available: false },
        entry.dirtyRevision,
      );
      return;
    }
    const detail = await options.project(source);
    const h = await header(source.targetSessionId);
    const activityAt = detail ? await options.activity(detail) : undefined;
    await index.refresh(
      {
        ...entry,
        state: state(detail),
        available:
          !!detail &&
          state(detail) !== 'unavailable' &&
          !!h &&
          eligible(h) &&
          entry.originActionId !== null,
        cwd: h?.cwd ?? entry.cwd,
        activityAt: Math.max(entry.activityAt, activityAt ?? source.ts),
        // Keep the latest canonical fact located by the scan watermark. The
        // actually running input can be older (for example a later withdrawn
        // queued input) and is resolved separately by the execution projection.
        sourceActionId: entry.sourceActionId,
        sessionNames: names(entry.sessionNames, h?.name ?? ''),
      },
      entry.dirtyRevision,
    );
  }

  async function sync() {
    observing = true;
    await syncFacts();
    if (!initialized) {
      await scanManualCatalog();
      await index.markDirty();
      initialized = true;
    }
    // Visit each dirty key at most once. A live worker may dirty it again;
    // keep that marker for the next query rather than waiting for it to become idle.
    let afterKey: string | undefined;
    for (;;) {
      const batch = await index.dirty(afterKey);
      if (!batch.length) break;
      for (const ref of batch) {
        const entry = await index.read(ref.kind, ref.id);
        if (entry) await refresh(entry);
      }
      afterKey = key(batch[batch.length - 1]!);
    }
  }

  return {
    query: (input: WorkHubTaskIndexQuery) =>
      serialized(async () => {
        await sync();
        return index.query(input);
      }),
    rebuild: () =>
      serialized(async () => {
        await index.rebuild();
        initialized = false;
        await sync();
      }),
    notify(sessionId: string) {
      // Before the first lookup, canonical facts and the catalog are sufficient
      // for backfill. Ordinary chats must not maintain an unused search index.
      if (closing || !observing) return Promise.resolve();
      // Share the existing projection lane with queries. A stale manual read
      // must not reinsert a Session after a newer archive/delete notification.
      const task = serialized(async () => {
        try {
          let affected = sessionId;
          const seen = new Set<string>();
          for (;;) {
            if (seen.has(affected)) {
              await index.markDirty();
              break;
            }
            seen.add(affected);
            await index.markDirty(affected);
            const current = await header(affected);
            if (!current) {
              // A deleted child no longer exposes its immutable parent link.
              // Conservatively invalidate on this rare lifecycle event rather
              // than retaining the parent's now-settled interaction status.
              await index.markDirty();
              break;
            }
            if (!current.subagentParent) break;
            affected = current.subagentParent.parentSessionId;
          }
          await manual(sessionId);
        } catch (error) {
          options.onError(error);
        } // advisory failure cannot cancel a committed task
      });
      notifications.add(task);
      void task.then(
        () => notifications.delete(task),
        () => notifications.delete(task),
      );
      return task;
    },
    async close() {
      closing = true;
      await tail;
      await Promise.all(notifications);
    },
    location: (document: Pick<WorkHubTaskIndexDocument, 'cwd'>) =>
      basename(document.cwd) || document.cwd,
  };
}
