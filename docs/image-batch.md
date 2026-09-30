# Image batch policy and local coordination (#81)

`src/capabilities/image/batch.js` groups 1–16 explicitly linked, existing
`count=1` ImageJobs. The module provides pure recommendations; the existing
coordinator persists fixed batch linkage and enforces budgets. Local batch
commands make no browser, generation, queue-send, consumer or controller action.
This is an offline increment; it does not complete #81 or enable native
multi-output generation. GitHub remains development state, Bridge holds
technical jobs and receipts, and the consumer/controller owns business acceptance.

## Local entry

```sh
chat-bridge image batch create < batch-create.json
chat-bridge image batch inspect < batch-query.json
chat-bridge image batch decision < batch-query.json
```

Create accepts only `{issuerRef,batch,keys}`. `batch` is the envelope below and
`keys` contains each existing job's exact `imageJobKey(request,grantId)`.
Every job/grant/digest must belong to that authenticated host-local owner and
one identical scope; the jobs must already exist. A job may belong to one
batch. Replaying the same envelope is idempotent; changed budget/linkage or
another owner's job is rejected. Create does not authorize generation.

Inspect/decision accept only `{batchId,issuerRef}` and use a single query-only
SQLite snapshot without creating a missing store or repairing projections.
Both authenticate historical ownership; decision also checks current I/O admission.
Expired/revoked rights remain holds while historical job/late evidence stays
visible to its authenticated owner. `revision` is the persisted batch budget
revision, and `budgetUsage` comes from persisted ImageJob attempts.

The loader reads actual controlled local receiver evidence through saved
OUTPUT_DELIVERY or existing OUTPUT_RECOVERY consumer/destination bindings.
Without a matching authority it reports RECEIVER_EVIDENCE_UNAVAILABLE; multiple
destinations report RECEIVER_DESTINATION_AMBIGUOUS. Ordinary receipts count as
AWAIT_CONTROLLER_ACK. Late receipts/counts remain separate and never promote
the original job or business status. `deliveries` exposes historical receipts
and current copy health without fetching or repairing bytes. It rejects
caller-provided receipts, admissions and jobs. See
[existing original delivery](image-output-delivery.md) for current receive rights,
the conservative original retention ceiling and local-only limits.

```js
const batch = normalizeImageBatch({
  batchId:'batch-1', createdAt:'2026-09-30T09:59:00Z',
  budget:{maxAttempts:27,maxItemAttempts:3,maxGenerationCalls:27,
    maxDurationMs:3600000,deadlineAt:'2026-09-30T11:00:00Z',allowPaidApi:false},
  items:[{itemId:'item-1',jobId:job.jobId,
    requestDigest:job.requestDigest,consumerRef:'receiver-1'}],
});
const decision = imageBatchDecision(batch, {jobs,receipts,admissions,at});
```

The caller must supply all three arrays from authoritative, authorized reads:
full `image-inspect` snapshots, actual receiver-owned Receipt records, and fresh
admission observations. An empty receiver read is `receipts:[]`; a producer
manifest or local output path is not a receipt. Receipt identities and bindings
are reused verbatim. A received item recommends `AWAIT_CONTROLLER_ACK` and
`businessApproval` remains `NOT_EVALUATED`; this module cannot manufacture ACKs.

Each admission observation wraps the existing `authorizeIO(key)` response with
the exact key used for that call and the job's request digest:

```js
{key:imageJobKey(job.request,job.grantId),requestDigest:job.requestDigest,
 allowed:true,expiresAt:proof.expiresAt,reason:null,quotaRemaining:null}
```

For a denied read, supply `allowed:false`, its exact reason, and a null expiry.
`quotaRemaining` is null unless a real current balance has been observed;
estimates must stay null. Known zero blocks a new generation, while retrieving
or receiving an existing original consumes no new generation call. Quota,
rate/cooldown, authentication, capability, manual control, project pause/drain
and local capacity retain distinct reason categories. Admission observations
are inputs, not bearer grants: passing objects to this module authenticates
nobody, and the actual I/O boundary must recheck rights and existing controls.

| Saved evidence | Recommendation |
| --- | --- |
| Existing job with no reserved attempt | `CONTINUE_EXISTING` |
| `SUBMISSION_UNKNOWN` | `RECONCILE_EXISTING`, same job and attempt |
| Known generation in progress | `OBSERVE_EXISTING` |
| Turn-bound candidate missing its original | `EXPORT_EXISTING`, exact missing output IDs |
| Original present but unverified | `VALIDATE_EXISTING` |
| Verified original without a receipt | `RECEIVE_EXISTING` |
| Actual `RECEIVED` receipt | `AWAIT_CONTROLLER_ACK` |
| All previous attempts proven `FAILED_PRE_SEND` | `RETRY_PRE_SEND`, same job, bounded next attempt |
| Post-send failure without positive settlement | `WAIT`, `REMOTE_SETTLEMENT_UNPROVEN` |

Pause, cancellation, expired rights or deadlines turn an I/O recommendation
into a hold and retain its `resumeAction`. Existing received evidence remains
available to its controller. Late output IDs are reported separately, never
counted as delivered or selected to replace good immutable outputs.

The envelope has a canonical `batchDigest`; changing fixed item/job/digest or
budget linkage while retaining that digest fails. Item associations use exact
job/request/attempt/turn/output identities, never array/DOM order. Seven valid
originals among nine items report `PARTIAL`, `validatedCount:7`,
`missingCount:2`. One collage fills only its own item. Repeated original byte
hashes are flagged and cannot establish independent images. Pixel duplicates
with different encoded bytes require the artifact verifier's own evidence;
this policy does not infer pixel equivalence.

Every saved attempt, including UNKNOWN and proven pre-send failures, counts
conservatively against batch attempts and possible generation calls. Export
jobs consume attempt slots but no generation slots. New attempt proposals
are allocated in declared item order within the remaining batch/item limits,
whole-batch elapsed/deadline limits and existing per-job limits. Proposed IDs
are deterministic. Repeating a decision changes nothing and refunds nothing.
`recommendationsOnly:true` and `reservationsPersisted:false` are explicit:
these decisions do **not** prove atomic or durable budget reservations.

The coordinator stores `image_batches` and `image_batch_items` in the existing
SQLite database. Job, request digest and item linkage are immutable. Attempt,
turn, output and late evidence remain in the original authoritative ImageJob;
their identities are not copied into a competing state machine.

Every linked job's ordinary `image-apply/beginAttempt` checks current whole-batch
and item totals, generation-call reservations, elapsed/deadline limits, existing
grant, controls and physical-session occupancy in the same `BEGIN IMMEDIATE`
transaction. It CAS-increments the batch revision and appends the original
UNKNOWN attempt atomically with the job's existing expected-revision CAS.
Invalid model, stale job revision or occupancy failure rolls back both.
Omitting batch metadata cannot bypass this guard. A raw coordinated apply may
also provide `expectedBatchRevision` to reject a stale batch decision; exact
event replay returns `RECONCILE_ONLY` and consumes no extra budget. No reservation
is refunded after UNKNOWN, failure, cancellation, revocation or expiry.

The pure recommendation still has `reservationsPersisted:false`: deciding alone
persists nothing. The actual conservative reservation ledger is the immutable
attempt history written by the original API transaction. The batch revision
advances only for new attempt reservations, not status observations. A decision
must also use the current item `jobRevision` when executing an original API
operation; batch revision alone does not authorize a stale observation/export.

Execution remains explicit through the original image API and adapter. The
existing scheduler, account pacing/cooldown, session occupancy, operation/outbox
and user controls remain the path; no second scheduler or waiting UI lease is
added. Ordinary generation/export I/O authorization also enforces the associated batch
deadline. Fresh output-only delivery is bounded separately by its grant and the
original retention ceiling; it never extends generation/export rights. No generation or consumer delivery is executed
by a local batch decision.

Post-send replacement attempts remain unsupported until A/B provide explicit
remote zero-output settlement evidence that the current occupancy gate can
consume. FAILED, idle, cancellation and expiry are insufficient. No new job,
grant or account alias may bypass that gate. Paid API/fee enforcement, actual
remote receiver transport/rights, live host/account/Project/turn correlation, canary,
installation and deployment require their own evidence.

Run the focused offline checks with
`node --test tests/image-batch.test.mjs tests/image-batch-persistence.test.mjs`;
integration must also run the repository-required `npm run check && npm test`.
