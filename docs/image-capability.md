# Image capability v1 — contract and persistence

This is the Bridge technical contract for #77, not a claim of live image support
or HZ business approval. The implementation consists of a Node contract/reducer,
a versioned schema and a narrow persistence hook in the existing coordinator.
No scheduler, account pool, browser service or Python subsystem is added.

## Identity and durable state

`schemaVersion` is `chatbridge.image.v1`.
`src/capabilities/image/schema.v1.json` defines Request, Grant, Event, Result,
Output, Capabilities and Receipt. `contract.js` implements the exact subset of
schema keywords used in that file, semantic validation, canonical SHA-256 and
pure state transitions using Node stdlib only.

An image `jobId` is **not** its `controllerTaskId`. The job points to an existing,
immutable controller dispatch `controllerOperationId` and its task; it does not
create another dispatch, controller task, callback, owner or account assignment.
Image attempt IDs, Chat user/assistant turn IDs and output IDs remain separate.

The existing `bridge.sqlite3` gains three lazy tables: `image_grants`,
`image_jobs` and `image_events`. Jobs use `(caller_ref, job_id)` as their unique
key. Request digest, route, scope and controller operation cannot be rebound.
The job and its event snapshot commit together under existing `BEGIN IMMEDIATE`
and expected-revision compare-and-swap. Duplicate event IDs replay the saved
snapshot; changed content conflicts. Concurrent updates to one revision cannot
both commit. No image job is projected into the reconstructable runtime cache.

Fresh attempts also exclude any other unresolved native job for the real
`accountId + conversationId`, in the same transaction. Caller, tenant, Project,
account alias and session alias do not partition that physical conversation.
Several jobs may be submitted, but only one can reserve its native side effect;
the loser receives only `IMAGE_SESSION_BUSY`, without another job's identity.
Same-event replay still returns `RECONCILE_ONLY`.

`normalizeImageRequest(input)` fills inputs/base/mask/count/ratio/conversation
policy defaults and hashes recursively key-sorted JSON without `requestDigest`.
Every request field is covered, including caller, tenant/namespace/purpose,
workgroup, exact account/Project/session/conversation, prompt, source hashes and
revisions, mask, budget, output destination and requested model/effort. A supplied
wrong digest fails. Same caller/job with the same request replays; another
approved request with that identity conflicts. Cross-scope access is denied.

## Authorization: separate host-owner grant, never a caller-supplied flag

There is no `authorized: true`, namespace shortcut or bearer token in a request.
The request's `authorizedOutput` describes the **requested** destination; it gains
permission only when the controller separately approves the entire request.
A `grantId` is a lookup key, not a credential. Arbitrary caller/job/namespace names
cannot create a grant or expand its scope.

The existing coordinator exposes the local management actions below. These are
JSON stdin commands in the source checkout, not a new installed public CLI:

```text
python3 src/coordinator.py image-authorize CONFIG_DIR STATE_DIR
  {"issuerRef":"<persisted controller owner>","grant":{
    "grantId":"grant-1",
    "controllerOperationId":"<existing dispatch operation UUID>",
    "controllerTaskId":"<existing controller task>",
    "request":<normalized exact ImageJob request>,
    "sourceExternalizationAuthorized":false,
    "expiresAt":"<ISO time no later than request budget deadline>",
    "capabilities":<route-bound feature-specific evidence snapshot>
  }}

python3 src/coordinator.py image-revoke CONFIG_DIR STATE_DIR
  {"issuerRef":"<persisted controller owner>","grantId":"grant-1"}
```

Grant creation/revocation reject tunnel-origin calls, even when the caller names
an owner. A local Codex owner must match the persisted thread and host through
existing `local_caller`; a non-Codex owner retains the existing host-local
management boundary. Grants are immutable; revoked grants are not revived by
replay. A newly approved capability snapshot can enable a BLOCKED job before an
attempt, or a bounded retry after proven pre-send failure. An already-started
attempt remains bound to its original grant; a different grant cannot silently
renew it or adopt its late results.

Worker access requires the saved grant's exact caller/job/scope and the existing
account-origin or local-owner check. An unverified Space hint is rejected.
These are guards within Bridge's **trusted host / verified account boundary**,
not isolation from another process with the same OS-user credentials or another
session controlling the same authorized account. A remote HZ gateway must
independently authenticate actor/service principal, tenant, object rights and
current receiving permissions; that gateway is outside #77 and is NOT_RUN here.
Neither an old callback nor a hash is authority to receive/adopt an asset.

An external owner/executor may establish a dedicated target using an ordinary,
exact-target control-only dispatch: initialize the target, verify readiness,
reply READY and wait. READY is not a terminal `queue result`; the default
watchdog leaves that task active as `AWAITING_DURABLE_UPDATE` and notifies its
owner. It needs no additional readiness phase. After the target is idle, the
external executor obtains the owner grant, saves the ImageJob and actual
native baseline, and reserves the attempt before the first image Send. It must
not put an image prompt in the bootstrap or have an active worker send to
itself. The owner, executor, controller task and image job remain separate
identities. Grants remain bound to the exact dispatch target; neither a
different target nor an unsent/completed bootstrap can admit image work.
The final controller result and owner ACK follow remote settlement, original
export/consumer evidence and owner review; technical ImageJob success cannot
complete that controller task. The HZ gateway remains unavailable until its
authentication and current actor/tenant/object-right checks are implemented.

Admission rechecks the existing registered account identity, binding, Project,
session/conversation, requested model/effort, controller delivery `SENT`, absence
of a controller result, management pause/drain, account cooldown and recorded
user-control pause. The adapter must additionally use the existing live UI
ownership/pacing gate around its side effect; database admission does not claim
an Ego Space, override human control, migrate accounts or authorize a paid API.
`allowPaidApi` is fixed to false in v1.

References use portable `artifact:`, `store:` or `urn:` identifiers, not Mac
paths, private session URLs or credentials. Imported source refs/hashes/revisions
need explicit source externalization approval. Source refs carrying Bridge job
and output IDs resolve to an exact VERIFIED parent in the same caller/scope.
Refine requires that parent and the same route/conversation; export-only also
binds the parent's route. An imported external image may be edited with explicit
authorization, but v1 refine/export-only do not guess an unknown prior Chat turn.

## Node API and adapter obligations

The executor supplies the existing `coordinated(command, payload)` transport:

```js
import {
  createImageJobAPI, normalizeImageRequest, imageJobKey
} from './src/capabilities/image/contract.js';

const image = createImageJobAPI({coordinated});
const request = normalizeImageRequest(authorizedRequest);
const key = imageJobKey(request, grantId);
const job = image.submit(request, {grantId});
```

| Method | Arguments | Contract |
| --- | --- | --- |
| submit | request, `{grantId}` | Persist or replay the authorized immutable job |
| inspect | `{grantId,callerRef,jobId,scope}` | Read job, attempts and original request |
| result | key | Read technical projection; omit full prompt |
| authorizeIO | key | Recheck current host grant and admission; `{allowed:true,expiresAt}` or explicit failure |
| sessionOccupancy | `{accountId,conversationId}`, optional key | Read only `{occupied,reservedByJob}`; no UI or permission grant |
| beginAttempt | key, event | Persist baseline and UNKNOWN before a possible send |
| record | key, event | Persist adapter observation; never execute a send |
| export | key, event | Persist exporter's byte evidence; no download or filesystem I/O |
| reconcile | key, event | Observe the original route/attempt only; never resend |
| cancel | key, event | Before attempt: cancel; after possible send: request stop only |

Mutations route to `image-submit` / `image-apply`; ordinary reads use
`image-inspect` / `image-result`, with the two query-only checks described below.
No installed runtime/CLI behavior changes in #77. Entry wiring and actual adapter
are #78's unique write domain; original-byte exporter and consumer receipts are
#79's. The controller installs only after independent review and integration.

`sessionOccupancy` calls `image-session-occupancy` with
`{session:{accountId,conversationId},key?}`. The local query uses a query-only
SQLite read transaction, never creates a missing store/image table, repairs a
projection or wakes Ego. A generic call returns no job, tenant, prompt or grant
details; an origin-account hint must match the queried account, and a Space-only
hint fails closed. A supplied key must pass existing grant access and exact
real-session binding. `reservedByJob` is true only when that saved grant/job is
the **sole** unresolved reservation; conflicting legacy rows make it false.
This is occupancy evidence, not current grant or I/O authorization.

`authorizeIO(key)` calls `image-io-admission` with the exact Key. It uses the
same query-only read path and requires the persisted job's current grant,
origin/local-owner access, current registered route, SENT controller with no
result, management/cooldown/manual admission, valid grant/deadline/attempt
duration, no revocation or cancel request and the request capability gate.
It returns only
`{allowed:true,expiresAt}` or an explicit failure. The expiry is the exact
minimum of the saved grant, request deadline and applicable attempt deadline;
it is not a new TTL or authority source. #78/#79 must call it before and after
awaited source/export I/O; `inspect` deliberately remains readable after
revocation and cannot authorize that I/O. This does not grant an image Send or
implement external actor/tenant/object/revision/receiving authorization.

#78 must consult this same occupancy before generic send/watch/recovery/prune/
detach behavior: unresolved image work permits observation/reconciliation, not
generic Retry, Continue, Stop, replay or automatic detach. An image executor
rechecks exclusive ownership with its key before upload/Send, alongside existing
live pacing, manual ownership and current authorization. A stale read cannot
authorize a side effect; only fresh `beginAttempt` supplies `NEWLY_RESERVED`.

Every event has `eventId` and `expectedRevision`. Example events below use
synthetic identifiers; a real adapter supplies observed evidence, not these
placeholders. The adapter method supplies `type` automatically.

```js
const reservation = image.beginAttempt(key, {
  eventId: 'begin-1', expectedRevision: job.revision, attemptId: 'attempt-1',
  baselineTurnIds: ['previous-user-id', 'previous-assistant-id'],
  modelSelection: {model: 'Latest', effort: 'Pro', raw: 'Pro', verified: true}
});
```

The first committed reservation returns `effectAdmission: "NEWLY_RESERVED"` for
generate/edit/refine. **Only that response**, within existing live UI admission,
permits the one intended send. Its durable job status is already
`SUBMISSION_UNKNOWN`. A replayed begin event returns `RECONCILE_ONLY`, never
another send permit. The permission is not saved in the job or returned by
inspect. A lost response, interrupted process or unknown send is reconciled on
the same route; a new event/attempt ID is not a retry loophole.

Export-only returns `READ_ONLY_EXPORT` on a new reservation. It does **not** send
a generation prompt. `sourceTurnId` comes from the persisted verified parent;
the observation must bind that original turn and can omit `userMessageId`.

For generation/edit/refine, observations must bind a new user message and a new
assistant turn absent from the pre-send baseline. Turn identity is immutable:

```js
const observed = image.record(key, {
  eventId: 'observed-1', expectedRevision: reservation.revision,
  attemptId: 'attempt-1', route: request.route, status: 'GENERATED',
  userMessageId: 'new-user-id', turnId: 'new-assistant-id',
  candidateOutputIds: ['output-1'], evidenceRef: 'artifact:evidence:new-turn'
});

image.export(key, {
  eventId: 'export-1', expectedRevision: observed.revision,
  attemptId: 'attempt-1', route: request.route,
  outputs: [verifiedOriginalOutput], evidenceRef: 'artifact:evidence:byte-checks'
});
```

Old images, input references, thumbnails, placeholders and assistant text cannot
be asserted as generation evidence by the adapter. This contract validates
bindings and claimed evidence structure; it cannot independently inspect DOM
or original bytes. #78/#79 must supply their real observations and verifier
results. The tests here deliberately use labeled synthetic metadata fixtures.

## States, limited cancellation and recovery

`SUBMITTED` is admission, not remote delivery. An attempt begins as
`SUBMISSION_UNKNOWN`; known new-turn observations can advance it to `GENERATING`,
`GENERATED` or `PARTIAL`. Generated candidates are not yet exported originals.
`FAILED_PRE_SEND` requires explicit before-send evidence with no known user or
assistant turn; only this state allows another attempt within `maxAttempts`.
Unknown delivery cannot be downgraded to safe-to-resend after known delivery.

`PARTIAL` retains known candidates/originals and exact `missingCount`. An output
set cannot silently remove previous candidates. `EXPORTED` means metadata for
all requested originals has been persisted but verification is incomplete.
`TECHNICALLY_VALIDATED` requires all requested outputs and all verifier checks.
`EXPORT_UNAVAILABLE`, `BLOCKED`, and `FAILED` remain explicit; they are not
successful text responses. No UI observation may directly claim the technical
validation state.

`cancel` before any possible send produces `CANCELLED`. After an attempt it
produces `CANCEL_REQUESTED`; no remote cancellation receipt is fabricated. #78
may request native Stop only under existing authorization/pacing, and cannot
undo prior external effects. Expired/revoked/budget-late results, cancelled work
and late observations after terminal failure are kept in `lateObservations` /
`lateOutputs`, with `LATE_RESULT_NOT_ADOPTED`. They do not replace accepted
outputs or become approved/published. Reads and evidence reconciliation remain
available during pause; new attempts do not.

The native reservation is retained for UNKNOWN, GENERATING, BLOCKED, FAILED or
EXPORT_UNAVAILABLE attempts. Cancel requests, expired/revoked grants, deadlines
and top-level terminal labels do not prove remote settlement. Only proven
`FAILED_PRE_SEND` or positively observed native `GENERATED/PARTIAL` settlement
releases it; #78 must verify that the native tool is settled before recording
those completion states. Late native settlement may release the conversation
while its outputs remain quarantined. Failure without such proof conservatively
stays occupied. Export-only work never reserves a native generation slot, but
its fresh begin also refuses another unresolved native job on that conversation.

## Capability observations and asset mapping

`unknownImageCapabilities(route)` defaults every feature to UNKNOWN.
`classifyImageCapabilities` accepts feature-specific NATIVE / ASSISTED /
UNSUPPORTED observations with version, timestamp, exact route and evidence refs.
Missing positive evidence stays UNKNOWN and execution fails closed. Input vision
or `imageParts` is not evidence of generation. Requested model, subscription
names and the moving label Latest imply neither an image model nor unlimited
quota. New capability evidence requires a separately authorized snapshot, not
an external caller's preferred mode.

Every positive model-dependent feature requires the capability snapshot's
`modelSelection.verified=true`, a non-null model/effort and an exact match to
`requestedModel/requestedEffort`. Mismatches/unverified resources block the job
and fail before attempt reservation. `beginAttempt` independently verifies the
current UI selection; snapshot evidence cannot replace that check. Native export
is model-dependent. Only ASSISTED export of an already authorized original is
model-independent, still requiring its own route/version/time/evidence, exact
source turn, current rights and independent byte verification. ASSISTED
generate/edit/refine and any other required features keep the resource check.

Features are generate/edit/refine/export/multiReference/mask/
deterministicComposite/batch. Native region and deterministic composition are
distinct. Mask coordinates bind source-pixels, source hash and source revision;
the actual mask/multi-reference/strict unchanged-pixel/batch capabilities remain
UNKNOWN or UNSUPPORTED without evidence and are not implemented by this schema.

Each Output binds job/attempt/turn/outputId, portable artifactRef, SHA-256, actual
MIME/byte length/decoded dimensions, ordered source hashes, parent output/base
revision, capability version/time, warnings and independent verifier checks
(magic, MIME, decode, hash, count). An output is immutable except for the initial
UNVERIFIED-to-VERIFIED upgrade; a verified output cannot be overwritten. The
exporter must resolve the authorized output target, validate bytes, enforce
filesystem and transfer safety and supply this metadata; #77 does not perform
those I/O operations or infer success from a filename.

HZ Blueprint #107 / Runtime #134 map `jobId/attemptId/route/turnId/outputId`,
`artifactRef/sha256` and source/base lineage into their immutable Asset/Revision
records. `Receipt` is `chatbridge.image.receipt.v1` with receiptId, consumerRef,
jobId, requestDigest, outputId, artifactRef, sha256, receivedAt,
`RECEIVED|REJECTED` and reason. The artifact workstream owns receipt production
and idempotent storage; this module exposes its strict shape, not HZ adoption.
A consumer must validate current rights and received bytes independently.
Bridge technical VERIFIED/EXPORTED/RECEIVED never writes APPROVED or PUBLISHED;
`result()` explicitly returns `businessApproval: "NOT_EVALUATED"`.

The ImageJob API never submits a controller queue result or ACK. At the end of a
development task the worker separately updates GitHub and calls `queue result`.
Only the persisted owning controller reviews that evidence and acknowledges it.

## Verification and deployment boundary

Node tests cover canonical request/authorization counterexamples, restart
persistence, same-request replay/conflict, cross-scope/account guards, exact
source/turn/output binding, UNKNOWN reconciliation, bounded pre-send retry,
parallel revision conflicts, lost begin response, partials, cancellation, late
quarantine, revoked grants, pause/drain/cooldown/manual takeover, and original-turn
export-only. Fixtures use temporary SQLite stores, fake worker receipts and
synthetic metadata; no live browser or paid image API is called.

Run `node --check src/capabilities/image/contract.js`, coordinator syntax checks,
and `npm run check && npm test`. Final fixed-head results are recorded in PR #84
and #77 rather than presenting a moving branch as accepted evidence.

NOT_RUN in this delivery: real generation or material upload, Chat original
export canary, installed #78/#79 integration, independent code review, external
HZ authentication gateway/consumer receipt integration, business adoption or
publishing, installation/rollback and production use. No runtime installation,
merge, source material externalization or paid API invocation is authorized by
these offline test fixtures. Raw prompts, private input data and temporary
session/resource URLs must not be copied to public GitHub evidence/logs.

## Model and R0 provenance (2026-09-30)

Original frontend task: Latest + Pro. Development task
CBIMG-77-20260930-03 has persisted send receipt
`a546be04-603f-42d8-be41-65bcd248d14d` with observed
`{model:"Latest",effort:"Pro",raw:"Pro",verified:true}` on authorized default /
Ru Wang, Chat Bridge Project `g-p-6abca54a9ea88191b5b4a9f64ee1d75c`.
This is developer-chat selection, not image generation/model/quota evidence.
Historical hzcodex identity/model observations do not override this route.

The 2026-09-30 review corrections are locally authorized on the same isolated
#77 branch, using the user's current local GPT-6.1 Sol / Extra High preference.
That supersedes the earlier frontend-only Git-write arrangement; it supplies
neither native image capability evidence nor a real image acceptance result.

R0 is separate PR #83 at `9dc2e76d7713a45b952f0089f633947ff9049e0b`, containing
only the original `3691b60` and `9dc2e76` commits above main
`5c7a77bc1d1e76870657ec7fdd619a2494bb3d58`. Fresh baseline check + 211 tests and
static/pacing passed; historical local receive + owner ACK receipts were reread,
not rerun as a new canary. Active background Codex wake-up, native Codex target
dispatch and MCP Events remain separate unimplemented gaps.

The image PR #84 is stacked on `codex/local-codex-roundtrip`, with initial API
handoff at `b73d5bf1d5a19436ca9a329e11a9a72f2a361b8b` followed by persistence
and recovery guards. The controller alone decides review, merge, installation
and acceptance. Other worktrees, main/runtime/CLI/install writers and HZ
repositories are not modified by this workstream.
