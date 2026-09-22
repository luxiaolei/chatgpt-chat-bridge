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

A session record contains conversation identity plus routing metadata such as logical role, account, lifecycle status, model/effort, Space, and tab/page attachment.

The runtime file contains reconstructable orchestration state such as active task IDs and recent project execution metadata. It must never outrank GitHub Issues/PRs as project truth.

### Logical project → account → Space

The control-plane hierarchy is:

```text
Logical Project
  ├─ ChatGPT account binding A → one Ego Space → many tabs/sessions
  └─ ChatGPT account binding B → one Ego Space → many tabs/sessions
```

All new sessions for the same project/account are created with `task.newPage()` inside the bound Space. A normal session creation must not create a new Space. A separate Space should be created only for explicit Space tests, account isolation, or a deliberate rebind. `chat-bridge space prune --project NAME` closes stale tabs that are not the control tab or an active registered session.

A ChatGPT conversation ID is independent of its Ego Space attachment. Rebinding a project/account to another Space preserves conversation identity and causes sessions to reattach in tabs in the new Space.

### Account failover

Account records are routing identities. Each logical project may bind to a different ChatGPT Project and Ego Space for each account. The bridge does not automate credentials; the selected Space must already have authorized access to that ChatGPT account/project.

Cross-account continuation should use GitHub durable state plus a handoff summary, then create or register a replacement session under the alternate account binding.

### Session lifecycle

Sessions have lifecycle state (`active`, `archived`, `retired`, or `deleted`). `retire` archives the remote ChatGPT conversation and removes it from the active routing pool while preserving history in the registry. `forget` is registry-only. `delete` is destructive and requires explicit confirmation.

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
GPT-5.6 Sol + High
```

The `GPT-6 Pro` bridge preset is intentionally represented as:

```text
Latest + Pro
```

because the current ChatGPT UI exposes the highest path through the `Latest` model choice plus the rightmost `Pro` thinking level.

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

### Completion callback

```text
Worker
  │
  ├─ update GitHub Issue / PR
  │
  └─ chat-bridge send conductor RESULT
                                  │
                                  ▼
                             Conductor Chat
                                  │
                                  ▼
                           next orchestration turn
```

A callback should carry a stable `task_id` and GitHub URL.

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

Two supported patterns are:

- Chat → Remote Desktop Commander → local CLI/tools
- Chat/Codex → local or Web Codex environment → local CLI/tools

For tasks that do not need local state, prefer direct Chat + GitHub work.

## Security boundary

The runtime controls a logged-in browser profile. Any process with access to the same user account and local browser control surface may be able to affect that session.

Do not expose the local runtime to untrusted users and do not commit browser state or the local registry.
