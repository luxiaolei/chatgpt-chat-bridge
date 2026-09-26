import test from "node:test";
import assert from "node:assert/strict";
import "../src/control-routing.js";

const { controlRoute, notificationTargets, resolveControllerTarget } = globalThis.__CHAT_BRIDGE_CONTROL__;

test("single-conductor projects stay backward compatible", () => {
  assert.deepEqual(controlRoute({}, "conductor"), {
    controller: "conductor",
    replyTo: "conductor",
    escalationTo: null,
    rootController: "conductor",
  });
  assert.deepEqual(notificationTargets({}, "conductor"), ["conductor"]);
});

test("domain task routes to domain controller before root", () => {
  const task = { controller: "00-s" };
  assert.deepEqual(controlRoute(task, "00-g"), {
    controller: "00-s",
    replyTo: "00-s",
    escalationTo: "00-g",
    rootController: "00-g",
  });
  assert.deepEqual(notificationTargets(task, "00-g"), ["00-s", "00-g"]);
});
test("explicit reply target is tried before controller", () => {
  const task = { controller: "00-s", replyTo: "review-s", escalationTo: "00-g" };
  assert.deepEqual(notificationTargets(task, "00-g"), ["review-s", "00-s", "00-g"]);
});

test("duplicate or self escalation is removed", () => {
  assert.deepEqual(notificationTargets({
    controller: "00-g",
    replyTo: "00-g",
    escalationTo: "00-g",
  }, "00-g"), ["00-g"]);
});

test("snake case envelope-compatible keys are accepted", () => {
  const route = controlRoute({ reply_to: "00-f", escalation_to: "00-g" }, "00-g");
  assert.equal(route.controller, "00-f");
  assert.equal(route.replyTo, "00-f");
  assert.equal(route.escalationTo, "00-g");
});

test("blank values do not shadow project root", () => {
  assert.deepEqual(notificationTargets({
    controller: " ", replyTo: "", escalationTo: null,
  }, "00-g"), ["00-g"]);
});

test('exact controller session wins across accounts and duplicate roles fail closed', () => {
  const chats = {
    a: { id: 'a', project: 'P', account: 'alpha', role: 'conductor', status: 'active' },
    b: { id: 'b', project: 'P', account: 'beta', role: 'conductor', status: 'active' },
  };
  assert.equal(resolveControllerTarget(chats, 'a', 'P').id, 'a');
  assert.equal(resolveControllerTarget(chats, 'a', 'another-project').id, 'a');
  assert.equal(resolveControllerTarget(chats, 'conductor', 'P', 'beta').id, 'b');
  assert.throws(() => resolveControllerTarget(chats, 'conductor', 'P'), /AMBIGUOUS_CONTROLLER/);
  assert.throws(() => resolveControllerTarget(chats, 'unknown', 'P'), /UNKNOWN_CONTROLLER/);
});
