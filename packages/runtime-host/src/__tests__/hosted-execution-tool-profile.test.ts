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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { buildBuiltinTools } from '@maka/runtime/builtin-tools';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { createBypassExecutionBoundary } from '@maka/core/sandbox-boundary';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import { z } from 'zod';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import { createWorkHubInspectionTool } from '../server/workhub-inspection-tool.js';
import { createWorkHubReadTool } from '../server/workhub-read-tool.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';
import { transcriptReader } from './fixtures/session-transcript-reader.js';
import {
  hostedExecutionRunProfile,
  projectHostedExecutionTools,
} from '../server/hosted-execution-tool-profile.js';

test('hosted execution tool profiles are durable Session creation inputs', () => {
  const decoded = decodeHostedExecutionStartInput({
    executionId: '00000000-0000-4000-8000-000000000001',
    session: {
      workspace: { kind: 'host_path', path: '/workspace' },
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'provider',
        model: 'model',
      },
      toolProfile: 'headless-coding-v1',
    },
    content: { text: 'solve' },
  });
  assert.equal(decoded.session.toolProfile, 'headless-coding-v1');
  assert.throws(
    () =>
      decodeHostedExecutionStartInput({
        ...decoded,
        session: { ...decoded.session, toolProfile: 'unknown-profile' },
      }),
    /Invalid Session tool profile/u,
  );
});

test('the headless coding profile freezes prompt, tools, and memory and passes product Bash through', () => {
  const profile = hostedExecutionRunProfile('headless-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Bash',
    'StopBackgroundTask',
    'WriteStdin',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'apply_patch',
  ]);
  assert.equal(profile.memoryExtraction, false);
  assert.equal(
    profile.systemPrompt,
    [
      'Complete the task by acting with the available tools, not by narrating.',
      'Prefer Read, Glob, and Grep for inspection, the available file-editing tool for file changes, and Bash for shell commands and tests.',
      'Verify the result when practical.',
      'Stop when the task is complete.',
    ].join('\n'),
  );

  const original: MakaTool = {
    name: 'Bash',
    description: 'Product Bash',
    parameters: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
      pty: z.boolean().optional(),
    }),
    impl: async () => 'ok',
  };
  const profileTools = projectHostedExecutionTools(
    [
      original,
      ...profile.toolNames
        .filter((name) => name !== 'Bash')
        .map(
          (name): MakaTool => ({
            name,
            description: name,
            parameters: z.object({}),
            impl: async () => 'ok',
          }),
        ),
      {
        name: 'ScheduledTask',
        description: 'Must stay outside the profile ceiling',
        parameters: z.object({}),
        impl: async () => 'scheduled',
      },
    ],
    'headless-coding-v1',
  );
  assert.deepEqual(
    profileTools.map(({ name }) => name),
    profile.toolNames,
  );
  assert.equal(profileTools[0], original);
});

test('the WorkHub coordination profile has conversational authority but zero tools', () => {
  const profile = hostedExecutionRunProfile('workhub-coordination-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, []);
  assert.equal(profile.memoryExtraction, false);
  assert.match(profile.systemPrompt, /conversational coordinator for WorkHub/u);
  assert.match(profile.systemPrompt, /no tools, filesystem authority/u);

  const productTool: MakaTool = {
    name: 'Read',
    description: 'Read files',
    parameters: z.object({}),
    impl: async () => 'not reachable',
  };
  assert.deepEqual(projectHostedExecutionTools([productTool], 'workhub-coordination-v1'), []);
});

test('WorkHub selects tasks directly without a retired pre-routing decision', () => {
  const profile = hostedExecutionRunProfile('workhub-coordination-v2');
  assert.ok(profile);
  assert.match(profile.systemPrompt, /no auxiliary intent\/recall model/u);
  assert.match(profile.systemPrompt, /not natural-language intent/u);
  assert.doesNotMatch(
    profile.systemPrompt,
    /If the Host binds a routing decision|Intent never selects/u,
  );
});

test('WorkHub v2 keeps its attachment and browser tool ceiling visible in direct and Code Mode', async () => {
  const makeTool = (name: string): MakaTool => ({
    name,
    description: name,
    parameters: z.object({}),
    impl: async () => name,
  });
  const control = makeTool('mcp__desktop_workhub__control');
  const tasks = ['find', 'start', 'continue', 'ask', 'stop'].map((name) =>
    makeTool(`mcp__desktop_workhub__${name}`),
  );
  const browserCalls: unknown[] = [];
  const browserNavigate: MakaTool = {
    name: 'mcp__desktop_browser__browser_navigate',
    description: 'Navigate the WorkHub browser',
    parameters: z.object({ url: z.string().url() }),
    impl: async (input) => {
      browserCalls.push(input);
      return `navigated:${input.url}`;
    },
  };
  const browserTools = [
    browserNavigate,
    makeTool('mcp__desktop_browser__browser_snapshot'),
    makeTool('mcp__desktop_browser__browser_click'),
    makeTool('mcp__desktop_browser__browser_type'),
    makeTool('mcp__desktop_browser__browser_wait'),
    makeTool('mcp__desktop_browser__browser_extract'),
  ];
  const reads: unknown[] = [];
  const builtinRead = buildBuiltinTools({
    attachmentResources: {
      async readAttachmentResource(sessionId, artifactId) {
        reads.push({ sessionId, artifactId });
        return { kind: 'text', text: 'attachment contents' };
      },
    },
  }).find(({ name }) => name === 'Read')!;
  const unexpectedRead = async () => assert.fail('Unexpected native read path');
  const tools = [
    makeTool('Bash'),
    builtinRead,
    ...browserTools,
    control,
    ...tasks,
    makeTool('mcp__desktop_workhub__tasks'),
    makeTool('AskUserQuestion'),
    makeTool('WorkHubResult'),
    makeTool('WorkHubEvidence'),
    makeTool('WorkHubInspect'),
    createWorkHubReadTool({
      sessions: {
        readWorkHubAssignment: unexpectedRead,
        readLatestWorkHubAssignment: unexpectedRead,
        readHeaderSnapshot: unexpectedRead,
        readWorkHubTaskFactsPage: unexpectedRead,
      },
      admission: new SessionAdmissionGate(),
      authorize: async (ctx) => {
        assert.equal(ctx.sessionId, WORKHUB_COORDINATION_SESSION_ID);
        return undefined;
      },
      status: unexpectedRead,
      result: unexpectedRead,
      evidence: unexpectedRead,
      catalog: unexpectedRead,
      history: unexpectedRead,
      inspect: createWorkHubInspectionTool({
        listSessions: async () => [
          {
            id: 'inspect-target',
            name: 'Existing work',
            cwd: '/workspace',
            createdAt: 1,
            statusUpdatedAt: 1,
            status: 'active',
            labels: [],
            isArchived: false,
          },
        ],
        reader: transcriptReader([
          {
            type: 'assistant',
            id: 'source-reply',
            turnId: 'source-turn',
            ts: 2,
            text: 'Source reply, not a new task.',
            modelId: 'test',
          },
        ]),
        admission: new SessionAdmissionGate(),
        readExecution: async () => null,
      }).impl,
    }),
  ];
  const projected = projectHostedExecutionTools(tools, 'workhub-coordination-v2');
  assert.deepEqual(
    projected.map(({ name }) => name),
    [
      control.name,
      ...tasks.map(({ name }) => name),
      ...browserTools.map(({ name }) => name),
      'Read',
      'AskUserQuestion',
      'WorkHubRead',
    ],
  );
  const read = projected.find(({ name }) => name === 'Read')!;
  const context = {
    sessionId: 'workhub',
    runId: 'run',
    turnId: 'turn',
    cwd: '/workspace',
    toolCallId: 'read',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  assert.deepEqual(await read.impl({ path: 'maka://runtime/attachments/attachment-1' }, context), {
    kind: 'text',
    text: 'attachment contents',
  });
  assert.deepEqual(reads, [{ sessionId: 'workhub', artifactId: 'attachment-1' }]);
  for (const input of [
    { path: '/etc/passwd' },
    { path: 'maka://runtime/background-tasks/task-1' },
    { path: 'maka://runtime/attachments/a?session=other' },
  ]) {
    assert.throws(() => read.impl(input, context));
  }
  assert.equal(reads.length, 1);
  assert.throws(
    () => projectHostedExecutionTools(tools.slice(0, 4), 'workhub-coordination-v2'),
    /Hosted tool profile is unavailable/,
  );
  assert.equal(hostedExecutionRunProfile('workhub-coordination-v2')?.memoryExtraction, false);
  const prompt = hostedExecutionRunProfile('workhub-coordination-v2')?.systemPrompt ?? '';
  assert.match(prompt, /find searches tasks and eligible manual Sessions one bounded page/u);
  assert.match(prompt, /Use start for a clearly independent execution goal/u);
  assert.match(prompt, /clearly independent execution goal/u);
  assert.match(prompt, /without requiring the user to say create a Session/u);
  assert.match(
    prompt,
    /explicit old-task reference that cannot be resolved requires clarification/u,
  );
  assert.match(prompt, /admit all clear goals before asking about an ambiguous remainder/u);
  assert.match(prompt, /private task workspace, not the selected project/u);
  assert.match(prompt, /known intended directory for coding/u);
  assert.match(prompt, /Ordinary continuation does not replay interrupted tools/u);
  assert.match(prompt, /side-pane preview does not change the target/u);
  assert.match(prompt, /queued input supplements the original admission in place/u);
  assert.match(prompt, /active input uses Steering at the next consumable boundary/u);
  assert.match(prompt, /Unsupported active backends or attachment input are rejected/u);
  assert.match(prompt, /never silently queued for a later Turn/u);
  assert.match(prompt, /Executor providers have no Host-native read bridge/u);
  assert.match(prompt, /fresh executor history recovery is not fully supported/u);
  assert.match(prompt, /approvals stay in the original task interaction interface/u);
  assert.doesNotMatch(
    prompt,
    /WorkHubResult|WorkHubInspect|WorkHubEvidence|ask_question|requesterActionId/u,
  );
  assert.match(prompt, /three pages/u);
  assert.match(prompt, /submit all known targets together, never split calls/u);
  assert.ok(!projected.some((tool) => tool.name === 'mcp__desktop_workhub__tasks'));

  let providerCatalog = '';
  let providerPrompt = '';
  const backend = new AiSdkBackend({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    header: {
      id: WORKHUB_COORDINATION_SESSION_ID,
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      createdAt: 1,
      name: 'WorkHub',
      titleIsManual: true,
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      statusUpdatedAt: 1,
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionSlug: 'test',
      connectionLocked: true,
      model: 'test',
      permissionMode: 'bypass',
      toolProfile: 'workhub-coordination-v2',
      toolMode: 'code_mode',
      schemaVersion: 1,
    },
    connection: {
      slug: 'test',
      providerType: 'openai',
      defaultModel: 'test',
    },
    apiKey: 'test',
    modelId: 'test',
    tools: [...projected],
    maxSteps: 1,
    readExecutionBoundary: async () => createBypassExecutionBoundary(0),
    readPermissionMode: async () => 'bypass',
    modelFactory: () => ({
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doStream: async ({
        tools: modelTools,
        prompt: modelPrompt,
      }: {
        tools?: unknown;
        prompt?: unknown;
      }) => {
        providerCatalog = JSON.stringify(modelTools);
        providerPrompt = JSON.stringify(modelPrompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'exec-1',
                toolName: 'exec',
                input: JSON.stringify({
                  code: `return {
              names: Object.keys(tools).sort(),
              allowed: [
                'Read',
                'WorkHubRead',
                'mcp__desktop_workhub__control',
                'mcp__desktop_browser__browser_navigate',
                'mcp__desktop_browser__browser_snapshot',
                'mcp__desktop_browser__browser_click',
                'mcp__desktop_browser__browser_type',
                'mcp__desktop_browser__browser_wait',
                'mcp__desktop_browser__browser_extract'
              ].map(name =>
                [name in tools, typeof tools[name]]),
              forbidden: ['Bash', 'Write', 'WorkHubResult', 'WorkHubInspect', 'WorkHubEvidence', 'mcp__desktop_workhub__tasks'].map(name =>
                [name in tools, typeof tools[name]]),
              result: await tools.mcp__desktop_browser__browser_navigate({ url: 'https://example.com/' }),
              inspection: (await tools.WorkHubRead({ sessionRef: 'inspect-target', view: 'reply' })).transcript.messages.map(m => [m.messageId, m.text])
            };`,
                }),
              });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
              });
              controller.close();
            },
          }),
        };
      },
    }),
  });
  const events: SessionEvent[] = [];
  try {
    for await (const event of backend.send({
      turnId: 'code-mode-ceiling',
      text: 'Inspect tools',
      context: [],
    })) {
      events.push(event);
    }
  } finally {
    await backend.dispose();
  }
  for (const name of projected.map((tool) => tool.name)) assert.ok(providerPrompt.includes(name));
  assert.doesNotMatch(
    providerPrompt,
    /WorkHubResult|WorkHubInspect|WorkHubEvidence|mcp__desktop_workhub__tasks/u,
  );
  assert.doesNotMatch(providerCatalog, /mcp__desktop_browser__browser_navigate/u);
  assert.doesNotMatch(providerCatalog, /Bash|Write/u);
  assert.deepEqual(browserCalls, [{ url: 'https://example.com/' }]);
  const result = events.find(
    (event) => event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.ok(result?.type === 'tool_result', JSON.stringify(events));
  assert.deepEqual(result.content, {
    kind: 'json',
    value: {
      ok: true,
      value: {
        names: projected.map((tool) => tool.name).sort(),
        allowed: [
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
        ],
        forbidden: [
          [false, 'undefined'],
          [false, 'undefined'],
          [false, 'undefined'],
          [false, 'undefined'],
          [false, 'undefined'],
          [false, 'undefined'],
        ],
        result: 'navigated:https://example.com/',
        inspection: [['source-reply', 'Source reply, not a new task.']],
      },
      toolCalls: [
        { index: 1, name: browserNavigate.name },
        { index: 2, name: 'WorkHubRead' },
      ],
    },
  });
});
