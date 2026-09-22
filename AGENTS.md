# Agent instructions

This repository implements ChatGPT Project chat routing over Ego Lite.

Before changing runtime behavior:

1. Read `skills/chat-bridge/SKILL.md`.
2. Read `docs/architecture.md`.
3. Preserve the principle: GitHub is durable state; chat is execution context/event delivery.
4. Prefer Ego Lite `ego-browser` APIs over desktop-coordinate automation.
5. Keep model-selection failures explicit.
6. Run `npm run check && npm test`.

For conductor behavior, read `skills/project-conductor/SKILL.md`.
