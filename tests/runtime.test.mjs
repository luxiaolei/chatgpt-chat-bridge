import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRuntime, createTurnEventStream, createToolResultStream} from "../src/runtime.js";

test("runtime exposes a typed stream probe without pretending CLI polling is streaming", async () => {
  const bridge = createRuntime({bin: process.execPath});
  const probe = await bridge.probe({capability: "stream"});
  assert.deepEqual(probe, {ok: true, capability: "stream", supported: false, transport: "cli-subprocess", reason: "NO_INCREMENTAL_TRANSPORT"});
  const unsupported = await bridge.stream({requestId: "r1", turnId: "t1"});
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED");
  assert.equal(unsupported.error.transport, "cli-subprocess");
});

test("image parts stay behind a typed unsupported boundary without invoking the CLI", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-image-"));
  const fake = path.join(dir, "bridge");
  const marker = path.join(dir, "invoked");
  await writeFile(fake, `#!/bin/sh
touch "${marker}"
exit 0
`, {mode: 0o755});
  try {
    const bridge = createRuntime({bin: fake});
    assert.deepEqual(await bridge.probe({capability: "imageParts"}), {
      ok: true, capability: "imageParts", supported: false,
      transport: "cli-subprocess", reason: "NO_SAFE_LOCAL_IMAGE_UPLOAD"
    });
    const result = await bridge.sendParts({target: "worker", parts: [
      {type: "text", text: "inspect this"},
      {type: "image", path: "/tmp/photo.png", mimeType: "image/png"}
    ]});
    assert.equal(result.error.code, "UNSUPPORTED");
    assert.equal(result.error.capability, "imageParts");
    await assert.rejects(import("node:fs/promises").then(({access}) => access(marker)), {code: "ENOENT"});
    assert.equal((await bridge.sendParts({target: "worker", parts: [{type: "image", url: "https://example.invalid/a.png"}]})).error.code, "IMAGE_REMOTE_URL_FORBIDDEN");
    assert.equal((await bridge.sendParts({target: "worker", parts: [{type: "image", data: "AAAA"}]})).error.code, "IMAGE_DATA_FORBIDDEN");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("turn event stream enforces correlation, sequence, terminal state, and assistant freshness", () => {
  const stream = createTurnEventStream({requestId: "r1", turnId: "t1", assistantMessageId: "a2"});
  assert.equal(stream.push({requestId: "r1", turnId: "t1", sequence: 1, type: "delta", assistantMessageId: "a2", delta: "hi"}).ok, true);
  assert.equal(stream.push({requestId: "r1", turnId: "t1", sequence: 2, type: "delta", assistantMessageId: "a1", delta: "old"}).error.code, "STALE_ASSISTANT_CONTENT");
  assert.equal(stream.push({requestId: "r1", turnId: "t1", sequence: 2, type: "progress", progress: {state: "running"}}).ok, true);
  assert.equal(stream.push({requestId: "r1", turnId: "t1", sequence: 3, type: "terminal", terminal: {status: "completed"}}).ok, true);
  assert.equal(stream.push({requestId: "r1", turnId: "t1", sequence: 4, type: "delta", assistantMessageId: "a2", delta: "late"}).error.code, "EVENT_AFTER_TERMINAL");
  assert.equal(stream.push({requestId: "r1", turnId: "other", sequence: 5, type: "progress", progress: {state: "running"}}).error.code, "TURN_CORRELATION_MISMATCH");
});

test("tool result boundary binds IDs/schema/name and emits duplicate, stale, and error receipts", () => {
  const stream = createToolResultStream({requestId: "r1", turnId: "t1", toolCallId: "call1", toolName: "lookup", schemaId: "lookup.v1"});
  assert.equal(stream.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 1, type: "progress", progress: {state: "running"}}).ok, true);
  assert.equal(stream.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 1, type: "progress", progress: {state: "old"}}).error.code, "STALE_TOOL_RESULT");
  assert.equal(stream.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 3, type: "result", resultId: "res1", toolName: "lookup", schemaId: "lookup.v1", result: {value: 1}}).error.code, "TOOL_SEQUENCE_GAP");
  assert.equal(stream.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 2, type: "result", resultId: "res1", toolName: "lookup", schemaId: "lookup.v1", result: {value: 1}}).ok, true);
  assert.equal(stream.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 3, type: "result", resultId: "res1", toolName: "lookup", schemaId: "lookup.v1", result: {value: 1}}).error.code, "DUPLICATE_TOOL_RESULT");
  const wrongBinding = createToolResultStream({requestId: "r1", turnId: "t1", toolCallId: "call1", toolName: "lookup", schemaId: "lookup.v1"});
  assert.equal(wrongBinding.push({requestId: "r1", turnId: "t1", toolCallId: "call1", sequence: 1, type: "result", resultId: "res2", toolName: "other", schemaId: "lookup.v1", result: {}}).error.code, "TOOL_BINDING_MISMATCH");
  const error = createToolResultStream({requestId: "r1", turnId: "t1", toolCallId: "call2", toolName: "lookup", schemaId: "lookup.v1"});
  assert.equal(error.push({requestId: "r1", turnId: "t1", toolCallId: "call2", sequence: 1, type: "error", resultId: "res3", toolName: "lookup", schemaId: "lookup.v1", error: {code: "TOOL_FAILED", message: "upstream"}}).ok, true);
  assert.equal(error.push({requestId: "r1", turnId: "t1", toolCallId: "call2", sequence: 2, type: "result", resultId: "res4", toolName: "lookup", schemaId: "lookup.v1", result: {}}).error.code, "TOOL_RESULT_AFTER_TERMINAL");
});

test("tool result capability stays unsupported and never executes a host command", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-tool-"));
  const fake = path.join(dir, "bridge");
  const marker = path.join(dir, "invoked");
  await writeFile(fake, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, {mode: 0o755});
  try {
    const bridge = createRuntime({bin: fake});
    assert.deepEqual(await bridge.probe({capability: "toolResults"}), {
      ok: true, capability: "toolResults", supported: false,
      transport: "cli-subprocess", reason: "NO_NATIVE_TOOL_EVENT_TRANSPORT"
    });
    const result = await bridge.submitToolResult({requestId: "r1", turnId: "t1", toolCallId: "call1", resultId: "res1"});
    assert.equal(result.error.code, "UNSUPPORTED");
    assert.equal(result.error.capability, "toolResults");
    await assert.rejects(import("node:fs/promises").then(({access}) => access(marker)), {code: "ENOENT"});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("timeout and stop receipts distinguish local process from remote generation", async () => {
  const hanging = path.join(await mkdtemp(path.join(tmpdir(), "bridge-runtime-timeout-")), "bridge");
  await writeFile(hanging, "#!/bin/sh\nsleep 2\n", {mode: 0o755});
  try {
    const result = await createRuntime({bin: hanging, timeoutMs: 20}).send({target: "worker", message: "hello"});
    assert.equal(result.error.code, "RUNTIME_TIMEOUT");
    assert.equal(result.error.localProcess, "terminated");
    assert.equal(result.error.remoteGeneration, "unknown");
  } finally { await rm(path.dirname(hanging), {recursive: true, force: true}); }
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-stop-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, "#!/bin/sh\nprintf '%s\\n' '{\"ok\":true,\"stopped\":true}'\n", {mode: 0o755});
  try {
    const result = await createRuntime({bin: fake}).stop({target: "worker"});
    assert.equal(result.cancellation.localProcess, "exited");
    assert.equal(result.cancellation.remoteGeneration, "unknown");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("ask exposes the final-only synchronous path and validates its envelope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-ask-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "ask" ]; then printf '%s\\n' '{"chat":"worker","response":"done"}'; exit 0; fi
exit 2
`, {mode: 0o755});
  try {
    const bridge = createRuntime({bin: fake});
    const result = await bridge.ask({project: "P", target: "worker", message: "hello", timeout: 1000});
    assert.equal(result.data.response, "done");
    assert.equal(result.mode, "final-only");
    assert.equal(bridge.capabilities.ask, true);
    assert.equal((await bridge.ask({target: "worker"})).error.code, "INVALID_INPUT");
    assert.equal((await bridge.ask({target: "worker", message: "hello", timeout: 0})).error.code, "INVALID_INPUT");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("runtime facade resolves routes and returns structured command results", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "list" ]; then printf '%s\\n' '[{"id":"c1","name":"worker","role":"worker","project":"P","account":"a"}]'; exit 0; fi
if [ "$1" = "send" ]; then printf '%s\\n' '{"ok":true,"delivered":true}'; exit 0; fi
printf '%s\\n' '{"ok":true,"sessionState":"IDLE_COMPLETE"}'; exit 0
`, {mode: 0o755});
  try {
    const bridge = createRuntime({bin: fake});
    assert.equal(bridge.capabilities.stream, false);
    assert.deepEqual(await bridge.resolveRoute({project: "P", target: "worker"}), {ok: true, route: {project: "P", account: "a", sessionRef: "c1", role: "worker", name: "worker"}});
    assert.deepEqual((await bridge.send({project: "P", target: "worker", message: "hello"})).data.delivered, true);
    assert.equal((await bridge.stream()).error.code, "UNSUPPORTED");
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("runtime facade marks uncertain send failures", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-error-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, `#!/bin/sh
printf '%s\\n' '{"ok":false,"deliveryStage":"SEND_ATTEMPTED","code":"DELIVERY_UNCONFIRMED"}' >&2
exit 1
`, {mode: 0o755});
  try {
    const result = await createRuntime({bin: fake}).send({target: "worker", message: "hello"});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "DELIVERY_UNCONFIRMED");
    assert.equal(result.error.sendAttempted, true);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("runtime preserves pretty-printed stdout and stderr JSON receipts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-pretty-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "ask" ]; then
  cat <<'JSON'
{
  "chat": "worker",
  "response": "pretty done"
}
JSON
  exit 0
fi
if [ "$1" = "status" ]; then
  cat <<'JSON'
{
  "sessionState": "IDLE_COMPLETE",
  "lastAssistantId": "a2"
}
JSON
  exit 0
fi
cat >&2 <<'JSON'
{
  "ok": false,
  "code": "DELIVERY_UNCONFIRMED",
  "deliveryStage": "SEND_ATTEMPTED"
}
JSON
exit 1
`, {mode: 0o755});
  try {
    const bridge = createRuntime({bin: fake});
    const ask = await bridge.ask({target: "worker", message: "hello"});
    assert.equal(ask.data.response, "pretty done");
    const status = await bridge.status({target: "worker"});
    assert.equal(status.data.sessionState, "IDLE_COMPLETE");
    const send = await bridge.send({target: "worker", message: "hello"});
    assert.equal(send.error.code, "DELIVERY_UNCONFIRMED");
    assert.equal(send.error.sendAttempted, true);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("runtime preserves nested structured error receipts from gateway-facing commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-runtime-error-contract-"));
  const fake = path.join(dir, "bridge");
  await writeFile(fake, `#!/bin/sh
cat >&2 <<'JSON'
{
  "ok": false,
  "error": {
    "code": "ASK_FAILED",
    "message": "final response unavailable",
    "deliveryStage": "PRE_SEND"
  }
}
JSON
exit 1
`, {mode: 0o755});
  try {
    const result = await createRuntime({bin: fake}).ask({target: "worker", message: "hello"});
    assert.equal(result.error.code, "ASK_FAILED");
    assert.equal(result.error.message, "final response unavailable");
    assert.equal(result.error.deliveryStage, "PRE_SEND");
  } finally { await rm(dir, {recursive: true, force: true}); }
});
