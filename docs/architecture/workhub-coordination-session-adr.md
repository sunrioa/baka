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

# ADR: One WorkHub Coordination Session per Runtime Host

- Status: Accepted
- Date: 2026-08-25
- Scope: WorkHub architecture
- Decision source: [Discussion #3286](https://github.com/apache/maka/discussions/3286#discussioncomment-18135855)
- Delivery tracker: [Issue #3492](https://github.com/apache/maka/issues/3492)

The one-Session ownership decision remains in force. This change establishes the
shared Intent, Recall, and deterministic Policy contracts plus a production-model
adapter, but it does not change the default routing strategy. The default can move
only after production-path comparative evidence required by the delivery tracker.
See the [current domain language](../workhub-domain-language.md).

## Context

### baka Step 5A: native task inbox

The Desktop WorkHub inbox is a bounded Host projection of original pending
Interactions, not a copy of questions into the Coordination Turn. Each item must
still belong to an active delegation's Message-owned root and current Turn/Run.
Queued Messages, historical shared Turns, replaced/stopped assignments and later
unrelated manual work confer no inbox response authority. Responses revalidate
that identity under both Session admission lanes and settle the original request.
Coordinator input and unrelated tasks do not wait on a relay model call.

The native inbox is excluded from the WorkHub window-control surface; answering
it is not a coordinator model tool. Questions and forms use the existing
Interaction authority. Existing Session-persistent sandbox/client-capability
grants may be inspected or denied there, but allowed only at the original task.
Tool permission decisions retain their original reviewer authority. Step 5A
does not introduce task grants, expiry/revocation, new permission defaults or a
second database. Those execution-scope/lifecycle contracts are implemented by
Step 5B below, not by restoring an old Session snapshot.

### baka Step 5B: supplemental task execution grants

The native inbox can approve an original sandbox-boundary or client-capability
request **for the assigned task**, list its active grants, and revoke them.
Ordinary tool permissions still use their original reviewer. Neither the model
nor a caller-supplied Session ID can create or redirect a task grant.

Each grant is an additive record in the existing `runtime.sqlite`, committed
atomically with the original request outcome. It names the delegation, original
Message-owned root Session/Turn/Run, requesting Session/Turn/Run, and boundary
revisions. Session defaults, model and working directory are not overwritten.
Client grants preserve the original provider/capability/evidence scope; path and
network grants reuse the existing sandbox expansion validation and OS backend.

Every tool reads authority with its fixed Session/Turn/Run/invocation identity.
Only the original logical root and authenticated child invocations with matching
immutable spawn lineage may use the supplement. Queued/manual work and later
tasks in the same Session do not inherit it. Existing child tool ceilings and
protected paths continue to apply.

Grants last at most one hour and end on revocation, expiry, cancellation,
completion, retirement, replacement, or a changed boundary revision. Closure is
durable before resource cancellation. Foreground calls and capability invocations
are fenced; task-authorized background shell resources retain their own lifetime
fence after the foreground tool returns. Revocation waits for their cleanup and
does not terminate unrelated Session resources. Cleanup failure drains the Host.

Reload/restart rebuilds only still-valid original scope from canonical execution
facts; closure cannot be replayed into fresh permission. This does not add a
Windows command backend or relax unsupported sandbox behavior.

Reload/reconnect queries canonical pending facts; late reads/receipts cannot
retarget a different Host. A lost response never automatically replays an
approval. The projection returns at most 32 requests and explicitly reports
truncation; handling them exposes the remaining requests, and original tasks
remain accessible.

WorkHub is intended to be one persistent conversational place where a user can ask
an ordinary question, clarify intent, continue existing work, or create new work.
R2.4 is a deterministic routing and context-continuity baseline that may also serve
as a future target resolver. It does not provide a persistent WorkHub conversation
and is not the final definition or authority boundary of WorkHub.

A persistent coordinator needs durable conversational continuity without creating
a second WorkHub database, event store, transcript substrate, or lifecycle
authority alongside Session.

## Decision

Each Runtime Host independently owns one stable WorkHub **Coordination Session**.
The Coordination Session is a special role of the existing Session, not a new
durable entity type or storage system. It reuses the existing Session, Turn,
transcript, model, recovery, and event infrastructure. Session remains the only
durable conversation and execution substrate.

The role is provisioned lazily when WorkHub first needs it and resolves to the same
Session after Runtime Host or application restarts. The Session role representation,
lookup, recovery, and per-Host UI resolution enforce this lifecycle contract. The
coordination transcript and typed action proposals use that same Session substrate.

The per-Host boundary is intentional. A Coordination Session coordinates only the
ordinary Sessions belonging to the same Runtime Host. Switching Runtime Hosts
selects the other Host's Coordination Session; the first milestone does not support
cross-Host coordination or a global Coordination Session.

The Coordination Session is hidden from the ordinary Session list and excluded
from every routing-candidate set. The Action Gate's self-route rejection remains a
defense in depth; it is not a substitute for keeping the Coordination Session out of
ordinary navigation and target discovery.

## Durable authority boundaries

| Concern | Durable authority |
| --- | --- |
| User messages sent in WorkHub, ordinary Q&A, clarification, coordination decisions, bounded delegation references, and coordination summaries | The active Runtime Host's Coordination Session |
| Concrete execution, project and filesystem scope, model and permission mode, root-Turn admission, tools, artifacts, recovery, archive/delete, and the authoritative execution transcript | The target ordinary Session |
| Aggregated WorkHub cards, filters, status summaries, and navigation aids | No durable authority; these are rebuildable projections of Session facts |

The Coordination Session is authoritative only for the coordination conversation.
It never acquires authority over an ordinary Session's execution or lifecycle.

## Routing dispositions, linked operations, and admission

Each routing objective resolves to one proposed **routing disposition**:

- `answer_here`: answer in the Coordination Session.
- `delegate_existing`: delegate concrete work to one bounded, valid ordinary
  Session.
- `create_new`: create an ordinary Session, then delegate concrete work to it.
- `clarify`: continue clarification in the Coordination Session without guessing a
  target or creating a Session.

Correction, stop, and resume are **linked operations** over a prior durable
delegation, not additional routing dispositions. Correction's replacement target
is still restricted to `delegate_existing` or explicit `create_new` admission.
Stop and resume follow the durable delegation-to-Session-to-Turn lineage rather
than inferring an operation target from a similarly named Session.

The decision flow is:

```text
user input
  -> intent analysis
  -> Session Resolver or linked-target resolution
  -> Coordination policy
  -> routing disposition or linked-operation proposal
  -> deterministic Action Gate
  -> owning Host / Session
```

Intent describes what the user wants; it does not select authority. The Session
Resolver returns bounded existing-Session evidence and never creates a Session.
Linked-target resolution starts from a bounded WorkHub-owned delegation and
follows its durable Message, Turn, and continuation lineage. Coordination policy
combines that evidence into an advisory proposal. Missing, stale, or ambiguous
linkage fails closed instead of falling back to name similarity.

All model and routing output is advisory. Before any write, a deterministic
**Action Gate** admits or rejects the proposed routing disposition or linked
operation. The gate
enforces Runtime Host and target validity, archive and waiting state, self-route
exclusion, explicit `create_new`, and existing tool and permission ceilings. For a
replacement, the gate additionally requires explicit correction evidence in the
trusted user text, claims the source delegation in Coordination transcript order,
and rejects any later competing replacement intent. Neither a model nor a routing
policy can directly authorize a write, Stop, or expansion of execution authority.

The optional model-routing adapter first calls a tool-free Intent model using the
Coordination Session's saved connection, model, and thinking setting. Only
`execute` and ordinary `continue` invoke a second tool-free Recall call. Recall sees
at most 32 candidates containing a request-scoped opaque reference, bounded
Session/workspace names, state, and recency bucket; it does not receive stable
Session identity, paths, file contents, tools, or capabilities. Intent sees the
current request and at most eight bounded user/assistant messages, but no candidates.

The deterministic Coordination Policy maps those assessments to one disposition or
linked operation. Invalid model output, provider failure, unavailable candidates,
empty recall, and ambiguity all fail closed to `clarify`; none implies `create_new`.
When that adapter is explicitly installed at composition, the result is stored on
the root-Turn admission and reused by recovery. Every fresh root, including queued
follow-ups and pending-message recovery, receives its own decision. The main
Coordination model receives that bound result in its Turn prompt. A side-effecting
proposal that changes its operation, candidate set, or candidate reference is
rejected before the existing Action Gate. `answer_here` and `clarify` remain normal
transcript outcomes.

Before any production default changes, model strategies must be compared through
the repository's existing `maka eval` Experiment/Cell/Attempt/Result path while
exercising the production projection and admission seams. A separate WorkHub-only
evaluation framework is deliberately not introduced here. The required evidence
must report Intent accuracy, recall-kind accuracy, Recall@K, MRR, outcome accuracy,
unsafe binds, implicit creation, unnecessary clarification, latency, token usage,
and cost separately.

Intent output contains no target. Session Resolver output contains only bounded
opaque candidate references; it cannot return creation or a disposition. Linked
target evidence is likewise advisory and cannot prove ownership. Model ranking or
tool selection alone cannot authorize work, and every resulting proposal still goes
through the Host-owned Gate with the original trusted user request.

## Delegation links rather than copies transcripts

A delegation persists only a bounded link between the coordination and execution
transcripts, such as:

```text
delegationId
coordinationTurnId
targetSessionId
targetMessageId
targetTurnId
disposition
```

The initial assignment link does not mirror the target Turn's execution lifecycle.
Target acceptance, running, waiting, completion, failure, abort, and recovery state
remain ordinary Session facts. WorkHub derives those states as read-only
projections and does not persist them as independent Coordination Session truth.
Linked correction records coordination-owned `active` / `superseded` / `aborted`
linkage without turning target execution status into WorkHub-owned state. Here,
`aborted` means the source link was retired but replacement admission could not
complete because the selected target became archived, disappeared, or began
waiting for user input. The renderer rebuilds active linkage from the complete
Coordination transcript separately from its bounded visible timeline, preserving
durable transcript sequence rather than wall-clock order.

The ordinary Session records the delegated request, tools, side effects, and
authoritative result. WorkHub may display a bounded projection or record a
coordination summary, but it does not copy the ordinary Session's complete
transcript into the Coordination Session. The assignment projection preserves
`create_new` so the visible card explicitly tells the user that WorkHub created a
new work item rather than merely saying that an existing item accepted the request.

Delegation linkage uses one closed, typed `delegation_assigned` record in the
existing Coordination Session transcript. Under the Coordination and target
Session admission authorities, one `runtime.sqlite` transaction commits that
record together with the target pending-message admission. For `create_new`, the
target Session metadata is created in the same transaction. The record carries the
exact user text, resolved target and target Message/Turn identities, creation
context, and stable display name. Its action fingerprint rejects conflicting reuse
of an action identity.

The transaction is the user-visible assignment boundary. Before commit neither
Session observes the work; after commit both the WorkHub linkage and target input
exist. Waking or continuing the in-memory executor happens only after commit. A
Host crash between commit and wake is handled by ordinary pending-message recovery,
so WorkHub does not own a second recovery state machine or compensation chain.
The `delegation_assigned` record itself projects the visible WorkHub turn; the
renderer does not append a second summary.

In baka, a new delegation to an active target is admitted as an ordinary
`next_turn` / `followup` Message, including when that target is waiting on its
original user request. It does not steer or stop the current Turn. Each queued
delegation starts its own successor Turn in acceptance order. WorkHub applies
the ordinary queue count, byte, snapshot and successor-admission capacity checks
under the same Session admission lease before atomically committing the assignment.
An idle target uses the existing native admission and starts when direct-worker
capacity is available.
Historical steering assignments remain readable; their shared-Turn ownership
and cancellation protections are unchanged. New admission does not overwrite
the target Session's permissions, model or working directory.

In baka, `RuntimePolicy.chatDefaults.workHubPermissionMode` stores the selected
Host's permission default for newly created WorkHub tasks. An absent value means
`ask`, independently of ordinary chat defaults. The WorkHub picker names this
new-task scope and requires confirmation before enabling `bypass`. Permission
defaults survive Host/Desktop restart; the existing model/executor preferences
remain process-local. Creation validates and stores the chosen boundary on the
new ordinary Session. The Coordination Session's internal `bypass` is never a
source for that boundary. Later default changes do not update existing tasks.
Reused and queued tasks continue to use their target Session's execution
authority, including the existing rejection of configuration changes while
a Turn is active. WorkHub does not introduce a permission override or another
sandbox authority.

In baka, `RuntimePolicy.chatDefaults.workHubMaxConcurrentSessions` limits direct
WorkHub root executions on that Host to an integer from 1 to 8 (absent means 3).
Assignment and exact source-Message proofs identify the roots; a historically
linked Session does not make unrelated manual Turns workers. Coordination and
subagent executions remain outside this budget. An epoch-local dispatch gate
waits before Runtime activation while the existing durable root remains
`admitted`; it is not a second persistent queue or execution owner. Live questions
and approvals keep their slot until the root actually retires. Raising the limit
wakes waiting roots; lowering allows existing executions to drain without killing
them. Stop fences cancel waiting roots without provider dispatch. Startup rebuilds
waiting order from durable admission time and retains strict recovery of already
dispatched Runs rather than replaying unknown effects. Cooperative handoff falls
back to existing cold recovery when a queued root has no Runtime owner to seal.

For a queued assignment, its admission Turn is not an execution-ownership claim;
the target Message remains the proof for its eventual successor Turn. Existing
Stop ambiguity checks still reject a Session with multiple working delegations
rather than choosing one implicitly. Crash recovery resumes durable pending
admissions; an orderly Host drain retains its existing queue-cancellation policy.

Correction reserves the replacement Message's queue capacity before writing a
replacement intent or retiring the source. The canonical snapshot capacity check
includes reservations for every admission, including ordinary submissions, queue
edits, Interactions and sandbox boundaries. Its private capacity projection does
not expose phantom Messages in the public queue, and counts an admitted reserved
Message only once. This applies while Stop is awaited, without holding a Session
admission lock across execution. Assignment consumes the reservation; any failure
releases it. A capacity rejection leaves the source intact and allows correction
with a new action identity. Reservations are transient admission guards, not
Messages or a second durable queue; recovery rechecks capacity from canonical facts.

The first-response contract is hybrid. The atomic `delegation_assigned` record is
an immediate durable acknowledgement, so WorkHub confirms acceptance without
waiting for target execution. The target Message is the stable delegation
identity. The assignment record's `targetTurnId` records its admission location;
the public receipt exposes `targetMessageId` and includes `targetTurnId` only
when Message authority proves actual execution ownership. WorkHub asks the
target Message authority which Turn durably consumed or admitted that Message,
then joins the resolved Turn's recorded lifecycle and the target Session's exact
live-Turn membership to project `running`, `waiting_for_user`, `completed`,
`failed`, and `aborted`. This remains correct when an unconsumed steering Message
is folded into a successor Turn or recovery aggregates several pending Messages
under one new Turn. A durable cancellation tombstone for a retracted queued
Message resolves the delegation to `aborted`. If the target authority is
temporarily unreadable, WorkHub projects `recovering` rather than inventing a
terminal result. These execution states are never appended as mutable Coordination
records; Session change notifications invalidate the projection and opening
WorkHub after restart rebuilds it from the same link and target facts.

The renderer persists only a Host-scoped action id until acknowledgement. Composer
draft text uses a separate storage key and lifecycle. A reload therefore preserves
idempotency without freezing old text or coupling draft edits to Host authority.
Queue exhaustion remains a local, retryable result because no assignment has yet
been committed. A target waiting for user input can accept a queued delegation,
but Resume cannot bypass that target's original pending interaction.

Before any destructive retirement, replacement persists a
`delegation_replacement_requested` record whose identity is unique to the source
delegation. The target Session's ordinary Message authority then either cancels
the exact still-pending delegated Message or resolves how the Message entered an
execution Turn. A root Turn created by that Message may be stopped; a pre-existing
user Turn that merely consumed it as steering is shared authority and must remain
running. Replacement assignment and the old link's `delegation_superseded` proof
commit atomically. Retrying the same action recovers the crash seam after
retirement/Stop and before replacement assignment. The replacement fingerprint
binds the resolved stable target Session id rather than its transient candidate
reference, so metadata refreshes do not change action identity and a retry cannot
select a different Session. If the target becomes archived or unavailable
after the destructive retirement boundary, Coordination appends a
`delegation_replacement_aborted` terminal fact. That auditable fact removes the
retired source from active linkage and makes later retries return the same terminal
outcome instead of displaying a stopped, unsuperseded link.

Direct stop resolves its target through the shared Session Resolver, then asks the
Host which of that Session's delegations still hold stoppable work before it
answers the user or proposes anything. WorkHub projections are rebuildable and may
be empty when a window opens, so a destructive answer is never given from one. The
proposal then carries only what resolution produced: the opaque delegation identity
and the Session it belongs to. Display names are retrieval evidence on the proposal side and never
appear in admission, and the proposal asserts no proof of its own — the Host makes
those from durable state. The Action Gate revalidates immediately before any
effect: the assignment still exists, it still belongs to the proposed Session, and
no other delegation on that Session still holds work that could be stopped. A
delegation link ends only by supersession or a resolved stop, so finished work
stays linked while ceasing to be a competing stop target; execution state that
cannot be read counts as competing, never as finished. Visibility is proved for
the stopped delegation alone, because nothing retires a delegation whose Session
was deleted and proving it over the whole active set would let one deleted Session
block every stop. A stale resolution therefore fails closed, while a rename between
resolution and admission is correctly irrelevant. Trusted user text still has to
carry a direct stop imperative, and the `user_stop` confirmation stays outside
strategy output, so neither model output nor a display name can select what gets
stopped.

Direct stop persists a distinct `delegation_stop_requested` claim before
retirement and a `delegation_stop_resolved` observation afterward. The pending
cancellation tombstone retains the destructive action identity, preserving
`cancelled_pending` across a crash between those two Coordination records. Its
owning-root Stop uses an action-derived abort source on the exact target Turn,
so recovery cannot mistake a normal Session stop for WorkHub delivery. Its
admission holds the Coordination Session together with every active target
Session lane while re-reading the active links. A concurrent assignment must
therefore settle before the sole-delegation proof, wait until after the stop
claim, or cause admission to fail closed. Only a confirmed direct stop records
that provenance: a route correction retiring the same owning root carries its own
cancellation claim but keeps the neutral Stop source, so replay cannot read a
correction as a delivered stop.

Every durable WorkHub record is keyed by what it is about — an assignment by its
action, a stop or replacement by its delegation — so no single record can see an
action identity that moved to a second delegation or a second disposition. A
separate durable action claim, taken under the same Coordination admission
before any effect, is that global owner. Exact replay converges on it; any other
reuse of the identity fails closed before an effect, including after a rejected
or still-recovering attempt and across Host restarts. The claim carries no
Session foreign key, because a committed destructive claim has to outlive the
removal of its target: when the target Session is gone, its removal tombstone —
not the vanished Message proof, and never a merely unreadable target — is what
lets the stop reach a terminal resolution.

## Consequences, costs, and reevaluation

- WorkHub gains persistent conversational continuity without adding another
  durable authority, database, event store, lifecycle, or transcript copy.
- Coordination and execution remain separately authoritative within the shared
  Session substrate.
- The per-Host boundary fragments WorkHub continuity when a user switches Runtime
  Hosts: each Host has a separate coordination transcript and cannot coordinate the
  other Host's Sessions.
- The special Session role adds provisioning, lookup, recovery, retention, and UI
  obligations even though it deliberately reuses the existing Session substrate.
- Every delegated Coordination turn adds one typed assignment record, which is
  also its visible timeline source.
- Whether Work is 1:1 with Session, 1:N over Sessions, or an independent durable
  entity remains unresolved.
- Cross-Runtime-Host coordination remains deferred.
- Coordination Session role representation, lazy creation, durable lookup,
  recovery, per-Host UI resolution, persistent transcript, closed dispositions,
  and the Action Gate are implemented. Durable delegation linkage is encoded in
  that transcript; target lifecycle projection and the hybrid first-response
  contract are implemented as rebuildable reads. Linked correction, exact
  target-owned pending cancellation/Turn Stop, atomic supersession, and retry-based
  replacement recovery and direct stop are implemented. Direct
  stop uses durable `delegation_stop_requested` / `delegation_stop_resolved`
  facts, exact Message ownership, and first-claim-wins arbitration with
  replacement. Its target comes from the shared Session Resolver port.
  Named resume uses ordinary Session continuation admission. Pause and
  pronoun-based stop controls remain later work.

  > **Status (2026-09, verified against `main`):** the Resolver's "temporary
  > exact-name baseline" above was never implemented. Coordination today is
  > model-driven: the coordination model discovers candidate Sessions,
  > admission revalidates opaque identity and expected state (this invariant
  > is unchanged), and stop/resume proposals travel with explicit durable
  > targets rather than any display name. The exact-name baseline and the
  > deferred recall-only replacement plan are historical.

Reevaluate the per-Host decision if supported workflows require one WorkHub
conversation to coordinate ordinary Sessions on multiple Runtime Hosts, or if Host
switching creates user-visible continuity loss that rebuildable projections cannot
resolve. Reevaluate the special Session role if implementing its lifecycle requires
a second durable authority or exceptions that the ordinary Session substrate cannot
enforce safely.

## Rejected alternatives

- A second WorkHub database, event store, transcript substrate, or lifecycle
  authority.
- One global Coordination Session spanning Runtime Hosts.
- Copying an ordinary Session's complete transcript into WorkHub.
- Allowing model or routing output to authorize writes without the deterministic
  Action Gate.

## Host target-choice interaction

Target selection is an interaction capability, independent of the optional
pre-admission model-routing strategy described above. The default Coordination
model can invoke `tasks.select_and_delegate` after candidate discovery. The Host
publishes a durable Form using its existing interaction authority, accepts an exact
opaque option, and passes its bound Session/workspace to the existing Action Gate.
No additional Session lifecycle or WorkHub database is introduced.

The Coordination Turn is already admitted while waiting. Only the subsequent Gate
and target admission can start delegated execution. The operation re-reads active
Run authority after waiting, retains the original admitted user content, and never
rewrites an existing routing decision. Bound experimental Turns must follow their
admitted decision; changing it requires a later coordination decision.

Renderer reload re-queries the pending interaction. Cancellation/Stop closes it;
Host recovery closes orphaned continuations. A stale offer cannot silently choose
another work. Successful assignment replay uses the durable action identity. The
former `answer -> targetSelection -> answer` pre-admission protocol and renderer
Promise are removed rather than retained as a second selection implementation.

## Baka single-entry asynchronous delegation

The default, unbound Coordination model can accept several unrelated objectives
in one user input. It answers ordinary questions directly, discovers existing
Sessions for continuation, and may propose `create_new` for an explicitly
requested independent execution objective without requiring the phrase "new
Session". Failed, stale or ambiguous continuation is not permission to create
replacement work. Bound experimental routing decisions remain binding.

Clear objectives receive separate, bounded `tasks` actions before clarification
of an ambiguous remainder. No batch entity, new queue, mandatory routing-model
pipeline or authority owner is added. Each action retains the original admitted
user input and its own delegated text. Existing durable action claims, Message
admission, next-Turn FIFO and Host-owned result delivery remain authoritative.
After acknowledging accepted or queued work, the Coordination Turn ends without
waiting for workers. Another user input and later per-task notifications enter
the existing Coordination admission path; acceptance is not execution or success.

New work defaults to a Host-created directory under
`StateRoot/workhub-tasks/<Host-derived-Session-id>`, stable for the action identity.
The Host rejects substituted task directories rather than following links.
It persists the resolved ordinary workspace, so recovery reuses the same Session
and directory. The selected Desktop project is not an implicit default.
`tasks.projects` exposes at most 32 current, available, registered project names
and opaque references per query. Desktop revalidates a reference against the
current Host catalog before supplying an ordinary project target; the existing
Host workspace resolver revalidates project availability during admission.
The model cannot supply a new arbitrary path, register or clone a project through
this tool. Unknown or ambiguous coding targets require clarification. Reused
Sessions retain their cwd, model and current permissions; new Sessions use the
WorkHub creation defaults.

Direct delegated roots resolve cwd aliases and acquire their existing concurrency
slot together with a same-directory/ancestor-directory conflict reservation.
Conflicting roots retain FIFO; unrelated roots can bypass a blocked conflict
when budget is available. If filesystem availability prevents resolving a cwd
identity, that root conservatively serializes all direct workers; this does not
turn an ordinary runtime availability problem into a ledger failure or grant
extra filesystem access. A live question or approval retains the original slot
until the owning root retires. Cancellation and terminal cleanup release it;
restart reconstructs reservations from durable admissions instead of replaying
already dispatched work.

This is a direct-WorkHub-worker collision guard, not a global filesystem lock or
new sandbox boundary. Manual Turns, subagents, extra approved paths and detached
processes are not brought into this budget. Private task directories do not
override existing permission profiles, OS temporary grants or full-access mode.
Aggregated task UI and new Windows execution backends remain subsequent steps.

## Controlled evidence and dependency continuation (Step 6)

`WorkHubEvidence` exposes only current, ordinary, result-enabled WorkHub
assignments on this Host. It lists bounded task references and reads committed
assistant output from the exact owned task execution. It does not expose arbitrary
Session history, user messages, child Sessions, foreign Hosts or filesystem
contents. The returned excerpt preserves action, delegation, original Message,
Turn, Run and assistant-message provenance and marks truncation (16 KB of text,
at most eight bounded transcript pages). A terminal source is not proof of
artifact correctness; references or paths in its text are not verified files.

A worker may ask a bounded question, optionally selecting a discovered source.
Without one, WorkHub receives a result notification and selects a visible source
or reports unavailable. Selecting a queued source does not dispatch more work.
Supplemental execution still goes through the existing user-authorized Action
Gate. Neither the question nor the source output is permission or a user message.
WorkHub must finish coordination promptly, not poll or block on the worker.

The Host fixes sender Session, Turn, Run, invocation, tool-call, assignment and
original Message identities. It persists one typed request and immutable reply
in the existing Session store; deterministic root admission is the delivery
receipt. These operational records are not displayed, backfilled as model facts,
searched as conversation text or copied into another Session. Only the current
root invocation may request evidence; only WorkHub may resolve another task's
request. Resolution fixes the exact source delegation and original Message,
never a display name or a mutable latest-Session reply.

A settled request ends its fragment with `dependency_wait`. It may release the
direct-worker concurrency/cwd reservation only after canonical tool and Turn
settlement and cleanup of live resources/children. Once evidence is available,
the Host admits a **fresh non-user Turn**, after pending manual/FIFO admissions.
It remains part of the original WorkHub task for result, Stop, correction and
worker-budget accounting, but not part of the old execution/grant lineage.
Existing task-scoped grants never flow into it; current Session defaults and
normal native approval apply. No Session-wide permission override/restore,
cheap same-Turn suspension or scheduler/subagent budget redesign is introduced.
An active/waiting Goal carried by this Turn or already driving autonomously must
first be paused through its normal Goal control. A user Goal armed for the next
Turn is not a leftover resource of the old fragment: it remains armed and binds
normally when the fresh Turn starts. The relay does not manipulate Goal state or
let its automatic scheduler bypass the dependency wait. The entire encoded
response also fits the existing root-admission budget, with explicit truncation
of excerpts or repeated task text.

Restart reconstructs waiting state from committed requests, owned execution
proofs and admissions, without a second task database. Duplicate delivery or
replies cannot create a second Turn; a conflicting reply is rejected. Stop,
archive or replacement retires the requester, and a retired/cancelled source
returns unavailable evidence. One-hour expiry returns an explicit expired
outcome. Each task is limited to eight communication rounds; same-Session waits,
self-dependencies and cycles/overlong dependency chains are rejected. One failing
source cannot starve unrelated requests. With direct concurrency one, a settled
request releases its slot so the queued producer can run, then the fresh requester
Turn acquires the normal slot/conflict reservation again. Recovery/handoff fences
the relay alongside the existing result poller.
