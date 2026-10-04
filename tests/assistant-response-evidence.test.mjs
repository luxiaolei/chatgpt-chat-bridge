import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as pathMod from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
const source=await fs.readFile("src/main.js","utf8");
const start=source.indexOf("async function assistantResponseEvidence(");
const code=source.slice(start,source.indexOf("\nasync function emitTaskEvent",start));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
test("assistant event has explicit unknown parent and full hash without invented linkage",async()=>{
  const dir=await fs.mkdtemp(pathMod.join(os.tmpdir(),"assistant-evidence-"));
  try {
    const fn=await new AsyncFunction("fs","pathMod","crypto","STATE_DIR",code+";return assistantResponseEvidence;")(fs,pathMod,crypto,dir);
    const text='{"rpc":"中文","quoted":"\\\\n\\""}',task={project:"P",account:"a",sessionId:"sid"};
    const out=await fn(task,{lastAssistantId:"aid",lastAssistant:text,lastAssistantTextSource:"message-bound-markdown-source",
      assistantMessageBinding:{parentUserMessageId:"fabricated"},lastUserId:"adjacent"});
    assert.equal(out.assistantMessageBinding,null);
    assert.equal(out.assistantMessageBindingCondition,"NATIVE_PARENT_ASSOCIATION_UNAVAILABLE");
    assert.equal(out.assistantText,text);assert.equal(out.assistantTextTruncated,false);assert.equal(out.assistantTextRef,null);
    assert.equal(out.assistantTextSha256,crypto.createHash("sha256").update(text).digest("hex"));
    assert.deepEqual(await fs.readdir(dir),[]);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test("oversized escaped Unicode event retains immutable complete text and bounded preview",async()=>{
  const dir=await fs.mkdtemp(pathMod.join(os.tmpdir(),"assistant-evidence-"));
  try {
    const fn=await new AsyncFunction("fs","pathMod","crypto","STATE_DIR",code+";return assistantResponseEvidence;")(fs,pathMod,crypto,dir);
    const task={project:"P",account:"a",sessionId:"sid"};
    const text='😀中文\u0000"\\'.repeat(30000);
    const observed={lastAssistantId:"aid",lastAssistant:text,lastAssistantTextSource:"message-bound-markdown-source"};
    const out=await fn(task,observed);
    assert.equal(out.assistantTextTruncated,true);assert.ok(Buffer.byteLength(JSON.stringify(out))<262144);
    assert.equal(out.assistantTextUtf16Length,text.length);assert.equal(out.assistantTextUtf8Bytes,Buffer.byteLength(text));
    const bytes=await fs.readFile(out.assistantTextRef.path,"utf8"),doc=JSON.parse(bytes);
    assert.equal(doc.text,text);assert.equal(doc.assistantId,"aid");assert.equal(doc.sessionId,"sid");
    assert.equal(doc.assistantTextSha256,out.assistantTextSha256);
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),out.assistantTextRef.sha256);
    assert.equal((await fs.stat(out.assistantTextRef.path)).mode&0o777,0o600);
    const again=await fn(task,observed);assert.deepEqual(again,out);
    await fs.writeFile(out.assistantTextRef.path,"corrupted");
    await assert.rejects(fn(task,observed));
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
