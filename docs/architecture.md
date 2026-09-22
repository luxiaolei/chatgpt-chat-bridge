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

## Registry

The bridge stores discovered and created sessions at:

```text
~/.config/chat-bridge/registry.json
```

The v2 registry separates logical identity from browser attachment:

```text
Logical Project
  └─ Account binding
       ├─ ChatGPT Project URL / ID
       ├─ preferred Ego Space name
       └─ runtime spaceId cache
            ├─ role/session A → tab/page
            └─ role/session B → tab/page
```

A session record contains `project`, `account`, `role`, `status`, conversation ID/URL, model/effort, `spaceName`, the current `spaceId` cache, and page label. A v1 registry is migrated in place; old per-session Space IDs are kept as `legacySpaceId` evidence but attachments are rebuilt in the project-bound Space.

The registry is a routing cache, not the authoritative project state. Space IDs are not treated as permanent identifiers because Ego Lite may rebuild a Space and assign a new ID.

## Runtime state

Ephemeral control-plane state is stored separately at:

```text
~/.local/state/chat-bridge/runtime.json
```

It records recent project/account/Space activity and is safe to reconstruct. GitHub remains durable state.

## Project, account, and Space binding

The bridge uses one preferred Ego Space for each logical Project + account binding. `chat-bridge new` calls `task.newPage()` inside that Space, so parallel worker sessions become tabs rather than new Spaces. Rebinding a project clears page attachments; sessions are lazily reattached to the new Space by conversation URL.

Multiple ChatGPT accounts can represent the same logical project. Each account has an independent ChatGPT Project URL and Space binding. Switching the bridge's active account changes the endpoint selected for new/routed sessions; actual browser authentication remains an Ego Lite/browser responsibility.

## Roles and session lifecycle

A role name is stable while individual conversations can be replaced. Only active sessions participate in role routing. Lifecycle operations are:

- `archive`: archive the remote conversation and mark the session inactive.
- `retire`: archive, mark retired, and close its attached Ego tab.
- `forget`: remove only the local routing record.
- `delete`: delete the remote conversation after explicit `--confirm DELETE`.

`space prune` closes tabs in the bound Project Space that are neither the control page nor referenced by an active session.

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
