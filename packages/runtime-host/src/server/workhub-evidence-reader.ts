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
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  WORKHUB_COORDINATION_SESSION_ID,
  type WorkHubDelegationAssignedMessage,
} from '@maka/core/session';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { READ_PAGE_MAX_BYTES } from '@maka/runtime/read-page';
import type { ExecutionStoresWriter } from '@maka/storage/execution-stores';
import type { HostedExecutionRef } from './hosted-execution-authority.js';
import { JsonArrayPageBudget } from './json-array-page-budget.js';
import type { SessionAdmissionGate, SessionAdmissionLease } from './session-admission-gate.js';
import type { SessionTranscriptReader } from './session-transcript-reader.js';
import type { TurnSnapshot } from '../protocol/turn.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const token = z.string().min(1).max(4096);
const sourceSchema = z
  .object({ workId: id, generationId: id, actionId: id, delegationId: id })
  .strict();
export const workHubEvidenceListParameters = z
  .object({
    operation: z.literal('list'),
    query: z.string().trim().max(256).optional(),
    limit: z.number().int().min(1).max(16).default(8),
    cursor: token.optional(),
  })
  .strict();
export const workHubEvidenceReadParameters = z
  .object({
    operation: z.literal('read'),
    sourceActionId: id.optional(),
    source: sourceSchema.optional(),
    cursor: token.optional(),
  })
  .strict();
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      version: z.literal(1),
      kind: z.literal('catalog'),
      holderSessionId: id,
      queryHash: z.string(),
      before: ordinal,
      through: ordinal,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('evidence'),
      holderSessionId: id,
      source: sourceSchema,
      sessionId: id,
      messageId: id,
      turnId: id,
      runId: id,
      through: ordinal,
      position: ordinal,
      textOffset: ordinal,
    })
    .strict(),
]);
type Cursor = z.infer<typeof cursorSchema>;
type Source = z.infer<typeof sourceSchema>;
// Keep the cursor model-visible instead of causing another archive/read layer.
const MAX_RESULT_BYTES = READ_PAGE_MAX_BYTES;
const MAX_TEXT_BYTES = READ_PAGE_MAX_BYTES;
const SCAN = { maxMessages: 64, maxStoredBytes: 256 * 1024 } as const;

function summary(value: string, maxEncodedBytes: number): string {
  let text = truncateUtf8(value, maxEncodedBytes - 2, '…');
  while (Buffer.byteLength(JSON.stringify(text)) > maxEncodedBytes) {
    text = truncateUtf8(text, Math.max(4, Math.floor(Buffer.byteLength(text) / 2)), '…');
  }
  return text;
}

const reference = (a: WorkHubDelegationAssignedMessage): Source => ({
  workId: a.work?.id ?? a.actionId,
  generationId: a.work?.generationId ?? a.actionId,
  actionId: a.actionId,
  delegationId: a.delegationId,
});
const sameReference = (a: Source, b: Source) =>
  a.workId === b.workId &&
  a.generationId === b.generationId &&
  a.actionId === b.actionId &&
  a.delegationId === b.delegationId;

/** Read-only pages of the existing ledger. Authority/ownership remain with the evidence runtime. */
export function createWorkHubEvidenceReader(options: {
  stores: Pick<
    ExecutionStoresWriter<'interactive'>['sessionStore'],
    'readWorkHubAssignmentsPage' | 'readWorkHubAssignment'
  >;
  reader: Pick<SessionTranscriptReader, 'readDurableHighWater' | 'readDurableRecords'>;
  admission: SessionAdmissionGate;
  authorize(ctx: MakaToolContext, lease: SessionAdmissionLease): Promise<void>;
  active(source: WorkHubDelegationAssignedMessage): Promise<boolean>;
  /** Read-only historical access is distinct from active communication authority. */
  readable?(
    source: WorkHubDelegationAssignedMessage,
    ctx: MakaToolContext,
    lease: SessionAdmissionLease,
  ): Promise<boolean>;
  execution(
    source: WorkHubDelegationAssignedMessage,
    lease: SessionAdmissionLease,
  ): Promise<
    (HostedExecutionRef & { status: TurnSnapshot['status']; waiting: boolean }) | undefined
  >;
}) {
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  const encode = (cursor: Cursor) => {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${sign(payload).toString('base64url')}`;
  };
  function decode(value: string | undefined, holderSessionId: string) {
    if (!value) return undefined;
    try {
      const [payload, signature, extra] = value.split('.');
      if (!payload || !signature || extra !== undefined) throw new Error('Malformed cursor');
      const supplied = Buffer.from(signature, 'base64url'),
        expected = sign(payload);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw new Error('Invalid signature');
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      if (cursor.holderSessionId !== holderSessionId) throw new Error('Changed reader');
      return cursor;
    } catch {
      throw new Error('Invalid or expired evidence cursor; discover/read again without a cursor');
    }
  }
  const lanes = (ctx: MakaToolContext, targets: readonly string[] = []) => [
    WORKHUB_COORDINATION_SESSION_ID,
    ctx.sessionId,
    ...targets,
  ];

  async function list(input: z.infer<typeof workHubEvidenceListParameters>, ctx: MakaToolContext) {
    const query = (input.query ?? '').normalize('NFC').toLowerCase();
    const queryHash = createHash('sha256').update(query).digest('hex');
    const cursor = decode(input.cursor, ctx.sessionId);
    if (
      cursor &&
      (cursor.kind !== 'catalog' ||
        cursor.queryHash !== queryHash ||
        cursor.before > cursor.through + 1)
    )
      throw new Error('Invalid or expired evidence cursor: changed discovery query');
    const page = await options.admission.runMany(lanes(ctx), async (lease) => {
      await options.authorize(ctx, lease);
      return options.stores.readWorkHubAssignmentsPage({
        ...SCAN,
        beforeSequence: cursor?.kind === 'catalog' ? cursor.before : Number.MAX_SAFE_INTEGER,
      });
    });
    const through = cursor?.kind === 'catalog' ? cursor.through : page.highWaterSequence;
    const rows = page.records.filter(
      (row): row is typeof row & { message: WorkHubDelegationAssignedMessage } =>
        row.message.type === 'workhub_coordination' && row.message.kind === 'delegation_assigned',
    );
    return options.admission.runMany(
      lanes(
        ctx,
        rows.map((row) => row.message.targetSessionId),
      ),
      async (lease) => {
        await options.authorize(ctx, lease);
        const tasks = [];
        const empty = { status: 'ok', tasks: [], truncated: false, nextCursor: null };
        const budget = new JsonArrayPageBudget(MAX_RESULT_BYTES, empty);
        let before = 0;
        const next = (position: number) =>
          through !== null && position > 0
            ? encode({
                version: 1,
                kind: 'catalog',
                holderSessionId: ctx.sessionId,
                queryHash,
                before: position,
                through,
              })
            : null;
        for (const row of rows) {
          ctx.abortSignal.throwIfAborted();
          const a = row.message;
          const previous = before;
          before = row.sequence;
          if (through === null || row.sequence > through || !(await options.active(a))) continue;
          const source = reference(a);
          const origin =
            source.workId === a.actionId
              ? a
              : await options.stores.readWorkHubAssignment(source.workId);
          if (!origin || (origin.work?.id ?? origin.actionId) !== source.workId) continue;
          const objective = origin.delegationText ?? origin.userText;
          const taskText = a.delegationText ?? a.userText;
          if (
            query &&
            !`${objective}\n${taskText}\n${a.targetSessionName}`
              .normalize('NFC')
              .toLowerCase()
              .includes(query)
          )
            continue;
          const execution = await options.execution(a, lease);
          const sessionName = summary(a.targetSessionName, 256);
          const taskExcerpt = summary(taskText, 512),
            objectiveExcerpt = summary(objective, 512);
          const task = {
            ...source,
            source,
            sessionName,
            nameTruncated: sessionName !== a.targetSessionName,
            task: taskExcerpt,
            objective: objectiveExcerpt,
            textTruncated: taskExcerpt !== taskText || objectiveExcerpt !== objective,
            createdAt: origin.ts,
            sourceSessionId: a.targetSessionId,
            sourceMessageId: a.targetMessageId,
            status: execution?.waiting
              ? 'waiting_for_dependency'
              : (execution?.status ?? 'unproven'),
            sourceTurnId: execution?.turnId ?? null,
            sourceRunId: execution?.runId ?? null,
          };
          if (!budget.tryAppend(task, through === null ? null : next(through))) {
            if (!tasks.length)
              throw new Error('Evidence discovery provenance exceeds its page budget');
            before = previous;
            break;
          }
          tasks.push(task);
          if (tasks.length >= input.limit) break;
        }
        await options.authorize(ctx, lease);
        ctx.abortSignal.throwIfAborted();
        const nextCursor = next(before);
        return { status: 'ok', tasks, truncated: nextCursor !== null, nextCursor };
      },
    );
  }

  async function read(input: z.infer<typeof workHubEvidenceReadParameters>, ctx: MakaToolContext) {
    const actionId = input.source?.actionId ?? input.sourceActionId;
    if (!actionId || (input.sourceActionId && input.sourceActionId !== actionId))
      throw new Error('Evidence requires one unchanged source action');
    const cursor = decode(input.cursor, ctx.sessionId);
    if (
      cursor &&
      (cursor.kind !== 'evidence' ||
        cursor.source.actionId !== actionId ||
        (input.source && !sameReference(cursor.source, input.source)))
    )
      throw new Error('Invalid or expired evidence cursor: source changed');
    const a = await options.admission.runMany(lanes(ctx), async (lease) => {
      await options.authorize(ctx, lease);
      return options.stores.readWorkHubAssignment(actionId);
    });
    if (!a) return { status: 'unavailable' };
    return options.admission.runMany(lanes(ctx, [a.targetSessionId]), async (lease) => {
      await options.authorize(ctx, lease);
      const canRead = () =>
        options.readable ? options.readable(a, ctx, lease) : options.active(a);
      if (!(await canRead())) return { status: 'unavailable' };
      const historical = !(await options.active(a));
      const source = reference(a);
      if (input.source && !sameReference(input.source, source))
        throw new Error('Evidence source changed; discover the work again');
      const execution = await options.execution(a, lease);
      const sameExecution = (value: typeof execution) =>
        value &&
        execution &&
        value.sessionId === execution.sessionId &&
        value.turnId === execution.turnId &&
        value.runId === execution.runId &&
        !value.waiting;
      if (
        cursor &&
        (cursor.kind !== 'evidence' ||
          !sameReference(cursor.source, source) ||
          cursor.sessionId !== a.targetSessionId ||
          cursor.messageId !== a.targetMessageId ||
          cursor.turnId !== execution?.turnId ||
          cursor.runId !== execution?.runId ||
          cursor.position > cursor.through)
      )
        throw new Error('Invalid or expired evidence cursor: source execution changed');
      if (
        !execution ||
        execution.waiting ||
        !['completed', 'failed', 'cancelled'].includes(execution.status)
      )
        return { status: 'pending' };
      const through =
        cursor?.kind === 'evidence'
          ? cursor.through
          : await options.reader.readDurableHighWater(a.targetSessionId, execution.turnId);
      const page =
        through === null
          ? null
          : await options.reader.readDurableRecords(
              a.targetSessionId,
              {
                ...SCAN,
                direction: 'older',
                throughSequence: through,
                ...(cursor?.kind === 'evidence' ? { position: cursor.position } : {}),
              },
              execution.turnId,
            );
      if (page && page.throughSequence !== through)
        throw new Error('Evidence transcript snapshot changed');
      ctx.abortSignal.throwIfAborted();
      const base = {
        source,
        ...(historical ? { historical: true } : {}),
        workId: source.workId,
        generationId: source.generationId,
        sourceActionId: a.actionId,
        sourceDelegationId: a.delegationId,
        sourceSessionId: a.targetSessionId,
        sourceMessageId: a.targetMessageId,
        sourceTurnId: execution.turnId,
        sourceRunId: execution.runId,
        status: execution.status,
        throughSequence: through,
        order: 'newest_first',
        contentScope: 'committed_assistant_text_of_owned_execution',
        offsetUnit: 'utf16_code_units',
      };
      const messages = [];
      const budget = new JsonArrayPageBudget(MAX_RESULT_BYTES, {
        status: 'ok',
        evidence: { ...base, messages: [], truncated: false, nextCursor: null },
      });
      const next = (position: number, textOffset: number) =>
        through !== null
          ? encode({
              version: 1,
              kind: 'evidence',
              holderSessionId: ctx.sessionId,
              source,
              sessionId: a.targetSessionId,
              messageId: a.targetMessageId,
              turnId: execution.turnId,
              runId: execution.runId,
              through,
              position,
              textOffset,
            })
          : null;
      let nextCursor = page?.nextPosition === null || !page ? null : next(page.nextPosition, 0);
      // A later row may need a continuation even when this row is complete.
      // Reserve its worst-case cursor before accepting any text into the page.
      const reservedCursor = through === null ? null : next(through, Number.MAX_SAFE_INTEGER);
      let remaining = MAX_TEXT_BYTES;
      for (const { sequence, message } of page?.records ?? []) {
        ctx.abortSignal.throwIfAborted();
        if (
          message.type !== 'assistant' ||
          message.turnId !== execution.turnId ||
          !message.text.length
        )
          continue;
        const start =
          cursor?.kind === 'evidence' && cursor.position === sequence ? cursor.textOffset : 0;
        if (start > message.text.length)
          throw new Error('Evidence text changed within its snapshot');
        if (messages.length >= 8 || remaining < 4) {
          nextCursor = next(sequence, start);
          break;
        }
        let bytes = remaining;
        for (;;) {
          const text = truncateUtf8(message.text.slice(start), bytes);
          const end = start + text.length;
          const candidate = {
            messageId: message.id,
            turnId: message.turnId,
            sequence,
            text,
            textOffset: start,
            totalTextChars: message.text.length,
            truncated: start > 0 || end < message.text.length,
            ...(message.interrupted ? { interrupted: true } : {}),
          };
          const continuation = end < message.text.length ? next(sequence, end) : nextCursor;
          if (text.length && budget.tryAppend(candidate, reservedCursor)) {
            messages.push(candidate);
            remaining -= Buffer.byteLength(text);
            if (end < message.text.length) nextCursor = continuation;
            break;
          }
          if (bytes <= 4) {
            if (!messages.length) throw new Error('Evidence provenance exceeds its page budget');
            nextCursor = next(sequence, start);
            break;
          }
          bytes = Math.max(4, Math.floor(bytes / 2));
        }
        if (
          nextCursor &&
          (messages.at(-1)?.sequence !== sequence ||
            messages.at(-1)!.textOffset + messages.at(-1)!.text.length < message.text.length)
        )
          break;
      }
      if (!(await canRead())) return { status: 'unavailable' };
      const latest = await options.execution(a, lease);
      if (!sameExecution(latest) || latest!.status !== execution.status)
        throw new Error('Evidence source execution changed while reading');
      await options.authorize(ctx, lease);
      ctx.abortSignal.throwIfAborted();
      return {
        status: 'ok',
        evidence: {
          ...base,
          messages,
          truncated: nextCursor !== null || messages.some((message) => message.truncated),
          nextCursor,
        },
      };
    });
  }
  return { list, read };
}
