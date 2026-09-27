import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const source=await readFile(path.resolve("src/main.js"),"utf8");
const begin=source.indexOf("async function reclaimOrphanManagedPage");
const end=source.indexOf("\nasync function newManagedPage",begin);
assert.ok(begin>=0&&end>begin);
const code=source.slice(begin,end);
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;

async function run(snapshot) {
  let closed=0;
  const page={label:"p1",close:async()=>{closed++}};
  const task={spaceId:7,pages:async()=>[page],tabs:async()=>[{label:"p1",active:false,openedBy:"agent"}]};
  const reclaim=await new AsyncFunction("loadRuntime","activeTaskStatus","orphanManagedPageCandidates","state",
    code+";return reclaimOrphanManagedPage;")(
      async()=>({tasks:{}}),
      status=>!["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"].includes(String(status).toUpperCase()),
      (pages,tabs)=>pages.filter(candidate=>candidate.label===tabs[0].label&&!tabs[0].active&&tabs[0].openedBy==="agent"),
      async()=>snapshot,
    );
  const result=await reclaim({},task,{spaceName:"managed",spaceId:7});
  return {result,closed};
}

test("orphan reclaim preserves a generating page",async()=>{
  const out=await run({generating:true,composerText:""});
  assert.equal(out.closed,0);
  assert.equal(out.result,null);
});

test("orphan reclaim preserves a drafted page and closes a blank page",async()=>{
  const drafted=await run({generating:false,composerText:"keep this draft"});
  assert.equal(drafted.closed,0);
  assert.equal(drafted.result,null);
  const blank=await run({generating:false,composerText:""});
  assert.equal(blank.closed,1);
  assert.deepEqual(blank.result,{page:"p1",reason:"orphan-managed"});
});
