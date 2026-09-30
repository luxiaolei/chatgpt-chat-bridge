# Image capability: independent acceptance preparation (#82)

Task `CBIMG-82-REVIEW-20260930-01`; role `image-review`; 2026-09-30.

## 1. Phase verdict and immutable scope

**REVIEW_PREPARATION_COMPLETE_WITH_FINDINGS. Image functionality is NOT ACCEPTED.**
This is a non-author fixed-head review and an executable acceptance plan, not
completion of #82, approval of PR84, an installed release, or a real image canary.
One capability-evidence defect was independently reproduced. Two integration
contracts still need proof: the control-task/target lifecycle and cross-job
session serialization. Return implementation changes to their unique owners.

| Subject | Exact reviewed commit | Scope / evidence level |
| --- | --- | --- |
| R0, PR83 | `9dc2e76d7713a45b952f0089f633947ff9049e0b` | Local Codex ownership, result persistence, local receive and owner ACK; source review plus scoped historical/current receipts |
| Image contract/persistence, PR84 (#77) | `7c764f2f2d53e939d162665aca9211da5c076778` | Committed contract/schema/coordinator and tests; seven independent temporary-store probes |
| Review branch | `codex/image-review-82-20260930`, based on the R0 commit above | Documentation only; not an A/B/C integration branch |
| #78 adapter and #79 original exporter | No fixed delivery accepted in this assignment | NOT_REVIEWED / integration NOT_RUN; authors' working directories were not read |
| #80 multi-reference/region and #81 batch | Separate later slices | NOT_RUN; not prerequisites for the bounded single-image slice merely because their broad issues remain open |

PR84 is stacked on PR83. PR83 contains the pre-existing `3691b60` code commit
and `9dc2e76` receipt documentation above main
`5c7a77bc1d1e76870657ec7fdd619a2494bb3d58`. The moving remote branch and the
installed runtime must not be substituted for these fixed objects. Both PR heads
were re-read through host-local `gh` and matched the assigned SHAs.

Source inspection used `git show <fixed-head>:<path>`. Independent probes used
`git archive` of the fixed objects into an isolated temporary directory under the
review worktree; it was removed after each probe run. No implementation author's
uncommitted changes were inspected or copied. No product code was changed.

A later CONTROL snapshot at approximately 06:56 UTC records a partial #78 PR85
at `df256f3`, controller ACK BLOCKED, and hard-blocked start/reconcile pending
persistent session exclusion, a native observer and original-export integration.
That later head was **not** part of this assignment's fixed-head review; it does
not turn the G02 reservation counterexample into evidence of unsafe live sends
by B, and neither its code nor its author test count is accepted here.

The authorized host/repository/remote/local GitHub identity were verified as
`xlmini`, `chatgpt-chat-bridge`, `luxiaolei/chatgpt-chat-bridge`, and `luxiaolei`.
The task envelope SHA-256 matched
`67e51015834daf44c378f5148aedaca183ea62fa619e06943bfed7238def28d4`.
Repository AGENTS, both repository skills and architecture were read. Access to
the installed skill path was denied; the envelope explicitly permits repository
copies. That denied path was not accessed through another transport.

## 2. Evidence levels and resource observation

`REPRODUCED` below means an independent check on committed code with synthetic
inputs, not a generated image. `AUTHOR_TESTED` means an author's recorded suite,
not a new reviewer run. `SOURCE_REVIEWED` means inspection only. `NOT_RUN` is not
PASS, and no metadata fixture establishes possession of original bytes.

The current reviewer requested **Latest + Pro**. At
`2026-09-30T06:43:16.685Z`, the supported status command returned live
`modelSelection={model:null, effort:"Pro", raw:"Pro"}` and a separately persisted
`verifiedResourceSelection={model:"Latest", effort:"Pro",
verifiedAt:"2026-09-30T06:38:59.890Z"}`. Configuration also said Latest/Pro.
Thus Pro was observed live and Latest/Pro was verified at dispatch; a fresh live
model-name observation was unavailable. No model/effort change or downgrade was
made. These observations do not identify the underlying image model, guarantee
image availability, or establish quota. The live page was still generating;
a visible Retry recommendation was not acted upon.

Baseline source tests recorded 211/211 plus static and pacing/cooldown PASS; the
existing controlled baseline log was read. PR84/contract-handoff records
234/234, including 23 image tests, and author log SHA-256
`ccbd284f9e7b934f4a6e95a4fd19e6380d4e80f27afa5b69ae761eefa550b289`.
That PR84 full-suite result is **AUTHOR_TESTED**; its host-local `/tmp` log was
not independently reopened in this review. The new independent probes below do
not rebrand the full 234-test suite as a reviewer run.

Fresh documentation-branch `npm run check && npm test`: **211/211 Node tests,
static and pacing/cooldown PASS in the completed log**. The outer reviewer
subprocess timed out after 55 seconds; the child test log subsequently completed
with a Node duration of 62,460.527375 ms. A follow-up own-worktree process check
found no remaining test process. The original outer shell exit status was not
recovered, so it is not asserted as exit 0. The run was not restarted. Evidence:
`review-check-test.json` and `review-check-test.log` (SHA-256
`cabae8c591f509bb7bfb230f7d5d1befb6d4028ae1560e6feab3d856c3c6b5b1`). This is R0 plus this document, not the full
PR84 or a combined A/B/C installation.

## 3. R0 review: what the local round trip does and does not prove

At the fixed R0 head, `src/coordinator.py:305-329` binds native local owners to
an exact saved thread/host and rejects tunnel-origin local-owner impersonation.
`task_contract` at `614-635` gives the immutable local dispatch precedence over
stale runtime owner fields. `result` at `973-1068` records an immutable result
before callback handling; a local owner gets `WAITING_LOCAL`, not a guessed Web
controller. `receive_local_result` at `1155-1186` is replayable, bounded polling
(maximum 55 seconds). `result_ack` at `1075-1152` validates the owning local
thread/host and exact result version before acceptance and `RECEIVED_LOCAL`.
These are routing guards inside the trusted OS-user boundary, not isolation from
an adversarial peer already holding that user's local privileges.

| Evidence | Observation | Qualification |
| --- | --- | --- |
| Historical `CB-LOCAL-20260930-01` | R0 document records SENT -> WAITING_LOCAL -> RECEIVED_LOCAL / ACCEPTED; code under that canary was `3691b60` | Historical document re-read, not a new canary or independently reopened original canary directory. Its approved Latest/Extra High does not override this task's Latest/Pro |
| Current `CBIMG-DIAG-78-20260930-01`, result version 1 | Diagnostic report records its own queue result / WAITING_LOCAL; saved owner ACK says ACCEPTED after evidence review | Current diagnostic round trip, not #78 image execution acceptance; this reviewer did not receive or ACK as the owner |
| Current `CBIMG-DIAG-79-20260930-01`, result version 1 | Diagnostic report plus saved owner ACK says ACCEPTED after evidence/hash review | Report was a pre-result snapshot; ACK and current CONTROL are the additional evidence. Not #79 original-export acceptance |
| This review task | Own supported queue status observed SENT, one dispatch attempt, RUNNING, exact persisted local Codex owner | Its final result and owner ACK remain separate; this document cannot confer acceptance |

The former implementation tasks `CBIMG-78-20260930-01` and
`CBIMG-79-20260930-01` remain **DELIVERY_UNKNOWN with business authorization
suspended**. Their diagnostic ACKs are neither proof of non-delivery nor
permission to replay or accept a late old task. The v2 author assignments are
new task IDs. No retry, reconciliation mutation, owner ACK or old-task result was
performed here.

No evidence here establishes active wake-up of a closed/idle Codex App, native
Codex target dispatch, MCP Events push, or arbitrary cross-account portability.

## 4. Controller task -> ImageJob -> actual Chat: traced call contract

Keep the identifiers and principals distinct:

```text
Native owner / independently authenticated HZ gateway
  -> existing controller dispatch operation O, controllerTaskId C, target Chat T
  -> separately authorized immutable image grant G (exact request + scope + route)
  -> image-submit: persist first ImageJob J (J != C)
  -> beginAttempt: persist attempt A, baseline, requested/observed resources,
                   SUBMISSION_UNKNOWN, then return one fresh effect admission
  -> #78 executor: existing live ownership/pacing gates, at most one image send to T
  -> exact new user/assistant turn observation (or original source turn for export)
  -> #79 original bytes -> manifest -> technical validation -> consumer receipt
  -> explicit controller-task result, then original owner review and ACK
```

This diagram describes required ordering, not a proven installed command path.
A development assignment to an implementation author is not itself a grant to
run a live ImageJob or externalize any source material.

### 4.1 Constraints actually enforced by PR84

`src/coordinator.py:2498-2521` requires the image route's session/account/Project
and requested model/effort to match **the saved controller dispatch target**.
`2566-2581` requires that dispatch already be SENT, with no controller result,
and rechecks pause/drain, cooldown and recorded user-control pause. The image
API does not create a dispatch or select a second target. Grant/revoke at
`2485-2495` are host-owner actions: a worker's account-origin hint, `caller.ref`,
namespace, digest or grant ID is not grant-issuing authority.

### 4.2 Independent results: neither assume universal deadlock nor claim a full path

| Scenario | Independent observation | Meaning |
| --- | --- | --- |
| Native caller differs from target Chat | R01: `caller.kind=codex`, caller ref != target; control-only fake dispatch SENT; first J persisted and begin returned NEWLY_RESERVED | A structurally legal external-owner path exists in the offline API. It did not send an image before J existed. The fake worker is not a browser/entrypoint proof |
| Worker W reuses C dispatched to W but requests target T != W | R02: grant rejected with IMAGE_ROUTE_NOT_GRANTED | Existing worker task cannot be repurposed as a different image target. A/B must specify the authorized target-control operation rather than weaken route checks |
| Controller dispatch has not yet been delivered | R03: IMAGE_CONTROLLER_DELIVERY_NOT_CONFIRMED; image job rows remain zero | A real image prompt must not be placed in that prerequisite dispatch merely to make image-submit admissible; doing so would precede J's durable reservation |
| Bootstrap READY is reported as terminal controller result | R04: first image-submit then fails IMAGE_CONTROLLER_RESULT_RECORDED | A normal completed bootstrap task cannot later become the ImageJob's control task |
| Running worker sends to its own Chat | Fixed R0 policy check returned CHAT_BUSY for generating=true; main.js:1139-1143 applies it before filling/sending | No automatic Stop, re-send loop, nested self-ask or removal of the safety check is an acceptable workaround |

A **candidate bounded establishment pattern** is: the genuine local owner (or a
separately authenticated host gateway) establishes O for a dedicated existing T
with a strictly control-only bootstrap; the bootstrap emits readiness, not a
terminal queue result; the external executor waits for T to be idle and its
composer to be empty; the owner issues G; J/baseline/UNKNOWN are persisted before
the first image send. The original task remains open until the whole authorized
image operation is settled. No generating worker needs to send to itself.

Only the offline persistence portion of that pattern was exercised. It is **not
yet an accepted operational protocol**: the normal queue footer
(`src/coordinator.py:412-431`) requests durable completion, and current liveness,
active-task protection, bootstrap semantics and the exact #78 entrypoint must
be made consistent and tested. An already running Web worker also cannot mint
G because grant creation is host-owner-only. The controller must either approve
and prove a bounded multi-turn control lifecycle or have A/B introduce an
explicitly authorized separation between dispatch execution and image target.
Do not invent a new scheduler, forge a Codex owner, clear origin hints, or use a
dummy live dispatch with an image prompt as an admission bypass.

For HZOS, `caller.kind=hzos` is a schema value, not a connected authenticated
service or an implemented gateway. Actor/tenant/object/current destination rights
must be checked by the real gateway independently. Cross-host callers use
portable artifact references; they do not assume a shared Mac pathname.

## 5. Findings and required owner actions

### F01 — P1: native capability evidence is not bound to verified model/effort

**REPRODUCED on PR84 `7c764f2...`. Owner: A / #77.**

Location: `src/capabilities/image/contract.js:110-123` (especially 111-120), with
`beginAttempt` at `220-223`. The gate checks feature, route, version and time but
never reads `capabilities.modelSelection`. The separate begin event confirms
that the current UI equals the requested model/effort, not that those resources
match the resources on which the positive capability was observed.

R06 supplied a route-matching NATIVE generation snapshot observed under
`Other-synthetic-model + High`; the request and attempt were Latest/Pro. R07 used
`model:null, effort:null, verified:false` in that positive snapshot. Both received
`NEWLY_RESERVED`. These were metadata-only tests; no live grant was issued.

Impact: unverified capability for the current resources can pass the supposedly
fail-closed native-generation gate. This does **not** demonstrate a downgrade of
the requested Latest/Pro controls. It demonstrates reuse of capability evidence
that did not verify those controls.

Required fix: reject absent/unverified/mismatched resource identity for
model-dependent positive features before effect admission. If a genuinely
model-independent assisted export capability is intended, define its explicit
policy and evidence scope rather than treating all positive snapshots as
resource-independent. Add mismatched and unverified snapshot regressions, and
retain the separate current-UI selection check. Latest still cannot pin an
unexposed underlying model version.

The independent reproductions preceded reading the matching existing automated
PR review. That review is corroborating, not substituted evidence:
[PR84 discussion](https://github.com/luxiaolei/chatgpt-chat-bridge/pull/84#discussion_r4141588196).

### G01 — Integration blocker: establish the control task without self-send or early image work

**REPRODUCED restrictions; complete #78 path NOT_RUN. Owners: A/B and controller.**

Locations: `src/coordinator.py:2498-2521,2566-2581`; R0
`src/task-policy.js:42-47`, `src/main.js:1139-1143`, and queue footer `412-431`.
R01-R04 and the fixed-policy check in section 4 delimit the problem precisely.
The target binding is a real constraint, not proof that every native caller is
impossible. Conversely, a mock control-only dispatch is not enough to approve
an active Web worker -> different image Chat integration.

Required handoff before a real canary: one executable, bounded trace showing
who creates O and G, where the bootstrap executes, when it is idle, why C is not
prematurely completed, the exact caller/session identities, J persisted before
any image prompt/upload, first/duplicate effect admission, and who finally
reports/ACKs C. Include native Codex and the declared HZ entry boundary; label the
external gateway unavailable until implemented. Resolve in assigned A/B domains,
not in this review's documents by granting broader permissions.

### G02 — Integration blocker: cross-job session exclusion is not supplied by per-job CAS

**REPRODUCED reservation gap; duplicate live send NOT OBSERVED. Owners: A/B.**

Locations: `src/coordinator.py:2566-2581,2641-2678`; R0
`src/task-policy.js:31-40`. R05 created two different jobs under the same
controller operation and target session. While J1 was SUBMISSION_UNKNOWN, J2's
begin also returned `NEWLY_RESERVED`. The policy check showed no active-task
conflict when the controller task ID was the same, while a different controller
task was rejected. Therefore a task-ID guard or an event replay guard alone is
not a cross-ImageJob guard.

The A contract correctly requires B to additionally hold live UI/pacing/manual
ownership admission. No fixed B adapter was reviewed, so this is not a claim
that it already double-sends. B must prove a session-scoped exclusion/reservation
covering unresolved image work, including the lost-send-receipt window, across
different job IDs and different processes. A short account UI lock does not
itself prove that invariant between polling calls. Do not hold a global UI lease
through generation waits; retain logical target exclusion instead. UNKNOWN
must reconcile on its original route before a conflicting job is admitted.

### K01 — Existing dispatch lifetime defect, separately owned

At both reviewed heads, `src/coordinator.py:2192,2300` uses a 120-second child
wrapper timeout; the R0 wrapper permits the Ego client a default 180 seconds.
The controller's `dispatch-fix-proposal/FINDINGS.md` and seven-check test log
report orphaned-child reproduction and a proposed bounded process-group fix.
This reviewer inspected the fixed source and those records, but did not rerun
the fake-process tests or install the proposal. The latest CONTROL additionally records a root closed-pipe / TERM-ignoring
counterexample still failing and a separately dispatched implementation task.
The previously recorded seven checks are therefore not evidence that the whole
proposal is correct. No new proposal code was inspected in this assignment.
The old UNKNOWN operations remain UNKNOWN. The controller must disposition this
known deployment risk
separately; it is not repaired by the document PR or by the new task IDs.

## 6. Executable acceptance matrix

Each future execution must pin an integrated commit, installed file hashes,
authorized host/account/Project/session, actual UI model/effort observation,
capability version/time, material rights, budget and output target. Store a
redacted evidence index keyed by task/job/attempt, not screenshots or chat text
masquerading as originals. Do not tick a parent issue based only on unit tests.

| ID / owner | Required action and negative case | Required evidence / expected result | This phase |
| --- | --- | --- | --- |
| M01 R0 / reviewer | Re-read exact PR83 owner/result/receive/ACK implementation; compare current diagnostic receipts to historical canary | Exact owner, immutable result event/version, WAITING_LOCAL then owner ACK; no Web fallback or wake-up claim | SOURCE_REVIEWED; diagnostic artifacts and ACKs read; new live round trip NOT_RUN |
| M02 A / #77 | Normalize same request with reordered keys; alter prompt/route/scope/source or extra authority/paid flag | Stable digest for same request; conflict/rejection for changes; job ID distinct from controller task | AUTHOR_TESTED (fixed 23-image-test suite); schema/source reviewed |
| M03 A / #77 | Wrong tenant/caller/origin or invented grant; worker tries grant/revoke; unconfirmed dispatch and result-recorded controller | Access denied; no new job or effect; explicit host-owner grant and current scope | Author counterexamples reviewed; R02-R04 independently reproduced |
| M04 A / #77 | Native capability snapshot for other model/effort or unverified selection | No fresh effect admission; explicit capability mismatch/unknown | **FAIL F01**, independently R06/R07; fix and fixed-head rerun required |
| M05 A/B | Trace C/O/G/J and actual T for first native call; test active worker, different target, premature bootstrap result | No self-send, no image before durable J; bounded controller lifecycle and host-grant issuance | R01 structural positive and R02-R04 restrictions reproduced; full path **NOT_RUN G01** |
| M06 A/B | Replay lost begin response; changed duplicate event; concurrent expected revisions; two jobs on one T | NEWLY_RESERVED only fresh; replay RECONCILE_ONLY; one CAS winner; logical same-session exclusion for unresolved jobs | A replay/CAS tests reviewed; R05 cross-job gap reproduced; adapter exclusion **NOT_RUN G02** |
| M07 B / #78 | Generate one synthetic image; observe new user and assistant turn; supply old/input/thumb/placeholder/text-only candidates | Exact pre-send baseline and new turn IDs; rejects non-output candidates; never count text as generated bytes | A identity checks reviewed; real DOM/adapter generation **NOT_RUN** |
| M08 B/C | Validate allowed local source bytes/hash/revision/current rights; reject missing/wrong hash/unsafe format; observe accepted attachment | Source externalization authorized before upload; accepted attachment tied to exact source; preserves #58 single-input behavior | A source metadata guards reviewed; actual source upload/checks **NOT_RUN** |
| M09 B/C | Source-bound single edit/refine after first original; wrong parent/hash/route, context loss and second source rejected | Immutable child output with exact parent/source hashes/revision; separate child turn and original | A same-source unit path reviewed; actual edit/refine **NOT_RUN** |
| M10 B | Simulate pre-send failure vs lost send acknowledgement; restart before/after send; repeated reconciliation | Proven pre-send only may retry within budget; UNKNOWN stays on original route with no re-generation; no old task replay | A tests reviewed; adapter crash boundaries **NOT_RUN** |
| M11 B | Human Space/draft/takeover, pause/drain, shared-account cooldown, wrong account/login, unavailable model | Fail/defer without claiming user Space, stopping generation, clearing another task or changing accounts to evade limits | Existing guards source-reviewed; full live protection **NOT_RUN** |
| M12 C / #79 | Original export via verified official/host channel; unavailable/expired URL and partial originals | Original bytes or explicit ASSISTED / EXPORT_UNAVAILABLE; resume missing originals only, never re-generate | Output/receipt shape only; real original channel **NOT_RUN** |
| M13 C | Decode and verify magic/MIME/hash/byte length/actual pixels/count; reject thumbnail, duplicate, corrupt and wrong-ratio output | Independent verifier receipt and file hashes; exact expected/actual/missing count; no prompt/DPI/upscale equals native-4K claim | Synthetic metadata not bytes; independent original verification **NOT_RUN** |
| M14 C | Path traversal, symlink, overwrite conflict, disk full, crash temp file and cross-host handoff | Controlled destination, no unauthorized overwrite, bounded cleanup, retention policy, verified remote receipt; local Mac path alone insufficient | **NOT_RUN**, requires fixed C implementation and isolated filesystem tests |
| M15 A/B/C | Cancel before send vs after possible send; revoke/expire permission, deadline and late results | CANCELLED only with no-send proof; otherwise CANCEL_REQUESTED; original attempts pinned; late outputs quarantined, no automatic delivery/adoption | A state tests reviewed; complete side-effect/receiving-right enforcement **NOT_RUN** |
| M16 C / HZ consumer | Retry export/receipt and late duplicate transfer; change consumer rights after grant | Portable redacted manifest binds J/A/turn/output/hash/lineage; byte-matching idempotent RECEIVED/REJECTED under current rights | Schema defined; actual consumer/authenticated receipt integration **NOT_RUN** |
| M17 reviewer / controller | Run check/test on proposed integrated head, compare fixed source and installed artifact; authorized installation and rollback separately | Old send/ask, routing, #58 input, callback/ACK, pacing/cooldown, SQLite hot reads and UNKNOWN regression logs; restore previous verified runtime if rollback exercised | Doc-branch run recorded below; integrated A/B/C check, installation and rollback **NOT_RUN** |
| M18 #80/#81 | Multiple references/mask/strict region/batch/item recovery, quota/cost and concurrent revisions | Feature-specific native/assisted/unsupported proof; no silent truncation; 7 of 9 is PARTIAL, collage is not nine originals | **NOT_RUN / SEPARATE_SCOPE**; no v1 pass extrapolation |
| M19 HZ business owner | Adopt an asset/revision, publish/channel/mobile delivery, commercial use/production | Separate authorized HZ business decisions and real downstream receipts | **NOT_RUN / OUT_OF_SCOPE**; Bridge technical status cannot approve/publish |

### Future real canary boundary (not authorization)

Only after separate controller authorization and accepted fixed A/B/C integration:
use licensed synthetic material, an explicit account/budget grant, one generate
and one single-source edit/refine at most. Retrieve and validate both original
files; correlate prompt/input hashes -> jobs/attempts -> new turns -> outputs ->
portable manifest -> independent byte validation -> authenticated consumer
receipt. Keep old-generation, input-reference and thumbnail controls, and
exercise failures offline before using the live account. Label any official
manual file handoff ASSISTED. Stop/defer on login, quota, rights or native
capability uncertainty; never silently switch to a paid API or another account.

A consumer receipt is not an ImageJob technical validation; neither is an HZ
asset approval or publication. HZ Blueprint #107 / Runtime #134 own business
asset/revision mapping and authenticated consumption. No changes were made to
those repositories. Raw prompts, source files, private conversation/resource
URLs, credentials and absolute export paths do not belong in public evidence.

## 7. Independent reproduction and controlled evidence index

On authorized host `xlmini`, evidence root is
`/Users/xlmini/Projects/chatbridge-image-delivery-20260930/`.

| File | SHA-256 / interpretation |
| --- | --- |
| `review-fixed-head-checks-v2.json` | `19ab14f02b8185a59234d5f609777fd34b33e1ff0c15f222150fbb061164fcbd`; seven independent probes, exit 0; contains full reproduction script and synthetic outcomes, including defect reproductions |
| `review-self-target-check.json` | `9e8d9e0f93ee485e110536e5602d404c26e86ccc5adf08d68759f56c631a18ed`; fixed-policy CHAT_BUSY and task-ID exclusion checks, exit 0 |
| `review-fixed-head-checks.json` | `23b85f9dfbe39c08b5d60f0cecb9434db085677b957a16b95b484d9b06eee6ae`; preserved first attempt, exit 1 from reviewer harness using positional `status` as JSON API. Not a product defect; corrected to read synthetic fixture SQL in v2 |
| `receipts/78-diagnostic-ack.json` | `3c4e311065a25b3851f9675d821d1be3d3bd1926c0c6a7b446c10e1529581442`; current diagnostic-only owner acceptance |
| `receipts/79-diagnostic-ack.json` | `efa97b8926cd6c1a755226de4711fd14b263a5e48316b909c3d4d0eb187f4fee`; current diagnostic-only owner acceptance |
| `dispatch-fix-proposal/FINDINGS.md` | `a382821b43e168c93c8c2f2196be2ce699b40a32f5b4c5cc6a00e8aca6ac1d4e`; separate controller diagnosis/proposal, not installed |
| `dispatch-fix-proposal/test-log.json` | `581489e74701aeb69b729529abc7e91d8e71b616cd887e3bdd785398ffbcee97`; previously recorded fake-process checks, not rerun here |
| `review-handoff.json` | Local machine-readable handoff: reviewed heads, source hashes, probes, document/test/PR evidence, model observations and completion boundary |

To reproduce the seven probes without the live bridge: extract the fixed PR84
commit into a fresh temporary directory, then run the `reproductionScript` from
`review-fixed-head-checks-v2.json` using Node from that directory. It imports the
fixed `tests/image-persistence-fixtures.mjs`, whose independent temporary
registry/SQLite store, mock worker and nonexistent Ego executable keep these
checks offline. Do not point its fixture transport at a live configuration.
The report records both the script digest and exact source commit.

The essential F01 reproduction is:

```js
// Run only in an isolated checkout/archive of the fixed PR84 head.
import {fixture} from './tests/image-persistence-fixtures.mjs';
const f = await fixture();
try {
  const r = f.request(); // request and actual begin event: Latest + Pro
  const g = f.grant(r);
  g.capabilities.modelSelection = {
    model: 'Other-synthetic-model', effort: 'High', raw: 'High', verified: true
  };
  const {key, job} = f.setup(r, g);
  console.log(f.begin(key, job).effectAdmission); // Actual: NEWLY_RESERVED
  // Required after fix: explicit mismatch rejection, not a native send permit.
} finally { await f.close(); }
```

## 8. Handoff and release gate

A must resolve F01. A/B/controller must agree and prove G01's bounded call path
and G02's session exclusion. C must provide actual original verification and
portable receipt evidence at its own fixed head. The controller separately owns
the dispatch-lifetime proposal and all merge/install/canary decisions. The
reviewer will not amend A/B/C implementation files or mark a later moving head
accepted based on this document.

The worker's final `queue result` may say COMPLETE **only for this assigned
preparation/initial-review phase** after durable GitHub/report updates. Bridge
resolves the original persisted controller; no callback target is chosen here.
`WAITING_LOCAL` and a worker result are not controller acceptance. Only the
owning Codex's evidence review and exact-version ACK settle this review task.
The #82 feature issue stays OPEN; all real generation, material externalization,
original export, authenticated consumer integration, installation, rollback,
paid APIs, business adoption, publishing and production remain **NOT_RUN**.
