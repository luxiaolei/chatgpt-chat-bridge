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

A logical Project may still bind several accounts, and each account may expose a different real ChatGPT Project ID/URL. Those Project locations are routing/context records, not reasons to create more Spaces. `space consolidate` previews legacy project-specific bindings and migrates them only after a drained safety check. User/manual Spaces remain outside automated cleanup.

Shared-Space cleanup is physical-Space-aware: protection is aggregated across every Project/control page/active task/session sharing the Space. Only inactive Bridge-managed pages with no generation, draft, active-task reference, or user ownership are reclaimable. Close failure leaves the attachment record intact. `space gc` is dry-run by default and revalidates agent ownership/liveness under the same UI pacing before `finish({keep: []})`.

A ChatGPT conversation ID is independent of its Ego Space attachment. Rebinding a project/account to another Space preserves conversation identity and causes sessions to reattach in tabs in the new Space. Page labels are a bounded runtime pool, not durable session identity: if `task.newPage()` hits the Ego page budget, the bridge may reclaim an idle managed session page and set that session's registry `page` to null. The next use reattaches the same conversation by URL. The control page, active/generating pages, active-task sessions, active tab, and non-empty composer drafts are protected from reclamation.

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

`lastProgressAt` and per-task baselines are stored in runtime state. Per-task `stallThresholdSec` can override the effort-based defaults. A new result is identified primarily by ChatGPT's stable `data-message-id`, with count/hash/length as additional signals.

The watchdog never marks a project task COMPLETE from UI state alone. `IDLE_COMPLETE` becomes `AWAITING_DURABLE_UPDATE`; the owning controller must reconcile GitHub Issue/PR/callback evidence. A Space in `user` or `agentDelegatedToUser` ownership is a hard automation boundary: watchdog does not claim it, persists `watchdogPausedForUserControl`, and later local preflight suppresses that task before browser startup. Explicit user-directed `send`/`ask`/`retry`/`recover`/`resend` clears the pause and allows work to continue through the normal managed-Agent-Space selection path. Mechanical recovery is conservative: native recovery control, then `continue`, then Stop + guarded continue. Original-task replay requires explicit aggressive mode. Exhausted recovery becomes `BLOCKED` and routes an event through `replyTo → controller → escalationTo → rootController`.

For continuous local operation, macOS launchd runs a fresh one-shot `chat-bridge watch --quiet` periodically. A fresh process reloads registry/runtime each scan, so newly created sessions and account/Space rebindings are visible without restarting a daemon.

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

A worker result, callback `SENT`, and controller acceptance are distinct states. `RESULT_RECORDED` can release the finished worker Tab after the safety grace period; business `COMPLETE` requires the owning controller's accepted ACK.

## Synchronous vs asynchronous routing

Use `ask` when the caller needs to block until the target chat finishes and directly consume the response.

Use `send` for event-style routing, especially worker-to-conductor callbacks.

## Recovery

The bridge exposes:

- `status`: inspect generation state and latest messages
- `stop`: stop an active generation
- `retry`: use a visible Retry/Regenerate control
- `resend`: resend the latest user message
- `recover`: combine stop → retry → resend fallback

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
8. continue.

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
