# Agent instructions

This repository implements ChatGPT Project chat routing over Ego Lite.

Before changing runtime behavior:

1. Read `skills/chat-bridge/SKILL.md`.
2. Read `docs/architecture.md`.
3. Preserve the principle: GitHub is durable state; chat is execution context/event delivery.
4. Prefer Ego Lite `ego-browser` APIs over desktop-coordinate automation.
5. Preserve one bound Ego Space per logical project/account; sessions are tabs, not Spaces.
6. Treat `spaceId` and page labels as runtime attachments, not permanent identity.
7. Keep destructive session deletion behind explicit confirmation.
8. Keep model-selection failures explicit.
9. Keep watchdog/callback routing controller-aware: task controller/replyTo/escalationTo first, project root controller as fallback.
10. Preserve backward compatibility for single-conductor projects (`rootController=conductor`).
11. Run `npm run check && npm test`.

For global/domain controller behavior, read `skills/project-conductor/SKILL.md`.
