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

import { useMemo, useState } from 'react';
import { ComposerPromptSuggestionProvider, ToastProvider, LocaleProvider, AstryxLocaleProvider, ChatSurfaceLayout, useToast } from '@maka/ui';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { StoredMessage, SessionSummary } from '@maka/core/session';
import type { WorkHubTask, WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
import { WorkHubRoot, WorkHubServicesProvider, WorkHubMainNavigation, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../src/renderer/features/workhub/index.js';
import { WorkbarServicesProvider, WorkbarShellRoot, WorkbarProvider, WorkbarHost, WorkbarTitlebarActions } from '../src/renderer/features/workbar/index.js';
import { createFakeWorkbarServices } from '../src/renderer/features/workbar/testing.js';
import { WorkHubEnablementProvider } from '../src/renderer/application/contracts/workhub-workspace/workhub-enablement.js';
import { SettingsNavigationProvider } from '../src/renderer/application/contracts/settings-presentation/settings-navigation.js';
import { appShellFrameStyle } from '../src/renderer/shell/frame-style.js';
import { WorkHubConversation, WorkHubHighlightContext } from '../src/renderer/features/workhub/testing.js';
import { desktopSessionKey } from '../src/shared/runtime-host-identity.js';
import type { WorkHubPresentationSnapshot, WorkHubMainNavigation as MainNavigation } from '../src/shared/workhub-presentation.js';

// Real host: a persistent WebContentsView mounts WorkHubRoot once and moves between windows.
const sessionId = desktopSessionKey({ hostId: 'story-host', sessionId: 'maka_workhub_coordination' });
const targetId = desktopSessionKey({ hostId: 'story-host', sessionId: 'payments' });
const writes = { panel: fn(), answer: fn(), model: fn(), defaults: fn(), permissions: fn(), concurrency: fn(), upload: fn(), open: fn(), question: fn(), form: fn(), taskAnswer: fn(), taskContinue: fn(), taskInput: fn() };
const overviewHostListeners = new Set<Parameters<WorkHubServices['subscribeHosts']>[0]>();
const overviewReadRecovery = new Set<() => void>();
const choices = ['model-a', 'model-b'].map((model, index) => ({
  connectionId: 'connection-test', connectionSlug: 'test', connectionName: 'Test', providerType: 'openai' as const,
  providerLabel: 'OpenAI', model, label: model, contextWindow: 100_000, isDefault: index === 0, thinkingLevels: ['low', 'high'] as ThinkingLevel[],
}));
const repairChoices = [
  ['coding-plan', 'Coding Plan', 'qwen3.8-32b', 'Qwen 3.8 32B'],
  ['deepseek', 'DeepSeek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['anthropic', 'Anthropic', 'claude-sonnet-4.5', 'Claude Sonnet 4.5'],
  ['openai', 'OpenAI', 'gpt-5.4', 'GPT-5.4'],
  ['google', 'Google', 'gemini-3-pro', 'Gemini 3 Pro'],
  ['moonshot', 'Moonshot', 'kimi-k2.5', 'Kimi K2.5'],
].map(([connectionSlug, connectionName, model, label], index) => ({
  connectionId: `connection-${connectionSlug}`, connectionSlug, connectionName,
  providerType: 'openai' as const, providerLabel: connectionName, model, label,
  contextWindow: 100_000, isDefault: index === 0, thinkingLevels: [] as ThinkingLevel[],
}));
function makeServices(failFirst: boolean, withHistory: boolean | 'usage', coloredHistory: boolean, selectTarget = false, question = false, progress = false, repairModel = false, suggestions = false, taskInbox = false, taskOverview = false): WorkHubServices {
  let failures = failFirst ? 1 : 0;
  let session: SessionSummary & { revision: number } = {
    id: sessionId, name: 'WorkHub', revision: 1, isFlagged: false, isArchived: false, labels: [], hasUnread: false,
    status: 'active', runningTurnIds: [], backend: 'ai-sdk', llmConnectionId: 'connection-test', llmConnectionSlug: 'test', connectionLocked: false,
    model: 'model-a', permissionMode: 'bypass',
  };
  const target = { ...session, id: targetId, name: '支付回调幂等性', cwd: '/projects/maka' };
  let messages: StoredMessage[] = withHistory ? [
    { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: '继续支付回调幂等性，补充重复投递测试点。' },
    { type: 'assistant', id: 'answer-1', turnId: 'turn-1', ts: 2, modelId: 'model-a', text: withHistory === 'usage' ? '已补充重复投递测试：同一支付回调多次到达时，只记录一次支付结果，并返回一致的响应。\n\n接下来会核对并发回调的处理结果。' : '已将任务交给支付回调工作。完整说明保留在工作台。\n\n' + '重复请求需要保持同一响应。'.repeat(70) + '\n\nEND_OF_FULL_RESPONSE' },
    { type: 'workhub_coordination', kind: 'delegation_assigned', id: 'link-1', turnId: 'turn-1', coordinationTurnId: 'turn-1', ts: 3, schemaVersion: 1, actionId: 'action-1', actionFingerprint: `sha256:${'0'.repeat(64)}`, disposition: 'delegate_existing', userText: '继续支付回调幂等性，补充重复投递测试点。', targetSessionId: targetId, targetSessionName: target.name, targetTurnId: 'target-turn', targetMessageId: 'target-message', delegationId: 'delegation-1' },
  ] : [];
  const secondTarget = { ...target, id: desktopSessionKey({ hostId: 'story-host', sessionId: 'release' }), name: '发布检查清单', cwd: '/projects/desktop' };
  // These are external Host responses, not a story-owned task classifier.
  let tasks: WorkHubTask[] = taskOverview ? [
    { actionId: 'overview-user', delegationId: 'overview-user-delegation', targetSessionId: targetId, targetSessionName: target.name, targetMessageId: 'overview-user-message', text: '确认首批发布范围', createdAt: 7, status: 'waiting_for_user', execution: { turnId: 'task-turn', runId: 'task-run', sharedTurn: false } },
    { actionId: 'overview-running', delegationId: 'overview-running-delegation', targetSessionId: secondTarget.id, targetSessionName: secondTarget.name, targetMessageId: 'overview-running-message', text: '核对打包依赖', createdAt: 6, status: 'running', execution: { turnId: 'running-turn', runId: 'running-run', sharedTurn: false } },
    { actionId: 'overview-evidence', delegationId: 'overview-evidence-delegation', targetSessionId: targetId, targetSessionName: '研究证据', targetMessageId: 'overview-evidence-message', text: '比对回调规范', createdAt: 5, status: 'waiting_for_dependency', execution: { turnId: 'evidence-tip-turn', runId: 'evidence-tip-run', sharedTurn: false }, dependency: { requestId: 'evidence-request', question: '需要发布检查中的协议版本证据', sourceActionId: 'overview-running' } },
    { actionId: 'overview-resource', delegationId: 'overview-resource-delegation', targetSessionId: secondTarget.id, targetSessionName: '并行检查', targetMessageId: 'overview-resource-message', text: '执行并发回归', createdAt: 4, status: 'waiting_resource', waitReason: 'concurrency', execution: { turnId: 'resource-turn', runId: 'resource-run', sharedTurn: false } },
    { actionId: 'overview-done', delegationId: 'overview-done-delegation', targetSessionId: secondTarget.id, targetSessionName: target.name, targetMessageId: 'overview-done-message', text: '补充重复投递用例', createdAt: 3, status: 'pending_acceptance', execution: { turnId: 'done-turn', runId: 'done-run', sharedTurn: false } },
    { actionId: 'overview-failed', delegationId: 'overview-failed-delegation', targetSessionId: targetId, targetSessionName: '文档整理', targetMessageId: 'overview-failed-message', text: '整理联调记录', createdAt: 2, status: 'failed', failure: '供应商连接中断；没有验证产物', execution: { turnId: 'failed-turn', runId: 'failed-run', sharedTurn: false } },
  ] : [];
  const availabilityListeners = new Set<() => void>();
  let disconnectedRead = false;
  const inputReceipts = new Map<string, WorkHubTaskInputResult>();
  if (coloredHistory) {
    const link = messages.find((message) => message.type === 'workhub_coordination' && message.kind === 'delegation_assigned')!;
    messages = [target, secondTarget, target].flatMap((work, index): StoredMessage[] => {
      const turnId = `turn-${index + 1}`;
      return [
        { type: 'user', id: `user-${index}`, turnId, ts: index * 3, text: index === 2 ? '继续补充异常场景。' : `请检查${work.name}。` },
        { type: 'assistant', id: `answer-${index}`, turnId, ts: index * 3 + 1, modelId: 'model-a', text: '任务已交给对应 Work。' },
        { ...link, id: `link-${index}`, turnId, coordinationTurnId: turnId, actionId: `action-${index}`, delegationId: `delegation-${index}`, targetTurnId: `target-turn-${index}`, targetMessageId: `target-message-${index}`, targetSessionId: work.id, targetSessionName: work.name } as StoredMessage,
      ];
    });
    messages.push({ type: 'user', id: 'unlinked', turnId: 'unlinked-turn', ts: 20, text: '先讨论一下整体计划。' });
  }
  const questionRequest: import('@maka/core/events').UserQuestionRequestEvent = {
    type: 'user_question_request', id: 'question-event', ts: 1, turnId: 'question-turn', requestId: 'question-request', toolUseId: 'question-tool',
    questions: [{ question: '首批发布范围选哪个？', options: [{ label: '仅邀请用户' }, { label: '公开测试' }] }],
  };
  if (question) session = { ...session, runningTurnIds: ['question-turn'] };
  if (question) messages = [{ type: 'user', id: 'question-user', turnId: 'question-turn', ts: 1, text: '帮我安排发布。' }, { type: 'turn_state', id: 'question-running', turnId: 'question-turn', ts: 2, status: 'running' }];
  if (taskOverview) messages = [
    { type: 'user', id: 'batch-user', turnId: 'batch-turn', ts: 1, text: '分别处理发布检查、研究证据和重复投递用例。' },
    { type: 'assistant', id: 'batch-receipt', turnId: 'batch-turn', ts: 2, modelId: 'model-a', text: '批量派发完整回执：每个任务都有自己的 actionId、delegationId 和执行记录。' },
    { type: 'turn_state', id: 'batch-done', turnId: 'batch-turn', ts: 3, status: 'completed' },
    ...tasks.filter(task => ['overview-running', 'overview-evidence', 'overview-done'].includes(task.actionId)).map((task): StoredMessage => ({
      type: 'workhub_coordination', kind: 'delegation_assigned', id: `batch-${task.actionId}`, turnId: 'batch-turn', coordinationTurnId: 'batch-turn', ts: 3,
      schemaVersion: 1, actionId: task.actionId, actionFingerprint: `sha256:${'0'.repeat(64)}`, disposition: 'delegate_existing', userText: '分别处理发布检查、研究证据和重复投递用例。',
      targetSessionId: task.targetSessionId, targetSessionName: task.targetSessionName, targetTurnId: task.execution!.turnId, targetMessageId: task.targetMessageId, delegationId: task.delegationId,
    })),
    ...messages,
  ];
  const interactionListeners = new Set<Parameters<WorkHubServices['subscribeActiveInteractions']>[0]>();
  const interactionUpdate = (event: Parameters<Parameters<WorkHubServices['subscribeActiveInteractions']>[0]>[0]) => { for (const listener of interactionListeners) listener(event); };
  let updateTranscript: ((snapshot: WorkHubTranscriptSnapshot) => void) | undefined;
  const sessionListeners = new Set<() => void>();
  const updateSessions = () => { for (const listener of sessionListeners) listener(); };
  let taskRequests: import('@maka/runtime-host/protocol').WorkHubPendingInteraction[] = taskInbox ? [
    { actionId: 'task-question-action', delegationId: 'task-question-delegation', targetSessionName: target.name,
      interaction: { schemaVersion: 1, interactionId: 'task-question', sessionId: targetId, turnId: 'task-turn', runId: 'task-run', revision: 1, status: 'pending', outcome: null,
        request: { kind: 'question', toolUseId: 'task-ask', questions: questionRequest.questions } } },
    { actionId: 'task-form-action', delegationId: 'task-form-delegation', targetSessionName: secondTarget.name,
      interaction: { schemaVersion: 1, interactionId: 'task-form', sessionId: secondTarget.id, turnId: 'form-turn', runId: 'form-run', revision: 1, status: 'pending', outcome: null,
        request: { kind: 'form', toolUseId: 'task-form-tool', message: '补充发布说明', requester: { name: 'Release task' }, fields: [{ kind: 'string', name: 'notes', label: '发布说明', required: true }] } } },
    { actionId: 'task-capability-action', delegationId: 'task-capability-delegation', targetSessionName: secondTarget.name,
      interaction: { schemaVersion: 1, interactionId: 'task-capability', sessionId: secondTarget.id, turnId: 'form-turn', runId: 'form-run', revision: 1, status: 'pending', outcome: null,
        request: { kind: 'client_capability', toolUseId: 'browser', target: { providerId: 'browser-provider', contractId: 'browser-contract', serverId: 'browser-server', toolName: 'navigate', capability: 'browser', scope: { kind: 'browser_origin', origin: 'https://example.com' } } } } },
  ] : [];
  let updateExecution: Parameters<WorkHubServices['observe']>[4];
  let taskGrants: import('@maka/runtime-host/protocol').WorkHubTaskGrant[] = [];
  let questionPending = question;
  let pendingForm: import('@maka/core/events').FormRequestEvent | undefined;
  let newWorkDefaults: Omit<import('@maka/core/session').WorkHubCreateDefaults, 'permissionMode'> = {};
  let newWorkPermissionMode: 'ask' | 'bypass' = 'ask';
  let permissionChanged: (() => void) | undefined;
  let executionConcurrency = 3;
  const publishExecution = () => updateExecution?.({ type: 'host_execution', available: true, rootTurn: pendingForm ? { sessionId, turnId: pendingForm.turnId, runId: 'selection-run', status: 'waiting_for_user' } : questionPending ? { sessionId, turnId: 'question-turn', runId: 'question-run', status: 'waiting_for_user' } : null });
  const publish = () => { publishExecution(); updateTranscript?.({ messages, hasOlder: false, ready: true }); };
  let presentation: WorkHubPresentationSnapshot = { placement: progress ? 'floating' : 'docked', floatingVisible: progress, progressRequest: progress ? 1 : undefined, shortcutRegistered: true, rendererCrashed: false, workbar: { collapsed: true, placement: 'right', togglePosition: 'titlebar' } };
  const presentationListeners = new Set<(snapshot: WorkHubPresentationSnapshot) => void>();
  const navigationListeners = new Set<(navigation: MainNavigation) => void>();
  return {
    inspector: {
      context: async () => ({ ok: true, data: { status: 'available', completedAt: 1, modelId: session.model, providerId: 'openai', inputTokens: 1000, contextWindow: 100_000 } }),
      trace: async () => ({ ok: true, data: { trace: { schemaVersion: 1, sessionId, turns: [], coverage: { modelCalls: 'none', turnsMissingModelCalls: [], unreadableRecords: 0, oversizedRuns: 0, turnsWithFewerModelCallsThanSteps: [] } }, nextCursor: null } }),
      summary: async () => ({ ok: true, data: {
        range: { from: 1, to: 2 }, totalRequests: 1, totalCostUsd: 0.002, totalDurationMs: 3400,
        totalTokens: { input: 1000, output: 120, cacheMiss: 400, cacheRead: 600, cacheWrite: 0, reasoning: 40, total: 1120 },
        cacheHitRequests: 1, cacheCreateRequests: 0, errorRequests: 0,
        provenance: { coverage: { attempts: 1, pricedAttempts: 1, unpricedAttempts: 0, usageReportedAttempts: 1, usagePartialAttempts: 0, usageMissingAttempts: 0 }, legacyRecords: 0, unreadableRecords: 0, pendingRepairs: 0 },
      } }),
      subscribeSessionEvents: () => () => {},
      subscribeUsageChanges: () => () => {},
    },
    retractQueueEntry: async () => {}, promoteQueueEntry: async () => {}, updateQueueEntry: async () => {},
    reorderQueueEntries: async () => {},
    enqueueMessage: async () => 'admitted',
    queryMessageExecutions: async () => ({ resolutions: [] }),
    surface: 'workhub', initialLocale: 'zh-CN', subscribeAppearance: () => () => {},
    presentation: { ready: async () => {}, progressReady: async () => {}, resizeProgress: async () => {}, expandProgress: async () => {}, getSnapshot: async () => presentation, setHost: async () => {}, setConversationLayout: async () => {}, detach: async () => {}, dock: async () => {}, hide: async () => {}, openUsage: async () => { writes.panel('inspector'); }, toggleWorkbar: async () => { writes.panel('toggle'); }, openTasks: async () => { presentation = { ...presentation, taskSelection: undefined }; for (const notify of presentationListeners) notify(presentation); for (const notify of navigationListeners) notify({ kind: 'workhub', panelAction: 'tasks' }); },
      selectTask: async selection => { presentation = { ...presentation, taskSelection: selection }; for (const notify of presentationListeners) notify(presentation); if (presentation.placement === 'docked' && selection.work) for (const notify of navigationListeners) notify({ kind: 'workhub', panelAction: 'tasks' }); },
      openSession: async (id) => { writes.open(id); }, openSettings: async () => {}, subscribe: handler => { presentationListeners.add(handler); return () => { presentationListeners.delete(handler); }; }, onViewportInset: () => () => {}, onFocusComposer: () => () => {}, onOpenMain: handler => { navigationListeners.add(handler); return () => { navigationListeners.delete(handler); }; } },
    control: { getSnapshot: async () => ({ revision: 0, phase: 'idle', canUndo: false }), subscribe: () => () => {}, stop: async () => {}, undo: async () => {} },
    bindBrowserSession: () => {},
    resolve: async () => sessionId, subscribeHosts: listener => { if (taskOverview) overviewHostListeners.add(listener); return () => { overviewHostListeners.delete(listener); }; }, subscribeAvailability: listener => { availabilityListeners.add(listener); return () => { availabilityListeners.delete(listener); }; },
    getSession: async () => session,
    getTaskSession: async id => id === target.id ? target : id === secondTarget.id ? secondTarget : null,
    listSessions: async () => coloredHistory ? [target, secondTarget] : [target], subscribeSessions: (handler) => { sessionListeners.add(handler); return () => { sessionListeners.delete(handler); }; }, modelChoices: async () => repairModel ? repairChoices : choices,
    setDefaultModel: async () => {},
    attachments: { pickFiles: async () => ({ ok: true, files: [{ approvalId: 'file-1', name: 'requirements.txt', size: 12, mimeType: 'text/plain' }] }), previewApproval: async () => ({ ok: false, reason: 'not-image' }) },
    readAttachmentBytes: async () => { throw new Error('Not an image'); },
    prepareAttachments: async (id, items) => { writes.upload(id, items); return [{ name: 'requirements.txt', kind: 'other', mimeType: 'text/plain', bytes: 12, ref: { kind: 'session_file', sessionId: 'maka_workhub_coordination', relativePath: 'artifact-1' } }]; },
    listActiveInteractions: async () => pendingForm ? [pendingForm] : questionPending ? [questionRequest] : [],
    queryTaskInteractions: async () => ({ requests: taskRequests, grants: taskGrants, truncated: false }),
    queryTasks: async () => { if (disconnectedRead) throw new Error('Host disconnected'); return { tasks, truncated: taskOverview }; },
    taskHistory: async (_owner, input) => {
      const task = tasks.find(item => item.actionId === input.workId);
      const link = messages.find(message => message.type === 'workhub_coordination' && message.kind === 'delegation_assigned' && message.actionId === input.workId);
      if (task) return { workId: input.workId, assignments: [
        { ...task, workId: input.workId, generationId: input.workId, state: task.execution ? 'owned' : 'queued', superseded: false },
        ...(task.actionId === 'overview-running' ? [{ ...task, workId: input.workId, generationId: input.workId, actionId: 'overview-initial', delegationId: 'overview-initial-delegation', targetMessageId: 'initial-message', state: 'owned' as const, superseded: false, execution: { turnId: 'initial-turn', runId: 'run-initial-turn' } }] : []),
        ...(task.actionId === 'overview-running' ? [{ ...task, workId: input.workId, generationId: 'older-generation', actionId: 'overview-cold', delegationId: 'overview-cold-delegation', targetSessionId: targetId, targetSessionName: target.name, targetMessageId: 'cold-message', state: 'owned' as const, superseded: true, execution: { turnId: 'cold-turn', runId: 'run-cold-turn' } }] : []),
      ], nextCursor: null };
      if (link?.type !== 'workhub_coordination' || link.kind !== 'delegation_assigned') throw new Error('No canonical task');
      return { workId: input.workId, assignments: [{ workId: input.workId, generationId: input.workId, actionId: link.actionId, delegationId: link.delegationId, targetSessionId: link.targetSessionId, targetSessionName: link.targetSessionName, targetMessageId: link.targetMessageId, text: link.userText, createdAt: link.ts, state: 'owned', superseded: false, execution: { turnId: link.targetTurnId, runId: `run-${link.targetTurnId}` } }], nextCursor: null };
    },
    taskExecutions: async (_owner, input) => {
      if (input.actionId === 'overview-initial') return { actionId: input.actionId, delegationId: input.delegationId, targetSessionId: secondTarget.id, executions: [{ sessionId: secondTarget.id, turnId: 'initial-turn', runId: 'run-initial-turn', status: 'completed', terminalEventId: 'complete-initial-turn' }], nextCursor: null };
      const task = tasks.find(item => item.actionId === input.actionId);
      const link = messages.find(message => message.type === 'workhub_coordination' && message.kind === 'delegation_assigned' && message.actionId === input.actionId);
      const targetSessionId = task?.targetSessionId ?? (link?.type === 'workhub_coordination' && link.kind === 'delegation_assigned' ? link.targetSessionId : undefined);
      const execution = task?.execution ?? (link?.type === 'workhub_coordination' && link.kind === 'delegation_assigned' ? { turnId: link.targetTurnId, runId: `run-${link.targetTurnId}` } : undefined);
      if (!targetSessionId || !execution) throw new Error('No owned execution');
      return { actionId: input.actionId, delegationId: input.delegationId, targetSessionId, executions: [{ sessionId: targetSessionId, turnId: execution.turnId, runId: execution.runId, ...(input.actionId === 'overview-running' ? { status: 'running' as const } : { status: 'completed' as const, terminalEventId: `complete-${execution.turnId}` }) }], nextCursor: null };
    },
    sendTaskInput: async (id, input) => {
      writes.taskInput(id, input);
      const source = tasks.find(task => task.actionId === input.workId && input.generationId === input.workId &&
        (!('sourceActionId' in input) || (task.actionId === input.sourceActionId && task.delegationId === input.sourceDelegationId)));
      if (!source) return { kind: 'rejected', code: 'not_found', message: 'Original task unavailable' };
      const { text: _text, ...identity } = input;
      const receipt: WorkHubTaskInputResult = { ...identity, sourceActionId: source.actionId, sourceDelegationId: source.delegationId, targetSessionId: source.targetSessionId, targetMessageId: 'direct-input-message', acceptedAt: 9, mode: 'steering', delivery: 'queued' };
      inputReceipts.set(input.inputId, receipt); updateSessions();
      return { kind: 'accepted', receipt };
    },
    readTaskInput: async (_id, input) => {
      const receipt = inputReceipts.get(input.inputId);
      if (!receipt || receipt.workId !== input.workId) throw new Error('No input receipt');
      return receipt;
    },
    readTask: async (_id, ref) => {
      const task = tasks.find(task => 'workId' in ref
        ? (task.workId ?? task.actionId) === ref.workId
        : task.actionId === ref.actionId && task.delegationId === ref.delegationId);
      if (!task) throw new Error('Original task unavailable');
      return { task, ...(task.status === 'pending_acceptance' ? { delivery: { text: '报告路径：/projects/maka/report.md\n助手声称测试通过；此处没有独立验证证据。', truncated: false, terminalEventId: 'done-terminal' } } : {}) };
    },
    continueTask: async (id, input) => {
      writes.taskContinue(id, input);
      const task = tasks.find(task => task.actionId === input.actionId && task.delegationId === input.delegationId);
      if (!task) throw new Error('Original task unavailable');
      if (writes.taskContinue.mock.calls.length === 1) {
        disconnectedRead = true;
        overviewReadRecovery.add(() => { disconnectedRead = false; });
        for (const listener of availabilityListeners) listener();
        throw new Error('Lost continuation receipt');
      }
      tasks = [...tasks, { ...task, actionId: 'overview-followup', delegationId: 'overview-followup-delegation', targetMessageId: 'followup-message', text: input.text, createdAt: 8, status: 'queued', execution: undefined }];
      updateSessions();
      return { disposition: 'delegate_existing', targetSessionId: task.targetSessionId };
    },
    revokeTaskGrant: async (_id, input) => {taskGrants = taskGrants.filter((item) => item.grant.grantId !== input.grantId); updateSessions(); return {grantId: input.grantId};},
    answerTaskInteraction: async (id, input) => {
      writes.taskAnswer(id, input);
      const item = taskRequests.find((item) => item.interaction.interactionId === input.interactionId)!;
      const request = item.interaction.request;
      const settle = () => { taskRequests = taskRequests.filter((candidate) => candidate !== item); updateSessions(); };
      if (input.answer.kind === 'question' && request.kind === 'question') {
        settle();
        return { ...item.interaction, revision: 2, status: 'answered', outcome: { kind: 'question_answer', answers: input.answer.answers, committedAt: 1 } };
      }
      if (input.answer.kind === 'form' && request.kind === 'form') {
        const { kind: _kind, ...answer } = input.answer;
        settle();
        return { ...item.interaction, revision: 2, status: 'answered', outcome: { kind: 'form_answer', ...answer, committedAt: 1 } };
      }
      if (input.answer.kind === 'client_capability' && request.kind === 'client_capability') {
        if (input.answer.decision === 'allow' && input.grantScope === 'task') taskGrants.push({actionId: item.actionId, targetSessionName: item.targetSessionName, grant: {
          version: 1, grantId: input.interactionId, delegationId: item.delegationId,
          rootSessionId: item.interaction.sessionId, rootTurnId: item.interaction.turnId, rootRunId: item.interaction.runId,
          sourceSessionId: item.interaction.sessionId, sourceRequestId: item.interaction.interactionId,
          sourceTurnId: item.interaction.turnId, sourceRunId: item.interaction.runId,
          rootBoundaryRevision: 0, sourceBoundaryRevision: 0, grantedAt: Date.now(), expiresAt: Date.now() + 3600000,
          resource: {kind: 'client_capability', target: request.target},
        }});
        settle();
        return { ...item.interaction, revision: 2, status: 'answered', outcome: { kind: 'client_capability_decision', decision: input.answer.decision, committedAt: 1 } };
      }
      throw new Error('No supported original request answer');
    },
    subscribeActiveInteractions: (handler) => { interactionListeners.add(handler); return () => { interactionListeners.delete(handler); }; },
    respondToUserForm: async (id, response) => {
      writes.form(id, response);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      const turnId = pendingForm!.turnId;
      pendingForm = undefined;
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'turn_state', id: `${turnId}-done`, turnId, ts: 6, status: 'completed' }];
      publish();
    },
    respondToUserQuestion: async (id, response) => {
      writes.question(id, response);
      if (failures-- > 0) throw new Error('Temporary Host failure');
      questionPending = false;
      pendingForm = undefined;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'assistant', id: 'question-answer', turnId: 'question-turn', ts: 3, modelId: 'model-a', text: '按公开测试安排发布。' }, { type: 'turn_state', id: 'question-complete', turnId: 'question-turn', ts: 4, status: 'completed' }];
      publish();
    },
    answer: async (id, input) => {
      writes.answer(id, input);
      if (selectTarget || repairModel) {
        pendingForm = { type: 'form_request', id: `form-${input.turnId}`, requestId: `selection-${input.turnId}`, turnId: input.turnId,
          ts: 5, toolUseId: repairModel ? 'repair-target-model' : 'select-and-delegate',
          message: repairModel
            ? '任务“支付回调幂等性”使用的模型“qwen3.8-27b-sglang”已不可用。请选择替代模型以继续。'
            : '选择要继续的工作', requester: { name: 'WorkHub' },
          fields: [repairModel
            ? { kind: 'string', name: 'targetModel', label: '替代模型', required: true, presentation: 'model_picker', minLength: 1 }
            : { kind: 'single_select', name: 'target', label: '工作 / 工作区', required: true,
                options: [{ value: 'candidate-0', label: '支付回调幂等性 / maka' }, { value: 'candidate-1', label: '发布检查清单 / desktop' }] }] };
        messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text }];
        interactionUpdate?.({ sessionId, interactions: [pendingForm] });
        publish(); return { kind: 'admitted', turnId: input.turnId };
      }
      if (failures-- > 0) throw new Error('Temporary Host failure');
      if (suggestions) {
        session = { ...session, runningTurnIds: [input.turnId] }; updateSessions?.();
        // Model transport is mocked; let the real controller observe an in-flight reply.
        await new Promise((resolve) => setTimeout(resolve, 100));
        session = { ...session, runningTurnIds: [] }; updateSessions?.();
      }
      messages = [...messages, { type: 'user', id: input.turnId, turnId: input.turnId, ts: 4, text: input.text, attachments: input.attachments }, { type: 'assistant', id: `${input.turnId}-answer`, turnId: input.turnId, ts: 5, modelId: 'model-a', text: '已收到。' }, { type: 'turn_state', id: `${input.turnId}-done`, turnId: input.turnId, ts: 6, status: 'completed' }];
      publish(); return { kind: 'admitted', turnId: input.turnId };
    },
    configureModel: async (id, input) => {
      writes.model(id, input); session = { ...session, revision: session.revision + 1, model: input.modelTarget.model, thinkingLevel: input.thinkingLevel ?? undefined }; updateSessions?.();
      return { kind: 'committed', session: { ...session, workspace: { target: { kind: 'host_path', path: '/projects/maka' }, hostCwd: '/projects/maka' }, createdAt: 0, activityAt: 0, labelsTruncated: false, llmConnectionId: 'connection-test', collaborationMode: 'agent', orchestrationMode: 'default' } };
    },
    getNewWorkDefaults: async () => newWorkDefaults,
    setNewWorkDefaults: async (id, defaults) => {
      writes.defaults(id, defaults);
      newWorkDefaults = defaults;
    },
    getNewWorkPermissionMode: async () => newWorkPermissionMode,
    setNewWorkPermissionMode: async (id, mode) => { writes.permissions(id, mode); newWorkPermissionMode = mode; permissionChanged?.(); return mode; },
    subscribeNewWorkPermissionMode: (_id, handler) => { permissionChanged = handler; return () => { permissionChanged = undefined; }; },
    getExecutionConcurrency: async () => executionConcurrency,
    setExecutionConcurrency: async (id, value) => { writes.concurrency(id, value); executionConcurrency = value; permissionChanged?.(); return value; },
    observe: (id, _event, _error, phase, execution, scope) => {
      if (id !== sessionId) { phase('ready'); execution?.({ type: 'host_execution', available: true, rootTurn: id === secondTarget.id ? { sessionId: id, turnId: 'running-turn', runId: 'running-run', status: 'running' } : null }); return () => {}; }
      updateExecution = execution; publishExecution(); return () => { updateExecution = undefined; };
    },
    openTranscript: async (id, handler, _signal, _error, scope) => {
      if (id !== sessionId) {
        if (scope) throw new Error('Full Session history must not be execution-filtered');
        const turns = id === secondTarget.id ? ['initial-turn', 'intervening-turn', 'running-turn'] : ['cold-turn'];
        handler({ messages: turns.flatMap((turnId, index): StoredMessage[] => [
          { type: 'user', id: `user-${turnId}`, turnId, ts: index * 5 + 1, text: turnId === 'intervening-turn' ? '同 Session 的其他任务也在这里。' : `${turnId}：核对当前任务，不改变权限和工作目录。` },
          { type: 'tool_call', id: `tool-${turnId}`, turnId, ts: index * 5 + 2, toolName: 'Read', args: { path: '/projects/maka/package.json' } },
          { type: 'tool_result', id: `result-${turnId}`, turnId, ts: index * 5 + 3, toolUseId: `tool-${turnId}`, isError: false, content: { kind: 'text', text: '{ "name": "maka" }' } },
          { type: 'assistant', id: `answer-${turnId}`, turnId, ts: index * 5 + 4, modelId: 'model-a', text: `任务公开输出 ${turnId}：已读取依赖，未更改文件。` },
          ...(turnId === 'running-turn' ? [] : [{ type: 'turn_state' as const, id: `complete-${turnId}`, turnId, ts: index * 5 + 5, status: 'completed' as const }]),
        ]), hasOlder: false, ready: true });
        return { observationChanged: () => {}, loadEarlier: async () => {}, close: async () => {} };
      }
      updateTranscript = handler; publish(); return { observationChanged: () => {}, loadEarlier: async () => {}, close: async () => { updateTranscript = undefined; } };
    },
    stop: async () => {
      questionPending = false;
      pendingForm = undefined;
      session = { ...session, runningTurnIds: [] }; updateSessions?.();
      interactionUpdate?.({ sessionId, interactions: [] });
      messages = [...messages, { type: 'turn_state', id: 'question-abort', turnId: 'question-turn', ts: 4, status: 'aborted' }];
      publish(); return [];
    },

  };
}
function DockedConsole({ services }: { services: WorkHubServices }) {
  const toastApi = useToast();
  const [workbarServices] = useState(() => createFakeWorkbarServices({ inspector: services.inspector,
    taskSelection: { clear: ownerSessionId => services.presentation.selectTask({ ownerSessionId }) },
  }));
  // The real provider owns topology, resizing, tab selection and collapse.
  // Only the Electron native docking rectangle is absent in Storybook.
  return <WorkHubEnablementProvider value={{ isEnabled: () => true, subscribe: () => () => {} }}><SettingsNavigationProvider navigation={{ openSettingsSection() {} }}><WorkbarServicesProvider services={workbarServices}><WorkbarShellRoot>{workbar => <WorkbarProvider bridge={workbar.bridge} input={{
    workHub: { active: true }, available: true, layoutSessionId: sessionId, activeSession: undefined,
    projectId: null, projectAliases: [], authoritativeSessionIds: undefined, shellObscured: false, modelChoices: choices, toastApi,
  }}>
    <div className="appFrame agents-layout-root" data-agents-page data-sidebar-state="collapsed" style={appShellFrameStyle({ sessionListCollapsed: true, sessionListWidth: 0 })}>
    <div className="maka-detail-with-artifacts" style={{ height: '100dvh', '--maka-plate-titlebar-clearance': '40px' } as import('react').CSSProperties}>
      <WorkbarTitlebarActions togglePosition="titlebar" />
      <WorkHubMainNavigation workbarReady={workbar.selectors.ready} onOpenUsage={() => workbar.commands.toggleTool('inspector')}
        onToggleWorkbar={workbar.commands.toggleRightPanel} onOpenWorkHub={() => {}} onOpenSession={id => { void services.presentation.openSession(id); }} />
      {/* Replace only Electron's main-column WebContentsView rectangle. */}
      <div className="mainColumn" style={{ position: 'relative' }}><WorkHubRoot /></div>
      <WorkbarHost togglePosition="titlebar" />
    </div>
    </div>
  </WorkbarProvider>}</WorkbarShellRoot></WorkbarServicesProvider></SettingsNavigationProvider></WorkHubEnablementProvider>;
}
function Surface({ failFirst = false, history = false, colors = false, selectTarget = false, question = false, progress = false, repairModel = false, suggestions = false, taskInbox = false, taskOverview = false, configureServices }: { failFirst?: boolean; history?: boolean | 'usage'; colors?: boolean; selectTarget?: boolean; question?: boolean; progress?: boolean; repairModel?: boolean; suggestions?: boolean; taskInbox?: boolean; taskOverview?: boolean; configureServices?(services: WorkHubServices): void }) {
  const [progressHeight, setProgressHeight] = useState(112);
  const [services] = useState(() => {
    const services = makeServices(failFirst, history, colors, selectTarget, question, progress, repairModel, suggestions, taskInbox, taskOverview);
    configureServices?.(services);
    // Storybook has no BrowserWindow: honor the production renderer's native
    // height request and use the native progress card's 360px width.
    if (progress) services.presentation.resizeProgress = async (_request, height) => { setProgressHeight(height); };
    return services;
  });
  const [suggestionsEnabled, setSuggestionsEnabled] = useState(suggestions);
  const prediction = useMemo(() => suggestions ? {
    enabled: suggestionsEnabled, setEnabled: setSuggestionsEnabled,
    generate: async () => '继续补充并发回调、重复投递和异常恢复的测试，确认所有边界条件都能正确处理，然后整理测试结果。',
  } : undefined, [suggestions, suggestionsEnabled]);
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider><ComposerPromptSuggestionProvider service={prediction}><WorkHubServicesProvider services={services}><div style={{ height: progress ? progressHeight : '100dvh', width: progress ? 360 : undefined, maxWidth: '100%' }}>{progress ? <WorkHubRoot /> : <DockedConsole services={services} />}</div></WorkHubServicesProvider></ComposerPromptSuggestionProvider></ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
const meta = { title: 'Product/WorkHub', parameters: { layout: 'fullscreen' }, beforeEach: () => {
  Object.values(writes).forEach((spy) => spy.mockClear());
  overviewHostListeners.clear();
  overviewReadRecovery.clear();
} } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function openDispatchReceipts(canvasElement: HTMLElement) {
  // Reading an earlier receipt releases tail-following, just as real wheel
  // input does. A bare programmatic scroll does not carry reader intent.
  const scroll = canvasElement.closest('[data-chat-scroll-container]') ?? canvasElement.querySelector('[data-chat-scroll-container]');
  scroll?.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, bubbles: true }));
  for (const receipt of canvasElement.querySelectorAll<HTMLDetailsElement>('.maka-turn-response-details'))
    if (!receipt.open) await userEvent.click(receipt.querySelector('summary')!);
}

// Real path: one WorkHub Turn delegates several works. Their Host-projected
// statuses render together; row clicks select the production task execution pane.
export const DispatchCards: Story = {
  render: () => <Surface history="usage" taskOverview />,
  play: async ({ canvasElement }) => {
    const main = canvasElement.querySelector<HTMLElement>('.mainColumn')!;
    await waitFor(() => expect(main.querySelector('[data-turn-id="batch-turn"]')).not.toBeNull());
    const batch = main.querySelector<HTMLElement>('[data-turn-id="batch-turn"]')!;
    const group = await within(batch).findByRole('region', { name: '已派发任务: 分别处理发布检查、研究证据和重复投递用例。' });
    const rows = group.querySelectorAll<HTMLElement>('.workhub-dispatch-row');
    expect(rows).toHaveLength(3);
    await waitFor(() => expect(rows[0]).toHaveAttribute('data-status', 'running'));
    expect(rows[1]).toHaveAttribute('data-status', 'waiting_for_dependency');
    expect(rows[2]).toHaveAttribute('data-status', 'pending_acceptance');
    expect(rows[2]).toHaveTextContent('执行结束');
    const receipt = batch.querySelector<HTMLDetailsElement>('.maka-turn-response-details')!;
    expect(receipt.open).toBe(false);
    expect(within(receipt).getByText(/批量派发完整回执/)).not.toBeVisible();
    await userEvent.click(receipt.querySelector('summary')!);
    await waitFor(() => expect(within(receipt).getByText(/批量派发完整回执/)).toBeVisible());
    await userEvent.click(receipt.querySelector('summary')!);
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer')).toHaveAccessibleName('发送目标：发布检查清单'));
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(canvasElement).getByRole('button', { name: '收起任务工作栏' }));
    await waitFor(() => expect(canvasElement.querySelector('.maka-session-workbar[data-placement="right"]')).not.toBeVisible());
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(canvasElement.querySelector('.maka-session-workbar[data-placement="right"]')).toBeVisible());
    await userEvent.click(rows[1]!);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer')).toHaveAccessibleName('发送目标：研究证据'));
    expect(rows[0]).toHaveAttribute('aria-pressed', 'false');
    expect(rows[1]).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(rows[0]!);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer')).toHaveAccessibleName('发送目标：发布检查清单'));
    expect(writes.open).not.toHaveBeenCalled();
    expect(writes.answer).not.toHaveBeenCalled();
    expect(writes.taskInput).not.toHaveBeenCalled();
    expect(writes.permissions).not.toHaveBeenCalled();
    expect(writes.concurrency).not.toHaveBeenCalled();
    await userEvent.click(within(canvasElement).getByRole('button', { name: '收起任务工作栏' }));
    for (const row of rows) expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  },
};

export const FullConversationAndWorkIdentity: Story = {
  render: () => <Surface history />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText(/END_OF_FULL_RESPONSE/)).toBeInTheDocument());
    expect(canvasElement.querySelector('.maka-turn-response-details')).not.toHaveAttribute('open');
    await openDispatchReceipts(canvasElement);
    const meta = canvasElement.querySelector<HTMLElement>('.maka-user-message .maka-message-meta')!;
    await waitFor(() => expect(getComputedStyle(meta).opacity).toBe('0'));
    meta.querySelector<HTMLButtonElement>('button[data-message-id]')!.focus();
    await waitFor(() => expect(getComputedStyle(meta).opacity).toBe('1'));
    (document.activeElement as HTMLElement).blur();
    await userEvent.click(canvasElement.querySelector('.workhub-turn-label') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeVisible());
    expect(canvas.getByText(/END_OF_FULL_RESPONSE/)).toBeInTheDocument();
    expect(canvasElement.querySelector('.workHubComposerContent')).toBeVisible();
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.hover(canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelector('.workhub-turn-label')).toHaveAttribute('data-work-highlighted', 'true'));
  },
};
export const FullConversationNarrow: Story = { ...FullConversationAndWorkIdentity, parameters: { viewport: { defaultViewport: 'tablet' } } };
async function openTaskSidebar(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvasElement.querySelector('.maka-session-workbar-toolbar')).not.toBeNull());
  const toggle = canvas.queryByRole('button', { name: '展开任务工作栏' });
  if (toggle) await userEvent.click(toggle);
  if (!canvasElement.querySelector('.workHubTaskPanel')) {
    const workbar = canvasElement.querySelector<HTMLElement>('.maka-session-workbar[data-placement="right"]')!;
    await userEvent.click(await within(workbar).findByText('任务执行', { exact: true }));
  }
}
// Real path: WorkHub → task overview → View task execution. The production
// WorkHubRoot selects a canonical work, then reads its full Session histories.
// Only Host responses are mocked; ChatView and the task-bound Composer are real.
// A coordinator question/form stays pending in its own scope while this task is usable.
export const TaskExecutionView: Story = {
  render: () => <Surface history="usage" taskInbox taskOverview question selectTarget />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const workId of ['overview-running', 'overview-evidence']) sessionStorage.removeItem(JSON.stringify(['workhub-task-input-v1', sessionId, workId]));
    const questionHeading = await canvas.findByRole('heading', { name: '首批发布范围选哪个？' });
    const coordinatorQuestion = questionHeading.closest<HTMLElement>('.maka-user-question-prompt')!;
    await userEvent.click(within(coordinatorQuestion).getAllByRole('option')[1]!);
    await openTaskSidebar(canvasElement);
    const heading = await canvas.findByRole('button', { name: '发布检查清单 执行中' });
    await userEvent.click(within(heading.closest('article')!).getByRole('button', { name: '查看任务执行' }));
    const view = await canvas.findByRole('region', { name: '任务实时执行' });
    await waitFor(() => expect(within(view).getByText(/任务公开输出 running-turn/)).toBeVisible());
    const taskScroll = view.closest<HTMLElement>('[data-chat-scroll-container]')!;
    const taskSessions = view.querySelectorAll<HTMLElement>('[data-task-session-id]');
    // Chromium virtualizes offscreen Turns. Read the previous/current Session
    // sections through their actual scrollport rather than requiring all rows
    // to be mounted at once in a short stacked viewport.
    taskScroll.scrollTo({ top: taskScroll.scrollTop + taskSessions[1]!.getBoundingClientRect().top - taskScroll.getBoundingClientRect().top });
    await waitFor(() => expect(within(view).getByText(/任务公开输出 initial-turn/)).toBeInTheDocument());
    expect(within(view).getByText('同 Session 的其他任务也在这里。')).toBeInTheDocument();
    taskScroll.scrollTo({ top: 0 });
    await waitFor(() => expect(within(view).getByText(/任务公开输出 cold-turn/)).toBeInTheDocument());
    taskScroll.scrollTo({ top: taskScroll.scrollHeight });
    await waitFor(() => expect(within(view).getByText(/任务公开输出 running-turn/)).toBeVisible());
    expect(view.querySelector('.workHubTaskViewHeader')).toBeNull();
    expect(view.querySelector('.workHubTaskAttempts')).toBeNull();
    expect(view.querySelector('.workHubTaskExecutionChoices')).toBeNull();
    expect(view.querySelector('.workHubTaskInstructions')).toBeNull();
    expect(within(view).queryByRole('button', { name: '刷新' })).toBeNull();
    expect(view.querySelectorAll('[data-task-session-id]')).toHaveLength(2);
    expect(within(view).getByTitle(targetId)).toHaveTextContent('Session · payments');
    expect(view.querySelector('[role="status"][data-status]')).toHaveTextContent('执行中');
    const inboxToggle = canvasElement.querySelector('.workHubTaskViewInbox summary')!;
    expect(inboxToggle).toBeVisible();
    await userEvent.click(inboxToggle);
    await waitFor(() => expect(canvas.getByRole('region', { name: '待你处理' })).toBeVisible());
    await userEvent.click(inboxToggle);
    expect(canvasElement.querySelector('.workHubTaskPanels .workHubTaskOverview')).toBeNull();
    expect(within(view).queryByText(/已补充重复投递测试/)).toBeNull();
    const taskComposer = canvasElement.querySelector<HTMLElement>('.workHubTaskComposer')!;
    expect(taskComposer).toBeVisible();
    expect(coordinatorQuestion).toBeVisible();
    expect(within(taskComposer).getByRole('button', { name: '停止' })).toBeVisible();
    expect(taskComposer).toHaveAccessibleName('发送目标：发布检查清单');
    expect(taskComposer.querySelector('.workHubTaskInputTarget')).toBeNull();
    expect(taskComposer.querySelector('.workHubTaskInputHint')).toBeNull();
    expect(canvasElement.querySelector('.workHubCoordinatorHeader')).toBeNull();
    expect(view.querySelector('.workHubTaskViewDescription')).toBeNull();
    expect(within(taskComposer).queryByRole('button', { name: '返回协调输入' })).toBeNull();
    const chooseTask = async (name: string) => {
      await userEvent.click(canvas.getByRole('combobox', { name: '选择任务' }));
      await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('option', { name }));
      await waitFor(() => expect(canvasElement.querySelector('.workHubTaskScreen:not([data-staged]) .workHubTaskComposer')).toHaveAccessibleName(`发送目标：${name}`));
    };
    let editor = taskComposer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await userEvent.click(editor); expect(editor).toHaveFocus();
    await userEvent.type(editor, '只核对协议，不更改权限。');
    await chooseTask('研究证据');
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toHaveAttribute('data-work-id', 'overview-evidence'));
    let otherEditor = canvasElement.querySelector<HTMLElement>('.workHubTaskComposer [contenteditable="true"]')!;
    expect(otherEditor).toHaveTextContent('');
    await userEvent.click(otherEditor); await userEvent.type(otherEditor, 'B 的独立草稿');
    await chooseTask('发布检查清单');
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toHaveAttribute('data-work-id', 'overview-running'));
    const currentComposer = canvasElement.querySelector<HTMLElement>('.workHubTaskComposer')!;
    editor = currentComposer.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await waitFor(() => expect(editor).toHaveTextContent('只核对协议，不更改权限。'));
    await userEvent.click(editor);
    expect(within(currentComposer).getByRole('button', { name: '发送' })).toBeVisible();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.taskInput).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      workId: 'overview-running', generationId: 'overview-running', text: '只核对协议，不更改权限。',
    })));
    expect(writes.taskInput.mock.calls.at(-1)?.[1]).not.toHaveProperty('sourceActionId');
    expect(writes.taskInput.mock.calls.at(-1)?.[1]).not.toHaveProperty('sourceDelegationId');
    await waitFor(() => expect(currentComposer.querySelector('[data-input-delivery="queued"]')).toBeVisible());
    expect(editor).toHaveFocus(); expect(editor).toHaveTextContent('');
    expect(currentComposer.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    const currentView = canvasElement.querySelector<HTMLElement>('.workHubTaskView')!;
    expect(currentView.scrollWidth).toBeLessThanOrEqual(currentView.clientWidth);
    const rail = canvasElement.querySelector<HTMLElement>('.maka-session-workbar[data-placement="right"]')!;
    expect(currentView.closest('.maka-session-workbar-panel')).toHaveAttribute('data-placement', 'right');
    expect(currentView.getBoundingClientRect().left).toBeGreaterThanOrEqual(rail.getBoundingClientRect().left);
    expect(canvasElement.querySelector('.workHubTaskRail')).toBeNull();
    expect(writes.answer).not.toHaveBeenCalled();
    expect(writes.taskContinue).not.toHaveBeenCalled();
    expect(writes.permissions).not.toHaveBeenCalled();
    expect(writes.defaults).not.toHaveBeenCalled();
    expect(writes.question).not.toHaveBeenCalled(); expect(writes.form).not.toHaveBeenCalled();
    expect(canvasElement.querySelector('.maka-user-question-prompt')).toBe(coordinatorQuestion);
    expect(within(coordinatorQuestion).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(coordinatorQuestion).getByRole('button', { name: '提交答案' }));
    await waitFor(() => expect(canvasElement.querySelector('.workHubComposerContent')).toBeVisible());
    const coordinatorEditor = canvasElement.querySelector<HTMLElement>('.workHubComposerContent [contenteditable="true"]')!;
    await userEvent.click(coordinatorEditor); await userEvent.type(coordinatorEditor, '选择后续工作');
    await chooseTask('研究证据');
    otherEditor = canvasElement.querySelector<HTMLElement>('.workHubTaskComposer [contenteditable="true"]')!;
    await waitFor(() => expect(otherEditor).toHaveTextContent('B 的独立草稿'));
    expect(coordinatorEditor).toHaveTextContent('选择后续工作');
    await chooseTask('发布检查清单');
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer [data-input-delivery="queued"]')).toBeVisible());
    await userEvent.click(coordinatorEditor); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-form-interaction-prompt')).toBeVisible());
    const coordinatorForm = canvasElement.querySelector<HTMLElement>('.maka-form-interaction-prompt')!;
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer [data-input-delivery="queued"]')).toBeVisible());
    expect(coordinatorForm).toBeVisible();
    expect(within(canvasElement.querySelector<HTMLElement>('.workHubTaskComposer')!).getByRole('button', { name: '停止' })).toBeVisible();
    const restoredEditor = canvasElement.querySelector<HTMLElement>('.workHubTaskComposer [contenteditable="true"]')!;
    await userEvent.click(restoredEditor); expect(restoredEditor).toHaveFocus(); expect(restoredEditor).toHaveTextContent('');
    expect(writes.taskInput).toHaveBeenCalledTimes(1);
    expect(writes.answer).toHaveBeenCalledTimes(1); expect(writes.question).toHaveBeenCalledTimes(1); expect(writes.form).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole('button', { name: '收起任务工作栏' }));
    await waitFor(() => expect(coordinatorForm).toBeVisible());
    expect(canvasElement.querySelector('.maka-form-interaction-prompt')).toBe(coordinatorForm);
    await openTaskSidebar(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskOverview')).toBeVisible());
    expect(canvasElement.querySelector('.workHubTaskComposer')).toBeNull();
    const reopenedTask = canvas.getByRole('button', { name: '发布检查清单 执行中' });
    await userEvent.click(within(reopenedTask.closest('article')!).getByRole('button', { name: '查看任务执行' }));
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskComposer')).toBeVisible());
  },
};
// Real path: the same task panel and coordination form stack in a narrow dock.
export const TaskExecutionViewNarrow: Story = { ...TaskExecutionView };

let pendingPreviewRead: Promise<void> | undefined;
const previewObservationPhases = new Map<string, Parameters<WorkHubServices['observe']>[3]>();
// Real preview shell, virtual rows and task-bound input; only Host read latency
// is controlled. Every paint must retain a positioned reader during a switch.
export const TaskPreviewSwitchIsAtomic: Story = {
  render: () => <Surface history="usage" taskOverview configureServices={services => {
    pendingPreviewRead = undefined;
    previewObservationPhases.clear();
    const observe = services.observe;
    services.observe = (id, event, error, phase, ...rest) => {
      const unsubscribe = observe(id, event, error, phase, ...rest);
      if (id !== sessionId) previewObservationPhases.set(id, phase);
      return () => { if (previewObservationPhases.get(id) === phase) previewObservationPhases.delete(id); unsubscribe(); };
    };
    const read = services.openTranscript;
    services.openTranscript = async (id, accept, ...rest) => {
      if (id === targetId && pendingPreviewRead) await pendingPreviewRead;
      return read(id, snapshot => accept({ ...snapshot, messages: snapshot.messages.map(message =>
        id !== sessionId && id !== targetId && message.type === 'assistant'
          ? { ...message, text: `${message.text}\n\n${'历史证据用于核对调用顺序和任务结果。'.repeat(24)}` } : message) }), ...rest);
    };
  }} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTaskSidebar(canvasElement);
    const heading = await canvas.findByRole('button', { name: '发布检查清单 执行中' });
    await userEvent.click(within(heading.closest('article')!).getByRole('button', { name: '查看任务执行' }));
    const active = () => canvasElement.querySelector<HTMLElement>('.workHubTaskScreen:not([data-staged])');
    await waitFor(() => expect(active()?.querySelector('.maka-chat-session-swap[data-placed] [data-transcript-turn-id]') ?? null).not.toBeNull());
    const original = active()!;
    const deck = original.parentElement!;
    const scroller = original.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
    await waitFor(() => expect(scroller.scrollHeight - scroller.clientHeight).toBeGreaterThan(200));
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true }));
    scroller.scrollTo({ top: scroller.scrollHeight / 3, behavior: 'instant' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const readers = [...original.querySelectorAll('.agents-chat-view-root')];
    const readingTop = scroller.scrollTop;
    for (const phase of previewObservationPhases.values()) phase('pending');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const [index, reader] of readers.entries()) expect(original.querySelectorAll('.agents-chat-view-root')[index]).toBe(reader);
    for (const phase of previewObservationPhases.values()) phase('ready');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (const [index, reader] of readers.entries()) expect(original.querySelectorAll('.agents-chat-view-root')[index]).toBe(reader);
    expect(Math.abs(scroller.scrollTop - readingTop)).toBeLessThan(2);
    const paints: boolean[] = [];
    let sampling = true, frame = 0;
    const sample = () => {
      paints.push(!!active()?.querySelector('.maka-chat-session-swap[data-placed] [data-transcript-turn-id]'));
      if (sampling) frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const choose = async (name: string) => {
      await userEvent.click(canvas.getByRole('combobox', { name: '选择任务' }));
      await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('option', { name }));
    };
    let release = () => {};
    try {
      pendingPreviewRead = new Promise(resolve => { release = resolve; });
      await choose('研究证据');
      await waitFor(() => expect(deck).toHaveAttribute('aria-busy', 'true'));
      expect(active()).toBe(original);
      expect(original).toHaveAttribute('inert');
      expect(canvasElement.querySelector('.workHubTaskScreen[data-staged]')).toHaveAttribute('inert');
      expect(canvasElement.querySelectorAll('.workHubTaskScreen')).toHaveLength(2);
      // A rapid reversal cancels the staged view. Late Host data must not
      // replace the current preview or re-enable the cancelled input target.
      await choose('发布检查清单');
      await waitFor(() => expect(deck).toHaveAttribute('aria-busy', 'false'));
      release(); pendingPreviewRead = undefined;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      expect(active()).toBe(original);
      await choose('研究证据');
      await waitFor(() => expect(active()?.querySelector('.workHubTaskView')).toHaveAttribute('data-work-id', 'overview-evidence'));
      expect(deck).toHaveAttribute('aria-busy', 'false');
      expect(canvasElement.querySelectorAll('.workHubTaskScreen')).toHaveLength(1);
      const composer = active()!.querySelector<HTMLElement>('.workHubTaskComposer')!;
      expect(composer).toHaveAccessibleName('发送目标：研究证据');
      const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]')!;
      await userEvent.click(editor); await userEvent.type(editor, '只说明证据来源，不改权限。');
      await userEvent.keyboard('{Enter}');
      await waitFor(() => expect(writes.taskInput).toHaveBeenCalledWith(sessionId, expect.objectContaining({ workId: 'overview-evidence', text: '只说明证据来源，不改权限。' })));
      expect(paints.length).toBeGreaterThan(0);
      expect(paints.every(Boolean)).toBe(true);
      expect(writes.answer).not.toHaveBeenCalled();
      expect(writes.permissions).not.toHaveBeenCalled();
      expect(writes.concurrency).not.toHaveBeenCalled();
    } finally {
      sampling = false; cancelAnimationFrame(frame); release(); pendingPreviewRead = undefined;
    }
  },
};
// Real path: Host task facts → WorkHubRoot's inbox/overview/composer; native
// continuation retains unsent drafts across same-Host re-resolution and keeps
// its exact submission after a lost receipt and reconnect.
export const TaskOverviewAndContinuation: Story = {
  render: () => <Surface history="usage" taskInbox taskOverview />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await openTaskSidebar(canvasElement);
    await waitFor(() => expect(canvas.getByRole('region', { name: '近期任务' })).toHaveAttribute('aria-busy', 'false'));
    let overview = canvas.getByRole('region', { name: '近期任务' });
    const inbox = await canvas.findByRole('region', { name: '待你处理' });
    expect(overview).toHaveAttribute('data-maka-assistant-exclude');
    expect(within(overview).getByText('执行结束不代表目标或产物已验证完成。')).toBeVisible();
    expect(within(overview).getByText('等待证据')).toBeInTheDocument();
    expect(within(overview).getByText('等待直接 worker 名额')).toBeInTheDocument();
    expect(within(overview).getByText('供应商连接中断；没有验证产物')).toBeInTheDocument();
    let editor = canvasElement.querySelector('.workHubComposerContent [contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    expect(editor).toHaveFocus();
    const rail = overview.closest<HTMLElement>('.workHubTaskPanel')!;
    expect(rail).toBeVisible();
    expect(rail.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    expect(canvasElement.querySelector('.workHubTaskPanels')).not.toContainElement(overview);
    const main = canvasElement.querySelector<HTMLElement>('.mainColumn')!;
    expect(rail.closest('.maka-session-workbar-panel')).toHaveAttribute('data-placement', 'right');
    expect(main.getBoundingClientRect().right).toBeLessThanOrEqual(rail.getBoundingClientRect().left);
    const float = canvas.getByRole('button', { name: '浮出工作台' }).getBoundingClientRect();
    expect(canvas.getByRole('button', { name: '浮出工作台' }).contains(document.elementFromPoint(float.x + float.width / 2, float.y + float.height / 2))).toBe(true);
    const panels = canvasElement.querySelector('.workHubTaskPanels')!;
    expect(panels.getBoundingClientRect().bottom).toBeLessThanOrEqual(editor.getBoundingClientRect().top);
    expect(editor.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    let done = within(overview).getByRole('button', { name: '支付回调幂等性 执行结束 · 待验收' });
    done.focus(); await userEvent.keyboard('{Enter}');
    let card = done.closest('article')!;
    await waitFor(() => expect(within(card).getByText(/done-turn \/ done-run/)).toBeVisible());
    expect(within(card).getByText('下方路径和测试结论来自助手输出，不是独立核验的产物或测试证据。')).toBeVisible();
    expect(within(card).getByText('报告路径：/projects/maka/report.md', { exact: false }).tagName).toBe('PRE');
    expect(within(card).queryByRole('link', { name: /report.md/ })).toBeNull();
    let instruction = within(card).getByRole('textbox', { name: '给此任务的新指令' });
    await userEvent.type(instruction, '请核验报告，不要改变原会话权限');
    await userEvent.click(within(overview).getByRole('button', { name: '刷新任务' }));
    expect(instruction).toHaveValue('请核验报告，不要改变原会话权限');
    expect(writes.taskContinue).not.toHaveBeenCalled();
    expect(overviewHostListeners.size).toBeGreaterThan(0);
    for (const listener of overviewHostListeners) listener({ hostId: 'story-host', isDefault: true, readiness: 'unavailable' });
    await waitFor(() => expect(overview).toHaveAttribute('aria-busy', 'true'));
    expect(writes.taskContinue).not.toHaveBeenCalled();
    for (const listener of overviewHostListeners) listener({ hostId: 'story-host', isDefault: true, readiness: 'ready' });
    await waitFor(() => expect(canvas.getByRole('region', { name: '近期任务' })).toHaveAttribute('aria-busy', 'false'));
    overview = canvas.getByRole('region', { name: '近期任务' });
    done = within(overview).getByRole('button', { name: '支付回调幂等性 执行结束 · 待验收' });
    await userEvent.click(done);
    card = done.closest('article')!;
    instruction = within(card).getByRole('textbox', { name: '给此任务的新指令' });
    await waitFor(() => expect(instruction).toHaveValue('请核验报告，不要改变原会话权限'));
    expect(writes.taskContinue).not.toHaveBeenCalled();
    expect(instruction).not.toHaveAttribute('readonly');
    editor = canvasElement.querySelector('.workHubComposerContent [contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, '另安排一个独立任务');
    await userEvent.click(within(card).getByRole('button', { name: '发送到此任务' }));
    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('操作尚未确认'));
    expect(instruction).toHaveValue('请核验报告，不要改变原会话权限');
    expect(instruction).toHaveAttribute('readonly');
    expect(within(card).getByRole('button', { name: '重试原续办' })).toBeDisabled();
    // The shell and coordinator are independent readers. Recover the mocked
    // transport explicitly; one reader must not consume the other's failure.
    for (const recover of overviewReadRecovery) recover();
    await userEvent.click(within(overview).getByRole('button', { name: '刷新任务' }));
    await waitFor(() => expect(within(card).getByRole('button', { name: '重试原续办' })).toBeEnabled());
    await userEvent.click(within(card).getByRole('button', { name: '重试原续办' }));
    await waitFor(() => expect(within(card).getByText('续办已进入原任务会话的 FIFO 队列。')).toBeVisible());
    expect(writes.taskContinue.mock.calls).toHaveLength(2);
    expect(writes.taskContinue.mock.calls[1]).toEqual(writes.taskContinue.mock.calls[0]);
    expect(writes.taskContinue.mock.calls[0]).toEqual([sessionId, expect.objectContaining({ actionId: 'overview-done', delegationId: 'overview-done-delegation', text: '请核验报告，不要改变原会话权限' })]);
    expect(writes.taskAnswer).not.toHaveBeenCalled();
    expect(editor).toHaveTextContent('另安排一个独立任务');
    await userEvent.click(within(card).getByRole('button', { name: '打开底层会话' }));
    expect(writes.open).toHaveBeenCalledWith(desktopSessionKey({ hostId: 'story-host', sessionId: 'release' }));
    await userEvent.click(done);
    // Restore the reachable top-of-list view for the visual evidence.
    rail.scrollTo({ top: 0 });
    panels.scrollTo({ top: 0 });
    await userEvent.click(canvas.getByRole('button', { name: '收起任务工作栏' }));
    await waitFor(() => expect(rail).not.toBeVisible());
    await openTaskSidebar(canvasElement);
    await waitFor(() => expect(rail).toBeVisible());
  },
};
// Real path: delegated task roots wait on questions/forms/grants; WorkHub's
// native task inbox and normal composer remain in the same production frame.
export const TaskInbox: Story = {
  render: () => <Surface taskInbox />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inbox = await canvas.findByRole('region', { name: '待你处理' });
    expect(inbox).toHaveAttribute('data-maka-assistant-exclude');
    const editor = canvasElement.querySelector('.workHubComposerContent [contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '再检查文档。');
    expect(editor).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledWith(sessionId, expect.objectContaining({ text: '再检查文档。' })));
    expect(inbox).toBeVisible();
    await userEvent.click(within(inbox).getByRole('button', { name: '支付回调幂等性 · 问题' }));
    expect(editor.closest('[hidden]')).toBeNull();
    expect(within(inbox).queryByRole('button', { name: '停止' })).toBeNull();
    const questionEditor = inbox.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.type(questionEditor, '保留这段回答');
    await userEvent.click(within(inbox).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(questionEditor).toHaveTextContent('保留这段回答'));
    await userEvent.clear(questionEditor);
    await userEvent.click(within(inbox).getByRole('option', { name: '公开测试' }));
    const confirm = within(inbox).getByRole('button', { name: '提交答案' });
    await userEvent.click(confirm);
    await waitFor(() => expect(writes.taskAnswer).toHaveBeenCalledWith(sessionId, {
      actionId: 'task-question-action', interactionId: 'task-question', expectedTurnId: 'task-turn', expectedRunId: 'task-run',
      answer: { kind: 'question', answers: ['公开测试'] },
    }));
    await waitFor(() => expect(within(inbox).queryByRole('button', { name: '支付回调幂等性 · 问题' })).toBeNull());
    await userEvent.click(within(inbox).getByRole('button', { name: '发布检查清单 · 权限' }));
    expect(within(inbox).getByText(/Session 默认权限不变/)).toBeVisible();
    expect(within(inbox).getByRole('button', { name: '允许此任务' })).toBeEnabled();
    expect(within(inbox).getByRole('button', { name: '拒绝请求' })).toBeEnabled();
    const composerBounds = editor.getBoundingClientRect();
    const inboxBounds = inbox.getBoundingClientRect();
    expect(inboxBounds.bottom).toBeLessThanOrEqual(composerBounds.top);
    expect(composerBounds.bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.click(within(inbox).getByRole('button', { name: '允许此任务' }));
    await waitFor(() => expect(writes.taskAnswer).toHaveBeenCalledWith(sessionId, {
      actionId: 'task-capability-action', interactionId: 'task-capability', expectedTurnId: 'form-turn', expectedRunId: 'form-run',
      answer: { kind: 'client_capability', decision: 'allow' }, grantScope: 'task',
    }));
    await waitFor(() => expect(within(inbox).getByText('有效任务授权')).toBeVisible());
    await userEvent.click(within(inbox).getByRole('button', {name: '撤销授权'}));
    await waitFor(() => expect(within(inbox).queryByText('有效任务授权')).toBeNull());
    await userEvent.click(within(inbox).getByRole('button', { name: '发布检查清单 · 表单' }));
    await userEvent.type(within(inbox).getByRole('textbox'), '发布说明已确认');
    await userEvent.click(within(inbox).getByRole('button', { name: '提交' }));
    await waitFor(() => expect(writes.taskAnswer).toHaveBeenCalledWith(sessionId, {
      actionId: 'task-form-action', interactionId: 'task-form', expectedTurnId: 'form-turn', expectedRunId: 'form-run',
      answer: { kind: 'form', action: 'accept', values: { notes: '发布说明已确认' } },
    }));
    await waitFor(() => expect(canvas.queryByRole('region', { name: '待你处理' })).toBeNull());
    await userEvent.click(editor);
    await userEvent.type(editor, '还可以继续输入');
    expect(editor).toHaveFocus();
    expect(editor).toHaveTextContent('还可以继续输入');
  },
};
// Real path: WorkHub composer usage → the same Workbar used by ordinary sessions.
export const UsageInspector: Story = {
  render: () => <Surface history="usage" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/接下来会核对并发回调的处理结果/);
    await openDispatchReceipts(canvasElement);
    const conversation = canvasElement.querySelector('[data-chat-scroll-container]')!;
    const editor = canvasElement.querySelector('[contenteditable="true"]')!;
    await userEvent.click(editor);
    await userEvent.type(editor, '再检查一下并发回调。');
    const trigger = canvas.getByRole('button', { name: '打开用量追踪' });
    await userEvent.click(trigger);
    await waitFor(() => expect(writes.panel).toHaveBeenCalledWith('inspector'));
    expect(canvasElement.querySelector('.maka-session-workbar')).toBeNull();
    expect(canvas.getByText(/接下来会核对并发回调的处理结果/)).toBeVisible();
    expect(conversation.isConnected).toBe(true);
    expect(editor).toHaveTextContent('再检查一下并发回调。');
  },
};
// Real path: the docked WorkHub composer opens its model picker before sending.
export const StandardComposer: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await waitFor(() => expect(canvas.getByRole('button', { name: '打开用量追踪' }).textContent).toContain('1%'));
    const concurrency = canvas.getByRole('combobox', { name: '并发' });
    await waitFor(() => expect(concurrency).toBeEnabled());
    await userEvent.click(concurrency);
    const menu = page.getByRole('listbox');
    expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(menu.getBoundingClientRect().bottom).toBeLessThanOrEqual(concurrency.getBoundingClientRect().top + 1);
    await waitFor(() => expect(page.getByRole('option', { name: '并发 8' })).toBeVisible());
    await userEvent.click(page.getByRole('option', { name: '并发 1' }));
    await waitFor(() => expect(writes.concurrency).toHaveBeenCalledWith(sessionId, 1));
    await waitFor(() => expect(concurrency.textContent).toBe('1'));
    await userEvent.click(canvas.getByRole('button', { name: /切换当前任务模型/ }));
    await userEvent.click(page.getByRole('option', { name: /model-b/ }));
    await waitFor(() => expect(writes.defaults).toHaveBeenCalledWith(sessionId, {
      model: { llmConnectionId: 'connection-test', llmConnectionSlug: 'test', model: 'model-b' },
    }));
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, 'Review requirements'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledWith(sessionId, expect.objectContaining({ text: 'Review requirements', attachments: [expect.objectContaining({ name: 'requirements.txt' })] })));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
  },
};
// Real path: WorkHub → new-task permissions → full access → explicit confirmation.
export const NewTaskPermissionConfirmation: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    const picker = () => canvas.getByRole('button', { name: /新任务权限: 自动/ });
    await waitFor(() => expect(picker()).toBeEnabled());
    await userEvent.click(picker());
    await userEvent.click(page.getByRole('menuitemradio', { name: '完全权限' }));
    const dialog = await page.findByRole('alertdialog');
    await waitFor(() => expect(within(dialog).getByText(/仅适用于新建任务，已有任务保留各自的权限/)).toBeVisible());
    expect(writes.permissions).not.toHaveBeenCalled();
  },
};
// Real path: WorkHub composer → thinking level → choose an override or restore the default.
export const ThinkingLevelPicker: Story = {
  render: () => <Surface />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 默认' })).toBeEnabled());
    const usage = canvas.getByRole('button', { name: '打开用量追踪' });
    await waitFor(() => expect(usage.textContent).toContain('1%'));
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 默认' }));
    await userEvent.click(page.getByRole('option', { name: /^高$/ }));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 高' })).toBeEnabled());
    await expect(writes.defaults).toHaveBeenCalledWith(sessionId, {
      model: { llmConnectionId: 'connection-test', llmConnectionSlug: 'test', model: 'model-a' },
      thinkingLevel: 'high',
    });
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 高' }));
    await userEvent.click(page.getByRole('option', { name: /^默认$/ }));
    await waitFor(() => expect(canvas.getByRole('combobox', { name: '思考级别: 默认' })).toBeEnabled());
    await expect(writes.defaults).toHaveBeenLastCalledWith(sessionId, {
      model: { llmConnectionId: 'connection-test', llmConnectionSlug: 'test', model: 'model-a' },
    });
    await userEvent.click(canvas.getByRole('combobox', { name: '思考级别: 默认' }));
    await expect(page.getByRole('option', { name: /^默认$/ })).toHaveAttribute('aria-selected', 'true');
  },
};
// Real path: a floating WorkHub progress card → edit its composer → open the model picker.
export const ProgressModelPicker: Story = {
  render: () => <Surface progress />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubLive')).toHaveAttribute('data-progress', 'true'));
    const card = canvasElement.querySelector('.workHubProgressCard.maka-progress-card');
    expect(card).toBeVisible();
    expect(card?.querySelector('.maka-progress-card-summary')).toBeVisible();
    expect(canvas.queryByRole('combobox', { name: /思考级别/ })).toBeNull();
    const status = card?.querySelector('[role="status"]');
    expect(status).toBeVisible();
    expect(status?.closest('button')).toBeNull();
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    const assertCompactLineBox = () => {
      expect(editor.closest('.workHubLive')).toHaveAttribute('data-conversation-expanded', 'false');
      const style = getComputedStyle(editor);
      expect(style.paddingTop).toBe('6px');
      expect(style.paddingBottom).toBe('6px');
      // Compact WorkHub has larger padding and initially requests maxRows=1.
      // Even then, its scrolling editor must leave a full line for the caret.
      expect(editor.clientHeight).toBeGreaterThanOrEqual(
        Number.parseFloat(style.lineHeight) + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
      );
    };
    await waitFor(assertCompactLineBox);
    await userEvent.click(editor);
    assertCompactLineBox();
    await userEvent.type(editor, 'Keep this draft readable while choosing a model.');
    const trigger = await canvas.findByRole('button', { name: /切换当前任务模型/ });
    await userEvent.click(trigger);
    const wheel = await canvas.findByRole('listbox');
    await waitFor(() => expect(wheel).toHaveFocus());
    const surface = wheel.closest('.maka-model-wheel-expanded')!;
    const pixels = new OffscreenCanvas(1, 1).getContext('2d')!;
    pixels.fillStyle = getComputedStyle(surface).backgroundColor;
    pixels.fillRect(0, 0, 1, 1);
    expect(pixels.getImageData(0, 0, 1, 1).data[3]).toBeGreaterThanOrEqual(230);
    expect(pixels.getImageData(0, 0, 1, 1).data[3]).toBeLessThan(255);
    expect(editor).toHaveTextContent('Keep this draft readable while choosing a model.');
    await userEvent.keyboard('{Escape}');
    await userEvent.clear(editor);
    await waitFor(() => expect(editor.textContent).toBe(''));
    assertCompactLineBox();
    // Restore this story's named final state: a draft with the model wheel open.
    await userEvent.type(editor, 'Keep this draft readable while choosing a model.');
    await userEvent.click(trigger);
    await waitFor(() => expect(canvas.getByRole('listbox')).toHaveFocus());
  },
};
export const ComposerRetainsFailedAttachment: Story = {
  render: () => <Surface failFirst />,
  play: async ({ canvasElement }) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    const canvas = within(canvasElement); const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(canvas.getByRole('button', { name: /切换当前任务模型/ })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: '添加上下文' }));
    await userEvent.click(page.getByRole('menuitem', { name: /添加文件/ }));
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor); await userEvent.type(editor, 'Review requirements'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    expect(editor).toHaveTextContent('Review requirements');
    expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(1);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledTimes(2));
    expect(writes.upload).toHaveBeenCalledTimes(1);
    expect(writes.answer.mock.calls[0]?.[1].turnId).toBe(writes.answer.mock.calls[1]?.[1].turnId);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-composer-attachment-token')).toHaveLength(0));
  },
};

// Real path: docked WorkHub's prompt rail remains inside the coordinator's
// scrollport when the unified shell workbar uses its titlebar control.
async function expectPromptRailClearance(canvasElement: HTMLElement) {
  await waitFor(() => {
    const rail = canvasElement.querySelector<HTMLElement>('.maka-prompt-rail')!;
    expect(rail).not.toBeNull();
    const ticks = rail.querySelectorAll<HTMLElement>('[data-prompt-turn-id]');
    expect(ticks).toHaveLength(4);
    if (window.innerWidth < 825) {
      expect(rail.closest('.maka-prompt-rail-host')).toHaveStyle({ display: 'none' });
      expect(rail).not.toBeVisible();
      expect(rail.getClientRects()).toHaveLength(0);
    } else {
      expect(rail).toBeVisible();
      const box = rail.getBoundingClientRect();
      const scroller = canvasElement.querySelector('[data-chat-scroll-container]')!.getBoundingClientRect();
      const composer = canvasElement.querySelector('.maka-composer')!.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.right).toBeLessThanOrEqual(scroller.right);
      expect(box.top).toBeGreaterThanOrEqual(scroller.top);
      expect(box.bottom).toBeLessThanOrEqual(composer.top);
      for (const tick of ticks) {
        const hit = tick.getBoundingClientRect();
        expect(tick.contains(document.elementFromPoint(hit.x + hit.width / 2, hit.y + hit.height / 2))).toBe(true);
      }
    }
    const body = canvasElement.querySelector('.workHubHistory')!;
    expect(body.scrollWidth - body.clientWidth).toBeLessThanOrEqual(1);
  });
  // At full desktop width, WorkHub must reach the same shared reading measure
  // as Sessions; applying transcript gutters twice makes this narrower.
  if (window.innerWidth >= 1600) {
    // The rail settles before the virtualized transcript mounts its rows.
    await waitFor(() => expect(canvasElement.querySelector('.maka-turn')).not.toBeNull());
    const turn = canvasElement.querySelector('.maka-turn')!;
    const measure = document.createElement('div');
    measure.style.cssText = 'position: absolute; visibility: hidden; height: 0; width: var(--maka-reading-measure)';
    turn.append(measure);
    const readingWidth = measure.getBoundingClientRect().width;
    measure.remove();
    expect(Math.abs(turn.getBoundingClientRect().width - readingWidth)).toBeLessThanOrEqual(1);
  }
}

// Real path: WorkHub with delegated Turns from two ordinary Sessions and asynchronously read execution feedback.
export const ColoredWorkHistory: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelector('.maka-turn-response-details')).not.toBeNull());
    await openDispatchReceipts(canvasElement);
    const scroll = canvasElement.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
    scroll.scrollTo({ top: scroll.scrollHeight });
    await expectPromptRailClearance(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('[data-turn-accent="true"]')).toHaveLength(3));
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-user-message .workhub-message-rail')).toHaveLength(3));
    const turns = canvasElement.querySelectorAll<HTMLElement>('[data-turn-accent="true"]');
    const stripeColor = (turn: HTMLElement) => getComputedStyle(turn.querySelector('.maka-user-message .workhub-message-rail')!, '::before').backgroundColor;
    expect(stripeColor(turns[0]!)).toBe(stripeColor(turns[2]!));
    expect(stripeColor(turns[0]!)).not.toBe(stripeColor(turns[1]!));
    expect(turns[0]!.querySelector('.workhub-turn-label')).toHaveTextContent('maka / 支付回调幂等性');
    expect(turns[1]!.querySelector('.workhub-turn-label')).toHaveTextContent('desktop / 发布检查清单');
    expect(canvasElement.querySelector('[data-transcript-turn-id="unlinked-turn"]')).not.toHaveAttribute('data-turn-accent');
    for (const turn of turns) {
      expect(turn.querySelectorAll('.workhub-turn-label')).toHaveLength(1);
      expect(turn.querySelector('.maka-assistant-answer .workhub-turn-label')).toBeNull();
      expect(turn.querySelector('.maka-user-message .maka-message-status-time')).toBeNull();
      expect(turn.querySelector('.maka-turn-footer [data-action="copy"]')).not.toBeNull();
      expect(turn.querySelector('.maka-turn-footer [data-action="branch"]')).toBeNull();
      const label = getComputedStyle(turn.querySelector('.workhub-turn-label span')!);
      const time = getComputedStyle(turn.querySelector('.maka-user-message .maka-message-meta')!);
      expect(label.fontSize).toBe(time.fontSize);
      expect(label.color).toBe(time.color);
      const prompt = getComputedStyle(turn.querySelector('.maka-user-message')!);
      const answer = getComputedStyle(turn.querySelector('.maka-assistant-answer')!);
      expect(prompt.borderRightWidth).toBe('4px');
      expect(prompt.borderLeftWidth).toBe('0px');
      expect(answer.borderLeftWidth).toBe('4px');
      expect(answer.borderRightWidth).toBe('0px');
      expect(getComputedStyle(turn).borderLeftWidth).toBe('0px');
      // The icon-button's square aspect must not shrink the full-height hit
      // target. The sender-side bar must also reach the message's outer edge.
      for (const sender of ['user', 'assistant']) {
        const message = turn.querySelector<HTMLElement>(`.maka-${sender === 'user' ? 'user-message' : 'assistant-answer'}`)!;
        const rail = message.querySelector<HTMLElement>('.workhub-message-rail')!;
        const bounds = message.getBoundingClientRect();
        const hit = rail.getBoundingClientRect();
        expect(Math.abs(hit.height - bounds.height)).toBeLessThan(1);
        expect(Math.abs(sender === 'user' ? hit.right - bounds.right : hit.left - bounds.left)).toBeLessThan(1);
      }
    }
    const metadataRights = [...canvasElement.querySelectorAll('.maka-user-message .maka-message-meta')].map((element) => element.getBoundingClientRect().right);
    expect(metadataRights).toHaveLength(4);
    expect(Math.max(...metadataRights) - Math.min(...metadataRights)).toBeLessThan(1);
    scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -scroll.scrollTop, bubbles: true }));
    scroll.scrollTo({ top: 0, behavior: 'instant' });
    const firstLabel = () => canvasElement.querySelector<HTMLElement>('[data-transcript-turn-id="turn-1"] .workhub-turn-label')!;
    await waitFor(() => expect(firstLabel()).toBeVisible());
    const label = firstLabel();
    await userEvent.hover(label);
    await waitFor(() => expect(canvasElement.querySelector('[data-transcript-turn-id="turn-3"] .workhub-turn-label')).toHaveAttribute('data-work-highlighted', 'true'));
    await waitFor(() => expect(canvasElement.querySelector('[data-transcript-turn-id="turn-3"] .maka-user-message .workhub-message-rail')).toHaveAttribute('data-work-highlighted', 'true'));
    await userEvent.click(firstLabel());
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeVisible());
    expect(writes.open).not.toHaveBeenCalled();
    await userEvent.unhover(label);
  },
};

// Real path: WorkHub asks its Host to select_and_delegate; the admitted Turn publishes a pending single-select Form.
export const TargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async ({ canvasElement }) => {
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '继续支付相关的工作，把异常场景补齐。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument());
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
  },
};

// Real path: a selected target's saved model disappeared, so WorkHub asks before changing that Session and delegating.
export const TargetModelRepair: Story = {
  render: () => <Surface repairModel />,
  play: async ({ canvasElement }) => {
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.type(editor, '继续支付回调幂等性，补充重复投递测试点。');
    await userEvent.keyboard('{Enter}');
    const prompt = await within(canvasElement).findByText(/qwen3\.8-27b-sglang.*已不可用/);
    expect(prompt).toBeVisible();
    await userEvent.click(within(canvasElement).getByRole('button', { name: '替代模型' }));
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByRole('listbox', { name: '替代模型' })).toBeVisible());
    await waitFor(() => expect(page.getByRole('option', { name: /Qwen 3.8 32B/ })).toBeVisible());
  },
};

// Real path: In the same Host Form, confirm a target with digits/Enter, then cancel another request with Escape.
export const KeyboardTargetSelection: Story = {
  render: () => <Surface selectTarget />,
  play: async (context) => {
    Object.values(writes).forEach((spy) => spy.mockClear());
    await TargetSelection.play!(context);
    await userEvent.keyboard('2{Enter}');
    await waitFor(() => expect(writes.form).toHaveBeenCalledWith(sessionId, expect.objectContaining({ action: 'accept', values: { target: 'candidate-1' } })));
    const editor = context.canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
    await userEvent.click(editor); await userEvent.type(editor, '需要进一步说明'); await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument());
    const formPrompt = context.canvasElement.querySelector('.maka-form-interaction-prompt') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(formPrompt.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await waitFor(() => expect(within(formPrompt).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
    expect(writes.form).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ action: 'cancel' }));
    expect(writes.answer).toHaveBeenCalledTimes(2);
  },
};

// Real path: A pending Host Form stays visible with its choice after a transport failure; the same response can be retried.
export const TargetSelectionFailure: Story = {
  render: () => <Surface selectTarget failFirst />,
  play: async (context) => {
    await TargetSelection.play!(context);
    await userEvent.keyboard('1{Enter}');
    await waitFor(() => expect(within(context.canvasElement).getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(context.canvasElement.querySelector('.maka-form-interaction-prompt')).toBeNull());
  },
};

// Real path: WorkHub asks its Host a question; the first response fails on the
// wire, the selection survives, and Enter retries to completion.
export const QuestionLifecycle: Story = {
  render: () => <Surface question failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('heading', { name: '首批发布范围选哪个？' })).toBeInTheDocument());
    expect(canvasElement.querySelector('.maka-turn-processing')).toBeNull();
    // The panel's digit/Enter shortcuts live on its own keydown, so focus must
    // have landed there before keys are sent.
    const prompt = canvasElement.querySelector('.maka-user-question-prompt') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(prompt.querySelector('.maka-choice-panel')));
    await userEvent.keyboard('2{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    await waitFor(() => expect(within(prompt).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeNull());
    expect(canvas.getByText('按公开测试安排发布。')).toBeInTheDocument();
    expect(writes.question).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ requestId: 'question-request' }));
  },
};

// Real path: WorkHub asks its Host a question; the prompt stays in the composer slot until answered or stopped.
export const QuestionPending: Story = {
  render: () => <Surface question />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByRole('heading', { name: '首批发布范围选哪个？' })).toBeInTheDocument());
  },
};

export const QuestionStopped: Story = {
  render: () => <Surface question />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeInTheDocument());
    await userEvent.click(canvas.getByRole('button', { name: '停止' }));
    await waitFor(() => expect(canvasElement.querySelector('.maka-user-question-prompt')).toBeNull());
  },
};

// Real path: WorkHub's assignment rail opens the task beside the unchanged
// coordinator conversation, without opening another native window.
export const FilterWorkConversations: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await expectPromptRailClearance(canvasElement);
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    writes.open.mockClear();
    await userEvent.click(canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeInTheDocument());
    const main = canvasElement.querySelector<HTMLElement>('.mainColumn')!;
    const mainScroll = main.querySelector<HTMLElement>('[data-chat-scroll-container]')!;
    mainScroll.scrollTo({ top: 0 });
    await waitFor(() => expect(within(main).getByText('请检查发布检查清单。')).toBeInTheDocument());
    mainScroll.scrollTo({ top: mainScroll.scrollHeight });
    await waitFor(() => expect(within(main).getByText('先讨论一下整体计划。')).toBeInTheDocument());
    await waitFor(() => expect(canvas.getByText(/任务公开输出/)).toBeInTheDocument());
    expect(writes.open).not.toHaveBeenCalled();
    expect(main.querySelectorAll('[data-prompt-turn-id]')).toHaveLength(4);
    mainScroll.scrollTo({ top: 0 });
    const firstTurn = () => main.querySelector<HTMLElement>('[data-turn-id="turn-1"]')!;
    await waitFor(() => expect(firstTurn()).not.toBeNull());
    await openDispatchReceipts(firstTurn());
    await waitFor(() => expect(firstTurn()?.querySelector('.maka-assistant-answer .workhub-message-rail')).toBeVisible());
    const answerRail = firstTurn().querySelector('.maka-assistant-answer .workhub-message-rail') as HTMLElement;
    answerRail.focus();
    expect(answerRail).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeNull());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    expect(writes.open).not.toHaveBeenCalled();
  },
};

function PagedWorkConversation() {
  const [loaded, setLoaded] = useState(false);
  const [selectedWork, selectWork] = useState<{ sessionId: string; name: string } | undefined>({ sessionId: targetId, name: '支付回调幂等性' });
  const messages: StoredMessage[] = [
    ...(loaded ? [{ type: 'user' as const, id: 'older', turnId: 'older-turn', ts: 1, text: '请检查支付回调幂等性。' }] : []),
    { type: 'user', id: 'latest', turnId: 'latest-turn', ts: 2, text: '继续补充异常场景。' },
    { type: 'user', id: 'discussion', turnId: 'discussion-turn', ts: 3, text: '先讨论一下整体计划。' },
  ];
  return <LocaleProvider locale="zh-CN"><AstryxLocaleProvider><ToastProvider>
    <WorkHubHighlightContext.Provider value={{ sessionId: undefined, highlight: () => {}, selectedWork, selectWork, toggleWork: (work) => selectWork((current) => current?.sessionId === work.sessionId ? undefined : work) }}>
      <ChatSurfaceLayout composer={null}><div className="workhub-surface"><WorkHubConversation messages={messages} onOpenWork={() => {}} onNew={() => {}} scrollBehavior="auto"
        activeSession={{ id: sessionId, name: 'WorkHub', isFlagged: false, isArchived: false, labels: [], hasUnread: false, status: 'active', runningTurnIds: [], backend: 'ai-sdk', llmConnectionId: 'connection-test', llmConnectionSlug: 'test', connectionLocked: false, model: 'model-a', permissionMode: 'ask' }}
        hasEarlierHistory={!loaded} onLoadEarlierHistory={() => setLoaded(true)}
        workLinks={['older-turn', 'latest-turn'].map((coordinationTurnId) => ({ id: coordinationTurnId, coordinationTurnId, targetSessionId: targetId, targetSessionName: '支付回调幂等性' }))} />
      </div></ChatSurfaceLayout>
    </WorkHubHighlightContext.Provider>
  </ToastProvider></AstryxLocaleProvider></LocaleProvider>;
}
export const FilterWorkHistoryPages: Story = {
  render: () => <PagedWorkConversation />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByText('继续补充异常场景。')).toBeInTheDocument());
    expect(canvas.queryByText('请检查支付回调幂等性。')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: '载入更早的记录' }));
    await waitFor(() => expect(canvas.getByText('请检查支付回调幂等性。')).toBeInTheDocument());
    expect(canvas.getByText('先讨论一下整体计划。')).toBeInTheDocument();
    expect(canvas.queryByRole('button', { name: '载入更早的记录' })).toBeNull();
    expect(canvas.queryByRole('button', { name: '显示全部对话' })).toBeNull();
  },
};
export const FilterWorkConversationsNarrow: Story = { ...FilterWorkConversations, parameters: { viewport: { defaultViewport: 'tablet' } } };

export const WorkFilterHoverAndToggle: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    writes.open.mockClear();
    const stripe = () => canvasElement.querySelector('.maka-user-message .workhub-message-rail') as HTMLElement;
    const color = () => getComputedStyle(stripe(), '::before').backgroundColor;
    const original = color();
    const originalWidth = stripe().getBoundingClientRect().width;
    const paint = () => getComputedStyle(stripe(), '::before');
    expect(paint().width).toBe('4px');
    expect(parseFloat(paint().borderTopLeftRadius)).toBeGreaterThan(0);
    await userEvent.hover(stripe());
    await waitFor(() => expect(color()).not.toBe(original));
    await waitFor(() => expect(paint().transform).toBe('matrix(1.5, 0, 0, 1, 0, 0)'));
    expect(getComputedStyle(stripe()).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(stripe().getBoundingClientRect().width).toBe(originalWidth);
    expect(canvasElement.querySelector('.maka-assistant-answer .workhub-message-rail')).toHaveAttribute('data-work-highlighted', 'true');
    await userEvent.unhover(stripe());
    await waitFor(() => expect(color()).toBe(original));
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeInTheDocument());
    await userEvent.click(stripe());
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeNull());
    await waitFor(() => expect(canvasElement.querySelectorAll('.maka-turn[data-turn-id]')).toHaveLength(4));
    expect(writes.open).not.toHaveBeenCalled();
  },
};

export const SendWhileWorkFiltered: Story = {
  render: () => <Surface history colors />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvasElement.querySelector('.workhub-message-rail')).not.toBeNull());
    await userEvent.click(canvasElement.querySelector('.workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeInTheDocument());
    expect(canvasElement.querySelector('.workHubComposerContent')).toBeVisible();
    const task = canvasElement.querySelector('.workHubTaskView');
    const editor = canvasElement.querySelector('.workHubComposerContent [contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.keyboard('FILTERED_SEND_PROBE{Enter}');
    await waitFor(() => expect(canvas.getByText('FILTERED_SEND_PROBE')).toBeInTheDocument());
    await waitFor(() => expect(canvas.getByText('已收到。')).toBeInTheDocument());
    expect(canvasElement.querySelector('.workHubTaskView')).toBe(task);
    expect(canvas.queryByRole('button', { name: '显示全部对话' })).toBeNull();
  },
};

export const RetryWhileWorkFiltered: Story = {
  render: () => <Surface history colors failFirst />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    writes.answer.mockClear();
    await waitFor(() => expect(canvasElement.querySelector('.workhub-message-rail')).not.toBeNull());
    const editor = canvasElement.querySelector('[contenteditable="true"]') as HTMLElement;
    await userEvent.click(editor);
    await userEvent.keyboard('FILTERED_RETRY_PROBE{Enter}');
    await waitFor(() => expect(canvas.getByRole('alert')).toHaveTextContent('Temporary Host failure'));
    await userEvent.click(canvasElement.querySelector('.workhub-message-rail') as HTMLElement);
    await waitFor(() => expect(canvasElement.querySelector('.workHubTaskView')).toBeVisible());
    await userEvent.click(canvas.getByRole('button', { name: /^重试$/ }));
    await waitFor(() => expect(writes.answer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(canvas.getByText('已收到。')).toBeInTheDocument());
    expect(canvas.getByText('FILTERED_RETRY_PROBE', { selector: '.maka-user-message *' })).toBeInTheDocument();
    expect(canvas.queryByRole('button', { name: '显示全部对话' })).toBeNull();
  },
};

// Real path: WorkHub → enable next-prompt suggestions → send a request → completed reply.
// Uses the production WorkHubRoot/controller/Composer; only service transport/model output are mocked.
export const NextPromptSuggestion: Story = {
  render: () => <Surface suggestions />,
  play: async ({ canvasElement }) => {
    const input = await within(canvasElement).findByRole('textbox');
    const suggestion = () => canvasElement.querySelector('.maka-composer-next-prompt') as HTMLElement | null;
    await userEvent.click(input);
    await userEvent.type(input, '请继续检查支付回调。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(suggestion()).not.toBeNull());
    const metrics = (element: Element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const style = getComputedStyle(element);
      return { rects: [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height })),
        font: style.font, letterSpacing: style.letterSpacing, whiteSpace: style.whiteSpace, wordBreak: style.wordBreak };
    };
    expect(getComputedStyle(suggestion()!).pointerEvents).toBe('none');
    await userEvent.click(input);
    expect(input).toHaveTextContent('');
    const offered = metrics(suggestion()!.querySelector('.maka-composer-next-prompt-text')!);
    const text = suggestion()!.textContent;
    expect(input).toHaveTextContent('');
    await userEvent.keyboard('{Tab}');
    await waitFor(() => expect(input).toHaveTextContent(text!));
    expect(metrics(input)).toEqual(offered);
    expect(writes.answer).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(writes.answer).toHaveBeenCalledTimes(2));
    expect(writes.answer.mock.calls[1][1].text).toBe(text);
    await waitFor(() => expect(suggestion()).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    expect(suggestion()).toBeNull();
    await userEvent.type(input, '请总结验证结果。');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(suggestion()).not.toBeNull());
  },
};
