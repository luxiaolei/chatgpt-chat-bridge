# Existing ordinary original delivery

`OUTPUT_DELIVERY` is a receive-only immutable row in the existing `image_grants`
table. The authenticated original host owner authorizes one actual, saved,
ordinary VERIFIED output. Generate/refine/edit/export jobs with count 1 may
deliver their existing controlled original. Candidate IDs, UNVERIFIED outputs
and lateOutputs cannot obtain this authority. OUTPUT_RECOVERY keeps its existing
ASSISTED generation/late-output restrictions.

```js
// chat-bridge image delivery authorize (JSON stdin)
{issuerRef,grant:{kind:'OUTPUT_DELIVERY',grantId,controllerOperationId,
  controllerTaskId,key:originalJobKey,requestDigest,route,
  output:{jobId,outputId,revisionId,artifactRef,sha256},
  consumerRef,destinationRef,maxByteLength,expiresAt}}
// image delivery admission | receive | receipt
{key:originalJobKey,deliveryGrantId}
```

The coordinator authenticates the actual operation owner/scope/route, loads the
ordinary output, and recomputes its immutable revision. Expiry is at most one
hour from issuance and bytes are bounded to at most 32 MiB. Repeating an identical
grant is idempotent; changing its payload conflicts. `image-revoke` also revokes
delivery grants. A grant ID is a lookup key, never a bearer credential. Receipt
v1 omits destination: all saved delivery/recovery authorities for the same
original key/job/digest/consumer must name one destination. New delivery issuance
rejects a changed destination; historical ambiguity is reported explicitly and
never resolved by taking the first match.

New delivery uses a conservative retention ceiling: the authoritative SQLite
`image_jobs.created_at` plus the original request's `authorizedOutput.retentionHours`
is the latest allowed delivery expiry. Job creation precedes export, so this
cannot extend the original retention allowance. Missing, malformed, future or unzoned
creation timestamps fail explicitly. This policy bounds the new permission;
it does not redefine legacy retention cleanup. No deletion or cleanup scheduler
is introduced. The original target, request/digest, grant/deadlines, timestamps
and original-record `verified.validation.checkedAt` remain unchanged. Receipt
`receivedAt` and a fresh delivery grant never reset that origin.

Admission rechecks delivery expiry/revocation, original owner/controller/route,
existing management and user controls, cooldown and cancellation. An expired
generation grant does not invalidate ownership of an existing ordinary original:
fresh delivery may copy its actual bytes within the retention ceiling. Delivery
cannot submit, beginAttempt, Send, upload, save/export a new original or authorize
source externalization. Ordinary authorizeIO and generation entry points reject
delivery authority. UNKNOWN reservations and generation-call budgets remain
unchanged; no post-Send retry or remote settlement proof is added.

`receive` uses the existing receiver and controlled stores. It authenticates the
saved producer record/ref/hash/attempt/turn, fully decodes actual bytes, and
persists a separate local consumer copy and immutable receipt. Authorization is
rechecked across awaited I/O. It returns RECEIVED and businessApproval
NOT_EVALUATED. This proves a local controlled consumer handoff, not remote
consumer deployment, channel publication or controller/HZ business acceptance.

`receipt` and batch inspect/decision use one authenticated historical reader.
It derives the private receiver directory from the saved destination and trusted
host state directory, validates exact receipt binding and its saved authorization
window, and checks the current copy hash/length. Caller output/receipt/path JSON
is rejected. Expiry/revocation/pause do not erase a historical receipt; they still
block new receive effects. Receipt history and copyHealth are separate: MISSING
or CORRUPT copies are reported without fetching or repairing them. Missing stores
are never created by queries, and queries never start Ego.

Batch ordinary receipts count toward receivedCount and AWAIT_CONTROLLER_ACK;
late receipts from existing recovery authority are separately exposed as
lateReceiptIds/lateDeliveryStatus/lateReceivedCount. They do not increase ordinary
validatedCount/receivedCount, change the original BLOCKED job, move lateOutputs
or adopt them. Existing verified late originals are reviewed rather than exported
again. A fresh purpose-bound delivery admission can recommend RECEIVE_EXISTING
after generation authority expires; it cannot authorize a new generation.

The targeted offline acceptance is `tests/image-output-delivery.test.mjs`; real
host/consumer/batch evidence and business acceptance require separate exercise.
