# Architecture

## Purpose

ChatGPT Chat Bridge provides a small control plane for multiple chats inside a ChatGPT Project.

It does **not** try to replace GitHub project management and it does not make chat history the durable source of truth.

The core separation is:

- **GitHub Issues / PRs**: durable project state
- **ChatGPT chats**: long-lived execution contexts
- **chat-bridge**: routing/session/model/recovery control
- **Conductor chat**: orchestration policy and next-step decisions
- **Ego Lite / ego-browser**: native browser runtime

## Runtime layers

```text
Chat / Codex caller
       │
       ▼
bin/chat-bridge
       │
       ▼
src/main.js
       │
       ▼
ego-browser nodejs
       │
       ▼
Ego Lite TaskSpace / Page / CDP
       │
       ▼
ChatGPT Project + conversations
```

No desktop screen coordinates are required for the normal path.

An explicit `queue submit --runtime codex` routes through the same durable queue
to a Bridge-dedicated thread on an existing shared native app-server. Native
bindings and turn receipts live in operations; they do not enter Web chat/page
pools. Results and owner ACK retain the same contract. See
[`native-codex-delivery.md`](native-codex-delivery.md) for startup, ownership,
readback/cancellation and the boundary from ordinary desktop conversations.


Resource waits are recorded as one episode in the existing operation result,
with separate pacing, capacity, mutex, busy and draft counters. Only a normal,
trusted PRE_SEND resource receipt can exhaust the 30-minute automatic wait
budget. Manual admission pauses do not spend that budget. The exact claim CAS
then records FAILED_PRE_SEND / RESOURCE_WAIT_EXHAUSTED and one episode-specific
event for the original caller or its committed successor. Unavailable routes
stay in the existing WAITING_ROUTE outbox until a committed successor resolves,
without a root-controller guess; local Codex owners see the
notice through local-pull. Only explicit queue retry starts a new episode.
UNKNOWN, post-send and identity failures retain their existing contracts.

SQLite lock retries use one monotonic deadline and nonblocking native attempts:
the coordinator keeps its 60-second finish allowance; a state-store invocation
shares a 15-second deadline across bootstrap, transaction, registration fence
and commit, beneath the unchanged 20-second outer timeout. Registry saves skip
a write only when there is no normalized delta and no registration to fence.

The installer rejects dirty or unresolved source before touching destinations,
then rechecks the same resolved commit/tree before publishing. Readback rejects
inadmissible source identity. It publishes an atomic private release manifest from its actual
copy map, including source commit/tree/clean state and every destination hash.
A serving coordinator records a private startup receipt beside its lock.
Pure-local health compares current disk hashes, startup disk hashes, process
start identity, and executing coordinator/helper code fingerprints. Fresh CLI,
native children and late module imports load independently and are not attested
by the resident receipt. None of these file/process checks inspect the browser.

## Registry and runtime state

The bridge keeps **routing identity** and **operational state** separate.

Registry:

```text
~/.config/chat-bridge/registry.json
```

Runtime cache:

```text
~/.local/state/chat-bridge/runtime.json
```

The registry is versioned and stores logical projects, ChatGPT account identities, per-account project bindings, and chat sessions. A project binding looks conceptually like:

```json
{
  "project": "My Project",
  "activeAccount": "primary",
  "bindings": {
    "primary": {
      "projectId": "g-p-...",
      "projectUrl": "https://chatgpt.com/g/g-p-.../project",
      "spaceName": "my-project-primary",
      "spaceId": 42
    }
  }
}
```

`spaceName` is the stable binding key. `spaceId` and page labels are runtime attachments and may be recreated. Version-1 registries are migrated to version 2; stale per-session Space attachments are cleared instead of being treated as permanent identity.

`registry.spaces` is a separate observed catalog: each scanned Ego Space records the actual ChatGPT user ID/display name and Project IDs seen in its open tabs. This is a many-to-many observation layer: one account can host multiple Projects, and a Project can appear in multiple accounts and Spaces. The catalog never overwrites the per-project/account routing binding; its `spaceId` is only a last-seen cache. `space restore` requires the saved named Space and a matching login before opening missing Project tabs.

A session record contains conversation identity plus routing metadata such as logical role, account, lifecycle status, model/effort, Space, and tab/page attachment.

The runtime file contains reconstructable orchestration state such as active task IDs and recent project execution metadata. It must never outrank GitHub Issues/PRs as project truth.

### Login/Profile → managed Space → Project/session tabs

The target browser hierarchy is:

```text
verified ChatGPT login/Profile
  └─ one Bridge-managed Ego Space
       ├─ Project A tabs/sessions
       ├─ Project B tabs/sessions
       └─ ...
```

A logical Project may still bind several accounts, and each account may expose a different real ChatGPT Project ID/URL. Those Project locations are routing/context records, not reasons to create more Spaces. `space consolidate` previews legacy project-specific bindings and migrates only when every bound Project is paused/drained, all delivery and callback states are settled, bindings are valid, and legacy Agent Spaces are empty. It closes only those empty Agent Spaces. User/manual Spaces remain outside automated cleanup.

Shared-Space cleanup is physical-Space-aware: protection is aggregated across every Project/control page/active task/session sharing the Space. Only Bridge-managed pages with no generation, unsafe draft, active-task reference or user ownership are reclaimable; registered pages must have proven terminal tasks, while orphan pages must be inactive. Close failure leaves the attachment record intact. `space gc` is dry-run by default and revalidates agent ownership/liveness under the same UI pacing before `finish({keep: []})`.

A ChatGPT conversation ID is independent of its Ego Space attachment. Rebinding a project/account to another Space preserves conversation identity and causes sessions to reattach in tabs in the new Space. Page labels are a bounded runtime pool, not durable session identity: if `task.newPage()` hits the Ego page budget, the bridge may reclaim an idle managed session page and set that session's registry `page` to null. The next use reattaches the same conversation by URL. The control page, generating pages, active-task sessions, pending responses/notifications, user control and unsafe drafts remain protected. Selection alone does not imply execution: a selected agent-owned registered page may be reclaimed only after its terminal tasks, exact Project/conversation and every fresh guard pass. Selected orphan or user-owned tabs remain protected. Authorized text-only drafts still require the existing complete private backup and guarded discard.

A confirmed `reattach --current-controller` places an existing formally registered current controller without inventing a runtime task. It requires an ACTIVE logical row with no pending successor, a verified managed target, fresh same-Project/login observation, one composer with empty untrimmed semantic text, no generation/approval and no active task or delivery lease. A short transaction compares the complete chat, binding, logical row, account identity and exact overflow mapping, then commits the previewed overflow mapping and attachment together. Failed observation may leave an allocated physical Space, but changes neither local mapping nor attachment. Runtime, logical epochs, pauses and UNKNOWN operations are preserved. Worker reattach still requires its exact active task.

Healthy legacy overflow Spaces remain usable. A verified agent-owned legacy-name collision in another Profile selects the deterministic `<canonical>-overflow-<Profile SHA-256 prefix>` target. Its returned Profile/ownership/ID must be freshly verified before recording the identity/Profile mapping; normalization retains a scoped attachment only through that exact verified mapping.

Project lifecycle policy defaults to `draftPolicy=preserve` and `maxOverflowSpaces=1`. A management-authorized `policy set --project NAME --draft-policy discard --max-overflow-spaces 2 --confirm` persists opt-in through the local coordinator without waking Ego. The overflow pool is shared by verified identity/Profile across aliases and Projects: primary plus at most two overflow Spaces (24 pages). Normal allocation tries safe reclamation in the primary and existing pool before selecting or creating one additional managed Space. Verified existing mapped Spaces can be reused immediately through the existing-only preview; creating or advancing a Space still requires the 120-second capacity wait and the configured budget. The latest mapping retains the previous Space; normalization, scoped prune and admitted automatic cleanup visit both without changing conversation IDs.

With explicit discard policy, normal dispatch/send and eligible reclamation use the shared account mutex and input guard. Before clearing a text-only draft once, the guard durably writes its full native document when available, raw/rendered text and composer/form HTML to a private `draft-backups` file (0600), verifies readback, and rechecks policy, login, exact Project/conversation, pause, generation, approval, unique composer, attachments and unchanged contents. After intent persistence, the existing characterized native editor probe compares the complete backup, current route, FileList/previews and UI state and dispatches one ProseMirror deletion transaction in the same synchronous browser action. Missing or uncharacterized atomic editor capability returns `DRAFT_DISCARD_UNSUPPORTED`; no plain fill, keyboard or DOM clearing is attempted. Default preserve, UNKNOWN/unbound delivery, partial-input or send-intent evidence, user control, attachments and uncertain mutation prevent clearing. Failed clearing has no destructive fallback. Backups stay local; delivery journals retain only backup receipt metadata.

The read-only reclamation context permits confirmed `SENT` dispatch/rotation occupancy to end when its exact registered task is technically `CANCELLED` or `FAILED`, matches its persisted owner, Project, account, conversation, role and workgroup, and has no pending response/notification or user pause. The fresh browser reclamation guards still decide whether to close the page. After the final native Tab read, the read-only context rechecks global/Project/workgroup pause or drain, Project/session user control and current task execution or pending response/notification plus the exact registered route and attachment snapshot before closing; a technically terminal task does not override these protections. This changes neither the SENT ledger nor result/owner ACK; missing results alone do not make a genuinely terminated task occupy a page forever. `BLOCKED`, UNKNOWN and unproven scopes remain protected.

### Account failover

Account records are routing identities. Each logical project may bind to a different ChatGPT Project and Ego Space for each account. The bridge does not automate credentials; the selected Space must already have authorized access to that ChatGPT account/project.

`account identify --project NAME --account ALIAS` verifies each binding against an existing managed ChatGPT page's session user ID. Only that ID leaves the page, never credentials/tokens. The SHA-256 of `identity:<ID>` scopes cooldown across aliases/projects/Spaces. Unidentified aliases use `alias:<ALIAS>` and are explicitly unverified; login/profile changes require re-identification, and identity mismatch is an error. Cooldown preflight is local-only; watchdog admits any eligible account then checks each task before browser access, skipping cooling identities without task failure. Legacy global cooldown is retained for the default identity only. The browser pacing lock stays shared for serialization, not quota accounting.

Cross-account continuation should use GitHub durable state plus a handoff summary, then create or register a replacement session under the alternate account binding.

A blocked task's controller notification interrupted by Web cooldown stays pending. Watchdog may retry that notification after cooldown, but the task remains blocked and recovery does not resume. Persistent `watch --loop` schedules fresh one-shot processes locally, so idle/cooling scans do not keep a browser controller alive.

### Session lifecycle

Sessions have lifecycle state (`active`, `archived`, `retired`, or `deleted`). `retire` archives the remote ChatGPT conversation and removes it from the active routing pool while preserving history in the registry. `forget` is registry-only. `delete` is destructive and requires explicit confirmation.

## Liveness and watchdog

A ChatGPT generation is not classified from one button alone. The bridge combines control state (Stop/Send/composer), stable `data-message-id` turn identity, assistant content fingerprints, a page-side MutationObserver scoped to message/generation UI, recovery/error controls, connectivity, and elapsed time since meaningful progress.

The session state machine is:

```text
RUNNING_ACTIVE -> RUNNING_QUIET -> SUSPECT_STALL
      |                 |               |
      v                 v               v
IDLE_COMPLETE   ERROR_RECOVERABLE   recovery ladder
IDLE_INCOMPLETE                     or BLOCKED
```

`lastProgressAt` and per-task baselines are stored in runtime state. Per-task `stallThresholdSec` can override the effort-based warning defaults. Without an override, the budget is at least the maximum of requested/configured and UI-observed effort defaults; a selector showing Medium cannot silently shorten an Extra High task budget. Quiet thresholds do not authorize Stop. One owner notice is queued per quiet episode; explicit aggressive recovery is required for Stop + guarded continue. A new result is identified primarily by ChatGPT's stable `data-message-id`, with count/hash/length as additional signals.

A visible Codex Tasks permission card, identified by its exact tool title and approval question in current alert/error UI outside message content, yields `WAITING_USER_APPROVAL` / `WAIT_FOR_USER_APPROVAL`. The task remains unfinished: no Retry, Stop, continue, recovery/failure-budget consumption, or repeated notice occurs while waiting. Send and native control paths recheck the gate; automatic page reclamation preserves it even for terminal tasks. When the card disappears, normal observation resumes. This narrow detector does not infer approval from arbitrary chat prose or claim support for other permission-card layouts.

The watchdog never marks a project task COMPLETE from UI state alone. `IDLE_COMPLETE` becomes `AWAITING_DURABLE_UPDATE`; the owning controller must reconcile GitHub Issue/PR/callback evidence. A Space in `user` or `agentDelegatedToUser` ownership is a hard automation boundary: watchdog does not claim it, persists `watchdogPausedForUserControl`, and later local preflight suppresses that task before browser startup. Explicit user-directed `send`/`ask`/`retry`/`recover`/`resend` clears the pause and allows work to continue through the normal managed-Agent-Space selection path. Mechanical recovery is conservative: a current visible native recovery control, then guarded `continue` for a real incomplete/error turn. Quiet UI alone never triggers Stop. Stop + guarded continue and original-task replay require explicit aggressive mode. Recovery checks the current task before acting and will not knowingly re-run a recorded result; this is not a global exactly-once guarantee for external side effects. Exhausted recovery becomes `BLOCKED` and routes an event through `replyTo → controller → escalationTo → rootController`.

For continuous local operation, macOS launchd runs a fresh one-shot `chat-bridge watch --quiet` periodically. A fresh process reloads registry/runtime each scan, so newly created sessions and account/Space rebindings are visible without restarting a daemon.

## GitHub Project management binding

The word **Project** has two distinct meanings and they must not share identity:

- a **ChatGPT Project** is a Chat/session location attached to an account/Profile and Ego Space;
- a **GitHub Project v2** is an optional management/index board for source Issues/PRs.

Each logical Bridge project may store optional `githubProject` metadata in the registry:

```json
{
  "owner": "luxiaolei",
  "number": 8,
  "id": "PVT_...",
  "url": "https://github.com/users/luxiaolei/projects/8",
  "sourceQueries": ["repo:luxiaolei/chatgpt-chat-bridge is:open"],
  "statusField": "Status",
  "statusFromLabels": {"status:backlog": "Backlog"}
}
```

The board is Project-first only as a **management read surface**. Source Issue/PR properties and evidence remain authoritative for task scope, dependency, review/CI and merge state; Bridge SQLite remains authoritative for dispatch/result/callback/ACK mechanics. A Project column cannot manufacture business/scientific acceptance.

`src/github-project.py` is a host-local `gh` adapter invoked by `chat-bridge github-project ...`. Reads are fully paginated and fail closed on truncation/inaccessibility. Refresh is preview-only by default. Explicit `--apply` can add only source references discovered by configured open/repo-scoped searches, and can mirror only explicitly mapped nonterminal Issue-label statuses. Before each write it re-reads source and board identity/value to detect concurrent changes. It never changes source Issue/PR state or executes/replays a Bridge task.

GitHub-native Auto-add/workflow configuration remains a board-setup responsibility because research, engineering and cross-repo programmes have different inclusion/status semantics. Binding a board does not claim that Auto-add is configured.

## Project sync

`chat-bridge sync --project NAME` opens the actual ChatGPT Project page and enumerates project-scoped conversation links.

This has two benefits:

1. project membership is read from the real Project UI rather than inferred from the global recent-chat sidebar;
2. project-scoped conversation URLs are refreshed in the registry.

## Session creation

`chat-bridge new` navigates to the target Project, configures the requested model/effort, sends the initial message, waits for ChatGPT to allocate a conversation ID, and registers the resulting session.

A session should normally map to one stable workstream or role.

## Model abstraction

The bridge separates:

- model radio selection
- thinking-effort slider

A normal configuration may be:

```text
Latest + High
```

The `GPT-6 Pro` bridge preset is intentionally represented as:

```text
Latest + Pro
```

because the current ChatGPT UI exposes the highest path through the `Latest` model choice plus the rightmost `Pro` thinking level.

New sessions default to Latest without forcing an effort. 5.5/5.6 Pro retain the requested older radio version. Pro uses the slider's current maximum and checks displayed effort. No unavailable-model or quota fallback is silent. Callers receive `modelSelection` with observed model/effort/raw UI text; configured preferences are not evidence of the live model.

When the current visible effort exactly matches the requested level, effort selection skips reopening the menu; model selection retains its radio confirmation, and different or unknown effort still requires slider and displayed-level verification.

## Message lifecycle

### Dispatch

```text
Conductor
  │
  ├─ update/read GitHub Issue
  │
  └─ chat-bridge send worker TASK
                         │
                         ▼
                    Worker Chat
```

Workgroups are scoped projections of the existing project/task/session records. A workgroup carries its charter Issue, optional parent, controller session, and revision/epoch; it does not create a second task database. The root controller approves structure. A delegated controller can submit and reconcile tasks only inside its group, while global, project, and parent controls remain authoritative. A missing `workgroupId` is legacy state and stays legacy.

When present, the same `workgroupId` is carried through logical placement, task/runtime projection, checkpointed rotation, operation/outbox rows, result versions, callbacks, and ACK validation. A root-owned task may retain a group label for admission while its persisted owner remains the root controller.

### Durable result, callback, and acceptance

```text
Worker
  ├─ update GitHub / authorized durable project state
  └─ queue result
          │
          ▼
   RESULT_RECORDED + persistent callback outbox
          │
          ▼
   current owning controller
          │
          ├─ review durable evidence
          └─ queue ack ACCEPTED / REJECTED / BLOCKED
```

A worker result, callback `SENT`, and controller acceptance are distinct states. `RESULT_RECORDED` can release the finished worker Tab after the safety grace period; business `COMPLETE` requires the owning controller's accepted ACK. Result persistence happens before callback resolution. When the owner is unavailable, `task_results` retains the original owner contract and the callback outbox waits for that owner or an already committed successor; it never falls back to root by guesswork.

## Synchronous vs asynchronous routing

Use `ask` when the caller needs to block until the target chat finishes and directly consume the response.

Use `send` for event-style routing, especially worker-to-conductor callbacks.

## Recovery

The bridge exposes:

- `status`: inspect generation state and latest messages
- `stop`: stop an active generation
- `retry`: use one exact current-conversation Retry/Try again control; never fall back to Regenerate or Continue
- `resend`: resend the latest user message
- `recover`: inspect current task/UI; use native recovery for errors, guarded continuation for incomplete turns, and defer quiet generation without stopping unless explicitly aggressive

Project state survives a broken chat because the authoritative task record is expected to be in GitHub.

## Conductor loop

A conductor should run a bounded orchestration loop:

1. reconcile GitHub state;
2. choose the next dispatch batch;
3. select/reuse/create sessions;
4. allocate model and thinking effort;
5. dispatch;
6. receive callbacks;
7. verify GitHub evidence;
8. continue. A workgroup's wake-up is scoped to that group; another group's running or awaiting-receipt work does not block it. Queued operations recheck the control scope/epoch before sending. Pause and drain block new business admission only; result recording, callback delivery, ACK, and management recovery remain available.

Only the conductor should normally fan out new work. Worker-to-worker delegation should be exceptional and must preserve task IDs and hop limits.

## Local execution

Some worker tasks need local capabilities such as filesystem access, GUI automation, builds, or private browser state.

The preferred local pattern for this deployment is:

- Chat / Codex → an authorized plugin whose display name starts with `ChatGPT Computer` → verified execution host → local CLI/tools

Plugin suffixes differ by ChatGPT account. Verify host/capabilities rather than matching a hard-coded connector name. Git/GitHub writes use the configured host's local `git`/`gh` identity. Remote Desktop Commander is not the default transport.

For tasks that do not need local state, prefer direct Chat + GitHub work.

## Security boundary

The runtime controls a logged-in browser profile. Any process with access to the same user account and local browser control surface may be able to affect that session.

Do not expose the local runtime to untrusted users and do not commit browser state or the local registry.

## Local reliability and read efficiency

Runtime and registry authority is SQLite; JSON is a compatibility projection. Hot read paths use `state-store.py peek`, which neither initializes missing stores nor rewrites projections. Legacy uninitialized deployments may read JSON; SQLite errors propagate rather than falling back to stale JSON. Explicit `get` repairs projections and `put` retains transactional conflict checks. Preflight and capacity readers consult SQLite authority. A store error defers watchdog work rather than escalating a healthy worker or amplifying contention with failure-counter writes.

`chat-bridge health` reports cached observation freshness, manual ownership, capacity waiting, and retained historical errors without touching Ego. Generation counts are labeled `recentlyObservedGenerating`, not live activity.

`control status` counts a durable result awaiting owner ACK even when its callback could not be sent. An acknowledged callback's old pre-send failure remains in the operation ledger and `historicalFailedPreSend`, but no longer counts as an unresolved send fault. Fresh generation takes precedence in the execution label while unresolved faults remain separate counters. An idle label describes the absence of dispatched work, not the absence of business opportunities. A resumed scope retains its persisted epoch and reason; stronger parent controls still govern admission.

Conversation attachment compares the conversation ID, origin, and any available canonical Project IDs, not the full URL string. Slug/query changes do not reload a running tab. A reused page label belonging to another conversation is never navigated away; the Bridge first looks for the same conversation, then uses the existing safe page pool. Readiness failure on an existing same-conversation tab does not trigger a Project navigation fallback.

Orphan cleanup does not create an idle-browser wakeup or bypass a cooling account. Cleanup inside a scan is scoped to the admitted account/Project and is not repeated by every per-task child. Terminal tab safety, active generations, drafts, user ownership, and UNKNOWN delivery reconciliation remain protected. This intentionally favors effective completed work over maximum open tabs.

See `docs/local-reliability-20260929.md` for the repair evidence, limitations, and deployment gate.

Unknown native submit formats remain explicit `PRE_SEND` / `FORMAT` / `UNSUPPORTED`. At that existing failure boundary, the shared probe reads bounded data descriptors and intrinsic function source without calling native getters, serializers or handlers. Diagnostic capture is limited to 128 globally unique editor candidates, 16 KiB UTF-8 per function source and 256 KiB per private file, including JSON escaping. A limit sets `truncated` and `limit`, stops capture, and omits oversized source; incomplete diagnostics never admit a format. Retained complete sources stay in a verified private `native-format-evidence` file (directory 0700, file 0600); public errors carry only its path, hash and byte count. Retention failure preserves the original strict rejection. This evidence does not admit an alias, create a session or prove delivery.

The complete retained normal FORMAT failure characterizes a single-expression submit family: one arrow parameter, one distinct callee identifier, and one distinct editor identifier in `parameter=>callee(editor.getText(),parameter)`. Only those identifiers vary; the entire intrinsic getter/serializer pair remains pinned to the observed sources. The probe does not normalize expressions, accept extra operations or infer a new getter/serializer. It reads methods through data descriptors, uses captured intrinsic source rather than custom coercion, and retains the validated method references for the native call and receipt. Every admitted path requires one composer-bound editor and rechecks its document, composer and method identities around the native body read. The captured original getter executes on its original editor with the verified document explicitly supplied as its first argument, as supported by every admitted getter source. The getter cannot re-read an accessor default and serialize a foreign document hidden by an ABA change. Document binding follows the verified getter's actual dictation/document access path, including accessors; descriptor-only diagnostic omission is not a document mismatch. Admission requires a complete ancestor chain within the existing 16-fiber budget. Remaining ancestors, cycles, opaque return accessors and exhausted bounded prototype lookup all prevent a uniqueness claim; opaque links are not invoked, and unknown-format diagnostics are marked incomplete. The hook entry, per-hook state/dependencies and each next link must also be readable within the existing descriptor bounds; opaque accessors or exhausted prototype lookup cannot masquerade as an empty chain. Diagnostics mark these hook scans incomplete without executing opaque accessors. Truncated method source, more than 64 dependencies or hooks in a matched fiber, or more than 128 observed composer-bound editors are also refused. Capability-only inspection invokes no getter, serializer or handler. These checks characterize a bounded UI shape; they cannot inspect closed-over values or turn a source pass into send, runtime or owner-acceptance evidence.

### Recovery of an already created, unregistered rotation

Host-local commands (Root controls live use):

- `queue observe --operation ID` reads an existing UNKNOWN browser operation using its persisted account, Project and session. It does not require or create a runtime task, reconcile delivery, change attachments, send, or clear a pause/draft. The existing `reattach --task` guard is unchanged.
- `control rotation-recover --operation ID --candidate CID` reads an explicit existing candidate and returns a preview with `expected`. Commit uses the same arguments plus `--expected DIGEST --confirm`; evidence is read again and exact operation, registry and logical-role snapshots are compared under the write transaction.
- The recovery accepts only the original native witness, exact rotation nonce/header and handoff hashes, verified login/Project, and one complete native user source bound to persistent candidate CID and message ID. Temporary source identity, competing local role/operation, absent or duplicate matching messages, and changed snapshots fail closed. It preserves prior result/witness and attempts. Missing historical before-user ID/server timestamp remain null. Uniqueness covers the observed candidate message and local registry, not an exhaustive server conversation search.
- Commit records the original delivery and registers `pending-rotation` only. The original role owner and epoch remain unchanged until the recovered successor invokes `control rotation-ack --rotation ID --caller-ref SUCCESSOR_CID --message VERIFICATION` through its account-authenticated connection. Host-local synthetic ACK is rejected for recovered successors. The transport authenticates the account; caller-ref remains declared session identity, not cryptographic ChatID authentication. ACK compares exact registry/logical/runtime snapshots before switching ownership.
- Draft/generation readiness is reported separately from historical message proof. Recovery never performs input, Stop, Retry, new-conversation creation or a resend. Observation may open an existing conversation in its verified agent-managed Space, leaving other tabs intact. It does not grant permission for a later input action.

Observation failures retain the parsed worker receipt and bounded stdout/stderr diagnostics in the returned error, without modifying the original operation. observation.outcome separates DEFERRED, IDENTITY_REJECTED and UNKNOWN; the original deliveryStatus stays DELIVERY_UNKNOWN and retryOriginalOperation is false. PRE_SEND inside observation.receipt describes the read worker only. A timeout/reset without trustworthy evidence remains UNKNOWN. Successful reads include online/errorTexts/recoveryControls/recoveryRequired/pageWasDiscarded; observedAt is local UI sampling, never server freshness proof. Rotation recovery requires healthy online, undiscarded UI with no current error/recovery requirement. It rejects retained native source-CID conflicts and temporarySourceFirstConflict even when later source bytes match. Cross-row candidate operation/logical occupancy and rotation uniqueness are checked again inside BEGIN IMMEDIATE before binding.

When an UNKNOWN observer has no exact owned target tab and its primary Space reports a page-budget refusal, it may inspect only the existing registered overflow/previous pool for the same verified identity/Profile. The shared overflow helper's existing-only preview validates managed ownership, mapping and actual Space IDs and cannot create a Space or save a mapping. Observation reuses one exact agent-owned Project/CID tab across that pool, or uses the reported budget and Tab inventory to choose one existing Space for a single known-CID page allocation. A capacity race does not retry another target. Missing/changed mappings, user ownership, competing CID tabs and a full pool fail closed. Fresh target and pool metadata, login, Project/CID, user pause and the unchanged operation/observation-scope anchor are checked before returning. No registry/runtime/operation/control update, reclamation, draft clearing or ACK occurs. Pending-successor observation retains its separate existing-unique-tab contract and never enters this fallback; explicit reattach retains its existing attachment-commit contract.

After a successful read, the observer may close only the page allocated by that invocation. The shared close helper checks login and scope, then samples exact URL and empty raw composer/attachments with no generation, approval, context or recovery error. After that final native sample, it rechecks managed ownership/Profile and unique CID, then synchronously peeks current registry/runtime attachments, user pause and the same observation-scope anchor before closing once. No further native sample follows these admission checks; they do not provide a cross-system atomic close. Failed or uncertain reads and existing worker/pending pages stay open. `temporaryObservationPageClosed` and its bounded cleanup condition report confirmed closure or a separate cleanup refusal/failure; cleanup failure does not invalidate a successful read or reclassify UNKNOWN.

The UNKNOWN observation anchor retains the complete original operation row, target and caller Chat records, exact account/binding, related Project metadata, managed-space identity/Profile inputs and the same identity/Profile overflow pool. Unrelated Chat, Project, account and Project-catalog maintenance does not invalidate a read. Requested/observed models, route/attachment changes and hidden operation changes remain guarded. Rotation recovery also includes the entire registry digest in its preview token and rechecks it under BEGIN IMMEDIATE before replacing the registry, preventing concurrent maintenance from being overwritten. Pending-successor observation keeps its separate logical/ACK anchor.

### Assistant observation and late reply correlation

assistantMessageBinding is explicitly null in the current native adapter; assistantMessageBindingCondition is NATIVE_PARENT_ASSOCIATION_UNAVAILABLE (or ASSISTANT_NOT_OBSERVED without an assistant). The characterized message-bound Markdown source proves the observed assistant ID/conversation/text but supplies no reliable parent-user relation. DOM order, latest user, task metadata and model self-reports never create one. No private conversation endpoint is added.

Reserved positive schema, not yet a supported positive capability: {format:"chatgpt-native-assistant-parent-v1",assistantId,parentUserMessageId,conversationId,account,assistantTextSha256,source}. A future extractor requires independently characterized native ancestry and exact same-assistant complete text, persistent conversation and account evidence. Missing/ambiguous ancestry stays null. Ordinary successful-send ACK handling is unchanged; late recovery consumers must fail closed per task when they need a parent association.

ASSISTANT_RESPONSE_READY carries assistantTextSha256 (complete observed UTF-8 bytes), assistantTextSource, assistantTextTruncated, assistantTextUtf16Length, assistantTextUtf8Bytes and the same explicit null binding. The journal measures the complete serialized event against its 256 KiB limit. assistantText is always complete or null, never a preview. Complete events retain ASSISTANT_RESPONSE_READY; if additive metadata alone exceeds the old event budget, only those new metadata fields are omitted to preserve the complete legacy event. Missing metadata is unknown, not evidence. Truly oversized bodies produce ASSISTANT_RESPONSE_UNAVAILABLE with assistantText=null, assistantTextTruncated=true and sessionState=RESPONSE_BODY_UNAVAILABLE. Old READY consumers cannot execute this as a partial RPC. assistantTextRef={format,path,sha256} points to a content-addressed local JSON document retaining complete text and exact account/Project/session/assistant metadata. Verify reference digest and complete text hash before use. Text retention does not prove parentage or task authorization.

`new` retains its actual confirmed same-send temporary source witness in the registered chat, scoped to the creation account and Project. A later shared send may reuse that mapping only when its fresh BEFORE owned source has the exact last confirmed user UID and full-body SHA256, its login/Project/CID and getter/serializer still match, and its fresh post-send UID/source exactly matches the current native body. Successful reuse records `registered-temporary-conversation-v1` and advances only the last confirmed native witness; source contradictions remain sticky. Existing claim admission remains required before Send. Missing creation receipts, changed layouts or body representations cannot create a mapping; historical UNKNOWN operations remain unchanged.

`status CID` and `read CID` can observe an exact registered `pending-rotation` successor through the existing read-only operation observer. The query requires the unique original SENT rotation, current ROTATING logical pending pointer, exact account/Project/role/workgroup, and unique predecessor/successor. It reads one existing agent-owned tab in the registered Space/Profile, verifies the real login, and rechecks the anchor afterward. It does not open another tab, save runtime/registry state, clear pauses or ACK. A concurrent ACK or scope change rejects the sample. Mutating commands retain the ACK barrier, including archive/retire/delete/forget; `queue observe` continues to require an UNKNOWN operation.


### Existing-conversation terminal LF evidence

The native editor body and the message-bound source are distinct representations.
Retained persistent-conversation send receipts characterize two exact
getter/serializer pairs, including the current native submit format verified by
a separate no-Send full function-source observation. They show the source equal
to the native body with exactly its single terminal LF removed. The source observer returns the owning message property verbatim; its
rendered-text fallback does not participate in this native comparison.

For future sends only, `persistent-single-terminal-lf-v1` permits that one exact
relation when the preceding character is non-whitespace, the getter and serializer
fingerprints match one captured pair (mixed pairs fail closed), the source is `BOUND_SOURCE`, and the
before/target/after URLs identify the same existing conversation. The source
observation must be at or after the native witness. Existing account, request/body
hash, witness freshness, fresh message ID and conflict checks still apply.
Receipts retain the original native body hash and record a separate `bodyBinding`
with the source hash and both lengths. No body is changed, and no generic trim,
CRLF, repeated LF, other whitespace, new-chat or temporary-alias rule is added.

This is an empirically bounded representation relation, not proof of the platform's
internal downstream transformation. Saved receipts do not recover an absent
before-ID baseline; historical UNKNOWN operations remain UNKNOWN. It supplies
neither assistant-parent evidence nor a reconciliation or resend permission.


### Exact latest-user source on ordinary status

`status` requests the existing source-aware `state` observation mode and returns
`lastUserSource` and `lastUserSourceCondition` without a consumer-specific flag.
This closes the `Quant _chat_status -> Bridge status -> observeSession -> state`
interface gap. It does not return full user-message history, expand a disclosure,
reload, send, or change either native source predicate. The newly exposed source
body and user-ID list are not retained in the heartbeat cache; a cached runtime
record is not a substitute for a current source observation. Watchdog observation
keeps its existing lightweight default.

`BOUND_SOURCE` binds the returned source tuple, not a temporary-to-persistent alias.
When the source still names `local-chatgpt:*`, its actual ID remains unchanged and
persistent-CID consumers must keep the delivery unknown. A later observation with
a directly bound persistent CID can establish current delivery evidence using the
consumer's exact account, original user UID/claim, full bytes, hash and observation
window checks. It does not backfill an absent historical alias witness. Complete
source bytes are neither rendered-text normalization nor native assistant-parent
proof. Delivery reconciliation and safe continuation require separate acceptance;
`assistantMessageBinding` remains null with its existing explicit condition.

The common sender checks existing native source binding before filling a new message. A valid retained creation witness keeps the registered-alias path. An otherwise unproven temporary source can settle through one standard same-CID reload only with a fresh verified login, empty composer/attachments, idle healthy UI, unchanged registry, current claim, RUNNING control and no user pause/Image occupancy. The existing same-claim journal retains the complete prior source and reload intent. After reload the same prior UID and full source bytes must bind directly to the persistent CID; otherwise the sender returns explicit PRE_SEND `NATIVE_EXISTING_SOURCE_UNVERIFIED`/UNSUPPORTED without filling or sending. The native getter/serializer are checked again before input, and scoped user pause is synchronously reread after the final native source/UI sample. No alias is synthesized, historical UNKNOWN is unchanged, and successful future delivery still requires the existing post-Send predicate.


### Recovery UI scope and durable claim evidence

History/sidebar Retry is not current-turn recovery. Visible controls under a
sidebar section, navigation, or aside are excluded. Unowned turn-error controls
must be within the actual main conversation. Global permission alerts are still
checked independently, including portal-rendered cards. Real current-turn errors
continue to block completion; this is not a last-reply-wins override. Exact Retry
and Try again labels require a unique candidate; only explicit recovery may also
choose Continue generating. Regenerate is never an automatic fallback.

The queue creates `delivery-attempts/OPERATION/CLAIM_ORDINAL/manifest.json` before
Popen. Each claim has its own immutable private files, preserving old claims.
The wrapper passes only a hash-bound descriptor to the existing native runtime.
Browser evidence is synced before input and before Send, retaining original user
baselines and complete source observations without publishing them. A second
SEND_INTENT in the same claim is rejected. Failure to persist required evidence
prevents the trigger, while an existing or uncertain intent remains UNKNOWN.
The journal does not weaken the native submission or account/session predicates.

Child output is captured to private files and synced during waits. Cleanup keeps
the old process-group boundary and records only observed local facts; it never
claims that remote execution stopped. Timeout diagnostics retain the full parsed
native witness when available and the raw capture, even when no routable new
session could be registered. A captured success on a timeout is not auto-delivery.
The local-only `queue delivery-attempts --operation ID` returns file hashes and
explicit evidence/UNKNOWN limits, not a new recovery or acceptance action. It
returns at most the latest 128 claim directories and flags truncation. Direct
non-queue consumers are not silently assigned a new operation or sender ticket.

### Quarantining a legacy rotation without a provable successor

`control rotation-quarantine` provides a local preview and explicit digest-bound management commit for an original force-new rotation that remains DELIVERY_UNKNOWN without a successor/native witness. Preview opens the existing store without initialization, uses query_only and a deferred read transaction, and does not wake Ego or take the writer lock. Confirm revalidates authority, the exact operation/logical/registry/runtime/checkpoint and competing ownership under BEGIN IMMEDIATE. It records one immutable management event and changes only the logical state to QUARANTINED. Original UNKNOWN/result/attempts, current owner/epoch, controls and remote execution remain unchanged; identical replay reports history and the current logical state.

Preparing from QUARANTINED requires that exact event and a newer checkpoint for the current owner; an explicit handoff must equal its rendering. Prepare compares the role-scoped logical rows, registry, checkpoint, event and competing rotations again inside its existing writer transaction. A custom logical-ref cannot bypass the protected role. Every later normal ACTIVE rotation carries the retained same-scope event in operations.event_id and uses the current owner/epoch, rather than the event's historical owner/epoch.

The final state-store registry put is the shared registration boundary for new/register/sync and legacy children. It applies the existing base/next delta in memory under BEGIN IMMEDIATE, then fences every new/reactivated/rerouted active or pending protected role across aliases/accounts. Ordinary puts cannot activate that role. A pending candidate must pass the exact release's delivery_attempt.verify_current on the same SQLite handle and match the current force-new rotation, event, owner, scope/account, body/header/epoch, Project/CID and occupancy. Existing same-CID routing/status metadata updates, retirement and unrelated roles remain compatible. There is no new age expiry: an expired claim means its persisted status or attempt/claimedAt/manifest tuple is no longer current.

A rejected put commits only bounded REGISTRATION_FENCED reconciliation evidence, leaving registry/runtime/projections unchanged. Supplied CID/URL remain UNAUTHENTICATED_REGISTRATION_PROPOSAL and nativeDeliveryProof=false. An owned manifest that matches the historical operation may separately identify an expired claim; this does not authenticate the proposed CID or authorize replay. The private filesystem boundary does not authenticate arbitrary code running as the same user.

Event-linked ACK requires an account-authenticated exact successor callerRef, nonempty verification, one matching SENT operation/session and one pending candidate. The locked transaction compares operation/event plus registry/logical/runtime and requires the only active same-role predecessor across accounts to be the current owner. It retires that owner, activates the successor and advances the epoch atomically. The event continues to fence late registrations after ACK. Queue result plus controller queue ack remains the business acceptance contract.

Finally, finish matches the captured claim ordinal and claimed_at as well as DISPATCHING. A zero-row update returns the current operation without pending/callback/management side effects; stale completion cannot bind a successor or rewrite a later claim.
