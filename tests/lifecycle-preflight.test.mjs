import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

async function fixture(autoReconcile=true, consumed=false) {
  const root=await mkdtemp(path.join(tmpdir(),"chat-bridge-life-"));
  const config=path.join(root,"config"), state=path.join(root,"state");
  await mkdir(config,{recursive:true}); await mkdir(state,{recursive:true});
  const registry={defaultAccount:"default",accounts:{default:{name:"default"}},projects:{
    P:{name:"P",activeAccount:"default",rootController:"root",bindings:{},
      lifecycle:{autoReconcile,minGapSec:0}}
  },chats:{}};
  const runtime={version:2,projects:{P:consumed?{lastReconcileProgressAt:"2026-09-24T06:00:00Z"}:{}},tasks:{
    A:{taskId:"A",project:"P",role:"worker",status:"COMPLETE",github:"https://example/A",updatedAt:"2026-09-24T06:00:00Z"}
  },sessions:{}};
  await writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify(runtime));
  return {config,state};
}

function run(config,state) {
  const script=path.resolve("src/web-preflight.py");
  return execFileSync("python3",[script,"watch",config,state,"watch","--project","P"],{encoding:"utf8"}).trim();
}

test("preflight wakes watchdog for pending project reconcile with no active tasks", async()=>{
  const {config,state}=await fixture(true,false);
  assert.equal(run(config,state),"1");
});

test("preflight stays asleep when reconcile progress was consumed", async()=>{
  const {config,state}=await fixture(true,true);
  assert.equal(run(config,state),"0");
});

test("preflight stays asleep when project auto reconcile is disabled", async()=>{
  const {config,state}=await fixture(false,false);
  assert.equal(run(config,state),"0");
});

test("UI pacing scope follows stable ChatGPT account identity", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"chat-bridge-scope-"));
  const config=path.join(root,"config"), state=path.join(root,"state");
  await mkdir(config,{recursive:true}); await mkdir(state,{recursive:true});
  const registry={
    defaultAccount:"default",
    accounts:{
      default:{name:"default",identity:"user-A"},
      alias:{name:"alias",identity:"user-A"},
      qc:{name:"qc",identity:"user-B"},
    },
    projects:{
      H:{name:"H",activeAccount:"default",bindings:{}},
      A:{name:"A",activeAccount:"alias",bindings:{}},
      Q:{name:"Q",activeAccount:"qc",bindings:{}},
    },
    chats:{},
  };
  await writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({version:2,projects:{},tasks:{},sessions:{}}));
  const script=path.resolve("src/web-preflight.py");
  const scopeFor=(project)=>execFileSync(
    "python3",[script,"scope",config,state,"status","role","--project",project],
    {encoding:"utf8"}
  ).trim();
  assert.equal(scopeFor("H"),scopeFor("A"));
  assert.notEqual(scopeFor("H"),scopeFor("Q"));
});
