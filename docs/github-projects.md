# GitHub Projects v2 integration

ChatBridge can optionally bind a logical project to a GitHub Projects v2 board. The binding changes **project-management reads**, not ChatGPT routing.

## Identity boundaries

Keep these identities separate:

- **ChatBridge logical project** — the orchestration namespace used by tasks/controllers.
- **ChatGPT Project** — the Web location used for Chat sessions, account/Profile bindings and Ego tabs.
- **GitHub Project v2** — an optional portfolio/status board containing source Issues/PRs.

A GitHub Project binding never moves a Chat, changes an account binding, creates a board or authorizes a business action.

## Project-first controller rule

When a logical project has a GitHub Project binding, a controller should:

1. inspect the bound Project first;
2. identify the relevant workstream/priority/status;
3. read the selected source Issue/PR, parent/dependency, review/CI and fixed evidence;
4. make dispatch/acceptance decisions only from the source evidence and the existing Bridge control contract.

If the board is unavailable, truncated, or conflicting, do not interpret an empty result as "nothing to do." Surface the board-read problem and use only source objects that can be verified.

Projects without a binding keep the existing Issue-first behavior.

## Commands

All commands below are host-local and use the host's existing `gh` login. They do not open ChatGPT Web.

### Bind

```bash
chat-bridge github-project bind \
  --project "ChatBridge" \
  --owner luxiaolei \
  --number 8
```

The command verifies owner/number through GitHub, stores the Project node ID/URL/title, and reads the Project back before returning success.

Optional source coverage and status projection can be configured at bind time:

```bash
chat-bridge github-project bind \
  --project "HZ OS" \
  --owner luxiaolei \
  --number 4 \
  --source-query 'repo:luxiaolei/huazhuo-blueprint is:open' \
  --source-query 'repo:luxiaolei/huazhuo-runtime is:open' \
  --map-status 'status:backlog=Backlog' \
  --map-status 'status:ready=Ready' \
  --status-field Status
```

Each source query must explicitly include both `repo:` and `is:open`. This prevents an accidental global/broad import and prevents a closed source object being treated as a new work candidate.

A board such as QuantCompany Research and QuantCompany Dev may intentionally use different queries even when both reference the same repository.

### Show / inspect

```bash
chat-bridge github-project show --project "PROJECT"
chat-bridge github-project inspect --project "PROJECT"
```

`show` reads only the local binding. `inspect` reads GitHub and verifies:

- bound Project identity and open state;
- every Project item page, including archived items;
- field/workflow configuration without silently truncating;
- source labels without truncation;
- configured source-query completeness;
- planned nonterminal status changes.

The response flags an enabled `Auto-close issue` workflow as a risk. It does not alter that workflow.

### Refresh

```bash
chat-bridge github-project refresh --project "PROJECT"
```

Refresh is preview-only by default. It reports:

- source objects matched by configured queries;
- missing source references;
- intentionally archived matching references;
- configured status changes;
- remaining differences after a run.

To apply only the configured safe projection:

```bash
chat-bridge github-project refresh --project "PROJECT" --apply
```

Remote writes are bounded and guarded:

- a missing source reference is re-read immediately before adding;
- board membership is re-read immediately before adding to tolerate a concurrent native Auto-add;
- status changes apply only to open **Issues**, not PRs;
- status changes require an explicit label→Project-status mapping;
- source identity/state/updatedAt/labels are re-read before a status write;
- current Project field value, field ID and option ID are re-read before a status write;
- concurrent source/Project changes fail as `CONFLICT` instead of overwriting;
- terminal/acceptance-like values such as Done, Closed, Complete, Accepted, Merged, Deployed, Released, Passed and Approved are rejected.

The adapter never closes or edits the source Issue, merges a PR, dispatches a Chat, retries an UNKNOWN delivery, acknowledges a worker result, or switches an installed runtime.

### Unbind

```bash
chat-bridge github-project unbind --project "PROJECT"
```

This removes only the local GitHub Project management binding. It does not delete/close the board and does not modify source Issues/PRs.

## Auto-add and GitHub-native workflows

GitHub-native Auto-add is intentionally **not** configured by the ChatBridge binding command.

Auto-add is a per-board setup concern because inclusion semantics differ:

- a cross-repo programme may include all open Issues/PRs from several repositories;
- a research portfolio and a development board may share one repository but include different issue kinds;
- a product board may intentionally exclude tool/reference repositories.

Board setup should configure native Auto-add where appropriate and separately backfill existing matching items. Copying a Project does not imply that Auto-add filters have been copied or validated.

The Bridge adapter can provide a conservative source-query backstop, but Project-native automation and Bridge refresh should not both write the same custom field unless one is explicitly designated as the writer.

## Completion and acceptance boundaries

These states are deliberately independent:

- Project Status
- source Issue state
- source PR merge/review/CI
- Bridge task dispatch/result/callback state
- controller ACK
- installed release
- business/scientific acceptance

A Project column is useful for selecting work; it is not a substitute for these evidentiary states.
