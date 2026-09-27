# Runtime facade API

`src/runtime.js` exports `createRuntime(options)` and a default `runtime` instance. It is a Node ESM boundary for the existing `bin/chat-bridge` CLI; registry, account/Space binding, pacing, cooldown, user-control and page attachment policy remain owned by Bridge.

## Requests and responses

All methods return a Promise of a JSON-safe object. Success is `{ok:true,data}` for CLI-backed operations, or `{ok:true,route}` for `resolveRoute`. Failure is `{ok:false,error:{code,message,...}}`; callers should branch on `ok` and must not retry a send after `sendAttempted:true` or `deliveryStage:"SEND_ATTEMPTED"`.

```js
const bridge = createRuntime();
await bridge.resolveRoute({project: "Project", target: "worker"});
await bridge.send({project: "Project", target: "worker", message: "task"});
await bridge.read({project: "Project", target: "worker"});
await bridge.status({project: "Project", target: "worker", task: "T-1"});
await bridge.stop({project: "Project", target: "worker"});
await bridge.ask({project: "Project", target: "worker", message: "final answer", timeout: 180000});
await bridge.attach({project: "Project", target: "worker"});
```

`resolveRoute` is local-only and reads the existing session registry through `list`; it does not wake Ego. `attach` uses the existing status/ensure-page path and therefore may contact Ego. Destructive deletion is intentionally absent.

`ask` is the existing bounded synchronous `status → send → status` path and returns one final response (`mode:"final-only"`). It is a safe transition for callers that need a response but must not be interpreted as a stream. `timeout` is in milliseconds and must be between 1 and 600000.

## Capabilities and limits

`capabilities` reports `resolveRoute`, `send`, `read`, `status`, `stop`, `ask`, and `attach` as supported. `stream`, `imageParts`, `toolResults`, and `multimodal` are false. `probe({capability:"stream"})` returns `{supported:false, transport:"cli-subprocess", reason:"NO_INCREMENTAL_TRANSPORT"}`. The CLI's status polling is never emitted as SSE.

## Image parts

`probe({capability:"imageParts"})` returns `NO_SAFE_LOCAL_IMAGE_UPLOAD`. `sendParts` is a boundary only: it rejects remote URLs with `IMAGE_REMOTE_URL_FORBIDDEN`, rejects base64/data fields with `IMAGE_DATA_FORBIDDEN`, and returns typed `UNSUPPORTED` for local image paths without invoking the CLI. The current Ego Browser surface used by ChatBridge exposes no verified file chooser or `setInputFiles` path, so no image is fetched or inserted into a text prompt. A future implementation must remain limited to one bounded local image plus text and require a dedicated canary before enabling the capability.

## Turn event boundary

`createTurnEventStream({requestId, turnId, assistantMessageId})` validates events for a future incremental transport. Each event must carry the same `requestId`, `turnId`, and a contiguous positive `sequence`, with `type` equal to `delta`, `progress`, or `terminal`. A configured assistant baseline is required for delta freshness; a different assistant message returns `STALE_ASSISTANT_CONTENT`. Duplicate, skipped, mismatched, or post-terminal events return typed errors. This validator does not create events from polling and does not claim that the current CLI can stream.

## Error and cancellation boundary

Known errors preserve Bridge codes such as `PACING_DEFERRED`, `WEB_COOLDOWN_ACTIVE`, `DELIVERY_UNCONFIRMED`, and `AMBIGUOUS_PROJECT_ACCOUNT`. A pre-send failure has `deliveryStage:"PRE_SEND"`; after the send control is triggered, delivery may be uncertain and is reported as `SEND_ATTEMPTED`. Timeout and disconnect receipts include `localProcess` and `remoteGeneration`; a facade timeout terminates only its CLI child and reports `remoteGeneration:"unknown"`. A successful `stop` receipt means the remote stop request completed, not that ChatGPT generation has been independently observed stopped (`remoteGeneration:"unknown"`). The facade never auto-retries an attempted or uncertain send.
