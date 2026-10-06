import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import "../src/task-policy.js";
import "../src/page-pool.js";
import "../src/session-policy.js";

const source=await readFile(path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const code=section("function samePhysicalSpace","\nasync function overflowManagedTask")+
  section("async function newManagedPage","\nasync function controlPage")+
  section("async function ensureProjectLocation","\nasync function ")+
  section("async function pruneProjectSpace","\nasync function gcAgentSpaces");
const projectHomeId=new Function(source.slice(source.indexOf("function projectHomeId("),source.indexOf("\nfunction projectKey("))+";return projectHomeId;")();
const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",cid="11111111-1111-4111-8111-111111111111",url=home.replace(/project$/, "c/"+cid);

async function fixture(orphan=false,change=()=>{}) {
  const binding={spaceName:"managed",spaceId:9,profileId:"P1",projectUrl:home};
  const reg={accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}},chats:{}};
  const rt={tasks:{}};
  if(!orphan){reg.chats[cid]={id:cid,project:"P",account:"a",role:"worker",status:"active",spaceName:"managed",spaceId:9,page:"p9",url};rt.tasks.t={taskId:"t",sessionId:cid,project:"P",account:"a",status:"COMPLETE"};}
  const f={reg,rt,binding,tabs:[{label:"p9",url:orphan?home:url,active:false,openedBy:"agent"}],
    snapshot:{composerCount:1,composerRawText:"",generating:false,approvalRequired:false},
    context:{sessionRefs:[],unboundProjectIds:[],unboundAny:false},closed:0,states:0,queries:0};
  change(f);let tabReads=0;
  const pages=f.tabs.map(tab=>({label:tab.label,url:async()=>f.pageUrl??tab.url,close:async()=>{f.closed++;if(f.closeError)throw f.closeError;}}));
  const task={spaceId:9,page:label=>pages.find(p=>p.label===label),pages:async()=>pages,tabs:async()=>tabReads++?f.freshTabs||f.tabs:f.tabs,
    newPage:async()=>{f.allocations=(f.allocations||0)+1;throw Error("page budget reached");}};
  const api=await new AsyncFunction("loadRuntime","state","saveRegistry","imageSessionOccupancy","pageDetachCandidates","orphanManagedPageCandidates","activeTaskStatus","composerIsEmpty","sameConversationUrl","projectHomeId","coordinated",
    "activeAccount","openBoundTask","projectRecord","bindingObserved","accountManagedTask","openProjectPage","bindingExecutionReadiness","pageBudgetError","clearCapacityWait","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError",
    code+";return {reclaimIdlePageSlot,reclaimOrphanManagedPage,pruneProjectSpace,ensureProjectLocation};")(
    async()=>rt,async()=>{f.states++;return f.snapshot;},async()=>{},()=>({occupied:!!f.image}),
    globalThis.__CHAT_BRIDGE_PAGE_POOL__.pageDetachCandidates,globalThis.__CHAT_BRIDGE_PAGE_POOL__.orphanManagedPageCandidates,
    globalThis.__CHAT_BRIDGE_TASK_POLICY__.activeTaskStatus,globalThis.__CHAT_BRIDGE_TASK_POLICY__.composerIsEmpty,
    globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,
    projectHomeId,
    (command)=>{assert.equal(command,"page-reclaim-context");f.queries++;return f.context;},
    (_r,_p,a)=>a||"a",async()=>({binding,task}),(r,p)=>r.projects[p],()=>true,
    async()=>({task,spaceName:"managed",profileId:"P1"}),async()=>home,()=>({ready:true}),
    error=>error.message==="page budget reached",async()=>{},async()=>({firstAt:Date.now()}),120,
    async()=>{throw Error("unexpected overflow");},()=>Object.assign(Error("capacity waiting"),{code:"CAPACITY_WAIT"})
  );
  f.result=f.entry==="prune"?await api.pruneProjectSpace(reg,"P","a"):f.entry==="ensure"?await api.ensureProjectLocation(reg,"P","a",{create:true,confirm:true}):
    orphan?await api.reclaimOrphanManagedPage(reg,task,binding,"a"):await api.reclaimIdlePageSlot(reg,"P","a",task,binding);
  return f;
}

test("registered reclaim requires its terminal task, exact conversation and same Project",async()=>{
  const same=globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,globalUrl="https://chatgpt.com/c/"+cid;
  assert.equal(same(globalUrl,url),true); // Preserve legacy callers; reclamation requires an explicit Project.
  assert.equal(same(globalUrl,url,"g-p-"+"a".repeat(32)),false);
  assert.equal((await fixture()).closed,1);
  for(const [name,change] of [
    ["another Project",f=>{f.reg.chats[cid].project="HZOS";}],
    ["actual HZOS URL despite P metadata",f=>{f.reg.chats[cid].url=url.replace("a".repeat(32),"b".repeat(32));f.tabs[0].url=f.reg.chats[cid].url;}],
    ["unbound UNKNOWN in P",f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}],
    ["unplaced UNKNOWN",f=>{f.context.unboundAny=true;}],
    ["unscoped actual URL",f=>{f.tabs[0].url="https://chatgpt.com/c/"+cid;}],
    ["unverified Project binding",f=>{delete f.binding.projectUrl;}],
    ["unscoped URL after state",f=>{f.pageUrl="https://chatgpt.com/c/"+cid;}],
    ["unscoped fresh tab",f=>{f.freshTabs=[{...f.tabs[0],url:"https://chatgpt.com/c/"+cid}];}],
    ["no durable task",f=>{f.rt.tasks={};}],
    ["BLOCKED",f=>{f.rt.tasks.t.status="BLOCKED";}],
    ["pending callback",f=>{f.rt.tasks.t.watchdogPendingNotification=true;}],
    ["external response",f=>{f.rt.tasks.t.externalResponsePending=true;}],
    ["user pause",f=>{f.rt.tasks.t.watchdogPausedForUserControl=true;}],
    ["recycled label",f=>{f.tabs[0].url="https://chatgpt.com/c/foreign";}],
    ["page changed during state",f=>{f.pageUrl="https://chatgpt.com/c/foreign";}],
    ["UNKNOWN operation",f=>{f.context.sessionRefs=[cid];}]
  ]) assert.equal((await fixture(false,change)).closed,0,name);
  assert.equal((await fixture(false,f=>{f.context.unboundProjectIds=["g-p-"+"b".repeat(32)];})).closed,1);
});

test("orphan reclaim never closes an unregistered conversation or another Project home",async()=>{
  assert.equal((await fixture(true)).closed,1);
  for(const [name,change] of [
    ["unknown conversation",f=>{f.tabs[0].url=url;}],
    ["other Project",f=>{f.tabs[0].url=home.replace("a".repeat(32),"b".repeat(32));}],
    ["same path foreign origin",f=>{f.tabs[0].url=home.replace("https://chatgpt.com","https://foreign.example");}],
    ["registered moved label",f=>{f.tabs[0].url=url;f.reg.chats[cid]={id:cid,spaceName:"managed",spaceId:9,page:"old",url};}],
    ["unbound UNKNOWN",f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}],
    ["unplaced UNKNOWN",f=>{f.context.unboundAny=true;}]
  ]) assert.equal((await fixture(true,change)).closed,0,name);
});

test("both reclaim helpers preserve active, user, draft, permission, generation and image occupants",async()=>{
  for(const orphan of [false,true]) for(const [name,change] of [
    ["active",f=>{f.tabs[0].active=true;}],
    ["user",f=>{f.tabs[0].openedBy="user";}],
    ["draft",f=>{f.snapshot.composerRawText=" ";}],
    ["permission",f=>{f.snapshot.approvalRequired=true;}],
    ["generating",f=>{f.snapshot.generating=true;}],
    ["image",f=>{if(orphan){f.tabs[0].url=url;f.reg.chats[cid]={id:cid,account:"a",spaceName:"managed",spaceId:9,page:"other",url};}f.image=true;}]
  ]) assert.equal((await fixture(orphan,change)).closed,0,`${orphan}:${name}`);
});

test("reclaim checks one candidate, rechecks ownership and stops on an uncertain close",async()=>{
  for(const orphan of [false,true]) {
    const addSecond=f=>{
      const second="33333333-3333-4333-8333-333333333333",secondUrl=url.replace(cid,second);
      f.tabs.push({label:"p10",url:orphan?home:secondUrl,active:false,openedBy:"agent"});
      if(!orphan){f.reg.chats[second]={...f.reg.chats[cid],id:second,page:"p10",url:secondUrl};f.rt.tasks.second={...f.rt.tasks.t,sessionId:second};}
    };
    const one=await fixture(orphan,addSecond);assert.equal(one.states,1);assert.equal(one.closed,1);
    const unsafe=await fixture(orphan,f=>{addSecond(f);f.snapshot.generating=true;});assert.equal(unsafe.states,1);assert.equal(unsafe.closed,0);
    for(const changed of [{active:true},{openedBy:"user"},{url:"about:blank"}])
      assert.equal((await fixture(orphan,f=>{f.freshTabs=[{...f.tabs[0],...changed}];})).closed,0);
    let observed;
    await assert.rejects(()=>fixture(orphan,f=>{addSecond(f);f.closeError=Error("close acknowledgement unknown");observed=f;}),/acknowledgement unknown/);
    assert.equal(observed.closed,1);assert.equal(observed.states,1);
  }
});

test("exact blank metadata needs no DOM read and remains protected by unbound operations",async()=>{
  for(const blank of ["about:blank","chrome://newtab/"]) {
    const safe=await fixture(true,f=>{f.tabs[0].url=blank;});assert.equal(safe.closed,1);assert.equal(safe.states,0);
    const occupied=await fixture(true,f=>{f.tabs[0].url=blank;f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];});assert.equal(occupied.closed,0);assert.equal(occupied.states,0);
  }
  assert.equal((await fixture(true,f=>{f.tabs[0].url="about:blank?foreign";})).closed,0);
});

test("public prune cannot bypass shared UNKNOWN or actual Project protections",async()=>{
  const terminal=await fixture(false,f=>{f.entry="prune";});assert.equal(terminal.closed,1);assert.equal(terminal.result.detached.length,1);assert.deepEqual(terminal.result.closed,[]);
  const homePage=await fixture(true,f=>{f.entry="prune";});assert.equal(homePage.closed,1);assert.deepEqual(homePage.result.closed,["p9"]);
  for(const change of [f=>{f.context.sessionRefs=[cid];},f=>{f.reg.chats[cid].project="HZOS";},f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}])
    assert.equal((await fixture(false,f=>{f.entry="prune";change(f);})).closed,0);
  let observed;
  await assert.rejects(()=>fixture(true,f=>{f.entry="prune";f.tabs.push({...f.tabs[0],label:"p10"});f.closeError=Error("close acknowledgement unknown");observed=f;}),/acknowledgement unknown/);
  assert.equal(observed.closed,1);
});

test("project ensure --create never allocates again after a reclaim or capacity error",async()=>{
  for(const uncertain of [true,false]) {
    let observed;
    await assert.rejects(()=>fixture(false,f=>{f.entry="ensure";if(uncertain)f.closeError=Error("close acknowledgement unknown");else f.snapshot.generating=true;observed=f;}),uncertain?/acknowledgement unknown/:/capacity waiting/);
    assert.equal(observed.allocations,1);assert.equal(observed.closed,uncertain?1:0);
  }
});
