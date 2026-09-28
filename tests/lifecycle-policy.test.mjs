import test from "node:test";
import assert from "node:assert/strict";
import "../src/lifecycle-policy.js";

const { normalizeLifecycle, reconcileCandidate, reconcileCandidates } = globalThis.__CHAT_BRIDGE_LIFECYCLE_POLICY__;

test("lifecycle defaults are conservative", () => {
  assert.deepEqual(normalizeLifecycle({ rootController: "00-g" }), {
    autoReconcile: false,
    reconcileRole: "00-g",
    minGapSec: 300,
    instruction: null,
  });
});

test("idle project with new durable completion produces reconcile event", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true, minGapSec: 0 } };
  const tasks = [
    { taskId: "S-1", project: "HZ OS", role: "00-s", controller: "00-s", status: "COMPLETE",
      github: "https://example/1", updatedAt: "2026-09-24T06:51:09Z" },
    { taskId: "G-1", project: "HZ OS", role: "00-g", controller: "00-g", status: "AWAITING_DURABLE_UPDATE" },
  ];
  const out = reconcileCandidate("HZ OS", project, tasks, {}, Date.parse("2026-09-24T07:00:00Z"));
  assert.equal(out?.event, "RECONCILE_REQUIRED");
  assert.equal(out?.latestTaskId, "S-1");
  assert.equal(out?.ready, true);
});

test("active domain work suppresses reconcile", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true } };
  const tasks = [
    { taskId: "S-1", project: "HZ OS", role: "00-s", status: "RUNNING" },
    { taskId: "C-1", project: "HZ OS", role: "00-c", status: "COMPLETE",
      github: "https://example/2", updatedAt: "2026-09-24T06:00:00Z" },
  ];
  assert.equal(reconcileCandidate("HZ OS", project, tasks, {}), null);
});

test("same durable progress is deduped", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true } };
  const tasks = [{ taskId: "S-1", project: "HZ OS", role: "00-s", status: "COMPLETE",
    github: "https://example/1", updatedAt: "2026-09-24T06:51:09Z" }];
  const runtime = { lastReconcileProgressAt: "2026-09-24T06:51:09Z" };
  assert.equal(reconcileCandidate("HZ OS", project, tasks, runtime), null);
});

test("minimum gap defers but preserves pending event", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true, minGapSec: 300 } };
  const tasks = [{ taskId: "S-1", project: "HZ OS", role: "00-s", status: "COMPLETE",
    github: "https://example/1", updatedAt: "2026-09-24T06:51:09Z" }];
  const runtime = { lastReconcileNotifiedAt: "2026-09-24T06:58:00Z" };
  const out = reconcileCandidate("HZ OS", project, tasks, runtime, Date.parse("2026-09-24T07:00:00Z"));
  assert.equal(out?.ready, false);
  assert.equal(Math.round(out?.waitSec), 180);
});

test("workgroup reconcile ignores another workgroup's active task", () => {
  const project = {
    rootController: "00-g",
    lifecycle: { autoReconcile: true, minGapSec: 0 },
    workgroups: { A: { controllerSessionRef: "owner-a" }, B: { controllerSessionRef: "owner-b" } },
  };
  const tasks = [
    { taskId: "A-1", project: "P", workgroupId: "A", role: "worker", status: "COMPLETE",
      github: "https://example/a", updatedAt: "2026-09-24T07:00:00Z" },
    { taskId: "B-1", project: "P", workgroupId: "B", role: "worker", status: "RUNNING" },
  ];
  const a = reconcileCandidate("P", project, tasks, {}, Date.parse("2026-09-24T08:00:00Z"),
    { workgroupId: "A", ownerSessionRef: "owner-a" });
  assert.equal(a?.workgroupId, "A");
  assert.equal(a?.ownerSessionRef, "owner-a");
  assert.equal(reconcileCandidate("P", project, tasks, {}, Date.now(), { workgroupId: "B", ownerSessionRef: "owner-b" }), null);
  assert.deepEqual(reconcileCandidates("P", project, tasks, {}, Date.parse("2026-09-24T08:00:00Z")).map(x => x.workgroupId), ["A"]);
});

test("group result recorded wakes its owner without requiring ACK", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true, minGapSec: 0 },
    workgroups: { A: { controllerSessionRef: "owner-a" }, B: { controllerSessionRef: "owner-b" } } };
  const tasks = [
    { taskId: "A-1", project: "P", workgroupId: "A", role: "worker", status: "RESULT_RECORDED",
      resultVersion: "1", resultRecordedAt: "2026-09-24T07:00:00Z" },
    { taskId: "B-1", project: "P", workgroupId: "B", role: "worker", status: "RUNNING" },
  ];
  const a = reconcileCandidate("P", project, tasks, {}, Date.parse("2026-09-24T08:00:00Z"),
    { workgroupId: "A", ownerSessionRef: "owner-a" });
  assert.equal(a?.resultVersion, "1");
  assert.equal(a?.latestTaskId, "A-1");
});

test("legacy reconcile remains independent from grouped work", () => {
  const project = { rootController: "00-g", lifecycle: { autoReconcile: true, minGapSec: 0 },
    workgroups: { A: { controllerSessionRef: "owner-a" } } };
  const tasks = [
    { taskId: "legacy-1", project: "P", role: "worker", status: "COMPLETE", github: "https://example/legacy", updatedAt: "2026-09-24T07:00:00Z" },
    { taskId: "A-1", project: "P", workgroupId: "A", role: "worker", status: "RUNNING" },
  ];
  const legacy = reconcileCandidate("P", project, tasks, {}, Date.parse("2026-09-24T08:00:00Z"), { legacyOnly: true });
  assert.equal(legacy?.latestTaskId, "legacy-1");
});
