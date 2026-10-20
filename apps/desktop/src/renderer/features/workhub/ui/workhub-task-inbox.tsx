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

import { useEffect, useState } from 'react';
import { Button } from '@astryxdesign/core';
import { ClientCapabilityPrompt, FormInteractionPrompt, SandboxBoundaryPrompt, UserQuestionPrompt, useUiLocale } from '@maka/ui';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { InteractionAnswer, WorkHubPendingInteraction } from '@maka/runtime-host/protocol';
import type { useWorkHubTaskInbox } from '../controller/use-workhub-task-inbox.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

export type WorkHubTaskInboxState = ReturnType<typeof useWorkHubTaskInbox>;

/** The coordinator lists requests; the corresponding task renders the original prompt. */
export function WorkHubTaskInbox({ inbox, onView }: { inbox: WorkHubTaskInboxState; onView(item: WorkHubPendingInteraction): Promise<void> }) {
  const copy = workHubLiveCopy[useUiLocale()];
  const [error, setError] = useState<string>();
  if (!inbox.requests.length && !inbox.error) return null;
  return <section className="workHubTaskInbox" data-maka-assistant-exclude aria-label={copy.taskInbox}>
    <header><strong>{copy.taskInbox} · {inbox.requests.length}</strong>
      <Button variant="ghost" size="sm" label={copy.retry} onClick={() => { void inbox.refresh(); }} />
    </header>
    {(error || inbox.error) && <p role="alert">{error ?? inbox.error}</p>}
    <div className="workHubTaskInboxItems">
      {inbox.requests.map(item => <article key={JSON.stringify([item.interaction.sessionId, item.interaction.interactionId, item.interaction.runId])}>
        <Button variant="ghost" size="sm" isDisabled={!inbox.ready}
          label={`${item.targetSessionName} · ${item.interaction.request.kind === 'question' ? copy.taskQuestion : item.interaction.request.kind === 'form' ? copy.taskForm : copy.taskPermission}`}
          onClick={() => { setError(undefined); void onView(item).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />
      </article>)}
    </div>
    {inbox.truncated && <p>{copy.taskInboxTruncated}</p>}
  </section>;
}

export function WorkHubTaskRequest({ item, inbox }: { item: WorkHubPendingInteraction; inbox: WorkHubTaskInboxState }) {
  const services = useWorkHubServices();
  const copy = workHubLiveCopy[useUiLocale()];
  const { interaction } = item;
  const request = interaction.request;
  // The immutable original request identity owns both drafts and the answer.
  const [questionEvent] = useState(() => request.kind === 'question' ? {
    id: interaction.interactionId, requestId: interaction.interactionId, turnId: interaction.turnId, ts: 0,
    type: 'user_question_request' as const, toolUseId: request.toolUseId,
    questions: request.questions.map(q => ({ ...q, options: [...q.options] })),
  } : undefined);
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<ChatModelChoice[]>();
  const [choiceRevision, setChoiceRevision] = useState(0);
  const needsModels = request.kind === 'form' && request.fields.some(field => field.kind === 'string' && field.presentation === 'model_picker');
  useEffect(() => {
    if (!needsModels) return;
    let disposed = false;
    setError(undefined);
    void services.modelChoices(interaction.sessionId).then(result => { if (!disposed) setChoices(result); }, reason => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { disposed = true; };
  }, [services, interaction.sessionId, needsModels, choiceRevision]);
  const disabled = !inbox.ready || inbox.isAnswering(item);
  const base = { id: interaction.interactionId, requestId: interaction.interactionId, turnId: interaction.turnId, ts: 0 };
  async function respond(answer: InteractionAnswer) {
    setError(undefined);
    try { await inbox.respond(item, answer); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
  }
  return <section className="workHubTaskPermission" aria-busy={disabled} data-maka-assistant-exclude>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {request.kind === 'question' && questionEvent && <UserQuestionPrompt request={questionEvent} stopPending={disabled}
        onRespond={response => respond({ kind: 'question', answers: response.answers })} />}
      {request.kind === 'form' && <>
        {needsModels && !choices && error && <Button variant="ghost" label={copy.retry} onClick={() => setChoiceRevision(value => value + 1)} />}
        {(!needsModels || choices) && <FormInteractionPrompt
          request={{ ...base, type: 'form_request', toolUseId: request.toolUseId, message: request.message, requester: request.requester, fields: request.fields }}
          modelChoices={choices} stopPending={disabled}
          onRespond={response => { const { requestId: _requestId, ...answer } = response; return respond({ kind: 'form', ...answer }); }} />}
      </>}
      {request.kind === 'permission' && <>
        <h3>{request.prompt.toolName}</h3>
        <pre>{JSON.stringify(request.prompt.review, null, 2)}</pre>
        {request.prompt.kind !== 'tool_permission' && <pre>{JSON.stringify(request.prompt.risk, null, 2)}</pre>}
        <Button label={copy.taskAllowOnce} isDisabled={disabled} onClick={() => { void respond({ kind: 'permission', decision: 'allow', rememberForTurn: false }).catch(() => {}); }} />
        {request.prompt.kind === 'tool_permission' && request.prompt.rememberForTurnAllowed &&
          <Button label={copy.taskAllowTurn} isDisabled={disabled} onClick={() => { void respond({ kind: 'permission', decision: 'allow', rememberForTurn: true }).catch(() => {}); }} />}
        <Button variant="ghost" label={copy.taskDeny} isDisabled={disabled} onClick={() => { void respond({ kind: 'permission', decision: 'deny', rememberForTurn: false }).catch(() => {}); }} />
      </>}
      {request.kind === 'sandbox_boundary' && <SandboxBoundaryPrompt request={{ ...base, type: 'sandbox_boundary_request', toolUseId: interaction.interactionId, expansion: request.expansion, justification: request.justification }}
        onRespond={response => respond({ kind: 'sandbox_boundary', decision: response.decision })} />}
      {request.kind === 'client_capability' && <ClientCapabilityPrompt request={{ ...base, type: 'client_capability_request', toolUseId: request.toolUseId, ...request.target }}
        onRespond={response => respond({ kind: 'client_capability', decision: response.decision })} />}
    </fieldset>
  </section>;
}
