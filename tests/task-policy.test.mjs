import test from "node:test";
import assert from "node:assert/strict";
import "../src/task-policy.js";

const {
  activeTaskStatus,
  assertTaskId,
  assertActiveTaskTarget,
  activeSessionConflict,
} = globalThis.__CHAT_BRIDGE_TASK_POLICY__;

test("stable task IDs are accepted", () => {
  for (const id of ["HZ-CTRL-T-001", "a.b:c_1", "T1"]) assert.equal(assertTaskId(id), id);
});

test("option-shaped and malformed task IDs are rejected", () => {
  for (const id of ["--help", "-x", "", " has space ", "/slash"]) {
    assert.throws(() => assertTaskId(id));
  }
});

test("active targetless task is rejected but terminal history may be targetless", () => {
  assert.throws(() => assertActiveTaskTarget({ status: "RUNNING", role: null, sessionId: null }));
  assert.doesNotThrow(() => assertActiveTaskTarget({ status: "COMPLETE", role: null, sessionId: null }));
});

test("second active task on same session is rejected", () => {
  const tasks = [
    { taskId: "A", status: "RUNNING", project: "HZ OS", account: "default", sessionId: "s1" },
  ];
  const conflict = activeSessionConflict(tasks, {
    taskId: "B", status: "DISPATCHED", project: "HZ OS", account: "default", sessionId: "s1",
  });
  assert.equal(conflict?.taskId, "A");
});

test("same task update and terminal prior task do not conflict", () => {
  const active = [{ taskId: "A", status: "RUNNING", project: "HZ OS", sessionId: "s1" }];
  assert.equal(activeSessionConflict(active, {
    taskId: "A", status: "RECOVERING", project: "HZ OS", sessionId: "s1",
  }), null);

  const terminal = [{ taskId: "A", status: "COMPLETE", project: "HZ OS", sessionId: "s1" }];
  assert.equal(activeSessionConflict(terminal, {
    taskId: "B", status: "RUNNING", project: "HZ OS", sessionId: "s1",
  }), null);
});

test("blocked is terminal for watchdog/admission purposes", () => {
  assert.equal(activeTaskStatus("BLOCKED"), false);
  assert.equal(activeTaskStatus("AWAITING_DURABLE_UPDATE"), true);
});
