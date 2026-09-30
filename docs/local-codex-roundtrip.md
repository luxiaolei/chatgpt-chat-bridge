# Local Codex → ChatGPT Chat → local result

Scope: first-version acceptance agreed on 2026-09-30. ChatGPT cloud Work is
excluded. Native Codex target dispatch, Luna automatic route selection and MCP
Events are later stages, not prerequisites for this round trip.

## Plan and contract

1. Persist the exact local Codex owner in the existing dispatch operation.
2. Dispatch explicitly to one verified ChatGPT Project/session, preserving
   existing account, model, capacity, pause and delivery-unknown checks.
3. Have that Chat verify its authorized Computer connection and perform one
   bounded local-resource task.
4. Record the Worker's result in existing `task_results`. Keep it `WAITING_LOCAL`
   until the original local thread reads the evidence and ACKs.
5. Run repository checks, install the verified files, perform one real canary,
   and record separate dispatch, artifact, result and ACK receipts.

`callerRef=codex:<CODEX_THREAD_ID>` is reserved for local callers. Submit requires
an explicit Project and registered session; the thread ID must match the calling
process environment and tunnel-origin callers are rejected. The operation saves
the thread ID, local hostname, original cwd and `transport=local-pull` in a nullable
`local_owner` column. Existing Web dispatch rows retain null and their old behavior.

The browser runtime validates local owner/task/project/target against the saved
operation before tracking a send. Result routing reads that immutable contract
rather than guessing a Web controller. No extra registry or result store exists.

`queue receive --task … --caller-ref codex:… --wait-seconds 50` is a bounded local
SQLite wait (maximum 55 seconds). It returns the exact result version and event
ID as tool data, without consuming it or marking it delivered. A resumed caller
can replay the same read. ACK verifies the original host/thread, records
`RECEIVED_LOCAL`, then applies the existing acceptance rules. The original cwd is
provenance; a resumed thread may execute commands from another directory.

## Deliberate limits

- This accepts results inside an active/resumed Codex caller. It does not wake a
  closed App or start a background Codex turn; app-server push remains unverified.
- Thread IDs and environment hints are routing guards, not a sandbox against
  processes that already share the OS user's filesystem and credentials.
- First-version local submit requires an existing Web session. Discover/create
  a suitable authorized session first; it does not create a native Codex target.
- Model/effort come from the caller or existing session. No Luna inference is
  inserted into the dispatch path.
- Worker completion and owner acceptance remain separate. Delivery-unknown is
  never blindly retried, and unavailable Computer tools produce BLOCKED evidence.

## Verification

- `npm run check`: passed.
- `npm test`: 211 tests passed; static and pacing/cooldown checks passed.
- Regression covers process-restart persistence, repeated submit/result/read/ACK,
  no Web fallback, thread/tunnel/target/project mismatch, stale runtime ownership,
  bounded waits and acceptance updating the task to COMPLETE.
- Installed with the existing installer. Source and installed SHA-256 match:
  coordinator `23a554a864c2eb786a3df31e5fbaeb4b792f4b2d0eb9b1b595f72cd1e70871c5`;
  main `015f569f72ac80abeeea9b2dfc724061c45217417410f76d0447c092549eed77`.
- Native CLI 0.159.2 read-only probe: `model/list` exposes GPT-6 Luna and Astra
  with supported effort options. `thread/read` finds the original local caller;
  it is `notLoaded` in this separate probe process. This proves persisted thread
  discovery, not a connection to the App's active runtime. No thread was resumed
  and no inference turn was started by this probe.
- Live Web discovery: `LiteLLM Web Probe` is accessible in the verified hzcodex
  binding. Both old probe sessions are retired. A new canary session attempt with
  `GPT-6 Luna` stopped at `PRE_SEND / Unavailable model selection`.
- The observed Web model menu contains `Latest`, `GPT-5.6 Sol`, `GPT-5.5`; it does
  not offer Luna or Astra. No fallback or task message was sent. Awaiting the
  user's decision on using `Latest + Extra High` for this one live canary.
- Prepared a random local challenge whose contents are absent from the Worker
  prompt. Live acceptance must verify the Worker's file, challenge hash and nonce,
  saved result, exact original owner and ACK. This part is still pending.
