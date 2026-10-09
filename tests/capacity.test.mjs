import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const coordinator=path.resolve("src/coordinator.py");

test("a successful page allocation cannot become a capacity wait when its state cleanup fails",async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const code=source.slice(source.indexOf("async function newManagedPage"),source.indexOf("\nasync function controlPage"));
  for(const mode of ["primary","reclaimed primary","overflow","previous overflow","advanced overflow"]) {
    const failure=Error(mode.includes("primary")?"state cleanup: page budget reached":"state cleanup unavailable"),reasons=[];
    let primaryCalls=0,created=0,clears=0;
    const page={label:"created"},full=async()=>{throw Error("page budget reached");};
    const create=async()=>{created++;return page;};
    const primary={spaceId:1,newPage:async()=>{primaryCalls++;return mode==="primary"||mode==="reclaimed primary"&&primaryCalls===2?create():full();}};
    const head={spaceId:2,newPage:mode==="overflow"?create:full},next={spaceId:3,newPage:create};
    const allocate=await new AsyncFunction("pageBudgetError","clearCapacityWait","reclaimIdlePageSlot","reclaimOrphanManagedPage","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return newManagedPage;")(
      e=>/page budget reached/.test(e.message),async()=>{clears++;throw failure;},
      async(_r,_p,_a,t)=>mode==="reclaimed primary"&&t===primary?{}:null,async()=>null,
      async(_r,_p,_a,_b,reason)=>{reasons.push(reason);return {firstAt:Date.now()-121000,reason};},120,
      async(_r,_p,_a,_b,options={})=>({task:options.previous||options.advance?next:head,mapping:{previousSpaces:mode==="previous overflow"?[{}]:[]}}),
      (_b,_w,reason)=>Object.assign(Error(reason),{code:"CAPACITY_WAIT"})
    );
    await assert.rejects(()=>allocate({},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true}),e=>e===failure,mode);
    assert.equal(created,1,mode);assert.equal(clears,1,mode);
    assert.deepEqual(reasons,mode.includes("primary")?[]:["PAGE_BUDGET_NO_SAFE_RECLAIM:main"],mode);
  }
});

test("an uncertain overflow allocation error cannot become a retryable capacity wait",async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const code=source.slice(source.indexOf("async function newManagedPage"),source.indexOf("\nasync function controlPage"));
  for(const mode of ["first overflow","reclaimed overflow","advanced overflow"]) {
    const failure=Error("allocation response lost"),reasons=[];let calls=0;
    const full=async()=>{throw Error("page budget reached");},primary={spaceId:1,newPage:full};
    const head={spaceId:2,newPage:async()=>{calls++;if(mode==="advanced overflow"||mode==="reclaimed overflow"&&calls===1)return full();throw failure;}};
    const next={spaceId:3,newPage:async()=>{calls++;throw failure;}};
    const allocate=await new AsyncFunction("pageBudgetError","clearCapacityWait","reclaimIdlePageSlot","reclaimOrphanManagedPage","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return newManagedPage;")(
      e=>/page budget reached/.test(e.message),()=>{throw Error("unexpected cleanup");},
      async(_r,_p,_a,t)=>mode==="reclaimed overflow"&&t===head?{}:null,async()=>null,
      async(_r,_p,_a,_b,reason)=>{reasons.push(reason);return {firstAt:Date.now()-121000,reason};},120,
      async(_r,_p,_a,_b,options={})=>({task:options.advance?next:head}),
      (_b,_w,reason)=>Object.assign(Error(reason),{code:"CAPACITY_WAIT"})
    );
    await assert.rejects(()=>allocate({},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true}),e=>e===failure,mode);
    assert.equal(calls,mode==="first overflow"?1:2,mode);
    assert.deepEqual(reasons,["PAGE_BUDGET_NO_SAFE_RECLAIM:main"],mode);
  }
});

test("normal allocation reuses the verified mapped pool before the expansion delay with real state storage",async()=>{
  const source=await readFile(process.env.CHAT_BRIDGE_CAPACITY_TEST_MAIN||path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const section=(a,z)=>source.slice(source.indexOf(a),source.indexOf(z,source.indexOf(a)));
  const code=section("function stored(","\nfunction coordinated")+section("function normalizeRuntime(","\nfunction runtimeCacheLock")+
    section("function managedSpacePlan(","\nasync function accountManagedTask")+section("async function overflowManagedTask(","\nasync function controlPage");
  for(const mode of ["free head","free previous","full pool","missing mapping","missing Space","wrong Profile","user owned","UNKNOWN owner"]){
    const root=await mkdtemp(path.join(tmpdir(),"bridge-mapped-pool-")),config=path.join(root,"config"),state=path.join(root,"state");
    try{
      await mkdir(config);await mkdir(state);await writeFile(path.join(config,"registry.json"),"{}");
      await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks:{protected:{status:"RUNNING"}},sessions:{paused:{watchdogPausedForUserControl:true}}}));
      const name="chat-bridge-agent-a",binding={spaceName:name,spaceId:2,profileId:"P1"},head={spaceName:name+"-overflow-2",spaceId:41,profileId:"P1",identity:"login-a",account:"a",createdAt:"2026-01-01T00:00:00Z"},
        previous={...head,spaceName:name+"-overflow",spaceId:32},reg={accounts:{a:{identity:"login-a"}},projects:{P:{lifecycle:{maxOverflowSpaces:2}}},spaces:{primary:{name,spaceId:2,profileId:"P1",identity:"login-a",ownership:"agent"}},capacityOverflow:{"login-a|P1":{...head,previousSpaces:[previous]}}};
      const available=[binding,head,previous].map(b=>({id:b.spaceId,name:b.spaceName,profileId:"P1",ownership:"agent",createdBy:"agent"})),counts={2:8,41:mode==="free head"?6:8,32:mode==="free previous"?6:8};
      if(mode==="missing mapping")reg.capacityOverflow={};
      if(mode==="missing Space")available.splice(1,1);
      if(mode==="wrong Profile")available[1].profileId="P2";
      if(mode==="user owned")available[1].ownership="user";
      if(mode==="UNKNOWN owner")available[1].ownership="unknown";
      let creates=0,saves=0,allocated=0;
      const tasks=new Map(available.map(s=>[s.id,{spaceId:s.id,name:s.name,newPage:async()=>{if(counts[s.id]>=8)throw Error("page budget reached (8/8)");counts[s.id]++;allocated++;return {label:"new-"+s.id};}}]));
      const api=await new AsyncFunction("childProcess","CONFIG_DIR","STATE_DIR","STORE_PATH","stateBaselines","Date","crypto","slug","listTaskSpaces","taskSpace","taskAccounts","accountScope","saveRegistry","reclaimIdlePageSlot","reclaimOrphanManagedPage","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return {stored,loadRuntime,recordCapacityWait,newManagedPage};")(
        await import("node:child_process"),config,state,process.env.CHAT_BRIDGE_CAPACITY_TEST_STORE||path.resolve("src/state-store.py"),new WeakMap(),class extends Date{static now(){return 100000;}},
        await import("node:crypto"),x=>x,async()=>available,async id=>{const task=tasks.get(id)||[...tasks.values()].find(t=>t.name===id);if(!task){creates++;throw Error("unexpected Space creation");}return task;},new Map(),(r,a)=>r.accounts[a].identity,async()=>{saves++;},async()=>null,async()=>null);
      api.stored("get","runtime");
      const before=await api.loadRuntime(),mapping=structuredClone(reg.capacityOverflow);
      if(mode==="free head"||mode==="free previous"){
        const result=await api.newManagedPage(reg,"P","a",tasks.get(2),binding,null,{allowOverflow:true});
        assert.equal(result.task.spaceId,mode==="free head"?41:32,mode);assert.equal(result.overflow,true);assert.equal(allocated,1);
      }else{
        await assert.rejects(()=>api.newManagedPage(reg,"P","a",tasks.get(2),binding,null,{allowOverflow:true}),e=>e.code==="CAPACITY_WAIT",mode);
        assert.equal(allocated,0,mode);
      }
      const after=await api.loadRuntime();assert.deepEqual(after.tasks,before.tasks);assert.deepEqual(after.sessions,before.sessions);
      assert.deepEqual(reg.capacityOverflow,mapping,mode);assert.equal(creates,0,mode);assert.equal(saves,0,mode);
    }finally{await rm(root,{recursive:true,force:true});}
  }
});

test("an explicitly budgeted second overflow is used only after safe reclaim fails",async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const code=source.slice(source.indexOf("async function newManagedPage"),source.indexOf("\nasync function controlPage"));
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  for(const [budget,created] of [[1,false],[2,false],[2,true]]) {
    const calls=[],primary={spaceId:1,newPage:async()=>{throw Error("page budget reached");}};
    const full={spaceId:9,newPage:primary.newPage},next={spaceId:10,newPage:async()=>({label:"next"})};
    const allocate=await new AsyncFunction("pageBudgetError","clearCapacityWait","reclaimIdlePageSlot","reclaimOrphanManagedPage","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return newManagedPage;")(
      e=>/page budget reached/.test(e.message),async()=>calls.push("cleared"),
      async(_r,_p,_a,t)=>{calls.push("idle:"+t.spaceId);return null;},async(_r,t)=>{calls.push("orphan:"+t.spaceId);return null;},
      async()=>({firstAt:Date.now()-121000}),120,
      async(_r,_p,_a,_b,options={})=>{calls.push(options.advance?"next":"overflow");if(options.advance&&budget===1)throw Error("OVERFLOW_SPACE_LIMIT");return {created,task:options.advance?next:full,binding:{spaceId:options.advance?10:9}};},
      (_b,_w,reason)=>Error(reason)
    );
    if(budget===2&&!created)assert.equal((await allocate({projects:{P:{lifecycle:{maxOverflowSpaces:budget}}}},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true})).page.label,"next");
    else await assert.rejects(()=>allocate({},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true}));
    assert.deepEqual(calls.slice(0,6),["idle:1","orphan:1","overflow","idle:9","orphan:9",...(!created?["next"]:[])]);
    assert.equal(calls.filter(x=>x==="next").length,created?0:1);
  }
});

test("the identity/Profile overflow budget retains both attachments and reuses the previous Space",async()=>{
  const source=await readFile('src/main.js','utf8'),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const name='chat-bridge-agent-a',reg={accounts:{a:{identity:'login-a'},alias:{identity:'login-a'}},projects:{P:{lifecycle:{maxOverflowSpaces:2},bindings:{a:{spaceName:name,spaceId:1,profileId:'P1'}}},other:{lifecycle:{maxOverflowSpaces:2}}},
    chats:{},spaces:{primary:{name,spaceId:1,identity:'login-a',profileId:'P1',ownership:'agent'}}};
  const available=[{id:1,name,profileId:'P1',ownership:'agent',createdBy:'agent'}];let creates=0;
  const api=await new AsyncFunction('crypto','slug','listTaskSpaces','taskSpace','taskAccounts','accountScope','saveRegistry','emptyRegistry','defaultSpaceName','DEFAULT_ACCOUNT',
    section('function managedSpacePlan','\nasync function accountManagedTask')+section('async function overflowManagedTask','\nasync function newManagedPage')+section('function normalizeRegistry','\nfunction normalizeRuntime')+';return {overflowManagedTask,normalizeRegistry,managedSpacePlan};')(
    await import('node:crypto'),x=>x,async()=>available,async(name,options)=>{let info=available.find(x=>x.name===name);if(!info){creates++;info={id:creates+1,name,profileId:options.profileId,ownership:'agent',createdBy:'agent'};available.push(info);}return {spaceId:info.id};},new Map(),(r,a)=>r.accounts[a].identity,async()=>{},()=>({accounts:{},projects:{},chats:{},spaces:{}}),()=>name,'a');
  const binding=reg.projects.P.bindings.a,first=await api.overflowManagedTask(reg,'P','a',binding),next=await api.overflowManagedTask(reg,'P','a',binding,{advance:true});
  assert.equal(next.spaceName,first.spaceName+'-2');assert.equal(creates,2);
  assert.deepEqual(next.mapping.previousSpaces,[first.mapping]);
  await assert.rejects(()=>api.overflowManagedTask(reg,'other','alias',binding,{advance:true}),/OVERFLOW_SPACE_LIMIT/);assert.equal(creates,2);
  const old=await api.overflowManagedTask(reg,'P','a',binding,{previous:true});assert.equal(old.spaceName,first.spaceName);assert.equal(reg.capacityOverflow['login-a|P1'].spaceName,next.spaceName);
  for(const item of [first,next])reg.chats[item.spaceName]={id:item.spaceName,project:'P',account:'a',spaceName:item.spaceName,spaceId:item.task.spaceId,profileId:'P1',page:'kept'};
  const normalized=api.normalizeRegistry(structuredClone(reg));for(const chat of Object.values(normalized.chats))assert.equal(chat.page,'kept');
  for(const item of [first,next])reg.spaces[item.spaceName]={identity:'login-a',profileId:'P1',name:item.spaceName,spaceId:item.task.spaceId,ownership:'agent'};
  assert.equal(api.managedSpacePlan(reg,'a','P1').spaceName,name);
  reg.capacityOverflow['login-a|P1'].previousSpaces=null;
  await assert.rejects(()=>api.overflowManagedTask(reg,'P','a',binding),/OVERFLOW_MAPPING_INVALID|AMBIGUOUS_CANONICAL_SPACE/);assert.equal(creates,2);
});

test("a full verified overflow reclaims once in that Space before retrying allocation",async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const code=source.slice(source.indexOf("async function newManagedPage"),source.indexOf("\nasync function controlPage"));
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const primary={spaceId:1,newPage:async()=>{throw Error("page budget reached");}};
  let allocations=0,overflowSelections=0,cleared=0;
  const page={label:"p9"},overflowTask={spaceId:9,newPage:async()=>{
    if(++allocations===1) throw Error("page budget reached");
    return page;
  }};
  const binding={spaceName:"primary",spaceId:1},overflowBinding={spaceName:"overflow",spaceId:9};
  const calls=[];
  const allocate=await new AsyncFunction("pageBudgetError","clearCapacityWait","reclaimIdlePageSlot","reclaimOrphanManagedPage","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return newManagedPage;")(
    error=>error.message==="page budget reached",async()=>{cleared++;},
    async(_reg,_project,_account,task,target,exclude)=>{
      calls.push(["idle",task.spaceId,target.spaceId,exclude]);
      return task===overflowTask?{page:"old"}:null;
    },async(_reg,task,target)=>{calls.push(["orphan",task.spaceId,target.spaceId]);return null;},
    async()=>({firstAt:Date.now()-121000}),120,
    async()=>{overflowSelections++;return {task:overflowTask,binding:overflowBinding,spaceName:"overflow"};},
    ()=>Error("capacity waiting")
  );
  const result=await allocate({},"P","a",primary,binding,"keep",{allowOverflow:true});
  assert.equal(result.page,page);assert.equal(result.task,overflowTask);assert.equal(result.binding,overflowBinding);
  assert.equal(allocations,2);assert.equal(overflowSelections,1);assert.equal(cleared,1);
  assert.deepEqual(calls,[["idle",1,1,"keep"],["orphan",1,1],["idle",9,9,"keep"]]);
});

test('a detached conversation reuses the bounded pool and preserves its CID during normal send allocation',async()=>{
  const source=await readFile('src/main.js','utf8'),a=source.indexOf('async function ensurePage'),z=source.indexOf('\nfunction hashText',a),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const url='https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/c/11111111-1111-4111-8111-111111111111',chat={id:url.split('/').at(-1),project:'P',account:'a',url,page:null},original=structuredClone(chat);
  const binding={spaceName:'chat-bridge-agent-a',spaceId:1,profileId:'P1'},overflow={spaceName:binding.spaceName+'-overflow-2',spaceId:10,profileId:'P1'},page={label:'next',goto:async target=>assert.equal(target,url),url:async()=>url};
  const ensure=await new AsyncFunction('openBoundTask','pagesOf','sameConversationUrl','newManagedPage','waitForConversationReady','saveRegistry','openConversationFromProject',source.slice(a,z)+';return ensurePage;')(
    async()=>({binding,task:{spaceId:1}}),async()=>[],(a,b)=>a===b,async(_r,p,account,_t,_b,id,options)=>{assert.equal(options.allowOverflow,true);assert.equal(id,chat.id);return {page,task:{spaceId:10},binding:overflow,overflow:true};},async()=>{},async()=>{},()=>{throw Error('unexpected fallback');});
  await ensure({projects:{P:{bindings:{a:binding}}}},chat,{allowOverflow:true});
  assert.equal(chat.id,original.id);assert.equal(chat.url,original.url);assert.equal(chat.page,'next');assert.equal(chat.spaceId,10);assert.equal(chat.spaceName,overflow.spaceName);
});

test("overflow exhaustion keeps resource waiting without recursion or another reclaim",async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const code=source.slice(source.indexOf("async function newManagedPage"),source.indexOf("\nasync function controlPage"));
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  for(const mode of ["no safe page","still full","orphan","non-budget error"]) {
    let allocations=0,selections=0,cleared=0;const calls=[],reasons=[];
    const primary={spaceId:1,newPage:async()=>{throw Error("page budget reached");}};
    const overflow={spaceId:9,newPage:async()=>{allocations++;if(mode==="orphan"&&allocations===2)return {label:"p9"};throw Error(mode==="non-budget error"?"connection lost":"page budget reached");}};
    const allocate=await new AsyncFunction("pageBudgetError","clearCapacityWait","reclaimIdlePageSlot","reclaimOrphanManagedPage","recordCapacityWait","CAPACITY_OVERFLOW_AFTER_SEC","overflowManagedTask","capacityWaitError","const handoffAllocatedPage=async()=>{};const allocateManagedPage=(task)=>task.newPage(); const cleanupFailedAllocation=async()=>{};\n"+code+";return newManagedPage;")(
      error=>error.message==="page budget reached",async()=>{cleared++;},
      async(_r,_p,_a,task)=>{calls.push(["idle",task.spaceId]);return task===overflow&&mode==="still full"?{}:null;},
      async(_r,task,_b,account)=>{assert.equal(account,"a");calls.push(["orphan",task.spaceId]);return task===overflow&&mode==="orphan"?{}:null;},
      async(_r,_p,_a,_b,reason)=>{reasons.push(reason);return {firstAt:Date.now()-121000,reason};},120,
      async(_r,_p,_a,_b,options={})=>{if(options.advance)throw Error("OVERFLOW_SPACE_LIMIT");selections++;return {task:overflow,binding:{spaceId:9},spaceName:"overflow"};},
      (_b,_w,reason)=>Error("capacity waiting: "+reason)
    );
    if(mode==="orphan") assert.equal((await allocate({},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true})).page.label,"p9");
    else await assert.rejects(()=>allocate({},"P","a",primary,{spaceName:"main"},null,{allowOverflow:true}),mode==="non-budget error"?/^Error: connection lost$/:/capacity waiting: OVERFLOW_UNAVAILABLE:/);
    assert.equal(selections,1);assert.equal(allocations,["still full","orphan"].includes(mode)?2:1);assert.equal(cleared,mode==="orphan"?1:0);
    assert.deepEqual(calls,mode==="non-budget error"?[["idle",1],["orphan",1]]:mode==="still full"?[["idle",1],["orphan",1],["idle",9]]:[["idle",1],["orphan",1],["idle",9],["orphan",9]]);
    assert.equal(reasons[0],"PAGE_BUDGET_NO_SAFE_RECLAIM:main");
    if(mode==="non-budget error") assert.equal(reasons.length,1);
  }
});

test("queue capacity exhaustion waits with backoff and stays distinct from BLOCKED", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"bridge-capacity-")), config=path.join(root,"config"), state=path.join(root,"state");
  await mkdir(config); await mkdir(state);
  const registry={defaultAccount:"a",accounts:{a:{identity:"login-a"}},projects:{P:{activeAccount:"a",bindings:{a:{projectUrl:"https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",spaceName:"agent-a",profileId:"P1"}}}},chats:{controller:{id:"controller",project:"P",account:"a",role:"conductor",status:"active"}}};
  await writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({version:2,projects:{},tasks:{},sessions:{}}));
  const marker=path.join(root,"ready");
  const fake=path.join(root,"bridge-worker");
  await writeFile(fake,`#!/bin/sh
if [ "$1" = "new" ] && [ ! -f "${marker}" ]; then
  printf '%s\\n' '{"ok":false,"deliveryStage":"PRE_SEND","code":"CAPACITY_WAIT","status":"WAITING_CAPACITY","reason":"PAGE_BUDGET_NO_SAFE_RECLAIM:agent-a","retryAfterSec":15,"nextRetryAt":"2099-01-01T00:00:15Z"}' >&2
  exit 1
fi
if [ "$1" = "new" ]; then printf '%s\\n' '{"ok":true,"id":"new-chat"}'; exit 0; fi
if [ "$1" = "task" ]; then printf '%s\\n' '{"ok":true}'; exit 0; fi
printf '%s\\n' '{"ok":true,"delivered":true}'; exit 0
`,{mode:0o755});
  const call=(command,payload,...args)=>{
    const result=spawnSync("python3",[coordinator,command,config,state,...args],{input:payload?JSON.stringify(payload):undefined,encoding:"utf8",env:{...process.env,CHAT_BRIDGE_BIN:fake}});
    assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
  };
  try {
    const queued=call("submit",{requestId:"capacity-1",callerRef:"controller",role:"worker",message:"work"});
    const waiting=call("work-one");
    assert.equal(waiting.status,"QUEUED");
    assert.equal(waiting.reason,"CAPACITY_WAITING");
    assert.ok(waiting.notBefore>Date.now()/1000);
    const runtime=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",config,state,"runtime"],{encoding:"utf8"}).stdout);
    assert.equal(runtime.tasks[queued.taskId].status,"WAITING_CAPACITY");
    const dashboard=call("control",null,"status","--project","P").projects[0];
    assert.equal(dashboard.tasks.capacityWaiting,1);
    assert.equal(dashboard.tasks.blocked,0);
    await writeFile(marker,"");
    spawnSync("python3",["-c","import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute('UPDATE operations SET not_before=0 WHERE id=?',(sys.argv[2],)); db.commit()",path.join(state,"bridge.sqlite3"),queued.operationId]);
    assert.equal(call("work-one").status,"SENT");
    const cleared=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",config,state,"runtime"],{encoding:"utf8"}).stdout);
    assert.equal(cleared.tasks[queued.taskId].status,"DISPATCHED");
    assert.equal(cleared.tasks[queued.taskId].capacityState,undefined);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("overflow preserves a healthy legacy target and isolates a verified foreign-Profile collision", async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const start=source.indexOf("function managedSpacePlan"),planEnd=source.indexOf("\nasync function accountManagedTask",start);
  const overflowStart=source.indexOf("async function overflowManagedTask"),overflowEnd=source.indexOf("\nasync function newManagedPage",overflowStart);
  const normalStart=source.indexOf("function normalizeRegistry"),normalEnd=source.indexOf("\nfunction normalizeRuntime",normalStart);
  const code=source.slice(start,planEnd)+source.slice(overflowStart,overflowEnd)+source.slice(normalStart,normalEnd);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor, crypto=await import("node:crypto");
  const name="chat-bridge-agent-a",profile="P1",legacy=name+"-overflow",scoped=legacy+"-"+crypto.createHash("sha256").update(profile).digest("hex").slice(0,8);
  const reg={defaultAccount:"a",chats:{},accounts:{a:{identity:"login-a",label:"A"}},
    spaces:{canonical:{identity:"login-a",accountName:"A",profileId:profile,name,ownership:"agent"}},
    projects:{P:{bindings:{a:{spaceName:name,spaceId:1,profileId:profile}}}}};
  let available=[],creates=0,opened=0,saves=0,wrongCreation=false;
  const baselines=new WeakMap(), writes=[];
  const api=await new AsyncFunction("listTaskSpaces","taskSpace","slug","crypto","taskAccounts","accountScope","saveRegistry","emptyRegistry","defaultSpaceName","DEFAULT_ACCOUNT","stored","stateBaselines",
    code+";return {overflowManagedTask,normalizeRegistry};")(
    async()=>available,async (target,options)=>{
      opened++;
      let info=available.find(x=>x.name===target);
      if(!info){creates++;info={id:9,name:target,profileId:wrongCreation?"P3":options.profileId,ownership:"agent",createdBy:"agent"};available.push(info);}
      return {spaceId:info.id};
    },s=>s.toLowerCase(),crypto,new Map(),(r,a)=>r.accounts[a].identity,async()=>{saves++;},
    ()=>({accounts:{},projects:{},chats:{},spaces:{}}),()=>name,"a",(_cmd,_kind,payload)=>{writes.push(payload);},baselines);
  assert.equal((await api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a)).spaceName,legacy);
  assert.equal((await api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a)).spaceName,legacy);
  assert.equal(creates,1);
  available=[{id:16,name:legacy,profileId:"P3",ownership:"agent",createdBy:"agent"}];
  const raw=structuredClone(reg);raw.chats.s={id:"s",project:"P",account:"a",spaceName:"old",page:"protected"};
  baselines.set(reg,raw);
  const repaired=await api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a,{preview:true});
  assert.equal(repaired.spaceName,scoped);assert.equal(available[0].id,16);assert.equal(available[0].profileId,"P3");
  assert.equal(writes.length,0);assert.equal(saves,1);
  assert.deepEqual(reg.capacityOverflow["login-a|P1"],raw.capacityOverflow["login-a|P1"]);
  const attached=structuredClone(reg);attached.capacityOverflow["login-a|P1"]=repaired.mapping;attached.chats.s={id:"s",project:"P",account:"a",spaceName:scoped,spaceId:9,profileId:profile,page:"p7"};
  assert.equal(api.normalizeRegistry(structuredClone(attached)).chats.s.page,"p7");
  for(const field of ["identity","profileId","spaceId","spaceName"]){
    const bad=structuredClone(attached);bad.capacityOverflow["login-a|P1"][field]="foreign";
    assert.equal(api.normalizeRegistry(bad).chats.s.page,null,field);
  }
  reg.capacityOverflow["login-a|P1"]=repaired.mapping;
  for(const bad of [
    [{id:9,name:scoped,profileId:profile,ownership:"user",createdBy:"agent"}],
    [{id:9,name:scoped,profileId:"P3",ownership:"agent",createdBy:"agent"}],
    [{id:9,name:scoped,profileId:profile,ownership:"agent",createdBy:"user"}],
    [{id:9,name:scoped,profileId:profile,ownership:"agent",createdBy:"agent"},{id:10,name:scoped,profileId:profile,ownership:"agent",createdBy:"agent"}]
  ]) {
    available=bad;const count=opened;
    await assert.rejects(()=>api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a));assert.equal(opened,count);
  }
  const fresh=structuredClone(reg);delete fresh.capacityOverflow["login-a|P1"];
  available=[{id:16,name:legacy,profileId:"P3",ownership:"agent",createdBy:"agent"}];wrongCreation=true;
  const count=saves;
  await assert.rejects(()=>api.overflowManagedTask(fresh,"P","a",fresh.projects.P.bindings.a),/VERIFICATION_FAILED/);
  assert.equal(saves,count);assert.equal(fresh.capacityOverflow["login-a|P1"],undefined);
});
