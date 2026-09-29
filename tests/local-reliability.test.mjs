import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

for (const file of ["control-routing", "page-pool", "liveness-policy", "task-policy", "web-policy", "model-policy", "session-policy"]) {
  await import(`../src/${file}.js`);
}
const source=(await readFile(new URL("../src/main.js",import.meta.url),"utf8")).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const healthy={online:true,composerPresent:true,generating:true,mode:"Medium",errorTexts:[],recoveryControls:[]};

async function harness(f={}) {
  f.calls=[];
  f.runtime ||= {tasks:{},sessions:{},projects:{}};
  return await new AsyncFunction("f",source+`
    const reg=f.reg||{};
    loadRuntime=async()=>structuredClone(f.runtime);
    saveRuntime=async value=>{f.runtime=structuredClone(value);f.calls.push('save');};
    saveRegistry=async()=>{f.calls.push('registry');};
    notifyController=async()=>{f.calls.push('notify');return {queued:true,sent:false};};
    stopGeneration=async()=>{f.calls.push('stop');return {stopped:true};};
    waitForGenerationStop=async()=>true;
    sendMessage=async()=>{f.calls.push('send');};
    emitTaskEvent=async()=>null;
    if(f.raw) state=async()=>f.raw;
    if(f.pages) {
      openBoundTask=async()=>({binding:f.binding,task:{spaceId:7,tabs:async()=>f.tabs||[]}});
      pagesOf=async()=>f.pages;
      newManagedPage=async()=>{f.calls.push('new-page');return f.newPage;};
      waitForConversationReady=async()=>true;
      openConversationFromProject=async()=>false;
    }
    return {classifySnapshot,gradedRecover,ensurePage,state,nativeRetry};
  `)(f);
}

test("requested Extra High cannot inherit the shorter observed Medium quiet threshold",async()=>{
  const api=await harness();
  const result=api.classifySnapshot(healthy,{quietForSec:496},{requestedEffort:"Extra High"},"Medium");
  assert.equal(result.stallThresholdSec,720);
  assert.equal(result.sessionState,"RUNNING_QUIET");
  assert.equal(result.effortMismatch,true);
});

test("context-limit discussion in task or assistant prose is not a platform error",()=>{
  const {contextExhausted}=globalThis.__CHAT_BRIDGE_SESSION_POLICY__;
  assert.equal(contextExhausted({errorTexts:[],lastUser:"Handle context too long by checkpointing."}),false);
  assert.equal(contextExhausted({errorTexts:[],lastAssistant:"The maximum context length should not be guessed."}),false);
  assert.equal(contextExhausted({errorTexts:["Maximum context length exceeded."]}),true);
});

test("disabled and historical retry controls cannot trigger recovery",()=>{
  const {recoveryRequired}=globalThis.__CHAT_BRIDGE_SESSION_POLICY__;
  assert.equal(recoveryRequired({errorTexts:[],recoveryControls:[{label:"Retry",disabled:true}]}),false);
  assert.equal(recoveryRequired({errorTexts:[],recoveryControls:[{label:"Retry",historical:true}]}),false);
});

test("quiet generation alone notifies once without stopping or consuming recovery budget",async()=>{
  const t={taskId:"T",project:"P",role:"worker",sessionId:"C",status:"RUNNING"};
  const f={runtime:{tasks:{T:t},sessions:{},projects:{}},raw:healthy};
  const api=await harness(f);
  const observed={...healthy,sessionState:"SUSPECT_STALL",quietForSec:2000,lastProgressAt:"2026-09-29T00:00:00Z"};
  const result=await api.gradedRecover({}, {id:"C",role:"worker"},{},t,observed,{});
  await api.gradedRecover({}, {id:"C",role:"worker"},{},t,observed,{});
  assert.equal(result.action,"DEFERRED");
  assert.equal(f.calls.includes("stop"),false);
  assert.equal(f.calls.includes("send"),false);
  assert.equal(f.calls.filter(x=>x==="notify").length,1);
  assert.equal(f.runtime.tasks.T.status,"RUNNING");
  assert.equal(f.runtime.tasks.T.totalRecoveryAttempts,undefined);
});

test("a durable result recorded after observation must not be replayed by recovery",async()=>{
  const t={taskId:"T",project:"P",role:"worker",sessionId:"C",status:"RUNNING"};
  const f={runtime:{tasks:{T:{...t,status:"RESULT_RECORDED",resultVersion:1}},sessions:{},projects:{}}};
  const api=await harness(f);
  const result=await api.gradedRecover({}, {id:"C",role:"worker"},{},t,{...healthy,sessionState:"IDLE_INCOMPLETE"},{});
  assert.equal(result.action,"SKIPPED");
  assert.equal(f.calls.includes("send"),false);
  assert.equal(f.runtime.tasks.T.status,"RESULT_RECORDED");
});

const id="12345678-1234-1234-1234-123456789abc";
const base="https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef";
function attachmentFixture(actual) {
  let current=actual;
  const calls=[];
  const page={label:"p1",url:async()=>current,goto:async url=>{calls.push(url);current=url;}};
  let newUrl="about:blank";
  const newPage={label:"p2",url:async()=>newUrl,goto:async url=>{newUrl=url;}};
  const binding={spaceId:7,spaceName:"managed",projectUrl:base+"/project"};
  const chat={id,role:"worker",project:"P",account:"a",url:base+"/c/"+id,page:"p1",spaceId:7,pageSpaceId:7,spaceName:"managed"};
  return {chat,calls,f:{binding,pages:[page],tabs:[{label:"p1",url:actual,openedBy:"agent",active:true}],newPage}};
}

test("same conversation with canonical slug/query differences is not navigated again",async()=>{
  const {chat,calls,f}=attachmentFixture(base+"-project-name/c/"+id+"?view=compact");
  const api=await harness(f);
  await api.ensurePage({projects:{P:{bindings:{a:f.binding}}}},chat);
  assert.deepEqual(calls,[]);
  assert.equal(f.calls.includes("new-page"),false);
});

test("a recycled label belonging to a different conversation is never navigated away",async()=>{
  const {chat,calls,f}=attachmentFixture(base+"/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  const api=await harness(f);
  await api.ensurePage({projects:{P:{bindings:{a:f.binding}}}},chat);
  assert.deepEqual(calls,[]);
  assert.equal(f.calls.includes("new-page"),true);
  assert.equal(chat.page,"p2");
});
