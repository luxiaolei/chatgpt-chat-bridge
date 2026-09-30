# ChatGPT / Ego single-image adapter — offline implementation, live gate closed

## Delivery status and fixed dependencies

This is #78, task `CBIMG-78-20260930-02`. It is not a retry, execution or completion
of `CBIMG-78-20260930-01`, which remains UNKNOWN. Initial R0 is
`9dc2e76d7713a45b952f0089f633947ff9049e0b` / PR83. The dependency is PR84's initial
shape at `b73d5bf1d5a19436ca9a329e11a9a72f2a361b8b`, followed by its **fixed handoff**
`7c764f2f2d53e939d162665aca9211da5c076778`. Those commits are adopted dependencies;
#78 does not edit their contract/schema/coordinator files. The sole ImageJob
schema and persistence API remain [the #77 contract](image-capability.md).

The executable delivery consists of a tested single-image execution core, native
single-action primitives, and a local CLI/runtime facade for the existing
ImageJob API. **There is no installed/live image execution path in this PR.**
`image start` and `image reconcile` return `BLOCKED` before browser or coordinator
access. `image probe` reports `nativeReady: false`; a successful probe command is
not a positive generation capability result. Public callers cannot enable the
missing native ports by an environment flag or an `authorized: true` field.

Remaining integration gates are material, not cosmetic:

1. A durable cross-job same-session admission guard, including another job's
   UNKNOWN attempt, must be reviewed in A and used within the existing account
   UI lane. A's per-job expected-revision CAS is not this cross-job exclusion.
   The fixed 7c764f2 snapshot does not provide that guard. B adds no second store.
2. A native image observer must prove route/ownership, stable new user/assistant
   IDs, parent relationship, settled image-tool state and generated-asset origin.
   Existing text `state()` and arbitrary image/alt text are insufficient. No
   production selector/provenance has been invented from synthetic test data.
3. C's fixed original-byte export/import, receiving permissions and applicable
   service authorization must be wired and independently tested. A candidate
   handoff cannot be downloaded, verified, adopted or published by itself.

The PR is a **partial, BLOCKED implementation delivery**, not #78 end-to-end
acceptance. No true original means `EXPORT_UNAVAILABLE`, not successful delivery.

## What is implemented

| Surface | Actual behavior |
| --- | --- |
| `chatgpt-ego.js` | Single-image request restriction, stable attempt prompt, exact source staging, baseline/new-turn classifier, single-shot executor and one-round reconciliation |
| `chatgpt-ego.ui.js` | Existing Page primitives: one fill, one native Send click, existing #58 upload helper plus native readiness. All require host-owned observation/ownership/model ports |
| `chatgpt-ego.cli.js` | Local probe/validate and authorized submit/inspect/result/cancel through #77; live start/reconcile explicitly closed |
| `runtime.image` | The same local commands with prompt-bearing JSON on stdin, never command-line arguments |
| `bin/chat-bridge` | An early local-only `image` branch; no bypass into the existing text send path |
| `scripts/install.sh` | Packages the capability directory with ESM metadata; the script was not installed/run for this delivery |

`src/main.js`, text send/ask, #58 input behavior, account selection, existing UI
pacing, shared Space management, queue callbacks and owner ACK are unchanged.
The text sender's fallback/retrigger behavior is not used by this adapter.

Single-source `edit` accepts only an authorized exact source/base match.
`refine` additionally requires a saved verified Bridge parent and the original
source turn/route. Multi-reference, reference-guided generate, mask, multi-output
and temporary/unknown conversation modes fail closed. An aspect ratio is a
request in the deterministic prompt, not proof of output pixels or cropping.
No strict unchanged-pixel/region claim is made.

## Local CLI and runtime

Commands consume a single JSON object on stdin. The examples below are shapes,
not operational grants. No grant creation command is added to the worker CLI.
A host owner must separately approve the normalized request via #77.

```sh
chat-bridge image probe </dev/null
chat-bridge image validate < request-envelope.json
chat-bridge image submit < request-and-grant.json
chat-bridge image inspect < job-key.json
chat-bridge image result < job-key.json
chat-bridge image cancel < cancel-envelope.json
```

`validate` accepts `{ "request": <ImageJob request> }` and returns a digest only.
`submit` accepts `{ "request": <request>, "grantId": <saved grant id> }` and
**only persists the job**, without uploading, changing models or sending.
`inspect` / `result` accept the #77 Key:
`{grantId, callerRef, jobId, scope}`. `inspect` is an authorized private read and
includes the full request; never paste its raw output into public GitHub logs.
`cancel` accepts `{key, event:{eventId, expectedRevision, reason?}}` and returns
`CANCELLED` before a possible send or `CANCEL_REQUESTED` afterwards. It does not
claim to stop an already-running remote generation.

```js
import {createRuntime} from './src/runtime.js';
const bridge = createRuntime();
const probe = await bridge.image.probe(); // probe.data.nativeReady === false
const saved = await bridge.image.submit({request, grantId}); // authorized persistence only
const result = await bridge.image.result(key);
const closed = await bridge.image.start({request, grantId}); // explicit PRE_SEND/BLOCKED
```

The existing `probe({capability: 'imageParts'})` remains a vision-input check,
not an image-generation or original-export capability. No paid API fallback,
new dispatch operation, task identity, scheduler or account pool is created.

## Internal host-owned ports, not a second durable API

`createImageExecutionAdapter({api, withUi, assertSessionAdmission, evidenceSink,
resolveSource, now})` is the integration seam. These are trusted host functions,
not flags in an external request. `api` must be #77's `createImageJobAPI`.

`withUi(route, callback)` must acquire the existing identity-scoped pacing/UI
lane and verify live ownership before the callback. It releases the lane after
one bounded round, including on exception. The adapter never waits in a loop for
generation. A caller may later request one reconciliation round, subject to the
existing pace. No hidden background polling is created. `assertSessionAdmission`
must recheck the current durable owner/grant/cancellation and exclude other
active/UNKNOWN jobs on the exact session before reservation/upload/send. It is
required, not replaced by a JavaScript Map, a temporary lock file or a caller's
boolean. These ports are mocked explicitly in offline tests; no production
cross-job implementation is claimed by those mocks.

`evidenceSink` must persist the bounded, prompt-free evidence under the authorized
artifact store and return a portable reference. The core does not invent an
`artifact:` receipt from an unstored hash. Native observation/evidence storage
failures after a possible send leave local delivery uncertain and never trigger
another generation. The existing durable state must be read on reconciliation.

`resolveSource` must independently authenticate object/tenant/revision rights
and return the authorized immutable source record with its local materialization.
The core compares artifactRef, SHA-256, revisionId, parent job/output IDs and, for
refine, route/source turn. It opens a regular non-symlink file, rejects symlinked
ancestors, reads at most 10 MiB plus one sentinel byte, validates content hash
and PNG/JPEG/WebP magic, then stages exact bytes under a private 0700 directory
and 0600 file. The upload no longer races changes to the original path. Staging
is cleaned in `finally`; cleanup failure is explicit and preserves send-attempt
classification. Abrupt host/process termination may leave that private staging
file; existing host retention/cleanup policy must address it before production.
This is input magic/hash checking, not C's independent original decode verifier.

## Effect, recovery and observation sequence

The request must first pass #77's independently issued grant. The core checks
live route/ownership, normal conversation, empty composer/attachments and actual
model/effort verification. `Latest` alone does not prove an image model. Only
matching verified selection permits a baseline.

The core calls #77 `beginAttempt` with stable baseline user/assistant IDs,
model selection, eventId, expectedRevision and attemptId. SQLite records
`SUBMISSION_UNKNOWN` **before** any possible upload/send. Only a fresh
`effectAdmission: NEWLY_RESERVED` is a send permit; replayed/lost begin responses
are reconcile-only. No new attempt ID is used to escape UNKNOWN.

After accepted attachment readiness, it fills the deterministic attempt-bound
prompt, rechecks draft, route/ownership, baseline, cancellation/revision, durable
admission and deadline, then issues exactly one native Send click. A click
exception can have late effects: there is no fallback Enter, regeneration,
new conversation, alternate account or automatic retry. A live failure proven
before triggering Send may record `FAILED_PRE_SEND`; an interrupted process
or lost begin response cannot supply that proof. Existing drafts/attachments
are not silently cleared during recovery.

New outputs require exactly one new matching user prompt hash, one unambiguous
new assistant turn with the correct parent, and native generated-output evidence
bound to that assistant. The classifier rejects historical turns, input refs,
source hashes, thumbnails, placeholders, loading/zero-size images, ordinary
embedded images, alt-text-only claims and assistant prose such as “generated”.
Native provenance is intentionally **not** inferred by the primitives module.
Unknown/missing/virtualized history and ambiguous IDs remain unverified.

`GENERATING`, candidate `GENERATED`, original `EXPORTED` and
`TECHNICALLY_VALIDATED` remain different states. A finished text-only/refused
turn does not create an image. Missing output while still unsettled is not a
proof of failure-to-send. Candidate IDs are stable, attempt/turn-bound hashes;
no signed source URL, credential, raw private prompt or local output path is
published in the handoff. C still needs an authorized original acquisition path.
Cancellation/budget-late evidence is passed to A's quarantine rules and never
returned as an adopted handoff. Reconciliation reads the original route only.

## SDK, product and authorization evidence reviewed 2026-09-30

Existing Bridge input code is MIT repository code; no third-party implementation
or new dependency was vendored. Official Ego source was read at commit
`dca7003349c5f7132189ba00547cbbd7ff8e597e` (CitroLabs MIT license). Relevant sources:

- [Ego skill at fixed commit](https://github.com/citrolabs/ego-lite/blob/dca7003349c5f7132189ba00547cbbd7ff8e597e/skills/ego-browser/SKILL.md)
- [Ego API reference at fixed commit](https://github.com/citrolabs/ego-lite/blob/dca7003349c5f7132189ba00547cbbd7ff8e597e/skills/ego-browser/references/api.md)
- [Ego license at fixed commit](https://github.com/citrolabs/ego-lite/blob/dca7003349c5f7132189ba00547cbbd7ff8e597e/LICENSE)
- [Official ChatGPT Images help](https://help.openai.com/en/articles/11084440-images-in-chatgpt)
- [OpenAI consumer Terms of Use](https://openai.com/policies/terms-of-use/)

Ego documents native `page.setInputFiles`, file chooser `setFiles`, and arming
`page.waitForEvent('download')` before the action. `download.saveAs(absolutePath)`
waits for completion; round-local download objects/files must be saved in that
same SDK round. This is preferable to inventing a global CDP download directory.
`page.fetch(url,{saveAs})` can preserve binary response bytes with the current
page's browser/CORS semantics. It does not prove that a displayed URL is an
original, authorized to retrieve, unexpired, or safe for an external destination.
None of these APIs was used to acquire a real output in this task.

Official ChatGPT help documents creating/uploading/editing images and a Save
control. It also cautions that region edits may extend beyond the selected area.
Those product facts do not establish an automation contract for this account,
layout, subscription or the moving Latest model label. The consumer terms
include restrictions on automated/programmatic extraction of data or Output and
circumventing limits/protective measures. The account's applicable agreement and
specific automation authorization have not been established here; ownership of
an Output and the presence of a browser SDK are not sufficient evidence.

Consequently automatic original extraction is not enabled. The conservative
boundary is **ASSISTED official Save**, followed by C's authorized import and
original-byte verification, or `EXPORT_UNAVAILABLE`. No private endpoint,
credential copying, CORS bypass, quota workaround, substitute paid API or
thumbnail-as-original fallback is implemented. This is an explicit integration
limit, not a claim that all SDK-supported actions are permitted or prohibited
under every possible agreement.

## Model evidence and verification limits

Requested resource: **Latest + Pro**, not Extra High. The current worker's
read-only UI observation at `2026-09-30T06:31:40.548Z` was
`{model:null, effort:"Pro", raw:"Pro"}` from the folded control. The distinct
persisted pre-send record at `2026-09-30T06:29:03.415Z` said Latest + Pro for
operation `895a9308-2ac6-4b00-9e10-0100fc01efe9`. They are not the same observation;
no exact underlying model identifier or image capability is inferred.

Tests use synthetic snapshots, a fake native Page, temporary source bytes and
temporary SQLite under #77's real coordinator/reducer. They test unknown/lost
acknowledgements and new-turn correlation but do not constitute a live canary.
The Computer non-login PATH initially lacked Node for subprocesses; running the
same tests through the existing standard login shell resolved that test setup
issue without changing machine configuration or installing tools.

Run `npm run check && npm test` in the source worktree. Fixed-head pass counts
and log hashes belong in PR/issue evidence and `execution-handoff.json`.
NOT_RUN: live native image observation, real generation/material externalization,
C original export/import canary, true cross-job UI concurrency, forced process
termination during a real upload, independent non-author review, HZ receiving
and adoption/publishing, runtime installation/rollback, production and paid APIs.

The worker separately publishes GitHub evidence and its own queue result. Only
the persisted controller may accept/ACK, merge, install or declare #78 complete.
