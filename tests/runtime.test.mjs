import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRuntime, createTurnEventStream} from "../src/runtime.js";

test("runtime exposes a typed stream probe without pretending CLI polling is streaming", async () => {
  const bridge = createRuntime({bin: process.execPath});
  const probe = await bridge.probe({capability: "stream"});
  assert.deepEqual(probe, {ok: true, capability: "stream", supported: false, transport: "cli-subprocess", reason: "NO_INCREMENTAL_TRANSPORT"});
  const unsupported = await bridge.stream({requestId: "r1", turnId: "t1"});
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED");
  assert.equal(unsupported.error.transport, "cli-subprocess");
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
