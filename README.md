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
- Persistent registry under `~/.config/chat-bridge/`
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
  --message "You own implementation for GitHub issue #12. Update the issue/PR, then callback conductor."
```

The bridge captures the real conversation ID and project-scoped URL.

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
