# ChatGPT / Ego image adapter

## Current source behavior

The CLI now constructs the executor in `main.js`. Live `start`, `reconcile`,
`characterize`, `assist-observe` and `download-original` authenticate their
persisted exact route before entering the existing account cooldown, pacing and
Ego runner. One invocation is one bounded UI round; generation waiting happens
between invocations, outside the UI lease. Local `probe`, `validate`, `submit`,
`inspect`, `result`, `cancel` and `import-original` never start Ego.

A's coordinator remains the only ImageJob/state authority. B uses
`sessionOccupancy(session, key?)` for durable exclusion and `authorizeIO(key)`
before and after awaited sensitive I/O. The latter returns the actual minimum
grant/attempt/deadline expiry. Generic send/ask/stream/model/retry/Stop/recover,
watchdog recovery, reclaim/prune/detach, lifecycle removal and Space convergence
respect unresolved image reservations. Cancel, elapsed time or top-level task
completion alone does not prove that the remote image tool stopped.

`image probe` still reports `nativeReady:false`. The public DOM observer records
actual message IDs, current composer/attachments/controls, and a bounded public
widget inventory. It does **not** infer native parent IDs, asset provenance or
settlement from ordered messages, previews, alt text, text self-report, private
React/application stores or private output URLs. Missing native provenance
remains `UNKNOWN`; it is not `FAILED`, resend permission or generated success.

Native start uses exactly one documented Send click after the persisted baseline
and reservation. It does not use the ordinary text sender's Enter/retrigger
fallback. Inputs use the existing #58 upload helper after current source rights,
immutable bytes/hash/revision checks and private staging. Revision IDs come from
the parent's `image result` `outputRevisions`, verified by current coordinator
source authority and the original record. Edit/refine require the
exact authorized source; refine also requires its saved same-conversation parent.
After the final awaited DOM inspection, Send rechecks its exact attempt,
unchanged baseline IDs, actual URL, expected prompt and accepted input count,
then sole reservation/current authority before the click. Upload performs its
corresponding current admission after the awaited file-control lookup and before
`setInputFiles`. Changed human draft/route/input/baseline or revoked authority
never reaches those effects; an already reserved ambiguous attempt stays UNKNOWN.
Native execution supports one output and one source. Exactly two inputs are
supported for ASSISTED edit only: ordered `source`, then `reference`, count 1,
mask null. Both existing Bridge originals require current ordinary source
authority, exact technical revisions and complete byte/record verification.
The `multiReference` feature needs model/route-bound ASSISTED evidence; a NATIVE
multi-reference claim is explicitly BLOCKED before Ego bootstrap, reservation
or effects. Masks, regions, third inputs, multi-reference refine, batch outputs
and temporary/unknown conversations remain explicitly unsupported. This
implemented manual path is not native upload or regional-edit evidence.

The C exporter performs complete decode, MIME/magic/hash/dimension/count checks,
immutable storage and portable manifest creation. B then calls A's export
transition. Producer exports report `NOT_RECEIVED`; they do not create a consumer
receipt or imply approval/publication. The runtime requires an explicitly
configured, maintained absolute `CHAT_BRIDGE_IMAGE_DECODER` executable, using C's
existing ImageMagick decoder. No decoder, runtime or service is installed here.

## Control-only bootstrap and exact ownership

Use dedicated target **T**, separate from the currently running developer or
executor Chat. The original owner dispatches controlling operation **O** to T:

```sh
chat-bridge queue submit --request-id IMAGE-READY-1 \
  --caller-ref "codex:$CODEX_THREAD_ID" --project "VERIFIED PROJECT" \
  --session-ref VERIFIED_TARGET_T --task IMAGE-CONTROL-1 \
  --message "Dedicated image target only. Reply READY after checking current resources and idle composer. This is readiness, not terminal completion: do not submit queue result yet. The owner will persist an image grant/job/baseline before an image prompt or input. Final result follows image settlement and evidence review."
chat-bridge queue status OPERATION_O
chat-bridge read VERIFIED_TARGET_T --project "VERIFIED PROJECT" --account VERIFIED_ACCOUNT
```

Require O to be durably `SENT`, T to be idle, and the actual model/effort verified.
Readiness is not `queue result`. Default watchdog may keep T's task in
`AWAITING_DURABLE_UPDATE`; no extra readiness state or scheduler is required.
Issue the exact A grant with the original owner:

```sh
chat-bridge queue image-authorize < owner-grant.json
chat-bridge image submit < image-submit.json
chat-bridge image start < image-start.json > image-start-result.json
```

`owner-grant.json` contains `{issuerRef,grant}` according to A's contract;
`image-submit.json` contains `{grantId,request}`. `image-start.json` adds the exact
`key`, original local `operatorRef`, and stable `attemptId`/`eventId`. Neither
`authorized:true`, a digest, a grant name nor ambient account/Space hints grants
permission. Installed copies remain separate from this checkout until explicitly
installed and verified.

Ego's Node process does not inherit the local Codex caller environment. The CLI
therefore captures a separate invocation context after actual grant access and
immutable original owner/thread/host verification. It binds action, exact key,
request digest and route. The trusted CLI script carries this context into Ego;
only scoped coordinator subprocesses receive the genuine captured environment.
The shared Node process environment is never changed. External request fields
cannot create that context, and captured remote/tunnel origins cannot use the
ASSISTED local-owner operator path.

The same validated preparation captures the actual CLI Node executable and only
the explicit `CHAT_BRIDGE_IMAGE_DECODER` path. Ego does not inherit either the
CLI's PATH or its decoder setting. Scoped image coordinator children prepend
that Node directory to Ego's PATH; the artifact factory receives the decoder
path directly. Request payload paths cannot override these captured settings.
Missing decoder configuration stays an explicit failure before byte acceptance.

For a reviewed source-only canary, invoke this checkout's `bin/chat-bridge`
directly and set `CHAT_BRIDGE_IMAGE_DECODER=/opt/homebrew/bin/magick` to the
existing maintained executable. The CLI resolves its adjacent source modules;
no install, restart or overriding the installed CLI is required.

## Executable ASSISTED official-original path

When native provenance is unavailable, the owner may issue explicit model/route
bound `ASSISTED` operation and export capabilities with actual official-UI
handoff evidence. `start` then selects/verifies resources, persists the baseline
and the sole A reservation, and returns `MANUAL_SEND_REQUIRED`. It does not fill,
upload, Send, Retry or Stop. Its result contains:

- The exact `prompt`, `key`, `route`, `attemptId`, `requestDigest` and model evidence.
- `originalPath` and `originalRef` for the private attempt-bound official Save inbox.
- For edit/refine, `manualInput` resolved from the currently authorized verified
  Bridge artifact, including its real byte hash, revision, source turn and MIME.
- For two-input edit, complete ordered `manualInputs` contains both independently
  resolved originals. `manualInput` remains the first-source alias; it cannot
  attest the second input. Per-file and combined ceilings are **10 MiB
  (10,485,760 bytes)**. The combined limit shares the existing single-input byte
  envelope rather than multiplying it. Sizes come from fresh ordinary authority's
  verified output records, never caller metadata; the normal host resolver
  independently verifies those exact original bytes. Both are checked before
  reservation and freshly resolved again before returning the manual handoff.

The exact host/controller owner reviews that result, uses the dedicated T, and
performs the one manual prompt/input submission. A lost/ambiguous Send stays
UNKNOWN; do not submit the prompt again. Wait outside Bridge's UI lease. When T
is idle and its actual output is complete, use ChatGPT's official Save action to
save the original to **the returned `originalPath`**. Do not use a thumbnail,
private URL, copied cookie, arbitrary local file or reference image.
The manual operator waits for the preceding account UI lease to end and the
normal pacing delay, preserves the existing ownership/user-pause gates, and
does not call generic `send`, `retry` or `stop` to bypass the reservation. A
scripted operator action, if separately authorized, needs its own reviewed
bounded invocation under the existing lease; ASSISTED start has no automatic
Send or original-extraction action.

The original local owner supplies an explicit official-UI attestation:

```json
{
  "key": {"grantId":"EXACT_GRANT","callerRef":"EXACT_TARGET","jobId":"EXACT_JOB","scope":{"tenantId":"EXACT_TENANT","namespace":"EXACT_NAMESPACE","purpose":"EXACT_PURPOSE","workgroupId":null}},
  "operatorRef":"codex:ACTUAL_ORIGINAL_OWNER_THREAD_ID",
  "path":"EXACT_RETURNED_ORIGINAL_PATH",
  "originalRef":"EXACT_RETURNED_ORIGINAL_REF",
  "sha256":"ACTUAL_OFFICIAL_SAVED_FILE_SHA256",
  "mimeType":"image/png",
  "officialSave":{
    "confirmed":true,"relationshipConfirmed":true,
    "requestDigest":"EXACT_REQUEST_DIGEST","attemptId":"EXACT_ATTEMPT",
    "route":{"project":"EXACT_PROJECT","projectId":"EXACT_PROJECT_ID","accountAlias":"EXACT_ALIAS","accountId":"EXACT_VERIFIED_ACCOUNT_ID","sessionRef":"EXACT_TARGET","conversationId":"EXACT_CONVERSATION_ID"},
    "promptHash":"SHA256_OF_WHITESPACE_NORMALIZED_RETURNED_PROMPT",
    "userMessageId":"OBSERVED_NEW_USER_ID","parentUserId":"SAME_OBSERVED_USER_ID",
    "turnId":"OBSERVED_ASSISTANT_ID"
  }
}
```

```sh
chat-bridge image assist-observe < assisted-observation.json > assisted-observation-result.json
# Use exactly the importPayload returned above:
chat-bridge image import-original < original-import.json > original-export-result.json
chat-bridge image result < exact-key.json
```

`assist-observe` rechecks the immutable controlling operation's original local
Codex owner contract and current grant. Tunnel-origin/external claims cannot
self-authorize this operator path. It reads the actual target through normal Ego
route/ownership gates, matches one new exact prompt/user turn, requires one
explicitly selected assistant turn with no intervening user/generation, and
fully decodes/hashes the saved official original. It persists the owner-declared
relationship as **ASSISTED**, including prompt/user/assistant/original hash and
source lineage; it does not represent the declaration as native parent/asset
proof. The actual bytes must differ from source inputs. A then records the known
settled candidate and releases its unresolved-generation exclusion.

For edit/refine, `officialSave.input` must contain `{confirmed:true,source,
sourceTurnId}`. `source` is the exact granted input object and `sourceTurnId`
comes from the returned `manualInput`. The authorized owner thereby declares
which original was actually uploaded; the adapter independently re-resolves and
fully verifies its current bytes and binding. This remains ASSISTED input
evidence, not native upload provenance.

For two-input edit, `officialSave.inputs` must be an array of exactly two
`{confirmed:true,source,sourceTurnId}` entries in the request order. Each `source`
is the complete corresponding granted object, including its role and immutable
revision; each turn comes from the corresponding `manualInputs` entry. A single
`officialSave.input`, missing item, changed role/source/turn or reordered array
is rejected. The original owner and actual user/assistant/prompt/original checks
remain mandatory. `assist-observe` freshly resolves both originals, checks the
same verified size budget, and stores both ordered owner attestations. Exported
`sourceHashes` and technical revision inputs retain the full sequence; the first
source remains the base parent. This declares the owner's actual manual upload
order and role assignment; it does not prove native attachment identity, model
consumption of those roles or regional/unchanged-pixel guarantees. Those still
need separately authorized real UI and official-original acceptance evidence.

`import-original` accepts only that private attempt-bound inbox/ref and the
current original owner. It rechecks exact candidate/attempt/turn/hash/MIME and
export capability, then runs C's exporter and A's export transition. Missing
originals can be retrieved/imported again under the same identity; this never
regenerates the image. Corrupt/conflicting immutable artifacts are not overwritten.
Actual bytes and manifests are stored under the host-private state directory;
opaque artifact refs are portable locators, not public paths or credentials.

For the bounded edit, issue a new grant/job on T after generation settled. Bind
its source/base exactly to the verified exported output's artifactRef/hash,
canonical technical revision from `outputRevisions`, parent job/output, and original source turn.
Repeat the same reservation/manual Send/official Save/ASSISTED observation/import
sequence. Do not reuse readiness O as a terminal result before both required jobs
and consumer evidence have been reviewed.

## Native characterization and original download

```sh
chat-bridge image characterize < exact-key-wrapper.json
chat-bridge image reconcile < exact-key-wrapper.json
chat-bridge image download-original < exact-key-and-output.json
```

These wrappers contain `{key}` and, for download, `outputId`. Characterization
persists route-bound public DOM facts without user/assistant prose, signed image
URLs or credentials. A native canary must show the new user/assistant IDs,
explicit parent/tool event binding, completed generated asset identity, accepted
edit source, and the official Save control bound to that exact output. If the
public UI lacks those authority facts, native readiness remains false and a
supported SDK surface is needed; chronology alone is insufficient.

The guarded download path arms `page.waitForEvent('download')` before one
observer-verified official Save click, saves actual bytes with `download.saveAs`
within that SDK round, checks current authority around I/O, then invokes C. The
current public observer does not yet establish that native asset/control proof,
so it returns typed `EXPORT_UNAVAILABLE` with the executable ASSISTED path.
No URL/selector supplied by an external image request enters the download action.

## Consumer receiving and final result

C's existing `createImageConsumerReceiver` must run under **receiver-owned**
current authorization, store, maintained decoder and authenticated
`resolveArtifact` transport. Its `receive({jobId,requestDigest,output,consumerRef,
authorizationContext})` resolves actual producer bytes, independently validates
and durably stores them, then produces a receiver receipt. A Mac path or producer
manifest is not receiving evidence. This branch deliberately does not enable an
unauthenticated HZ gateway or create a consumer/service/account pool.

After the real receiver receipt and technical/source evidence are reviewed, the
external executor reports the controlling task's durable final result. The
original owning controller receives and ACKs it:

```sh
chat-bridge queue result --task IMAGE-CONTROL-1 --status COMPLETE \
  --summary "Exact generated/edit jobs, official originals, manifests and actual receiver receipt" --github DURABLE_EVIDENCE_URL
chat-bridge queue receive --task IMAGE-CONTROL-1 --caller-ref "codex:$CODEX_THREAD_ID" --wait-seconds 50
chat-bridge queue ack --task IMAGE-CONTROL-1 --result-version EXACT_VERSION \
  --caller-ref "codex:$CODEX_THREAD_ID" --status ACCEPTED --message "Reviewed exact evidence"
```

Source checks, producer technical validation, receiver receipt, owner acceptance,
installation and business adoption/publication remain distinct. This development
used synthetic non-sensitive bytes and isolated SQLite/mock Ego surfaces only;
real image generation/edit/download/consumer receipt and installation are NOT_RUN.
The old frontend #78 UNKNOWN operations are unchanged and are never replayed or
accepted by this isolated local branch.
