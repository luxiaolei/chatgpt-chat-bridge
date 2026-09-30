# Owned dispatch subprocess cleanup

Scope: independent reliability repair for #86, related to #31/#32 and #76.
This is not acceptance of the image contract (#77 / PR84), and contains none of
its code. The branch starts at `9dc2e76d7713a45b952f0089f633947ff9049e0b` and
is stacked only on R0 `codex/local-codex-roundtrip` / PR83.

## Reproduced defect

The baseline coordinator uses `subprocess.run(..., timeout=120)` for dispatch
and evidence reads. The CLI's default Ego client timeout is 180 seconds. The
outer wrapper can therefore time out first and stop only its direct child.
`ego-runner.py` creates a separate client process group, so stopping the outer
group alone cannot finish that separate group's cleanup.

The first local proposal also had an EOF bug: it stopped escalation as soon as
`communicate()` returned. A descendant ignoring SIGTERM with all three standard
streams connected to DEVNULL survives even though its leader exits and its
leader's pipes close. The same regression fails against both the proposed
`run_bridge` and `stop_client`. The isolated negative controls use only their own
fake processes and clean them in `finally`; the proposal files remain unchanged.

## Narrow repair

`run_bridge` starts an owned session/process group and is used by all three
existing wrapper call sites: dispatch, evidence reconciliation and task-record
registration. `stop_bridge` and runner `stop_client` send TERM, drain/reap the
leader, and independently check the owned group through a bounded grace period.
Leader exit or pipe EOF does not skip cleanup. A surviving group gets KILL,
followed by bounded pipe collection/reaping. Normal receipts also clean residual
owned children; their original exit status and output are retained.

A signal-0 group probe was observed to raise an intermittent EPERM during an
isolated shell-client teardown on the authorized test host. An inconclusive
probe is not treated as an empty group: cleanup keeps its grace and final KILL
attempt. Permission errors from an actual TERM/KILL are not suppressed or
worked around. Tests inject the inconclusive-probe case deterministically.

The runner forwards TERM/INT to its separately owned client group. A signal
between `Popen` and assignment is saved until ownership is captured. Repeated
termination signals are ignored only during the bounded cleanup, then previous
handlers are restored. Normal completion, timeout and signal-driven exit share
that cleanup. The outer TERM grace is seven seconds, exceeding the runner's
maximum two-second TERM grace, two-second drain and two-second reap budgets.

The coordinator also latches TERM/INT in the main thread, including the outer
spawn/assignment window. Its existing worker threads check cancellation during
bounded `communicate` waits, finish only their owned groups, and retain UNKNOWN
for an interrupted dispatch. The service stops admitting claims and waits for
those workers before restoring signal handlers and exiting. Repeated signals
cannot interrupt cleanup. No process registry or new supervisor is needed.
If cancellation arrived while a claim waited for SQLite's writer lock, the
uncommitted claim rolls back and stays QUEUED with no attempt consumed. A claim
already committed before cancellation remains conservatively UNKNOWN.

Only groups created by these helpers are signaled. There is no PID enumeration,
process-name matching, global process killer, browser Stop operation or shutdown
of Ego Lite/TaskSpaces/renderers. A helper does not claim arbitrary descendants
that deliberately escape its group. This is not a guarantee against uncatchable
SIGKILL of the supervisor or OS-level uninterruptible processes; no broader
permissions, service or supervision subsystem is introduced.

## Timeout compatibility and claims

The coordinator respects the CLI's `CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC`:
30–600 seconds, default 180, with an empty value also using the default. It adds
60 seconds for the existing wrapper's startup/pacing work. The direct runner
retains its own 1–600-second range and 120-second default. NaN and infinity are
rejected instead of being interpreted as an unlimited wait.

Task registration retains its 30-second execution budget. Both `claim` and
explicit `recover` use the same interrupted-claim window:

```text
max(300, bridge_timeout + 30 + 2 * (7 + 4) + 60)
```

This allows for dispatch plus registration, both bounded teardowns, and a
DB/finish allowance: 352 seconds at the default configuration, 772 seconds at
the maximum. These are local operational budgets, not platform quotas or proof
that a remote generation has stopped. No queue/scheduler or schema was added.

## UNKNOWN and private diagnostics

Timeout remains `DELIVERY_UNKNOWN`, even when TERM makes a leader print a receipt
and exit zero. Unstructured nonzero exits and unreadable receipts remain UNKNOWN.
A timeout cannot use a printed PRE_SEND line as evidence for safe replay. Existing
structured, normally returned PRE_SEND receipts keep their existing bounded retry
behavior. Task-record timeout/failure preserves the discovered session reference
and reports `TASK_RECORD_NOT_CONFIRMED`; it does not create a duplicate Chat.

Non-structured failure diagnostics use the existing private `operations.result`
field: phase (`dispatch`, `evidence`, `task-record`), exit code where available,
and at most 2048 characters of stderr tail. A failed evidence probe keeps prior
dispatch diagnostics and stores `reconcileWorker` separately, without changing
UNKNOWN into delivery evidence or exposing that stderr in the public reconcile
response. No additional diagnostic store or log service exists.

Public operation projections exclude these private fields. No full command
argv, request/prompt or stdout dump is added to diagnostics or public evidence.
Timeout exceptions use a generic `chat-bridge` command label and error-class
reasons rather than `str(TimeoutExpired)` with its sensitive argv. Captured stderr
can itself contain private content; do not copy it into GitHub, a callback summary
or public logs without a separate review. The original exit-1 cause from the
historical incident remains unknown because its stderr was not retained then.

## Reproducible offline checks

```sh
node --test tests/dispatch-lifecycle.test.mjs tests/ego-runner.test.mjs
python3 tests/dispatch-lifecycle-check.py outer-closed-pipes
python3 tests/dispatch-lifecycle-check.py runner-closed-pipes
npm run check && npm test
```

The Python file is a test fixture invoked by the existing Node runner, not a new
runtime subsystem. It creates disposable fake processes and temporary SQLite
stores. Test PID observations and cleanup are limited to those fake processes;
no live Bridge operation, process or browser is exercised.

Coverage includes closed-pipe TERM-ignoring descendants, early/reaped leaders,
normal EOF with residual children, timeout followed by leader exit zero,
separately owned nested client groups, spawn/assignment signals, unrelated
process survival, repeated coordinator cancellation, real thread-pool shutdown,
normal receipts, inconclusive probes, timeout range/lease
compatibility, bounded private stderr and argv privacy, all three wrapper call
sites, and unchanged UNKNOWN/retry rules.

Final fixed-head test counts and log hashes are recorded in the PR and the
local `dispatch-fix-handoff.json`, not inferred from a moving branch. Negative
proposal checks and an intermediate EPERM failure are retained in private test
logs; a rerun alone is not the fix.

## Delivery boundary

`NOT_INSTALLED` / `NOT_MERGED`. No live database mutation or reconciliation,
no termination of real in-flight processes, no replay of an old UNKNOWN, and no
image generation/material upload/paid API are part of this repair. Tests do not
establish a production browser canary, installation/rollback or independent
review. The original #77 delivery remains independent and unaccepted until its
controller reviews and ACKs it.

Development dispatch `CBIMG-DISPATCH-FIX-20260930-01` was observed as SENT with
`modelSelection={model:Latest, effort:Pro, raw:Pro, verified:true}` in its persisted
receipt. This is the developer Chat's selection, not an image-model assertion.
The worker records this repair in GitHub and submits its own queue result;
only the persisted local Codex owner may ACK final acceptance.

The frontend result at `dac2ae2` was rejected after independent review reproduced
outer TERM and spawn/assignment INT leaks. The user then authorized local Codex
continuation; the root owns these cancellation corrections and their review.
That local revision does not impersonate a new frontend queue result.
