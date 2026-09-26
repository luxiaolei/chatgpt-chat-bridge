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

The queue returns a durable operation ID. `QUEUED` is not delivery; `SENT` confirms only the ChatGPT user message, not task completion. `DELIVERY_UNKNOWN` requires a read/reconciliation before any retry. Start the local worker with `~/.local/share/chatgpt-chat-bridge/install-coordinator.sh` after installing Bridge; `queue work-one` processes one claim manually. A controller without a known `callerRef` must supply an explicit Project to the direct `send` command instead of guessing its source Project.

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

For an observed Project whose chat tabs do not show its name, verify the Project page and then run `chat-bridge space label --space "SPACE" --project-id "g-p-..." --name "NAME"`. This does not change routing.

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

## Models and Thinking Level

Model choice and Thinking Level are independent controls.

In the current ChatGPT Web deployment used by this Bridge:

- `Latest` is the moving current-model choice and currently resolves to **GPT-6**.
- Thinking Level is the slider: `Instant → Medium → High → Extra High → Pro`.
- `Pro` is the rightmost slider position.
- Therefore `Latest + Pro` is the **GPT-6 Pro** path.
- The Bridge preset `GPT-6 Pro` is shorthand for `Latest + Pro`.

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

The watchdog uses multiple signals: Stop/Send/composer controls, stable ChatGPT message IDs, assistant text/hash/length, a page-side MutationObserver, recovery/error UI, and elapsed time since real progress. Normal quiet thinking is not interrupted until the task's stall threshold is crossed. If the bound Space is `user` or `agentDelegatedToUser`, watchdog must not claim or switch that Space: it records `watchdogPausedForUserControl`, and later preflight suppresses that task locally until an explicit `send`, `ask`, `retry`, `recover`, or `resend` clears the pause.

Install the macOS launchd watchdog (all projects, one-shot scan every 60 seconds):

```bash
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 60
```

Remove it with `~/.local/share/chatgpt-chat-bridge/uninstall-watchdog.sh`.

Recovery ladder is deliberately conservative: native Continue/Try again/Retry/Regenerate → `continue` → Stop + guarded continue. Re-sending the original task is only enabled with `--aggressive`. Repeated failures mark the task `BLOCKED` and wake the owning controller/root escalation chain for GitHub reconciliation.

ChatGPT-Web-touching commands are serialized per verified login identity, including aliases of the same account; different logins have separate pacing gates. Normal UI work cannot run faster than 10 seconds; `new`, `archive`, `retire`, and `delete` cannot run faster than 30 seconds. Calls wait at most 5 seconds inline; longer pacing/lock waits return `PACING_DEFERRED` (exit 75). Watchdog separates tasks on the same login by at least 10 seconds. `Too many requests` creates an adaptive 3–15 minute account-scoped cooldown; manual commands return `WEB_COOLDOWN_ACTIVE`. Watchdog skips that identity but continues others, and never starts Ego when no eligible tasks remain. Use `cooldown status --account ALIAS` (or `--project NAME`) and `cooldown clear --account ALIAS --confirm`. Legacy global cooldown protects only the default account. A pacing lock is not an account quota.

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
- Keep a verified managed Agent Space per login/Profile, with Project tabs as needed; do not take over a human-owned Space.
- A role should normally have one active session per project/account; retire the old session before replacement.
- Sync before dispatching a multi-chat batch.
- Use `ask` when the caller must synchronously consume the result.
- Use `send` for callback/event delivery to another Chat.
- Treat GitHub Issues and PRs as the durable project record; Chat messages are coordination events, not the source of truth.
- Include a task ID in cross-chat messages to make retries and callbacks idempotent.
