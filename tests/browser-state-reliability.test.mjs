import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import "../src/task-policy.js";
import "../src/page-pool.js";
import "../src/session-policy.js";
const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
const start=source.indexOf("async function state(");
const end=source.indexOf("\nfunction classifySnapshot",start);
const state=new Function(source.slice(start,end)+";return state;")();
const retryStart=source.indexOf("async function nativeRetry(");
const retryEnd=source.indexOf("\nasync function waitForGenerationStop",retryStart);
const retry=new Function("state","assertImagePageFree",source.slice(retryStart,retryEnd)+";return nativeRetry;")(state,async()=>{});

function node(text="",attributes={},options={}) {
  const item={innerText:text,textContent:text,tagName:options.tagName||"DIV",disabled:!!options.disabled,
    getAttribute:name=>attributes[name]??null,
    getClientRects:()=>options.hidden?[]:[{}],
    getBoundingClientRect:()=>({width:options.hidden?0:100,height:options.hidden?0:40}),
    closest:selector=>selector.includes("data-message")||selector.includes("search-unit")?options.message||null:null,
    querySelector:()=>options.containsMessage||null,
    querySelectorAll:()=>[],
    contains:other=>other===item,
    click:()=>{item.clicked=true;},
  };
  return item;
}
async function withDom({buttons=[],errors=[],known=[],messages=[],files=[],previews=[],inline=[],missingForm=false,url="https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"},fn) {
  const root=node(), composer=node(), form=node();
  composer.closest=selector=>selector==="form"&&!missingForm?form:null;
  composer.querySelectorAll=()=>inline;
  root.matches=selector=>selector==='main, [role="main"]';
  root.contains=other=>other===root||buttons.includes(other)||errors.includes(other)||known.includes(other)||messages.includes(other);
  form.querySelectorAll=selector=>selector==="button"?buttons:
    selector==='button[aria-label^="Remove "], img, [data-testid="attachment-preview"]'?previews.filter(p=>p.tagName==="IMG"||p.getAttribute('aria-label')?.startsWith("Remove ")||p.getAttribute('data-testid')==="attachment-preview"):[];
  const document={title:"ChatGPT",visibilityState:"visible",wasDiscarded:false,
    querySelector:selector=>selector==="main"?root:selector==="form"?form:selector.includes("prompt-textarea")?composer:null,
    querySelectorAll:selector=>selector==="button"?buttons:
      selector==='input[type="file"]'?files:
      selector.includes("prompt-textarea")?[composer]:
      selector.includes('[role="alert"]')?errors:
      selector.startsWith("main div")?known:
      selector.includes("data-message-author-role")||selector.includes("search-unit")?messages:[],
  };
  const values={document,location:{href:url},
    navigator:{onLine:true},getComputedStyle:()=>({visibility:"visible",display:"block",opacity:"1"}),
    __CHAT_BRIDGE_WATCH:{root,seq:0,lastMutationAt:Date.now(),startedAt:Date.now()},
  };
  const saved=new Map(Object.keys(values).map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    for(const [k,v] of Object.entries(values)) Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
    return await fn({evaluate:async(func,arg)=>func(arg)});
  } finally {
    for(const [k,d] of saved) {if(d) Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
  }
}

test("hidden or disabled Stop controls do not report active generation",async()=>{
  for(const options of [{hidden:true},{disabled:true}]) {
    const snapshot=await withDom({buttons:[node("Stop generating",{"data-testid":"stop-button"},options)]},state);
    assert.equal(snapshot.generating,false);
  }
});

test("actual DOM attachment-only drafts protect shared reclaim, control reuse and empty-page cleanup",async()=>{
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const section=(a,z)=>source.slice(source.indexOf(a),source.indexOf(z,source.indexOf(a)));
  const projectHomeId=new Function(section("function projectHomeId(","\nfunction projectKey(")+";return projectHomeId;")();
  const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",cid="11111111-1111-4111-8111-111111111111";
  const {activeTaskStatus,composerIsEmpty,assertComposerSafe}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;
  const file={files:[new File(["synthetic"],"draft.pdf",{type:"application/pdf"})]};
  const throwing={get files(){throw Error("FileList unavailable");}};
  for(const [name,dom,safe] of [
    ["empty",{},true],
    ["empty file control",{files:[{files:[]}]},true],
    ["PDF and preview",{files:[file],previews:[node("draft.pdf",{"aria-label":"Remove draft.pdf"})]},false],
    ["selected PDF only",{files:[file]},false],
    ["preview after FileList reset",{files:[{files:[]}],previews:[node("draft.pdf",{"aria-label":"Remove draft.pdf"},{disabled:true,hidden:true})]},false],
    ["image preview only",{previews:[node("",{},{tagName:"IMG"})]},false],
    ["attachment card only",{previews:[node("draft.pdf",{"data-testid":"attachment-preview"})]},false],
    ["nontext editor node",{inline:[node("",{contenteditable:"false"})]},false],
    ["FileList unknown",{files:[{files:null}]},false],
    ["FileList read failure",{files:[throwing]},false],
    ["composer form unknown",{missingForm:true},false],
  ]) for(const entry of ["registered","orphan","reuse","close"]) await withDom(dom,async page=>{
    const binding={spaceName:"managed",spaceId:9,profileId:"P1",projectUrl:home,...(entry==="reuse"?{controlPage:"p9"}:{})};
    const url=entry==="registered"?home.replace(/project$/,"c/"+cid):home;
    const chat={id:cid,project:"P",account:"a",role:"worker",status:"active",spaceName:"managed",spaceId:9,page:"p9",url};
    const reg={accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}},chats:entry==="registered"?{[cid]:chat}:{}};
    const rt={tasks:entry==="registered"?{t:{sessionId:cid,project:"P",account:"a",status:"COMPLETE"}}:{}};
    let closes=0,saves=0;
    Object.assign(page,{label:"p9",url:async()=>url,close:async()=>{closes++;}});
    const task={spaceId:9,page:()=>page,pages:async()=>[page],tabs:async()=>[{label:"p9",url,active:false,openedBy:"agent"}]};
    const api=await new AsyncFunction("loadRuntime","state","saveRegistry","imageSessionOccupancy","activeTaskStatus","composerIsEmpty","pageDetachCandidates","orphanManagedPageCandidates","sameConversationUrl","projectHomeId","coordinated","openBoundTask",
      "const {draftDiscardProject}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n"+section("function samePhysicalSpace","\nasync function overflowManagedTask")+
      section("async function closeEmptyPage(","\nasync function nativeSubmissionWitness")+";return {reclaimIdlePageSlot,reclaimOrphanManagedPage,closeEmptyPage};")(
      async()=>rt,state,async()=>{saves++;},()=>({occupied:false}),activeTaskStatus,composerIsEmpty,
      globalThis.__CHAT_BRIDGE_PAGE_POOL__.pageDetachCandidates,globalThis.__CHAT_BRIDGE_PAGE_POOL__.orphanManagedPageCandidates,
      globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,projectHomeId,
      ()=>({sessionRefs:[],unboundProjectIds:[],unboundAny:false}),async()=>({task,binding}));
    const result=entry==="registered"?await api.reclaimIdlePageSlot(reg,"P","a",task,binding):entry==="close"?await api.closeEmptyPage(page):
      await api.reclaimOrphanManagedPage(reg,task,binding,"a",entry==="reuse"?binding:null);
    assert.equal(closes,safe&&entry!=="reuse"?1:0,`${name}:${entry} closes`);
    assert.equal(saves,safe&&entry==="registered"?1:0,`${name}:${entry} registry writes`);
    if(entry==="registered"&&!safe) assert.equal(chat.page,"p9");
    if(entry==="reuse") assert.equal(result?.handle===page,safe,`${name}: reuse`);
    const snapshot=await state(page);
    assert.equal(snapshot.composerCount,1);assert.equal(snapshot.composerRawText,"");
    assert.equal(composerIsEmpty(snapshot),safe,`${name}: shared predicate`);
    if(!safe) assert.throws(()=>assertComposerSafe(snapshot),/USER_DRAFT_PRESENT/);
    assert.equal(composerIsEmpty(await state(page,false,null,false)),false,"omitted draft observations remain unknown");
  });
});

test("history Retry controls cannot make a healthy current turn recoverable",async()=>{
  const old=node("old",{"data-message-author-role":"assistant","data-message-id":"old"});
  const current=node("current",{"data-message-author-role":"assistant","data-message-id":"new"});
  const button=node("Retry",{}, {message:old});
  const snapshot=await withDom({messages:[old,current],buttons:[button]},state);
  assert.deepEqual(snapshot.recoveryControls,[]);
});

test("strict Retry selects neither a historical Retry nor current Regenerate",async()=>{
  const old=node("old",{"data-message-author-role":"assistant","data-message-id":"old"});
  const current=node("current",{"data-message-author-role":"assistant","data-message-id":"new"});
  const oldButton=node("Retry",{}, {message:old});
  const currentButton=node("Regenerate response",{}, {message:current});
  await withDom({messages:[old,current],buttons:[oldButton,currentButton]},retry);
  assert.equal(!!oldButton.clicked,false);
  assert.equal(!!currentButton.clicked,false);
});

test("stream restoration error is recognized outside a role=alert container",async()=>{
  const snapshot=await withDom({known:[node("Resume stream unavailable")]},state);
  assert.deepEqual(snapshot.errorTexts,["Resume stream unavailable"]);
});

test("an ancestor wrapping quoted error prose is not platform error UI",async()=>{
  const message=node("Something went wrong is an example.",{"data-message-author-role":"assistant","data-message-id":"new"});
  const wrapper=node("Something went wrong is an example.",{}, {containsMessage:message});
  const snapshot=await withDom({known:[wrapper],messages:[message]},state);
  assert.deepEqual(snapshot.errorTexts,[]);
});

const approvalFixture=JSON.parse(await readFile(new URL("./fixtures/codex-tasks-approval.json",import.meta.url),"utf8"));
const approvalText=[...approvalFixture.heading,approvalFixture.description].join("\n");

test("observed Codex Tasks permission card waits without Retry or Stop",async()=>{
  assert.equal(approvalFixture.messageAncestor,null);
  assert.deepEqual(approvalFixture.messageDescendants,[]);
  const card=node(approvalText,{role:approvalFixture.node.role,"aria-atomic":approvalFixture.node.ariaAtomic});
  const buttons=[node("Retry"),node("Stop generating")];
  const snapshot=await withDom({errors:[card],buttons},state);
  assert.equal(snapshot.approvalRequired,true);
  for(const action of ["retry","stop"]) {
    await assert.rejects(withDom({errors:[card],buttons},p=>state(p,false,action)),/APPROVAL_REQUIRED/);
  }
  assert.equal(buttons.some(b=>b.clicked),false);
});

test("approval detection excludes hidden, historical, quoted and ordinary error UI",async()=>{
  const message=node(approvalText,{"data-message-author-role":"assistant"});
  for(const errors of [
    [node(approvalText,{}, {hidden:true})],
    [node(approvalText,{}, {message})],
    [node(approvalText,{}, {containsMessage:message})],
    [node("Example: "+approvalText)],
    [node("Something went wrong")],
    [node("Allow ChatGPT to use another tool?")]
  ]) {
    const snapshot=await withDom({errors,messages:[message]},state);
    assert.equal(snapshot.approvalRequired,false);
  }
  const snapshot=await withDom({},state);
  assert.equal(snapshot.approvalRequired,false);
});

test("historical approval UI is excluded from current recovery state",async()=>{
  const old=node("old",{"data-message-author-role":"assistant"});
  const current=node("current",{"data-message-author-role":"assistant"});
  const snapshot=await withDom({messages:[old,current],errors:[node(approvalText,{}, {message:old})]},state);
  assert.equal(snapshot.approvalRequired,false);
});
