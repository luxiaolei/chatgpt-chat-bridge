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
await bridge.attach({project: "Project", target: "worker"});
```

`resolveRoute` is local-only and reads the existing session registry through `list`; it does not wake Ego. `attach` uses the existing status/ensure-page path and therefore may contact Ego. Destructive deletion is intentionally absent.

## Capabilities and limits

`capabilities` reports `resolveRoute`, `send`, `read`, `status`, `stop`, and `attach` as supported. `stream`, `toolResults`, and `multimodal` are false and their methods return `UNSUPPORTED`. This facade does not define a model/tool protocol; that belongs in the gateway.

## Error and cancellation boundary

Known errors preserve Bridge codes such as `PACING_DEFERRED`, `WEB_COOLDOWN_ACTIVE`, `DELIVERY_UNCONFIRMED`, and `AMBIGUOUS_PROJECT_ACCOUNT`. A pre-send failure has `deliveryStage:"PRE_SEND"`; after the send control is triggered, delivery may be uncertain and is reported as `SEND_ATTEMPTED`. The facade timeout terminates only its CLI child and reports `RUNTIME_TIMEOUT`; it cannot cancel a ChatGPT generation. Use `stop` for that operation.
