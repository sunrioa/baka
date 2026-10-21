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
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { messageContentDigest } from '@maka/core/events';
import { WORKHUB_EVAL_CASES, workHubEvalCase } from '../workhub-cases.js';
import { checkWorkHubCapture, loadWorkHubCapture } from '../workhub-evidence.js';
import { runWorkHubEvalCli } from '../workhub-cli.js';

type Obj = Record<string, unknown>;
interface Step extends Obj {
  id: string;
  trigger: Obj;
  admission?: Obj;
  consumption?: Obj;
  terminal?: Obj;
}
interface Fixture {
  schemaVersion: number;
  mode: string;
  caseId: string;
  run: Obj;
  environment: Obj;
  bindings: Record<
    string,
    {
      kind?: 'task' | 'session';
      workId?: string;
      generationId?: string;
      sessionId: string;
      title: string;
    }
  >;
  setup: Obj;
  factsBefore: Obj[];
  factsAfter: Obj[];
  retiredMutations: Obj[];
  toolCalls: Obj[];
  requests: Obj[];
  steps: Step[];
}

function attempt(turnId: string, sessionId = 'coordinator'): Obj {
  return {
    schemaVersion: 1,
    logicalCallId: `call_${turnId}`,
    attemptId: `attempt_${turnId}`,
    traceId: 'trace',
    sessionId,
    runId: `run_${turnId}`,
    turnId,
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'offline',
    modelId: 'offline-model',
    connectionSlug: 'offline',
    startedAt: 100,
    completedAt: 150,
    latencyMs: 50,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 50,
    outputTokens: 10,
    costBasis: 'unpriced',
  };
}

/** Synthetic checker inputs only. These never start a provider, Host or Desktop. */
function fixture(caseId: string): Fixture {
  const spec = workHubEvalCase(caseId);
  const f: Fixture = {
    schemaVersion: 1,
    mode: 'offline-checker-fixture',
    caseId,
    run: {
      commit: 'a'.repeat(40),
      profile: 'isolated',
      startedAt: 100,
      endedAt: 1000,
      completeObservation: true,
      history: 'tagged-isolated-fixture',
      historyLabel: 'offline synthetic checker input; no natural age',
    },
    environment: {
      modelId: 'offline-model',
      connectionId: 'offline-id',
      connectionSlug: 'offline',
      executor: 'ai-sdk',
      effectiveContextWindow: 131072,
      configuredInputLimit: 131072,
      compactionThreshold: null,
      pricingVerified: false,
    },
    bindings: Object.fromEntries(
      spec.bindings.map((name) => [
        name,
        {
          workId: `work_${name}`,
          generationId: `generation_${name}`,
          sessionId: `session_${name}`,
          title: `PRIVATE_FIXTURE_TITLE_${name}`,
        },
      ]),
    ),
    setup: {},
    factsBefore: [],
    factsAfter: [],
    retiredMutations: [],
    toolCalls: [],
    requests: [],
    steps: [],
  };
  if (caseId === 'T01')
    f.factsBefore.push({
      id: 'historical_fact',
      kind: 'delegation_assigned',
      actionId: 'historical_action',
      work: { id: 'work_old', generationId: 'generation_old' },
      targetSessionId: 'session_old',
      userText: '清理空格并写边界测试。',
    });
  if (caseId === 'T02') f.setup = { previewWorkId: 'work_a', mainTopicWorkId: 'work_b' };
  if (caseId === 'J07') f.setup = { coordinatorHistory: 'empty', antecedentWorkIds: [] };
  if (caseId === 'T13')
    f.setup = {
      undeliveredFollowup: {
        messageId: 'old_followup_message',
        workId: 'work_stale',
        userText: '把上次未发送的旧要求再补发一遍。',
        consumption: null,
        coordinationStatus: 'cancelled',
      },
    };
  f.factsAfter = [...f.factsBefore];
  for (const expected of spec.steps) {
    const turnId = `coord_${expected.id.replaceAll('-', '_')}`;
    const trigger = {
      turnId,
      sourceMessageId: `source_${turnId}`,
      inputOrigin: expected.origin,
      surface: expected.surface,
      userText: expected.text ?? '任务结果已到达，仅供汇报。',
    };
    const s: Step = { id: expected.id, trigger };
    f.steps.push(s);
    if (expected.surface === 'main') f.requests.push(attempt(turnId));
    if (expected.surface === 'main' && expected.operation !== 'none')
      f.toolCalls.push({
        turnId,
        toolCallId: `tool_${turnId}`,
        request: {
          kind: expected.operation,
          input: expected.target ? { taskId: f.bindings[expected.target].workId } : {},
        },
      });
    if (expected.operation === 'none') {
      s.terminal = {
        sessionId: 'coordinator',
        turnId,
        runId: `run_${turnId}`,
        status: 'completed',
        terminalEventId: `terminal_${turnId}`,
      };
      continue;
    }
    if (expected.operation === 'ask') {
      s.interaction = {
        interactionId: 'interaction_ask',
        turnId,
        status: 'pending',
        outcome: null,
        request: {
          kind: 'form',
          fields: [
            {
              kind: 'single_select',
              name: 'target',
              options: [],
            },
          ],
        },
      };
      continue;
    }
    const b = f.bindings[expected.target ?? 'a'];
    const content = { kind: 'text' as const, text: expected.text ?? '' };
    const targetMessageId = `message_${turnId}`;
    const workerTurn = `worker_${turnId}`;
    const targetSessionId = caseId === 'T06-fresh' ? 'fresh_session_a' : b.sessionId;
    const worker = { sessionId: targetSessionId, turnId: workerTurn, runId: `run_${workerTurn}` };
    const previous = [...f.factsAfter]
      .reverse()
      .find(
        (fact) =>
          fact.kind === 'delegation_assigned' && (fact.work as Obj | undefined)?.id === b.workId,
      );
    const native =
      expected.operation === 'start' || caseId === 'T06-fresh'
        ? {
            id: `fact_${turnId}`,
            kind: 'delegation_assigned',
            actionId: `action_${turnId}`,
            coordinationTurnId: turnId,
            work: {
              id: b.workId,
              generationId: caseId === 'T06-fresh' ? `action_${turnId}` : b.generationId,
              ...(caseId === 'T06-fresh' ? { continuesActionId: 'old_action_a' } : {}),
            },
            targetSessionId,
            targetMessageId,
            disposition: 'create_new',
            userText: trigger.userText,
            inputOrigin: expected.origin,
          }
        : {
            id: `fact_${turnId}`,
            kind: 'task_input',
            inputId: `input_${turnId}`,
            turnId: previous?.coordinationTurnId ?? turnId,
            sourceActionId: previous?.actionId ?? 'original_source_action',
            sourceMessageId: trigger.sourceMessageId,
            workId: b.workId,
            generationId: b.generationId,
            targetSessionId: b.sessionId,
            targetMessageId,
            targetContentDigest: messageContentDigest(content),
            text: trigger.userText,
            originalUserText: trigger.userText,
            inputOrigin: expected.origin,
            mode: expected.mode ?? 'continuation',
            ts: 150,
            ...(expected.mode === 'steering'
              ? { execution: { turnId: worker.turnId, runId: worker.runId } }
              : {}),
          };
    s.admission = native;
    if (s.admission.mode === 'continuation')
      f.factsAfter.push({
        id: `companion_${turnId}`,
        kind: 'delegation_assigned',
        actionId: `new_action_${turnId}`,
        work: {
          id: b.workId,
          generationId: b.generationId,
          continuesActionId: s.admission.sourceActionId,
        },
        coordinationTurnId: turnId,
        targetSessionId: b.sessionId,
        targetMessageId,
        disposition: 'delegate_existing',
        userText: trigger.userText,
        inputOrigin: expected.origin,
      });
    f.factsAfter.push(native);
    s.consumption =
      expected.mode === 'steering'
        ? {
            event: {
              ...worker,
              id: 'steering_event',
              role: 'user',
              ts: 250,
              refs: { providerEventId: targetMessageId },
              content: { ...content, steering: true },
            },
          }
        : { admission: worker, sourceMessage: { messageId: targetMessageId, content } };
    s.terminal = { ...worker, status: 'completed', terminalEventId: `terminal_${workerTurn}` };
    f.requests.push(attempt(workerTurn, b.sessionId));
    if (expected.mode === 'steering') {
      s.activeBefore = { ...worker, status: 'running' };
      s.activeTool = { ...worker, startedAt: 100, completedAt: 200, status: 'completed' };
    }
    if (expected.mode === 'queued_supplement') {
      const queue = {
        type: 'queue_update',
        steeringEntries: [],
        followupEntries: [
          {
            messageId: targetMessageId,
            entryId: 'queue_entry',
            placement: 'next_turn',
            state: 'queued',
          },
        ],
      };
      s.queueBefore = structuredClone(queue);
      s.queue = queue;
      s.cancellation = { delivery: 'cancelled', targetMessageId, workId: b.workId };
      s.activeBefore = {
        sessionId: 'session_a',
        turnId: 'active_a',
        runId: 'active_a_run',
        status: 'running',
      };
      s.activeAfter = structuredClone(s.activeBefore);
      delete s.consumption;
      delete s.terminal;
    }
    if (caseId === 'T06-fresh') {
      const historical = {
        id: 'old_a',
        kind: 'delegation_assigned',
        actionId: 'old_action_a',
        work: { id: b.workId, generationId: b.generationId },
        targetSessionId: b.sessionId,
      };
      f.factsBefore.push(historical);
      f.factsAfter.unshift(historical);
      s.previousSegment = { workId: b.workId, sessionId: b.sessionId };
      s.historyReads = [
        {
          ...worker,
          input: { taskId: b.workId, view: 'history' },
          result: {
            status: 'ok',
            history: {
              workId: b.workId,
              contentScope: 'same_work_history',
              records: [
                { kind: 'user', actionId: 'old_action_a', text: '原要求' },
                {
                  kind: 'user',
                  actionId: 'old_action_a',
                  recordSource: 'task_input',
                  text: '后续纠正',
                },
                { kind: 'tool_call', actionId: 'old_action_a', text: '工具参数' },
                { kind: 'tool_result', actionId: 'old_action_a', text: '工具结果' },
              ],
            },
          },
        },
      ];
    }
  }
  if (caseId === 'J07') setSelection(f);
  return f;
}

/** Native ask shapes in synthetic OFFLINE inputs, not model dispatch or invented Work IDs. */
function setSelection(f: Fixture): void {
  const candidates = Object.values(f.bindings);
  const choices = candidates.map((binding) => ({
    kind: binding.kind ?? 'task',
    id: binding.kind === 'session' ? binding.sessionId : binding.workId,
  }));
  ((f.toolCalls[0].request as Obj).input as Obj).choices = choices;
  ((f.steps[0].interaction as Obj).request as { fields: { options: Obj[] }[] }).fields[0].options =
    [
      ...candidates.map((binding, index) => ({
        label: binding.title,
        value: JSON.stringify([
          choices[index].kind,
          choices[index].id,
          binding.kind === 'session' ? `sha256:${'a'.repeat(64)}` : binding.generationId,
        ]),
      })),
      { value: 'new_task', label: '新建任务' },
    ];
}

function sessionSelectionFixture(): Fixture {
  const f = fixture('J07');
  f.bindings = Object.fromEntries(
    Object.entries(f.bindings).map(([name, binding]) => [
      name,
      { kind: 'session' as const, sessionId: binding.sessionId, title: binding.title },
    ]),
  );
  setSelection(f);
  const call = f.toolCalls[0];
  f.toolCalls = [
    {
      turnId: call.turnId,
      content: {
        kind: 'function_call',
        id: call.toolCallId,
        name: 'mcp__desktop_workhub__ask',
        args: (call.request as Obj).input as Obj,
      },
    },
  ];
  return f;
}

function issue(f: Fixture, code: string): void {
  const result = checkWorkHubCapture(f);
  assert.equal(result.verdict, 'fail');
  assert(
    result.issues.some((entry) => entry.code === code),
    JSON.stringify(result.issues),
  );
  assert.equal(result.realModelPass, false);
}

describe('WorkHub evidence checker — OFFLINE synthetic fixtures, not real-model passes', () => {
  for (const spec of WORKHUB_EVAL_CASES)
    test(`${spec.id}: accepts complete offline evidence without claiming model quality`, () => {
      const result = checkWorkHubCapture(fixture(spec.id));
      assert.deepEqual(result.issues, []);
      assert.equal(result.verdict, 'pass');
      assert.equal(result.realModelPass, false);
    });

  test('old same-topic routing, duplicate dispatch and unsolicited earlier work fail', () => {
    const old = fixture('T01');
    const call = old.toolCalls.at(-1)!;
    (call.request as { input: Obj }).input.taskId = old.bindings.old.workId;
    issue(old, 'wrong_task_tool_target');
    const wrongSession = fixture('T01');
    wrongSession.steps.at(-1)!.admission!.targetSessionId = wrongSession.bindings.old.sessionId;
    issue(wrongSession, 'wrong_task_admission');
    const duplicate = fixture('J12');
    duplicate.toolCalls.push(structuredClone(duplicate.toolCalls.at(-1)!));
    issue(duplicate, 'duplicate_tool_dispatch');
    const stale = fixture('T13');
    stale.factsAfter.push({
      id: 'resurrected',
      kind: 'task_input',
      workId: stale.bindings.stale.workId,
    });
    issue(stale, 'stale_followup_resurrected');
    issue(stale, 'unsolicited_or_duplicate_effect');
    const contaminated = fixture('T13');
    contaminated.steps[0].admission!.delegationText = '把上次未发送的旧要求再补发一遍。';
    issue(contaminated, 'stale_followup_text_reused');
  });

  test('preview target cannot replace main topic; clear antecedent cannot clarify', () => {
    const preview = fixture('T02');
    (preview.toolCalls.at(-1)!.request as { input: Obj }).input.taskId = preview.bindings.a.workId;
    issue(preview, 'wrong_task_tool_target');
    const clear = fixture('J12');
    (clear.toolCalls.at(-1)!.request as Obj).kind = 'ask';
    issue(clear, 'wrong_operation');
  });

  test('a receipt and disappearing queue row cannot prove consumption or settlement', () => {
    const f = fixture('J12');
    delete f.steps.at(-1)!.consumption;
    delete f.steps.at(-1)!.terminal;
    issue(f, 'missing_evidence');
    issue(f, 'consumption_identity_mismatch');
    issue(f, 'execution_not_settled_completed');
  });

  test('continuation joins original-source input to exactly one current assignment', () => {
    const f = fixture('J12');
    assert.notEqual(f.steps[1].admission!.turnId, f.steps[1].trigger.turnId);
    assert.deepEqual(checkWorkHubCapture(f).issues, []);
    const companion = f.factsAfter.find((fact) => fact.id === 'companion_coord_continue')!;
    f.factsAfter.push({ ...companion, id: 'duplicate_companion', actionId: 'duplicate_action' });
    issue(f, 'continuation_assignment_count');
    const wrongSource = fixture('J12');
    wrongSource.steps[1].admission!.sourceMessageId = 'another_user_message';
    issue(wrongSource, 'admission_coordinator_mismatch');
  });

  test('direct correction must consume in original Turn after the tool completes', () => {
    const f = fixture('T03-direct');
    ((f.steps[0].consumption as Obj).event as Obj).turnId = 'later_turn';
    issue(f, 'correction_not_consumed_same_turn');
    const interrupted = fixture('T03-direct');
    (interrupted.steps[0].activeTool as Obj).status = 'cancelled';
    issue(interrupted, 'active_tool_interrupted_or_no_boundary');
  });

  test('queued supplement cannot move position, consume or cancel another task', () => {
    const f = fixture('T03-queue');
    (f.steps[0].queue as Obj).followupEntries = [];
    issue(f, 'queue_identity_or_fifo_changed');
    const other = fixture('T03-queue');
    (other.steps[0].activeAfter as Obj).turnId = 'different_turn';
    issue(other, 'other_execution_changed');
  });

  test('fresh requires new segment and excludes other task history', () => {
    const f = fixture('T06-fresh');
    (f.steps[0].previousSegment as Obj).sessionId = f.steps[0].admission!.targetSessionId;
    issue(f, 'fresh_segment_not_proven');
    const leak = fixture('T06-fresh');
    const read = (leak.steps[0].historyReads as Obj[])[0];
    (((read.result as Obj).history as Obj).records as Obj[]).push({
      kind: 'user',
      actionId: 'other_task',
      text: 'unrelated',
    });
    issue(leak, 'other_task_history_leaked');
  });

  test('routing cases allow autonomous fresh only through the correct current task lineage', () => {
    const f = fixture('J12');
    const s = f.steps[1],
      previous = f.steps[0].admission!;
    const messageId = s.admission!.targetMessageId;
    f.factsAfter = f.factsAfter.filter((fact) => fact.targetMessageId !== messageId);
    const fresh: Obj = {
      ...previous,
      id: 'fresh_fact',
      actionId: 'fresh_generation',
      coordinationTurnId: s.trigger.turnId,
      targetSessionId: 'new_segment',
      targetMessageId: messageId,
      work: {
        id: f.bindings.a.workId,
        generationId: 'fresh_generation',
        continuesActionId: previous.actionId,
      },
      userText: s.trigger.userText,
    };
    s.admission = fresh;
    f.factsAfter.push(fresh);
    (s.consumption!.admission as Obj).sessionId = 'new_segment';
    s.terminal!.sessionId = 'new_segment';
    assert.deepEqual(checkWorkHubCapture(f).issues, []);
    (fresh.work as Obj).continuesActionId = 'historical_unrelated_action';
    issue(f, 'fresh_lineage_not_current_task');
  });

  test('missing cache counts remain unknown; reported zero remains zero; unverified pricing is suppressed', () => {
    const f = fixture('J12');
    assert.equal(checkWorkHubCapture(f).usage.cacheReadInputTokens, null);
    for (const r of f.requests) {
      r.cacheReadInputTokens = 0;
      r.costBasis = 'priced';
      r.costUsd = 0.01;
    }
    assert.equal(checkWorkHubCapture(f).usage.cacheReadInputTokens, 0);
    assert.equal(checkWorkHubCapture(f).usage.estimatedUsd, null);
    f.environment.pricingVerified = true;
    f.environment.pricingSource = 'explicit fixture connection price';
    assert.equal(checkWorkHubCapture(f).usage.estimatedUsd, f.requests.length * 0.01);
  });

  test('J07 requires native new-task option, no existing antecedent and no dispatch', () => {
    const f = fixture('J07');
    (
      (f.steps[0].interaction as Obj).request as { fields: { options: Obj[] }[] }
    ).fields[0].options.pop();
    issue(f, 'new_task_choice_missing');
    const antecedent = fixture('J07');
    antecedent.setup.antecedentWorkIds = ['work_a'];
    issue(antecedent, 'no_antecedent_unproven');
  });

  test('J07 accepts native Session candidates without Work or generation identities', () => {
    const f = sessionSelectionFixture();
    assert.deepEqual(Object.keys(f.bindings.a).sort(), ['kind', 'sessionId', 'title']);
    const result = checkWorkHubCapture(f);
    assert.deepEqual(result.issues, []);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.realModelPass, false);
    assert.equal(result.phases[0].settlement, 'waiting_for_user');
    f.mode = 'desktop-model';
    issue(f, 'unbound_evidence');
    const mixed = fixture('J07');
    mixed.bindings.a = { kind: 'session', sessionId: 'session_a', title: 'Manual Session' };
    mixed.bindings.b.kind = 'task';
    setSelection(mixed);
    assert.deepEqual(checkWorkHubCapture(mixed).issues, []);
  });

  test('J07 rejects fabricated Work fields on Session bindings and duplicate Session candidates', () => {
    for (const key of ['work', 'workId', 'generationId', 'actionId']) {
      const f = sessionSelectionFixture();
      (f.bindings.a as Obj)[key] = key === 'work' ? { id: 'fake_work' } : 'fake_identity';
      issue(f, 'session_binding_has_work_identity');
    }
    const duplicate = sessionSelectionFixture();
    duplicate.bindings.b.sessionId = duplicate.bindings.a.sessionId;
    issue(duplicate, 'duplicate_task_bindings');
    const otherCase = fixture('J12');
    otherCase.bindings.a = { kind: 'session', sessionId: 'session_a', title: 'Manual Session' };
    issue(otherCase, 'missing_private_binding');
  });

  test('J07 Session clarification rejects unexpected dispatch in tools or canonical facts', () => {
    const call = sessionSelectionFixture();
    call.toolCalls.push({
      turnId: call.steps[0].trigger.turnId,
      toolCallId: 'unexpected_start',
      request: { kind: 'start', input: { sessionRef: call.bindings.a.sessionId } },
    });
    issue(call, 'unexpected_write_call_count');
    const dispatched = sessionSelectionFixture();
    dispatched.factsAfter.push({
      id: 'unexpected_assignment',
      kind: 'delegation_assigned',
      actionId: 'unexpected_action',
      targetSessionId: dispatched.bindings.a.sessionId,
    });
    issue(dispatched, 'unsolicited_or_duplicate_effect');
  });

  test('J07 ask choices and original native form must match the privately bound candidates', () => {
    const wrongCall = sessionSelectionFixture();
    (((wrongCall.toolCalls[0].content as Obj).args as Obj).choices as Obj[])[0].id =
      'unoffered_session';
    issue(wrongCall, 'ask_candidates_mismatch');
    for (const options of [
      [{ value: JSON.stringify(['session', 'unoffered_session', `sha256:${'a'.repeat(64)}`]) }],
      [{ value: JSON.stringify(['session', 'session_a', 'fake_generation']) }],
      [],
    ]) {
      const f = sessionSelectionFixture();
      const field = ((f.steps[0].interaction as Obj).request as { fields: { options: Obj[] }[] })
        .fields[0];
      field.options.splice(0, 1, ...options);
      issue(f, 'native_selection_candidates_mismatch');
    }
    const work = fixture('J07');
    const field = ((work.steps[0].interaction as Obj).request as { fields: { options: Obj[] }[] })
      .fields[0];
    field.options[0].value = JSON.stringify(['task', 'work_a', 'unrelated_generation']);
    issue(work, 'native_selection_candidates_mismatch');
  });

  test('fixed input cannot be padded with IDs, full titles or forced tools', () => {
    const f = fixture('J12');
    f.steps[1].trigger.userText += ` ${f.bindings.a.workId} WorkHubContinue`;
    issue(f, 'fixed_input_changed');
    issue(f, 'input_contains_exact_binding');
    issue(f, 'input_contains_tool_hint');
  });

  test('inline desktop facts cannot be called a real-model pass', () => {
    const f = fixture('J12');
    f.mode = 'desktop-model';
    issue(f, 'unbound_evidence');
  });

  test('native Root trigger and existing collector tool/SQL request projections need no invented envelopes', () => {
    const f = fixture('J12');
    for (const s of f.steps)
      s.trigger = {
        turnId: s.trigger.turnId,
        userMessageId: s.trigger.sourceMessageId,
        normalizedInput: { text: s.trigger.userText },
        execution: { kind: 'workhub_coordination' },
      };
    f.toolCalls = f.toolCalls.map((call) => ({
      kind: 'function_call',
      turnId: call.turnId,
      toolCallId: call.toolCallId,
      name: `mcp__desktop_workhub__${(call.request as Obj).kind}`,
      operation: (call.request as Obj).kind,
      selectedWorkId: ((call.request as Obj).input as Obj).taskId,
    }));
    f.requests = f.requests.map((r) => ({
      attempt_id: r.attemptId,
      logical_call_id: r.logicalCallId,
      completed_at: r.completedAt,
      session_id: r.sessionId,
      turn_id: r.turnId,
      call_kind: r.callKind,
      provider_id: r.providerId,
      model_id: r.modelId,
      latency_ms: r.latencyMs,
      status: r.status,
      usage_basis: r.usageBasis,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_input_tokens: null,
      cache_write_input_tokens: 0,
      cost_basis: r.costBasis,
      cost_usd: null,
    }));
    const result = checkWorkHubCapture(f);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.usage.sources, ['usage_model_call_attempts']);
    assert.equal(result.usage.cacheReadInputTokens, null);
    assert.equal(result.usage.cacheWriteInputTokens, 0);
  });

  test('retired protocol calls and newly written retired state fail rather than disappear from inventory', () => {
    const f = fixture('J12');
    f.toolCalls.push({
      kind: 'function_call',
      turnId: f.steps[1].trigger.turnId,
      toolCallId: 'retired_tool',
      name: 'WorkHubControl',
      operation: 'correct',
    });
    issue(f, 'unexpected_write_call_count');
    const state = fixture('J12');
    state.retiredMutations.push({ type: 'workhub_peer_question', id: 'unexpected_peer' });
    issue(state, 'retired_protocol_mutation');
    const missing = fixture('J12');
    delete (missing as Partial<Fixture>).retiredMutations;
    issue(missing, 'missing_evidence_array');
  });

  test('invalid request evidence does not produce a complete-looking cost or token total', () => {
    const f = fixture('J12');
    f.requests.push({ attemptId: 'invalid_missing_usage' });
    issue(f, 'invalid_physical_request_record');
    const usage = checkWorkHubCapture(f).usage;
    assert.equal(usage.requests, f.requests.length);
    assert.equal(usage.invalidRequestRecords, 1);
    assert.equal(usage.inputTokens, null);
    assert.equal(usage.estimatedUsd, null);
  });
});

describe('WorkHub capture CLI — OFFLINE file integrity and command tests', () => {
  test('plans are pending Desktop runs and unknown cases fail', async () => {
    let out = '';
    let err = '';
    const io = {
      stdout: (s: string) => {
        out += s;
      },
      stderr: (s: string) => {
        err += s;
      },
    };
    assert.equal(await runWorkHubEvalCli(['plan', 'T01'], io), 0);
    assert.equal(JSON.parse(out).status, 'pending_desktop_execution');
    assert.equal(await runWorkHubEvalCli(['plan', 'unknown'], io), 2);
    assert.match(err, /Unknown WorkHub case/u);
  });

  test('J07 Session selection evidence retains source hash and pointer verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workhub-j07-checker-'));
    try {
      const f = sessionSelectionFixture();
      const source = join(root, 'selection.json');
      const manifest = join(root, 'capture.json');
      await writeFile(source, JSON.stringify({ selection: f.steps[0].interaction }));
      const sha256 = createHash('sha256')
        .update(await readFile(source))
        .digest('hex');
      await writeFile(
        manifest,
        JSON.stringify({
          ...f,
          steps: [
            {
              ...f.steps[0],
              interaction: { $evidence: { file: 'selection.json', sha256, pointer: '/selection' } },
            },
          ],
        }),
      );
      const loaded = await loadWorkHubCapture(manifest);
      const interaction = (loaded.capture as Fixture).steps[0].interaction as object;
      assert(loaded.verified.has(interaction));
      const report = checkWorkHubCapture(loaded.capture, loaded);
      assert.deepEqual(report.issues, []);
      assert.equal(report.realModelPass, false);
      await writeFile(source, '{}');
      await assert.rejects(loadWorkHubCapture(manifest), /SHA-256 mismatch/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('source hashes and pointers are verified; offline check exit codes distinguish pass/fail/invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workhub-checker-'));
    try {
      const f = fixture('J12');
      const source = join(root, 'source.json');
      const manifest = join(root, 'capture.json');
      await writeFile(source, JSON.stringify({ records: f.requests }));
      const sha256 = createHash('sha256')
        .update(await readFile(source))
        .digest('hex');
      const captured = {
        ...f,
        requests: { $evidence: { file: 'source.json', sha256, pointer: '/records' } },
      };
      await writeFile(manifest, JSON.stringify(captured));
      const loaded = await loadWorkHubCapture(manifest);
      assert.equal(loaded.evidenceFiles, 1);
      assert(loaded.verified.has((loaded.capture as Fixture).requests[0]));
      assert.equal(checkWorkHubCapture(loaded.capture, loaded).verdict, 'pass');
      let out = '';
      const io = {
        stdout: (s: string) => {
          out += s;
        },
        stderr: (_s: string) => {},
      };
      assert.equal(await runWorkHubEvalCli(['check', manifest], io), 0);
      assert.equal(JSON.parse(out).realModelPass, false);
      await writeFile(manifest, JSON.stringify({ ...captured, steps: [] }));
      assert.equal(await runWorkHubEvalCli(['check', manifest], io), 1);
      await writeFile(source, '{}');
      assert.equal(await runWorkHubEvalCli(['check', manifest], io), 2);
      await assert.rejects(loadWorkHubCapture(manifest), /SHA-256 mismatch/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
