# ChatGPT Chat Bridge

[简体中文](README.zh-CN.md)

Route work between ChatGPT Project chats through **Ego Lite's native `ego-browser` runtime**.

ChatGPT Chat Bridge turns multiple chats inside one ChatGPT Project into addressable agent sessions. A conductor chat can discover project chats, create sessions, allocate models/thinking levels, send tasks, wait for responses, recover stuck turns, and receive callbacks.

> This is browser automation over your own logged-in ChatGPT session. It is not an OpenAI API and is not affiliated with or endorsed by OpenAI.

## Why

Large projects often need multiple long-lived contexts:

- conductor / project manager
- research
- coding
- review
- debugging
- domain specialists

The bridge gives those chats a small RPC-like control plane while keeping **GitHub Issues and Pull Requests as durable project state**.

```text
                  GitHub Issues / PRs
                         ▲
                         │ durable state
                         │
Conductor Chat ── chat-bridge ── Worker Chats
     ▲                  │              │
     │                  │              │
     └──── callback ────┴──────────────┘
```

## Features

- Discover real chats inside a ChatGPT Project
- Create a real chat in a specific Project
- Register stable aliases for chats
- Send messages without waiting
- Ask and wait for the final assistant reply
- Read the last assistant response
- Inspect generation state
- Select ChatGPT model and thinking effort
- `GPT-6 Pro` preset: **Latest + Pro** (rightmost thinking slider)
- Multi-signal liveness state machine, heartbeat, watchdog, and graded recovery
- Project/account/Space bindings with one Ego Space per project/account
- Session lifecycle: archive, retire, delete (explicit confirmation), and local forget
- Persistent registry under `~/.config/chat-bridge/` and runtime cache under `~/.local/state/chat-bridge/`
- Conductor skill for GitHub-driven orchestration, including optional root/domain controller hierarchies

## Requirements

- macOS with Ego Lite installed
- Ego Lite signed in to the ChatGPT account you want to use
- `ego-browser` CLI available (Ego Lite's native agent runtime)
- Python 3 for CLI argument encoding
- Optional: Remote Desktop Commander or a local/Web Codex environment to invoke the CLI from Chat

The project intentionally has no npm runtime dependencies.

## Install

```bash
git clone https://github.com/luxiaolei/chatgpt-chat-bridge.git
cd chatgpt-chat-bridge
./scripts/install.sh
```

This installs:

- `~/.local/bin/chat-bridge`
- `~/.local/share/chatgpt-chat-bridge/main.js`
- `~/.agents/skills/chat-bridge/SKILL.md`
- `~/.agents/skills/project-conductor/SKILL.md`

## Quick start

Initialize a default project:

```bash
chat-bridge init --project "My Project"
```

Discover/sync the actual ChatGPT Project:

```bash
chat-bridge sync --project "My Project"
chat-bridge list --project "My Project"
```

Route a task:

```bash
chat-bridge send research-agent \
  "Analyze issue #12 and update GitHub before callback." \
  --project "My Project"
```

RPC-style call:

```bash
chat-bridge ask review-agent \
  "Review PR #34 and summarize blocking issues." \
  --project "My Project"
```

Read the most recent response:

```bash
chat-bridge read review-agent --project "My Project"
```

## Create a chat session

```bash
chat-bridge new \
  --project "My Project" \
  --name implementation-agent \
  --model "GPT-5.6 Sol" \
  --effort High \
  --message "You own implementation for GitHub issue #12. Update the issue/PR, then callback the owning controller."
```

The bridge captures the real conversation ID and project-scoped URL. New sessions for the same logical project/account are opened as **new tabs inside the bound Ego Space**; they do not create a new Space per session.

## Project, account, and Space binding

A logical project can have multiple ChatGPT account bindings. Each binding has its own ChatGPT Project URL and stable Ego Space name. The numeric Ego `spaceId` is treated as a runtime cache and may change when Ego recreates a Space.

```bash
chat-bridge account add secondary --label "Secondary ChatGPT"
chat-bridge account use secondary --project "My Project"
chat-bridge bind --project "My Project" --account secondary \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-secondary"
chat-bridge space show --project "My Project" --account secondary
```

The bridge does not automate account credentials. The bound Ego Space must already have access to the intended ChatGPT account/project. Switching the logical active account changes routing; GitHub remains the durable cross-account handoff state.

## Session lifecycle

```bash
chat-bridge archive research-agent --project "My Project"
chat-bridge retire research-agent --project "My Project"
chat-bridge forget research-agent --project "My Project"
chat-bridge delete research-agent --project "My Project" --confirm
```

- `archive`: archive the ChatGPT conversation and mark the local session archived.
- `retire`: archive the ChatGPT conversation and mark the role/session retired so a replacement session can take over later.
- `forget`: remove only the local registry entry; the ChatGPT conversation is untouched.
- `delete`: permanently delete the ChatGPT conversation and requires explicit `--confirm`.

## Runtime task cache

Operational task state is stored separately from the registry at `~/.local/state/chat-bridge/runtime.json`. It is a reconstructable cache, not the source of truth; GitHub Issues/PRs remain authoritative.

```bash
chat-bridge task set HZ-47-W4 --project "My Project" --role implementation \
  --controller 00-s --reply-to 00-s --escalation-to 00-g \
  --status RUNNING --github "https://github.com/OWNER/REPO/issues/47"
chat-bridge task list --project "My Project"
chat-bridge task clear HZ-47-W4 --project "My Project"
```

## Model allocation

Normal model selection:

```bash
chat-bridge model implementation-agent "GPT-5.6 Sol" --project "My Project"
chat-bridge effort implementation-agent "Extra High" --project "My Project"
```

Highest preset:

```bash
chat-bridge model implementation-agent "GPT-6 Pro" --project "My Project"
```

`GPT-6 Pro` is a bridge preset that selects **Latest** in ChatGPT and sets thinking effort to **Pro**, the rightmost slider position.

Observed effort levels:

| Level | Slider |
| --- | ---: |
| Instant | 0 |
| Medium | 1 |
| High | 2 |
| Extra High | 3 |
| Pro | 4 |

## Watchdog

Tracked dispatch:

```bash
chat-bridge send research-agent "..." --project "My Project" --task T-001
```

Status now exposes `RUNNING_ACTIVE`, `RUNNING_QUIET`, `SUSPECT_STALL`, `IDLE_COMPLETE`, `IDLE_INCOMPLETE`, `ERROR_RECOVERABLE`, and `BLOCKED`, with message IDs, `lastProgressAt`, `quietForSec`, recovery controls, and a recommended action.

Run a scan or a foreground loop:

```bash
chat-bridge watch --project "My Project" --dry-run
chat-bridge watch --project "My Project"
chat-bridge watch --loop --interval 15
```

Install the macOS watchdog for all projects:

```bash
./scripts/install.sh
~/.local/share/chatgpt-chat-bridge/install-watchdog.sh 15
```

launchd starts a fresh one-shot scan every 15 seconds. Recovery is conservative: native Continue/Retry first, then `continue`, then Stop + guarded continue. Original-task replay requires `--aggressive`. UI completion never marks the durable task COMPLETE; it becomes `AWAITING_DURABLE_UPDATE` until GitHub is reconciled.

## Recovery

```bash
chat-bridge status implementation-agent --project "My Project"
chat-bridge stop implementation-agent --project "My Project"
chat-bridge retry implementation-agent --project "My Project"
chat-bridge recover implementation-agent --project "My Project"
```

`recover` stops an active generation, tries a native retry/regenerate action, and falls back to resending the last user message.

## Conductor workflow

The bridge supports both a single conductor and a hierarchical controller tree. Small projects can keep the backward-compatible `conductor` root. Larger projects may initialize an explicit root controller:

```bash
chat-bridge init --project "My Project" --root-controller 00-g
```

A tracked task may then carry `controller`, `replyTo`, and `escalationTo`:

```bash
chat-bridge send supply-worker "..." --project "My Project" --task T-001 \
  --controller 00-s --reply-to 00-s --escalation-to 00-g
```

Watchdog notifications are tried in this order: `replyTo → controller → escalationTo → rootController`, with duplicates removed. Normal worker callbacks should also go to the owning domain controller. The root controller handles cross-domain ownership, shared-resource conflicts, evidence-policy disputes, and priority arbitration rather than every worker event.

The overall architecture remains **GitHub-first, Chat-event-driven**: workers update the GitHub Issue/PR before callback; controllers reconcile durable state before dispatching the next batch.

See [skills/project-conductor/SKILL.md](skills/project-conductor/SKILL.md) and [docs/architecture.md](docs/architecture.md).

## Calling from Chat

### Remote Desktop Commander

A Chat with Remote Desktop Commander access can execute:

```bash
chat-bridge ask research-agent "..." --project "My Project"
```

on the connected computer running Ego Lite.

### Web/local Codex

A Codex environment with access to the machine can invoke the same CLI. The project is complementary to [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web): that project connects ChatGPT Web models to Codex workflows, while this bridge focuses on **ChatGPT Project session discovery, routing, callbacks, and conductor orchestration**.

## Project structure

```text
bin/chat-bridge                  CLI wrapper
src/main.js                     Ego-browser runtime
scripts/install.sh              Installer
scripts/uninstall.sh            Uninstaller
skills/chat-bridge/             Worker/routing skill
skills/project-conductor/       Conductor skill
docs/architecture.md            Architecture and control plane
.github/ISSUE_TEMPLATE/         Suggested durable task format
tests/static.sh                 Static checks
```

## Development

```bash
npm run check
npm test
./bin/chat-bridge help
```

Account-bound browser flows are intentionally not run in CI because they depend on a logged-in Ego Lite profile.

## Security

The bridge controls a logged-in browser session. Treat the local Ego Lite profile and chat registry as sensitive user state.

- Do not expose the local browser control service to untrusted users.
- Do not commit registry files or cookies.
- Use only on accounts and projects you are authorized to control.
- Expect ChatGPT UI changes to require selector maintenance.

See [SECURITY.md](SECURITY.md).

## License

MIT.
