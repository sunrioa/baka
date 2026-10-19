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

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  WorkHubTaskIndexDocument,
  WorkHubTaskIndexEntry,
  WorkHubTaskIndexHit,
  WorkHubTaskIndexQuery,
  WorkHubTaskIndexPage,
} from './session-store-contract.js';
export type {
  WorkHubTaskIndexDocument,
  WorkHubTaskIndexEntry,
  WorkHubTaskIndexHit,
  WorkHubTaskIndexQuery,
  WorkHubTaskIndexPage,
  WorkHubTaskIndexStore,
} from './session-store-contract.js';

export const WORKHUB_TASK_INDEX_FORMAT = 1;
export const WORKHUB_TASK_FIND_PAGE_SIZE = 10;

export const WORKHUB_TASK_INDEX_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workhub_task_index (
    row_id INTEGER PRIMARY KEY,
    doc_key TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('task', 'session')),
    entity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL,
    activity_at INTEGER NOT NULL CHECK (activity_at >= 0),
    cwd TEXT NOT NULL,
    available INTEGER NOT NULL CHECK (available IN (0, 1)),
    current_session_id TEXT NOT NULL,
    source_action_id TEXT,
    origin_action_id TEXT,
    session_ids_json TEXT NOT NULL CHECK (json_valid(session_ids_json)),
    dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty >= 0),
    title_n TEXT NOT NULL,
    requests_n TEXT NOT NULL,
    brief_n TEXT NOT NULL,
    session_names_n TEXT NOT NULL,
    cwd_n TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workhub_task_index_by_activity ON workhub_task_index(activity_at DESC, doc_key);
  CREATE INDEX IF NOT EXISTS workhub_task_index_by_cwd ON workhub_task_index(cwd, activity_at DESC, doc_key);
  CREATE INDEX IF NOT EXISTS workhub_task_index_by_session ON workhub_task_index(current_session_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS workhub_task_search USING fts5(
    title_n, requests_n, brief_n, session_names_n, cwd_n,
    content='workhub_task_index', content_rowid='row_id', tokenize='trigram'
  );
  CREATE TRIGGER IF NOT EXISTS workhub_task_index_insert AFTER INSERT ON workhub_task_index BEGIN
    INSERT INTO workhub_task_search(rowid, title_n, requests_n, brief_n, session_names_n, cwd_n)
      VALUES (new.row_id, new.title_n, new.requests_n, new.brief_n, new.session_names_n, new.cwd_n);
  END;
  CREATE TRIGGER IF NOT EXISTS workhub_task_index_delete AFTER DELETE ON workhub_task_index BEGIN
    INSERT INTO workhub_task_search(workhub_task_search, rowid, title_n, requests_n, brief_n, session_names_n, cwd_n)
      VALUES ('delete', old.row_id, old.title_n, old.requests_n, old.brief_n, old.session_names_n, old.cwd_n);
  END;
  CREATE TRIGGER IF NOT EXISTS workhub_task_index_update AFTER UPDATE OF title_n, requests_n, brief_n, session_names_n, cwd_n ON workhub_task_index BEGIN
    INSERT INTO workhub_task_search(workhub_task_search, rowid, title_n, requests_n, brief_n, session_names_n, cwd_n)
      VALUES ('delete', old.row_id, old.title_n, old.requests_n, old.brief_n, old.session_names_n, old.cwd_n);
    INSERT INTO workhub_task_search(rowid, title_n, requests_n, brief_n, session_names_n, cwd_n)
      VALUES (new.row_id, new.title_n, new.requests_n, new.brief_n, new.session_names_n, new.cwd_n);
  END;
  CREATE TABLE IF NOT EXISTS workhub_task_index_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL,
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= -1),
    cursor_key TEXT NOT NULL DEFAULT (lower(hex(randomblob(32))))
  );
  INSERT OR IGNORE INTO workhub_task_index_state(singleton,format_version,through_sequence)
    VALUES (1, ${WORKHUB_TASK_INDEX_FORMAT}, -1);
`;

interface Cursor {
  version: 1;
  key: string;
  match: WorkHubTaskIndexPage['match'];
  rank: number;
  at: number;
  doc: string;
}
type Row = Record<string, unknown>;
const normalized = (text: string) => text.normalize('NFC').toLowerCase();
const normalizedQuery = (text: string) => normalized(text.trim()).split(/\s+/u).filter(Boolean);
const docKey = (kind: WorkHubTaskIndexDocument['kind'], id: string) => `${kind}:${id}`;
const searchFields = ['title_n', 'requests_n', 'brief_n', 'session_names_n', 'cwd_n'] as const;
const weights = [100, 40, 10, 4, 1] as const;
const activeRank =
  "CASE WHEN kind = 'task' AND state IN ('queued','running','waiting_for_user') THEN 1 ELSE 0 END";

export class WorkHubTaskIndexCursorError extends Error {}

/** The owning SQLite store supplies its existing transaction/writer boundary. */
export class SqliteWorkHubTaskIndex {
  constructor(private readonly db: DatabaseSync) {}

  upsert(document: WorkHubTaskIndexDocument, expectedDirtyRevision?: number): boolean {
    if (!Number.isSafeInteger(document.activityAt) || document.activityAt < 0)
      throw new Error('Invalid task activity time');
    const sessions = [...new Set(document.sessionIds)];
    const result = this.db
      .prepare(`INSERT INTO workhub_task_index (
      doc_key,kind,entity_id,title,summary,state,activity_at,cwd,available,current_session_id,
      source_action_id,origin_action_id,session_ids_json,title_n,requests_n,brief_n,session_names_n,cwd_n
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(doc_key) DO UPDATE SET
      title=excluded.title,summary=excluded.summary,state=excluded.state,activity_at=excluded.activity_at,
      cwd=excluded.cwd,available=excluded.available,current_session_id=excluded.current_session_id,
      source_action_id=excluded.source_action_id,origin_action_id=excluded.origin_action_id,
      session_ids_json=excluded.session_ids_json,title_n=excluded.title_n,requests_n=excluded.requests_n,
      brief_n=excluded.brief_n,session_names_n=excluded.session_names_n,cwd_n=excluded.cwd_n,dirty=0
      WHERE (? IS NULL OR workhub_task_index.dirty=?)
    `)
      .run(
        docKey(document.kind, document.id),
        document.kind,
        document.id,
        document.title,
        Array.from(document.summary).slice(0, 200).join(''),
        document.state,
        document.activityAt,
        document.cwd,
        document.available ? 1 : 0,
        document.currentSessionId,
        document.sourceActionId,
        document.originActionId,
        JSON.stringify(sessions),
        normalized(document.title),
        normalized(document.requests),
        normalized(document.brief),
        normalized(document.sessionNames),
        normalized(document.cwd),
        expectedDirtyRevision ?? null,
        expectedDirtyRevision ?? null,
      );
    return Number(result.changes) === 1;
  }

  read(kind: WorkHubTaskIndexDocument['kind'], id: string): WorkHubTaskIndexEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM workhub_task_index WHERE doc_key=?')
      .get(docKey(kind, id));
    if (!row) return undefined;
    const { segmentCount: _segmentCount, ...hit } = this.#hit(row);
    return {
      ...hit,
      sessionIds: JSON.parse(row.session_ids_json as string) as string[],
      requests: row.requests_n as string,
      brief: row.brief_n as string,
      sessionNames: row.session_names_n as string,
      dirtyRevision: row.dirty as number,
    };
  }

  containsSession(sessionId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM workhub_task_index AS task
      WHERE task.kind='task' AND EXISTS (SELECT 1 FROM json_each(task.session_ids_json) WHERE value=?) LIMIT 1`)
      .get(sessionId);
  }

  rebuild(): void {
    // Keep the signing key: identical rebuilt result sets can resume existing cursors.
    this.db.exec('DELETE FROM workhub_task_index');
    this.db
      .prepare(
        'UPDATE workhub_task_index_state SET format_version=?,through_sequence=-1 WHERE singleton=1',
      )
      .run(WORKHUB_TASK_INDEX_FORMAT);
  }

  remove(kind: WorkHubTaskIndexDocument['kind'], id: string): void {
    this.db.prepare('DELETE FROM workhub_task_index WHERE doc_key = ?').run(docKey(kind, id));
  }

  markDirty(sessionId?: string): void {
    if (sessionId === undefined) this.db.exec('UPDATE workhub_task_index SET dirty=dirty+1');
    else
      this.db
        .prepare(`UPDATE workhub_task_index SET dirty=dirty+1 WHERE current_session_id=?
      OR EXISTS (SELECT 1 FROM json_each(session_ids_json) WHERE value=?)`)
        .run(sessionId, sessionId);
  }

  dirty(
    afterKey?: string,
  ): readonly Pick<WorkHubTaskIndexEntry, 'kind' | 'id' | 'dirtyRevision'>[] {
    return this.db
      .prepare(
        'SELECT kind,entity_id,dirty FROM workhub_task_index WHERE dirty>0 AND doc_key>? ORDER BY doc_key LIMIT 64',
      )
      .all(afterKey ?? '')
      .map((row) => ({
        kind: row.kind as WorkHubTaskIndexDocument['kind'],
        id: row.entity_id as string,
        dirtyRevision: row.dirty as number,
      }));
  }

  watermark(): number {
    const state = this.db
      .prepare(
        'SELECT format_version,through_sequence FROM workhub_task_index_state WHERE singleton=1',
      )
      .get();
    if (!state || state.format_version !== WORKHUB_TASK_INDEX_FORMAT)
      throw new Error('Task index must be rebuilt');
    return state.through_sequence as number;
  }

  advance(throughSequence: number): void {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < this.watermark())
      throw new Error('Invalid task index watermark');
    this.db
      .prepare('UPDATE workhub_task_index_state SET through_sequence=? WHERE singleton=1')
      .run(throughSequence);
  }

  query(input: WorkHubTaskIndexQuery): WorkHubTaskIndexPage {
    const terms = [...new Set(normalizedQuery(input.query ?? ''))];
    const key = createHash('sha256')
      .update(JSON.stringify([WORKHUB_TASK_INDEX_FORMAT, terms, input.cwd ?? null]))
      .digest('hex');
    const cursor = this.#cursor(input.cursor, key);
    const filter = input.cwd === undefined ? '1' : 'cwd = ?';
    const filterArgs: SQLInputValue[] = input.cwd === undefined ? [] : [input.cwd];
    const predicates = terms.map((term) =>
      Array.from(term).length >= 3
        ? {
            sql: 'row_id IN (SELECT rowid FROM workhub_task_search WHERE workhub_task_search MATCH ?)',
            args: [`"${term.replaceAll('"', '""')}"`],
          }
        : {
            sql: `(${searchFields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
            args: searchFields.map(
              () =>
                `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
            ),
          },
    );
    const matched = (mode: 'all' | 'any') =>
      predicates.map((p) => `(${p.sql})`).join(mode === 'all' ? ' AND ' : ' OR ');
    const matchArgs = predicates.flatMap((p) => p.args);
    const exists = (mode: 'all' | 'any') =>
      !!this.db
        .prepare(
          `SELECT 1 FROM workhub_task_index WHERE (${filter}) AND (${matched(mode)}) LIMIT 1`,
        )
        .get(...filterArgs, ...matchArgs);
    const match =
      cursor?.match ??
      (!terms.length ? 'recent' : exists('all') ? 'all' : exists('any') ? 'any' : 'unmatched');
    if (!terms.length && match !== 'recent')
      throw new WorkHubTaskIndexCursorError('Changed task query');
    const recent = match === 'recent' || match === 'unmatched';
    const rank = recent
      ? activeRank
      : terms
          .map(
            () =>
              `(${searchFields.map((field, i) => `CASE WHEN instr(${field},?)>0 THEN ${weights[i]} ELSE 0 END`).join('+')})`,
          )
          .join('+');
    const rankArgs: SQLInputValue[] = recent
      ? []
      : terms.flatMap((term) => searchFields.map(() => term));
    const where = recent ? filter : `(${filter}) AND (${matched(match)})`;
    const after = cursor
      ? 'WHERE rank < ? OR (rank = ? AND (activity_at < ? OR (activity_at = ? AND doc_key > ?)))'
      : '';
    // SQLite owns the match set. The Host receives only one page plus one lookahead row.
    const rows = this.db
      .prepare(`WITH ranked AS (
      SELECT doc_key,kind,entity_id,title,summary,state,activity_at,cwd,available,current_session_id,
        source_action_id,origin_action_id,json_array_length(session_ids_json) AS segment_count,${rank} AS rank
      FROM workhub_task_index WHERE ${where}
    ) SELECT * FROM ranked ${after} ORDER BY rank DESC,activity_at DESC,doc_key ASC LIMIT ?`)
      .all(
        ...rankArgs,
        ...filterArgs,
        ...(recent ? [] : matchArgs),
        ...(cursor ? [cursor.rank, cursor.rank, cursor.at, cursor.at, cursor.doc] : []),
        WORKHUB_TASK_FIND_PAGE_SIZE + 1,
      );
    const visible = rows.slice(0, WORKHUB_TASK_FIND_PAGE_SIZE);
    const last = visible.at(-1);
    return {
      items: visible.map((row) => this.#hit(row)),
      match,
      nextCursor:
        rows.length > visible.length && last
          ? this.#encode({
              version: 1,
              key,
              match,
              rank: last.rank as number,
              at: last.activity_at as number,
              doc: last.doc_key as string,
            })
          : null,
    };
  }

  #signature(payload: string): Buffer {
    const state = this.db
      .prepare('SELECT cursor_key FROM workhub_task_index_state WHERE singleton=1')
      .get();
    if (typeof state?.cursor_key !== 'string' || !/^[a-f0-9]{64}$/u.test(state.cursor_key))
      throw new Error('Task index cursor key is unavailable');
    return createHmac('sha256', Buffer.from(state.cursor_key, 'hex')).update(payload).digest();
  }

  #encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${this.#signature(payload).toString('base64url')}`;
  }

  #cursor(token: string | undefined, key: string): Cursor | undefined {
    if (token === undefined) return undefined;
    try {
      if (token.length > 2048) throw new Error('Oversized cursor');
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) throw new Error('Invalid cursor');
      const expected = this.#signature(payload),
        supplied = Buffer.from(signature, 'base64url');
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
        throw new Error('Changed cursor');
      const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Cursor;
      if (
        !c ||
        Object.keys(c).sort().join(',') !== 'at,doc,key,match,rank,version' ||
        c.version !== 1 ||
        c.key !== key ||
        !['all', 'any', 'recent', 'unmatched'].includes(c.match) ||
        !Number.isSafeInteger(c.rank) ||
        c.rank < 0 ||
        !Number.isSafeInteger(c.at) ||
        c.at < 0 ||
        typeof c.doc !== 'string' ||
        c.doc.length > 512 ||
        c.doc.includes('\0')
      )
        throw new Error('Changed cursor');
      return c;
    } catch {
      throw new WorkHubTaskIndexCursorError(
        'Invalid or incompatible task cursor; start the query again',
      );
    }
  }

  #hit(row: Row): WorkHubTaskIndexHit {
    return {
      kind: row.kind as WorkHubTaskIndexHit['kind'],
      id: row.entity_id as string,
      title: row.title as string,
      summary: row.summary as string,
      state: row.state as WorkHubTaskIndexHit['state'],
      activityAt: row.activity_at as number,
      cwd: row.cwd as string,
      available: row.available === 1,
      currentSessionId: row.current_session_id as string,
      sourceActionId: row.source_action_id as string | null,
      originActionId: row.origin_action_id as string | null,
      segmentCount: row.segment_count as number,
    };
  }
}
