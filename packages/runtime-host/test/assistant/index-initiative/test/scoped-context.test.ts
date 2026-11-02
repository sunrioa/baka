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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Notebook } from '../../../../src/assistant/index-initiative/notebook.js';
import { fixture, until } from './fixture.js';
import { output, view, note } from './notebook-output.js';

async function scoped() {
  const f = await fixture();
  await f.remote('assistant.bind', { sessionId: 'owner' });
  const before = await f.invoke('InitiativeStatus');
  const configured = await f.invoke('InitiativeConfigure', { contextMode: 'scoped' });
  assert.equal(configured.intervalMs, before.intervalMs);
  assert.equal(configured.enabled, false);
  assert.equal(configured.effect.before.contextMode, 'legacy');
  assert.equal(configured.effect.after.contextMode, 'scoped');
  return f;
}

async function check(f: any) {
  const previous = (await f.invoke('InitiativeStatus')).lastRun?.id;
  await f.invoke('InitiativeControl', { action: 'check' });
  await until(async () => (await f.invoke('InitiativeStatus')).lastRun?.id !== previous);
  const state = await f.invoke('InitiativeStatus');
  assert.equal(state.lastError, null);
  return state;
}

test('30 scoped cycles use fresh workers while relevant knowledge, receipts and closed feedback survive restart', async () => {
  const f = await scoped();
  const bookPath = join(f.root, 'dev.maka.index-initiative', 'notebook.sqlite');
  const book = new Notebook(bookPath);
  book.appendNote(note, 'original-evidence');
  book.appendNote(
    { ...note, topicId: 'other', title: 'Other', text: 'UNRELATED_DUMP'.repeat(3000) },
    'unrelated',
  );
  book.put('actual-delivery', 'delivery', {
    text: '之前已发送的展览信息',
    topicIds: [note.topicId],
  });
  book.recordFeedback({ id: 'stop', text: '这方向不用再提醒', replyTo: 'actual-delivery' });
  book.resolveFeedback(
    {
      feedbackId: 'stop',
      understanding: '关闭提醒',
      rules: [
        { quote: '不用再提醒', status: 'closed', reason: '用户决定', tags: ['摄影'], topicIds: [] },
      ],
    },
    'close',
  );
  book.close();
  const discovery = new Set<string>(),
    judgement = new Set<string>();
  let notes = 0;
  try {
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      const seed = await readFile(view(prompt), 'utf8');
      assert.ok(seed.length < 10000);
      assert.doesNotMatch(seed, /UNRELATED_DUMP|用户曾关注摄影展/);
      assert.match(prompt, /你是用户/);
      assert.match(prompt, /干净的工作上下文/);
      assert.equal(
        f.workers.get(id).transcript.length,
        1,
        'no previous cycle in working transcript',
      );
      const topic = await invoke('DiscoveryNotebook', { view: 'topic', topicId: note.topicId });
      assert.equal(topic.nextOffset, null);
      const material = JSON.parse(topic.text);
      assert.equal(material.topic.status, 'closed');
      assert.match(topic.text, /用户曾关注摄影展|actual-delivery|这方向不用再提醒/);
      assert.doesNotMatch(topic.text, /UNRELATED_DUMP/);
      if (prompt.includes('Phase: discovery')) {
        discovery.add(id);
        await output(prompt, {
          notes: [
            {
              ...note,
              topicId: `new-${notes}`,
              title: `New ${notes++}`,
              text: '新调查保存为独立认识',
            },
          ],
        });
      } else {
        judgement.add(id);
        await output(prompt);
      }
    });
    for (let i = 0; i < 30; i++) {
      await check(f);
      if (i === 14) await f.restart();
    }
    assert.equal(discovery.size, 30);
    assert.equal(judgement.size, 30);
    const old = [...discovery][0];
    const visible = f
      .filterTools(old, f.tools.resolve(old, []).tools)
      .map((tool: any) => tool.name);
    assert.ok(
      !visible.includes('MemoryIndexWrite'),
      'replaced workers stay restricted after restart',
    );
    await assert.rejects(f.invokeAs(old, 'MemoryIndexWrite', {}));
    await assert.rejects(f.invokeAs(old, 'DiscoveryNotebook', {}));
    f.workers.set('foreign', { status: 'idle', transcript: [] });
    await assert.rejects(f.invokeAs('foreign', 'DiscoveryNotebook', {}));
    const restored = new Notebook(bookPath);
    try {
      assert.equal(restored.events('note').length, 32);
      assert.equal(restored.feedback().length, 1);
      assert.equal(restored.events('delivery').length, 1);
      assert.equal(restored.state(note.topicId).status, 'closed');
    } finally {
      restored.close();
    }
  } finally {
    await f.close();
  }
});

test('failed scoped judgement reuses the same context across restart and delivers once', async () => {
  const f = await scoped();
  const discoveries: string[] = [],
    judges: string[] = [];
  const text = '本次已确认的信息';
  try {
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        const batch = await invoke('InboxCheck', {});
        for (const item of batch.items.filter((item: any) => item.type === 'discovery'))
          await invoke('SendUser', {
            messageId: `sent:${item.id}`,
            messages: [{ text: JSON.parse(item.content), discoveryIds: [item.id] }],
          });
        await invoke('Sleep', {
          notNotified: batch.items
            .filter((item: any) => item.type !== 'discovery')
            .map((item: any) => ({
              inboxId: item.id,
              reason: 'Controlled fixture handles discovery delivery only',
            })),
        });
      } else if (prompt.includes('Phase: discovery')) {
        discoveries.push(id);
        await output(prompt, { notes: [note] });
      } else {
        judges.push(id);
        if (judges.length === 1) throw Error('provider unavailable');
        const topic = await invoke('DiscoveryNotebook', { view: 'topic', topicId: note.topicId });
        assert.match(topic.text, /用户曾关注摄影展/);
        await output(prompt, { messages: [{ text, topicIds: [note.topicId] }] });
      }
    });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(async () => !!(await f.invoke('InitiativeStatus')).lastError);
    const pending = await f.invoke('InitiativeStatus');
    await assert.rejects(
      f.invoke('InitiativeConfigure', { contextMode: 'legacy' }),
      /pending discovery/,
    );
    await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    await f.restart();
    const completed = await check(f);
    assert.equal(discoveries.length, 1);
    assert.deepEqual(judges, [pending.judgementSession, pending.judgementSession]);
    assert.equal(completed.contextWake, undefined);
    assert.equal(completed.intervalMs, 90 * 60000);
    await until(async () => {
      const binding = await f.remote('assistant.binding');
      if (binding.bot?.error || binding.bot?.wakeError) throw Error(JSON.stringify(binding.bot));
      return f.workers.get('owner').transcript.some((message: any) => message.text === text);
    });
    assert.equal(
      f.workers.get('owner').transcript.filter((message: any) => message.text === text).length,
      1,
    );
    await until(async () => (await f.remote('assistant.binding')).bot?.sleeping);
    const rollback = await f.invoke('InitiativeConfigure', { contextMode: 'legacy' });
    assert.equal(rollback.contextMode, 'legacy');
  } finally {
    await f.close();
  }
});

test('scoped actual conversation reads start recent, remain bounded and recover older messages', async () => {
  const f = await scoped();
  try {
    f.workers.get('owner').transcript = Array.from({ length: 40 }, (_, i) => ({
      id: `message-${i}`,
      type: 'user',
      text: `SOURCE_${i}_` + '内容😀'.repeat(1200),
    }));
    let read = false;
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (!read) {
        read = true;
        const first = await invoke('DiscoveryContext', { limit: 2, maxCharacters: 1000 });
        assert.equal(first.nextOffset, 2);
        assert.ok(first.text.length <= 1000);
        let text = first.text,
          offset = first.nextTextOffset;
        while (offset !== null) {
          const page = await invoke('DiscoveryContext', {
            limit: 2,
            maxCharacters: 1000,
            textOffset: offset,
            revision: first.contextRevision,
          });
          assert.ok(page.text.length <= 1000);
          text += page.text;
          offset = page.nextTextOffset;
        }
        const current = JSON.parse(text);
        assert.deepEqual(
          current.messages.map((message: any) => message.id),
          ['message-38', 'message-39'],
        );
        assert.equal(current.messages[1].text, f.workers.get('owner').transcript[39].text);
        const older = await invoke('DiscoveryContext', { offset: 38, limit: 2 });
        assert.equal(older.nextOffset, null);
        assert.match(older.text, /message-0/);
        f.workers.get('owner').transcript[39].text += 'new evidence';
        await assert.rejects(
          invoke('DiscoveryContext', {
            limit: 2,
            textOffset: first.nextTextOffset,
            revision: first.contextRevision,
          }),
          /Context changed/,
        );
        await assert.rejects(
          invoke('DiscoveryNotebook', { view: 'event', eventId: 'missing' }),
          /Unknown notebook event/,
        );
      }
      await output(prompt);
    });
    await check(f);
    assert.equal(read, true);
  } finally {
    await f.close();
  }
});

test('quick discovery rotates successful scoped contexts and pins failed wakes through a parent mode change', async () => {
  const f = await scoped();
  const ids: string[] = [];
  let fail = false;
  try {
    f.setRunner(async ({ id, prompt, invoke }: any) => {
      assert.match(prompt, /本次检查时间范围/);
      ids.push(id);
      assert.match(prompt, /干净的工作上下文/);
      const page = await invoke('QuickDiscoveryNotebook', { limit: 1000 });
      assert.ok(page.text.length <= 1000);
      assert.equal(page.view, 'catalog');
      if (fail) throw Error('quick provider unavailable');
    });
    const run = async (error = false) => {
      const before = ids.length;
      await f.remote('assistant.quick-discovery', { action: 'check' });
      await until(async () => {
        const status = await f.remote('assistant.quick-discovery-status');
        return (
          ids.length > before && !status.active && (error ? !!status.pending : !status.pending)
        );
      });
      return f.remote('assistant.quick-discovery-status');
    };
    await run();
    await run();
    assert.notEqual(ids[0], ids[1]);
    fail = true;
    const pending = await run(true);
    await f.invoke('InitiativeConfigure', { contextMode: 'legacy' });
    await f.restart();
    fail = false;
    const completed = await run();
    assert.equal(ids[2], ids[3]);
    assert.equal(completed.checkedThrough, pending.pending.to);
    assert.equal(completed.contextWake, undefined);
    const old = ids[0];
    const visible = f
      .filterTools(old, f.tools.resolve(old, []).tools)
      .map((tool: any) => tool.name);
    assert.ok(!visible.includes('MatterDelegate'));
    await assert.rejects(
      f.invokeAs(old, 'QuickDiscoveryReport', { key: 'stale', messages: ['not allowed'] }),
      /active quick|unavailable/,
    );
    await assert.rejects(
      f.invokeAs(old, 'QuickDiscoveryNotebook', {}),
      /Not the quick|unavailable/,
    );
  } finally {
    await f.close();
  }
});

test('scoped task reads use a compact directory and retrieve only an owned task by ID', async () => {
  const f = await scoped();
  try {
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        const batch = await invoke('InboxCheck', {});
        await invoke('Sleep', {
          notNotified: batch.items.map((item: any) => ({
            inboxId: item.id,
            reason: 'Controlled task-read fixture',
          })),
        });
      }
    });
    const task = await f.invoke('MatterDelegate', {
      taskKey: 'owned',
      title: 'Owned task',
      request: 'OWNED_TASK_BODY'.repeat(500),
    });
    await f.invoke('MatterTaskControl', { id: task.id, action: 'pause' });
    f.workers.set('other-owner', { status: 'idle', transcript: [] });
    await f.remote('matters.authorize-session', { sessionId: 'other-owner' });
    const other = await f.invokeAs('other-owner', 'MatterDelegate', {
      taskKey: 'private',
      title: 'Other owner',
      request: 'FOREIGN_TASK_BODY',
    });
    await f.invokeAs('other-owner', 'MatterTaskControl', { id: other.id, action: 'pause' });
    let read = false;
    f.setRunner(async ({ prompt, invoke }: any) => {
      if (prompt.startsWith('Inbox 有新消息')) {
        const batch = await invoke('InboxCheck', {});
        await invoke('Sleep', {
          notNotified: batch.items.map((item: any) => ({
            inboxId: item.id,
            reason: 'Controlled task-read fixture',
          })),
        });
        return;
      }
      if (!read) {
        read = true;
        const directory = await invoke('DiscoveryContext', {});
        assert.equal(directory.nextTextOffset, null);
        assert.match(directory.text, /Owned task/);
        assert.doesNotMatch(directory.text, /OWNED_TASK_BODY|FOREIGN_TASK_BODY/);
        let text = '',
          textOffset = 0,
          revision: string | undefined;
        for (;;) {
          const page = await invoke('DiscoveryContext', { taskId: task.id, textOffset, revision });
          text += page.text;
          revision = page.contextRevision;
          if (page.nextTextOffset === null) break;
          textOffset = page.nextTextOffset;
        }
        assert.equal(JSON.parse(text).tasks.request, 'OWNED_TASK_BODY'.repeat(500));
        await assert.rejects(
          invoke('DiscoveryContext', { taskId: other.id }),
          /outside this conversation/,
        );
      }
      await output(prompt);
    });
    await check(f);
    assert.equal(read, true);
  } finally {
    await f.close();
  }
});

test('mode changes preserve the saved deadline and cannot race a busy legacy admission', async () => {
  const f = await fixture();
  try {
    await f.remote('assistant.bind', { sessionId: 'owner' });
    await f.invoke('InitiativeConfigure', { intervalMinutes: 90 });
    f.workers.set('busy-legacy', { status: 'running', labels: ['assistant-discovery:owner'] });
    await f.invoke('InitiativeControl', { action: 'check' });
    await until(
      async () => (await f.invoke('InitiativeStatus')).discoverySession === 'busy-legacy',
    );
    assert.equal((await f.invoke('InitiativeStatus')).active, null);
    await assert.rejects(
      f.invoke('InitiativeConfigure', { contextMode: 'scoped' }),
      /pending discovery/,
    );
    f.setRunner(async ({ prompt }: any) => {
      await output(prompt);
    });
    f.workers.get('busy-legacy').status = 'idle';
    const before = await check(f);
    const after = await f.invoke('InitiativeConfigure', { contextMode: 'scoped' });
    assert.equal(after.nextAt, before.nextAt);
    assert.equal(after.intervalMs, before.intervalMs);
    assert.equal(after.enabled, before.enabled);
  } finally {
    await f.close();
  }
});
