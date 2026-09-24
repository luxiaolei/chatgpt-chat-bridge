import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import "../src/event-journal.js";

const {appendEvent,listEvents,safeSegment}=globalThis.__CHAT_BRIDGE_EVENTS__;

test("project/account event journals are physically separated", async()=>{
  const state=await mkdtemp(path.join(tmpdir(),"bridge-events-"));
  const a=await appendEvent(state,{project:"Quant Company",account:"qc-alpha",type:"ASSISTANT_RESPONSE_READY",taskId:"T1",data:{assistantId:"A1"}});
  const b=await appendEvent(state,{project:"Other Project",account:"other",type:"ASSISTANT_RESPONSE_READY",taskId:"T2",data:{assistantId:"A2"}});
  const qa=await listEvents(state,{project:"Quant Company",account:"qc-alpha"});
  const ob=await listEvents(state,{project:"Other Project",account:"other"});
  assert.equal(qa.length,1); assert.equal(qa[0].taskId,"T1"); assert.equal(qa[0].cursor,a.cursor);
  assert.equal(ob.length,1); assert.equal(ob[0].taskId,"T2"); assert.equal(ob[0].cursor,b.cursor);
  const qraw=await readFile(path.join(state,"events",safeSegment("Quant Company"),safeSegment("qc-alpha")+".jsonl"),"utf8");
  const oraw=await readFile(path.join(state,"events",safeSegment("Other Project"),safeSegment("other")+".jsonl"),"utf8");
  assert.match(qraw,/"taskId":"T1"/); assert.doesNotMatch(qraw,/"taskId":"T2"/);
  assert.match(oraw,/"taskId":"T2"/); assert.doesNotMatch(oraw,/"taskId":"T1"/);
});

test("event cursor resumes within one project/account stream", async()=>{
  const state=await mkdtemp(path.join(tmpdir(),"bridge-events-"));
  const one=await appendEvent(state,{project:"P",account:"a",type:"TASK_DISPATCHED",taskId:"T1"});
  const two=await appendEvent(state,{project:"P",account:"a",type:"ASSISTANT_RESPONSE_READY",taskId:"T1"});
  const rows=await listEvents(state,{project:"P",account:"a",after:one.cursor});
  assert.equal(rows.length,1);
  assert.equal(rows[0].cursor,two.cursor);
  assert.equal(rows[0].type,"ASSISTANT_RESPONSE_READY");
});
