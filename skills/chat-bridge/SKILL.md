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
chat-bridge send AGENT_ALIAS "message" --project "PROJECT NAME"
```

RPC-style call that waits for the assistant response:

```bash
chat-bridge ask AGENT_ALIAS "message" --project "PROJECT NAME"
```

Read the most recent assistant response:

```bash
chat-bridge read AGENT_ALIAS --project "PROJECT NAME"
```

Inspect generation state and configured resources:

```bash
chat-bridge status AGENT_ALIAS --project "PROJECT NAME"
```

## Create and register sessions

Create a new Chat inside a ChatGPT Project:

```bash
chat-bridge new --project "PROJECT NAME" \
  --name research-agent \
  --model "GPT-5.6 Sol" \
  --effort High \
  --message "Initial role and task"
```

The command captures the conversation ID, project-scoped URL, Ego TaskSpace, model, and effort in the registry.

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

## Recovery

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

`recover` stops a stuck generation if needed, tries Retry/Regenerate, and falls back to resending the last user message.

## Routing rules

- Prefer stable registry aliases over raw conversation IDs.
- Sync before dispatching a multi-chat batch.
- Use `ask` when the caller must synchronously consume the result.
- Use `send` for callback/event delivery to another Chat.
- Treat GitHub Issues and PRs as the durable project record; Chat messages are coordination events, not the source of truth.
- Include a task ID in cross-chat messages to make retries and callbacks idempotent.
