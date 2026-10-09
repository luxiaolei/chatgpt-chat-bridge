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
 const prune=await new AsyncFunction("listTaskSpaces","loadRuntime","openBoundTask","pagesOf","spaceProtection","samePhysicalSpace","state","reclaimOrphanManagedPage","projectHomeId","coordinated",code+";return pruneManagedOrphanTabs;")(
   async()=>spaces,async()=>({tasks:{}}),async(_r,_p,_a,options)=>{visited.push(options.spaceOverride.spaceId);return {binding:options.spaceOverride,task:{spaceId:options.spaceOverride.spaceId,tabs:async()=>[]}};},
   async()=>[],()=>({labels:new Set()}),()=>false,async()=>({generating:false,composerText:""}),async()=>null,projectHomeId,()=>({unboundAny:false}));
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
 await new AsyncFunction("args","reg","pruneManagedOrphanTabs","print","coordinated",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch)(
     ["space","prune","--all","--project","P","--account","a"],{},async(_r,p,a)=>{calls.push([p,a]);return [];},value=>output.push(value),()=>({unboundAny:false}));
 assert.deepEqual(calls,[["P","a"]]);assert.deepEqual(output,[{ok:true,closed:[]}]);
 calls.length=0;
 await new AsyncFunction("args","reg","pruneManagedOrphanTabs","print","coordinated",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch)(
     ["space","prune","--all"],{},async(_r,p,a)=>{calls.push([p,a]);return [];},()=>{},()=>({unboundAny:false}));
 assert.deepEqual(calls,[[null,null]]);
});

test("maintenance inspects candidates without removing account UNKNOWN protection",async()=>{
 for(const f of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${f}.js`);
 const prefix=source.split('const cmd=args[0] || "help";')[0];
 const result=await new AsyncFunction(prefix+`
   const binding={projectUrl:'https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'/project',spaceName:'managed',spaceId:7,profileId:'P1',account:'a'};
   const chat={id:'C',project:'P',account:'a',role:'worker',status:'active',page:'p1',spaceName:'managed',spaceId:7,profileId:'P1'};
   const reg={accounts:{a:{identity:'login'}},projects:{P:{bindings:{a:binding}}},chats:{C:chat}};
   const before=JSON.stringify(reg), reads=[], queries=[];
   const web=async()=>{reads.push('Web');return [];};
   const task={spaceId:7,pages:web,tabs:web};
   coordinated=(command,payload)=>{if(command!=='page-reclaim-context')throw Error(command);queries.push(payload);return {unboundAny:true};};
   loadRuntime=async()=>({tasks:{T:{taskId:'T',sessionId:'C',project:'P',account:'a',status:'COMPLETE',updatedAt:'2000-01-01T00:00:00Z'}}});
   imageSessionOccupancy=()=>({occupied:false});listTaskSpaces=async()=>[{id:7,name:'managed',profileId:'P1',ownership:'agent',createdBy:'agent'}];openBoundTask=async()=>({task,binding});state=async()=>{throw Error('no candidate UI required');};saveRegistry=async()=>{throw Error('no state mutation permitted');};
   const outcomes=[await reclaimIdlePageSlot(reg,'P','a',task,binding),await reclaimOrphanManagedPage(reg,task,binding,'a'),
     await detachTerminalTaskPages(reg,'P','a'),await pruneManagedOrphanTabs(reg,'P','a')];
   return {outcomes,reads,queries,unchanged:JSON.stringify(reg)===before};
 `)();
 assert.deepEqual(result.outcomes,[null,null,[],[]]);assert.ok(result.reads.length);assert.equal(result.unchanged,true);
});

test("scoped prune reaches the shared candidate guards and preserves identity refusals",async()=>{
 const opt=source.slice(source.indexOf("function opt("),source.indexOf("\nfunction boolValue("));
 const start=source.indexOf('else if(cmd==="space"){'),end=source.indexOf('\nelse if(',start+1),branch=source.slice(start,end);
 const run=new AsyncFunction("args","reg","print","activeAccount","pruneManagedOrphanTabs","pruneProjectSpace","bindingFor","touchRuntime",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch);
 for(const all of [[],['--all']]) {
   const output=[],calls=[],args=['space','prune',...all,'--project','P','--account','a'];
   const guarded=async(_reg,p,a)=>{calls.push([p,a]);return all.length?[]:{ok:true,closed:[]};};
   await run(args,{},value=>output.push(value),()=> 'a',guarded,guarded,()=>({spaceName:'managed'}),async()=>{});
   assert.deepEqual(output,[{ok:true,closed:[]}]);assert.deepEqual(calls,[['P','a']]);
   const denied=async()=>{throw Error('PAGE_RECLAIM_ORIGIN_MISMATCH');};
   await assert.rejects(run(args,{},()=>{},()=> 'a',denied,denied,()=>({}),async()=>{}),/PAGE_RECLAIM_ORIGIN_MISMATCH/);
 }
});

test("project-wide prune retains healthy accounts when the active account is blocked",async()=>{
 const opt=source.slice(source.indexOf("function opt("),source.indexOf("\nfunction boolValue("));
 const start=source.indexOf('else if(cmd==="space"){'),end=source.indexOf('\nelse if(',start+1),branch=source.slice(start,end);
 const calls=[],output=[],forbidden=()=>{throw Error('account-wide refusal cannot select one active account');};
 await new AsyncFunction("args","reg","print","activeAccount","coordinated","pruneManagedOrphanTabs",opt+
   'const project=opt("project"),accountArg=opt("account"),cmd=args[0];if(false){}'+branch)(
     ['space','prune','--all','--project','P'],{},value=>output.push(value),forbidden,forbidden,
     async(_r,p,a)=>{calls.push([p,a]);return [{spaceId:8,page:'healthy'}];});
 assert.deepEqual(calls,[['P',null]]);assert.deepEqual(output,[{ok:true,closed:[{spaceId:8,page:'healthy'}]}]);
});

test("unfiltered maintenance skips blocked account while retaining another verified pool",async()=>{
 const spaces=[{id:7,name:'chat-bridge-agent-a',profileId:'P1',ownership:'agent',createdBy:'agent'},
   {id:8,name:'chat-bridge-agent-b',profileId:'P2',ownership:'agent',createdBy:'agent'}];
 const reg={accounts:{a:{identity:'one'},b:{identity:'two'}},projects:{},chats:{}};
 for(const [index,alias] of ['a','b'].entries()) reg.projects[alias]={bindings:{[alias]:{
   spaceId:index+7,spaceName:spaces[index].name,profileId:spaces[index].profileId,projectUrl:'https://chatgpt.com/g/g-p-'+alias.repeat(32)+'/project'}}};
 const visited=[];
 const prune=await new AsyncFunction('listTaskSpaces','openBoundTask','reclaimOrphanManagedPage','projectHomeId','coordinated',code+';return pruneManagedOrphanTabs;')(
   async()=>spaces,async(_r,project,account,options)=>{visited.push(account);return {binding:reg.projects[project].bindings[account],task:{spaceId:options.spaceOverride.spaceId}};},
   async(_r,_t,_b,a)=>a==='a'?null:{page:'done'},projectHomeId,(_command,payload)=>({unboundAny:payload.account==='a'}));
 assert.deepEqual(await prune(reg),[{spaceId:8,spaceName:'chat-bridge-agent-b',page:'done'}]);assert.deepEqual(visited,['a','b']);
});
