import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";
import "../src/task-policy.js";
import "../src/page-pool.js";
import "../src/session-policy.js";

const source=await readFile(path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const code="const {draftDiscardProject}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n"+section("function samePhysicalSpace","\nasync function overflowManagedTask")+
  section("async function newManagedPage","\nasync function controlPage")+
  section("async function ensureProjectLocation","\nasync function ")+
  section("async function pruneProjectSpace","\nasync function gcAgentSpaces")+
  section("async function pruneManagedOrphanTabs","\nasync function watchOnce")+
  section("async function detachTerminalTaskPages","\nasync function pruneManagedOrphanTabs");
const projectHomeId=new Function(source.slice(source.indexOf("function projectHomeId("),source.indexOf("\nfunction projectKey("))+";return projectHomeId;")();
const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",cid="11111111-1111-4111-8111-111111111111",url=home.replace(/project$/, "c/"+cid);

async function fixture(orphan=false,change=()=>{}) {
  const binding={spaceName:"managed",spaceId:9,profileId:"P1",projectUrl:home};
  const reg={accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}},chats:{}};
  const rt={tasks:{}};
  if(!orphan){reg.chats[cid]={id:cid,project:"P",account:"a",role:"worker",status:"active",spaceName:"managed",spaceId:9,page:"p9",url};rt.tasks.t={taskId:"t",sessionId:cid,project:"P",account:"a",status:"COMPLETE"};}
  const f={reg,rt,binding,tabs:[{label:"p9",url:orphan?home:url,active:false,openedBy:"agent"}],
    snapshot:{url:orphan?home:url,composerCount:1,composerAttachmentsEmpty:true,composerRawText:"",generating:false,approvalRequired:false},
    context:{sessionRefs:[],unboundProjectIds:[],unboundAny:false},closed:0,states:0,queries:0};
  await change(f);let tabReads=0;
  const pages=f.tabs.map(tab=>({label:tab.label,url:async()=>f.pageUrl??tab.url,close:async()=>{f.closed++;(f.closedPages||=[]).push(tab.label);if(f.closeError)throw f.closeError;f.tabs=f.tabs.filter(t=>t.label!==tab.label);if(f.freshTabs)f.freshTabs=f.freshTabs.filter(t=>t.label!==tab.label);}}));
  const task={spaceId:9,page:label=>pages.find(p=>p.label===label),pages:async()=>pages,tabs:async()=>{if(tabReads++&&f.beforeFreshTabs)await f.beforeFreshTabs();return tabReads>1?f.freshTabs||f.tabs:f.tabs;},
    newPage:async()=>{f.allocations=(f.allocations||0)+1;if(f.entry==="allocate"&&f.allocations>1)return {label:"p10"};throw Error("page budget reached");}};
  const api=await new AsyncFunction("loadRuntime","state","saveRegistry","imageSessionOccupancy","pageDetachCandidates","orphanManagedPageCandidates","activeTaskStatus","composerIsEmpty","sameConversationUrl","projectHomeId","coordinated",
    "activeAccount","openBoundTask","projectRecord","bindingObserved","accountManagedTask","openProjectPage","bindingExecutionReadiness","pageBudgetError","clearCapacityWait","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError",
    "listTaskSpaces","process","assertInputSafe",code+";return {reclaimIdlePageSlot,reclaimOrphanManagedPage,newManagedPage,pruneProjectSpace,ensureProjectLocation,detachTerminalTaskPages};")(
    async()=>rt,async()=>{f.states++;const sample=f.states>1&&f.closingSnapshot?f.closingSnapshot:f.snapshot;if(f.afterState)await f.afterState();return sample?{...sample,url:f.pageUrl??sample.url}:sample;},async()=>{},()=>({occupied:!!f.image}),
    globalThis.__CHAT_BRIDGE_PAGE_POOL__.pageDetachCandidates,globalThis.__CHAT_BRIDGE_PAGE_POOL__.orphanManagedPageCandidates,
    globalThis.__CHAT_BRIDGE_TASK_POLICY__.activeTaskStatus,globalThis.__CHAT_BRIDGE_TASK_POLICY__.composerIsEmpty,
    globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,
    projectHomeId,
    (command,payload)=>{assert.equal(command,"page-reclaim-context");f.queries++;if(f.readContext)return f.readContext(payload);return f.states>0?f.freshContext||f.context:f.context;},
    (_r,_p,a)=>a||"a",async(_r,_p,_a,options)=>{
      f.openOptions=options;
      if(f.terminalOverflow && (!options?.spaceOverride || f.forceMainReturn))return {binding,task:{spaceId:1,page:label=>({label,close:async()=>{f.mainClosed=(f.mainClosed||0)+1;}}),tabs:async()=>[{label:"p9",active:false,openedBy:"agent",url:url.replace(cid,"99999999-9999-4999-8999-999999999999")}]}};
      return {binding:f.terminalOverflow?{...binding,...options.spaceOverride}:binding,task};
    },(r,p)=>r.projects[p],()=>true,
    async()=>({task,spaceName:"managed",profileId:"P1"}),async()=>home,()=>({ready:true}),
    error=>error.message==="page budget reached",async()=>{},async()=>({firstAt:Date.now()}),120,
    async()=>{throw Error("unexpected overflow");},()=>Object.assign(Error("capacity waiting"),{code:"CAPACITY_WAIT"}),
    async()=>f.available||[{id:9,name:f.terminalOverflow?"overflow":"managed",profileId:"P1",ownership:"agent",createdBy:"agent"}],{env:{}},
    async(_page,_identity,_url,options)=>{f.inputChecks=(f.inputChecks||0)+1;if(f.inputError)throw Error(f.inputError);if(options.discardDraft===true){f.discards=(f.discards||0)+1;if(f.discardError)throw Error("discard unconfirmed");f.snapshot.composerRawText="";}return _identity;}
  );
  f.result=f.entry==="allocate"?await api.newManagedPage(reg,"P","a",task,binding):f.entry==="terminal"?await api.detachTerminalTaskPages(reg,"P","a"):f.entry==="prune"?await api.pruneProjectSpace(reg,"P","a"):f.entry==="ensure"?await api.ensureProjectLocation(reg,"P","a",{create:true,confirm:true}):
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

test("terminal and orphan closes recheck Space ownership, creator and physical identity",async()=>{
  for(const orphan of [false,true]) for(const patch of [{ownership:"user"},{createdBy:"user"},{profileId:"P2"},{name:"other"},{id:10}]) {
    const f=await fixture(orphan,f=>{f.afterState=()=>{if(f.states>=2)f.available=[{id:9,name:"managed",profileId:"P1",ownership:"agent",createdBy:"agent",...patch}];};});
    assert.equal(f.closed,0,JSON.stringify({orphan,patch}));
    if(!orphan) assert.equal(f.reg.chats[cid].page,"p9");
  }
});
test("explicit Project discard is shared by terminal and orphan reclaim after every protection passes",async()=>{
  const permit=f=>{f.reg.projects.P.lifecycle={draftPolicy:"discard"};f.snapshot.composerRawText="old text";};
  for(const orphan of [false,true]) {
    const safe=await fixture(orphan,permit);assert.equal(safe.closed,1);assert.equal(safe.discards,1);
    for(const change of [f=>{f.context.unboundAny=true;},...(orphan?[f=>{f.tabs[0].active=true;}]:[]),f=>{f.snapshot.composerAttachmentsEmpty=false;}]) {
      const guarded=await fixture(orphan,f=>{permit(f);change(f);});assert.equal(guarded.closed,0);assert.equal(guarded.discards||0,0);
    }
    if(!orphan)for(const field of ["project","account"]) {
      const mismatch=await fixture(false,f=>{permit(f);f.rt.tasks.t[field]="other";});assert.equal(mismatch.closed,0);assert.equal(mismatch.discards||0,0);
    }
    let failed;await assert.rejects(()=>fixture(orphan,f=>{permit(f);f.discardError=true;failed=f;}),/discard unconfirmed/);assert.equal(failed.closed,0);
  }
});

test("proven pre-send capacity waiting without a page cannot veto safe orphan reclamation",async()=>{
  assert.equal(globalThis.__CHAT_BRIDGE_TASK_POLICY__.activeTaskStatus("WAITING_CAPACITY"),true);
  const waiting=f=>{
    f.rt.tasks.waiting={taskId:"waiting",project:"P",account:"a",sessionId:null,status:"WAITING_CAPACITY"};
    f.context.preSendCapacityWaits=[{taskId:"waiting",project:"P",account:"a",sessionId:null}];
  };
  const out=await fixture(true,waiting);
  assert.equal(out.closed,1);
  assert.ok(out.queries>=2);
  for(const [name,change] of [
    ["no authoritative proof",f=>{delete f.context.preSendCapacityWaits;}],
    ["another task",f=>{f.context.preSendCapacityWaits[0].taskId="other";}],
    ["another Project",f=>{f.context.preSendCapacityWaits[0].project="other";}],
    ["another account",f=>{f.context.preSendCapacityWaits[0].account="other";}],
    ["another session",f=>{f.context.preSendCapacityWaits[0].sessionId=cid;}],
    ["RUNNING",f=>{f.rt.tasks.waiting.status="RUNNING";}],
    ["user pause",f=>{f.rt.tasks.waiting.watchdogPausedForUserControl=true;}],
    ["pending callback",f=>{f.rt.tasks.waiting.watchdogPendingNotification=true;}],
    ["external response",f=>{f.rt.tasks.waiting.externalResponsePending=true;}],
    ["independent unplaced UNKNOWN",f=>{f.context.unboundAny=true;}],
    ["independent Project UNKNOWN",f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}],
    ["active tab",f=>{f.tabs[0].active=true;}],
    ["user tab",f=>{f.tabs[0].openedBy="user";}],
    ["draft",f=>{f.snapshot.composerRawText=" ";}],
    ["attachment",f=>{f.snapshot.composerAttachmentsEmpty=false;}],
    ["unknown attachment",f=>{delete f.snapshot.composerAttachmentsEmpty;}],
    ["approval",f=>{f.snapshot.approvalRequired=true;}],
    ["generation",f=>{f.snapshot.generating=true;}],
    ["foreign actual Project",f=>{f.tabs[0].url=home.replace("a".repeat(32),"b".repeat(32));}]
  ]) assert.equal((await fixture(true,f=>{waiting(f);change(f);})).closed,0,name);
});

test("capacity proof is rechecked after page observation before closing",async()=>{
  const out=await fixture(true,f=>{
    f.rt.tasks.waiting={taskId:"waiting",project:"P",account:"a",sessionId:"missing",status:"WAITING_CAPACITY"};
    f.context.preSendCapacityWaits=[{taskId:"waiting",project:"P",account:"a",sessionId:"missing"}];
    f.freshContext={sessionRefs:["missing"],unboundProjectIds:[],unboundAny:false,preSendCapacityWaits:[]};
  });
  assert.equal(out.closed,0);assert.ok(out.states>=1);assert.ok(out.queries>=2);
});

test("both reclaim helpers preserve user, draft, permission, generation and image occupants",async()=>{
  for(const orphan of [false,true]) for(const [name,change] of [
    ["user",f=>{f.tabs[0].openedBy="user";}],
    ["draft",f=>{f.snapshot.composerRawText=" ";}],
    ["permission",f=>{f.snapshot.approvalRequired=true;}],
    ["generating",f=>{f.snapshot.generating=true;}],
    ["image",f=>{if(orphan){f.tabs[0].url=url;f.reg.chats[cid]={id:cid,account:"a",spaceName:"managed",spaceId:9,page:"other",url};}f.image=true;}]
  ]) assert.equal((await fixture(orphan,change)).closed,0,`${orphan}:${name}`);
});

test("reclaim searches safe candidates, rechecks ownership and stops on an uncertain close",async()=>{
  for(const orphan of [false,true]) {
    const addSecond=f=>{
      const second="33333333-3333-4333-8333-333333333333",secondUrl=url.replace(cid,second);
      f.tabs.push({label:"p10",url:orphan?home:secondUrl,active:false,openedBy:"agent"});
      if(!orphan){f.reg.chats[second]={...f.reg.chats[cid],id:second,page:"p10",url:secondUrl};f.rt.tasks.second={...f.rt.tasks.t,sessionId:second};}
    };
    const one=await fixture(orphan,addSecond);assert.equal(one.states,2);assert.equal(one.closed,1);
    const unsafe=await fixture(orphan,f=>{addSecond(f);f.snapshot.generating=true;});assert.equal(unsafe.states,2);assert.equal(unsafe.closed,0);
    for(const changed of [...(orphan?[{active:true}]:[]),{openedBy:"user"},{url:"about:blank"}])
      assert.equal((await fixture(orphan,f=>{f.freshTabs=[{...f.tabs[0],...changed}];})).closed,0);
    let observed;
    await assert.rejects(()=>fixture(orphan,f=>{addSecond(f);f.closeError=Error("close acknowledgement unknown");observed=f;}),/acknowledgement unknown/);
    assert.equal(observed.closed,1);assert.equal(observed.states,2);
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

test("terminal detach uses its exact physical Space and guarded conversation without bypassing grace",async()=>{
  const setup=f=>{f.entry="terminal";f.terminalOverflow=true;f.binding.spaceId=1;f.binding.spaceName="main";f.binding.profileId="P1";f.reg.chats[cid].spaceName="overflow";f.reg.chats[cid].profileId="P1";f.rt.tasks.t.updatedAt="2026-01-01T00:00:00Z";};
  const safe=await fixture(false,setup);assert.equal(safe.mainClosed||0,0);assert.equal(safe.closed,1);assert.deepEqual(safe.openOptions.spaceOverride,{spaceName:"overflow",spaceId:9,profileId:"P1"});assert.equal(safe.result[0].sessionId,cid);
  for(const change of [f=>{f.forceMainReturn=true;},f=>{f.available=[];},f=>{f.context.sessionRefs=[cid];},f=>{f.context.unboundAny=true;},f=>{f.snapshot.approvalRequired=true;},f=>{f.rt.tasks.t.project="HZOS";},f=>{f.rt.tasks.t.account="other-login";},f=>{f.rt.tasks.t.updatedAt=new Date().toISOString();},f=>{f.rt.tasks.t.watchdogPendingNotification=true;},f=>{f.rt.tasks.young={...f.rt.tasks.t,taskId:"young",updatedAt:new Date().toISOString()};},f=>{delete f.rt.tasks.t.updatedAt;},f=>{f.rt.tasks.unknownAge={...f.rt.tasks.t,taskId:"unknownAge"};delete f.rt.tasks.unknownAge.updatedAt;}]) {
    const blocked=await fixture(false,f=>{setup(f);change(f);});assert.equal(blocked.closed,0);assert.equal(blocked.mainClosed||0,0);assert.equal(blocked.reg.chats[cid].page,"p9");
  }
  const only=await fixture(false,f=>{setup(f);const younger="00000000-0000-4000-8000-000000000000";f.reg.chats[younger]={...f.reg.chats[cid],id:younger,page:"p10",url:url.replace(cid,younger)};f.rt.tasks.younger={...f.rt.tasks.t,sessionId:younger,updatedAt:new Date().toISOString()};f.tabs.push({...f.tabs[0],label:"p10",url:url.replace(cid,younger)});});assert.deepEqual(only.closedPages,["p9"]);
  let observed;await assert.rejects(()=>fixture(false,f=>{setup(f);f.closeError=Error("close acknowledgement unknown");observed=f;}),/acknowledgement unknown/);assert.equal(observed.closed,1);assert.equal(observed.reg.chats[cid].page,"p9");
});

test("selected registered terminal pages reclaim through allocation, prune and watchdog after every guard passes",async()=>{
  for(const status of ["COMPLETE","FAILED","CANCELLED","RESULT_RECORDED"]) for(const entry of ["direct","allocate","prune","terminal"]) for(const draft of [false,true]) {
    const out=await fixture(false,f=>{
      f.tabs[0].active=true;f.entry=entry;f.rt.tasks.t.status=status;f.rt.tasks.t.updatedAt="2026-01-01T00:00:00Z";
      if(draft){f.reg.projects.P.lifecycle={draftPolicy:"discard"};f.snapshot.composerRawText="authorized terminal text";}
    });
    assert.equal(out.closed,1,status+":"+entry+":"+draft);
    assert.equal(out.reg.chats[cid].page,null);assert.equal(out.reg.chats[cid].attachmentEpoch,1);
    assert.equal(out.discards||0,draft?1:0);assert.equal(out.inputChecks,1);
    if(entry==="allocate"){assert.equal(out.allocations,2);assert.equal(out.result.label,"p10");}
    if(entry==="prune")assert.equal(out.result.detached[0].chatId,cid);
    if(entry==="terminal")assert.equal(out.result[0].sessionId,cid);
  }
  const changed=await fixture(false,f=>{f.freshTabs=[{...f.tabs[0],active:true}];});assert.equal(changed.closed,1);
});

test("selection never relaxes terminal ownership, route, execution, draft or UNKNOWN guards",async()=>{
  for(const [name,change] of [
    ["terminal task Project drift",f=>{f.rt.tasks.t.project="other";}],
    ["terminal task account drift",f=>{f.rt.tasks.t.account="other";}],
    ["RUNNING",f=>{f.rt.tasks.t.status="RUNNING";}],
    ["waiting response",f=>{f.rt.tasks.t.status="WAITING_RESPONSE";}],
    ["BLOCKED",f=>{f.rt.tasks.t.status="BLOCKED";}],
    ["no terminal task",f=>{f.rt.tasks={};}],
    ["new live task",f=>{f.rt.tasks.live={...f.rt.tasks.t,taskId:"live",status:"RUNNING"};}],
    ["pending notification",f=>{f.rt.tasks.t.watchdogPendingNotification=true;}],
    ["external response pending",f=>{f.rt.tasks.t.externalResponsePending=true;}],
    ["user control pause",f=>{f.rt.tasks.t.watchdogPausedForUserControl=true;}],
    ["generation",f=>{f.snapshot.generating=true;}],
    ["approval",f=>{f.snapshot.approvalRequired=true;}],
    ["unknown generation",f=>{delete f.snapshot.generating;}],
    ["image occupancy",f=>{f.image=true;}],
    ["control page",f=>{f.binding.controlPage="p9";}],
    ["another Project control page",f=>{f.reg.projects.other={bindings:{a:{...f.binding,controlPage:"p9"}}};}],
    ["user owned",f=>{f.tabs[0].openedBy="user";}],
    ["unknown owner",f=>{f.tabs[0].openedBy="unknown";}],
    ["fresh owner changed",f=>{f.freshTabs=[{...f.tabs[0],openedBy:"user"}];}],
    ["Project mismatch",f=>{f.reg.chats[cid].project="other";}],
    ["account mismatch",f=>{f.reg.chats[cid].account="other";}],
    ["no Project binding",f=>{delete f.binding.projectUrl;}],
    ["wrong conversation",f=>{f.tabs[0].url=url.replace(cid,"22222222-2222-4222-8222-222222222222");}],
    ["wrong Project URL",f=>{f.tabs[0].url=url.replace("a".repeat(32),"b".repeat(32));}],
    ["unscoped URL",f=>{f.tabs[0].url="https://chatgpt.com/c/"+cid;}],
    ["fresh URL changed",f=>{f.freshTabs=[{...f.tabs[0],url:"about:blank"}];}],
    ["draft preserve",f=>{f.snapshot.composerRawText="preserve this text";}],
    ["attachments",f=>{f.snapshot.composerAttachmentsEmpty=false;}],
    ["unknown attachments",f=>{delete f.snapshot.composerAttachmentsEmpty;}],
    ["multiple composers",f=>{f.snapshot.composerCount=2;}],
    ["UNKNOWN conversation",f=>{f.context.sessionRefs=[cid];}],
    ["unbound Project UNKNOWN",f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}],
    ["unbound UNKNOWN",f=>{f.context.unboundAny=true;}],
    ["fresh UNKNOWN",f=>{f.freshContext={sessionRefs:[cid],unboundProjectIds:[],unboundAny:false};f.reg.projects.P.lifecycle={draftPolicy:"discard"};f.snapshot.composerRawText="authorized text";}],
  ]) {
    const out=await fixture(false,f=>{f.tabs[0].active=true;change(f);});
    assert.equal(out.closed,0,name);assert.equal(out.reg.chats[cid].page,"p9",name);
  }
  for(const orphan of [false,true]) {
    const out=await fixture(orphan,f=>{f.tabs[0].active=true;if(!orphan)f.rt.tasks={};});
    assert.equal(out.closed,0,"no proven terminal ownership:"+orphan);
  }
});

test("selected terminal reclaim reads real management and user-control pauses even without occupying operations",async()=>{
  const {mkdtemp,mkdir,writeFile,rm}=await import("node:fs/promises"),{readFileSync}=await import("node:fs");
  const {tmpdir}=await import("node:os"),{spawnSync}=await import("node:child_process");
  const env={...process.env};delete env.CHAT_BRIDGE_FROM_ACCOUNT_ID;delete env.CHAT_BRIDGE_FROM_SPACE;
  for(const [name,scope,mode,userPause,expected] of [
    ["global pause","global","PAUSED",null,0],
    ["Project pause","project:P","PAUSED",null,0],
    ["Project drain","project:P","DRAINING",null,0],
    ["workgroup pause","workgroup:P:child","PAUSED",null,0],
    ["ancestor workgroup pause","workgroup:P:parent","PAUSED",null,0],
    ["Project user control",null,null,"project",0],
    ["session user control",null,null,"session",0],
    ["other Project pause","project:other","PAUSED",null,1],
    ["other workgroup pause","workgroup:P:other","PAUSED",null,1],
    ["RUNNING","project:P","RUNNING",null,1],
    ...["RUNNING","watchdogPendingNotification","externalResponsePending","watchdogPausedForUserControl","projectPause","sessionPause","project","account","registry:page","registry:url","registry:account","registry:profileId","registry:attachmentEpoch","registry:generation"].map(field=>["changed during final native tabs: "+field,null,null,"race:"+field,0]),
    ...["deleted task","role fallback"].map(field=>["changed during final UI sample: "+field,null,null,"final:"+field,0])
  ]) {
    const root=await mkdtemp(path.join(tmpdir(),"bridge-selected-terminal-")),config=path.join(root,"config"),stateDir=path.join(root,"state");
    try {
      await mkdir(config);await mkdir(stateDir);
      const out=await fixture(false,async f=>{
        f.tabs[0].active=true;f.reg.chats[cid].workgroupId="child";f.rt.tasks.t.workgroupId="child";
        f.reg.projects.P.workgroups={parent:{},child:{parentWorkgroupId:"parent"},other:{}};
        if(userPause==="project")f.rt.projects={P:{watchdogPausedForUserControl:true}};
        if(userPause==="session")f.rt.sessions={[cid]:{watchdogPausedForUserControl:true}};
        await writeFile(path.join(config,"registry.json"),JSON.stringify(f.reg));await writeFile(path.join(stateDir,"runtime.json"),JSON.stringify(f.rt));
        const call=(command,payload)=>spawnSync("python3",[path.resolve("src/coordinator.py"),command,config,stateDir],{input:JSON.stringify(payload),encoding:"utf8",env});
        const init=call("list",{});assert.equal(init.status,0,init.stderr);
        if(scope){
          const sql=spawnSync("python3",["-c","import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute('INSERT INTO control_state(scope,mode,epoch,reason,updated_at) VALUES(?,?,1,?,?)',(sys.argv[2],sys.argv[3],'test pause','now'));d.commit()",path.join(stateDir,"bridge.sqlite3"),scope,mode],{encoding:"utf8",env});assert.equal(sql.status,0,sql.stderr);
        }
        if(userPause?.startsWith("race:")||userPause?.startsWith("final:")){
          const hook=userPause.startsWith("final:")?"afterState":"beforeFreshTabs";
          f[hook]=()=>{
          if(hook==="afterState"&&f.states<2)return;
          f[hook]=null;
          const changed=JSON.parse(JSON.stringify(f.rt)),field=userPause.slice(userPause.indexOf(":")+1);
          if(field==="projectPause"){
            const sql=spawnSync("python3",["-c","import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute('INSERT INTO control_state(scope,mode,epoch,reason,updated_at) VALUES(?,?,1,?,?)',('project:P','PAUSED','race','now'));d.commit()",path.join(stateDir,"bridge.sqlite3")],{encoding:"utf8",env});assert.equal(sql.status,0,sql.stderr);return;
          }
          if(field.startsWith("registry:")){
            const next=JSON.parse(JSON.stringify(f.reg)),key=field.slice(9),value={page:"p10",url:url.replace(cid,"22222222-2222-4222-8222-222222222222"),account:"other",profileId:"P2",attachmentEpoch:2,generation:2}[key];next.chats[cid][key]=value;
            const sql=spawnSync("python3",["-c","import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute(\"UPDATE documents SET payload=? WHERE kind='registry'\",(sys.argv[2],));d.commit()",path.join(stateDir,"bridge.sqlite3"),JSON.stringify(next)],{encoding:"utf8",env});assert.equal(sql.status,0,sql.stderr);return;
          }
          if(field==="deleted task")changed.tasks={};
          else if(field==="role fallback")changed.tasks={fallback:{...changed.tasks.t,taskId:"fallback",sessionId:null,role:"worker"}};
          else if(field==="sessionPause")changed.sessions={[cid]:{watchdogPausedForUserControl:true}};
          else if(field==="RUNNING")changed.tasks.t.status="RUNNING";else changed.tasks.t[field]=field==="project"||field==="account"?"other":true;
          const sql=spawnSync("python3",["-c","import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute(\"UPDATE documents SET payload=? WHERE kind='runtime'\",(sys.argv[2],));d.commit()",path.join(stateDir,"bridge.sqlite3"),JSON.stringify(changed)],{encoding:"utf8",env});assert.equal(sql.status,0,sql.stderr);
          };
        }
        f.readContext=payload=>{
          const before=readFileSync(path.join(stateDir,"bridge.sqlite3")),r=call("page-reclaim-context",payload);
          assert.equal(r.status,0,r.stderr);assert.deepEqual(readFileSync(path.join(stateDir,"bridge.sqlite3")),before,"read-only context changed SQLite");
          return JSON.parse(r.stdout);
        };
      });
      assert.equal(out.closed,expected,name);assert.equal(out.reg.chats[cid].page,expected?null:"p9",name);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test("selected terminal empty composer uses the shared login guard and fresh closing UI",async()=>{
  const good=await fixture(false,f=>{f.tabs[0].active=true;});assert.equal(good.closed,1);assert.equal(good.inputChecks,1);
  for(const [name,change] of [
    ["late generation",f=>{f.closingSnapshot={...f.snapshot,generating:true};}],
    ["late approval",f=>{f.closingSnapshot={...f.snapshot,approvalRequired:true};}],
    ["late draft",f=>{f.closingSnapshot={...f.snapshot,composerRawText:"new draft"};}],
    ["late attachment",f=>{f.closingSnapshot={...f.snapshot,composerAttachmentsEmpty:false};}],
    ["late CID drift",f=>{f.closingSnapshot={...f.snapshot,url:url.replace(cid,"22222222-2222-4222-8222-222222222222")};}],
    ["late Project home",f=>{f.closingSnapshot={...f.snapshot,url:home};}]
  ]){
    const out=await fixture(false,f=>{f.tabs[0].active=true;change(f);});assert.equal(out.closed,0,name);
  }
  for(const code of ["INPUT_LOGIN_UNAVAILABLE","INPUT_LOGIN_MISMATCH","DELIVERY_TARGET_MISMATCH","USER_DRAFT_PRESENT"]){
    const observed=await fixture(false,f=>{f.tabs[0].active=true;f.inputError=code;});assert.equal(observed.closed,0);assert.equal(observed.reg.chats[cid].page,"p9");
  }
});

test("existing reclaim input mode requires an exact Project/CID before any draft discard",()=>{
  const guard=new Function("sameConversationUrl","projectHomeId","projectKey",section("function assertInputTarget(","\nasync function saveDraftBackup")+";return assertInputTarget;")(globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,projectHomeId,new Function(section("function projectKey(","\n")+";return projectKey;")());
  assert.doesNotThrow(()=>guard({url:"https://chatgpt.com/c/"+cid},url)); // Preserve the existing legacy input URL contract.
  assert.doesNotThrow(()=>guard({url},url,true));
  assert.doesNotThrow(()=>guard({url:home},home,true));
  for(const changed of [home,"https://chatgpt.com/c/"+cid,url.replace(cid,"22222222-2222-4222-8222-222222222222"),url.replace("a".repeat(32),"b".repeat(32))])
    assert.throws(()=>guard({url:changed},url,true),/DELIVERY_TARGET_MISMATCH/);
});
