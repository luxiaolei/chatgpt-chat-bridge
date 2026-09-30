# Image capability: first assisted loop

The 2026-09-30 bounded canary completed generation → official original export → exact-source refinement → second official original export → independent local consumer receipt. Non-author review confirmed both originals, actual consumer copies, receipts and the exact parent revision; the controller's durable ACK is recorded separately below. This is technical acceptance of an **ASSISTED** path.

## Fixed implementation and execution scope

- Product code: `ed77edf383ce7f4c4e2f573d1c88a81b1e6b97d7`, Draft PR [#93](https://github.com/luxiaolei/chatgpt-chat-bridge/pull/93).
- Required checks: `npm run check && npm test`; 449 passed, zero failed or skipped. Exact-head [push CI](https://github.com/luxiaolei/chatgpt-chat-bridge/actions/runs/36715978679) and [PR CI](https://github.com/luxiaolei/chatgpt-chat-bridge/actions/runs/36715984521) succeeded.
- Local installation: all 36 mapped files matched the fixed source after the loop. No daemon restart. Rollback execution: **NOT_RUN**; installation backups and activation receipts are retained.
- One verified login/Profile and one project-bound conversation, under the original local Codex owner. Private account, conversation and host identifiers remain in the controlled evidence packet. Recycled Space/Page numbers were verified as current runtime attachments, never used as permanent conversation identity.
- Requested and freshly observed frontend selection: **Latest / High**. “Latest” is the observed UI label, not a claim about a fixed underlying model version. Capability mode: **ASSISTED**, not NATIVE.
- Authorized original synthetic test material, one generation Send and one source-bound refinement Send, both consumed. No paid API, customer asset or additional image request was used.

## Actual originals and reception

| Result | Decoded image | Original bytes | SHA-256 | Local receiver |
| --- | --- | ---: | --- | --- |
| Generation | PNG, 1254 × 1254 | 982850 | `6bb48ef55e352e7bb901799131dd08e83ed6cffab0af2136ac20f4092dce6ba5` | RECEIVED at 12:42:56.075 UTC |
| Source-bound refinement | PNG, 1254 × 1254 | 1205162 | `d79f97aebda792c13e0575247eef03b3740a3c2bf9430113cb76cc0f94c017b6` | RECEIVED at 13:41:40.760 UTC |

The original generation deadline elapsed before its official Download. A separate output-only recovery grant permitted recovery of that existing result. The generation job remains **BLOCKED**, with zero ordinary outputs and one VERIFIED late output; its deadline, request, attempt and budget were not extended, and the late result was not adopted as ordinary completion.

A fresh ordinary refinement grant explicitly authorized the exact recovered source. Its input SHA, parent output and base revision bind the first original. The resulting immutable revision is `cbimg-r1:403509c5a8c44f7aa37a8b32a1d0d0872269904f073d59c19d53a20825ad6d63`, with parent revision `cbimg-r1:f264e51c80f4f61e011076e3bfa7717841aceb9a88392b26fb458813e6c231ee`. The refinement job is **TECHNICALLY_VALIDATED**, revision 4, with one VERIFIED ordinary output and no late output.

Each official Save used the scoped new image reply and the official UI Download event, followed by complete decoding, byte/hash checks, immutable original records and an actual local consumer copy. Both receipt results reported `reused: false`. The second receipt is `receipt-f6a69eefdbc22b255d14dfa05396353bc184b1f39846b7b0f9141d2531e3c89c`; the first is `receipt-05b6fd786f78cf40797fc00ef5d7a638c5def35dbfaf7787691638699177441d`.

Inspection of the saved originals found a red teapot followed by a cobalt-blue teapot, each with two green leaves on an ivory background and no visible text or logo. This observation does not establish pixel-exact protection outside an edit region.

## Evidence and failure handling

The controlled packet preserves original request/grant, actual model selection, handoff, permanent Send marker, matching full-prompt/new-user/new-assistant observation, official Save marker, original bytes, manifest, immutable revision, actual receipt and final job query. Full prompts, private conversation/resource URLs, credentials and original image bytes are not published in repository logs.

The first abandoned job had a proven pre-Send failure and was cancelled with zero Send clicks. The real generation and refinement each used one Send. Unknown submission was reconciled against the existing turn; no generation was replayed. Old/input/preview reuse, malformed originals, partial/export-failure handling, revoked authority, user-owned Spaces and unknown delivery have bounded regression evidence in the required suite and independent reviews.

A rejected disposable Save helper allowed a click if authority changed during its last awaited live guard. The corrected helper rechecks ordinary authority after that guard and before either click; independent revocation cases produced zero clicks. Its runtime-attachment correction was independently checked against documented Ego APIs. A later `UI_LOCK_BUSY` response occurred before any Save marker or click; the successful same-package Save retains its permanent marker. Rejected helpers and original failure evidence remain preserved.

Final independent evidence review: **BOUNDED_ASSISTED_TECHNICAL_CLOSED_LOOP_CONFIRMED**, six groups of actual file/decode/manifest/revision/receipt/source-package checks, with no binding mismatches. The controlled JSON report SHA-256 is `28c2da1a3570b229ecd91fa15dd41d34faea5b626b6e25ed3c7950d43f24b494`. The original worker durably reported **COMPLETE**, result version 1. The exact original local Codex owner received that result and recorded **ACCEPTED** after this review; a subsequent local read returned **RECEIVED_LOCAL / ACCEPTED**, and the task is **COMPLETE**. The ACK accepts this bounded technical delivery only. This control-only callback is separate from the two image requests and both local consumer receipts; it does not prove proactive native Codex target delivery.

## Scope that remains open

This run does not prove native parent/asset metadata, multi-reference editing, region/mask submission, deterministic pixel protection, live batch recovery, remote/HZ tenant receipt, HZ business adoption, publication, production rollout or rollback execution. #80 and #81 enhancements have separate acceptance work; none requires a second scheduler or a new business asset database in Bridge.

GitHub holds development state; Bridge holds technical jobs, provenance and delivery receipts; HZOS remains responsible for business asset adoption and channel outcomes. A worker result, callback or RECEIVED receipt alone is not business acceptance.
