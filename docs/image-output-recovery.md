# Expired original recovery

`OUTPUT_RECOVERY` is a fresh, host-owner-issued row in the existing `image_grants` table. It grants no generation authority. The original request, digest, deadline, grant, generation reservations, output target and retention policy remain unchanged.

The first supported path is an existing single ASSISTED `generate` attempt, count 1, with no input artifacts, whose original grant/request/attempt has expired or been revoked. Native, multiple-attempt, edit and refine recovery are explicitly unsupported. Current owner/controller/route, management/user pause, cooldown, capability and cancellation checks still apply. Expired grants do not clear UNKNOWN reservations; only actual positive turn/original evidence can settle the existing attempt.

Issue through `image recovery authorize` (JSON stdin):

```js
{issuerRef, grant:{kind:'OUTPUT_RECOVERY', grantId, controllerOperationId,
  controllerTaskId, key:originalKey, requestDigest, attemptId, route,
  userMessageId, turnId, evidenceRef, expiresAt, targetRef, consumerRef,
  destinationRef, maxByteLength}}
```

`targetRef` must equal the original request's output target. Expiry is at most one hour from issuance; `maxByteLength` is at most 32 MiB. IDs pin the existing public user and assistant/gallery wrapper plus authorized-owner official-viewer evidence; they do not assert native parent/asset provenance. A grant ID remains a lookup name, never a bearer token. Exact re-issuance is idempotent; changing any binding conflicts. Existing `image-revoke` revokes either grant type.

Every recovery invocation carries the original key separately:

```js
const recovery={recoveryGrantId, requestDigest, attemptId, route,
  userMessageId, turnId};
api.authorizeRecovery(originalKey,recovery,'observe');
// Allowed actions: observe, save, verify, receive.
createHostImageArtifacts({api,key:originalKey,recovery,stateDir,coordinated});
```

`image recovery admission` accepts `{key,recovery,action,binding?}` and performs a query-only local SQLite read. `image recovery inbox` accepts `{key,recovery}` and returns the existing attempt's controlled official-original inbox plus `MANUAL_OFFICIAL_SAVE_REQUIRED`. No command automatically clicks Save or Send. The authenticated owner uses the official Save handoff after fresh `save` admission. No private asset URLs, previews, screenshots or arbitrary paths qualify as originals.

Live `prepare` supports recovery only for `characterize` and `assist-observe`. It captures the actual local-owner environment and fixed recovery context for Ego coordinator calls. Ordinary `authorizeIO`, submit, beginAttempt, Send, upload, start, reconcile and native download do not accept recovery. Do not replace their authorization functions with a recovery wrapper.

After official Save, `assist-observe` accepts `{key,recovery,operatorRef,path,originalRef,officialSave}`. `officialSave` retains the existing explicit owner confirmation, route/digest/attempt/user/turn/prompt/relationship binding. A precomputed `sha256` is optional only for recovery: read and full decode of the actual controlled bytes produces the hash and stable output ID. The exact public route/login, unique request-matching user and assistant wrapper are checked independently. The returned `importPayload` carries the same recovery context to `image import-original`.

Observation/export use the original key and grant through existing CAS. Expired results stay `lateObservations`/`lateOutputs`, `BLOCKED`, and `LATE_RESULT_NOT_ADOPTED`. Additive `lateOutputRevisions` exposes immutable VERIFIED descriptors without moving outputs or marking business acceptance. Existing immutable original records prevent replacement bytes.

`image recovery receive` accepts `{key,recovery,outputId,artifactRef,sha256,consumerRef,destinationRef}`. Admission loads the actual VERIFIED late output and checks the pinned consumer/destination. The existing consumer receiver reads the controlled producer original, validates/decodes the actual bytes and persists its separate controlled copy and immutable receipt under the state directory. Caller-supplied output/receipt JSON is rejected. This local receiver handoff does not claim a remote consumer deployment, a batch receiver ledger, or HZ business adoption; receipt status and controller acceptance remain separate.

A later `refine` requires a new ordinary generation request/grant with source externalization explicitly authorized and the exact late artifact/hash/revision in `inputs` and `baseRevision`. Source admission authenticates the stored VERIFIED output revision and its original record/bytes using the #80 resolver. Neither recovery authority nor a receipt permits source upload by itself. The parent remains late and unadopted.
