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

import { WORKHUB_TASK_INPUT_TEXT_MAX_BYTES, type WorkHubTaskInputRequest } from '@maka/core/workhub-task-input';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { WorkHubTaskAssignment, WorkHubTaskInputResult } from '@maka/runtime-host/protocol';
import { isRecord } from '@maka/core/record-schema';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import type { WorkHubServices } from '../ports.js';
import type { WorkHubTaskViewSnapshot } from './task-view-model.js';

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface Attempt { input: WorkHubTaskInputRequest; targetSessionId: string; draftVersion: number; editorDraft: string }
interface Recovery { draft: string; draftVersion: number; attempt?: Attempt }
export interface WorkHubTaskInputSnapshot extends Recovery {
  readonly sending: boolean;
  readonly reconciling: boolean;
  readonly recoveryUnsafe: boolean;
  readonly receipt?: WorkHubTaskInputResult;
  readonly rejected?: { code: string; message: string };
  readonly error?: 'storage' | 'length' | 'unknown' | 'identity';
}
const entity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const sourceFields = ['workId', 'generationId', 'sourceActionId', 'sourceDelegationId'] as const;

/** Historical inspection never silently turns a direct send into a different source. */
export function workHubTaskInputSource(view: WorkHubTaskViewSnapshot): WorkHubTaskAssignment | undefined {
  const a = view.assignment;
  if (!view.ready || !view.executionsReady || !a || a.superseded ||
      a.actionId !== view.assignments[0]?.actionId || ['cancelled', 'unavailable'].includes(a.state)) return undefined;
  const latest = view.executions.at(-1);
  if (view.execution && (view.execution.turnId !== latest?.turnId || view.execution.runId !== latest.runId)) return undefined;
  return a;
}

function rendererStorage(): RecoveryStorage | undefined {
  try { return typeof sessionStorage === 'undefined' ? undefined : sessionStorage; }
  catch { return undefined; }
}

/** Renderer recovery only. Accepted input and delivery authority remain in the Host ledger. */
export function createWorkHubTaskInputModel(
  services: Pick<WorkHubServices, 'sendTaskInput' | 'readTaskInput'>,
  owner: string,
  workId: string,
  currentSource: () => WorkHubTaskAssignment | undefined,
  storage: RecoveryStorage | undefined = rendererStorage(),
  newId: () => string = () => crypto.randomUUID(),
) {
  const host = parseDesktopSessionKey(owner);
  if (host.sessionId !== WORKHUB_COORDINATION_SESSION_ID || !entity(workId)) throw new Error('Invalid task input scope');
  const key = JSON.stringify(['workhub-task-input-v1', owner, workId]);
  const listeners = new Set<() => void>();
  let closed = false;
  let sending = false;
  let reading: Promise<void> | undefined;
  let corrupt = false;
  let recoveryError = false;
  let recovery: Recovery = { draft: '', draftVersion: 0 };
  let state: WorkHubTaskInputSnapshot = { ...recovery, sending: false, reconciling: false, recoveryUnsafe: false };

  function readRecovery(): Recovery {
    const raw = storage?.getItem(key);
    if (!raw) return { draft: '', draftVersion: 0 };
    if (raw.length > 1024 * 1024) throw new Error('Recovery record exceeds its bound');
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || typeof value.draft !== 'string' || value.draft.length > 120000 ||
        !Number.isSafeInteger(value.draftVersion) || (value.draftVersion as number) < 0) throw new Error('Invalid input recovery');
    const result: Recovery = { draft: value.draft, draftVersion: value.draftVersion as number };
    if (value.attempt !== undefined) {
      const a = value.attempt;
      if (!isRecord(a) || !isRecord(a.input)) throw new Error('Invalid pending task input');
      const input = a.input;
      if (Object.keys(input).length !== 6 ||
          !entity(input.inputId) || !sourceFields.every(field => entity(input[field])) || input.workId !== workId ||
          typeof input.text !== 'string' || !input.text.trim() ||
          new TextEncoder().encode(input.text).length > WORKHUB_TASK_INPUT_TEXT_MAX_BYTES ||
          typeof a.targetSessionId !== 'string' || parseDesktopSessionKey(a.targetSessionId).hostId !== host.hostId ||
          !Number.isSafeInteger(a.draftVersion) || (a.draftVersion as number) < 0 || (a.draftVersion as number) > result.draftVersion ||
          (a.editorDraft !== undefined && (typeof a.editorDraft !== 'string' || a.editorDraft.length > 120000))) throw new Error('Invalid pending task input');
      result.attempt = { input: input as unknown as WorkHubTaskInputRequest, targetSessionId: a.targetSessionId, draftVersion: a.draftVersion as number,
        // Older reservations have no editor snapshot. Only their unchanged
        // version can use the saved draft; a later edit must never be cleared.
        editorDraft: typeof a.editorDraft === 'string' ? a.editorDraft : result.draftVersion === a.draftVersion ? result.draft : input.text };
    }
    return result;
  }
  function persist(next: Recovery) {
    try {
      if (!storage) throw new Error('Reload-safe recovery storage unavailable');
      if (next.draft.length > 120000 || !Number.isSafeInteger(next.draftVersion)) throw new Error('Draft exceeds the recovery bound');
      const raw = JSON.stringify(next);
      if (raw.length > 1024 * 1024) throw new Error('Recovery record exceeds its bound');
      storage.setItem(key, raw);
      recoveryError = false;
    } catch (error) { recoveryError = true; throw error; }
  }
  function publish(patch: Partial<WorkHubTaskInputSnapshot>) {
    state = { ...state, ...recovery, ...patch, recoveryUnsafe: recoveryError,
      ...(recoveryError && patch.error !== 'length' && patch.error !== 'identity' ? { error: 'storage' as const } : {}) };
    if (!closed) for (const listener of listeners) listener();
  }
  try { recovery = readRecovery(); publish({ ...(recovery.attempt ? { error: 'unknown' as const } : {}) }); }
  catch { corrupt = true; recoveryError = true; publish({ error: 'storage' }); }

  function accept(attempt: Attempt, receipt: WorkHubTaskInputResult): boolean {
    if (state.attempt?.input.inputId !== attempt.input.inputId) return false;
    if (receipt.inputId !== attempt.input.inputId || receipt.targetSessionId !== attempt.targetSessionId ||
        sourceFields.some(field => receipt[field] !== attempt.input[field]) ||
        (state.receipt && (receipt.acceptedAt !== state.receipt.acceptedAt || receipt.targetMessageId !== state.receipt.targetMessageId || receipt.mode !== state.receipt.mode))) {
      publish({ error: 'identity' }); return false;
    }
    // A failed or weaker later read cannot erase immutable delivery evidence.
    const proven = state.receipt && ['delivered', 'cancelled'].includes(state.receipt.delivery);
    publish({ receipt: proven ? state.receipt : receipt, rejected: undefined, error: undefined });
    // Failed edits belong to this editor, not a cross-mount version order.
    // A late receipt cannot write that RAM over another owner's saved draft.
    // Keep the warning until the active editor actually persists its edits.
    if (recoveryError && (recovery.draftVersion !== attempt.draftVersion || recovery.draft !== attempt.editorDraft)) return true;
    // Another mounted owner may have edited this work while this IPC awaited.
    // Read its latest reservation, and clear only this exact, unedited draft.
    try {
      const latest = readRecovery();
      if (latest.attempt?.input.inputId === attempt.input.inputId && latest.draftVersion === attempt.draftVersion && latest.draft === attempt.editorDraft) {
        const next = { ...latest, draft: '', draftVersion: latest.draftVersion + 1 };
        persist(next);
        if (recovery.draftVersion === attempt.draftVersion && recovery.draft === attempt.editorDraft) { recovery = next; publish({ error: undefined }); }
      } else if (latest.attempt?.input.inputId === attempt.input.inputId && !latest.draft && recovery.draftVersion === attempt.draftVersion && recovery.draft === attempt.editorDraft) {
        recovery = latest; recoveryError = false; publish({ error: undefined });
      }
    } catch { recoveryError = true; publish({ error: 'storage' }); }
    return true;
  }
  async function dispatch(attempt: Attempt): Promise<boolean> {
    if (closed || sending) return false;
    sending = true; publish({ sending: true, error: undefined, rejected: undefined });
    try {
      const result = await services.sendTaskInput(owner, attempt.input);
      if (state.attempt?.input.inputId !== attempt.input.inputId) return false;
      if (result.kind === 'accepted') return accept(attempt, result.receipt);
      // A successful concurrent reconciliation outranks a lost command receipt.
      if (state.receipt) return true;
      publish(result.kind === 'rejected' ? { rejected: result, error: undefined } : { error: 'unknown' });
      return false;
    } catch {
      if (state.attempt?.input.inputId === attempt.input.inputId && !state.receipt) publish({ error: 'unknown' });
      return !!state.receipt;
    } finally { sending = false; publish({ sending: false }); }
  }
  return {
    key,
    snapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readDraft: () => recovery.draft,
    writeDraft(text: string) {
      if (closed || (text === recovery.draft && !recoveryError)) return;
      if (text !== recovery.draft) recovery = { ...recovery, draft: text, draftVersion: recovery.draftVersion + 1 };
      try { if (corrupt) throw new Error('Unreadable recovery must not be overwritten'); persist(recovery); publish({ error: state.error === 'storage' ? undefined : state.error }); }
      catch { recoveryError = true; publish({ error: 'storage' }); }
    },
    async send(source: WorkHubTaskAssignment, text: string): Promise<boolean> {
      const current = currentSource();
      if (closed || sending || !current || current.workId !== workId || source.workId !== workId ||
          ['generationId', 'actionId', 'delegationId', 'targetSessionId'].some(field => current[field as keyof WorkHubTaskAssignment] !== source[field as keyof WorkHubTaskAssignment])) return false;
      if (state.attempt && !state.receipt && !state.rejected) return false;
      if (corrupt) { publish({ error: 'storage' }); return false; }
      if (!text.trim() || new TextEncoder().encode(text).length > WORKHUB_TASK_INPUT_TEXT_MAX_BYTES) { publish({ error: 'length' }); return false; }
      const attempt: Attempt = {
        input: { inputId: newId(), workId, generationId: source.generationId, sourceActionId: source.actionId, sourceDelegationId: source.delegationId, text },
        targetSessionId: source.targetSessionId, draftVersion: recovery.draftVersion, editorDraft: recovery.draft,
      };
      try {
        if (!entity(attempt.input.inputId) || !sourceFields.every(field => entity(attempt.input[field])) || parseDesktopSessionKey(attempt.targetSessionId).hostId !== host.hostId) throw new Error('Input source changed Host');
      } catch { publish({ error: 'identity' }); return false; }
      const next = { ...recovery, attempt };
      try { persist(next); }
      catch { publish({ error: 'storage' }); return false; }
      recovery = next; publish({ receipt: undefined, rejected: undefined, error: undefined });
      return dispatch(attempt);
    },
    async retry(): Promise<boolean> {
      if (closed || sending || !state.attempt || state.receipt) return false;
      // Same ID, payload and old source; never copy a pending attempt onto a
      // newly selected generation. The Host still validates an uncommitted ID.
      return dispatch(state.attempt);
    },
    reconcile(): Promise<void> {
      if (closed || !state.attempt || reading || (!recoveryError && state.receipt && ['delivered', 'cancelled'].includes(state.receipt.delivery))) return reading ?? Promise.resolve();
      const attempt = state.attempt;
      publish({ reconciling: true });
      const task = (async () => {
        try { accept(attempt, await services.readTaskInput(owner, { workId, inputId: attempt.input.inputId })); }
        catch {
          // not_found is not proof of rejection: the original command may
          // still be arriving. Do not retire its ID or downgrade a receipt.
          if (state.attempt?.input.inputId === attempt.input.inputId && !state.receipt && !state.rejected) publish({ error: 'unknown' });
        }
      })().finally(() => { if (reading === task) { reading = undefined; publish({ reconciling: false }); } });
      reading = task;
      return task;
    },
    close() { closed = true; listeners.clear(); },
  };
}
