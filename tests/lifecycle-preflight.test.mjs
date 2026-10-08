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
  },chats:{root:{id:"root",project:"P",account:"default",role:"root",status:"active"}}};
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

test("preflight wakes for an aged terminal agent tab and sleeps after detach", async()=>{
  const {config,state}=await fixture(false,false);
  const fs=await import("node:fs/promises");
  const registry=JSON.parse(await fs.readFile(path.join(config,"registry.json"),"utf8"));
  const runtime=JSON.parse(await fs.readFile(path.join(state,"runtime.json"),"utf8"));
  registry.chats.worker={id:"worker",project:"P",account:"default",status:"active",page:"p2"};
  runtime.tasks.A.sessionId="worker";
  await fs.writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await fs.writeFile(path.join(state,"runtime.json"),JSON.stringify(runtime));
  assert.equal(run(config,state),"1");
  registry.chats.worker.page=null;
  await fs.writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  assert.equal(run(config,state),"0");
});

test("preflight wakes for an aged settled BLOCKED agent tab", async()=>{
  const {config,state}=await fixture(false,false);
  const fs=await import("node:fs/promises");
  const registry=JSON.parse(await fs.readFile(path.join(config,"registry.json"),"utf8"));
  const runtime=JSON.parse(await fs.readFile(path.join(state,"runtime.json"),"utf8"));
  registry.chats.worker={id:"worker",project:"P",account:"default",status:"active",page:"p2"};
  runtime.tasks.A.sessionId="worker";
  runtime.tasks.A.status="BLOCKED";
  await fs.writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await fs.writeFile(path.join(state,"runtime.json"),JSON.stringify(runtime));
  assert.equal(run(config,state),"1");
});

test("preflight stays asleep while project reconcile is paused for user control", async()=>{
  const {config,state}=await fixture(true,false);
  const runtime=JSON.parse(await (await import("node:fs/promises")).readFile(path.join(state,"runtime.json"),"utf8"));
  runtime.projects.P={watchdogPausedForUserControl:true,watchdogPausedSpace:"Manual"};
  await writeFile(path.join(state,"runtime.json"),JSON.stringify(runtime));
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

test("watch-all uses separate public scoped reclaim without trusting a task child exit or waking idle lanes",()=>{
  const code=String.raw`import tempfile,pathlib,sys,importlib.util,json
spec=importlib.util.spec_from_file_location("web",pathlib.Path("src/web-preflight.py"));w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);state=p/"state";state.mkdir();config=p/"config";config.mkdir()
 reg={"defaultAccount":"a","accounts":{"a":{"identity":"login"}},"projects":{"P":{},"Q":{}},"chats":{}}
 rt={"tasks":{str(i):{"taskId":str(i),"account":"a","project":name,"status":"RUNNING"} for i,name in enumerate(["P","P","Q"])}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps(rt))
 calls=[]
 class Completed:returncode=0;stdout='{"ok":true,"closed":[]}';stderr=""
 w.subprocess.run=lambda args,**kwargs:(calls.append(args) or Completed())
 def run():
  try:w.run("watch-all",config,state,["bridge","watch"])
  except SystemExit as e:assert e.code==0
 run();assert len(calls)==5,calls
 assert all("--skip-lifecycle" in a for a in calls[:3]),calls
 assert [a[a.index("--project")+1] for a in calls]==["P","P","Q","P","Q"],calls
 assert all(a[1:4]==["space","prune","--all"] for a in calls[3:]),calls
 calls.clear()
 try:w.run("watch-all",config,state,["bridge","watch","--dry-run"])
 except SystemExit as e:assert e.code==0
 assert len(calls)==3 and not any("prune" in a for a in calls),calls
 calls.clear()
 calls.clear();w.cooldown=lambda *args:{"active":True};run();assert not calls
 rt["tasks"]={};(state/"runtime.json").write_text(json.dumps(rt));w.cooldown=lambda *args:{"active":False};run();assert not calls
 print("PASS scoped admission, dedup, cooldown, idle")`;
  assert.match(execFileSync("python3",["-c",code],{encoding:"utf8"}),/PASS scoped admission/);
});
