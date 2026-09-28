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

test("overflow is one managed Space per verified login/Profile and never takes user Space", async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const start=source.indexOf("function managedSpacePlan");
  const planEnd=source.indexOf("\nasync function accountManagedTask",start);
  const overflowStart=source.indexOf("async function overflowManagedTask");
  const overflowEnd=source.indexOf("\nasync function newManagedPage",overflowStart);
  const code=source.slice(start,planEnd)+source.slice(overflowStart,overflowEnd);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const task={spaceId:9,newPage:async()=>({label:"p1"})};
  const reg={accounts:{a:{identity:"login-a",label:"A"}},spaces:{canonical:{identity:"login-a",accountName:"A",profileId:"P1",name:"chat-bridge-agent-a",ownership:"agent"}},projects:{P:{bindings:{a:{projectUrl:"https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",projectId:"g-p-"+"a".repeat(32),spaceName:"chat-bridge-agent-a",profileId:"P1"}}}}};
  const taskAccounts=new Map(); let available=[]; let creates=0;
  const api=await new AsyncFunction("listTaskSpaces","taskSpace","slug","crypto","taskAccounts","accountScope","saveRegistry",code+";return {overflowManagedTask};")(
    async()=>available,async name=>{if(!available.length) creates++;assert.equal(name,"chat-bridge-agent-a-overflow");return task;},s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,""),await import("node:crypto"),taskAccounts,(r,a)=>r.accounts[a].identity,async()=>{});
  const first=await api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a);
  assert.equal(first.spaceName,"chat-bridge-agent-a-overflow");
  const existing={name:first.spaceName,profileId:"P1",ownership:"agent"}; available=[existing];
  const reused=await api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a);
  assert.equal(reused.spaceName,first.spaceName); assert.equal(creates,1);
  available=[{name:first.spaceName,profileId:"P1",ownership:"user"}];
  await assert.rejects(()=>api.overflowManagedTask(reg,"P","a",reg.projects.P.bindings.a),error=>error?.code==="SPACE_IN_USER_CONTROL");
});
