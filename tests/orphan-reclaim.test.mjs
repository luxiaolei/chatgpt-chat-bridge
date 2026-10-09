import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import "../src/task-policy.js";
import "../src/session-policy.js";
const source=await readFile(path.resolve("src/main.js"),"utf8");
const begin=source.indexOf("async function reclaimOrphanManagedPage");
const end=source.indexOf("\nasync function newManagedPage",begin);
assert.ok(begin>=0&&end>begin);
const code="const physicalReleasePayload=(_r,_t,page,_b,_p,account,purpose,candidate)=>({account,candidate,resourceTarget:{purpose,page:page.label}});const releasePhysicalPage=async(_r,_t,page)=>page.close();"+'const {composerIsEmpty,draftDiscardProject}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n'+source.slice(begin,end);
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;

async function run(snapshot) {
  snapshot={approvalRequired:false,composerCount:1,composerAttachmentsEmpty:true,composerRawText:snapshot.composerText,...snapshot};
  let closed=0;
  const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project";
  const page={label:"p1",url:async()=>home,close:async()=>{closed++}};
  const task={spaceId:7,pages:async()=>[page],tabs:async()=>closed?[]:[{label:"p1",url:home,active:false,openedBy:"agent"}]};
  const reclaim=await new AsyncFunction("loadRuntime","activeTaskStatus","orphanManagedPageCandidates","state","projectHomeId","coordinated","sameConversationUrl","assertInputSafe","listTaskSpaces",
    code+";return reclaimOrphanManagedPage;")(
      async()=>({tasks:{}}),
      status=>!["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"].includes(String(status).toUpperCase()),
      (pages,tabs)=>pages.filter(candidate=>candidate.label===tabs[0].label&&!tabs[0].active&&tabs[0].openedBy==="agent"),
      async()=>({...snapshot,url:home}),
      value=>value===home?"g-p-"+"a".repeat(32):null,
      ()=>({sessionRefs:[],unboundProjectIds:[],unboundAny:false}),
      globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,
      async()=>"login",async()=>[{id:7,name:"managed",profileId:"P1",ownership:"agent",createdBy:"agent"}],
    );
  const result=await reclaim({accounts:{a:{identity:"login"}}},task,{spaceName:"managed",spaceId:7,profileId:"P1",projectUrl:home},"a");
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

test("orphan reclaim preserves a pending permission card with empty composer",async()=>{
  const out=await run({approvalRequired:true,generating:false,composerText:""});
  assert.equal(out.closed,0);
  assert.equal(out.result,null);
});
