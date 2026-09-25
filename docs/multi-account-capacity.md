# Multi-account Web capacity and sticky external sessions

Status: design contract for GitHub Issue #27.

## Boundary

Chat Bridge is a generic Web-session transport and capacity plane. It knows logical projects, ChatGPT account bindings, Ego Spaces, conversations, routed tasks, callbacks, local coordination events, and Web pacing. It does not know market data, backtests, research sandboxes, protected holdouts, or Mini/MBP compute.

Project systems such as QuantCompany consume this layer while keeping local research semantics outside this repository.

## Topology

A logical project may bind multiple ChatGPT accounts. Each project/account pair owns one stable Ego Space and may host multiple managed conversation tabs. Existing conversation identity is sticky and never silently migrates between accounts.

## Capacity projection

Add a local-only command: chat-bridge capacity --project PROJECT.

Per account it reports bounded local observations only: identity verification state, project/Space binding, cooldown state, active routed task count, managed conversation/page counts, locally known active/generating state, and eligibility/exclusion reasons. Computing capacity must not open ChatGPT Web.

## Deterministic account selection

Add: chat-bridge account select --project PROJECT [--affinity-key KEY] [--account ACCOUNT].

Selection order:
1. Explicit account wins if eligible.
2. Existing active session/task for the affinity key keeps its account.
3. Exclude unavailable bindings and active cooldowns.
4. Rank deterministically by active routed tasks, attached pages, active conversations, then account alias.
5. Return one selected account plus compact candidate metrics.

Selection applies only to new work and never moves an existing conversation.

## Opaque affinity

Callers may provide an opaque affinity_key. Chat Bridge persists and compares it only for sticky placement; it must not interpret project-domain semantics.

new --auto-account --affinity-key KEY selects an account from local state, creates the conversation in that project/account Ego Space, and persists selected account plus affinity metadata. Explicit --account overrides auto placement.

## Event transport

Project/account event journals remain the asynchronous external-completion channel. Consumers keep their own cursor. completionMode=external emits ASSISTANT_RESPONSE_READY once per assistant message ID. The journal is coordination state only; GitHub or the consuming project DB remains business durable state.

## Failure and cooldown

A cooling account is excluded from new auto placement. Existing sticky work stays assigned and is not copied to another account. Other healthy accounts remain eligible. Aliases for the same identified login share the existing cooldown identity scope.

## Security and out of scope

No session tokens are exported. Chat Bridge adds no shell, filesystem, Python, data, backtest, replay, holdout, production-trading, or host scheduling authority. Those belong to the consuming project.

## Acceptance

- Capacity projection tests cover multiple accounts and cooldown isolation.
- Selector tests cover explicit override, sticky affinity, deterministic least-load placement, and no eligible account.
- new --auto-account uses the selected project/account Space.
- Existing active session affinity never migrates silently.
- Event isolation/cursor tests continue to pass.
- npm test, static and pacing checks pass.
- README/Chinese README and conductor skill reference this contract.
