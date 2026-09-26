import test from "node:test";
import assert from "node:assert/strict";
import "../src/page-pool.js";

const { pageDetachCandidates, orphanManagedPageCandidates } = globalThis.__CHAT_BRIDGE_PAGE_POOL__;

const chats = [
  { id: "a", role: "00-g", project: "HZ OS", account: "default", status: "active", page: "p20", lastUsedAt: "2026-09-23T01:00:00Z" },
  { id: "b", role: "00-s", project: "HZ OS", account: "default", status: "active", page: "p21", lastUsedAt: "2026-09-23T02:00:00Z" },
  { id: "c", role: "worker", project: "HZ OS", account: "default", status: "active", page: "p22", lastUsedAt: "2026-09-23T03:00:00Z" },
  { id: "d", role: "other", project: "Other", account: "default", status: "active", page: "p30" },
  { id: "e", role: "retired", project: "HZ OS", account: "default", status: "retired", page: "p31" },
];

test("idle candidates are oldest first", () => {
  const out = pageDetachCandidates(chats, [], { project: "HZ OS", account: "default" });
  assert.deepEqual(out.map(x => x.id), ["a", "b", "c"]);
});

test("active task session is protected", () => {
  const out = pageDetachCandidates(chats, [
    { status: "RUNNING", project: "HZ OS", account: "default", sessionId: "a", role: "00-g" },
  ], { project: "HZ OS", account: "default" });
  assert.deepEqual(out.map(x => x.id), ["b", "c"]);
});

test("role-bound active task without session id is protected", () => {
  const out = pageDetachCandidates(chats, [
    { status: "DISPATCHED", project: "HZ OS", role: "00-s" },
  ], { project: "HZ OS", account: "default" });
  assert.deepEqual(out.map(x => x.id), ["a", "c"]);
});

test("terminal tasks do not pin a page", () => {
  const out = pageDetachCandidates(chats, [
    { status: "COMPLETE", project: "HZ OS", sessionId: "a" },
  ], { project: "HZ OS", account: "default" });
  assert.equal(out[0].id, "a");
});

test("control page, active tab and target chat are excluded", () => {
  const out = pageDetachCandidates(chats, [], {
    project: "HZ OS",
    account: "default",
    controlPage: "p20",
    excludePageLabels: ["p21"],
    excludeChatIds: ["c"],
  });
  assert.deepEqual(out, []);
});


test("orphan managed page fallback only returns inactive Agent-created unprotected pages", () => {
  const pages=[{label:"p1"},{label:"p2"},{label:"p3"},{label:"p4"}];
  const tabs=[
    {label:"p1",active:false,openedBy:"agent"},
    {label:"p2",active:true,openedBy:"agent"},
    {label:"p3",active:false,openedBy:"unknown"},
    {label:"p4",active:false,openedBy:"agent"},
  ];
  assert.deepEqual(orphanManagedPageCandidates(pages,tabs,{protectedPageLabels:["p4"]}).map(p=>p.label),["p1"]);
  assert.deepEqual(orphanManagedPageCandidates(pages,tabs,{hasLiveTasks:true}),[]);
});
