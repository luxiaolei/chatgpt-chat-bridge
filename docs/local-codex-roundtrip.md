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
  not offer Luna or Astra. The user explicitly approved `Latest + Extra High`
  for this one live canary. UI selection was verified before dispatch; the
  underlying model version is not inferred from Latest.

## Live acceptance — passed, 2026-09-30

The canary used an ordinary Chat in `LiteLLM Web Probe`, not cloud Work. The Chat
connected through `ChatGPT Computer - HZCodex` to host `xlmini`, read the local
challenge and repository instructions, wrote the bounded evidence file, and
itself ran the installed `queue result` command. The controller did not create
the Worker's evidence or submit its result on its behalf.

| Receipt | Observed value |
| --- | --- |
| Code under test | `3691b60c0598eeb464489f43c8970c97b9dbd6d7` |
| Task | `CB-LOCAL-20260930-01` |
| Dispatch operation | `ea42967d-d4ee-4ac1-9fd5-0938d4257111` |
| Worker Chat | `6abc7583-3060-83ee-b346-55eba4564587` |
| Original local thread | `01a0efdf-e8de-7870-a3ef-88f0b4d99ba4` |
| Requested / verified UI selection | `Latest / Extra High` |
| Dispatch | `SENT`, one attempt, 2026-09-30 02:36:33 UTC |
| Worker evidence timestamp | 2026-09-30 02:38:37 UTC |
| Result event | `result:CB-LOCAL-20260930-01:1` |
| Before owner ACK | `WAITING_LOCAL`, no acceptance |
| After verification and ACK | `RECEIVED_LOCAL`, `ACCEPTED`, task `COMPLETE` |

The controller independently checked the challenge nonce, byte-level SHA-256,
host, repository path, Git remote, code HEAD, timestamp and original owner. The
challenge contents were absent from the dispatched prompt. Its SHA-256 was
`4157075e592123bc08d7fa1810e91abf2e762d3c4c79a10f6185a34fc37598fe`.

Local receipts are retained at
`~/.local/state/chat-bridge/canaries/CB-LOCAL-20260930-01/`: `dispatch-receipt.json`,
`evidence.json`, `received.json`, `verification.json`, `ack.json`,
`accepted-result.json`, and `accepted-dispatch.json`.

This accepts the scoped first-version round trip for the tested account/host.
It does not establish background App wake-up, MCP Events push, autonomous Luna
routing, native Codex target dispatch or reliability across every account/model.
