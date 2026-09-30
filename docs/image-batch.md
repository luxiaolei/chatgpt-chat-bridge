# Offline image batch policy (#81)

`src/capabilities/image/batch.js` groups 1–16 explicitly linked, existing
`count=1` ImageJobs. It provides pure recommendations and performs no browser,
filesystem, database, queue, receipt, generation or controller action. This is
an offline increment; it does not complete #81 or enable native multi-output
generation. GitHub remains development state, Bridge holds technical jobs and
receipts, and the consumer/controller owns business acceptance.

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

Coordinator integration remains pending. Its single writer must persist the
batch envelope/linkage and CAS revision in the existing SQLite database;
re-read authoritative jobs/receipts/admission and reserve batch budget in the
same transaction as `beginAttempt` before any possible Send. Concurrent stale
recommendations must lose that CAS, not send twice. The existing scheduler,
account pacing/cooldown, session occupancy, operation/outbox and user controls
remain the execution path; no second scheduler or waiting UI lease is added.

Post-send replacement attempts remain unsupported until A/B provide explicit
remote zero-output settlement evidence that the current occupancy gate can
consume. FAILED, idle, cancellation and expiry are insufficient. No new job,
grant or account alias may bypass that gate. Paid API/fee enforcement, actual
receiver transport/rights, live host/account/Project/turn correlation, canary,
installation and deployment require their own evidence.

Run the focused offline check with `node --test tests/image-batch.test.mjs`;
integration must also run the repository-required `npm run check && npm test`.
