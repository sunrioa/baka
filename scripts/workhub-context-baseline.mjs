#!/usr/bin/env node
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

// Offline diagnostics only: no Host connection, model call, migration, prune,
// checkpoint write, credential discovery, or source-database mutation.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  buildRuntimeEventModelReplayPlan,
  workHubCoordinationReceiptText,
} from '../packages/runtime/dist/model-history.js';
import {
  loadModelProjectionTransitionsFromRunLedger,
  reduceEffectiveModelProjections,
} from '../packages/runtime/dist/model-projection-transition-ledger.js';
import { durableProjectionToToolResultOutput } from '../packages/runtime/dist/durable-tool-result-projection.js';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const size = (text) => ({ utf8Bytes: Buffer.byteLength(text), utf16Units: text.length });
const ACTIONS = new Set(['start', 'continue', 'ask', 'stop']);

/** Read one transactionally consistent snapshot. Returned text is PRIVATE. */
export function collectContextSnapshot(database, sessionId) {
  if (!sessionId) throw new Error('An explicit session ID is required');
  database.exec('BEGIN');
  try {
    const header = database
      .prepare('SELECT payload_json FROM session_metadata WHERE session_id = ?')
      .get(sessionId);
    if (!header) throw new Error('Session not found');
    const rows = database
      .prepare(`SELECT e.event_kind, e.payload_json, o.ordinal
      FROM runtime_session_event_ordinals o JOIN runtime_events e ON e.event_id = o.event_id
      WHERE o.session_id = ? ORDER BY o.ordinal`)
      .all(sessionId);
    const runRows = database
      .prepare(`SELECT event_type, record_json FROM core_agent_run_events
      WHERE session_id = ? AND event_type IN
        ('model_projection_transition_recorded', 'history_compact_checkpoint_recorded',
         'request_composition_resolved', 'send_diagnostics_recorded')
      ORDER BY event_ts, sequence, event_id`)
      .all(sessionId);
    const usage = database
      .prepare(`SELECT attempt_id, completed_at, call_kind, status, usage_basis,
      input_tokens, output_tokens, cache_read_input_tokens, cache_miss_input_tokens,
      cache_write_input_tokens, connection_slug, model_id, cost_basis, cost_usd
      FROM usage_model_call_attempts WHERE session_id = ? ORDER BY completed_at, attempt_id`)
      .all(sessionId);
    const metadata = JSON.parse(header.payload_json);
    const runtimeEvents = rows
      .filter((row) => row.event_kind !== 'thinking')
      .map((row) => JSON.parse(row.payload_json));
    const storageByKind = {};
    for (const row of rows) {
      const entry = (storageByKind[row.event_kind] ??= { records: 0, storedUtf8Bytes: 0 });
      entry.records += 1;
      entry.storedUtf8Bytes += Buffer.byteLength(row.payload_json);
    }
    const result = {
      schemaVersion: 1,
      sampledAt: new Date().toISOString(),
      sessionId,
      session: {
        model: metadata.model,
        connection: metadata.llmConnectionSlug,
        toolProfile: metadata.toolProfile,
      },
      throughOrdinal: rows.at(-1)?.ordinal ?? 0,
      storageByKind,
      runtimeEvents,
      runEvents: runRows.map((row) => JSON.parse(row.record_json)),
      usage,
    };
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function category(item, events) {
  const event = events.get(item.eventId);
  if (item.kind === 'text') {
    if (workHubCoordinationReceiptText(event)) return 'action_receipts';
    if (event?.content?.origin?.kind === 'workhub_result') return 'result_notifications';
    if (item.role === 'assistant') return 'coordinator_replies';
    if (item.role === 'user') return 'user_inputs';
    return 'host_facts';
  }
  const operation = item.toolName?.replace(/^mcp__desktop_workhub__/u, '');
  if (item.kind === 'tool_call') return 'tool_arguments';
  if (operation === 'find') return 'find_results';
  if (item.toolName === 'WorkHubRead') return 'workhub_read_results';
  if (ACTIONS.has(operation)) return 'action_receipts';
  if (operation === 'tasks' || item.retiredWorkHubOperation) return 'retired_tool_results';
  return 'other_tool_results';
}

function itemBody(item) {
  if (item.kind === 'text') return item.content;
  if (item.kind === 'tool_call') return JSON.stringify(item.input) ?? 'null';
  return (
    JSON.stringify(
      item.modelProjection
        ? durableProjectionToToolResultOutput(item.modelProjection)
        : item.output,
    ) ?? 'null'
  );
}

/** Only aggregate sizes escape this function; never return user/tool text. */
export async function analyzeContextSnapshot(snapshot) {
  const checkpoints = snapshot.runEvents.filter(
    (event) => event.type === 'history_compact_checkpoint_recorded',
  );
  // Never silently count raw history as active context after a checkpoint.
  // A post-compaction comparison must supply the effective checkpoint replay.
  if (checkpoints.length)
    throw new Error('Checkpoint-aware replay is required; raw-history sizing would be misleading');
  const runIds = [...new Set(snapshot.runEvents.map((event) => event.runId))];
  const loaded = await loadModelProjectionTransitionsFromRunLedger(
    {
      readEvents: async (session, run) =>
        snapshot.runEvents.filter((event) => event.sessionId === session && event.runId === run),
    },
    snapshot.sessionId,
    runIds,
  );
  if (loaded.unscopedUnreadable || loaded.unreadableTargets.size)
    throw new Error('Unreadable projection ledger');
  const effective = reduceEffectiveModelProjections(snapshot.runtimeEvents, loaded.transitions);
  const plan = buildRuntimeEventModelReplayPlan(effective.events);
  const events = new Map(effective.events.map((event) => [event.id, event]));
  const categories = {};
  const tools = {};
  for (const item of plan.items) {
    if (item.kind === 'thinking') continue;
    const body = itemBody(item);
    const measured = size(body);
    const entry = (categories[category(item, events)] ??= {
      items: 0,
      utf8Bytes: 0,
      utf16Units: 0,
    });
    entry.items += 1;
    entry.utf8Bytes += measured.utf8Bytes;
    entry.utf16Units += measured.utf16Units;
    if (item.kind === 'tool_result') {
      const tool = (tools[item.toolName] ??= { results: 0, utf8Bytes: 0, utf16Units: 0 });
      tool.results += 1;
      tool.utf8Bytes += measured.utf8Bytes;
      tool.utf16Units += measured.utf16Units;
    }
  }
  const totals = Object.values(categories).reduce(
    (sum, entry) => ({
      items: sum.items + entry.items,
      utf8Bytes: sum.utf8Bytes + entry.utf8Bytes,
      utf16Units: sum.utf16Units + entry.utf16Units,
    }),
    { items: 0, utf8Bytes: 0, utf16Units: 0 },
  );
  for (const entry of Object.values(categories)) {
    entry.estimatedTokensAtFourUnits = Math.ceil(entry.utf16Units / 4);
    entry.shareOfPayloadBytes = totals.utf8Bytes ? entry.utf8Bytes / totals.utf8Bytes : 0;
  }
  const composition = snapshot.runEvents.findLast(
    (event) => event.type === 'request_composition_resolved',
  )?.data?.snapshot;
  const lastDiagnostics = snapshot.runEvents.findLast(
    (event) => event.type === 'send_diagnostics_recorded',
  )?.data;
  const diagnostics = {};
  for (const item of plan.diagnostics) diagnostics[item.code] = (diagnostics[item.code] ?? 0) + 1;
  const lastRequest = snapshot.usage.findLast(
    (row) => row.call_kind === 'main' && row.status === 'completed',
  );
  return {
    schemaVersion: 1,
    sessionId: snapshot.sessionId,
    sampledAt: snapshot.sampledAt,
    sourceSha256: hash(JSON.stringify(snapshot)),
    throughOrdinal: snapshot.throughOrdinal,
    session: snapshot.session,
    storageByKind: snapshot.storageByKind,
    projection: {
      appliedTransitions: effective.applied.length,
      rejectedTransitions: effective.rejected.length,
      checkpointCount: checkpoints.length,
      diagnostics,
    },
    totals: { ...totals, estimatedTokensAtFourUnits: Math.ceil(totals.utf16Units / 4) },
    categories,
    tools,
    stablePrompt: {
      systemPromptHash: composition?.systemPromptHash ?? null,
      systemPromptBytes: null,
      toolSchemaJson: composition?.toolSchemas
        ? size(JSON.stringify(composition.toolSchemas))
        : null,
      toolNames: composition?.toolNames ?? [],
    },
    lastRequest: lastRequest ?? null,
    lastRuntimeEstimate: lastDiagnostics?.contextBudget ?? null,
    limits: [
      'Payload sizes use the production replay planner and committed projection transitions, not raw tool bodies.',
      'These are portable text/tool replay payloads, not a capture of a serialized HTTP request or its exact tokenizer.',
      'Provider reasoning and media bodies are not exported or counted in active payload totals.',
      'Retired-tool lowering and message/protocol wrappers add materialization overhead not included in payload totals.',
      'Token estimates use UTF-16 units / 4, not a DeepSeek tokenizer; reported usage belongs to the identified prior request.',
      'System prompt text is not durably captured by request composition; its size remains unknown rather than invented.',
      'Usage cache fields are ledger-normalized and are not proof every subfield was explicitly reported by the provider.',
    ],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      db: { type: 'string' },
      session: { type: 'string' },
      snapshot: { type: 'string' },
      out: { type: 'string' },
      'private-snapshot-out': { type: 'string' },
    },
  });
  if ((!values.db || !values.session) && !values.snapshot)
    throw new Error('Use --db <existing sqlite> --session <id>, or --snapshot <private JSON>');
  if (values.snapshot && values.db) throw new Error('Choose database or snapshot, not both');
  let snapshot;
  if (values.snapshot) snapshot = JSON.parse(readFileSync(values.snapshot, 'utf8'));
  else {
    const database = new DatabaseSync(realpathSync(values.db), { readOnly: true });
    try {
      snapshot = collectContextSnapshot(database, values.session);
    } finally {
      database.close();
    }
  }
  const report = await analyzeContextSnapshot(snapshot);
  if (values['private-snapshot-out'])
    writeFileSync(resolve(values['private-snapshot-out']), `${JSON.stringify(snapshot)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  if (values.out)
    writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  console.log(
    JSON.stringify(
      values.out
        ? { output: resolve(values.out), sourceSha256: report.sourceSha256, totals: report.totals }
        : report,
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
