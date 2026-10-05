import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

const coordinator=path.resolve("src/coordinator.py");

test("queue capacity exhaustion waits with backoff and stays distinct from BLOCKED", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"bridge-capacity-")), config=path.join(root,"config"), state=path.join(root,"state");
  await mkdir(config); await mkdir(state);
  const registry={defaultAccount:"a",accounts:{a:{identity:"login-a"}},projects:{P:{activeAccount:"a",bindings:{a:{projectUrl:"https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",spaceName:"agent-a"}}}},chats:{controller:{id:"controller",project:"P",account:"a",role:"conductor",status:"active"}}};
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
