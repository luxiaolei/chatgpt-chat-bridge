# Constrained Luna routing

`chat-bridge route judge REQUEST.json` runs the signed-in local Codex CLI with
GPT-6 Luna / low effort. It disables tools and user plugins, uses an ephemeral
read-only workspace, and returns a structured receipt. It does not dispatch.
There is no API key, paid gateway, fallback model or new business scheduler.

The request is `{"version":1,"task":"the exact task envelope","choices":[...]}`.
Supply one to eight authorized choices, each with `id`, `runtime`, `model` and
`effort`, plus an optional `description`. A `web` choice requires an existing
`sessionRef`; a `codex` choice requires verified `nativeHost`, `nativeThread`,
`nativeCwd` and `nativeSocket`. Use absolute paths. The task is limited to 16000
characters and choices to 12000 bytes. Business role and Project remain the
controller's explicit selections.

Add `--luna-select REQUEST.json` to an ordinary `queue submit` to select from
those choices and send through the existing coordinator. Every explicit
runtime, target, model or effort flag filters the candidate set first, so
judgment cannot override a deliberate choice. No matching choice, malformed
output, unavailable Luna or unsupported runtime fails before sending.
The selected worker model is still capability-checked by its target adapter;
an advisory receipt is not proof that a model or target is available.

Receipts are saved under `STATE/routing-advice/` and in the operation. Repeating
the same caller/request uses the original receipt; changing its input gives
`IDEMPOTENCY_CONFLICT`. The coordinator still owns identity, pause/drain,
placement, delivery uncertainty, results and exact controller acceptance.
Luna cannot invent a target, close work, ACK a result or clear a pause.
