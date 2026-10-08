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
import { FormInteractionPrompt, UserQuestionPrompt, useUiLocale } from '@maka/ui';
import type { ChatModelChoice } from '@maka/core/chat-model-choice';
import type { WorkHubPendingInteraction } from '@maka/runtime-host/protocol';
import type { useWorkHubTaskInbox } from '../controller/use-workhub-task-inbox.js';
import { useWorkHubServices } from '../services.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';

type Inbox = ReturnType<typeof useWorkHubTaskInbox>;

export function WorkHubTaskInbox({ inbox }: { inbox: Inbox }) {
  const services = useWorkHubServices();
  const copy = workHubLiveCopy[useUiLocale()];
  const [expanded, setExpanded] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  if (!inbox.requests.length && !inbox.grants?.length && !inbox.error) return null;
  return <section className="workHubTaskInbox" data-maka-assistant-exclude aria-label={copy.taskInbox}>
    <header><strong>{copy.taskInbox} · {inbox.requests.length}</strong>
      <Button variant="ghost" size="sm" label={copy.retry} onClick={() => { void inbox.refresh(); }} />
    </header>
    {inbox.error && <p role="alert">{inbox.error}</p>}
    {openError && <p role="alert">{openError}</p>}
    <div className="workHubTaskInboxItems">
      {inbox.requests.map((item) => {
        const key = JSON.stringify([item.interaction.sessionId, item.interaction.interactionId, item.interaction.runId]);
        const open = expanded === key;
        return <article key={key}>
          <div className="workHubTaskInboxHeading">
            <Button className="workHubTaskInboxExpand" variant="ghost" size="sm" aria-expanded={open}
              onClick={() => setExpanded(open ? undefined : key)}
              label={`${item.targetSessionName} · ${item.interaction.request.kind === 'question' ? copy.taskQuestion
                : item.interaction.request.kind === 'form' ? copy.taskForm : copy.taskPermission}`} />
            <Button variant="ghost" size="sm" label={copy.openWork} onClick={() => { setOpenError(undefined); void services.presentation.openSession(item.interaction.sessionId).catch((reason) => setOpenError(reason instanceof Error ? reason.message : String(reason))); }} />
          </div>
          {open && <TaskRequest item={item} inbox={inbox} />}
        </article>;
      })}
    </div>
    {!!inbox.grants?.length && <div className="workHubTaskInboxItems">
      <strong>{copy.taskGrants}</strong>
      {inbox.grants.map((item) => <article key={item.grant.grantId}>
        <p>{item.targetSessionName} · {copy.taskGrantExpires} {new Date(item.grant.expiresAt).toLocaleString()}</p>
        <pre>{JSON.stringify(item.grant.resource, null, 2)}</pre>
        <Button variant="ghost" size="sm" label={copy.taskRevoke} isDisabled={!inbox.ready || inbox.isRevoking(item)}
          onClick={async () => {setOpenError(undefined); try {await inbox.revoke(item);} catch (reason) {setOpenError(reason instanceof Error ? reason.message : String(reason));}}} />
      </article>)}
    </div>}
    {inbox.truncated && <p>{copy.taskInboxTruncated}</p>}
  </section>;
}

function TaskRequest({ item, inbox }: { item: WorkHubPendingInteraction; inbox: Inbox }) {
  const services = useWorkHubServices();
  const copy = workHubLiveCopy[useUiLocale()];
  const { interaction } = item;
  const request = interaction.request;
  // A published Interaction request is immutable. Keep its question event
  // stable across inbox refresh/busy changes so the shared prompt keeps drafts.
  const [questionEvent] = useState(() => request.kind === 'question' ? {
    id: interaction.interactionId, requestId: interaction.interactionId, turnId: interaction.turnId, ts: 0,
    type: 'user_question_request' as const, toolUseId: request.toolUseId,
    questions: request.questions.map((q) => ({ ...q, options: [...q.options] })),
  } : undefined);
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<ChatModelChoice[]>();
  const [choiceRevision, setChoiceRevision] = useState(0);
  const needsModels = request.kind === 'form' && request.fields.some((field) => field.kind === 'string' && field.presentation === 'model_picker');
  useEffect(() => {
    if (!needsModels) return;
    let disposed = false;
    setError(undefined);
    void services.modelChoices(interaction.sessionId).then((result) => {
      if (!disposed) setChoices(result);
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { disposed = true; };
  }, [services, interaction.sessionId, needsModels, choiceRevision]);
  const disabled = !inbox.ready || inbox.isAnswering(item);
  const base = { id: interaction.interactionId, requestId: interaction.interactionId, turnId: interaction.turnId, ts: 0 };
  if (request.kind === 'question' && questionEvent) return <UserQuestionPrompt
    request={questionEvent}
    stopPending={disabled}
    onRespond={(response) => inbox.respond(item, { kind: 'question', answers: response.answers })}
  />;
  if (request.kind === 'form') return <>
    {error && <p role="alert">{error}</p>}
    {needsModels && !choices && error && <Button variant="ghost" label={copy.retry} onClick={() => setChoiceRevision((value) => value + 1)} />}
    {(!needsModels || choices) && <FormInteractionPrompt
      request={{ ...base, type: 'form_request', toolUseId: request.toolUseId, message: request.message, requester: request.requester, fields: request.fields }}
      modelChoices={choices}
      stopPending={disabled}
      onRespond={(response) => {
        const { requestId: _requestId, ...answer } = response;
        return inbox.respond(item, { kind: 'form', ...answer });
      }}
    />}
  </>;
  // Only explicit sandbox/client requests may receive supplemental task authority.
  // Ordinary tool decisions keep their existing reviewer authority.
  return <div className="workHubTaskPermission">
    <p>{request.kind === 'permission' ? copy.taskOriginalAuthority : copy.taskGrantScope}</p>
    <pre>{JSON.stringify(request, null, 2)}</pre>
    {error && <p role="alert">{error}</p>}
    {(request.kind === 'sandbox_boundary' || request.kind === 'client_capability') &&
      <Button label={copy.taskAllow} isDisabled={disabled} onClick={async () => {
        setError(undefined);
        try {await inbox.respond(item, {kind: request.kind, decision: 'allow'}, 'task');}
        catch (reason) {setError(reason instanceof Error ? reason.message : String(reason));}
      }} />}
    {(request.kind === 'sandbox_boundary' || request.kind === 'client_capability') &&
      <Button variant="ghost" label={copy.taskDeny} isDisabled={disabled} onClick={async () => {
        setError(undefined);
        try { await inbox.respond(item, { kind: request.kind, decision: 'deny' }); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
      }} />}
  </div>;
}
