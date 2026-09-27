import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRuntime} from "../src/runtime.js";

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
