# Security

ChatGPT Chat Bridge controls a logged-in ChatGPT browser session through Ego Lite's native agent runtime.

## Sensitive state

Treat these as sensitive local user state:

- Ego Lite browser profiles and cookies
- ChatGPT session state
- `~/.config/chat-bridge/registry.json`
- local repositories and credentials reachable by Remote Desktop Commander or Codex

The registry should not contain passwords or API keys, but it contains conversation IDs and routing metadata and should not be committed.

## Operating assumptions

Use the bridge only:

- on machines you trust;
- with ChatGPT accounts you are authorized to operate;
- on GitHub repositories/projects you are authorized to modify.

Do not expose local control ports or the Ego browser runtime to untrusted network clients.

## Browser automation risk

This software depends on ChatGPT web UI semantics. UI changes can break selectors.

The bridge should fail explicitly when model/session controls cannot be found rather than silently selecting a different model or task.

## GitHub

GitHub Issues and PRs may contain project-sensitive information. Worker chats should avoid copying secrets into public repositories.

## Reporting

For a security concern, open a GitHub issue only if the report contains no sensitive exploit details. Otherwise contact the repository owner privately.
