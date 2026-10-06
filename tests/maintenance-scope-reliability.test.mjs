import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
const begin=source.indexOf("async function pruneManagedOrphanTabs");
const end=source.indexOf("\nasync function watchOnce",begin);
const code=source.slice(begin,end);
const projectHomeId=new Function(source.slice(source.indexOf("function projectHomeId("),source.indexOf("\nfunction projectKey("))+";return projectHomeId;")();
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
async function fixture(reg,spaces,account="a") {
 const visited=[];
 const prune=await new AsyncFunction("listTaskSpaces","loadRuntime","openBoundTask","pagesOf","spaceProtection","samePhysicalSpace","state","reclaimOrphanManagedPage","projectHomeId",code+";return pruneManagedOrphanTabs;")(
   async()=>spaces,async()=>({tasks:{}}),async(_r,_p,_a,options)=>{visited.push(options.spaceOverride.spaceId);return {binding:options.spaceOverride,task:{spaceId:options.spaceOverride.spaceId,tabs:async()=>[]}};},
   async()=>[],()=>({labels:new Set()}),()=>false,async()=>({generating:false,composerText:""}),async()=>null,projectHomeId);
 await prune(reg,null,account);return visited;
}

test("account-scoped cleanup cannot visit another login even when Space labels collide",async()=>{
 const reg={accounts:{a:{identity:"one"},b:{identity:"two"}},projects:{P:{bindings:{a:{spaceName:"chat-bridge-agent-same",spaceId:7,profileId:"Profile 1"},b:{spaceName:"chat-bridge-agent-same",spaceId:8,profileId:"Profile 2"}}}},chats:{}};
 const spaces=[{id:7,name:"chat-bridge-agent-same",ownership:"agent",createdBy:"agent",profileId:"Profile 1"},{id:8,name:"chat-bridge-agent-same",ownership:"agent",createdBy:"agent",profileId:"Profile 2"},{id:9,name:"manual",ownership:"user"}];
 assert.deepEqual(await fixture(reg,spaces),[7]);
});

test("unknown numeric Space identity with ambiguous names fails closed during cleanup",async()=>{
 const reg={accounts:{a:{identity:"one"}},projects:{P:{bindings:{a:{spaceName:"same"}}}},chats:{}};
 assert.deepEqual(await fixture(reg,[{id:7,name:"chat-bridge-agent-same",ownership:"agent",createdBy:"agent",profileId:"Profile 1"},{id:8,name:"chat-bridge-agent-same",ownership:"agent",createdBy:"agent",profileId:"Profile 2"}]),[]);
});

test("state-store failures defer watchdog work without marking the worker failed or writing counters",async()=>{
 for(const f of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${f}.js`);
 const prefix=source.split('const cmd=args[0] || "help";')[0];
 const run=await new AsyncFunction(prefix+`
   const task={taskId:'T',sessionId:'C',project:'P',account:'a',role:'worker',status:'RUNNING'};
   const reg={projects:{P:{}},chats:{C:{id:'C',project:'P',account:'a',role:'worker',status:'active'}}};
   let writes=0;
   loadRuntime=async()=>({tasks:{T:{...task}},sessions:{},projects:{}});
   resolveChat=()=>reg.chats.C;
   assertWebAvailable=async()=>{};
   ensurePage=async()=>{throw new Error('STATE_STORE_RUNTIME: database is locked');};
   saveRuntime=async()=>{writes++;};
   const result=await watchOnce(reg,'P','a',{skipLifecycle:true});
   return {result,writes};
 `)();
 assert.equal(run.writes,0);assert.equal(run.result[0].state,"STATE_STORE_DEFERRED");
});

test("actual space prune --all CLI retains existing Project and account filters",async()=>{
 const opt=source.slice(source.indexOf("function opt("),source.indexOf("\nfunction boolValue("));
 const start=source.indexOf('else if(cmd==="space"){'),end=source.indexOf('\nelse if(',start+1),branch=source.slice(start,end);
 const calls=[],output=[];
 await new AsyncFunction("args","reg","pruneManagedOrphanTabs","print",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch)(
     ["space","prune","--all","--project","P","--account","a"],{},async(_r,p,a)=>{calls.push([p,a]);return [];},value=>output.push(value));
 assert.deepEqual(calls,[["P","a"]]);assert.deepEqual(output,[{ok:true,closed:[]}]);
 calls.length=0;
 await new AsyncFunction("args","reg","pruneManagedOrphanTabs","print",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch)(
     ["space","prune","--all"],{},async(_r,p,a)=>{calls.push([p,a]);return [];},()=>{});
 assert.deepEqual(calls,[[null,null]]);
});
