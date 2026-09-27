# Runtime facade API

`src/runtime.js` exports `createRuntime(options)` and a default `runtime` instance. It is a Node ESM boundary for the existing `bin/chat-bridge` CLI; registry, account/Space binding, pacing, cooldown, user-control and page attachment policy remain owned by Bridge.

## Requests and responses

All methods return a Promise of a JSON-safe object. Success is `{ok:true,data}` for CLI-backed operations, or `{ok:true,route}` for `resolveRoute`. Failure is `{ok:false,error:{code,message,...}}`; nested CLI receipts are normalized into the same `code`, `message`, and `deliveryStage` fields and retained as `cause`. Callers should branch on `ok` and must not retry a send after `sendAttempted:true` or `deliveryStage:"SEND_ATTEMPTED"`.

```js
const bridge = createRuntime();
await bridge.resolveRoute({project: "Project", target: "worker"});
await bridge.send({project: "Project", target: "worker", message: "task"});
await bridge.read({project: "Project", target: "worker"});
await bridge.status({project: "Project", target: "worker", task: "T-1"});
await bridge.stop({project: "Project", target: "worker"});
await bridge.ask({project: "Project", target: "worker", message: "final answer", timeout: 180000});
await bridge.stream({project: "Project", target: "worker", message: "incremental answer", requestId: "req-1", turnId: "turn-1"});
await bridge.askParts({project: "Project", target: "worker", parts: [
  {type: "text", text: "describe this image"},
  {type: "image", path: "/absolute/path/photo.png", mimeType: "image/png"},
]});
await bridge.attach({project: "Project", target: "worker"});
```

`resolveRoute` is local-only and reads the existing session registry through `list`; it does not wake Ego. `attach` uses the existing status/ensure-page path and therefore may contact Ego. Destructive deletion is intentionally absent.

## Gateway consumer boundary

The Rust Gateway is a protocol adapter, not a second ChatBridge registry. It
must use the Bridge route contract and must not resolve Space IDs, Page labels,
account aliases, or browser ownership itself.

The minimum call sequence is:

```js
const route = await bridge.resolveRoute({
  project: "Project",
  target: "worker",
  // account is optional when the call has a verified account-bound origin
});

await bridge.ask({
  project: "Project",
  target: route.route.sessionRef,
  account: route.route.account,
  message: "...",
});
```

`target` is the logical role/session selector. `project` alone is not an
unambiguous route when a Project contains more than one registered session.
The current API therefore requires `target` and returns `AMBIGUOUS_ROUTE` when
the selector is not unique. A future project-only convenience operation must
fail closed on ambiguity; it must not guess an account or session.

The Bridge owns the selected account, Project binding, Space/Page attachment,
pacing, cooldown, user-control pause, recovery, and delivery-stage receipt.
The Gateway should preserve the resolved `project`, `account`, and
`sessionRef` in its request evidence, while treating them as an observed route
receipt rather than recreating the selection policy.

An account may be omitted only when the caller is running in a verified
account-bound origin. An unbound local invocation must provide the account when
the Bridge cannot safely infer it. Desktop/MCP connectivity is an origin or
control context; it is not a replacement for this route receipt or a native
model-inference transport.

## Concurrency boundary

Each facade call owns one bounded CLI child. The facade does not create a second lock or bypass admission: the existing CLI remains the shared authority for per-account UI pacing, cooldown, user-control pauses, and page protection. Concurrent UI calls for the same account may return `PACING_DEFERRED`, `WEB_COOLDOWN_ACTIVE`, or another typed admission error; callers must preserve request/turn correlation and must not treat a child exit as proof that a remote generation stopped. Local `resolveRoute`/registry reads remain safe to run without waking Ego.

`ask` is the existing bounded synchronous `status → send → status` path and returns one final response (`mode:"final-only"`). It is a safe transition for callers that need a response but must not be interpreted as a stream. `timeout` is in milliseconds and must be between 1 and 600000.

## Capabilities and limits

`capabilities` reports `resolveRoute`, `send`, `read`, `status`, `stop`, `ask`, `attach`, `stream`, `imageParts`, and image-text `multimodal` as supported. `toolResults` remains false because ChatGPT Web has not exposed a native external-tool event transport. `stream` is observed-incremental: deltas are sampled from the current assistant DOM while generation is active, carry request/turn/sequence IDs, and end with a terminal event; the facade never splits a completed final response into fake chunks.

## Image parts

`probe({capability:"imageParts"})` reports `mode:"local-file-upload"`. `sendParts` and `askParts` accept one absolute local PNG, JPEG, or WebP plus text, enforce a 10 MiB limit and file-byte MIME validation, reject remote URLs/base64, upload through Ego Browser's native `setInputFiles` path, and return the normal delivery/final-response receipt. The verified internal canary used the existing hzcodex ChatGPT Web Gateway session and returned `IMAGE_UPLOAD_OK` and `IMAGE_ASK_OK`.

## External tool result boundary

`probe({capability:"toolResults"})` still returns `NO_NATIVE_TOOL_EVENT_TRANSPORT`. `createToolResultStream({requestId, turnId, toolCallId, toolName, schemaId})` validates caller-produced `progress`, `result`, and `error` receipts. Result/error events must include matching request, turn, tool-call, result, tool name, and schema IDs with contiguous sequence numbers. Duplicate result IDs return `DUPLICATE_TOOL_RESULT`; stale or skipped sequences return `STALE_TOOL_RESULT` or `TOOL_SEQUENCE_GAP`; binding mismatches return `TOOL_BINDING_MISMATCH`; malformed failures return typed `INVALID_TOOL_*` errors. `submitToolResult` remains `UNSUPPORTED` until the browser exposes a real native tool-call event to bind against. The caller executes the tool; ChatBridge never runs a host command and never prompt-emulates a tool success.

## Turn event boundary

`createTurnEventStream({requestId, turnId, assistantMessageId})` validates the events returned by `stream`. Each event must carry the same `requestId`, `turnId`, and a contiguous positive `sequence`, with `type` equal to `delta`, `progress`, or `terminal`. A configured assistant baseline is required for delta freshness; a different assistant message returns `STALE_ASSISTANT_CONTENT`. Duplicate, skipped, mismatched, or post-terminal events return typed errors. The runtime emits these events from observed DOM polling and does not split a completed final response into fake chunks.

## Error and cancellation boundary

Known errors preserve Bridge codes such as `PACING_DEFERRED`, `WEB_COOLDOWN_ACTIVE`, `DELIVERY_UNCONFIRMED`, and `AMBIGUOUS_PROJECT_ACCOUNT`. A pre-send failure has `deliveryStage:"PRE_SEND"`; after the send control is triggered, delivery may be uncertain and is reported as `SEND_ATTEMPTED`. Timeout and disconnect receipts include `localProcess` and `remoteGeneration`; a facade timeout terminates only its CLI child and reports `remoteGeneration:"unknown"`. A successful `stop` receipt means the remote stop request completed, not that ChatGPT generation has been independently observed stopped (`remoteGeneration:"unknown"`). The facade never auto-retries an attempted or uncertain send.
