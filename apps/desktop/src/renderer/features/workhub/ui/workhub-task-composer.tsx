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

import { useEffect, useRef, type RefObject } from 'react';
import { Composer, Button, useUiLocale, type ComposerHandle } from '@maka/ui';
import { ChevronDown, CornerDownRight } from 'lucide-react';
import type { WorkHubServices } from '../ports.js';
import type { useWorkHubTaskView } from '../controller/use-workhub-task-view.js';
import { useWorkHubTaskInput } from '../controller/use-workhub-task-input.js';
import { workHubTaskInputCopy } from '../locales/workhub-task-input-copy.js';
import { workHubTaskViewCopy } from '../locales/workhub-task-view-copy.js';

export function WorkHubTaskComposer({ services, owner, workId, name, view, composerRef }: {
  services: WorkHubServices; owner: string; workId: string; name: string; view: ReturnType<typeof useWorkHubTaskView>; composerRef?: RefObject<ComposerHandle | null>;
}) {
  const locale = useUiLocale(), t = workHubTaskInputCopy[locale];
  const input = useWorkHubTaskInput(services, owner, workId, view);
  const { state, model } = input;
  const localComposer = useRef<ComposerHandle>(null);
  const composer = composerRef ?? localComposer;
  useEffect(() => {
    // Reconciliation after reload may confirm a send whose response was lost.
    // The model clears only its unchanged submitted draft, never a newer edit.
    const text = model.readDraft();
    if (composer.current?.getDraft(model.key) !== text) composer.current?.setDraft(model.key, text);
  }, [composer, model, state.draftVersion]);
  const unknown = !!state.attempt && !state.receipt && !state.rejected;
  const error = state.error ? t.error[state.error] : state.rejected?.message;
  const blocked = !view.ready ? t.unavailable : !input.source ? t.history : input.session?.backend === 'plugin-executor' ? t.unsupported : !input.ready ? t.sessionUnavailable : undefined;
  return <section className="workHubTaskComposer" data-work-input={workId} aria-label={t.title}>
    <p className="workHubTaskInputTarget"><CornerDownRight size={14} aria-hidden="true" />{t.address.replace('{name}', name)}</p>
    {blocked && <p role="status">{blocked}{!input.source && view.ready && <Button size="sm" variant="ghost" label={workHubTaskViewCopy[locale].follow} onClick={view.followLatest} />}</p>}
    {error && <p role="alert">{error}</p>}
    {state.recoveryUnsafe && state.error !== 'storage' && <p role="alert">{t.error.storage}</p>}
    {state.attempt && <details className="workHubTaskInputDetails">
      <summary><span>{t.lastInput}</span>{state.receipt && <span className="workHubTaskReceipt" role="status" data-input-id={state.receipt.inputId} data-input-delivery={state.receipt.delivery}>{t.delivery[state.receipt.delivery]}</span>}<ChevronDown size={14} aria-hidden="true" /></summary>
      <div><h4>{t.original}</h4><p>{state.attempt.input.text}</p><p className="workHubTaskHint">{t.deliveryHint}</p><code>{state.attempt.input.generationId} / {state.attempt.input.sourceActionId}</code></div>
    </details>}
    {unknown && <div className="workHubTaskInputRecovery">
      <p>{t.pending}</p>
      <Button size="sm" variant="ghost" label={t.check} isDisabled={state.reconciling} onClick={() => { void model.reconcile(); }} />
      <Button size="sm" variant="ghost" label={t.retry} isDisabled={!view.ready || state.sending} onClick={() => { void model.retry(); }} />
    </div>}
    {input.stopFailed && <p role="alert">{t.stopFailed}</p>}
    <Composer ref={composer} draftKey={model.key} draftPersistence={input.persistence}
      placeholder={t.placeholder} onSend={input.send} onStop={input.stop}
      streaming={input.canStop} stopPending={input.stopPending}
      sendBlocked={!input.ready || state.sending || unknown} sendBlockedReason={blocked ?? (unknown ? t.pending : undefined)}
      activeSession={input.session} activeModel={input.session?.model} pickersReadOnly
      activeModelConnectionId={input.session?.llmConnectionId} activeModelConnectionSlug={input.session?.llmConnectionSlug}
      showStaticModelUnavailableStatus={false} />
    <p className="workHubTaskInputHint">{t.scopeHint}</p>
  </section>;
}
