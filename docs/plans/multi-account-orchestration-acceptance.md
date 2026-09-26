# ChatBridge v0.9 acceptance and cutover record

Updated 2026-09-26. Code baseline: PR #46 at `c7e891e`. This records observed evidence and the remaining release gates; it is not a production acceptance receipt. The canonical source checkout is `/Users/xlmini/Projects/chatgpt-chat-bridge`.

## Evidence so far

| Gate | State | Evidence and limit |
| --- | --- | --- |
| Local checks | PASS | `npm run check`, 127/127 Node tests, static and pacing/cooldown checks, `git diff --check`. |
| Project Ensure | PASS for one synthetic create/reuse | A second synthetic Project returned `NEEDS_PROJECT_SETUP`, then `READY` with `created:true`, then `READY` with `created:false` and the same Project ID. Both bindings use the existing managed Space. |
| Single-account result loop | PARTIAL | Synthetic controller → queue → worker → read-only ChatGPT Computer call → durable result → callback → controller ACK completed. One earlier dispatch remains `DELIVERY_UNKNOWN`; it was not resent. |
| Model/Thinking | PASS for observed choices | Worker UI showed `Latest` + `High`; successor controller showed `Latest` + `Medium`. `Latest` does not prove a fixed underlying model version. |
| Controller rotation | PASS for maintenance case | Checkpoint, successor Chat, ACK, atomic epoch switch and a late callback to the successor were observed. Hard context exhaustion was not induced in a real Chat. |
| Management plane | PASS for one canary Project | Scoped pause blocked admission; drain, broadcast preview/send, controller ACK and resume worked. Global and multi-controller broadcast were not exercised. |
| Terminal Tab lifecycle | PASS for one worker | A finished worker Tab detached after grace; a later task reused the same conversation in a new Tab. Detached-running behavior was not tested and remains disabled by default. |
| Shared Space and multi-account | PARTIAL | Simulated protection tests pass. In the real canary Space, pruning Project A kept Project B's inactive control Tab, B's inactive active-task Tab, and A's active-session Tabs; it closed only a retired A Tab. The synthetic B task was then cleared. A separate `qc-alpha` / Profile 2 managed Space was identity-verified. Its synthetic Project returned `NEEDS_PROJECT_SETUP`, then `READY created:true`, then `READY created:false` with the same ID `g-p-6ab79617a1c08191af3ce6039baff27a`. Task `CB09-QC-CROSS-001` went from the hzcodex controller to a qc-alpha worker, performed a read-only Computer check of the xlmini host and `package.json` (`0.9.0`), recorded result v1, delivered callback to the original controller, and received `ACCEPTED`; B reports `COMPLETE`. The worker's first result command reached the production Bridge and returned `RESULT_TASK_NOT_REGISTERED`; it then explicitly used the isolated canary config/state and succeeded. No duplicate dispatch or production task write followed. Draft/user ownership and two-controller receipts remain untested. |
| Resource stability | PARTIAL | Ten read-only Ego client rounds: canary Tabs 4→4, orphan clients 0→0, global Renderer count 35→35. Ten rounds of actual Tab/session churn and CPU/latency measurements remain open. |
| Isolated install/migration rehearsal | PASS locally | 22 staged runtime/CLI/Skill copies matched source hashes. Staged CLI read an empty isolated control plane. A consistent copy of production state opened under v0.9 with 5 projects and 116 tasks; registry/runtime documents were unchanged. |
| Isolated coordinator restart | PASS for synthetic worker | A queued dispatch and then a queued callback survived daemon restarts and each sent once. A simulated crashed claim became `DELIVERY_UNKNOWN`; another restart made no additional fake send. Real Ego generation/recovery was not tested. |
| Production cutover | BLOCKED | No production binaries, launchd services, database, or Spaces were changed. The state snapshot has 13 BLOCKED and 1 FAILED tasks; three projects report `NEEDS_REVIEW`. Canary also reports `NEEDS_REVIEW` for one unknown dispatch. |

The canary-only SQLite database was backed up before an older, invalid `SUPERSEDED` classification was restored to `DELIVERY_UNKNOWN`. A later dispatch of the same synthetic task ID succeeded before the new guard was added; that success cannot prove the earlier send did not happen. The first callback had an unknown original send receipt, but its exact synthetic message was observed in the target conversation; a local UI text hash and conversation reference were retained. The earlier database reason relied only on controller ACK, so a general evidence-backed reconciliation/audit path remains open. No further retry was made after the ambiguity was identified.

## Remaining release gates

1. Reconcile unknown sends using direct target-conversation evidence and retain the audit trail. Keep genuinely unresolved sends unknown and block duplicate task IDs.
2. Extend the two-Project shared-Space canary to draft/user-ownership boundaries; do not prune any business Project or Manual Space.
3. Exercise two independent controllers; the hzcodex → qc-alpha → hzcodex route and Computer host/path receipt are complete for one synthetic task. Keep isolated canary state explicit in Computer commands.
4. Extend restart rehearsal to real Ego generation/result-recorded behavior in the isolated canary. Run ten actual Tab/session churn rounds with queue wait, UI lease, callback latency, Tabs, Renderer, CPU, and orphan-client trends.
5. Classify the production BLOCKED/FAILED tasks by owner and decide which need reconciliation before each project can resume. Keep Issue #37 open until the release evidence is complete.

## Production cutover sequence, after the gates pass

1. Fix the PR commit, installed runtime and Skill hashes, target accounts/projects, controller list, and rollback owner. Confirm no uncontrolled concurrent writer is active.
2. Take a consistent SQLite backup, plus registry/runtime projections, current installed runtime/CLI/Skills, launchd plists and service status. Preserve any new outbox/task records created after this point.
3. Persist pause/drain for the approved scope, allow results/callbacks/ACKs to finish, and inspect `DELIVERY_UNKNOWN` before stopping the old coordinator and watchdog. Do not pause every production project merely to test one.
4. Install the fixed version, verify hashes and local checks, then start exactly one coordinator and the intended watchdog. Read `control status` locally before any browser work.
5. Broadcast a versioned reload/check to the approved controllers, collect each version/hash ACK, run a single-project canary, then resume projects in batches. Missing ACKs keep their scopes paused.
6. If rollback is needed, first stop new admission and back up the **post-upgrade** database/outbox. Restore compatible binaries/services without replacing the database with an old snapshot or erasing messages sent since cutover; reconcile those operations before resuming.

GitHub is durable business state. Chat sessions carry execution context and event delivery. A green test run, empty active queue, or callback `SENT` alone does not establish business acceptance.
