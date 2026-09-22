# Conductor operating model

The conductor chat is the project-level coordinator.

## Source of truth

Use GitHub as the durable source of truth.

Recommended setup:

- one umbrella Issue for the overall project;
- child Issues for independent workstreams;
- PRs for code/document changes;
- a Discussion for broad design context or long-running architectural conversation.

The conductor should maintain the umbrella Issue with active sessions, current phase, blockers, completed milestones, and next dispatch batch.

## Dispatch contract

Every task should include:

- stable task ID;
- GitHub Issue/PR reference;
- goal;
- acceptance criteria;
- worker alias;
- callback target;
- required model/effort when relevant;
- explicit instruction to update GitHub before callback.

Example:

```text
[TASK]
task_id: CORE-12-IMPL-1
issue: luxiaolei/repo#12
from: conductor
to: implementation-agent
reply_to: conductor
attempt: 1
max_hops: 5

Goal:
Implement the accepted design.

Acceptance criteria:
- tests pass;
- PR opened;
- Issue updated with evidence.

Required durable update:
Update the Issue/PR first. Then callback conductor with the GitHub URL.
```

## Callback contract

```text
[RESULT]
task_id: CORE-12-IMPL-1
from: implementation-agent
to: conductor
status: COMPLETE
github: https://github.com/.../pull/34
summary: Implementation complete; tests pass.
next: Review PR #34.
```

The callback is delivered through:

```bash
chat-bridge send conductor "[RESULT] ..." --project "PROJECT"
```

That user message wakes the conductor for its next turn.

## Resource policy

Suggested default allocation:

| Work type | Model | Effort |
| --- | --- | --- |
| Routing/status/basic lookup | Latest | Instant/Medium |
| Normal implementation/research | GPT-5.6 Sol | High |
| Architecture/difficult review | GPT-5.6 Sol | Extra High |
| Highest-stakes synthesis/final review | GPT-6 Pro preset | Pro |

The highest tier should be reserved for work whose error cost or reasoning complexity justifies it.

## Session policy

Create a new session when:

- context is meaningfully different;
- the workstream is expected to live for multiple rounds;
- the existing session is corrupted/stuck/context-saturated;
- separation of responsibilities reduces confusion.

Reuse a session when its context directly benefits the new task.

## Failure policy

If a worker chat stalls:

1. inspect `chat-bridge status`;
2. run `chat-bridge recover`;
3. if repeated recovery fails, preserve the Issue/PR state and create a replacement session;
4. seed the new session from GitHub links and current decisions, not from an unbounded copy of old chat history.

## Completion

A worker result is evidence, not authoritative completion.

The conductor should validate:

- Issue/PR state;
- tests/review evidence;
- acceptance criteria;
- unresolved blockers.

Only then should the workstream or project be declared complete.
