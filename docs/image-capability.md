# Image capability v1 — contract and persistence

This document owns the Bridge technical contract (#77), not HZ business approval.
`src/capabilities/image/schema.v1.json` defines versioned shapes;
`contract.js` validates and canonicalizes them using Node stdlib only.
An ImageJob `jobId` is **not** a controller queue `taskId`. Jobs will reference the
existing immutable dispatch operation and live in the same SQLite database, not
in the reconstructable runtime cache. Existing send/ask, #58 vision input,
local Codex ownership, callback/ACK, UNKNOWN, manual takeover and pacing remain
unchanged. No scheduler, account pool, browser service or Python subsystem is added.

## Frozen API (first handoff)

`normalizeImageRequest(input)` fills documented defaults, validates the strict
schema and computes `requestDigest` (SHA-256 of recursively key-sorted JSON without
the digest field). Every request field, including caller/scope/route, prompt,
input hashes, base revision, mask, budget, output destination and requested model,
is covered. A supplied wrong digest fails. Same caller/job + same request replays;
a changed request conflicts. Namespaces, job IDs and digests are not credentials.

`createImageJobAPI({coordinated})` uses the existing coordinator transport:

| Method | Arguments | Meaning |
| --- | --- | --- |
| submit | request, `{grantId}` | Persist one authorized, immutable ImageJob |
| inspect / result | `{grantId,callerRef,jobId,scope}` | Read state / technical result |
| beginAttempt | key, event | Persist baseline before any possible UI send |
| record | key, event | Record new-turn observation, never a browser send |
| export | key, event | Record exporter's original-byte evidence, not perform I/O |
| reconcile | key, event | Reconcile original route only; never resend UNKNOWN |
| cancel | key, event | Cancel only before an attempt; otherwise request stop |

Events carry `eventId` and `expectedRevision` for transactional idempotency/CAS.
The persistence implementation is the next commit after this shape handoff;
this first handoff alone is **not** a runnable end-to-end image implementation.
The entry-point wiring/adapter belongs solely to #78 and export implementation
solely to #79. No new CLI command is installed by this contract commit.

## Authorization and evidence boundary

An external request cannot set `authorized`, grant itself permission by choosing
a namespace/caller/job, or submit a local filesystem path as a portable artifact.
A **separate controller-issued grant**, bound to the persisted owner operation
and entire normalized request digest, is required by the persistence boundary.
Input externalization and output destination are explicitly granted, not inferred
from a prior vision upload. Same-OS-user processes remain a trusted local boundary,
as with existing Bridge. A remote HZ gateway must authenticate its principal and
tenant before entering this local API; this module is not an Internet auth server.

`unknownImageCapabilities(route)` defaults every feature to UNKNOWN.
`classifyImageCapabilities` accepts feature-specific native/assisted/unsupported
observations with version, timestamp, exact route and evidence references;
`imageParts` or input vision is not generation evidence. Capabilities include
generate/edit/refine/export/multiReference/mask/deterministicComposite/batch.
ASSISTED is explicit, not automatic success. Native region editing and deterministic
composition are distinct; neither implies untouched pixels without evidence.

Outputs bind job/attempt/new turn/outputId, source hashes, parent/base revision,
portable artifactRef, actual MIME/bytes/pixels/hash and independent verifier checks.
Only all affirmative byte-verification checks permit technical VERIFIED.
`validateImageReceipt` defines a consumer receipt; RECEIVED/REJECTED does not confer
APPROVED/PUBLISHED. HZ Blueprint #107 / Runtime #134 own immutable asset/revision,
rights, adoption and placement. They map from these fields and independently check
current receiving permissions; a Mac path, old callback or byte hash is not access.

## Model and delivery limits (2026-09-30)

User request: Latest + Pro, not Extra High. Development task
CBIMG-77-20260930-03 has persisted send receipt
`a546be04-603f-42d8-be41-65bcd248d14d` with observed
`{model:"Latest",effort:"Pro",raw:"Pro",verified:true}` on authorized default /
Ru Wang, Chat Bridge Project `g-p-6abca54a9ea88191b5b4a9f64ee1d75c`.
This is developer-chat selection, not proof of an image model, generation or quota.
The historical hzcodex observation is not reused as this account's identity.

R0 is PR #83 at `9dc2e76d7713a45b952f0089f633947ff9049e0b` (two existing
commits only). Historical local receive + owner ACK exists; active background
Codex wake-up/native Codex dispatch/MCP Events are separate unimplemented gaps.
The image PR is stacked on `codex/local-codex-roundtrip`. Controller alone reviews,
merges, installs and ACKs. Generation, real material upload, original-export canary,
installation/rollback, HZ adoption and publishing are **NOT_RUN** in this delivery.
