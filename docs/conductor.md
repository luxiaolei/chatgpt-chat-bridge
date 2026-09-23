# Conductor operating model

The bridge supports either one project conductor or a hierarchy of one root controller plus domain controllers.

## Source of truth

GitHub Issues and Pull Requests are durable project state. ChatGPT conversations are long-lived execution/control contexts. The bridge registry/runtime cache is reconstructable routing state and must not outrank GitHub.

Recommended project shape:

```text
root controller
  ├─ domain controller A → specialists / issue workers
  ├─ domain controller B → specialists / issue workers
  └─ verification controller → reviewers
```

For a small project, the backward-compatible root role remains `conductor`.
## Control routing

Initialize a hierarchical project:

```bash
chat-bridge init --project "PROJECT" --root-controller 00-g
```

Each tracked task may carry:

- `controller`: owning domain controller;
- `replyTo`: first callback/watchdog destination, normally the owning controller;
- `escalationTo`: fallback controller when the owning controller cannot be reached;
- `rootController`: project-level fallback captured from project configuration.

Notification order is:

```text
replyTo → controller → escalationTo → rootController
```

Duplicate targets are removed. A task must not be escalated merely because it belongs to the same project as the root controller.
## Dispatch contract

```text
[TASK]
task_id: SUP-48-IMPL-1
issue: luxiaolei/repo#48
from: 00-s
to: supply-worker
reply_to: 00-s
escalation_to: 00-g

Goal:
...

Acceptance:
...

Required durable update:
Update the Issue/PR first, then callback the owning controller.
```

Equivalent tracked dispatch:

```bash
chat-bridge send supply-worker "..." --project "PROJECT" --task SUP-48-IMPL-1 \
  --controller 00-s --reply-to 00-s --escalation-to 00-g
```
## Responsibility split

The root controller owns cross-domain priorities, controller health, shared write/resource conflicts, ownership transfers, and evidence-policy arbitration.

A domain controller owns its Issue set and may autonomously dispatch/recover/replace sessions, request review, update ordinary task state, and progress PR work inside its domain.

Specialist and issue-worker chats execute work. They do not silently change ownership or create a second control plane.

The verification controller/reviewer must return PASS, CHANGES_REQUIRED, BLOCKED, or a bounded evidence result to the owning controller. A green author check is not independent acceptance.

## Watchdog

The local watchdog owns only mechanical liveness and conservative recovery. It never decides project completion. `IDLE_COMPLETE` becomes `AWAITING_DURABLE_UPDATE`; the owning controller reconciles GitHub evidence before marking COMPLETE.

If recovery is exhausted, the watchdog notifies the task's control chain. If a domain controller is unreachable, the event falls back to its escalation/root controller.
## Session policy

Keep one active session per logical role/project/account unless duplicate-role operation is explicitly required. Create a new session when the context is materially different, a workstream is long-lived, or a session is unhealthy/context-saturated. Retire the old session before replacement when practical.

All sessions for one logical project/account live as tabs in one bound Ego Space. A new chat must not create a new Space.

## Completion

A worker result is evidence, not authoritative completion. Controllers validate current Issue/PR state, tests/review evidence, acceptance criteria, and blockers. The root controller declares project-level completion only when the durable GitHub graph supports it.
