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
  --model "GPT-5.6 Sol" \
  --effort High \
  --message "Initial role and task"
```

The command captures the conversation ID, project-scoped URL, model, effort, and current tab attachment in the registry. New sessions for one logical project/account MUST open with `task.newPage()` inside that project/account's bound Ego Space. Do not create a new Space per session.

## Accounts and Space binding

```bash
chat-bridge account add secondary --label "Secondary ChatGPT"
chat-bridge account use secondary --project "PROJECT NAME"
chat-bridge bind --project "PROJECT NAME" --account secondary --url "PROJECT URL" --space "SPACE NAME"
chat-bridge space show --project "PROJECT NAME" --account secondary
chat-bridge account identify --project "PROJECT NAME" --account secondary
```

Treat `spaceName` as the stable binding and numeric `spaceId` as a runtime cache. Account bindings do not perform credential login; the bound Ego Space must already have access to the intended ChatGPT account/project.

Identify each binding from an existing managed ChatGPT page. The stable logged-in user ID (never tokens) shares cooldown across aliases/projects/Spaces; different users remain independent. Until identified, cooldown follows the configured alias and is explicitly unverified: reuse the alias for the same login. Re-identify after changing login/profile/Space; a different login requires another alias. Account-wide discovery uses a bound page, never an arbitrary default-profile global Space.

## Session lifecycle

```bash
chat-bridge archive AGENT_ALIAS --project "PROJECT NAME"
chat-bridge retire AGENT_ALIAS --project "PROJECT NAME"
chat-bridge forget AGENT_ALIAS --project "PROJECT NAME"
chat-bridge delete AGENT_ALIAS --project "PROJECT NAME" --confirm
```

Prefer `retire` for replacing a context-heavy or unhealthy role session. `delete` is destructive and must remain explicitly confirmed.

## Runtime task cache

```bash
chat-bridge task set TASK_ID --project "PROJECT NAME" --role ROLE --status RUNNING --github URL
chat-bridge task list --project "PROJECT NAME"
chat-bridge task clear TASK_ID --project "PROJECT NAME"
```

Runtime state lives under `~/.local/state/chat-bridge/` and is reconstructable. GitHub remains authoritative.

## Models and thinking

Select a model:

```bash
chat-bridge model research-agent "GPT-5.6 Sol" --project "PROJECT NAME"
```

Select thinking level:

```bash
chat-bridge effort research-agent "Extra High" --project "PROJECT NAME"
```

Observed effort levels are:

- Instant
- Medium
- High
- Extra High
- Pro

### GPT-6 Pro preset

```bash
chat-bridge model research-agent "GPT-6 Pro" --project "PROJECT NAME"
```

The bridge maps this preset to ChatGPT's `Latest` model choice plus `Pro` effort, i.e. the rightmost thinking slider position.

New sessions default to Latest without forcing Pro. `5.6 Pro` and `5.5 Pro` select those versions plus the current rightmost slider endpoint; `model AGENT Latest --effort High` configures the two separately. Unavailable/ambiguous choices fail explicitly. Model quota exhaustion is not conversation-access cooldown: choose an older version explicitly, never silently fall back. `status`, `send`, `ask`, `new`, `model`, and `effort` expose UI-observed `modelSelection` (model, effort, raw); null means unrecognized. `status` separates configured values from observations.

## Watchdog and recovery

Dispatch tracked work with `--task`; this records the pre-dispatch assistant baseline and lets the watchdog distinguish a new result from an idle/stopped turn.

```bash
chat-bridge send research-agent "TASK ENVELOPE" --project "PROJECT NAME" --task T-001
chat-bridge watch --project "PROJECT NAME" --dry-run
chat-bridge watch --project "PROJECT NAME"
```

The watchdog uses multiple signals: Stop/Send/composer controls, stable ChatGPT message IDs, assistant text/hash/length, a page-side MutationObserver, recovery/error UI, and elapsed time since real progress. Normal quiet thinking is not interrupted until the task's stall threshold is crossed.

Install the macOS launchd watchdog (all projects, one-shot scan every 60 seconds):

```bash
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 60
```

Remove it with `~/.local/share/chatgpt-chat-bridge/uninstall-watchdog.sh`.

Recovery ladder is deliberately conservative: native Continue/Try again/Retry/Regenerate → `continue` → Stop + guarded continue. Re-sending the original task is only enabled with `--aggressive`. Repeated failures mark the task `BLOCKED` and wake the owning controller/root escalation chain for GitHub reconciliation.

All ChatGPT-Web-touching commands are serialized through a shared browser pacing gate. Normal UI work cannot run faster than 10 seconds; `new`, `archive`, `retire`, and `delete` cannot run faster than 30 seconds. Calls wait at most 5 seconds inline; longer pacing/lock waits return `PACING_DEFERRED` (exit 75). Watchdog separates tasks by at least 10 seconds. `Too many requests` creates an adaptive 3–15 minute account-scoped cooldown; manual commands return `WEB_COOLDOWN_ACTIVE`. Watchdog skips that identity but continues others, and never starts Ego when no eligible tasks remain. Use `cooldown status --account ALIAS` (or `--project NAME`) and `cooldown clear --account ALIAS --confirm`. Legacy global cooldown protects only the default account. The shared pacing lock is not an account quota.

Stop an active generation:

```bash
chat-bridge stop AGENT_ALIAS --project "PROJECT NAME"
```

Use a native retry/regenerate control when exposed:

```bash
chat-bridge retry AGENT_ALIAS --project "PROJECT NAME"
```

Automatic recovery:

```bash
chat-bridge recover AGENT_ALIAS --project "PROJECT NAME"
```

`recover` uses the same conservative recovery policy. It does not re-send the original user task unless `--aggressive` is explicitly supplied.

## Routing rules

- Prefer stable logical role/registry aliases over raw conversation IDs.
- Keep one bound Ego Space per logical project/account; open worker sessions as tabs inside it.
- A role should normally have one active session per project/account; retire the old session before replacement.
- Sync before dispatching a multi-chat batch.
- Use `ask` when the caller must synchronously consume the result.
- Use `send` for callback/event delivery to another Chat.
- Treat GitHub Issues and PRs as the durable project record; Chat messages are coordination events, not the source of truth.
- Include a task ID in cross-chat messages to make retries and callbacks idempotent.
