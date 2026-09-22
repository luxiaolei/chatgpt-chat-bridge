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
- Stop, Retry/Regenerate, resend, and automatic recovery
- Project-scoped Ego Space binding: one logical Project/account endpoint uses one Space; new sessions open as tabs in that Space
- Logical ChatGPT accounts and per-account Project bindings for account failover
- Session lifecycle: archive, retire, delete, forget, and Space tab pruning
- Persistent registry at `~/.config/chat-bridge/registry.json`
- Runtime cache at `~/.local/state/chat-bridge/runtime.json`
- Automatic v1 → v2 registry migration without losing conversation IDs
- Conductor skill for GitHub-driven multi-chat orchestration

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

Initialize a logical project and bind its preferred Ego Space:

```bash
chat-bridge init --project "My Project" --space "my-project"
```

A Project/account binding owns one Ego Space. `chat-bridge new` creates a **new tab inside that Space**; it does not create a new Space per Chat.

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
  --message "You own implementation for GitHub issue #12. Update the issue/PR, then callback conductor."
```

The bridge captures the real conversation ID and project-scoped URL. The stable routing identity is the logical `role`; the concrete conversation can later be retired and replaced.

## Local state and Space binding

The bridge keeps two local files on the machine running Ego Lite:

```text
~/.config/chat-bridge/registry.json          # durable routing/config cache
~/.local/state/chat-bridge/runtime.json      # ephemeral orchestration/runtime cache
```

GitHub Issues/PRs remain the authoritative project state. The local files only reconstruct routing and execution state.

Each logical Project can have one binding per ChatGPT account:

```text
logical project → account → ChatGPT Project URL/ID → Ego Space
```

`spaceName` is the stable binding. Numeric `spaceId` is treated as a runtime cache because Ego Lite can recreate a Space with a different ID.

Inspect or change the Space binding:

```bash
chat-bridge space show --project "My Project"
chat-bridge space bind "my-project-space" --project "My Project"
chat-bridge space prune --project "My Project"
```

`space prune` keeps the Project control tab and tabs referenced by active sessions, and closes stale untracked tabs.

## Multiple ChatGPT accounts

A logical Project is not tied permanently to one ChatGPT account. Register account labels and switch the active endpoint:

```bash
chat-bridge account add secondary --label "Secondary ChatGPT"
chat-bridge account use secondary --project "My Project"
chat-bridge bind --project "My Project" --account secondary \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-secondary"
```

The account label records routing intent; the actual logged-in account/profile is still controlled by Ego Lite/ChatGPT. The bridge does not assume that an Ego Space by itself isolates cookies or login state.

## Session lifecycle

```bash
chat-bridge archive implementation-agent --project "My Project"
chat-bridge retire implementation-agent --project "My Project"
chat-bridge delete implementation-agent --project "My Project" --confirm DELETE
chat-bridge forget implementation-agent --project "My Project"
```

- `archive`: archive the ChatGPT conversation and mark it archived locally.
- `retire`: archive the conversation and retire that concrete session so the same role can be replaced.
- `delete`: destructively delete the ChatGPT conversation; requires `--confirm DELETE`.
- `forget`: remove only the local registry record; the remote conversation is untouched.

Archive/retire/delete also close the bound session tab.

## Accounts, Spaces, and logical projects

A logical project can be bound to more than one ChatGPT account. Each account gets its own ChatGPT Project binding and preferred Ego Space:

```bash
chat-bridge account add alternate
chat-bridge account use alternate --project "My Project"
chat-bridge bind --project "My Project" --account alternate \
  --url "https://chatgpt.com/g/g-p-.../project" \
  --space "my-project-alternate"
```

The account name is a bridge-side identity/binding. The bridge does not impersonate or silently log in to another ChatGPT account; the corresponding Ego Lite browser context must already be authenticated.

Inspect the active binding:

```bash
chat-bridge account list
chat-bridge space show --project "My Project"
chat-bridge space prune --project "My Project"
```

`space prune` keeps the project control tab and registry-referenced active session tabs, and closes other tabs in that bound Space.

## Session lifecycle

Stable roles can outlive individual Chat sessions. Retire an old session before creating its replacement:

```bash
chat-bridge archive implementation-agent --project "My Project"
chat-bridge retire implementation-agent --project "My Project"
chat-bridge forget implementation-agent --project "My Project"
chat-bridge delete implementation-agent --project "My Project" --confirm DELETE
```

`archive` archives the ChatGPT conversation. `retire` archives it, removes it from the active routing pool, and closes its attached Ego tab. `forget` removes only the local registry entry. `delete` is destructive and requires explicit confirmation.

## Local control-plane state

- `~/.config/chat-bridge/registry.json`: project/account/Space bindings and Chat session routing records.
- `~/.local/state/chat-bridge/runtime.json`: ephemeral orchestration/runtime observations.
- GitHub Issues/PRs remain the durable source of truth for project work.

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

## Recovery

```bash
chat-bridge status implementation-agent --project "My Project"
chat-bridge stop implementation-agent --project "My Project"
chat-bridge retry implementation-agent --project "My Project"
chat-bridge recover implementation-agent --project "My Project"
```

`recover` stops an active generation, tries a native retry/regenerate action, and falls back to resending the last user message.

## Conductor workflow

The recommended architecture is **GitHub-first, Chat-event-driven**:

1. Create an umbrella GitHub Issue for project plan/status.
2. Create workstream Issues and PRs.
3. Give the conductor chat the repository, project name, and umbrella Issue.
4. The conductor syncs project chats and creates/reuses worker sessions.
5. The conductor allocates model + thinking level by task difficulty.
6. Workers update the GitHub Issue/PR **before** reporting completion.
7. Workers callback the conductor through `chat-bridge send conductor ...`.
8. That callback creates a new conductor turn, which reconciles GitHub state and dispatches the next batch.
9. Repeat until project acceptance criteria are satisfied.

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
