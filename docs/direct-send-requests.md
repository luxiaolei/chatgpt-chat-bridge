# Opt-in direct-send request evidence

External callers may append `--request-id ID --request-file ABSOLUTE_JSON
--expected-hash SHA256` to the original `send` command. Only `request-file` opts
in; ordinary direct sends, stream request IDs and queue attempts keep their
existing contracts. No coordinator operation or queue claim is manufactured.

The caller commits its own claim first and writes this private, owner-readable
JSON file. SHA256 always means the original UTF-8 bytes, including newlines.

```json
{
  "format": "chat-bridge-direct-request-v1",
  "requestId": "sha256 of compact JSON array [operationId, claimToken]",
  "operationId": "original caller operation",
  "claimToken": "original committed caller claim",
  "owner": {"agentId": "original agent", "principal": "original principal"},
  "jobId": "original job",
  "generation": 1,
  "attempt": 1,
  "contextSha256": "original context SHA256",
  "project": "exact registry project name",
  "account": "exact verified account alias",
  "accountId": "sha256 of identity: followed by verified login identity",
  "sessionRef": "persistent conversation UUID",
  "targetUrl": "https://chatgpt.com/g/g-p-PROJECT_ID/c/CONVERSATION_UUID",
  "callerRef": "original --caller-ref or null",
  "taskId": "original --task or null",
  "messageSha256": "SHA256 of original full CLI message",
  "requestedModel": "original explicit --model or null",
  "requestedEffort": "original explicit --effort or null",
  "deadlineAt": 1790000000000,
  "route": {
    "projectId": "canonical lowercase g-p- plus 32 hex digits",
    "profileId": "verified registry Profile",
    "identityHash": "sha256 of verified login identity"
  }
}
```

`requestId` is lowercase 64 hex. `generation` and `attempt` are positive safe
integers; `deadlineAt` is a safe integer Unix timestamp in milliseconds. A caller
such as QuantCompany bounds it by the fresh owner/turn expiry and the committed
claim start plus its existing transport timeout. Bridge does not extend it.
Owner, job and claim fields are declared provenance, not authentication or a new
permission. CLI body, task, caller, requested model/effort, target, account and
registry route must match before any UI call.
An opt-in request is a background send: it preserves user-control pause flags
and uses the existing `pauseOnUserControl` gate. It does not resume a paused
Space. Legacy foreground sends keep their existing explicit-resume behavior.

Bridge copies the exact request bytes to private
`STATE_DIR/direct-requests/ID/manifest.json`, then syncs exclusive
`00-REQUEST_INTENT.json` before UI access. An existing ID directory, including a
partial or expired attempt, rejects a second invocation as `SEND_ATTEMPTED`.
Callers retain their own operation-level UNKNOWN fence across claims; changing
the claim is not permission to replay an uncertain send.

The existing phase writer produces immutable, synced files with this envelope:
`{format, requestId, operationId, claimToken, manifestSha256, phase, recordedAt,
data}`. There is no queue `claimOrdinal`. Allocation phases also keep the existing
coordinator allocation receipts and pool fences, using the same request ID.

- `30-INPUT_VERIFIED.json`: `data.nativeWitness` is the original native witness
  receipt; `data.nativeBody` is its complete serialized body.
- `40-SEND_INTENT.json`: the pre-trigger uncertainty barrier. It proves neither
  the physical click nor delivery, and never supplies a user-message ID.
- `50-SEND_RETURNED.json`: the official Send call returned. Its
  `data.observationWindow` contains `startedAt`, `deadlineAt` (Unix ms) and
  `timeoutMs:8000`, reusing the sender's existing eight-second observation budget.
  It is also retained in subsequent `nativeWitness.postSend.observationWindow`.
- `60-OBSERVED-NNN.json`: `data.snapshot` retains observed user IDs and the full
  native `lastUserSource` with its conversation/message IDs and text.
  A `MODEL_SELECTED` observation retains the existing dispatch model-selection
  result separately from the original requested model/effort in the manifest.
- `70-DELIVERY_CONFIRMED.json`: only after the existing native delivery predicate
  passes. `data` retains the original delivery fields, `nativeBody`, `before` and
  `snapshot`. `nativeWitness` retains the actual request/body/getter/serializer/
  account hashes, witness timestamp and native message ID, plus the existing
  `POST_SEND_CONFIRMATION` sample with `missingCondition:null`.
- `90-ERROR.json`: the sender's actual `deliveryStage` and original native
  `postSend` witness when available, plus its native body and before/latest
  snapshots. Missing evidence remains missing. Errors before entering the sender
  retain only their actual code/stage.
- `75-SCRIPT_FINISHED.json`: local command success and whether Send was attempted.
  This is not remote execution settlement or business acceptance.

Success/error output includes a `directRequest` locator when initialization
completed: `{format, requestId, operationId, claimToken, requestFile, directory,
manifestPath, manifestSha256}`. A caller must retain its own original request
ID/path/SHA independently of stdout. Empty stdout after timeout can still locate
the same ID directory; it never establishes PRE_SEND or successful delivery.

Deadline, removal/change of the original request bytes, or existence of the
adjacent `requestFile + ".revoked"` blocks subsequent action intents and is
checked synchronously again immediately before composer mutations and Send.
The caller may create its own private marker during client finalization. This
ends future pre-Send permission; it does not cancel an already-issued native
action or prove backend termination. Evidence from already-issued actions can
still be recorded after revocation/expiry. The checks and remote UI calls are
not atomic.

A strict reader must verify the original caller wire reference/claim, exact
manifest SHA and fields, phase request/claim/SHA bindings, and original transport
window before applying its existing native UID/source/body/account/time checks.
Late samples outside that window remain diagnostics. No stage is a native parent
capability, owner ACK, scientific result or replay authority. These private files
may contain complete instructions/source; do not publish them to GitHub.

For this opt-in contract, a sample may follow the caller's timeout if the original
Send intent preceded its deadline and the same claim's post-Send sample falls
within the synced `SEND_RETURNED` observation window. The getter witness precedes
Send (`30` then `40`); the post-Send `observedAt` falls after the window start and
at/before its deadline. The original native freshness and source predicates still
apply. In-flight UI calls may return later; samples outside this window produce
`DIRECT_OBSERVATION_OUTSIDE_WINDOW` and remain UNKNOWN. There is no additional
observation budget, re-observation, Send or backend-cancellation capability.
