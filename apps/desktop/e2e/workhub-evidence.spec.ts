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

import { createServer } from 'node:http';
import { deferred } from '@maka/core/test-only/async-primitives';
import {
  awaitSendReady,
  COMPOSER_INPUT,
  expect,
  test,
  getWorkHubPage,
  withE2eWindow,
} from './fixtures';

// Electron owns the native tasks capability transport and the task-inbox
// contextBridge response. This journey proves that, after evidence starts a
// fresh worker Turn, its real question can still be answered through WorkHub's
// native Desktop binding (including a replaced renderer). Host-only tests
// cannot detect a stale Electron offer or preload response routing to the old Run.
test('evidence continuation retains a live Desktop question binding after WorkHub reload', async ({}, testInfo) => {
  const producerRelease = deferred<void>();
  const seen: string[] = [];
  const errors: string[] = [];
  const requests: unknown[] = [];
  let sequence = 0;
  let sourceActionId = '';
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body);
      const messages = input.messages.filter(
        (m: { role: string; content: unknown }) =>
          m.role !== 'user' ||
          typeof m.content !== 'string' ||
          !m.content.startsWith('Runtime Host environment for this turn:'),
      );
      const user =
        messages.filter((m: { role: string }) => m.role === 'user').at(-1)?.content ?? '';
      const last = messages.at(-1);
      const toolName = (message: { name?: string; tool_call_id?: string }) =>
        message.name ??
        messages
          .flatMap(
            (m: { tool_calls?: { id: string; function: { name: string } }[] }) =>
              m.tool_calls ?? [],
          )
          .find((call: { id: string }) => call.id === message.tool_call_id)?.function.name;
      requests.push({
        user,
        lastRole: last?.role,
        lastName: last ? toolName(last) : undefined,
        lastContent: String(last?.content).slice(0, 800),
      });
      if (requests.length > 16) requests.shift();
      const hasTool = (name: string) =>
        input.tools?.some((item: { function: { name: string } }) => item.function.name === name);
      const toolResult = (message: { content: string }) => {
        let value = JSON.parse(message.content);
        if (Array.isArray(value)) value = JSON.parse(value.map((item) => item.text ?? '').join(''));
        return value.structuredContent ?? value;
      };
      const tasksName = 'mcp__desktop_workhub__tasks';
      let tool: { name: string; args: unknown } | undefined;
      let content = '';
      if (user === 'Start two independent tasks: EVIDENCE_CONSUMER and EVIDENCE_PRODUCER.') {
        const receipts = messages
          .filter(
            (m: { role: string; name?: string }) => m.role === 'tool' && toolName(m) === tasksName,
          )
          .map(toolResult);
        for (const receipt of receipts) {
          if (receipt.disposition !== 'create_new')
            throw new Error('Native delegation failed: ' + JSON.stringify(receipt));
        }
        if (receipts.length === 2) {
          sourceActionId = receipts[1].actionId;
          content = 'Both tasks accepted; WorkHub remains available.';
        } else if (!hasTool(tasksName)) tool = { name: 'tool_search', args: { query: tasksName } };
        else
          tool = {
            name: tasksName,
            args: {
              request: {
                operation: 'create_new',
                title: receipts.length ? 'Evidence producer' : 'Evidence consumer',
                text: receipts.length ? 'EVIDENCE_PRODUCER' : 'EVIDENCE_CONSUMER',
              },
            },
          };
      } else if (user === 'EVIDENCE_CONSUMER') {
        if (!hasTool('WorkHubEvidence'))
          tool = { name: 'tool_search', args: { query: 'WorkHubEvidence' } };
        else {
          seen.push('wait');
          tool = {
            name: 'WorkHubEvidence',
            args: { operation: 'request', question: 'Which checksum did the producer verify?' },
          };
        }
      } else if (user === 'EVIDENCE_PRODUCER') {
        seen.push('producer');
        await producerRelease.promise;
        content = 'Verified checksum abc123; source result, not authorization.';
      } else if (user.startsWith('Host notification:') && user.includes('waiting_for_dependency')) {
        const notification = JSON.parse(user.split('\n\n').at(-1));
        if (last?.role === 'tool' && toolName(last) === 'WorkHubEvidence') {
          seen.push('routed');
          content = 'Evidence is routed; I can take unrelated user input.';
        } else {
          if (!sourceActionId) throw new Error('Missing native source receipt');
          tool = {
            name: 'WorkHubEvidence',
            args: {
              operation: 'resolve',
              requesterActionId: notification.actionId,
              requestId: notification.details.requestId,
              sourceActionId,
            },
          };
        }
      } else if (user.startsWith('Host evidence response:')) {
        if (!user.includes('abc123') || !user.includes('sourceMessageId'))
          throw new Error('Missing bounded source provenance');
        if (last?.role === 'tool' && toolName(last) === 'AskUserQuestion') {
          if (!last.content.includes('Use checksum'))
            throw new Error('Missing actual human answer');
          seen.push('finished');
          content = 'Consumer finished using abc123 after the explicit human answer.';
        } else {
          seen.push('resumed');
          tool = {
            name: 'AskUserQuestion',
            args: {
              questions: [
                {
                  question: 'Confirm using checksum abc123?',
                  options: [{ label: 'Use checksum' }, { label: 'Do not use' }],
                },
              ],
            },
          };
        }
      } else content = 'WorkHub can handle unrelated input without waiting.';
      const chunk = (delta: unknown, finish: string | null) =>
        'data: ' +
        JSON.stringify({
          id: 'e2e-evidence-' + sequence,
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        '\n\n';
      sequence++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        chunk(
          tool
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-' + sequence,
                    type: 'function',
                    function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                  },
                ],
              }
            : { role: 'assistant', content },
          null,
        ),
      );
      response.write(chunk({}, tool ? 'tool_calls' : 'stop'));
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      errors.push(String(error));
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('No local model port');
  try {
    await withE2eWindow(
      {
        seed: true,
        readinessSelector: COMPOSER_INPUT,
        locale: 'en',
        testInfo,
        productionModel: {
          baseUrl: 'http://127.0.0.1:' + address.port + '/v1',
          modelId: 'fake-model',
        },
      },
      async (page, { app }) => {
        await page.evaluate(() =>
          window.maka.settings.updateClient({ workHub: { enabled: true } }),
        );
        const hub = await getWorkHubPage(app);
        const send = async (text: string) => {
          await hub.locator(COMPOSER_INPUT).fill(text);
          await awaitSendReady(hub);
          await hub.locator(COMPOSER_INPUT).press('Enter');
        };
        await send('Start two independent tasks: EVIDENCE_CONSUMER and EVIDENCE_PRODUCER.');
        await expect
          .poll(() => ({ routed: seen.includes('routed'), errors }))
          .toEqual({ routed: true, errors: [] });
        expect(seen).toContain('producer');
        await send('Can I send an unrelated request now?');
        await expect(
          hub
            .locator('article')
            .filter({ hasText: 'WorkHub can handle unrelated input without waiting.' })
            .last(),
        ).toBeVisible();
        producerRelease.resolve();
        const inbox = hub.locator('.workHubTaskInbox');
        await expect(inbox.locator('.workHubTaskInboxExpand')).toBeVisible();
        await inbox.locator('.workHubTaskInboxExpand').click();
        await expect(
          inbox.getByRole('option', { name: 'Use checksum', exact: true }),
        ).toBeVisible();
        // This is a replacement renderer talking to the same native capability
        // transport and to a new (not the original delegation's) hosted Turn.
        await hub.reload();
        await expect(inbox.locator('.workHubTaskInboxExpand')).toBeVisible();
        await inbox.locator('.workHubTaskInboxExpand').click();
        await inbox.getByRole('option', { name: 'Use checksum', exact: true }).click();
        await inbox.getByRole('button', { name: 'Submit answers', exact: true }).click();
        await expect
          .poll(() => ({ finished: seen.filter((value) => value === 'finished').length, errors }))
          .toEqual({ finished: 1, errors: [] });
        expect(seen.filter((value) => value === 'resumed')).toHaveLength(1);
        await expect(inbox).toBeHidden();
      },
    );
  } catch (error) {
    await testInfo.attach('local-model-requests', {
      body: JSON.stringify({ requests, seen, errors }, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    producerRelease.resolve();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
