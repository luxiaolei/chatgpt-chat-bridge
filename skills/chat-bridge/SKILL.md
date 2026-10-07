---
name: chat-bridge
description: Discover, create, route, inspect, recover, and configure ChatGPT Project chats through Ego Lite's native ego-browser runtime.
---

# chat-bridge

Use `chat-bridge` to control ChatGPT Project chats from an agent without desktop-coordinate automation.

## Preconditions

- Ego Lite is installed and logged in.
- `ego-browser` is available.
- Run `scripts/install.sh` from this repository, or invoke `bin/chat-bridge` from the checkout.

After any Chat Bridge upgrade, controller/setup Chats must re-read the installed `chat-bridge` and `project-conductor` Skills before relying on routing, account, Space, or model behavior.

For local repository work in this deployment, discover an authorized Computer plugin whose display name starts with `ChatGPT Computer`, then verify its actual target host/capabilities before use. The account-specific suffix is not stable identity. Git/GitHub writes default to the configured execution host's local `git`/`gh`; do not infer GitHub identity from the ChatGPT account and do not switch to Remote Desktop Commander unless the user explicitly requests it.

## GitHub Project management binding

A ChatBridge logical Project can optionally bind to a **GitHub Projects v2** board. This is management metadata and is intentionally separate from the ChatGPT Project/account/Space binding below.

Local-only commands (they do not open ChatGPT Web):

```bash
chat-bridge github-project bind --project "PROJECT" --owner OWNER --number 8
chat-bridge github-project show --project "PROJECT"
chat-bridge github-project inspect --project "PROJECT"
chat-bridge github-project refresh --project "PROJECT"          # preview only
chat-bridge github-project refresh --project "PROJECT" --apply  # explicit, configured safe writes only
chat-bridge github-project unbind --project "PROJECT"
```

`bind` verifies the board through the host-local `gh` identity and stores only owner/number/id/url plus explicit sync policy in the Bridge registry. It does not create a board, configure GitHub Auto-add, move Chats, dispatch tasks or change source Issues/PRs.

Optional refresh policy is configured at bind time, for example:

```bash
chat-bridge github-project bind --project "HZ OS" --owner luxiaolei --number 4 \
  --source-query 'repo:luxiaolei/huazhuo-blueprint is:open' \
  --source-query 'repo:luxiaolei/huazhuo-runtime is:open' \
  --map-status 'status:backlog=Backlog' \
  --map-status 'status:ready=Ready'
```

Every source query must explicitly contain `repo:` and `is:open`. `refresh` reads all board pages and verifies search completeness; an incomplete/inaccessible read is an explicit error, never an empty project. `--apply` may only add configured open source references and mirror explicitly configured **nonterminal** Issue-label statuses after source/version and Project-field read-back checks. It refuses terminal/acceptance-like mappings such as Done/Closed/Accepted/Deployed. It never edits/closes source Issues, merges PRs, retries UNKNOWN delivery, dispatches workers, acknowledges results or switches a runtime release.

If a logical project has no GitHub Project binding, existing routing and Issue-first controller behavior are unchanged. See `docs/github-projects.md`.

## Project discovery

Refresh the actual ChatGPT Project before routing:

```bash
chat-bridge sync --project "PROJECT NAME"
chat-bridge list --project "PROJECT NAME"
```

`sync` opens the real ChatGPT Project page, discovers its chats, and updates the local registry at `~/.config/chat-bridge/registry.json`.

List visible ChatGPT Projects:

```bash
chat-bridge projects
```

## Route messages

Fire-and-forget:

```bash
chat-bridge send AGENT_ALIAS "message" --project "PROJECT NAME" --task TASK_ID
```

RPC-style call that waits for the assistant response:

```bash
chat-bridge ask AGENT_ALIAS "message" --project "PROJECT NAME"
```

Read the most recent assistant response:

```bash
chat-bridge read AGENT_ALIAS --project "PROJECT NAME"
```

Inspect generation/liveness state and configured resources:

```bash
chat-bridge status AGENT_ALIAS --project "PROJECT NAME" --task TASK_ID
```

`status` returns a state such as `RUNNING_ACTIVE`, `RUNNING_QUIET`, `SUSPECT_STALL`, `IDLE_COMPLETE`, `IDLE_INCOMPLETE`, `ERROR_RECOVERABLE`, or `BLOCKED`, plus heartbeat fields including `lastProgressAt`, `quietForSec`, message IDs, recovery controls, and a recommended action.

## Create and register sessions

Create a new Chat inside a ChatGPT Project:

```bash
chat-bridge new --project "PROJECT NAME" \
  --name research-agent \
  --model Latest \
  --effort High \
  --message "Initial role and task"
```

The command captures the conversation ID, project-scoped URL, model, effort, and current tab attachment in the registry. The target architecture is one Bridge-managed Ego Space per verified ChatGPT login/Profile, with multiple Project and conversation tabs inside it. Conversation identity is durable; Space/page labels are recyclable runtime attachments. Do not create a new Space per session or per Project merely for concurrency.

## Accounts and Space binding

```bash
chat-bridge account add secondary --label "Secondary ChatGPT"
chat-bridge account use secondary --project "PROJECT NAME"
chat-bridge bind --project "PROJECT NAME" --account secondary --url "PROJECT URL" --space "SPACE NAME"
chat-bridge space show --project "PROJECT NAME" --account secondary
chat-bridge account identify --project "PROJECT NAME" --account secondary
```

For Project/location setup and Space convergence:

```bash
chat-bridge project ensure --project "PROJECT NAME" --account secondary
chat-bridge project ensure --project "PROJECT NAME" --account secondary --create --confirm
chat-bridge space consolidate --account secondary
chat-bridge space consolidate --account secondary --confirm
```

`project ensure` reuses a real accessible ChatGPT Project when possible. Creating one requires both `--create` and `--confirm`; it does not log in, share a Project, or copy private files. `space consolidate` is dry-run by default and migrates only after bound Projects are paused/drained, unknown deliveries and callbacks are cleared, and legacy Agent Spaces have no open Tabs or drafts. It closes only emptied Agent Spaces; human-owned Spaces remain outside automated cleanup. A verified login/Profile normally uses one Bridge-managed `chat-bridge-agent-*` Space across Projects.

For a Project whose owner explicitly authorized draft discard and bounded extra capacity, use the actual host-local or registered management identity:

```bash
chat-bridge policy set --project "AUTHORIZED PROJECT" --draft-policy discard --max-overflow-spaces 2 --confirm
chat-bridge policy show --project "AUTHORIZED PROJECT"
```

Policy is persistent and local-only; defaults are `preserve` and one overflow. The shared identity/Profile pool permits primary plus at most two overflow Spaces (24 pages), reclaiming existing pool pages before creating at most one additional Space per normal allocation. Strictly verified existing mapped Spaces can be reused immediately; new or advanced Spaces retain the 120-second capacity wait and policy budget. Old attachments remain mapped and eligible for scoped prune/admitted automatic cleanup. Explicit discard enables the shared normal dispatch/send and safe reclaim guard only for unchanged text-only drafts after complete durable private backup (0600), fresh login/Project/conversation and input/control checks. Attachments, partial input/send intent, UNKNOWN/unbound delivery, user pause and uncertain clearing remain protected. Do not infer permission from another Project or clear a draft through a separate private routine.

The final native action compares the backed-up document/text/form, exact URL and current attachment/UI state and deletes through one synchronous transaction after the intent is durable. If the characterized editor lacks that capability, `DRAFT_DISCARD_UNSUPPORTED` preserves the draft; do not fall back to fill, keyboard deletion or direct DOM changes.

Treat `spaceName` as the stable binding and numeric `spaceId` as a runtime cache. Account bindings do not perform credential login; the bound Ego Space must already have access to the intended ChatGPT account/project.

Identify each binding from an existing managed ChatGPT page. The stable logged-in user ID (never tokens) shares cooldown across aliases/projects/Spaces; different users remain independent. Until identified, cooldown follows the configured alias and is explicitly unverified: reuse the alias for the same login. Re-identify after changing login/profile/Space; a different login requires another alias. Account-wide discovery uses a bound page, never an arbitrary default-profile global Space.

For a ChatGPT Web controller, a user request that does not name a destination Project means the Project containing the controller's current Chat. Identify that Project from the current Chat's context and pass its name as `--project`; an explicitly named destination Project overrides it. The tunnel does not supply the source Chat's Project. Never substitute the registry's default Project or infer a Project from the Space name. If the current Chat is outside a Project or its Project cannot be verified, ask for the destination Project before sending.

Using the controller's own ChatGPT Computer connection: pass the destination Project with `--project` and the target Chat by its registered alias, then omit `--account` and `--space`. A linked tunnel supplies the stable `CHAT_BRIDGE_FROM_ACCOUNT_ID` hint; older tunnels may supply a Space label. The bridge verifies a matching login and uses that account's binding for the named Project. Neither hint identifies the source Chat or its Project, and neither is an authentication boundary. An unknown or mismatched origin fails closed.

A local shell call outside the connected computer has no automatic origin. If the origin is missing and a Project is bound to different logins, use `--account` only when the intended account is known; never guess from the default account or Space name. An origin with no matching Project binding fails closed. The local skill file is not automatically loaded into ChatGPT Web; a Web controller must read it through its connected computer before relying on these rules.

One account may have multiple Projects, and one Project may appear in multiple accounts and Spaces. The observed Space catalog is separate from each project's configured routing Space:

```bash
chat-bridge space scan --space "EXISTING SPACE NAME"
chat-bridge space map
chat-bridge space restore --space "EXISTING SPACE NAME"
chat-bridge space restore # all scanned Spaces
chat-bridge space gc      # dry-run only
chat-bridge space gc --confirm
```

Scan records the actual logged-in user ID/display name, Profile, and Project URLs from open tabs, not credentials. Human-owned Spaces remain untouched by automated dispatch; Bridge may use a separate managed Agent Space for the verified login/Profile and keep multiple Project tabs there. A Project binding is not eligible for new work when that login's observed catalog does not contain its actual Project ID. Restore verifies login identity before opening missing tabs; changed/expired logins require user action.

For HZ OS work moved to `hzcodex`, first verify that `hzcodex` actually has an HZ OS ChatGPT Project and bind its observed ID/Profile. A copied Project ID from the Ru Wang account is not proof. Keep Ru Wang's existing sessions and in-flight tasks where they are; change only new-task admission after verification. The `hzcodex` Web GitHub connector may use a different identity: HZ OS repository work must use this Mac's `xlmini` local Git/`gh` through ChatGPT Computer, checking the target repository remote and local `gh auth status` before any push/PR. Do not silently switch GitHub accounts or credentials.

## Durable dispatch queue

When the controller knows its registered session reference, use the queue for asynchronous work. `callerRef` pins the source Chat, so an omitted `--project` uses that Chat's registered Project; an explicit Project is an intentional cross-project route. The tunnel does not supply `callerRef`, so never infer it from a Space or account.

```bash
chat-bridge queue submit --request-id HZ-001 --caller-ref CONTROLLER_SESSION_REF --role WORKER_ROLE --message "Task envelope"
chat-bridge queue status OPERATION_ID
chat-bridge queue list
```

A controller may pin actual execution resources in the durable operation:

```bash
chat-bridge queue submit --request-id HZ-002 --caller-ref CONTROLLER_SESSION_REF \
  --role WORKER_ROLE --model Latest --effort High --message "Task envelope"
```

For normal worker completion, do not hand-code the callback destination. The queue injects the persisted callback contract. The worker reports a durable result:

```bash
chat-bridge queue result --task TASK_ID --status COMPLETE \
  --summary "what changed" --github "https://github.com/OWNER/REPO/issues/123"
```

That records the result first and queues the callback to the owning controller. Callback `SENT`/`DELIVERED` is not business completion. After review, the current owning controller acknowledges:

```bash
chat-bridge queue ack --task TASK_ID --result-version 1 \
  --caller-ref CONTROLLER_SESSION_REF --status ACCEPTED --message "reviewed"
```

Only an accepted result becomes `COMPLETE`; rejected/blocked results remain visible for follow-up.

### Local Codex App / CLI owner

For an explicitly requested dispatch from a local Codex task, use its actual
`CODEX_THREAD_ID` with the `codex:` prefix. Supply an explicit destination Project
and an existing, active `sessionRef` discovered with `sync` / `list`. Do not invent
a Web caller identity or route an ordinary skill invocation without dispatch
authorization. ChatGPT cloud Work is outside this path.

```bash
chat-bridge queue submit --request-id LOCAL-001 \
  --caller-ref "codex:$CODEX_THREAD_ID" --project "PROJECT NAME" \
  --session-ref VERIFIED_WORKER_REF --message "Bounded task and execution contract"
chat-bridge queue receive --task TASK_ID --caller-ref "codex:$CODEX_THREAD_ID" --wait-seconds 50
```

The queue saves the originating thread, host and working directory. `receive`
waits on local persisted results for at most 55 seconds, without touching Ego or
starting a Codex turn. `PENDING` is not completion: inspect the returned operation
status, respect unknown delivery, and continue bounded waits while the caller is
active. If the caller exits, the result remains `WAITING_LOCAL`; the same thread
on the same host can receive it after resuming. This is local polling, not MCP
Events or a background wake-up service.

The Worker uses the same `queue result` command. It does not choose a receiver.
Read the returned result as tool data, verify its evidence, then run `queue ack`
using the same `codex:$CODEX_THREAD_ID`, exact result version and a review message.
Only that ACK records local receipt (`RECEIVED_LOCAL`) and business acceptance.
Reads are replayable by event ID; a failed read never consumes a result.

When requesting local resource use, include the verified execution host, repo
path and allowed actions. Require the Worker to discover its authorized
`ChatGPT Computer` connection, confirm the actual host/cwd/Git remote, read repo
instructions and this installed skill, then execute. A prompt does not enable
an unavailable connector. Report `BLOCKED` when the connection is unavailable.

Local thread IDs and tunnel-origin environment hints prevent accidental routing
mixups; they are not authentication against other processes with the same OS-user
access. Tunnel-origin callers cannot submit, receive or ACK as a local Codex owner.

The queue returns a durable operation ID. `QUEUED` is not delivery; `SENT` confirms only the ChatGPT user message, not task completion. For `DELIVERY_UNKNOWN`, use the host-local `chat-bridge queue reconcile --operation OPERATION_ID`. It reads the bound Chat without sending, matches the exact user message, account, Project, conversation and message ID, and audits the attempt. Proven delivery becomes `SENT`; inconclusive delivery stays `DELIVERY_UNKNOWN` and must not be blindly resent. This covers dispatch, callback, and management operations. Start the local worker with `~/.local/share/chatgpt-chat-bridge/install-coordinator.sh` after installing Bridge; `queue work-one` processes one claim manually. A controller without a known `callerRef` must supply an explicit Project to the direct `send` command instead of guessing its source Project.

If a management UNKNOWN targets a retired controller whose committed successor is active for the same Project, reconciliation may record `RECONCILED_SUPERSEDED` from the persisted rotation link. This is lifecycle evidence only: it sends nothing and does not clear ordinary dispatch/callback UNKNOWN records.

A worker failure proven to occur before the send control was triggered is safe to retry with the same operation. Transient UI-readiness failures are requeued with bounded backoff (three attempts); other proven pre-send failures become `FAILED_PRE_SEND` and can be manually retried with `chat-bridge queue retry --operation OPERATION_ID`. A failure after a send attempt remains `DELIVERY_UNKNOWN` and cannot use either retry path.

### Automatic dispatch boundary

For controller-driven work, prefer `queue submit` with `callerRef + role`.

The **controller chooses the logical role**. Chat Bridge does not use an LLM to guess the role from task prose.

Once the role is supplied, Bridge handles mechanical placement:

- infer the logical Project from the exact registered `callerRef`;
- reuse the unique active role session when available;
- otherwise create a new role session;
- for a new session, choose an eligible verified account/Project binding using current capacity and cooldown state;
- keep an existing session pinned to its existing account;
- use the managed Agent Space for the selected login/Profile without taking over a human-owned Space.

A controller normally should not specify raw conversation IDs, page labels, Space IDs, or accounts. Those are runtime attachments. Specify them only for an intentional override, diagnosis, or a known existing target.

`queue submit` also reserves a new logical role placement atomically so concurrent requests cannot silently create the same role on two accounts. New placements exclude locally cooling accounts; an already accepted/sticky session is not silently migrated.

For an observed Project whose chat tabs do not show its name, verify the Project page and then run `chat-bridge space label --space "SPACE" --project-id "g-p-..." --name "NAME"`. This does not change routing.

## Session lifecycle

```bash
chat-bridge archive AGENT_ALIAS --project "PROJECT NAME"
chat-bridge retire AGENT_ALIAS --project "PROJECT NAME"
chat-bridge forget AGENT_ALIAS --project "PROJECT NAME"
chat-bridge delete AGENT_ALIAS --project "PROJECT NAME" --confirm
```

Prefer `retire` for replacing a context-heavy or unhealthy role session. `delete` is destructive and must remain explicitly confirmed.

A hard `Context too long` / maximum-conversation condition is not a Retry case. Watchdog classifies it as `CONTEXT_EXHAUSTED` and stops mechanical continuation. Use a checkpointed two-phase replacement:

```bash
chat-bridge queue checkpoint --project "PROJECT" --role ROLE --session-ref SESSION_REF \
  --version CP-1 --summary "state needed by successor"
chat-bridge control rotation-prepare --project "PROJECT" --role ROLE --confirm
# successor verifies current Skills/tools/host/model, then:
# SUCCESSOR_SESSION_REF is this successor's actual sessionRef / persistent CID in its own URL, not the predecessor or a local Codex thread ID.
chat-bridge control rotation-ack --rotation ROTATION_ID --caller-ref SUCCESSOR_SESSION_REF --message "verified"
```

The logical role/controller remains stable while the concrete conversation gets a new generation. Late callbacks follow only a committed successor mapping; old conversations are retained as history instead of being deleted.

A legacy rotation with no registered successor or retained native witness may be quarantined only by authorized management. This preserves the original UNKNOWN and does not prove a remote child stopped. Preview is local and read-only; confirm requires its exact digest:

```bash
chat-bridge control rotation-quarantine --operation OLD_OPERATION --caller-ref MANAGEMENT_REF --reason "retained evidence and recovery decision"
chat-bridge control rotation-quarantine --operation OLD_OPERATION --caller-ref MANAGEMENT_REF --reason "retained evidence and recovery decision" --expected PREVIEW_DIGEST --confirm
# Record a new checkpoint for the same current owner after quarantine, then:
chat-bridge control rotation-prepare --project "PROJECT" --role ROLE --quarantine-event EVENT_ID --caller-ref MANAGEMENT_REF --confirm
# The actual successor verifies its role/tools/host/model through its account connection:
chat-bridge control rotation-ack --rotation NEW_ROTATION --caller-ref SUCCESSOR_CID --message "verification summary"
```

The retained quarantine event permanently fences new/reactivated active registrations for that Project/role/workgroup across account aliases. A current owned rotation claim may register only pending-rotation; its exact SENT successor must ACK before ownership changes. Later normal ACTIVE rotations carry the event automatically and use the current owner/epoch. Rejected registrations retain bounded declared CID/URL evidence; they are not native delivery proof or authorization to replay. Existing same-CID metadata/attachments and unrelated roles retain normal behavior.

Before successor ACK, `status EXACT_CID` or `read EXACT_CID` may inspect its existing managed tab. This read-only path verifies the exact SENT rotation/current logical pending scope and fresh login, then rechecks the same anchor. It does not ACK, clear pauses, attach another tab or permit mutations; `queue observe` still applies only to UNKNOWN operations.

For an unknown native submit format, retain the original `PRE_SEND` / `FORMAT` / `UNSUPPORTED` failure. The shared normal failure path saves bounded descriptor/function shape in private `native-format-evidence` files; `nativeFormatEvidence` contains only the path/hash/bytes or an explicit retention failure. Capture stops at 128 globally unique editor candidates, 16 KiB UTF-8 per function source or 256 KiB per private file. A diagnostic with `truncated=true` / a `limit` is incomplete; omitted or partial source must never characterize an accepted format. Read and verify that file before characterizing an exact adapter change. It is diagnostic evidence, not session binding, delivery or permission to retry an UNKNOWN operation.

Future `new` calls retain their confirmed native creation witness. Shared sends can reuse its temporary source mapping only with the same account/Project/CID/getter/serializer and an exact fresh BEFORE UID/full-body proof, followed by a fresh current UID and full native body. Absent historical creation proof stays absent; never backfill it from an equal current body or URL.

Before filling a future existing-chat native send, the shared sender requires direct persistent source binding or the valid retained creation proof. A bound temporary source without that proof may use one standard same-CID reload, guarded by fresh login, empty raw composer/attachments, no generation/approval/context/recovery error, unchanged registry/current claim and RUNNING control without user pause/Image occupancy. Afterward the same prior UID/full bytes must bind directly to the persistent CID, native support is rechecked before input, and scoped user pause is synchronously reread after the final native source/UI sample. Failure is explicit PRE_SEND UNSUPPORTED with no fill/Send; it neither manufactures an alias nor settles an old UNKNOWN operation.

## Runtime task cache

```bash
chat-bridge task set TASK_ID --project "PROJECT NAME" --role ROLE --status RUNNING --github URL
chat-bridge task list --project "PROJECT NAME"
chat-bridge task clear TASK_ID --project "PROJECT NAME"
```

Runtime state lives under `~/.local/state/chat-bridge/` and is reconstructable. GitHub remains authoritative.

## Models and Thinking Level

Model choice and Thinking Level are independent controls.

In the current ChatGPT Web deployment used by this Bridge:

- `Latest` is a moving model choice; its underlying version is not verified by the UI label alone.
- Thinking Level is the slider: `Instant → Medium → High → Extra High → Pro`.
- `Pro` is the rightmost slider position.
- The Bridge preset `GPT-6 Pro` selects `Latest + Pro`; the observed UI choice must be reported as `Latest`, not as a verified fixed GPT-6 version.

New sessions default to `Latest`. They do **not** force `Pro`; if effort is omitted the page default is preserved.

Select the two controls separately:

```bash
chat-bridge model research-agent Latest --project "PROJECT NAME"
chat-bridge effort research-agent High --project "PROJECT NAME"
```

Or set them together:

```bash
chat-bridge model research-agent Latest --effort "Extra High" --project "PROJECT NAME"
chat-bridge model research-agent "GPT-6 Pro" --project "PROJECT NAME"
```

Recommended controller allocation:

- routine lookup/routing/status: `Latest + Instant/Medium`
- normal implementation/debugging/research: `Latest + High`
- difficult architecture/review/ambiguous debugging: `Latest + Extra High`
- highest-stakes synthesis/final critical review: `Latest + Pro`

Older pinned models such as `5.6 Pro` or `5.5 Pro` remain explicit compatibility choices; never silently downgrade to them. Unavailable/ambiguous choices fail explicitly.

Before every `send` or `ask`, the Bridge re-applies the session's configured model and effort and confirms the UI selection. A reattached conversation therefore cannot silently inherit a lower Thinking Level. `status`, `send`, `ask`, `new`, `model`, and `effort` expose UI-observed `modelSelection` (`model`, `effort`, `raw`); that observed value is the runtime truth.

## Watchdog and recovery

Dispatch tracked work with `--task`; this records the pre-dispatch assistant baseline and lets the watchdog distinguish a new result from an idle/stopped turn.

```bash
chat-bridge send research-agent "TASK ENVELOPE" --project "PROJECT NAME" --task T-001
chat-bridge watch --project "PROJECT NAME" --dry-run
chat-bridge watch --project "PROJECT NAME"
```

The watchdog uses multiple signals: Stop/Send/composer controls, stable ChatGPT message IDs, assistant text/hash/length, a page-side MutationObserver, recovery/error UI, and elapsed time since real progress. Quiet thresholds are warnings, not automatic cancellation deadlines. `SUSPECT_STALL` returns `INSPECT_WITHOUT_STOP` and queues one owner notice per quiet episode without consuming recovery attempts. Requested and observed effort are recorded separately; a lower observed effort cannot shorten the requested effort's default warning budget. If the bound Space is `user` or `agentDelegatedToUser`, watchdog must not claim or switch that Space: it records `watchdogPausedForUserControl`, and later preflight suppresses that task locally until an explicit `send`, `ask`, `retry`, `recover`, or `resend` clears the pause.

Install the macOS launchd watchdog (all projects, one-shot scan every 60 seconds):

```bash
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 60
```

Remove it with `~/.local/share/chatgpt-chat-bridge/uninstall-watchdog.sh`.

Recovery uses a unique exact current-conversation native Continue/Try again/Retry control, then a guarded `continue` for an actually incomplete/error turn. Quiet generation alone is never stopped automatically. Stop + guarded continue and original-task replay require explicit `--aggressive`; inspect current durable/tool progress first. Recovery rechecks task state and will skip results already recorded or accepted. Repeated failures mark the task `BLOCKED` and wake the owning controller/root escalation chain for GitHub reconciliation.

ChatGPT-Web-touching commands are serialized per verified login identity, including aliases of the same account; different logins have separate pacing gates. Normal UI work cannot run faster than 10 seconds; `new`, `archive`, `retire`, and `delete` cannot run faster than 30 seconds. The default UI pacing inline budget is 12 seconds and the separate lock-wait budget is at most 5 seconds; longer waits return `PACING_DEFERRED` (exit 75). Watchdog separates tasks on the same login by at least 10 seconds. `Too many requests` creates an adaptive 3–15 minute account-scoped cooldown; manual commands return `WEB_COOLDOWN_ACTIVE`. Watchdog skips that identity but continues others, and never starts Ego when no eligible tasks remain. Use `cooldown status --account ALIAS` (or `--project NAME`) and `cooldown clear --account ALIAS --confirm`. Legacy global cooldown protects only the default account. A pacing lock is not an account quota.

Stop an active generation:

```bash
chat-bridge stop AGENT_ALIAS --project "PROJECT NAME"
```

Use a unique exact current-conversation Retry/Try again control; this never falls back to Regenerate or Continue:

```bash
chat-bridge retry AGENT_ALIAS --project "PROJECT NAME"
```

Automatic recovery:

```bash
chat-bridge recover AGENT_ALIAS --project "PROJECT NAME"
```

`recover` uses the same conservative recovery policy. It does not re-send the original user task unless `--aggressive` is explicitly supplied. A hard context limit is never handled by Retry/Continue; it requires the checkpointed rotation flow above.

Running tasks stay attached by default. Once a task has a durable `RESULT_RECORDED` or terminal status, is past the configured grace window, passes the generation/draft/ownership and exact Project/conversation guards, and the page is Bridge-managed, watchdog may close that Tab and leave the conversation registered for lazy reattach. Tab selection alone does not protect a proven terminal registered page; selected orphan/user-owned Tabs stay protected. Authorized text-only drafts still need complete private backup before the shared guarded discard. Closing a running Tab is not assumed safe; detached-running remains experimental and is not the default policy.

## Management control plane

Local status/topology/runtime/task/event reads do not wake Ego:

```bash
chat-bridge health
chat-bridge control status
chat-bridge topology
chat-bridge runtime
chat-bridge task list --project "PROJECT"
```

`health` is a global local-only summary, not a live browser scan. It separates historical errors, nonterminal task records, user-control pauses, and page observations fresh within 180 seconds. `recentlyObservedGenerating` is a cached observation, not proof that a remote model is still running. Routine local reads use SQLite `peek` without rewriting compatibility JSON. `state-store.py get` remains the explicit projection-repair path. An idle/cooling watchdog never starts Ego just to scan orphan tabs; admitted maintenance is account-scoped and is not repeated after every task child.

`control status` separates business intent from technical admission. `businessState` / `businessStateReason` describe the owner-facing project state (for example `REPLANNING`, `NOT_STARTED`, `PAUSED`, or `INTERNAL_TEST`), while `control.mode` (`RUNNING`, `PAUSED`, `DRAINING`) only controls whether new Bridge business work may enter. `durableStateRef` is the stable root ledger/index the controller should re-read on reconciliation; it may link to GitHub Issues/PR evidence rather than duplicating all project state in Chat.

Workgroups are durable admission scopes inside a project. The root controller approves each group's charter, parent, controller, and revision; a delegated controller may operate only its own group. Use the existing control plane with `--workgroup GROUP_ID` for group pause, drain, resume, and status. Project and global controls remain stronger than a child-group resume. Queued dispatches recheck the saved scope epoch before sending, so a pause takes effect after enqueueing.

Create or revise a group with an expected revision; preview first and read back the applied record:

```bash
chat-bridge control workgroup --project "PROJECT" --workgroup-id GROUP_ID \
  --name "Group name" --controller-session-ref OWNER_SESSION \
  --charter-issue "#31" --expected-revision 0 --dry-run --confirm
chat-bridge control workgroup --project "PROJECT" --workgroup-id GROUP_ID \
  --name "Group name" --controller-session-ref OWNER_SESSION \
  --charter-issue "#31" --expected-revision 0 --confirm
```

Admission control is persistent:

```bash
chat-bridge control pause --project "PROJECT" --reason "upgrade" --confirm
chat-bridge control drain --project "PROJECT" --reason "upgrade" --confirm
chat-bridge control resume --project "PROJECT" --confirm
```

`pause`/`drain` block new business admission while result recording, callbacks, ACKs, and management recovery remain available. `stop-running` is a separate explicit operation because stopping generation cannot undo external side effects.

Broadcasts are scoped, previewable, persistent, and individually acknowledged:

```bash
chat-bridge control broadcast --project "PROJECT" --kind RELOAD \
  --message "Re-read installed Skills and verify version/host/model"
chat-bridge control broadcast --project "PROJECT" --kind RELOAD \
  --message "Re-read installed Skills and verify version/host/model" --confirm
chat-bridge control ack --event EVENT_ID --caller-ref CONTROLLER_SESSION_REF \
  --status ACKNOWLEDGED --message "checked"
```

Management authority is distinct from a normal task `callerRef`. Host-local administration may bootstrap approved controller admins; Web-originated workers cannot grant themselves global control.

## Routing rules

- Prefer stable logical role/registry aliases over raw conversation IDs.
- Keep a verified managed Agent Space per login/Profile, with Project tabs as needed; do not take over a human-owned Space.
- A role should normally have one active session per project/account; retire the old session before replacement.
- Sync before dispatching a multi-chat batch.
- Use `ask` when the caller must synchronously consume the result.
- Use `send` for callback/event delivery to another Chat.
- Treat GitHub Issues and PRs as the durable project record; Chat messages are coordination events, not the source of truth.
- Include a task ID in cross-chat messages to make retries and callbacks idempotent.

## Same-task observation recovery

`chat-bridge reattach ROLE --project PROJECT --account ACCOUNT --task EXACT_TASK --confirm` observes the existing conversation in the account's existing verified Bridge-managed Space. It neither sends/replays a message nor closes old user tabs. `--resume-watch` additionally clears only that exact task's user-control observation pause after a healthy, same-login, empty-composer check. No Project/business pause is cleared; UNKNOWN delivery is not classified as NOT_STARTED. Keep the original task/session identity.

For a taskless current controller, use `chat-bridge reattach ROLE --project PROJECT --account ACCOUNT --current-controller --confirm`; add `--overflow` to select the login/Profile's verified managed overflow target. This host-local operator entry requires the formal ACTIVE current-controller row and an idle, same-login/Project page with exactly one composer and empty untrimmed semantic text. Overflow allocation is previewed; its mapping and attachment commit together only after the checks pass. Failed checks preserve both local records, although a newly allocated physical Space may remain. It it forbids `--task` and `--resume-watch`, never clicks Retry or sends, and never infers a current controller from registry names.

External RPC extraction prefers the exact message-bound Markdown source where available; `lastAssistantTextSource` states whether the source or rendered DOM was used. Unknown source layouts remain explicit fallbacks, never heuristically unescaped or JSON-repaired.

Existing UNKNOWN recovery: see docs/architecture.md, "Recovery of an already created, unregistered rotation". Use operation-anchored queue observe for missing runtime tasks; rotation-recover defaults to preview. Never treat recovery binding as successor ACK.

If that UNKNOWN observation cannot find the exact owned tab and the primary Space is full, it may reuse the existing verified identity/Profile overflow/previous pool. It searches for one exact agent-owned Project/CID tab, or opens the known CID once in one existing Space with available capacity. Duplicate/unowned targets, changed mappings/Profile, user-controlled Spaces and a full pool are explicit refusals. It never creates a Space, saves an attachment/mapping/capacity record, reclaims a page, clears a draft/pause, retries another target, sends or ACKs. Fresh login/Project/CID, target ownership, user pause and the original local anchor still govern the observation. The pending-successor status/read path still requires its one existing registered tab and does not use this capacity fallback.

UNKNOWN observations anchor the complete original operation and exact target/caller, account, binding, related Project and managed-space/overflow scope. Unrelated registry maintenance does not block a read. Formal rotation recovery retains a full-registry preview/CAS guard against lost updates; its pending-successor ACK anchor is unchanged.

A successful observation may close only its own newly allocated page, once. After login/scope checks and the final strict idle, empty-composer/attachment UI sample, it rechecks ownership/Profile and unique CID, then synchronously rereads registry/runtime attachments, user pause and the same observation-scope anchor before close. These checks do not provide cross-system atomicity. Existing worker/pending pages and failed or uncertain reads stay open. The allocated-page receipt reports `temporaryObservationPageClosed` and a bounded cleanup condition; a cleanup refusal/failure leaves the read successful and UNKNOWN unchanged. It is not proof of reduced process memory or restored business execution.


## Per-claim delivery evidence

Queued Web `send`/`new` attempts now create a private immutable claim directory
before starting a child. It retains the claim identity, child PID and configured
timeout, raw stdout/stderr, browser target/baseline, input witness, exclusive
pre-trigger intent, observed source, and termination diagnostics when available.
Use `chat-bridge queue delivery-attempts --operation ID` for a local read-only
file/hash index. This does not start Ego, reconcile, register a candidate or resend.

The synced `SEND_INTENT` is an uncertainty barrier, not proof that the click ran.
Missing stages or empty output never prove absence of delivery. A timeout stays
UNKNOWN even if cleanup captures a successful-looking receipt. Prior attempts are
not overwritten. Direct non-queue callers retain their existing receipt contract;
this journal is not a native parent/alias capability or an RPC execution ticket.
Files are private and may contain complete source; do not upload them to GitHub.
