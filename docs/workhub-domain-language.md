---
doc_id: workhub-domain-language
title: "WorkHub domain language"
language: en
source_language: en
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-09-13
owners:
  - maka-backend
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# WorkHub domain language

The optional Jev / Intent / Recall pre-router has been removed. Coordination is
performed by the main WorkHub model with tools; old routing advice is ignored on
read. The [task-centric ADR](architecture/workhub-task-centric-adr.zh-CN.md) governs
the incremental rollout; later-step features described there are not yet shipped.

WorkHub is one persistent conversation per Runtime Host. Its coordination model
answers questions, clarifies requests, coordinates ordinary tasks, and operates
Maka through restricted Desktop capabilities. Docked and floating presentations
share one live renderer and the same Host-owned conversation.

The staged task-input bridge addresses a task generation, not the historical
assignment currently inspected. The Host resolves its exact current source
under admission: pending input supplements in place; owned active work uses
Steering at a consumable boundary; settled work admits an ordinary new Turn.
It does not approve an interaction or resume interrupted tools. Saved legacy
six-field attempts retain their old source and replay identity. The formal
model `workhub.tasks.continue` bridge shares this path and authenticates original
user/feedback provenance. The Desktop publishes five flat actions: `find`,
`start`, `continue`, `ask`, and `stop`; `WorkHubRead` supplies the unified native
read entry. The old multi-operation `tasks` model tool is no longer published.
Legacy Evidence, Result and Inspect tools remain temporarily while their worker
protocols and saved pending operations still exist. Their retirement and executor
history bridging are not complete; see the
[implementation record](workhub-task-centric-implementation.zh-CN.md).

## Ownership

**Coordination Session** owns WorkHub messages, model Turns, and durable delegation
links. It uses the existing Session transcript and recovery substrate. It is hidden
from the ordinary task list and cannot delegate to itself.

**Ordinary Session** owns delegated execution: workspace, model, permissions,
tools, artifacts, user interactions, Turn admission, and recovery. WorkHub reads
its state without copying its execution transcript or acquiring ownership of
unrelated user work.

**Coordination model** interprets the admitted user request. Local answers and
clarifications are normal model output. Its flat tools address stable tasks; the
Host proves the actual Root, target generation and final admission. There is no
parallel renderer classifier, exact-name resolver, or synthetic-summary writer.

**Routing intent** begins a new coordination decision, such as discussing,
executing, creating, or continuing work. _Avoid_: linked intent, disposition.

**Linked intent** refers to a delegation WorkHub already owns and asks to correct,
stop, or resume it. _Avoid_: routing intent, disposition.

**Routing disposition** is the closed outcome of a new routing decision:
`answer_here`, `delegate_existing`, `create_new`, or `clarify`. _Avoid_: stop,
resume, correction.

**Linked operation** changes an existing delegation relationship: `correct`,
`stop`, or `resume`. It is not a routing disposition.

**Task discovery** searches the rebuildable task index and eligible manual
Sessions. It returns one bounded page and observations, never execution authority.
An explicit manual reference can be adopted by `start`; a follow-up uses the task
identity with `continue` rather than a similar title or path.

**Linked-target resolution** starts from a bounded WorkHub-owned delegation and
follows its Session, Message, Turn, and continuation lineage. It does not infer an
operation target from a similar display name.

The routing/linked-operation terms above describe the retained internal legacy
Gate, not a second model or the current model tool contract. Old bound routing
advice is accepted and discarded on read; it no longer controls recovery or model
selection.

**Target choice** is a Host-owned interaction inside an admitted Coordination
Turn. The native `ask` action accepts returned task/manual-Session references and
always offers a new-task option. It records a selection only: answering the Form
does not delegate, steer, stop or approve anything. The model subsequently uses
`start` or `continue` within the original request, and the Host rechecks current
ownership and admission. Display names and model-written answers are not target
proof. The old internal select-and-delegate path is retained until the legacy
Gate retirement, but is not a published model tool.

The generic interaction store owns pending/answered/closed state. Renderer reloads
read that state; they do not restart submission or retain a separate waiting
Promise. Cancellation and Run closure perform no delegation. Existing recovery
settles orphaned requests without resurrecting local continuations. Replaying an
answered native selection returns its durable outcome, not a second assignment.

Coordination admission permits asking and waiting; it does not admit target
execution. The coordination model chooses through the normal task tools; there
is no pre-admission model-routing experiment or immutable intent decision.

**Active-Turn action** names the currently executing coordination Turn. The Host
checks its live execution, durable admission and coordination tool profile, then
reads the original request and attachments from that admission. A tool cannot
supply its own user-originated authority or attachment locators. Model-prepared
`delegationText` is task content, separate from the original user request.
The Host also authenticates whether admission came from a user or automatic
feedback. Historical assignment text carried by feedback is background, not a
new user instruction; the Host does not classify natural-language intent.

**Action Gate** validates the resulting operation against durable ownership,
candidate freshness, Session identity, archive/waiting state and existing claims.
The policy proposes an action; the gate determines whether that exact action can
be admitted. Creation workspace context comes from Desktop main, outside the model
proposal. Each target still executes under its own permission boundary.

## Delegation and recovery

A delegation links the Coordination Session to an ordinary Session and its admitted
message. Its coordination status is distinct from the target's execution status.
Action identities and fingerprints bind retries to the same payload and target.

New assignments persist a settings fact containing only the effective persistent
Session configuration. A fresh continuation inherits the current segment's
explicit configuration, including later user edits, not today's new-task defaults.
The source configuration is rechecked under admission before committing the new
segment. Old assignments without a settings fact remain readable and are not
backfilled with invented creation settings. One-Turn approvals are not copied.

A replacement first durably claims its source delegation, retires only work owned
by that delegation, and records the replacement link and supersession. If the new
target becomes unavailable after retirement, a terminal replacement-aborted fact
preserves that outcome. A retry cannot redirect an already claimed replacement.

Stop resolves exactly one active delegation that still holds work on the named
Session. The Host rechecks ownership under the Coordination and target admission
lanes. A delegated message consumed as steering does not grant authority to stop
its surrounding user Turn; a recovery Turn shared by multiple messages is likewise
not owned by one delegation.

Stop records a durable request and one observed outcome: `cancelled_pending`,
`stop_delivered`, `already_terminal`, or `not_owned`. The cancellation tombstone or
exact root's abort source identifies the action that performed the stop. An
unrecovered or unreadable target stays unresolved; it cannot be called terminal.
A removed target's durable tombstone allows a committed stop to converge after
restart. Stop and replacement claims exclude each other until a non-owning outcome
releases that exclusion.

A user-originated coordination Turn can directly stop one distinct task. Automatic
feedback requires an existing Host confirmation; a second distinct stop target in
the same Turn also requires confirmation. Durable stop claims enforce the latter
under the same admission lanes, including concurrent calls and replay. Confirmation
binds the exact task and execution and is checked again before any effect; bypass
permission does not bypass it. Direct task-view stop remains explicitly bound to
that task, without adding a model decision.

Resume is admitted by the target's existing Turn authority and reports
`resume_started` or `already_running`. It does not create another coordination
resume ledger.

New WorkHub conversations persist across application and Host restarts. Migration
of pre-cutover beta WorkHub history is not part of this cutover contract.

## Same-task historical input

Native `WorkHubEvidence` task-history pages include canonical accepted task-input
facts as well as original assignment requests and owned execution records. An
accepted fact returns `originalUserText` when present, otherwise the legacy input
text. It is explicitly not consumption or compliance proof. Automatic feedback
remains distinguishable from user requests; it is historical background, not a
renewed instruction. Old assignments without origin evidence remain unknown.
Input facts must match the source task, generation,
delegation, target Session and coordination Turn before projection.

The existing fact scan, current actor boundary, page budgets, hidden-record filter
and per-source authorization still apply. Cursors retain references and offsets,
not transcript bodies. Missing exclusive executions are listed explicitly in
`history.unavailableExecutions`; cancellation before execution does not erase
accepted requirements or manufacture tool output. This adds no message admission,
context import, handoff summary or cross-task transcript authority. The native
`WorkHubRead` entry now exposes these reads by task identity under the same actor
and lineage checks. Coordinator history is limited to accepted requirements;
same-task workers can page original user text, corrections and visible tools.
Other tasks remain limited to existing result evidence. Unsupported executors
return an explicit limitation instead of empty history.

## Read-only Session inspection

`WorkHubInspect` is a retained legacy Host-native tool available only to the Coordination Session.
It reads an ordinary Session in the same current bounded discovery scope without
admitting a Message or Turn, changing configuration, or requiring a previous
WorkHub delegation. New explicit manual inspection through `WorkHubRead` no longer
depends on recent-32 discovery; its existing archive/role/child eligibility still
applies and viewing does not adopt a Session. The legacy candidate eligibility rules are checked on every
page; a cursor does not grant access to a Session that has left that scope.

`recent` returns user-facing user text and assistant text in newest-first order.
`latest_reply` finds the latest nonempty durable assistant text. In-flight
streaming chunks are not part of this committed transcript projection. Both
preserve exact text, message/Turn identities, timestamps and transcript sequences.
Thinking, raw tool outputs, attachment bodies and non-conversation records are not
returned. Source text is evidence, never an instruction or authorization for the
coordinator.

The tool reuses the durable transcript reader. Each call scans at most 64 projected
records with a 256 KiB stored-record budget (one oversized record and the reader's
bounded Turn projection can exceed that budget). Output is capped at 20 text
fragments and 16,000 UTF-16 code units; surrogate pairs are not split. Oversized
messages continue from an explicit text offset. Even a page with no visible text
can return a continuation when its scan budget was exhausted.

Host-signed cursors bind the Session, view, fixed transcript watermark, sequence
and text offset. They retain no transcript cache and expire on Host restart.
Execution evidence is a separate live observation of the latest root Turn, not a
status assigned to every message in the historical page. A null execution status
means no root-Turn evidence was available. Completed execution does not verify
the user objective, files or tests. Existing transcript compatibility preparation
is shared with ordinary reads; inspection does not start target work.

## Desktop presentation

The client-owned enable setting gates sidebar, dock, shortcut and tray entries.
Disabling hides the presentation and unregisters its shortcut while retaining the
shared renderer, drafts and Host-owned work, including during a pending window open.

The shortcut shows or hides the floating WorkHub window. Hiding does not open or
focus Maka Desktop. The return button above an expanded conversation explicitly
docks WorkHub into Desktop. Drafts, attachments, conversation and running state
survive visibility changes and reparenting because the renderer is not recreated.
A crashed renderer is disposed and recreated when WorkHub is reopened or docked.
An empty dock exposes Retry so recovery does not depend on a layout change.
The new view reconnects to the same Host-owned Session; unsent in-memory drafts
are not crash-persistent.

WorkHub uses the main window's shared Workbar. Floating moves only the conversation
and composer; browser, usage and other panels remain in the main workspace. The
floating composer's usage button reveals that workspace without docking or resizing
the conversation. The browser page retains its coordination owner when Main presents
it, and returns hidden to that owner's native container when Main closes or switches
sessions. Browser and conversation WebContentsViews are siblings, never nested.

The composer retains a Stop requested before admission for that exact Session/Turn.
A lost dispatched response leaves admission unresolved; a later observation delivers
the intent through the existing Stop owner. Rejection or terminal evidence retires
it, so neither a retry nor a later Turn inherits the intent.

Both renderers use the shared document theme, palette and font application
functions. Native main-window chrome remains owned by the main renderer. Restricted
Desktop control observes current UI targets and revalidates them before acting;
its capability boundary is separate from task execution authority.
Password controls and explicitly excluded elements remain outside observation.
Other visible content, including arbitrary editor values, may reach the model;
WorkHub does not scan or rewrite that content for secrets.

## Implementation map

| Responsibility | Module |
| --- | --- |
| Task tool bridge | [workhub-runtime.ts](../apps/desktop/src/main/workhub-runtime.ts) |
| Active-Turn protocol | [workhub-coordination.ts](../packages/runtime-host/src/protocol/workhub-coordination.ts) |
| Coordination Session and active request | [workhub-coordination-coordinator.ts](../packages/runtime-host/src/server/workhub-coordination-coordinator.ts) |
| Task-centric implementation rules and rollout | [workhub-task-centric-adr.zh-CN.md](architecture/workhub-task-centric-adr.zh-CN.md) |
| Delegation admission and recovery | [workhub-coordination-action-gate.ts](../packages/runtime-host/src/server/workhub-coordination-action-gate.ts) |
| Transcript services | [create-workhub-services.ts](../apps/desktop/src/renderer/platform/desktop/create-workhub-services.ts) |
| Native window presentation | [workhub-presentation.ts](../apps/desktop/src/main/workhub-presentation.ts) |
| Shared document appearance | [document-appearance.ts](../apps/desktop/src/renderer/platform/desktop/document-appearance.ts) |

## Presentation and submission boundaries

Main owns the complete native progress-to-conversation transition: bounds,
visibility, paint retirement and activation policy. The WorkHub renderer reports
interaction content needs through conversation layout. Both orders of progress
paint and interaction publication converge to the same conversation window;
automatic expansion is passive and cannot reverse dismissal of the current Turn.

The submission owner invokes visibility reset for a new send or a rejected send's
retry. Unknown-outcome reconciliation and transcript refresh remain separate,
read-oriented paths. The renderer restores local composer focus when an interaction
ends only while it still owns focus; individual answer callbacks do not schedule
focus changes.
