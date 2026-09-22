# Contributing

## Development setup

```bash
git clone https://github.com/luxiaolei/chatgpt-chat-bridge.git
cd chatgpt-chat-bridge
npm run check
npm test
```

Browser-bound integration tests require a local Ego Lite profile signed into ChatGPT.

## Design rules

- Prefer Ego Lite's native `ego-browser` runtime over desktop-coordinate automation.
- Keep GitHub as durable project state; do not add hidden project state that exists only in chat.
- Make model-selection failures explicit.
- Preserve stable task/session aliases.
- Avoid adding runtime npm dependencies unless there is a strong reason.
- Do not commit local registry, cookies, tokens, or browser profiles.

## Pull requests

A PR should include:

- motivation;
- behavioral change;
- validation performed;
- any ChatGPT UI assumptions changed.
