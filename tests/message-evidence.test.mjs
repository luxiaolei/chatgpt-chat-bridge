import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
const start=source.indexOf("function normalizedEvidenceText");
const end=source.indexOf("\nasync function state",start);
const {normalize,expand}=new Function(source.slice(start,end)+
  ";return {normalize:normalizedEvidenceText,expand:expandEvidenceMessages};")();

test("evidence expands only user messages and strips UI disclosure labels",async()=>{
  const message="[RESULT]\ntask_id: CB09-1\nsummary: done";
  assert.equal(normalize(message+"\nShow less"),normalize(message));
  assert.equal(normalize(message+"\nShow more"),normalize(message));
  let calls=0,waits=0;
  await expand({evaluate:async()=>++calls===1?1:0,waitForTimeout:async()=>{waits++;}});
  assert.equal(calls,2); assert.equal(waits,1);
});
