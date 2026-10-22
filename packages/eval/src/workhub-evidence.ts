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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  decodeMessageContent,
  messageContentDigest,
  normalizeMessageContent,
  type MessageContent,
} from '@maka/core/events';
import { workHubEvalCase } from './workhub-cases.js';
import {
  isWorkHubWriteCall,
  workHubRequestObservation,
  workHubToolCall,
  workHubTrigger,
  type WorkHubRequestObservation,
} from './workhub-capture-records.js';

type RecordValue = Record<string, unknown>;
export interface WorkHubEvidenceRef {
  readonly $evidence: { readonly file: string; readonly sha256: string; readonly pointer: string };
}
export interface WorkHubEvalIssue {
  readonly code: string;
  readonly at: string;
}
export interface WorkHubEvalPhase {
  readonly step: string;
  admission: 'missing' | 'observed' | 'not_applicable';
  queue: 'not_observed' | 'observed';
  consumption:
    | 'missing'
    | 'root'
    | 'same_turn_steering'
    | 'cancelled_before_start'
    | 'not_applicable';
  settlement:
    | 'missing'
    | 'completed'
    | 'cancelled_before_start'
    | 'waiting_for_user'
    | 'not_applicable';
}
export interface WorkHubEvalReport {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly revision: string;
  readonly durationMs: number | null;
  readonly mode: string;
  readonly verdict: 'pass' | 'fail';
  readonly realModelPass: boolean;
  readonly evidenceFiles: number;
  readonly issues: readonly WorkHubEvalIssue[];
  readonly phases: readonly WorkHubEvalPhase[];
  readonly usage: {
    readonly requests: number;
    readonly invalidRequestRecords: number;
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadInputTokens: number | null;
    readonly cacheMissInputTokens: number | null;
    readonly cacheWriteInputTokens: number | null;
    readonly missingUsageRequests: number;
    readonly estimatedUsd: number | null;
    readonly costClaim: 'connection_price_estimate_only';
    readonly coverage: 'captured_attempts_only';
    readonly sources: readonly string[];
  };
}

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const scope = (value: unknown) => {
  const r = record(value);
  return { sessionId: r.sessionId, turnId: r.turnId, runId: r.runId };
};
const sameScope = (a: unknown, b: unknown) => isDeepStrictEqual(scope(a), scope(b));
const effect = (value: unknown): boolean =>
  ['delegation_assigned', 'task_input'].includes(text(record(value).kind));
const factWork = (value: unknown) => {
  const r = record(value);
  return r.kind === 'task_input' ? r.workId : (record(r.work).id ?? r.actionId);
};
const factGeneration = (value: unknown) => {
  const r = record(value);
  return r.kind === 'task_input' ? r.generationId : (record(r.work).generationId ?? r.actionId);
};

/** Read-only. Hashes bind checks to exported evidence, not to the truth of its provenance. */
export async function loadWorkHubCapture(path: string): Promise<{
  capture: unknown;
  verified: ReadonlySet<object>;
  evidenceFiles: number;
}> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as unknown;
  const verified = new Set<object>();
  const files = new Map<string, { digest: string; data: unknown }>();
  const bindTree = (item: unknown): void => {
    if (item === null || typeof item !== 'object' || verified.has(item)) return;
    verified.add(item);
    for (const child of Object.values(item)) bindTree(child);
  };
  async function load(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map(load));
    if (value === null || typeof value !== 'object') return value;
    const r = record(value);
    if (Object.hasOwn(r, '$evidence')) {
      if (Object.keys(r).length !== 1)
        throw Error('Evidence reference must not carry inline facts');
      const ref = record(r.$evidence);
      if (!text(ref.file) || !/^[a-f0-9]{64}$/u.test(text(ref.sha256)))
        throw Error('Evidence reference requires file and SHA-256');
      if (typeof ref.pointer !== 'string' || (ref.pointer !== '' && !ref.pointer.startsWith('/')))
        throw Error('Evidence pointer must be an RFC 6901 JSON Pointer');
      const file = resolve(dirname(path), text(ref.file));
      let source = files.get(file);
      if (!source) {
        const bytes = await readFile(file);
        source = {
          digest: createHash('sha256').update(bytes).digest('hex'),
          data: JSON.parse(bytes.toString('utf8')),
        };
        files.set(file, source);
      }
      if (source.digest !== ref.sha256) throw Error(`Evidence SHA-256 mismatch: ${ref.file}`);
      let selected = source.data;
      for (const token of ref.pointer === '' ? [] : ref.pointer.slice(1).split('/')) {
        if (/~(?:[^01]|$)/u.test(token)) throw Error('Invalid JSON Pointer escape');
        const key = token.replace(/~1/gu, '/').replace(/~0/gu, '~');
        if (selected === null || typeof selected !== 'object' || !Object.hasOwn(selected, key))
          throw Error(`Evidence pointer missing: ${ref.pointer}`);
        selected = (selected as RecordValue)[key];
      }
      if (selected === null || typeof selected !== 'object')
        throw Error('Evidence must select an object or array, not an unbound primitive');
      bindTree(selected);
      return selected;
    }
    const entries = await Promise.all(
      Object.entries(r).map(async ([key, item]) => [key, await load(item)] as const),
    );
    return Object.fromEntries(entries);
  }
  return { capture: await load(manifest), verified, evidenceFiles: files.size };
}

/** Offline fixtures exercise this checker; only source-bound Desktop captures can claim model passes. */
export function checkWorkHubCapture(
  value: unknown,
  sources: { readonly verified?: ReadonlySet<object>; readonly evidenceFiles?: number } = {},
): WorkHubEvalReport {
  const c = record(value);
  const spec = workHubEvalCase(text(c.caseId));
  const issues: WorkHubEvalIssue[] = [];
  const fail = (code: string, at: string) => issues.push({ code, at });
  const check = (ok: unknown, code: string, at: string) => {
    if (!ok) fail(code, at);
  };
  const desktop = c.mode === 'desktop-model';
  check(c.schemaVersion === 1, 'schema_version', 'schemaVersion');
  check(desktop || c.mode === 'offline-checker-fixture', 'unknown_mode', 'mode');
  function evidence(item: unknown, at: string): RecordValue {
    check(item !== null && typeof item === 'object', 'missing_evidence', at);
    if (desktop) check(!!item && sources.verified?.has(item as object), 'unbound_evidence', at);
    return record(item);
  }
  function evidenceList(item: unknown, at: string): unknown[] {
    evidence(item, at);
    check(Array.isArray(item), 'missing_evidence_array', at);
    return list(item);
  }
  const run = record(c.run);
  check(/^[a-f0-9]{40}$/u.test(text(run.commit)), 'missing_commit', 'run.commit');
  check(run.profile === 'isolated', 'profile_not_isolated', 'run.profile');
  check(
    count(run.startedAt) && count(run.endedAt) && run.endedAt >= run.startedAt,
    'invalid_observation_window',
    'run',
  );
  check(
    run.completeObservation === true,
    'incomplete_observation_window',
    'run.completeObservation',
  );
  check(
    ['none', 'natural', 'tagged-isolated-fixture'].includes(text(run.history)),
    'history_provenance_missing',
    'run.history',
  );
  if (run.history === 'tagged-isolated-fixture')
    check(text(run.historyLabel).trim(), 'historical_fixture_unlabelled', 'run.historyLabel');

  const env = evidence(c.environment, 'environment');
  for (const field of ['modelId', 'connectionId', 'connectionSlug', 'executor'])
    check(text(env[field]).trim(), 'missing_route', `environment.${field}`);
  for (const field of ['effectiveContextWindow', 'configuredInputLimit', 'compactionThreshold'])
    check(
      Object.hasOwn(env, field) && (env[field] === null || (count(env[field]) && env[field] > 0)),
      'missing_window_observation',
      `environment.${field}`,
    );
  check(
    typeof env.pricingVerified === 'boolean',
    'missing_pricing_provenance',
    'environment.pricingVerified',
  );
  if (env.pricingVerified)
    check(text(env.pricingSource).trim(), 'missing_pricing_source', 'environment.pricingSource');
  const bindings = record(c.bindings);
  const ids: unknown[] = [];
  const selectionCandidates: {
    kind: 'task' | 'session';
    id: string;
    generationId?: string;
  }[] = [];
  for (const name of spec.bindings) {
    const b = record(bindings[name]);
    if (spec.id === 'J07' && b.kind === 'session') {
      check(identity(b.sessionId), 'missing_private_binding', `bindings.${name}.sessionId`);
      check(
        !['work', 'workId', 'generationId', 'actionId'].some((key) => Object.hasOwn(b, key)),
        'session_binding_has_work_identity',
        `bindings.${name}`,
      );
      selectionCandidates.push({ kind: 'session', id: text(b.sessionId) });
      ids.push(JSON.stringify(['session', b.sessionId]));
    } else {
      if (spec.id === 'J07')
        check(
          b.kind === undefined || b.kind === 'task',
          'invalid_selection_binding_kind',
          `bindings.${name}.kind`,
        );
      for (const key of ['workId', 'generationId', 'sessionId'])
        check(identity(b[key]), 'missing_private_binding', `bindings.${name}.${key}`);
      if (spec.id === 'J07')
        selectionCandidates.push({
          kind: 'task',
          id: text(b.workId),
          generationId: text(b.generationId),
        });
      ids.push(spec.id === 'J07' ? JSON.stringify(['task', b.workId]) : b.workId);
    }
    check(text(b.title).trim(), 'missing_private_title', `bindings.${name}.title`);
  }
  check(new Set(ids).size === ids.length, 'duplicate_task_bindings', 'bindings');

  const before = evidenceList(c.factsBefore, 'factsBefore');
  const after = evidenceList(c.factsAfter, 'factsAfter');
  check(
    evidenceList(c.retiredMutations, 'retiredMutations').length === 0,
    'retired_protocol_mutation',
    'retiredMutations',
  );
  const beforeIds = new Set(before.map((f) => record(f).id));
  const newFacts = after.filter((f) => !beforeIds.has(record(f).id) && effect(f));
  for (const raw of after.filter((f) => !beforeIds.has(record(f).id))) {
    const f = record(raw);
    check(
      !/^workhub_(?:evidence|peer)/u.test(text(f.type)) &&
        ![
          'delegation_replacement_requested',
          'delegation_replacement_aborted',
          'delegation_superseded',
        ].includes(text(f.kind)),
      'retired_protocol_mutation',
      `factsAfter.${text(f.id)}`,
    );
    if (['delegation_stop_requested', 'delegation_stop_resolved'].includes(text(f.kind)))
      check(
        spec.id === 'T03-queue' && f.targetSessionId === record(bindings.b).sessionId,
        'unsolicited_stop_fact',
        `factsAfter.${text(f.id)}`,
      );
  }
  check(
    new Set(after.map((f) => record(f).id)).size === after.length,
    'duplicate_fact_identity',
    'factsAfter',
  );
  for (const old of before)
    check(
      after.some((f) => isDeepStrictEqual(f, old)),
      'historical_fact_changed',
      `factsBefore.${text(record(old).id)}`,
    );
  const allCalls = evidenceList(c.toolCalls, 'toolCalls').flatMap((call) => {
    const normalized = workHubToolCall(call);
    return normalized ? [normalized] : [];
  });
  const writeCalls = allCalls.filter(isWorkHubWriteCall);
  const seenEffects = new Set<string>();
  const currentSegments = new Map(
    Object.entries(bindings).map(([name, binding]) => [
      name,
      {
        sessionId: record(binding).sessionId,
        generationId: record(binding).generationId,
      },
    ]),
  );
  const seenCalls = new Set<string>();
  const observedTurns = new Set<string>();
  const coordinatorTurns = new Set<string>();
  const executionTurns = new Set<string>();
  const phases: WorkHubEvalPhase[] = [];
  const steps = list(c.steps).map(record);
  check(
    steps.length === spec.steps.length && new Set(steps.map((s) => s.id)).size === steps.length,
    'step_set_mismatch',
    'steps',
  );

  for (const expected of spec.steps) {
    const step = steps.find((s) => s.id === expected.id) ?? {};
    const at = `steps.${expected.id}`;
    const trigger = workHubTrigger(evidence(step.trigger, `${at}.trigger`));
    check(
      identity(trigger.turnId) &&
        (expected.origin === 'feedback' || identity(trigger.sourceMessageId)),
      'missing_trigger_identity',
      `${at}.trigger`,
    );
    check(
      trigger.inputOrigin === expected.origin && trigger.surface === expected.surface,
      'trigger_origin_mismatch',
      `${at}.trigger`,
    );
    if (expected.text !== null)
      check(trigger.userText === expected.text, 'fixed_input_changed', `${at}.trigger.userText`);
    for (const binding of expected.origin === 'user' ? Object.values(bindings).map(record) : []) {
      // Fixed input equality prevents injected titles; a model-created title may
      // legitimately repeat words from the original creation request.
      for (const key of ['workId', 'generationId', 'sessionId']) {
        const token = text(binding[key]);
        if (token)
          check(
            !text(trigger.userText).includes(token),
            'input_contains_exact_binding',
            `${at}.trigger.userText`,
          );
      }
    }
    check(
      expected.origin === 'feedback' ||
        !/\b(?:WorkHub(?:Start|Continue|Find|Read|Ask|Stop)|workhub\.tasks\.[a-z]+)\b/u.test(
          text(trigger.userText),
        ),
      'input_contains_tool_hint',
      `${at}.trigger.userText`,
    );
    check(!observedTurns.has(text(trigger.turnId)), 'duplicate_trigger_turn', at);
    observedTurns.add(text(trigger.turnId));
    if (expected.surface === 'main') coordinatorTurns.add(text(trigger.turnId));
    const calls = writeCalls.filter((call) => call.turnId === trigger.turnId);
    for (const call of calls) {
      const id = text(call.toolCallId);
      const key = `${text(call.turnId)}:${id}`;
      check(identity(id) && !seenCalls.has(key), 'duplicate_tool_dispatch', at);
      seenCalls.add(key);
    }
    const p: WorkHubEvalPhase = {
      step: expected.id,
      admission: 'missing',
      queue: 'not_observed',
      consumption: 'missing',
      settlement: 'missing',
    };
    phases.push(p);
    const sideInput = expected.surface === 'task';
    check(
      sideInput ? calls.length === 0 : calls.length === (expected.operation === 'none' ? 0 : 1),
      'unexpected_write_call_count',
      at,
    );
    if (!sideInput && expected.operation !== 'none') {
      const call = calls[0] ?? {};
      check(record(call.request).kind === expected.operation, 'wrong_operation', at);
      if (expected.target && expected.operation === 'continue')
        check(
          record(record(call.request).input).taskId === record(bindings[expected.target]).workId,
          'wrong_task_tool_target',
          at,
        );
    }
    if (expected.operation === 'ask') {
      const interaction = evidence(step.interaction, `${at}.interaction`);
      const request = record(interaction.request ?? interaction);
      check(
        request.kind === 'form' &&
          identity(interaction.interactionId) &&
          interaction.turnId === trigger.turnId &&
          interaction.status === 'pending' &&
          interaction.outcome === null,
        'missing_native_selection',
        `${at}.interaction`,
      );
      const options = list(request.fields)
        .flatMap((field) => list(record(field).options))
        .map(record);
      check(
        options.some((option) => option.value === 'new_task'),
        'new_task_choice_missing',
        `${at}.interaction`,
      );
      check(
        options.some((option) => text(option.value) !== 'new_task'),
        'task_choices_missing',
        `${at}.interaction`,
      );
      const choiceKey = (choice: RecordValue) => JSON.stringify([choice.kind, choice.id]);
      const expectedChoices = new Set(selectionCandidates.map(choiceKey));
      const sameChoices = (choices: RecordValue[]) =>
        choices.length === selectionCandidates.length &&
        new Set(choices.map(choiceKey)).size === choices.length &&
        choices.every((choice) => expectedChoices.has(choiceKey(choice)));
      check(
        sameChoices(list(record(record(calls[0]?.request).input).choices).map(record)),
        'ask_candidates_mismatch',
        `${at}.toolCall`,
      );
      const fields = list(request.fields)
        .map(record)
        .filter((field) => field.name === 'target');
      const targetOptions = list(fields[0]?.options).map(record);
      const offered = targetOptions
        .filter((option) => option.value !== 'new_task')
        .map((option) => {
          let tuple: unknown;
          try {
            tuple = JSON.parse(text(option.value));
          } catch {
            return {};
          }
          if (!Array.isArray(tuple) || tuple.length !== 3) return {};
          const [kind, id, basis] = tuple;
          const candidate = selectionCandidates.find(
            (item) => item.kind === kind && item.id === id,
          );
          if (
            !candidate ||
            (kind === 'session'
              ? !/^sha256:[a-f0-9]{64}$/u.test(text(basis))
              : basis !== candidate.generationId)
          )
            return {};
          return { kind, id };
        });
      check(
        fields.length === 1 &&
          fields[0].kind === 'single_select' &&
          targetOptions.filter((option) => option.value === 'new_task').length === 1 &&
          sameChoices(offered),
        'native_selection_candidates_mismatch',
        `${at}.interaction`,
      );
      p.admission = 'not_applicable';
      p.consumption = 'not_applicable';
      p.settlement = 'waiting_for_user';
      continue;
    }
    if (expected.operation === 'none') {
      const terminal = evidence(step.terminal, `${at}.terminal`);
      check(
        terminal.turnId === trigger.turnId &&
          terminal.status === 'completed' &&
          identity(terminal.terminalEventId),
        'feedback_not_settled',
        `${at}.terminal`,
      );
      p.admission = 'not_applicable';
      p.consumption = 'not_applicable';
      p.settlement = terminal.status === 'completed' ? 'completed' : 'missing';
      continue;
    }
    const bindingName = expected.target ?? '';
    let b: RecordValue = { ...record(bindings[bindingName]), ...currentSegments.get(bindingName) };
    const admission = evidence(step.admission, `${at}.admission`);
    const factId = text(admission.id);
    check(effect(admission) && identity(factId), 'missing_admission_fact', `${at}.admission`);
    check(!seenEffects.has(factId), 'duplicate_effect', `${at}.admission`);
    seenEffects.add(factId);
    check(
      newFacts.some((f) => isDeepStrictEqual(f, admission)),
      'admission_not_in_inventory',
      `${at}.admission`,
    );
    if (
      expected.operation === 'continue' &&
      admission.kind === 'delegation_assigned' &&
      admission.disposition === 'create_new'
    ) {
      const previous = [...before, ...newFacts]
        .map(record)
        .find(
          (f) =>
            f.kind === 'delegation_assigned' &&
            f.actionId === record(admission.work).continuesActionId &&
            factWork(f) === b.workId &&
            f.targetSessionId === b.sessionId &&
            factGeneration(f) === b.generationId,
        );
      check(
        previous &&
          admission.targetSessionId !== b.sessionId &&
          factGeneration(admission) !== b.generationId &&
          factGeneration(admission) === admission.actionId &&
          identity(admission.targetSessionId),
        'fresh_lineage_not_current_task',
        `${at}.admission`,
      );
      // Identity remains private/immutable at work level; new segment identity
      // must be proven by the real current source, never selected by a fixture router.
      b = { ...b, sessionId: admission.targetSessionId, generationId: factGeneration(admission) };
      currentSegments.set(bindingName, { sessionId: b.sessionId, generationId: b.generationId });
    }
    check(
      factWork(admission) === b.workId &&
        factGeneration(admission) === b.generationId &&
        admission.targetSessionId === b.sessionId,
      'wrong_task_admission',
      `${at}.admission`,
    );
    check(
      (admission.originalUserText ?? admission.userText ?? admission.text) === trigger.userText &&
        (admission.inputOrigin ?? 'user') === expected.origin,
      'admission_source_mismatch',
      `${at}.admission`,
    );
    if (!sideInput)
      check(
        admission.kind === 'task_input'
          ? admission.sourceMessageId === trigger.sourceMessageId
          : (admission.coordinationTurnId ?? admission.turnId) === trigger.turnId,
        'admission_coordinator_mismatch',
        `${at}.admission`,
      );
    // Ended-task continuation commits an input and one new assignment together.
    // The input keeps its original source Turn; the assignment owns this trigger.
    if (admission.mode === 'continuation') {
      const companions = newFacts
        .map(record)
        .filter(
          (f) =>
            f.kind === 'delegation_assigned' &&
            f.targetMessageId === admission.targetMessageId &&
            f.targetSessionId === admission.targetSessionId &&
            factWork(f) === factWork(admission) &&
            factGeneration(f) === factGeneration(admission) &&
            record(f.work).continuesActionId === admission.sourceActionId &&
            f.disposition === 'delegate_existing',
        );
      check(companions.length === 1, 'continuation_assignment_count', `${at}.admission`);
      for (const companion of companions) {
        check(!seenEffects.has(text(companion.id)), 'duplicate_effect', `${at}.admission`);
        seenEffects.add(text(companion.id));
        if (!sideInput)
          check(
            companion.coordinationTurnId === trigger.turnId,
            'admission_coordinator_mismatch',
            `${at}.admission`,
          );
      }
    }
    if (expected.operation === 'start')
      check(
        admission.kind === 'delegation_assigned' && admission.disposition === 'create_new',
        'independent_task_not_started',
        `${at}.admission`,
      );
    if (expected.mode)
      check(admission.mode === expected.mode, 'input_mode_mismatch', `${at}.admission`);
    p.admission = 'observed';
    if (step.queue !== undefined) {
      const queue = evidence(step.queue, `${at}.queue`);
      const entries = [...list(queue.steeringEntries), ...list(queue.followupEntries)].map(record);
      check(
        queue.type === 'queue_update' &&
          entries.some((entry) => entry.messageId === admission.targetMessageId),
        'message_not_in_queue',
        `${at}.queue`,
      );
      p.queue = 'observed';
    }
    if (expected.mode === 'queued_supplement') {
      const original = evidence(step.queueBefore, `${at}.queueBefore`);
      const updated = evidence(step.queue, `${at}.queue`);
      const order = (r: RecordValue) =>
        [...list(r.steeringEntries), ...list(r.followupEntries)].map((e) => record(e).messageId);
      check(
        order(original).includes(admission.targetMessageId) &&
          isDeepStrictEqual(order(original), order(updated)),
        'queue_identity_or_fifo_changed',
        at,
      );
      const cancelled = evidence(step.cancellation, `${at}.cancellation`);
      check(
        cancelled.delivery === 'cancelled' &&
          cancelled.targetMessageId === admission.targetMessageId &&
          cancelled.workId === b.workId,
        'queue_cancellation_unproven',
        at,
      );
      check(
        sameScope(
          evidence(step.activeBefore, `${at}.activeBefore`),
          evidence(step.activeAfter, `${at}.activeAfter`),
        ) && record(step.activeAfter).status === 'running',
        'other_execution_changed',
        at,
      );
      check(step.consumption === undefined, 'cancelled_queue_was_consumed', at);
      p.consumption = 'cancelled_before_start';
      p.settlement = 'cancelled_before_start';
      continue;
    }
    const proof = evidence(step.consumption, `${at}.consumption`);
    const root = record(proof.admission);
    const event = record(proof.event);
    const isSteering = Object.keys(event).length > 0;
    const execution = isSteering ? event : root;
    executionTurns.add(text(execution.turnId));
    const message = isSteering ? event : record(proof.sourceMessage);
    const messageId = isSteering ? record(event.refs).providerEventId : message.messageId;
    check(
      identity(execution.turnId) &&
        identity(execution.runId) &&
        execution.sessionId === b.sessionId &&
        messageId === admission.targetMessageId,
      'consumption_identity_mismatch',
      `${at}.consumption`,
    );
    if (admission.kind === 'task_input') {
      let digest: string | undefined;
      try {
        digest = messageContentDigest(
          decodeMessageContent(normalizeMessageContent(message.content as MessageContent)),
        );
      } catch {
        /* Missing canonical content is an evidence failure below. */
      }
      check(
        digest !== undefined && digest === admission.targetContentDigest,
        'consumed_content_digest_mismatch',
        `${at}.consumption`,
      );
    } else
      check(
        text(record(message.content).text).includes(
          text(admission.delegationText ?? admission.userText),
        ) && text(admission.delegationText ?? admission.userText).length > 0,
        'consumed_delegation_missing',
        `${at}.consumption`,
      );
    if (expected.mode === 'steering') {
      const active = evidence(step.activeBefore, `${at}.activeBefore`);
      check(
        isSteering &&
          event.role === 'user' &&
          record(event.content).steering === true &&
          sameScope(execution, active),
        'correction_not_consumed_same_turn',
        `${at}.consumption`,
      );
      const tool = evidence(step.activeTool, `${at}.activeTool`);
      check(
        sameScope(tool, active) &&
          count(tool.startedAt) &&
          count(tool.completedAt) &&
          count(admission.ts) &&
          count(event.ts) &&
          tool.startedAt <= admission.ts &&
          admission.ts < tool.completedAt &&
          tool.completedAt <= event.ts &&
          tool.status === 'completed',
        'active_tool_interrupted_or_no_boundary',
        `${at}.activeTool`,
      );
    }
    if (admission.mode === 'steering')
      check(
        isSteering &&
          sameScope(execution, {
            sessionId: admission.targetSessionId,
            ...record(admission.execution),
          }),
        'steering_execution_changed',
        `${at}.consumption`,
      );
    p.consumption = isSteering ? 'same_turn_steering' : 'root';
    const terminal = evidence(step.terminal, `${at}.terminal`);
    check(
      sameScope(terminal, execution) &&
        terminal.status === 'completed' &&
        identity(terminal.terminalEventId),
      'execution_not_settled_completed',
      `${at}.terminal`,
    );
    if (terminal.status === 'completed') p.settlement = 'completed';
  }
  for (const fact of newFacts)
    check(
      seenEffects.has(text(record(fact).id)),
      'unsolicited_or_duplicate_effect',
      `factsAfter.${text(record(fact).id)}`,
    );
  for (const call of writeCalls)
    check(
      seenCalls.has(`${text(call.turnId)}:${text(call.toolCallId)}`),
      'unsolicited_write_call',
      `toolCalls.${text(call.toolCallId)}`,
    );

  const setup = evidence(c.setup, 'setup');
  if (spec.id === 'T01') {
    check(
      ['natural', 'tagged-isolated-fixture'].includes(text(run.history)),
      'old_task_provenance_missing',
      'run.history',
    );
    check(
      before.some(
        (f) =>
          factWork(f) === record(bindings.old).workId && text(record(f).userText).includes('空格'),
      ),
      'historical_task_missing',
      'factsBefore',
    );
    if (run.history === 'natural')
      check(
        count(setup.oldCreatedAt) &&
          count(run.startedAt) &&
          run.startedAt - setup.oldCreatedAt >= 9 * 24 * 60 * 60 * 1000,
        'natural_old_task_not_nine_days',
        'setup.oldCreatedAt',
      );
  }
  if (spec.id === 'T02')
    check(
      setup.previewWorkId === record(bindings.a).workId &&
        setup.mainTopicWorkId === record(bindings.b).workId,
      'preview_main_context_unproven',
      'setup',
    );
  if (spec.id === 'J07')
    check(
      setup.coordinatorHistory === 'empty' &&
        Array.isArray(setup.antecedentWorkIds) &&
        setup.antecedentWorkIds.length === 0,
      'no_antecedent_unproven',
      'setup',
    );
  if (spec.id === 'T13') {
    const stale = record(setup.undeliveredFollowup);
    check(
      identity(stale.messageId) &&
        stale.workId === record(bindings.stale).workId &&
        text(stale.userText).trim() &&
        stale.consumption === null &&
        stale.coordinationStatus === 'cancelled',
      'undelivered_stopped_setup_unproven',
      'setup.undeliveredFollowup',
    );
    check(
      !newFacts.some((f) => factWork(f) === record(bindings.stale).workId),
      'stale_followup_resurrected',
      'factsAfter',
    );
    const staleText = text(stale.userText);
    if (staleText)
      check(
        !newFacts.some((f) =>
          text(record(f).delegationText ?? record(f).text).includes(staleText),
        ) &&
          !writeCalls.some((call) =>
            text(record(record(call.request).input).text).includes(staleText),
          ),
        'stale_followup_text_reused',
        'factsAfter',
      );
  }
  if (spec.id === 'T06-fresh') {
    const step = steps[0] ?? {};
    const old = evidence(step.previousSegment, 'steps.fresh.previousSegment');
    const fresh = record(step.admission);
    check(
      fresh.kind === 'delegation_assigned' &&
        fresh.disposition === 'create_new' &&
        old.sessionId !== fresh.targetSessionId &&
        old.workId === factWork(fresh),
      'fresh_segment_not_proven',
      'steps.fresh.admission',
    );
    const reads = evidenceList(step.historyReads, 'steps.fresh.historyReads').map(record);
    const ownActions = new Set(
      before
        .filter((f) => factWork(f) === record(bindings.a).workId)
        .map((f) => record(f).actionId),
    );
    const history: RecordValue[] = [];
    for (const read of reads) {
      check(
        sameScope(read, step.terminal) &&
          record(read.input).view === 'history' &&
          record(read.input).taskId === record(bindings.a).workId,
        'history_read_not_in_new_execution',
        'steps.fresh.historyReads',
      );
      const result = record(read.result);
      const page = record(result.history);
      check(
        result.status === 'ok' &&
          page.workId === record(bindings.a).workId &&
          page.contentScope === 'same_work_history',
        'history_unavailable_or_wrong_scope',
        'steps.fresh.historyReads',
      );
      history.push(...list(page.records).map(record));
    }
    for (const kind of ['user', 'tool_call', 'tool_result'])
      check(
        history.some((r) => r.kind === kind && text(r.text).length > 0),
        'required_history_kind_missing',
        `steps.fresh.historyReads.${kind}`,
      );
    check(
      history.some((r) => r.recordSource === 'task_input' && text(r.text).length > 0),
      'correction_history_missing',
      'steps.fresh.historyReads',
    );
    check(
      history.every((r) => ownActions.has(r.actionId)),
      'other_task_history_leaked',
      'steps.fresh.historyReads',
    );
  }

  const requests = evidenceList(c.requests, 'requests');
  check(requests.length > 0, 'model_requests_missing', 'requests');
  const attempts: WorkHubRequestObservation[] = [];
  for (const request of requests) {
    const observation = workHubRequestObservation(request);
    if (observation) attempts.push(observation);
  }
  check(attempts.length === requests.length, 'invalid_physical_request_record', 'requests');
  check(
    new Set(attempts.map((r) => r.attemptId)).size === attempts.length,
    'duplicate_usage_attempt',
    'requests',
  );
  for (const turnId of coordinatorTurns)
    check(
      attempts.some((a) => a.turnId === turnId),
      'coordinator_request_missing',
      `requests.${turnId}`,
    );
  for (const turnId of executionTurns)
    check(
      attempts.some((a) => a.turnId === turnId),
      'worker_request_missing',
      `requests.${turnId}`,
    );
  const sum = (
    key:
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadInputTokens'
      | 'cacheMissInputTokens'
      | 'cacheWriteInputTokens',
  ): number | null =>
    attempts.length > 0 &&
    attempts.length === requests.length &&
    attempts.every((r) => r[key] !== undefined)
      ? attempts.reduce((total, r) => total + (r[key] as number), 0)
      : null;
  const estimatedUsd =
    env.pricingVerified === true &&
    attempts.length > 0 &&
    attempts.length === requests.length &&
    attempts.every((r) => r.costBasis === 'priced' && r.costUsd !== undefined)
      ? attempts.reduce((total, r) => total + (r.costUsd as number), 0)
      : null;
  return {
    schemaVersion: 1,
    caseId: spec.id,
    revision: text(run.commit),
    durationMs: count(run.startedAt) && count(run.endedAt) ? run.endedAt - run.startedAt : null,
    mode: text(c.mode),
    verdict: issues.length ? 'fail' : 'pass',
    realModelPass: desktop && issues.length === 0,
    evidenceFiles: sources.evidenceFiles ?? 0,
    issues,
    phases,
    usage: {
      requests: requests.length,
      invalidRequestRecords: requests.length - attempts.length,
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cacheReadInputTokens: sum('cacheReadInputTokens'),
      cacheMissInputTokens: sum('cacheMissInputTokens'),
      cacheWriteInputTokens: sum('cacheWriteInputTokens'),
      missingUsageRequests:
        requests.length -
        attempts.length +
        attempts.filter((r) => r.usageBasis === 'missing').length,
      estimatedUsd,
      costClaim: 'connection_price_estimate_only',
      coverage: 'captured_attempts_only',
      sources: [...new Set(attempts.map((attempt) => attempt.source))],
    },
  };
}
