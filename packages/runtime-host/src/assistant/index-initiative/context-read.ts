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

import type { Notebook } from './notebook.js';
import { z } from 'zod';

export type DiscoveryContextMode = 'legacy' | 'scoped';
export type NotebookView = 'catalog' | 'topic' | 'feedback' | 'deliveries' | 'event';
export const CONTEXT_PAGE_CHARACTERS = 8000;
export const MAX_CONTEXT_PAGE_CHARACTERS = 12000;
// Leave room for cursor/revision metadata below Runtime's 7,500-byte archive threshold.
export const MAX_CONTEXT_PAGE_BYTES = 6000;

export const notebookReadSchema = z
  .object({
    view: z.enum(['catalog', 'topic', 'feedback', 'deliveries', 'event']).default('catalog'),
    topicId: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z
      .number()
      .int()
      .min(2)
      .max(MAX_CONTEXT_PAGE_CHARACTERS)
      .default(CONTEXT_PAGE_CHARACTERS),
    revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Pass notebookRevision on continuation; restart the read if the notebook changed.'),
  })
  .strict();

/** Bounded text, with an explicit continuation; never silently drop the remainder. */
export function contextPage(text: string, offset = 0, limit = CONTEXT_PAGE_CHARACTERS) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 2 ||
    limit > MAX_CONTEXT_PAGE_CHARACTERS
  )
    throw Error('Invalid context page');
  if (
    offset > 0 &&
    offset < text.length &&
    /[\uDC00-\uDFFF]/u.test(text[offset]) &&
    /[\uD800-\uDBFF]/u.test(text[offset - 1])
  )
    throw Error('Context offset splits a Unicode character');
  let end = Math.min(text.length, offset + limit);
  if (
    end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/u.test(text[end])
  )
    end--;
  let bytes = 2,
    boundedEnd = offset; // JSON string quotes.
  for (const character of text.slice(offset, end)) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes + size > MAX_CONTEXT_PAGE_BYTES) break;
    bytes += size;
    boundedEnd += character.length;
  }
  end = boundedEnd;
  return {
    text: text.slice(offset, end),
    offset,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length,
  };
}

const preview = (text: string, length: number) =>
  text.length <= length ? text : text.slice(0, length) + '…';

/** Views over durable knowledge. A topic read includes its receipts and applicable feedback. */
export function notebookContext(
  book: Notebook,
  input: {
    view?: NotebookView;
    topicId?: string;
    eventId?: string;
    offset?: number;
    limit?: number;
    revision?: number;
  } = {},
) {
  const revision = book.events().at(-1)?.seq ?? 0;
  if (input.revision !== undefined && input.revision !== revision)
    throw Error('Notebook changed; restart this view from offset 0');
  const view = input.view ?? 'catalog';
  let text: string;
  if (view === 'catalog') {
    text =
      '# 主题目录（摘要，不是待办或当前需求）\n' +
      JSON.stringify(
        [...book.topics().values()]
          .sort(
            (a, b) =>
              (b.notes.at(-1)?.recordedAt ?? '').localeCompare(a.notes.at(-1)?.recordedAt ?? '') ||
              a.id.localeCompare(b.id),
          )
          .map((topic) => ({
            id: topic.id,
            title: preview(topic.title, 160),
            tags: topic.tags.slice(0, 12).map((tag: string) => preview(tag, 60)),
            notes: topic.notes.length,
            updatedAt: topic.notes.at(-1)?.recordedAt,
          })),
        null,
        2,
      );
  } else if (view === 'topic') {
    const topic = book.topics().get(input.topicId ?? '');
    if (!topic) throw Error('Unknown notebook topic');
    const state = book.state(topic.id);
    const resolutions = book
      .feedbackResolutions()
      .filter((event) =>
        event.payload.rules.some(
          (rule: any) =>
            rule.topicIds.includes(topic.id) ||
            rule.tags.some((tag: string) => topic.tags.includes(tag)),
        ),
      );
    const feedbackIds = new Set(resolutions.map((event) => event.payload.feedbackId));
    const all = book.events();
    const linked = new Set(
      all.filter((event) => event.payload.topicIds?.includes(topic.id)).map((event) => event.id),
    );
    const events = all.filter(
      (event) =>
        event.payload.topicId === topic.id ||
        event.payload.topicIds?.includes(topic.id) ||
        linked.has(event.payload.preparedId) ||
        linked.has(event.payload.replyTo) ||
        feedbackIds.has(event.id) ||
        resolutions.some((resolution) => resolution.id === event.id),
    );
    text = JSON.stringify(
      {
        topic: {
          id: topic.id,
          title: topic.title,
          status: state.status,
          reason: state.reason,
          resumeAt: state.resumeAt ?? null,
        },
        events,
      },
      null,
      2,
    );
  } else if (view === 'feedback') {
    const resolutions = book.feedbackResolutions();
    const resolved = new Set(resolutions.map((event) => event.payload.feedbackId));
    text = JSON.stringify(
      {
        pending: book.pendingFeedback(),
        rules: resolutions
          .filter((event) => event.payload.rules.length)
          .map((event) => ({
            id: event.id,
            feedbackId: event.payload.feedbackId,
            rules: event.payload.rules,
          })),
        // Resolved prose is not working context. Keep IDs so originals can still
        // be recovered through the event view, including feedback without rules.
        feedback: book.feedback().map((event) => ({
          id: event.id,
          at: event.at,
          replyTo: event.payload.replyTo,
          resolved: resolved.has(event.id),
        })),
      },
      null,
      2,
    );
  } else if (view === 'deliveries') {
    text = JSON.stringify(
      {
        delivered: book.events('delivery'),
        handedToBot: book.events('reported'),
        notice: '交给 Bot 不等于用户实际收到。',
      },
      null,
      2,
    );
  } else {
    const event = book.event(input.eventId ?? '');
    if (!event) throw Error('Unknown notebook event');
    text = JSON.stringify(event, null, 2);
  }
  return {
    ...contextPage(text, input.offset, input.limit),
    view,
    feedbackRevision: book.revision(),
    notebookRevision: revision,
    readOnly: true,
  };
}

/** No notes, tool dumps, or full transcript are put into the initial model request. */
export function discoverySeed(book: Notebook) {
  const catalog = notebookContext(book, { view: 'catalog', limit: 6000 });
  const feedback = notebookContext(book, { view: 'feedback', limit: 3000 });
  return [
    `Notebook revision：${catalog.notebookRevision}（分页续读时作为 revision）。`,
    catalog.text,
    `\n目录后续 offset：${catalog.nextOffset ?? '无'}；目录总字符：${catalog.totalCharacters}。`,
    '\n# 用户反馈（先处理，再决定是否交流）',
    feedback.text,
    `\n反馈后续 offset：${feedback.nextOffset ?? '无'}。`,
    '\n通过 DiscoveryNotebook 分页读取目录、具体 topic、反馈、真实送达或原始 event。nextOffset 非空表示仍有未读取内容。旧线索仍可查询；不要只查看目录第一页。',
  ].join('\n');
}
