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
    releasePhysicalPage=async(_r,_t,page)=>page.close();assertPhysicalPageAvailable=()=>{};
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

    if(f.watch) {
      assertWebAvailable=async()=>{};
      resolveChat=()=>f.chat;
      ensurePage=async()=>({page:{}});
      detectWebRateLimit=async()=>{};
      if(f.recoveryApprovalRace) nativeRetry=async()=>{throw new Error("APPROVAL_REQUIRED");};
    }
    if(f.detach) {
      listTaskSpaces=async()=>[{id:7,name:"managed",profileId:"P1",ownership:"agent",createdBy:"agent"}];
      imageSessionOccupancy=()=>({occupied:false});
      coordinated=command=>{if(command!=="page-reclaim-context")throw Error(command);return {sessionRefs:[],unboundProjectIds:[],unboundAny:false};};
      openBoundTask=async()=>({binding:f.binding,task:{spaceId:7,page:()=>({url:async()=>f.chat.url,evaluate:async()=>"login-a",close:async()=>f.calls.push("close")}),tabs:async()=>f.calls.includes("close")?[]:[{label:"p1",url:f.chat.url,active:false,openedBy:"agent"}]}});
    }
    return {classifySnapshot,gradedRecover,ensurePage,state,nativeRetry,watchOnce,detachTerminalTaskPages};
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

test("approval waits outrank errors, offline and completion without budget or notices",async()=>{
  const t={taskId:"T",project:"P",sessionId:"C",status:"RUNNING",recoveryAttempts:3,totalRecoveryAttempts:8,watchErrorCount:2};
  const f={runtime:{tasks:{T:t},sessions:{},projects:{}}};
  const api=await harness(f);
  const pending={...healthy,approvalRequired:true,generating:false,errorTexts:["permission"],online:false,composerPresent:false};
  const observed=api.classifySnapshot(pending,{quietForSec:2000},t);
  assert.equal(observed.sessionState,"WAITING_USER_APPROVAL");
  assert.equal(observed.recommendation,"WAIT_FOR_USER_APPROVAL");
  for(let n=0;n<2;n++) {
    const decision=await api.gradedRecover({}, {id:"C"},{},t,{...pending,...observed},{aggressive:true});
    assert.equal(decision.action,"DEFERRED");
    assert.equal(decision.reason,"WAITING_USER_APPROVAL");
  }
  assert.deepEqual(f.runtime.tasks.T,t);
  assert.deepEqual(f.calls,[]);
  assert.equal(globalThis.__CHAT_BRIDGE_SESSION_POLICY__.recoveryRequired(pending),false);
  const cleared=api.classifySnapshot({...healthy,approvalRequired:false,errorTexts:["Network error"]},{},t);
  assert.equal(cleared.sessionState,"ERROR_RECOVERABLE");
});

test("pending approval prevents composer mutation as a pre-send defer",()=>{
  const {assertComposerSafe,isPreSendDefer}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;
  assert.throws(()=>assertComposerSafe({approvalRequired:true,inputReady:true,composerText:""}),error=>{
    assert.equal(error.message,"APPROVAL_REQUIRED");
    assert.equal(isPreSendDefer(error),true);
    return true;
  });
});

test("watchdog persists approval observation without changing unfinished status or notice budgets",async()=>{
  const t={taskId:"T",project:"P",sessionId:"C",status:"RUNNING",recoveryAttempts:3,totalRecoveryAttempts:8,watchErrorCount:2,watchdogPendingNotification:"existing pending receipt"};
  const f={watch:true,chat:{id:"C",project:"P",account:"a"},runtime:{tasks:{T:t},sessions:{},projects:{}},
    raw:{...healthy,approvalRequired:true,generating:false,composerText:"",assistantCount:2,lastAssistant:"current",lastAssistantId:"a",assistantChars:7}};
  const api=await harness(f), reg={chats:{C:f.chat}};
  for(let n=0;n<2;n++) {
    const result=await api.watchOnce(reg,null,null,{skipLifecycle:true,aggressive:true});
    assert.equal(result[0].state,"WAITING_USER_APPROVAL");
    assert.equal(result[0].recovery.reason,"WAITING_USER_APPROVAL");
  }
  const live=f.runtime.tasks.T;
  for(const key of ["status","recoveryAttempts","totalRecoveryAttempts","watchErrorCount","watchdogPendingNotification"]) assert.equal(live[key],t[key]);
  assert.equal(live.sessionState,"WAITING_USER_APPROVAL");
  assert.equal(f.runtime.sessions.C.approvalRequired,true);
  assert.equal(f.calls.some(x=>["send","stop","notify"].includes(x)),false);
  f.raw={...f.raw,approvalRequired:false,generating:true};
  const resumed=await api.watchOnce(reg,null,null,{skipLifecycle:true});
  assert.equal(resumed[0].state,"RUNNING_ACTIVE");
  assert.equal(f.runtime.sessions.C.approvalRequired,false);
});

test("approval appearing at recovery action defers without watch failure accounting",async()=>{
  const t={taskId:"T",project:"P",sessionId:"C",status:"RUNNING",watchErrorCount:2,recoveryAttempts:0,totalRecoveryAttempts:0};
  const f={watch:true,recoveryApprovalRace:true,chat:{id:"C",project:"P",account:"a"},runtime:{tasks:{T:t},sessions:{},projects:{}},
    raw:{...healthy,generating:false,errorTexts:["Network error"],assistantCount:1,lastAssistant:"current",assistantChars:7}};
  const api=await harness(f);
  const result=await api.watchOnce({chats:{C:f.chat}},null,null,{skipLifecycle:true});
  assert.equal(result[0].state,"WAITING_USER_APPROVAL");
  for(const key of ["status","watchErrorCount","recoveryAttempts","totalRecoveryAttempts"]) assert.equal(f.runtime.tasks.T[key],t[key]);
  assert.equal(f.calls.some(x=>["send","stop","notify"].includes(x)),false);
});

test("terminal detach keeps an approval page attached and resumes normal cleanup after gate disappears",async()=>{
  const cid="11111111-1111-4111-8111-111111111111",home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project";
  const chat={id:cid,project:"P",account:"a",status:"active",spaceName:"managed",spaceId:7,profileId:"P1",page:"p1",url:home.replace(/project$/,"c/"+cid)};
  const binding={spaceName:"managed",spaceId:7,profileId:"P1",projectUrl:home};
  const f={detach:true,chat,binding,runtime:{tasks:{T:{taskId:"T",project:"P",account:"a",sessionId:cid,status:"RESULT_RECORDED",updatedAt:"2020-01-01T00:00:00Z"}},sessions:{},projects:{}},
    raw:{url:chat.url,inputReady:true,approvalRequired:true,generating:false,composerText:"",composerCount:1,composerAttachmentsEmpty:true,composerRawText:""}};
  const reg=f.reg={accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}},chats:{[cid]:chat}},api=await harness(f);
  assert.deepEqual(await api.detachTerminalTaskPages(reg),[]);
  assert.equal(chat.page,"p1");
  assert.equal(f.calls.includes("close"),false);
  f.raw={...f.raw,approvalRequired:false};
  assert.equal((await api.detachTerminalTaskPages(reg)).length,1);
  assert.equal(chat.page,null);
  assert.equal(f.calls.includes("close"),true);
});
