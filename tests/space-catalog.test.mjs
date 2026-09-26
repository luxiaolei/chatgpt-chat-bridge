import test from "node:test";
import assert from "node:assert/strict";
import {recordSpace, recordProjectName, spaceMap, missingProjectUrls, selectManagedSpace, agentSpaceGcCandidates} from "../src/space-catalog.js";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
globalThis.__CHAT_BRIDGE_STORE_PATH__=path.resolve("src/state-store.py");
globalThis.__CHAT_BRIDGE_COORDINATOR_PATH__=path.resolve("src/coordinator.py");
import {spawnSync} from "node:child_process";

const qc="g-p-6aa272fd978c819185de9d1e8778ba2f-quant-company";
const hz="g-p-6aa6c99725688191b10b478d015f96f9-hz-os";
const project=id=>`https://chatgpt.com/g/${id}/project`;
const chat=id=>`https://chatgpt.com/g/${id}/c/6ab29d07-99b0-83ee-b6d7-51067561abe8`;
const base=id=>id.match(/^g-p-[0-9a-f]{32}/)[0];

test("catalog preserves many projects per account and one project across accounts and Spaces",()=>{
  const reg={accounts:{"qc-alpha":{identity:"alpha",label:"alpha lu"}},projects:{
    "Quant Company":{bindings:{"qc-alpha":{projectId:qc,spaceName:"QC - Agent"}}},
    "HZ OS":{bindings:{default:{projectId:hz,spaceName:"HZ OS"}}},
  },spaces:{}};
  recordSpace(reg,{name:"QC, Social - Manual",spaceId:18,identity:"alpha",accountName:"alpha lu",urls:[chat(qc),chat(hz)]});
  recordSpace(reg,{name:"Commerce, Reality, HZ Manual",spaceId:27,identity:"ru",accountName:"Ru Wang",urls:[chat(hz)]});
  const map=spaceMap(reg);
  assert.equal(reg.spaces["QC, Social - Manual"].account,"qc-alpha");
  assert.deepEqual(map.spaces.find(s=>s.name==="QC, Social - Manual").projects.map(p=>p.id),[base(qc),base(hz)]);
  assert.equal(map.projects.find(p=>p.id===base(hz)).spaces.length,2);
  assert.equal(map.projects.find(p=>p.id===base(hz)).accounts.length,2);
  assert.deepEqual(map.configuredBindings.filter(b=>b.project==="HZ OS").map(b=>b.space),["HZ OS"]);
  assert.equal(reg.projects["HZ OS"].bindings.default.spaceName,"HZ OS");
});

test("scan refuses changed login and restore opens only missing project tabs",()=>{
  const reg={accounts:{},projects:{},spaces:{}};
  recordSpace(reg,{name:"Manual",spaceId:1,identity:"alpha",accountName:"alpha lu",urls:[chat(qc),chat(hz)]});
  assert.throws(()=>recordSpace(reg,{name:"Manual",spaceId:1,identity:"other",accountName:"Other",urls:[]}),/SPACE_ACCOUNT_CHANGED/);
  assert.equal(reg.spaces.Manual.identity,"alpha");
  assert.deepEqual(missingProjectUrls(reg.spaces.Manual,[chat(qc)]),[project(hz)]);
});

test('user-owned Space is never taken over for automated work',()=>{
  for(const ownership of ['user','agentDelegatedToUser']) {
    const live=[{name:'QC2- Agent',ownership,profileId:'Profile 1'}];
    assert.deepEqual(selectManagedSpace({spaceName:'QC2- Agent'},'hzcodex',live),
      {spaceName:'chat-bridge-agent-hzcodex',profileId:'Profile 1',changed:true,existing:false});
    assert.throws(()=>selectManagedSpace({spaceName:'QC2- Agent'},'hzcodex',live,{pauseOnUserControl:true}),
      error=>error?.code==='SPACE_IN_USER_CONTROL'&&error?.spaceName==='QC2- Agent'&&error?.ownership===ownership);
    assert.throws(()=>selectManagedSpace({spaceName:'QC2- Agent'},'hzcodex',[
      ...live,{name:'chat-bridge-agent-hzcodex',ownership,profileId:'Profile 1'}
    ]),/SPACE_IN_USER_CONTROL/);
  }
  assert.throws(()=>selectManagedSpace({spaceName:'Unknown'},'hzcodex',[]),/PROFILE_REQUIRED/);
  assert.deepEqual(selectManagedSpace({spaceName:'QC - Agent'},'alpha',[
    {name:'QC - Agent',ownership:'agent',profileId:'Profile 2'}
  ]),{spaceName:'QC - Agent',profileId:'Profile 2',changed:false,existing:true});
});

test('agent Space GC only returns unbound idle chat-bridge agent Spaces',()=>{
  const reg={
    defaultAccount:'a',
    projects:{A:{activeAccount:'a',bindings:{a:{spaceName:'chat-bridge-agent-bound'}}}},
    chats:{
      live:{id:'live',project:'B',account:'a',spaceName:'chat-bridge-agent-live'},
      done:{id:'done',project:'C',account:'a',spaceName:'chat-bridge-agent-done'},
    },
  };
  const runtime={tasks:{
    live:{taskId:'live',sessionId:'live',project:'B',account:'a',status:'RUNNING'},
    done:{taskId:'done',sessionId:'done',project:'C',account:'a',status:'COMPLETE'},
  }};
  const available=[
    {id:1,name:'chat-bridge-agent-bound',ownership:'agent'},
    {id:2,name:'chat-bridge-agent-live',ownership:'agent'},
    {id:3,name:'chat-bridge-agent-done',ownership:'agent'},
    {id:4,name:'chat-bridge-agent-idle',ownership:'agent'},
    {id:5,name:'chat-bridge-agent-user',ownership:'user'},
    {id:6,name:'Manual',ownership:'agent'},
  ];
  assert.deepEqual(agentSpaceGcCandidates(reg,runtime,available).map(s=>s.id),[3,4]);
});

test("slugged binding and slugless chat URL resolve to one Project",()=>{
  const reg={accounts:{},spaces:{},projects:{"Quant Company":{bindings:{a:{projectId:qc}}}}};
  const bare=qc.slice(0,qc.indexOf("-quant-company"));
  recordSpace(reg,{name:"Manual",spaceId:1,identity:"alpha",accountName:"alpha lu",urls:[chat(bare)]});
  assert.equal(spaceMap(reg).spaces[0].projects[0].name,"Quant Company");
  assert.deepEqual(missingProjectUrls(reg.spaces.Manual,[chat(qc)]),[]);
});

test('UI dispatch rejects a bound Project absent from that login catalog',async()=>{
  for(const file of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])
    await import(`../src/${file}.js`);
  const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0];
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const {bindingObserved}=await new AsyncFunction(source+'return {bindingObserved};')();
  const reg={accounts:{hz:{identity:'hzcodex'}},spaces:{manual:{identity:'hzcodex',projects:[{id:base(qc)}]}}};
  assert.equal(bindingObserved(reg,'hz',{projectId:hz}),false);
  assert.equal(bindingObserved(reg,'hz',{projectId:qc}),true);
});

test("scan never claims an existing unverified routing alias just because names match",()=>{
  const reg={accounts:{"alpha-lu":{name:"alpha-lu",label:"not verified"}},projects:{},spaces:{}};
  const item=recordSpace(reg,{name:"Manual",spaceId:1,identity:"alpha",accountName:"alpha lu",urls:[]});
  assert.notEqual(item.account,"alpha-lu");
  assert.equal(reg.accounts["alpha-lu"].identity,undefined);
});

test("verified project names remain distinct from account-specific Project IDs",()=>{
  const reg={accounts:{},projects:{"Quant Company":{bindings:{alpha:{projectId:qc}}}},spaces:{}};
  const other="g-p-6aaca2e3dc4081918776b2d90eae06a1";
  recordSpace(reg,{name:"HZCodex",spaceId:0,identity:"hz",accountName:"hzcodex",urls:[chat(other)]});
  assert.throws(()=>recordProjectName(reg,"HZCodex","g-p-00000000000000000000000000000000","Wrong"),/PROJECT_NOT_OBSERVED/);
  recordProjectName(reg,"HZCodex",other,"Quant Company");
  recordSpace(reg,{name:"HZCodex",spaceId:0,identity:"hz",accountName:"hzcodex",urls:[chat(other)]});
  const map=spaceMap(reg);
  assert.equal(map.spaces[0].projects[0].name,"Quant Company");
  assert.equal(map.spaces[0].projects[0].id,other);
  assert.equal(reg.projects["Quant Company"].bindings.alpha.projectId,qc);
});

test("space scan persists actual login and projects without changing routing bindings",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"])
    await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-spaces-"));
  const keys=["__CHAT_BRIDGE_CONFIG_DIR__","__CHAT_BRIDGE_STATE_DIR__","__CHAT_BRIDGE_ARGS__","__CHAT_BRIDGE_SPACE_CATALOG__"];
  const previous=keys.map(k=>globalThis[k]);
  try {
    const reg={version:2,defaultAccount:"default",accounts:{default:{identity:"different"}},projects:{
      "Quant Company":{activeAccount:"default",bindings:{default:{spaceName:"QC - Agent",projectId:qc}}}
    },chats:{}};
    await (await import("node:fs/promises")).writeFile(path.join(dir,"registry.json"),JSON.stringify(reg));
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=dir;globalThis.__CHAT_BRIDGE_STATE_DIR__=dir;
    globalThis.__CHAT_BRIDGE_ARGS__=["space","scan","--space","Manual"];
    globalThis.__CHAT_BRIDGE_SPACE_CATALOG__={recordSpace,spaceMap,missingProjectUrls};
    let finished=0;
    const page={label:"p1",evaluate:async()=>({id:"alpha",name:"alpha lu"})};
    const busy={label:"p2",evaluate:async()=>{throw Error("busy conversation")}};
    const task={spaceId:18,tabs:async()=>[{url:chat(qc),title:"QC",label:"p2",page:busy,active:true},
      {url:"https://chatgpt.com/",title:"ChatGPT",label:"p1",page}],page:label=>label==="p1"?page:busy,
      finish:async()=>{finished++;}};
    const source=await readFile(path.resolve(import.meta.dirname,"../src/main.js"),"utf8");
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    await new AsyncFunction("listTaskSpaces","claimTaskSpace","taskSpace","console",source)(
      async()=>[{id:18,name:"Manual",ownership:"user"}],async()=>task,async()=>{throw Error("must claim user Space")},{log:()=>{}}
    );
    const saved=JSON.parse(await readFile(path.join(dir,"registry.json"),"utf8"));
    assert.equal(saved.spaces.Manual.accountName,"alpha lu");
    assert.deepEqual(saved.spaces.Manual.projects.map(p=>p.id),[base(qc)]);
    assert.equal(saved.projects["Quant Company"].bindings.default.spaceName,"QC - Agent");
    assert.equal(finished,1);
  } finally {
    keys.forEach((k,i)=>{globalThis[k]=previous[i]});
    await rm(dir,{recursive:true,force:true});
  }
});

test("restore closes a probe tab when the saved Space has a different login",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"])
    await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-restore-"));
  const keys=["__CHAT_BRIDGE_CONFIG_DIR__","__CHAT_BRIDGE_STATE_DIR__","__CHAT_BRIDGE_ARGS__","__CHAT_BRIDGE_SPACE_CATALOG__"];
  const previous=keys.map(k=>globalThis[k]);
  try {
    const reg={version:2,defaultAccount:"default",accounts:{default:{}},projects:{},chats:{},spaces:{
      Manual:{name:"Manual",identity:"alpha",account:"alpha",projects:[{id:qc,url:project(qc)}]}
    }};
    await (await import("node:fs/promises")).writeFile(path.join(dir,"registry.json"),JSON.stringify(reg));
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=dir;globalThis.__CHAT_BRIDGE_STATE_DIR__=dir;
    globalThis.__CHAT_BRIDGE_ARGS__=["space","restore","--space","Manual"];
    globalThis.__CHAT_BRIDGE_SPACE_CATALOG__={recordSpace,spaceMap,missingProjectUrls};
    let closed=0;
    const page={goto:async()=>{},evaluate:async()=>({id:"other",name:"Other"}),close:async()=>{closed++}};
    const task={spaceId:1,tabs:async()=>[],newPage:async()=>page};
    const source=await readFile(path.resolve(import.meta.dirname,"../src/main.js"),"utf8");
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    await assert.rejects(new AsyncFunction("listTaskSpaces","claimTaskSpace","taskSpace","console",source)(
      async()=>[{id:1,name:"Manual",ownership:"agent"}],async()=>{throw Error("unexpected claim")},async()=>task,{log:()=>{}}
    ),/SPACE_ACCOUNT_CHANGED/);
    assert.equal(closed,1);
  } finally {
    keys.forEach((k,i)=>{globalThis[k]=previous[i]});
    await rm(dir,{recursive:true,force:true});
  }
});

test("explicit restore launches Ego Lite before browser control on macOS",async()=>{
  if(process.platform!=="darwin") return;
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-launch-"));
  try {
    const bin=path.join(dir,"bin"),app=path.join(dir,"ego lite.app"),marker=path.join(dir,"opened");
    await mkdir(bin);await mkdir(app);
    await writeFile(path.join(bin,"open"),`#!/bin/sh\nprintf launched > "${marker}"\n`,{mode:0o755});
    const fakeEgo=path.join(bin,"ego-browser");
    await writeFile(fakeEgo,"#!/bin/sh\ncat >/dev/null\n",{mode:0o755});
    const config=path.join(dir,"config"),state=path.join(dir,"state");
    await mkdir(config);await mkdir(state);
    await writeFile(path.join(config,"registry.json"),JSON.stringify({version:2,defaultAccount:"default",accounts:{default:{}},projects:{},chats:{},spaces:{}}));
    const result=spawnSync(path.resolve(import.meta.dirname,"../bin/chat-bridge"),["space","restore"],{
      encoding:"utf8",env:{...process.env,PATH:`${bin}:${process.env.PATH}`,EGO_BROWSER_BIN:fakeEgo,
        EGO_LITE_APP:app,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state}
    });
    assert.equal(result.status,0,result.stderr);
    assert.equal(await readFile(marker,"utf8"),"launched");
  } finally {await rm(dir,{recursive:true,force:true})}
});

test("space scan rejects duplicate Space names instead of choosing an arbitrary login",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"])
    await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-duplicate-"));
  const keys=["__CHAT_BRIDGE_CONFIG_DIR__","__CHAT_BRIDGE_STATE_DIR__","__CHAT_BRIDGE_ARGS__","__CHAT_BRIDGE_SPACE_CATALOG__"];
  const previous=keys.map(k=>globalThis[k]);
  try {
    await writeFile(path.join(dir,"registry.json"),JSON.stringify({version:2,accounts:{},projects:{},chats:{},spaces:{}}));
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=dir;globalThis.__CHAT_BRIDGE_STATE_DIR__=dir;
    globalThis.__CHAT_BRIDGE_ARGS__=["space","scan","--space","Same"];
    globalThis.__CHAT_BRIDGE_SPACE_CATALOG__={recordSpace,spaceMap,missingProjectUrls};
    const source=await readFile(path.resolve(import.meta.dirname,"../src/main.js"),"utf8");
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    await assert.rejects(new AsyncFunction("listTaskSpaces","claimTaskSpace","taskSpace","console",source)(
      async()=>[{id:1,name:"Same",ownership:"user"},{id:2,name:"Same",ownership:"user"}],
      async()=>{throw Error("must not claim")},async()=>{throw Error("must not open")},{log:()=>{}}
    ),/AMBIGUOUS_SPACE/);
  } finally {keys.forEach((k,i)=>{globalThis[k]=previous[i]});await rm(dir,{recursive:true,force:true})}
});

test("space label persists a verified name for an observed Project only",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"])
    await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-label-"));
  const keys=["__CHAT_BRIDGE_CONFIG_DIR__","__CHAT_BRIDGE_STATE_DIR__","__CHAT_BRIDGE_ARGS__","__CHAT_BRIDGE_SPACE_CATALOG__"];
  const previous=keys.map(k=>globalThis[k]);
  try {
    const id="g-p-6aaca2e3dc4081918776b2d90eae06a1";
    await writeFile(path.join(dir,"registry.json"),JSON.stringify({version:2,accounts:{},projects:{},chats:{},spaces:{
      Manual:{name:"Manual",projects:[{id,url:project(id)}]}
    }}));
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=dir;globalThis.__CHAT_BRIDGE_STATE_DIR__=dir;
    globalThis.__CHAT_BRIDGE_ARGS__=["space","label","--space","Manual","--project-id",id,"--name","Quant Company"];
    globalThis.__CHAT_BRIDGE_SPACE_CATALOG__={recordSpace,recordProjectName,spaceMap,missingProjectUrls};
    const source=await readFile(path.resolve(import.meta.dirname,"../src/main.js"),"utf8");
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    await new AsyncFunction("console",source)({log:()=>{}});
    const saved=JSON.parse(await readFile(path.join(dir,"registry.json"),"utf8"));
    assert.equal(saved.spaces.Manual.projects[0].name,"Quant Company");
  } finally {keys.forEach((k,i)=>{globalThis[k]=previous[i]});await rm(dir,{recursive:true,force:true})}
});
