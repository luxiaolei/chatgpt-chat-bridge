# Runtime facade acceptance

This is the evidence ledger for the Gateway-facing runtime boundary. It keeps
local contract tests separate from a real ChatGPT Web canary; passing the first
does not prove the second.

## Reproduce the local gate

From the repository root:

```bash
npm run check
npm test
```

The gate covers the runtime facade, CLI syntax, pacing/cooldown, route
resolution, user-owned Space protection, observed turn-event ordering, image
input validation, uncertain delivery, and the explicit unsupported tool-result
boundary. The stream timeout test asserts `SEND_ATTEMPTED` plus
`remoteGeneration: "unknown"`; it does not claim that the remote generation
stopped.

## Current evidence by tracked issue

| Issue | Local contract | Real Web canary | Status |
| --- | --- | --- | --- |
| [#56](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/56) correlated turn events | `src/main.js` emits progress/delta/terminal events; `src/runtime.js` validates request/turn/sequence and fresh assistant IDs; `tests/runtime.test.mjs` covers stale content, ordering, terminal handling, timeout and remote-cancel uncertainty. | 2026-09-27 Gateway canary: session `6ab89adb-0e0c-83e8-b6a3-9a716854c33e`, verified Latest + Instant, `gateway-1`/`turn-1`, progress → delta → terminal, final `STREAM_ROUTE_OK`. | COMPLETE for observed DOM-incremental events; this is not original token timing. |
| [#58](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/58) image input parts | One local PNG/JPEG/WebP, 10 MiB limit, magic-byte/MIME checks, no URL/base64, native file input path, delivery-stage propagation, malformed-input tests. | 2026-09-27 Gateway canary uploaded one local PNG and returned `Left: red circle; Right: blue square` on the hzcodex Gateway Canary route. | COMPLETE for one-image local upload/interpretation; other media remain unsupported. |
| [#59](https://github.com/luxiaolei/chatgpt-chat-bridge/issues/59) external tool results | ID/schema/name binding, contiguous serial receipts, duplicate/stale rejection, caller-only execution, typed `UNSUPPORTED` with `NO_NATIVE_TOOL_EVENT_TRANSPORT`. | No native ChatGPT Web tool-event transport is currently exposed. | BLOCKED: safe unsupported boundary is complete; native transport requires a browser capability change. |

## Safety boundary

The Gateway consumes `resolveRoute({project, target, account?})` and the exact
route receipt. ChatBridge remains the authority for account/Project/Space/Page
selection, pacing, cooldown, user-control pause, recovery, and delivery stage.
The runtime never retries an attempted or uncertain send. A caller disconnect
or local timeout only terminates the CLI child; it does not imply that the
remote ChatGPT generation stopped. `stop` is a separate request and reports
`remoteGeneration: "unknown"` until independently observed.

No production deployment or native tool claim is made by this document.
