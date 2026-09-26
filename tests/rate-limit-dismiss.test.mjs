import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
globalThis.__CHAT_BRIDGE_STORE_PATH__=path.resolve("src/state-store.py");
globalThis.__CHAT_BRIDGE_COORDINATOR_PATH__=path.resolve("src/coordinator.py");

const root=path.resolve(import.meta.dirname,"..");

test("dismissible rate-limit dialog recovers without persisting cooldown",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) {
    await import(`../src/${file}.js`);
  }
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-dismiss-rate-limit-"));
  const config=path.join(dir,"config"),state=path.join(dir,"state");
  await mkdir(config); await mkdir(state);
  const reg={
    version:2,
    defaultProject:"A",
    defaultAccount:"a",
    accounts:{a:{identity:"same"}},
    projects:{A:{activeAccount:"a",bindings:{}}},
    chats:{}
  };
  await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
  const oldConfig=globalThis.__CHAT_BRIDGE_CONFIG_DIR__;
  const oldState=globalThis.__CHAT_BRIDGE_STATE_DIR__;
  globalThis.__CHAT_BRIDGE_CONFIG_DIR__=config;
  globalThis.__CHAT_BRIDGE_STATE_DIR__=state;
  try {
    const source=(await readFile(path.join(root,"src/main.js"),"utf8")).split('const cmd=args[0] || "help";')[0];
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const api=await new AsyncFunction("setTimeout","taskSpace",source+`
      const reg=await loadRegistry();
      return {detectWebRateLimit,bind:(id,a)=>taskAccounts.set(id,a)};
    `)(callback=>callback(),async()=>({}));
    api.bind(1,"a");
    let calls=0;
    const page={
      spaceId:1,
      evaluate:async()=>{
        calls+=1;
        if(calls===1) return {candidates:["Too many requests"],dismissed:1};
        return {candidates:[],dismissed:0};
      },
      waitForTimeout:async()=>{}
    };
    const result=await api.detectWebRateLimit(page,"status");
    assert.deepEqual(result,{recovered:true,dismissed:true});
    assert.equal(calls,2);
    const cooldownDir=path.join(state,"web-cooldowns");
    const exists=await stat(cooldownDir).then(()=>true).catch(()=>false);
    assert.equal(exists,false);
  } finally {
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=oldConfig;
    globalThis.__CHAT_BRIDGE_STATE_DIR__=oldState;
    await rm(dir,{recursive:true,force:true});
  }
});

test("non-dismissible rate-limit surface still persists cooldown",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) {
    await import(`../src/${file}.js`);
  }
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-hard-rate-limit-"));
  const config=path.join(dir,"config"),state=path.join(dir,"state");
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config,"registry.json"),JSON.stringify({
    version:2,defaultProject:"A",defaultAccount:"a",
    accounts:{a:{identity:"same"}},projects:{A:{activeAccount:"a",bindings:{}}},chats:{}
  }));
  const oldConfig=globalThis.__CHAT_BRIDGE_CONFIG_DIR__;
  const oldState=globalThis.__CHAT_BRIDGE_STATE_DIR__;
  globalThis.__CHAT_BRIDGE_CONFIG_DIR__=config;
  globalThis.__CHAT_BRIDGE_STATE_DIR__=state;
  try {
    const source=(await readFile(path.join(root,"src/main.js"),"utf8")).split('const cmd=args[0] || "help";')[0];
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const api=await new AsyncFunction("setTimeout","taskSpace",source+`
      const reg=await loadRegistry();
      return {detectWebRateLimit,bind:(id,a)=>taskAccounts.set(id,a)};
    `)(callback=>callback(),async()=>({}));
    api.bind(1,"a");
    const page={spaceId:1,evaluate:async()=>({candidates:["Too many requests"],dismissed:0})};
    await assert.rejects(api.detectWebRateLimit(page,"status"),{code:"WEB_RATE_LIMITED"});
    const files=await import("node:fs/promises").then(fs=>fs.readdir(path.join(state,"web-cooldowns")));
    assert.equal(files.length,1);
  } finally {
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=oldConfig;
    globalThis.__CHAT_BRIDGE_STATE_DIR__=oldState;
    await rm(dir,{recursive:true,force:true});
  }
});
