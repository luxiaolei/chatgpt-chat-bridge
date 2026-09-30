# ChatGPT / Ego single-image adapter

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
immutable bytes/hash/revision checks and private staging. Edit/refine require the
exact authorized source; refine also requires its saved same-conversation parent.
Only one image and one source are supported. Masks, multiple references, batch
outputs and temporary/unknown conversations remain explicitly unsupported.

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

The exact host/controller owner reviews that result, uses the dedicated T, and
performs the one manual prompt/input submission. A lost/ambiguous Send stays
UNKNOWN; do not submit the prompt again. Wait outside Bridge's UI lease. When T
is idle and its actual output is complete, use ChatGPT's official Save action to
save the original to **the returned `originalPath`**. Do not use a thumbnail,
private URL, copied cookie, arbitrary local file or reference image.

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

`import-original` accepts only that private attempt-bound inbox/ref and the
current original owner. It rechecks exact candidate/attempt/turn/hash/MIME and
export capability, then runs C's exporter and A's export transition. Missing
originals can be retrieved/imported again under the same identity; this never
regenerates the image. Corrupt/conflicting immutable artifacts are not overwritten.
Actual bytes and manifests are stored under the host-private state directory;
opaque artifact refs are portable locators, not public paths or credentials.

For the bounded edit, issue a new grant/job on T after generation settled. Bind
its source/base exactly to the verified exported output's artifactRef/hash,
owner-assigned immutable revision, parent job/output, and original source turn.
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
