import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
const start=source.indexOf("async function state(");
const end=source.indexOf("\nfunction classifySnapshot",start);
const state=new Function(source.slice(start,end)+";return state;")();
const retryStart=source.indexOf("async function nativeRetry(");
const retryEnd=source.indexOf("\nasync function waitForGenerationStop",retryStart);
const retry=new Function("state","assertImagePageFree",source.slice(retryStart,retryEnd)+";return nativeRetry;")(state,async()=>{});

function node(text="",attributes={},options={}) {
  const item={innerText:text,textContent:text,disabled:!!options.disabled,
    getAttribute:name=>attributes[name]??null,
    getClientRects:()=>options.hidden?[]:[{}],
    closest:selector=>selector.includes("data-message")||selector.includes("search-unit")?options.message||null:null,
    querySelector:()=>options.containsMessage||null,
    querySelectorAll:()=>[],
    contains:other=>other===item,
    click:()=>{item.clicked=true;},
  };
  return item;
}
async function withDom({buttons=[],errors=[],known=[],messages=[]},fn) {
  const root=node(), composer=node(), form=node();
  form.querySelectorAll=()=>buttons;
  const document={title:"ChatGPT",visibilityState:"visible",wasDiscarded:false,
    querySelector:selector=>selector==="main"?root:selector==="form"?form:selector.includes("prompt-textarea")?composer:null,
    querySelectorAll:selector=>selector==="button"?buttons:
      selector.includes('[role="alert"]')?errors:
      selector.startsWith("main div")?known:
      selector.includes("data-message-author-role")||selector.includes("search-unit")?messages:[],
  };
  const values={document,location:{href:"https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc"},
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

test("history Retry controls cannot make a healthy current turn recoverable",async()=>{
  const old=node("old",{"data-message-author-role":"assistant","data-message-id":"old"});
  const current=node("current",{"data-message-author-role":"assistant","data-message-id":"new"});
  const button=node("Retry",{}, {message:old});
  const snapshot=await withDom({messages:[old,current],buttons:[button]},state);
  assert.deepEqual(snapshot.recoveryControls,[]);
});

test("native recovery never selects a historical Retry over the current response",async()=>{
  const old=node("old",{"data-message-author-role":"assistant","data-message-id":"old"});
  const current=node("current",{"data-message-author-role":"assistant","data-message-id":"new"});
  const oldButton=node("Retry",{}, {message:old});
  const currentButton=node("Regenerate response",{}, {message:current});
  await withDom({messages:[old,current],buttons:[oldButton,currentButton]},retry);
  assert.equal(!!oldButton.clicked,false);
  assert.equal(currentButton.clicked,true);
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
