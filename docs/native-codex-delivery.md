# Dedicated native Codex delivery

`queue submit --runtime codex` dispatches to an existing **Bridge-dedicated**
Codex thread on an already running shared app-server. It does not send to an
arbitrary desktop tab, start an isolated `codex exec`, or wake a closed desktop
application. GitHub remains durable project state. Worker result and owner ACK
keep their existing meanings.

## Start a dedicated shared runtime

Use Node 22 or newer (native `WebSocket`) and Codex CLI 0.159.2 or a compatible
app-server protocol. Run the following in a separately supervised terminal or
service. The deployment owner chooses the service lifecycle; Bridge does not
restart or reconfigure an existing user runtime.

```sh
mkdir -p "$HOME/.local/state/chat-bridge/native"
chmod 700 "$HOME/.local/state/chat-bridge/native"
umask 077
CODEX_INTERNAL_ORIGINATOR_OVERRIDE=chat_bridge_native \
  codex app-server --listen "unix://$HOME/.local/state/chat-bridge/native/server.sock"
```

The originator setting identifies the dedicated runtime. Do not open its workers
for simultaneous manual interaction. The public `turn/start` protocol can steer
an active turn and does not offer an atomic idle/draft check; therefore Bridge
rejects threads created by ordinary desktop/CLI clients. This ownership boundary
is an operational guard, not isolation from processes with the same OS identity.
The service inherits existing Codex permissions and authentication; Bridge does
not select a more permissive sandbox, answer approval requests, or alter credentials.

`unix://` is WebSocket over a Unix socket. `codex app-server proxy` forwards bytes;
it does not translate newline JSON into WebSocket messages. The adapter uses
Node's native WebSocket through a temporary one-connection loopback tunnel. A
random request path is checked before forwarding to the owner-checked socket.
The tunnel closes with the adapter; the shared app-server and worker survive.

## Create and dispatch

Create returns the verified host/thread/cwd/socket binding. It sends no inference
turn. Preserve the receipt, especially if a response is lost; a missing response
does not authorize blind duplicate creation.

```sh
chat-bridge queue native-create --native-host xlmini \
  --native-cwd /absolute/workspace \
  --native-socket "$HOME/.local/state/chat-bridge/native/server.sock" \
  --model gpt-6-astra --effort xhigh --confirm

chat-bridge queue submit --runtime codex --project PROJECT \
  --request-id REQUEST_ID --task TASK_ID --caller-ref "codex:$CODEX_THREAD_ID" \
  --native-host xlmini --native-thread THREAD_ID --native-cwd /absolute/workspace \
  --native-socket "$HOME/.local/state/chat-bridge/native/server.sock" \
  --model gpt-6-astra --effort xhigh --message 'Bounded authorized task'
chat-bridge queue work-one
```

A registered Web controller may also submit using its existing callerRef. A local
Codex caller retains its original host/thread/cwd contract and local-pull result
routing. Native workers are never inserted into Web `chats` or `runtime.tasks`;
queue/control views derive their business status from operations and task_results.
Native workers do not occupy browser pages or trigger Ego recovery.

Both explicit model and effort are preserved. Defaults are `gpt-6-astra/xhigh`.
Current `model/list` validates the exact pair before resume/send; unavailable
models or effort fail explicitly. `modelSelection.executionObserved=false`
means catalog validation and requested turn settings, not model execution telemetry.

## Receipts, recovery, cancellation and acceptance

```sh
chat-bridge queue status OPERATION_ID
chat-bridge queue native-read OPERATION_ID
chat-bridge queue native-cancel OPERATION_ID --confirm
chat-bridge queue reconcile --operation OPERATION_ID
```

Readback is correlated by exact host/thread/cwd, operation UUID as native
`clientUserMessageId`, exact user text including the control footer, and native
turn ID when one was recorded. It never retries an uncertain send. Reconciliation
leaves missing, duplicated or mismatched evidence `STILL_UNKNOWN`. History scans
are bounded to 1,000 turns; exceeding the bound remains unknown. Readback never
resumes a thread or wakes Ego.

Cancellation interrupts only that proven native turn. A turn still in progress
returns `interruptRequested`; `cancelled=true` requires readback showing the exact
turn interrupted. The operation becomes CANCELLED only after that evidence. This
is not result acceptance and cannot undo external actions. `queue cancel` remains
the existing way to cancel an operation that has not left QUEUED.

Pause/drain are checked at enqueue, claim and immediately before native turn
start. An unavailable socket or rejected target is PRE_SEND; a lost turn/start
response is DELIVERY_UNKNOWN. An unrecorded worker result keeps the target busy.
An explicit retry is permitted only for proven FAILED_PRE_SEND operations.
Retry and the final pre-send check revalidate the thread reservation. A conflicting
saved retry fails PRE_SEND, releasing its claim so another queued operation can
proceed. Native task IDs cannot be reused after cancellation; a fresh task ID
prevents old results or acceptance from attaching to later work.

The worker itself uses the control footer's `queue result`. Native result
recording checks the executing thread/host against the saved target. The owner
then verifies artifacts and runs the existing `queue receive` and `queue ack`.
Reading the native assistant reply does not record a worker result or accept it.

Optional `--routing-advice FILE` persists the bounded Luna receipt plus its file
SHA-256. The coordinator verifies the original message hash, exact selected
choice membership, runtime, target and requested model/effort. The receipt is
included in operation idempotence; it cannot silently replace explicit flags.

## Evidence and limits

On 2026-09-30, Codex 0.159.2 on xlmini was checked using a temporary shared Unix
listener, with no inference turn. Initialization and model/list succeeded;
`gpt-6-astra/xhigh` and `gpt-6-luna/low` were exposed. A native-create call produced
thread `01a0f252-1fc2-7821-af00-20c1475058bf`; a second connection read the same idle
Bridge-owned thread. The temporary service was stopped after the probe. This is
transport/creation evidence, not deployment, inference completion, or desktop wake.

Automated checks cover target/catalog/busy rejection, request idempotence, pause,
unknown delivery and exact readback reconciliation, cancellation, native/Web pool
separation, worker result provenance, and separate owner ACK. Production acceptance
requires a dedicated deployed service plus a bounded native artifact/result/ACK
canary. No private desktop IPC writes are implemented.
