# Image originals, verification and consumer receipts (#79)

## Delivery boundary

This is the offline #79 library delivery for `CBIMG-79-20260930-02`, based on
`9dc2e76d7713a45b952f0089f633947ff9049e0b`. It adds only exporter, verifier,
manifest/receipt logic and their tests. It does not implement a browser adapter,
a new scheduler, a job database, a network artifact service or business publishing.
The previous `CBIMG-79-20260930-01` remains delivery-unknown and is not replayed,
executed, adopted or completed by this task.

The #77 contract is injected as a trusted module dependency. Compatibility is
checked against immutable Git objects, never another worker's uncommitted tree:

- Initial PR84 shape: `b73d5bf1d5a19436ca9a329e11a9a72f2a361b8b`.
- Latest handoff/reducer: `7c764f2f2d53e939d162665aca9211da5c076778`.

No contract/schema/coordinator, main/runtime/CLI/install or #78 adapter file is
changed. #78 owns entry wiring and an actually verified original-provider channel.
The consumer integration owns authenticated cross-host resolution and receipt
transport. This delivery does not turn either dependency into a verified native
capability.

## Functions

| Module | Function | Boundary |
| --- | --- | --- |
| `verifier.js` | `createImageMagickDecoder(options)` | Configured, bounded full raster decoder; no installation. |
| `verifier.js` | `verifyImageBytes(bytes, options)` | Magic/container, MIME, full decode, actual pixels and hash; count remains unverified. |
| `verifier.js` | `inspectImageCount(items, expectedCount)` | Expected/actual/unique counts; byte and normalized-pixel duplicates. |
| `exporter.js` | `createControlledImageStore({root,targetRef})` | Private immutable storage with `read(name)` and `putImmutable(name,bytes)`. |
| `exporter.js` | `createImageExporter(dependencies)` | `exportOriginals(plan)` retrieves only authorized original files. |
| `manifest.js` | `createImageManifest(input)` | Internal snapshot with exact #77 Output records. |
| `manifest.js` | `publicImageManifest(manifest)` | Separate, redacted public schema and canonical snapshot digest. |
| `manifest.js` | `imageExportEvent(result, metadata)` | Builds #77 export evidence; does not call its coordinator. |
| `manifest.js` | `createImageConsumerReceiver(dependencies)` | Receiver-side `receive(input)`, independent verification and durable receipt. |
| `manifest.js` | `authorizeArtifactBinding(authorize,binding,clock,context)` | Samples the trusted clock after the asynchronous authorizer returns. |

All production factories use trusted, host-selected dependencies. Request fields
cannot select an executable, install a decoder, choose a local destination path,
supply an authorization function, or replace the contract module.

## #78 integration shape

The following function is a library wiring example, not an installed command.
`host` must be supplied by the authorized integration. Its authorization and
original-provider methods have no permissive defaults in this implementation.

```js
import {createControlledImageStore, createImageExporter}
  from './src/capabilities/image/exporter.js';
import {createImageMagickDecoder}
  from './src/capabilities/image/verifier.js';
import {imageExportEvent}
  from './src/capabilities/image/manifest.js';

export async function buildOriginalExporter({contract, host}) {
  const store = await createControlledImageStore({
    root: host.privateOriginalRoot,
    targetRef: host.authorizedTargetRef,
  });
  const decode = createImageMagickDecoder({executable: host.imageMagickPath});
  return createImageExporter({
    contract,
    store,
    decode,
    authorize: (binding, context) => host.verifyActiveControllerGrant(binding, context),
    readOriginal: (binding, context) => host.readAuthorizedOfficialOriginal(binding, context),
  });
}

export async function recordOriginalEvidence({exporter, plan, api, key, event}) {
  const result = await exporter.exportOriginals(plan);
  if (result.manifestPersisted && result.manifest.outputs.length) {
    // api/key/event originate from A's persisted job and B's existing transport.
    // Preserve eventId and expectedRevision on a lost response; never regenerate.
    await api.export(key, imageExportEvent(result, event));
  }
  return result;
}
```

`plan` has this shape:

```js
{
  request,              // A-normalized ImageJob request; normalization is checked again.
  attemptId, turnId,     // Exact persisted attempt and observed output turn.
  capabilities,         // The snapshot pinned to that attempt's separately issued grant.
  authorizationContext, // Trusted actor/grant lookup context; not a caller-chosen permission.
  outputs: [{
    outputId,
    attemptId,
    turnId,
    status: 'AVAILABLE', // Or MISSING, UNKNOWN, LATE; those three never invoke the provider.
    originalRef,         // Opaque original-handoff reference, never a temporary URL/path.
    expectedSha256,      // Optional for first recovery; mandatory pinned hash after a record.
    expectedWidth,
    expectedHeight,
  }],
}
```

The trusted original provider returns a Buffer and actual declared MIME, plus
provenance bound to the same job/attempt/turn/output/original reference:

```js
{
  bytes, mimeType,
  provenance: {
    kind: 'OFFICIAL_HANDOFF', // Requires ASSISTED export evidence.
    // NATIVE_ORIGINAL instead requires separately verified NATIVE export evidence.
    jobId, attemptId, turnId, outputId, originalRef,
  },
}
```

This is not a generic fetcher. It does not accept URLs, use session credentials,
call an undocumented endpoint, capture screenshots, or infer that a thumbnail is
an original. B must establish genuine provenance before invoking this boundary.
A mock provenance label in a test is not real provider capability evidence.
Absent provider or specific export evidence returns `EXPORT_UNAVAILABLE`.
Official manual file handoff is explicitly `ASSISTED`, never relabeled native.

### Authorization is a dependency, not a digest-based permission system

`authorize(binding, context)` must independently check the authenticated actor,
current A-issued grant and immutable request, scope, destination, route, exact
attempt/new-turn/candidate IDs, cancellation/deadlines, original references and
**pinned capability snapshot**. It returns `{allowed, bindingDigest, expiresAt}`.
`bindingDigest` is SHA-256 of `canonicalArtifactJSON(binding)` and prevents an
accidental proof/binding mismatch. It is not a credential, signature or authority.
A function that simply returns `allowed:true` is acceptable only in explicitly
synthetic tests, not in production integration. An external caller's `authorized`,
namespace, grant ID, job ID or request digest cannot grant access.

Permission is rechecked before source I/O, before publication, on replay and before
manifest persistence. Every proof expiry is compared to the trusted injected clock
after the awaited hook resolves; a request/context timestamp cannot select that
permission clock. Direct helper callers must pass a clock function, not a sampled
timestamp. A pinned capability snapshot is not replaced by a fresh
unrelated observation on retry. There is no arbitrary default capability TTL:
current grant validity governs its pinned snapshot. A trusted host may explicitly
configure `maxCapabilityAgeMs`; future-dated, unobserved, missing or unsupported
feature evidence fails closed regardless.

## What is actually verified

PNG, JPEG and WebP are supported as single-frame originals. PNG chunk CRCs and
container bounds are checked; truncated/trailing PNG data, malformed RIFF lengths
and known animated containers are rejected. These structural checks do not count
as proof of decoding. The configured decoder must successfully produce every pixel.

The ImageMagick factory pipes original bytes to a forced raster coder and reads
full PAM RGBA8 output. It checks successful exit, empty stderr, a bounded header,
exact `width * height * 4` raster length and a complete pixel digest. It never uses
`identify`, `-ping`, the prompt's claimed resolution, DPI or header dimensions as
complete decode evidence. Original bytes are stored unchanged; PAM conversion is
verification only. Animation is unsupported rather than silently reduced to a
first-frame preview.

Default bounds are 25,000,000 encoded bytes at the verifier, 16,777,216 decoded
pixels, 16,384 per dimension, 512 MiB decoder memory policy and a 15-second decoder
timeout. Disk pixel cache and map cache are disabled; one decoder thread is used.
ImageMagick's internal list limit is four, while exact single-raster output is
independently enforced. Timeout terminates only the owned decoder child, not a
Chat or a generation task. These application limits are not an OS sandbox.

No npm dependency or second service was added. On the verified execution host,
existing ImageMagick `7.1.1-47 Q16-HDRI` and Node `v24.4.0` ran the offline fixtures.
A deployment must explicitly provide a trusted, maintained ImageMagick 7 binary
with PNG/JPEG/WebP coders and a suitable host security policy. Missing decoding
support returns `DECODE_UNAVAILABLE`/`DECODE_FAILED`; no installation or weaker
header-only fallback is attempted. ImageMagick may spool encoded stdin into its
own temporary area even with disk pixel caching disabled; that host-owned area,
permissions and decoder policy must meet the material's data-handling requirements.
Actual sensitive-material use was not tested or authorized here.

Official dependency references: [command-line options](https://imagemagick.org/script/command-line-options.php)
and [security policy](https://imagemagick.org/script/security-policy.php).

SHA-256 is over original bytes. A second hash over fully decoded normalized pixels
finds duplicate imagery with different encoding/metadata. Duplicate outputs are
not deleted or silently deduplicated: actual count, unique count and duplicate IDs
are reported, and the batch remains unverified. Aspect-ratio and requested-size
mismatches are explicit warnings alongside actual dimensions; no native-4K claim is
inferred from a request or resampling.

## Safe publication and bounded recovery

The host, not an ImageJob request, configures the absolute storage root and portable
target reference. The root is private (0700), owned by the current user and pinned
by device/inode. Ancestors must be non-symlink directories owned by root/current
user; writable non-sticky ancestors are rejected. Files are private (0600),
regular and owned by the current user. Path components, absolute filenames,
symlinks, unrelated hard links and directory substitution detected during checks
are rejected.

Writes snapshot caller Buffers, create a unique temporary file exclusively with
`O_NOFOLLOW`, write and sync bytes, then publish with a no-overwrite hard link.
The temporary name binds the exact final filename and a UUID. Readers normally
require one link; exactly two links are accepted only when the private same-owner
regular temporary alias for that final name has the same device/inode. This keeps
complete bytes readable during publication and after a writer dies before unlink.
Extra or unbound links remain unsafe. Reads/retries never delete an alias, so a
live publishing writer retains ownership of its cleanup.
The temporary name is removed, the directory is synced, and the published file is
read back. Existing identical data is reusable; different data is a conflict,
never an overwrite. Disk/I/O/permission errors remain failures. Only this write's
temporary file is cleaned; existing successful files are not removed by recovery.

**Trust boundary:** Node's portable path-based filesystem APIs do not offer a
complete dirfd/openat traversal guarantee against a hostile process sharing the
same OS user that continuously replaces directories between checks. Such a peer
is outside this deployment's local trust boundary. This code does not claim a
kernel-enforced filesystem sandbox or protection against privileged writers.
Abrupt process death can leave a private temporary file; automatic sweeping of
unknown temporary files is deliberately not implemented because it could race a
live writer. The earlier unbound `.image-tmp-<UUID>` naming is not sufficient proof
of a published alias and remains rejected and preserved. This offline branch was
not installed/deployed; no legacy recovery migration is implemented. Live-request
write-failure cleanup, concurrent reads/retries and an owned-child SIGKILL followed
by a newly constructed store are tested.

Each immutable original record binds request digest, output, attempt, turn,
original reference, expected dimensions, original hash and verification evidence.
The record is durable before the original bytes are published. A restarted
exporter verifies an existing original without calling the provider. Only an
explicitly absent original may be re-fetched, by the same bound reference and hash.
An existing corrupt file is not treated as absent and is neither replaced nor
re-generated. Unknown/late candidates do not invoke original retrieval.
For export-only jobs the parent hash is enforced; a new generation/edit cannot
pass merely by returning the exact input source bytes.

These are passive artifact/receipt records, not ImageJob state or another job
scheduler. A continues to own SQLite jobs/events/grants, operation identities,
revision CAS, unknown-delivery reconciliation and controller callbacks.

Every manifest snapshot is immutable. Partial snapshots survive later recovery.
Successful original files survive a manifest write failure; the returned evidence
then has `manifestPersisted:false` and cannot be converted to an A export event.
A snapshot requires all expected unique outputs to report `TECHNICALLY_VALIDATED`.
It still does not claim delivery, business approval or publishing.

## Immutable A outputs and redacted sharing

Internal manifests retain A's exact Output schema, including lineage, turn and
capability snapshot. Dynamic count/duplicate warnings are batch snapshot fields,
not mutable per-output warnings. Original byte-check timestamps remain anchored to
the immutable original record; a new manifest timestamp records fresh revalidation.
This permits PARTIAL to VERIFIED upgrades without changing immutable output fields,
and repeated already-VERIFIED outputs remain byte-for-byte the same JSON values.
The latest fixed A reducer is tested against both transitions.

`imageExportEvent` uses the persisted snapshot reference and the **internal**
outputs. It does not invoke `queue result`, `queue ack`, generate, reconcile or any
coordinator call. B provides the current revision and durable event ID to A's
existing `api.export` transport.

The public manifest is a distinct whitelist schema. It contains hashes, opaque
artifact locators, dimensions, actual status, lineage and typed warnings, but not
full prompts, route/account/session/conversation data, local paths, source download
URLs or provider exceptions. Turn IDs and free-form version strings are digested.
Unknown nested fields are not copied. Public manifests are not accepted as A Output
records. Retained job/output/parent IDs and hash correlation may still be sensitive;
sharing requires the destination's current authorization and disclosure policy.
Opaque references must not encode secrets just because they satisfy the syntax.

An artifact reference is a locator, not a bearer credential or proof of receiving.
The artifact-service integration must map these locators to its authorized stores
and enforce object permissions; a Mac path is never the cross-host API contract.
No network artifact service is installed by this module.

## Consumer receipt boundary

Construct `createImageConsumerReceiver` at the receiving host/service with its own
controlled store, `authorize`, `resolveArtifact` and decoder. Its `receive` method
accepts `{jobId,requestDigest,output,consumerRef,authorizationContext}`. The output
must satisfy A's shape and be technically VERIFIED. The receiver independently
resolves authorized bytes, decodes, checks original hash/MIME/dimensions/length,
rechecks permission, and durably stores bytes. It rechecks permission again after
that awaited durable byte write and before publishing or replaying a RECEIVED
receipt. Revocation/expiry at that boundary preserves already written bytes and
any prior receipt, but does not issue or return a successful receipt.

The receipt has A's exact `chatbridge.image.receipt.v1` shape. Repeated same-output
receiving preserves the receipt ID and original receivedAt; changed hash/reference
conflicts rather than re-importing. Authorization is checked even when returning a
previous receipt. A missing receiver copy can be restored only with the same hash;
it never asks a generator to create replacement imagery. Failed verification or
storage does not create a successful receipt.

Producer manifests always say `NOT_RECEIVED`. Offline local test receipts are not
real cross-host receipt evidence. The production receiver's authentication, network
transport and consumer-owned durable acceptance must be independently integrated
and tested. Neither technical VERIFIED nor RECEIVED means APPROVED/PUBLISHED.

## Evidence and unrun work

At the original fixed delivery `f4fcba4aeffbbbdd7a4ed7adaca1e545763ad4dd`,
`npm run check && npm test` passed: **265/265 Node tests**, including
**54 new artifact tests**, zero failures/skips, plus static and pacing/cooldown
checks. All images were synthetic, non-sensitive offline fixtures. Full PNG/JPEG/
WebP decoding used the installed decoder. Contract tests loaded both fixed Git
objects; elsewhere they explicitly skip when the immutable object is unavailable,
which must not be mistaken for successful integration testing.

Coverage includes invalid/truncated pixels despite valid headers, MIME/hash/count
mismatch, byte/pixel duplicates, animation refusal, dimension warnings, resource
limits, path/symlink/hard-link conflicts, disk-full and temporary cleanup, buffer
mutation, restart/partial recovery, late/unknown output isolation, current-grant
checks, public redaction and receiver idempotency/failure. A first short-tool full
suite attempt timed out without a terminal result; it is not counted as a pass.
The separate complete foreground rerun produced the counts above.

The local correction of independent review findings ART-01/02/03 adds seven
regression tests. The artifact run passes **61/61**, covering proof expiry during
each receiving authorization await, export denial before source I/O, revocation
after durable bytes for fresh and replayed receipts, live publication reads and
retries, an actual owned-child SIGKILL/restart, and conservative unrelated-link
rejection. Full repository revision evidence is retained in the handoff separately
from the original delivery evidence: `npm run check && npm test` passed **272/272**
with zero failures/skips, plus static and pacing/cooldown checks. The test log is
`tests/image-artifacts-revision-full.log` (SHA-256
`5ae533d519695b94902bbaf30ca68c26f4c891e7aff1d4c169784aa229cc9262`);
the preceding `npm run check` success is captured in the local tool receipt.

Model evidence for this development task: requested Latest + Pro. The exact bound
session's native status read at `2026-09-30T06:33:36.076Z` observed effort Pro;
its folded live model label was null. The same read returned
`verifiedResourceSelection={model:Latest,effort:Pro,verifiedAt:2026-09-30T06:29:52.706Z}`
for this task's pre-send verification. These observations are kept separate; no
fixed underlying model version or image model is inferred, and no downgrade was
attempted.

**NOT_RUN:** real image generation or source upload; real original-provider export
canary; installed A/B/C runtime/CLI integration; real authenticated cross-host
artifact delivery or external consumer receipt; independent non-author review of
the correction (the original fixed delivery was independently reviewed);
installation/rollback; native multi-reference/mask/batch capability validation;
HZ adoption, publishing, channels or production. No paid API, merge or owner ACK
was performed. Those remain separate controller-owned review/integration gates.
