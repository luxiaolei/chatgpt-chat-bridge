# Agent instructions

This repository implements ChatGPT Project chat routing over Ego Lite.

Before changing runtime behavior:

1. Read `skills/chat-bridge/SKILL.md`.
2. Read `docs/architecture.md`.
3. Preserve the principle: GitHub is durable state; chat is execution context/event delivery.
4. Prefer Ego Lite `ego-browser` APIs over desktop-coordinate automation.
5. Prefer one Bridge-managed Ego Space per verified ChatGPT login/Profile; multiple Projects and sessions share that Space as tabs. Existing legacy Spaces are consolidated only after a drained safety check.
6. Treat `spaceId`, Page labels, and Tab attachments as runtime state, not permanent identity.
7. Keep destructive session deletion behind explicit confirmation.
8. Keep model-selection failures explicit and persist requested vs UI-observed model/Thinking separately.
9. Keep watchdog/callback routing controller-aware: exact persisted reply/controller target first, project root controller only as a fallback.
10. Preserve backward compatibility for single-conductor projects (`rootController=conductor`).
11. Run `npm run check && npm test`.
12. Treat logical controller/role identity separately from one conversation; context-exhausted chats rotate through checkpointed, ACKed successor sessions.
13. Use `queue result` + controller `queue ack` for normal completion; a worker result or a sent callback is not business acceptance.
14. `control pause|drain|resume|broadcast|status` is the management plane. Global/project control mutations require authorized management identity and must not be simulated by chat prose alone.
15. Pure local status/topology/task/event queries must not wake Ego. Background callback/management sends must not clear a user-control pause.
16. Do not assume a running Chat can close its Tab and continue all later tools. Attached-running remains the default; only safely terminal/result-recorded tabs may be detached automatically.
17. For this deployment, Git/GitHub writes should use an authorized ChatGPT Computer connection to the configured execution host and local `git`/`gh`; plugin display suffixes are not stable identity.

For global/domain controller behavior, read `skills/project-conductor/SKILL.md`.
