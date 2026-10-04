import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
await import("../src/event-journal.js");
const {appendEvent,listEvents}=globalThis.__CHAT_BRIDGE_EVENTS__;
const source=await fs.readFile("src/main.js","utf8"),start=source.indexOf("async function assistantResponseEvidence(");
const code=source.slice(start,source.indexOf("\nasync function emitTaskEvent",start));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const evidence=await new AsyncFunction("crypto",code+";return assistantResponseEvidence;")(crypto);
const task={project:"P",account:"a",sessionId:"sid",taskId:"T"};
const event=async text=>({...task,type:"ASSISTANT_RESPONSE_READY",data:{...await evidence(task,{
  lastAssistantId:"aid",lastAssistant:text,lastAssistantTextSource:"message-bound-markdown-source",
  assistantMessageBinding:{parentUserMessageId:"fabricated"},lastUserId:"adjacent"}),sessionState:"IDLE_COMPLETE"}});
const sha=text=>crypto.createHash("sha256").update(text).digest("hex");

test("complete assistant events expose unknown ancestry and never fabricate linkage",async()=>{
  const text=JSON.stringify({op:"context",section:'中文 "\\n"'}),data=(await event(text)).data;
  assert.equal(data.assistantText,text);assert.equal(data.assistantTextTruncated,false);assert.equal(data.assistantTextRef,null);
  assert.equal(data.assistantTextSha256,sha(text));assert.equal(data.assistantMessageBinding,null);
  assert.equal(data.assistantMessageBindingCondition,"NATIVE_PARENT_ASSOCIATION_UNAVAILABLE");
});
test("60000 Chinese characters remain a complete valid RPC in the actual journal",async()=>{
  const dir=await fs.mkdtemp(pathMod.join(os.tmpdir(),"assistant-event-"));
  try {
    const text=JSON.stringify({op:"context",section:"中".repeat(60000)});
    assert.equal(text.length,60029);assert.equal(Buffer.byteLength(text),180029);
    const record=await appendEvent(dir,await event(text));
    assert.equal(record.type,"ASSISTANT_RESPONSE_READY");
    assert.equal(record.data.assistantText,text);assert.equal(record.data.assistantTextTruncated,false);
    assert.equal(JSON.parse(record.data.assistantText).section.length,60000);
    assert.equal(Buffer.byteLength(JSON.stringify(record))<=262144,true);
    assert.equal((await listEvents(dir,{project:"P",account:"a",type:"ASSISTANT_RESPONSE_READY"})).length,1);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test("metadata cannot shrink the previous complete event budget",async()=>{
  const dir=await fs.mkdtemp(pathMod.join(os.tmpdir(),"assistant-budget-"));
  try {
    const small=await appendEvent(dir,await event(""));
    const legacy={...small,data:{assistantId:"aid",assistantText:"",sessionState:"IDLE_COMPLETE"}};
    const text="x".repeat(262144-128-Buffer.byteLength(JSON.stringify(legacy)));
    const record=await appendEvent(dir,await event(text));
    assert.equal(record.type,"ASSISTANT_RESPONSE_READY");assert.equal(record.data.assistantText,text);
    assert.ok(Buffer.byteLength(JSON.stringify(record))<=262144);
    assert.equal(record.data.assistantTextSha256,undefined); // Only additive metadata was dropped.
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test("true overflow is unavailable to READY consumers and retains verified complete original",async()=>{
  const dir=await fs.mkdtemp(pathMod.join(os.tmpdir(),"assistant-reference-"));
  try {
    const text=JSON.stringify({op:"context",section:'😀中文\u0000"\\'.repeat(30000)});
    const input=await event(text),record=await appendEvent(dir,input);
    assert.equal(record.type,"ASSISTANT_RESPONSE_UNAVAILABLE");
    assert.equal(record.data.assistantText,null);assert.equal(record.data.assistantTextTruncated,true);
    assert.equal(record.data.sessionState,"RESPONSE_BODY_UNAVAILABLE");
    assert.equal((await listEvents(dir,{project:"P",account:"a",type:"ASSISTANT_RESPONSE_READY"})).length,0);
    assert.ok(Buffer.byteLength(JSON.stringify(record))<262144);
    const reference=record.data.assistantTextRef,bytes=await fs.readFile(reference.path,"utf8"),doc=JSON.parse(bytes);
    assert.equal(sha(bytes),reference.sha256);assert.equal(doc.text,text);
    assert.equal(doc.assistantId,"aid");assert.equal(doc.sessionId,"sid");assert.equal(doc.assistantTextSha256,sha(text));
    assert.equal((await fs.stat(reference.path)).mode&0o777,0o600);
    assert.deepEqual((await appendEvent(dir,input)).data,record.data);
    await fs.writeFile(reference.path,"corrupted");
    await assert.rejects(appendEvent(dir,input));
    await assert.rejects(appendEvent(dir,{...input,data:{...input.data,assistantTextSha256:"wrong"}}),/complete assistant text evidence/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
