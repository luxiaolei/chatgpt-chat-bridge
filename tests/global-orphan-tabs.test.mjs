import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";

import "../src/task-policy.js";
const source=await readFile(path.resolve("src/main.js"),"utf8");
const begin=source.indexOf("async function pruneManagedOrphanTabs");
const end=source.indexOf("\nasync function watchOnce",begin);
assert.ok(begin>=0&&end>begin);
const code='const {composerIsEmpty}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n'+source.slice(begin,end);
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;

test("global orphan cleanup closes only inactive agent orphan tabs",async()=>{
  const closed=[];
  const pages=[
    {label:"p1",close:async()=>closed.push("p1")},
    {label:"p2",close:async()=>closed.push("p2")},
    {label:"p3",close:async()=>closed.push("p3")},
    {label:"p4",close:async()=>closed.push("p4")},
  ];
  const tabs=[
    {label:"p1",url:"chrome://newtab/",active:false,openedBy:"agent"},
    {label:"p2",url:"https://chatgpt.com/",active:false,openedBy:"agent"},
    {label:"p3",url:"https://chatgpt.com/",active:false,openedBy:"user"},
    {label:"p4",url:"https://chatgpt.com/",active:true,openedBy:"agent"},
  ];
  const fn=await new AsyncFunction("listTaskSpaces","loadRuntime","taskSpace","pagesOf","spaceProtection","samePhysicalSpace","state",code+";return pruneManagedOrphanTabs;")(
    async()=>[{id:7,name:"chat-bridge-agent-a",ownership:"agent",createdBy:"agent",profileId:"Profile 1"}],
    async()=>({tasks:{}}),
    async()=>({pages:async()=>pages,tabs:async()=>tabs}),
    async task=>task.pages(),
    ()=>({labels:new Set(),protectedChatIds:new Set()}),
    ()=>false,
    async()=>({generating:false,composerText:"",composerCount:1,composerRawText:""}),
  );
  const out=await fn({chats:{},accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:{spaceName:"chat-bridge-agent-a",spaceId:7,profileId:"Profile 1",account:"a"}}}}});
  assert.deepEqual(closed,["p1","p2"]);
  assert.equal(out.length,2);
});
