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

import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import type { StoredMessage, WorkHubDelegationAssignedMessage } from '@maka/core/session';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { ToolResultArchiveEvidenceReader } from '@maka/core/tool-result-archive-evidence';
import { TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES } from '@maka/core/tool-result-archive-evidence';
import { createLedgerArchiveResourceReader } from '@maka/runtime/ledger-tool-result-archive-reader';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { RuntimeReadModelError } from '@maka/runtime/runtime-read-model';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import type { createWorkHubTaskHistoryRuntime } from './workhub-task-history-runtime.js';
import type { workHubEvidenceReadParameters } from './workhub-evidence-reader.js';

type Cursor = {
  holder: string;
  boundaryActionId: string;
  sourceActionId: string;
  filter: string;
  through: number | null;
  before: number;
  found: boolean;
  current?: {
    actionId: string;
    phase: 'request' | 'input' | 'execution' | 'records';
    offset: number;
    inputId?: string;
    executionCursor?: string;
    execution?: {
      turnId: string;
      runId: string;
      through: number | null;
      position: number | null;
    };
  };
};
type Assignment = WorkHubDelegationAssignedMessage;
type ReadInput = z.infer<typeof workHubEvidenceReadParameters>;
const workId = (a: Assignment) => a.work?.id ?? a.actionId;
const SCAN = { maxMessages: 64, maxStoredBytes: 256 * 1024 } as const;

/** Same-work history is a read projection, never a Session import or a new admission. */
export function createWorkHubTaskHistoryReader(options: {
  stores: Pick<
    ExecutionStoresWriter<'interactive'>['sessionStore'],
    'readWorkHubAssignment' | 'readWorkHubTaskFactsPage' | 'readWorkHubTaskInput'
  >;
  reader: Pick<SessionTranscriptReader, 'readDurableHighWater' | 'readDurableRecords'>;
  history: Pick<
    ReturnType<typeof createWorkHubTaskHistoryRuntime>,
    'readExecutions' | 'readAssignmentState'
  >;
  admission: SessionAdmissionGate;
  authorize(
    source: Assignment,
    ctx: MakaToolContext,
    lease: SessionAdmissionLease,
  ): Promise<Assignment | undefined>;
  archiveEvidence?: ToolResultArchiveEvidenceReader;
}) {
  // Keep only bounded reference/offset state, not history bodies. Short opaque
  // tokens survive model copying better than encoding an entire nested cursor.
  // Eviction and Host restart expire reads without reviving any authority.
  const cursors = new Map<string, Cursor>();
  const cursorBytes = 24;
  const encode = (cursor: Cursor) => {
    const token = randomBytes(cursorBytes).toString('base64url');
    if (cursors.size >= 128) cursors.delete(cursors.keys().next().value!);
    cursors.set(token, structuredClone(cursor));
    return token;
  };
  function decode(value: string): Cursor {
    const cursor = cursors.get(value);
    if (!cursor)
      throw new Error('Invalid or expired task history cursor; read again without a cursor');
    return structuredClone(cursor);
  }
  async function project(message: StoredMessage, sessionId: string) {
    const base = { messageId: message.id, turnId: message.turnId, timestamp: message.ts };
    switch (message.type) {
      case 'user':
        return {
          ...base,
          kind: 'user',
          inputOrigin: message.origin?.kind ?? 'execution_input',
          ...(message.steeringEventId ? { steeringEventId: message.steeringEventId } : {}),
          format: 'text',
          body: message.text,
        };
      case 'assistant':
        return { ...base, kind: 'assistant', format: 'text', body: message.text };
      case 'tool_call':
        if (message.modelVisibility === 'hidden') return undefined;
        return {
          ...base,
          kind: 'tool_call',
          toolName: message.toolName,
          toolCallId: message.id,
          format: 'json',
          body: JSON.stringify(message.args) ?? 'null',
        };
      case 'tool_result': {
        if (message.modelVisibility === 'hidden') return undefined;
        const content = message.content;
        let body = JSON.stringify(content),
          archiveStatus: string | undefined;
        if (content.kind === 'archived_tool_result') {
          archiveStatus = content.status === 'not_loaded' ? 'unavailable' : content.status;
          const evidence = options.archiveEvidence;
          if (evidence) {
            const loaded = await evidence.read({
              sessionId,
              runtimeEventId: content.runtimeEventId,
            });
            if (
              loaded.ok &&
              loaded.event.sessionId === sessionId &&
              loaded.event.turnId === message.turnId &&
              loaded.event.content?.kind === 'function_response' &&
              loaded.event.content.id === message.toolUseId &&
              loaded.event.content.name === content.toolName
            ) {
              const result = await createLedgerArchiveResourceReader(evidence)({
                storage: 'event',
                sessionId,
                runtimeEventId: content.runtimeEventId,
                maxBytes: TOOL_RESULT_ARCHIVE_EVIDENCE_MAX_BYTES,
              });
              if (result.ok) {
                body = result.serializedResult;
                archiveStatus = 'loaded';
              } else archiveStatus = result.reason;
            } else archiveStatus = loaded.ok ? 'source_mismatch' : loaded.reason;
          }
        }
        return {
          ...base,
          kind: 'tool_result',
          toolCallId: message.toolUseId,
          isError: message.isError,
          ...(archiveStatus ? { archiveStatus } : {}),
          format: 'json',
          body,
        };
      }
      default:
        return undefined;
    }
  }
  return async (input: ReadInput, ctx: MakaToolContext) => {
    const sourceActionId = input.source?.actionId ?? input.sourceActionId;
    if (!sourceActionId || (input.sourceActionId && input.sourceActionId !== sourceActionId))
      throw new Error('Task history requires one fixed source action');
    const source = await options.stores.readWorkHubAssignment(sourceActionId);
    if (!source) return { status: 'unavailable' as const };
    if (
      input.source &&
      (input.source.workId !== workId(source) ||
        input.source.generationId !== (source.work?.generationId ?? source.actionId) ||
        input.source.delegationId !== source.delegationId)
    )
      throw new Error('Task history source changed');
    const guard = (a: Assignment) =>
      options.admission.runMany(
        [WORKHUB_COORDINATION_SESSION_ID, ctx.sessionId, source.targetSessionId, a.targetSessionId],
        async (lease) => {
          ctx.abortSignal.throwIfAborted();
          if (workId(a) !== workId(source)) return undefined;
          const actor = await options.authorize(source, ctx, lease);
          const checked = actor && (await options.authorize(a, ctx, lease));
          return checked?.actionId === actor?.actionId ? actor : undefined;
        },
      );
    const actor = await guard(source);
    if (!actor) return { status: 'unavailable' as const };
    const kinds = [
      ...new Set(input.kinds ?? ['user', 'assistant', 'tool_call', 'tool_result']),
    ].sort();
    const filter = kinds.join(',');
    let state: Cursor;
    if (input.cursor) {
      state = decode(input.cursor);
      if (
        state.holder !== ctx.sessionId ||
        state.boundaryActionId !== actor.actionId ||
        state.sourceActionId !== sourceActionId ||
        state.filter !== filter
      )
        throw new Error('Task history cursor reader, source or filter changed');
    } else {
      const page = await options.stores.readWorkHubTaskFactsPage({
        ...SCAN,
        beforeSequence: Number.MAX_SAFE_INTEGER,
      });
      state = {
        holder: ctx.sessionId,
        boundaryActionId: actor.actionId,
        sourceActionId,
        filter,
        through: page.highWaterSequence,
        before: Number.MAX_SAFE_INTEGER,
        found: false,
      };
    }
    const records: Array<Record<string, unknown>> = [];
    const unavailableExecutions: Array<{ actionId: string; reason: string }> = [];
    const touched = new Map<string, Assignment>([[source.actionId, source]]);
    let done = state.through === null;
    let current = source;
    const response = (nextCursor: string | null) => ({
      status: 'ok' as const,
      history: {
        workId: workId(source),
        sourceActionId,
        contentScope: 'same_work_history',
        assignmentOrder: 'newest_first',
        recordOrder: 'newest_first_within_execution',
        offsetUnit: 'utf16_code_units',
        records,
        ...(unavailableExecutions.length ? { unavailableExecutions } : {}),
        nextCursor,
      },
    });
    const append = (
      value: Record<string, unknown> & { body: string },
      advance: (offset: number, complete: boolean) => void,
    ) => {
      const start = state.current!.offset;
      if (start > value.body.length)
        throw new Error('Task history text changed within its snapshot');
      let bytes = READ_PAGE_MAX_BYTES;
      while (bytes >= 4) {
        const text = truncateUtf8(value.body.slice(start), bytes);
        const end = start + text.length,
          complete = end === value.body.length;
        const previous = structuredClone(state);
        advance(end, complete);
        const { body, ...metadata } = value;
        const item = {
          ...metadata,
          actionId: current.actionId,
          sessionId: current.targetSessionId,
          text,
          textOffset: start,
          totalTextChars: body.length,
          truncated: !complete || start > 0,
        };
        records.push(item);
        if (Buffer.byteLength(JSON.stringify(response('x'.repeat(32)))) <= READ_PAGE_MAX_BYTES)
          return true;
        records.pop();
        state = previous;
        bytes = Math.floor(bytes / 2);
      }
      if (!records.length) throw new Error('Task history provenance exceeds its page budget');
      return false;
    };
    // Bounded discovery/projection work per call. Empty pages can still carry a cursor.
    for (let step = 0; step < 12 && !done && records.length < 8; step++) {
      ctx.abortSignal.throwIfAborted();
      if (!state.current) {
        if (state.before === 0) {
          done = true;
          break;
        }
        const page = await options.stores.readWorkHubTaskFactsPage({
          ...SCAN,
          beforeSequence: state.before,
        });
        for (const row of page.records) {
          state.before = row.sequence;
          const fact = row.message;
          if (row.sequence > state.through! || fact.type !== 'workhub_coordination') continue;
          if (!state.found) {
            if (fact.kind === 'delegation_assigned' && fact.actionId === state.boundaryActionId)
              state.found = true;
            // The actor assignment is a fixed boundary: neither its live
            // inputs nor future accepted facts become this historical page.
            continue;
          }
          if (fact.kind === 'task_input') {
            if (fact.workId !== workId(source) || !kinds.includes('user')) continue;
            state.current = {
              actionId: fact.sourceActionId,
              inputId: fact.inputId,
              phase: 'input',
              offset: 0,
            };
          } else if (fact.kind === 'delegation_assigned' && workId(fact) === workId(source)) {
            state.current = { actionId: fact.actionId, phase: 'request', offset: 0 };
          }
          if (state.current) break;
        }
        if (!state.current) {
          if (!page.records.length || state.before === 0) done = true;
          continue;
        }
      }
      const a = await options.stores.readWorkHubAssignment(state.current.actionId);
      if (!a || (await guard(a))?.actionId !== actor.actionId)
        return { status: 'unavailable' as const };
      current = a;
      touched.set(a.actionId, a);
      if (state.current.phase === 'input') {
        const accepted = await options.stores.readWorkHubTaskInput(state.current.inputId!);
        if (
          !accepted ||
          accepted.workId !== workId(a) ||
          accepted.generationId !== (a.work?.generationId ?? a.actionId) ||
          accepted.sourceActionId !== a.actionId ||
          accepted.sourceDelegationId !== a.delegationId ||
          accepted.targetSessionId !== a.targetSessionId ||
          accepted.turnId !== a.coordinationTurnId
        )
          return { status: 'unavailable' as const };
        if (
          !append(
            {
              kind: 'user',
              recordSource: 'task_input',
              inputOrigin: accepted.inputOrigin ?? 'unknown_legacy',
              textSource:
                accepted.originalUserText === undefined
                  ? 'accepted_text_legacy'
                  : 'original_user_text',
              messageId: accepted.id,
              inputId: accepted.inputId,
              timestamp: accepted.ts,
              mode: accepted.mode,
              targetMessageId: accepted.targetMessageId,
              coordinationTurnId: accepted.turnId,
              ...(accepted.sourceMessageId ? { sourceMessageId: accepted.sourceMessageId } : {}),
              acceptance: 'not_consumption_proof',
              format: 'text',
              body: accepted.originalUserText ?? accepted.text,
            },
            (offset, complete) => {
              if (complete) state.current = undefined;
              else state.current!.offset = offset;
            },
          )
        )
          break;
        continue;
      }
      if (state.current.phase === 'request') {
        if (kinds.includes('user')) {
          if (
            !append(
              {
                kind: 'user',
                inputOrigin: 'coordination_request',
                requestOrigin: a.inputOrigin ?? 'unknown_legacy',
                textSource: 'recorded_user_context',
                messageId: a.work?.sourceMessageId ?? a.id,
                timestamp: a.ts,
                format: 'text',
                body: a.userText,
              },
              (offset, complete) => {
                state.current!.offset = complete ? 0 : offset;
                if (complete) state.current!.phase = 'execution';
              },
            )
          )
            break;
        } else state.current.phase = 'execution';
        continue;
      }
      if (state.current.phase === 'execution') {
        const availability = await options.history.readAssignmentState(a.actionId, a.delegationId);
        if (availability !== 'owned') {
          unavailableExecutions.push({
            actionId: a.actionId,
            reason: availability === 'cancelled' ? 'cancelled_before_start' : availability,
          });
          if (Buffer.byteLength(JSON.stringify(response('x'.repeat(32)))) > READ_PAGE_MAX_BYTES) {
            unavailableExecutions.pop();
            break;
          }
          state.current = undefined;
          continue;
        }
        const page = await options.history.readExecutions(
          a.actionId,
          a.delegationId,
          state.current.executionCursor,
          1,
        );
        const execution = page.executions[0];
        if (!execution || !['completed', 'failed', 'cancelled'].includes(execution.status))
          return { status: 'pending' as const };
        const through = await options.reader.readDurableHighWater(
          a.targetSessionId,
          execution.turnId,
        );
        if (through === null) {
          unavailableExecutions.push({
            actionId: a.actionId,
            reason: 'native_transcript_unavailable',
          });
          if (Buffer.byteLength(JSON.stringify(response('x'.repeat(32)))) > READ_PAGE_MAX_BYTES) {
            unavailableExecutions.pop();
            break;
          }
        }
        state.current.executionCursor = page.nextCursor ?? undefined;
        state.current.execution = {
          turnId: execution.turnId,
          runId: execution.runId,
          through,
          position: through,
        };
        state.current.phase = 'records';
      }
      const execution = state.current.execution!;
      if (execution.position === null) {
        if (state.current.executionCursor) {
          state.current.phase = 'execution';
          state.current.execution = undefined;
        } else state.current = undefined;
        continue;
      }
      let page;
      try {
        page = await options.reader.readDurableRecords(
          a.targetSessionId,
          {
            ...SCAN,
            direction: 'older',
            throughSequence: execution.through,
            position: execution.position,
          },
          execution.turnId,
        );
      } catch (error) {
        if (error instanceof RuntimeReadModelError)
          return {
            status: 'unsupported' as const,
            reason: 'The recorded native execution cannot be projected as task history',
          };
        throw error;
      }
      if (page.throughSequence !== execution.through)
        throw new Error('Task history snapshot changed');
      let full = false;
      for (const row of page.records) {
        if (row.message.turnId !== execution.turnId || !kinds.includes(row.message.type)) {
          state.current.execution!.position = row.sequence > 0 ? row.sequence - 1 : null;
          state.current.offset = 0;
          continue;
        }
        const value = await project(row.message, a.targetSessionId);
        if (!value) {
          state.current.execution!.position = row.sequence > 0 ? row.sequence - 1 : null;
          state.current.offset = 0;
          continue;
        }
        if (
          !append(
            { ...value, sequence: row.sequence, runId: execution.runId },
            (offset, complete) => {
              state.current!.offset = complete ? 0 : offset;
              state.current!.execution!.position = complete
                ? row.sequence > 0
                  ? row.sequence - 1
                  : null
                : row.sequence;
            },
          )
        ) {
          full = true;
          break;
        }
        if (state.current.offset || records.length >= 8) {
          full = true;
          break;
        }
      }
      if (full) break;
      state.current.execution!.position = page.nextPosition;
    }
    for (const assignment of touched.values())
      if ((await guard(assignment))?.actionId !== actor.actionId)
        return { status: 'unavailable' as const };
    if (!state.found && done) return { status: 'unavailable' as const };
    return response(done ? null : encode(state));
  };
}
