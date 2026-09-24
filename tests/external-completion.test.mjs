import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root=path.resolve(new URL("..", import.meta.url).pathname);

test("external completion keeps idle assistant result owned by external adapter", async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","lifecycle-policy","web-policy","model-policy","session-policy","event-journal"]) {
    await import(`../src/${file}.js`);
  }
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-external-"));
  const config=path.join(dir,"config"), stateDir=path.join(dir,"state");
  await mkdir(config); await mkdir(stateDir);
  const reg={
    version:2,defaultProject:"P",defaultAccount:"a",accounts:{a:{name:"a"}},
    projects:{P:{name:"P",activeAccount:"a",rootController:"root",bindings:{}}},
    chats:{
      worker:{id:"worker",project:"P",account:"a",status:"active",role:"worker"},
      root:{id:"root",project:"P",account:"a",status:"active",role:"root"},
    },
  };
  const task={
    taskId:"T1",sessionId:"worker",project:"P",account:"a",role:"worker",
    controller:"root",replyTo:"root",escalationTo:"root",rootController:"root",
    status:"RUNNING",completionMode:"external",
  };
  await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
  await writeFile(path.join(stateDir,"runtime.json"),JSON.stringify({version:2,projects:{},tasks:{T1:task},sessions:{}}));
  const oldConfig=globalThis.__CHAT_BRIDGE_CONFIG_DIR__, oldState=globalThis.__CHAT_BRIDGE_STATE_DIR__;
  globalThis.__CHAT_BRIDGE_CONFIG_DIR__=config; globalThis.__CHAT_BRIDGE_STATE_DIR__=stateDir;
  try {
    const source=(await readFile(path.join(root,"src/main.js"),"utf8")).split('const cmd=args[0] || "help";')[0];
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const sent=[];
    const api=await new AsyncFunction("setTimeout","taskSpace",source+`
      const reg=await loadRegistry();
      return {
        reg,
        watchOnce,
        override:(ensure,observe)=>{ensurePage=ensure;observeSession=observe;},
        sender:(fn)=>{sendMessage=fn;}
      };
    `)(callback=>callback(),async()=>({spaceId:1,pages:async()=>[]}));
    api.sender(async(_page,message)=>sent.push(message));
    api.override(async()=>({page:{}}),async()=>({
      sessionState:"IDLE_COMPLETE",recommendation:"RECONCILE_DURABLE_STATE",
      quietForSec:0,runningForSec:0,lastProgressAt:new Date().toISOString(),
      lastAssistantId:"assistant-1",lastAssistant:"{\"op\":\"context\",\"section\":\"index\"}",
    }));
    const results=await api.watchOnce(reg,null,null,{autoRecover:true});
    assert.equal(results[0].state,"IDLE_COMPLETE");
    assert.equal(results[0].notification,null);
    assert.equal(sent.length,0);
    const runtime=JSON.parse(await readFile(path.join(stateDir,"runtime.json"),"utf8"));
    assert.equal(runtime.tasks.T1.status,"RUNNING");
    assert.equal(runtime.tasks.T1.completionMode,"external");
    assert.equal(runtime.tasks.T1.externalResponsePending,true);
    assert.equal(runtime.tasks.T1.watchdogResultNotifiedAt,null);
    const events=await globalThis.__CHAT_BRIDGE_EVENTS__.listEvents(stateDir,{project:"P",account:"a"});
    assert.equal(events.length,1);
    assert.equal(events[0].type,"ASSISTANT_RESPONSE_READY");
    assert.equal(events[0].data.assistantId,"assistant-1");
    assert.match(events[0].data.assistantText,/"op":"context"/);
    await api.watchOnce(reg,null,null,{autoRecover:true});
    const deduped=await globalThis.__CHAT_BRIDGE_EVENTS__.listEvents(stateDir,{project:"P",account:"a"});
    assert.equal(deduped.length,1);
  } finally {
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=oldConfig;
    globalThis.__CHAT_BRIDGE_STATE_DIR__=oldState;
  }
});
