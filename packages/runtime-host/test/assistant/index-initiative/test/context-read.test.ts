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

import test from 'node:test';
import assert from 'node:assert/strict';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';
import {
  contextPage,
  notebookContext,
  discoverySeed,
} from '../../../../src/assistant/index-initiative/context-read.js';
import { note } from './notebook-output.js';

function whole(book: Notebook, input: any) {
  let offset = 0,
    result = '',
    revision: string | undefined;
  for (;;) {
    const page = notebookContext(book, { ...input, offset, limit: 97, revision });
    assert.ok(page.text.length <= 97);
    result += page.text;
    revision = page.notebookRevision;
    if (page.nextOffset === null) return result;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
}

test('topic continuation rejects time-derived state changes and a fresh read retains all evidence', () => {
  let now = '2030-01-01T23:59:59.000Z';
  const book = new Notebook(':memory:', () => now);
  const text = '原始证据😀'.repeat(2000);
  try {
    book.appendNote({ ...note, text }, 'evidence');
    book.put('delivered', 'delivery', { topicIds: [note.topicId], text: '已交流的发现' });
    book.recordFeedback({ id: 'later', text: '明天再提醒', replyTo: 'delivered' });
    book.resolveFeedback(
      {
        feedbackId: 'later',
        understanding: '等待用户指定时间',
        rules: [
          {
            quote: '明天再提醒',
            status: 'deferred',
            reason: '用户指定时间',
            resumeAt: '2030-01-02T00:00:00.000Z',
            topicIds: [note.topicId],
            tags: [],
          },
        ],
      },
      'defer',
    );
    const first = notebookContext(book, { view: 'topic', topicId: note.topicId, limit: 700 });
    assert.notEqual(first.nextOffset, null);
    assert.equal(book.state(note.topicId).status, 'deferred');
    const sequence = book.events().at(-1)!.seq;
    now = '2030-01-02T00:00:01.000Z';
    assert.equal(book.events().at(-1)!.seq, sequence, 'no events changed at the deadline');
    assert.equal(book.state(note.topicId).status, 'open');
    assert.throws(
      () =>
        notebookContext(book, {
          view: 'topic',
          topicId: note.topicId,
          limit: 700,
          offset: first.nextOffset!,
          revision: first.notebookRevision,
        }),
      /Notebook changed/,
    );
    const fresh = JSON.parse(whole(book, { view: 'topic', topicId: note.topicId }));
    assert.equal(fresh.topic.status, 'open');
    assert.equal(fresh.events.find((event: any) => event.id === 'evidence').payload.text, text);
  } finally {
    book.close();
  }
});

test('bootstrap stays bounded while every catalog topic and full source remain recoverable', () => {
  const book = new Notebook(':memory:');
  try {
    for (let i = 0; i < 80; i++)
      book.appendNote(
        {
          ...note,
          topicId: `topic-${i}`,
          title: `Topic ${i}`,
          text: i === 79 ? 'UNRELATED_PAYLOAD'.repeat(2000) : note.text,
        },
        `note-${i}`,
      );
    const seed = discoverySeed(book);
    assert.ok(seed.length < 10000);
    assert.doesNotMatch(seed, /UNRELATED_PAYLOAD/);
    const first = notebookContext(book, { limit: 6000 });
    const feedback = notebookContext(book, { view: 'feedback', limit: 3000 });
    assert.ok(seed.includes(first.notebookRevision));
    assert.ok(seed.includes(feedback.notebookRevision));
    assert.notEqual(first.nextOffset, null);
    const catalog = whole(book, { view: 'catalog' });
    for (let i = 0; i < 80; i++) assert.ok(catalog.includes(`"topic-${i}"`));
    const source = JSON.parse(whole(book, { view: 'event', eventId: 'note-79' }));
    assert.equal(source.payload.text, 'UNRELATED_PAYLOAD'.repeat(2000));
  } finally {
    book.close();
  }
});

test('a topic read carries its evidence, handoff, actual receipt and applicable feedback without unrelated notes', () => {
  const book = new Notebook(':memory:');
  try {
    book.appendNote(note, 'note');
    book.appendNote(
      { ...note, topicId: 'other', title: 'Other', tags: [], text: 'UNRELATED_EVIDENCE' },
      'other-note',
    );
    book.put('prepared', 'prepared', { topicIds: [note.topicId], text: '准备交流' });
    book.put('reported', 'reported', { preparedId: 'prepared', text: '已交给 Bot' });
    book.put('delivered', 'delivery', { topicIds: [note.topicId], text: '用户实际收到' });
    book.put('other-delivery', 'delivery', { topicIds: ['other'], text: '其他方向' });
    book.recordFeedback({ id: 'linked', text: '这件事请暂缓', replyTo: 'delivered' });
    book.recordFeedback({ id: 'tag-rule', text: '摄影方向先不需要', replyTo: 'other-delivery' });
    book.resolveFeedback(
      {
        feedbackId: 'tag-rule',
        understanding: '用户关闭方向',
        rules: [
          {
            quote: '摄影方向先不需要',
            status: 'closed',
            reason: '用户决定',
            topicIds: [],
            tags: ['摄影'],
          },
        ],
      },
      'resolution',
    );
    const result = JSON.parse(whole(book, { view: 'topic', topicId: note.topicId }));
    assert.equal(result.topic.status, 'closed');
    assert.deepEqual(
      result.events.map((event: any) => event.id),
      ['note', 'prepared', 'reported', 'delivered', 'linked', 'tag-rule', 'resolution'],
    );
    assert.doesNotMatch(JSON.stringify(result), /UNRELATED_EVIDENCE|other-note/);
    const receipts = whole(book, { view: 'deliveries' });
    assert.match(receipts, /交给 Bot 不等于用户实际收到/);
    assert.match(receipts, /other-delivery/);
  } finally {
    book.close();
  }
});

test('continuations detect changed knowledge and do not silently lose or split Unicode content', () => {
  const book = new Notebook(':memory:');
  try {
    const text = '前缀😀🦊正文'.repeat(500);
    book.appendNote({ ...note, text }, 'note');
    assert.equal(JSON.parse(whole(book, { view: 'event', eventId: 'note' })).payload.text, text);
    const first = notebookContext(book, { view: 'event', eventId: 'note', limit: 97 });
    book.appendNote({ ...note, text: 'new evidence' }, 'next');
    assert.throws(
      () =>
        notebookContext(book, {
          view: 'event',
          eventId: 'note',
          offset: first.nextOffset!,
          revision: first.notebookRevision,
        }),
      /Notebook changed/,
    );
    assert.throws(
      () => notebookContext(book, { view: 'topic', topicId: 'unknown' }),
      /Unknown notebook topic/,
    );
    assert.throws(
      () => notebookContext(book, { view: 'event', eventId: 'unknown' }),
      /Unknown notebook event/,
    );
    assert.deepEqual(contextPage('a😀b', 0, 2), {
      text: 'a',
      offset: 0,
      nextOffset: 1,
      totalCharacters: 4,
    });
    assert.throws(() => contextPage('a😀b', 2), /Unicode/);
    for (const limit of [-1, 1, 12001, Number.NaN])
      assert.throws(() => contextPage('text', 0, limit), /Invalid context page/);
  } finally {
    book.close();
  }
});

test('feedback bootstrap prioritizes pending owner text and keeps resolved originals on demand', () => {
  const book = new Notebook(':memory:');
  try {
    book.put('delivery', 'delivery', { topicIds: [], text: '真实送达' });
    book.recordFeedback({ id: 'old', text: 'RESOLVED_PROSE'.repeat(2000), replyTo: 'delivery' });
    book.resolveFeedback(
      { feedbackId: 'old', understanding: 'OLD_INTERPRETATION'.repeat(2000), rules: [] },
      'understood',
    );
    book.recordFeedback({ id: 'current', text: '当前反馈请优先处理', replyTo: 'delivery' });
    const result = JSON.parse(whole(book, { view: 'feedback' }));
    assert.deepEqual(
      result.pending.map((event: any) => event.id),
      ['current'],
    );
    assert.match(JSON.stringify(result), /当前反馈请优先处理/);
    assert.doesNotMatch(JSON.stringify(result), /RESOLVED_PROSE|OLD_INTERPRETATION/);
    assert.ok(result.feedback.some((entry: any) => entry.id === 'old' && entry.resolved));
    assert.equal(
      JSON.parse(whole(book, { view: 'event', eventId: 'old' })).payload.text,
      'RESOLVED_PROSE'.repeat(2000),
    );
  } finally {
    book.close();
  }
});

test('serialized UTF-8 pages stay below Runtime archival size for Chinese, emoji and escaped controls', () => {
  for (const text of ['中文😀'.repeat(5000), '"\\\u0000\n'.repeat(5000)]) {
    let offset = 0,
      recovered = '';
    for (;;) {
      const page = contextPage(text, offset, 12000);
      assert.ok(
        Buffer.byteLength(JSON.stringify({ ...page, contextRevision: 'a'.repeat(64) }), 'utf8') <
          7500,
      );
      recovered += page.text;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
    assert.equal(recovered, text);
  }
});
