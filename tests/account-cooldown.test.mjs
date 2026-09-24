import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, mkdir, writeFile, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";

const root=path.resolve(import.meta.dirname,"..");
const scope=id=>createHash("sha256").update(`identity:${id}`).digest("hex");

test("identify binds only the stable login ID, rejects changed login and records HTTP 429",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-identify-"));
  const keys=["__CHAT_BRIDGE_CONFIG_DIR__","__CHAT_BRIDGE_STATE_DIR__","__CHAT_BRIDGE_ARGS__","document","location","fetch"];
  const previous=keys.map(k=>globalThis[k]);
  try {
    const binding={account:"a",spaceName:"existing",spaceId:7};
    await writeFile(path.join(dir,"registry.json"),JSON.stringify({defaultAccount:"a",defaultProject:"A",accounts:{a:{}},projects:{A:{activeAccount:"a",bindings:{a:binding}}},chats:{}}));
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=dir;globalThis.__CHAT_BRIDGE_STATE_DIR__=dir;
    globalThis.__CHAT_BRIDGE_ARGS__=["account","identify","--project","A"];
    globalThis.document={querySelectorAll:()=>[],body:null};globalThis.location={origin:"https://chatgpt.com"};
    let login="user-one",status=200;
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,"/api/auth/session");assert.equal(options.credentials,"same-origin");
      return {status,ok:status===200,json:async()=>({user:{id:login},accessToken:"must-not-persist"})};
    };
    const page={spaceId:7,url:async()=>"https://chatgpt.com/c/test",evaluate:async fn=>fn()};
    const source=await readFile(path.join(root,"src/main.js"),"utf8");
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const output=[];
    const run=()=>new AsyncFunction("taskSpace","console",source)(async name=>{assert.equal(name,"existing");return {spaceId:7,pages:async()=>[page]};},{log:row=>output.push(row)});
    await run();
    const saved=await readFile(path.join(dir,"registry.json"),"utf8");
    assert.equal(JSON.parse(saved).accounts.a.identity,"user-one");
    assert.equal(saved.includes("must-not-persist"),false);
    assert.equal(output.join("").includes("must-not-persist"),false);
    assert.equal(JSON.parse(output[0]).scope,scope("user-one"));
    login="user-two";
    await assert.rejects(run(),/ACCOUNT_IDENTITY_MISMATCH/);
    assert.equal(JSON.parse(await readFile(path.join(dir,"registry.json"),"utf8")).accounts.a.identity,"user-one");
    status=429;
    await assert.rejects(run(),{code:"WEB_RATE_LIMITED"});
    assert.equal(JSON.parse(await readFile(path.join(dir,"web-cooldowns",scope("user-one")+".json"),"utf8")).seconds,180);
  } finally {
    keys.forEach((k,i)=>{globalThis[k]=previous[i];});
    await rm(dir,{recursive:true,force:true});
  }
});

test("account cooldown follows identity across projects and aliases; other logins stay available", async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-accounts-"));
  const config=path.join(dir,"config"), state=path.join(dir,"state");
  try {
    await mkdir(config); await mkdir(path.join(state,"web-cooldowns"),{recursive:true});
    const reg={defaultAccount:"a",defaultProject:"A",accounts:{a:{identity:"user-one"},alias:{identity:"user-one"},b:{identity:"user-two"}},
      projects:{A:{activeAccount:"a"},B:{activeAccount:"b"},C:{activeAccount:"alias"}},
      chats:{second:{id:"second",project:"B",account:"b",role:"worker",status:"active"}}};
    await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
    await writeFile(path.join(state,"web-cooldowns",scope("user-one")+".json"),JSON.stringify({until:new Date(Date.now()+180000).toISOString(),strikes:1}));
    const run=(action,args)=>spawnSync("python3",[path.join(root,"src/web-preflight.py"),action,config,state,...args],{encoding:"utf8"});
    const status=args=>{const result=run("status",args);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
    assert.equal(status(["cooldown","status","--project","A"]).active,true);
    assert.equal(status(["cooldown","status","--project","C"]).scope,scope("user-one"));
    assert.equal(status(["cooldown","status","--project","B"]).active,false);
    assert.equal(status(["status","second","--project","B"]).account,"b");
    reg.chats.collision={id:"collision",project:"B",account:"a",role:"second",status:"active"};
    reg.projects.B.activeAccount="a";
    await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
    assert.equal(status(["status","second","--project","B"]).account,"b");
    reg.projects.B.activeAccount="b";
    await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
    const tasks={one:{status:"RUNNING",project:"A",account:"a",role:"worker"}};
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
    assert.equal(run("watch",["watch"]).stdout.trim(),"0");
    tasks.two={status:"RUNNING",project:"B",account:"b",sessionId:"second"};
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
    assert.equal(run("watch",["watch"]).stdout.trim(),"1");
    assert.equal(run("watch",["watch","--project","A"]).stdout.trim(),"0");
    assert.equal(run("watch",["watch","--account","b"]).stdout.trim(),"1");
    tasks.two.status="BLOCKED";
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
    assert.equal(run("watch",["watch","--account","b"]).stdout.trim(),"0");
    tasks.two.watchdogPendingNotification="notify controller only";
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
    assert.equal(run("watch",["watch","--account","b"]).stdout.trim(),"1");
    tasks.two.status="RUNNING";delete tasks.two.watchdogPendingNotification;
    assert.equal(run("clear",["cooldown","clear","--account","b","--confirm"]).status,0);
    assert.equal(status(["cooldown","status","--account","a"]).active,true);
    assert.equal(run("clear",["cooldown","clear","--account","alias","--confirm"]).status,0);
    assert.equal(status(["cooldown","status","--account","a"]).active,false);
    // A pre-upgrade default-account cooldown must survive, without blocking B.
    await writeFile(path.join(state,"web-cooldown.json"),JSON.stringify({until:new Date(Date.now()+180000).toISOString()}));
    assert.equal(status(["cooldown","status","--account","alias"]).active,true);
    assert.equal(status(["cooldown","status","--account","b"]).active,false);
    // Wrapper proves both the all-cooled skip and the mixed-account admission.
    const fake=path.join(dir,"ego");
    await writeFile(fake,"#!/bin/sh\ncat >/dev/null\nexit 42\n",{mode:0o755});
    const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake};
    const cli=(...args)=>spawnSync(path.join(root,"bin/chat-bridge"),args,{env,encoding:"utf8"});
    assert.equal(cli("watch","--quiet","--account","a").status,0);
    assert.equal(cli("projects","--account","a").status,75);
    assert.equal(cli("watch","--quiet").status,42);
    assert.equal(cli("watch","--loop","--iterations","1","--account","a").status,0);
    // The persistent wrapper stays local when idle, then notices newly added work.
    await writeFile(fake,"#!/bin/sh\ncat >/dev/null\necho browser-entered\n",{mode:0o755});
    await rm(path.join(state,"ui-pacing.last"),{force:true});
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks:{one:tasks.one}}));
    const loop=spawnSync("python3",["-c",`
import json, pathlib, runpy, sys
m=runpy.run_path(sys.argv[1])
m['time'].sleep=lambda _: pathlib.Path(sys.argv[3], 'runtime.json').write_text(sys.argv[5])
m['run']('loop', pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), [sys.argv[4], 'watch', '--loop', '--iterations', '2', '--account', 'b'])
`,path.join(root,"src/web-preflight.py"),config,state,path.join(root,"bin/chat-bridge"),JSON.stringify({tasks})],{env,encoding:"utf8",timeout:5000});
    assert.equal(loop.status,0,loop.stderr);
    assert.equal(loop.stdout.trim(),"browser-entered");
    await writeFile(path.join(state,"web-cooldowns",scope("user-two")+".json"),"broken json");
    assert.equal(run("watch",["watch","--account","b"]).status,2);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("runtime stops a cooling identity before browser access and continues another account",async()=>{
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${file}.js`);
  const dir=await mkdtemp(path.join(tmpdir(),"bridge-watch-"));
  const config=path.join(dir,"config"),state=path.join(dir,"state");
  await mkdir(config); await mkdir(state);
  const reg={version:2,defaultProject:"A",defaultAccount:"a",accounts:{a:{identity:"same"},alias:{identity:"same"},b:{identity:"different"}},
    projects:{A:{activeAccount:"a",bindings:{}},B:{activeAccount:"b",bindings:{}}},
    chats:{a:{id:"a",project:"A",account:"a",status:"active",role:"one"},alias:{id:"alias",project:"A",account:"alias",status:"active",role:"two"},b:{id:"b",project:"B",account:"b",status:"active",role:"three"}}};
  const tasks=Object.fromEntries(Object.values(reg.chats).map(c=>[c.id,{taskId:c.id,sessionId:c.id,project:c.project,account:c.account,status:"RUNNING"}]));
  await writeFile(path.join(config,"registry.json"),JSON.stringify(reg));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
  const oldConfig=globalThis.__CHAT_BRIDGE_CONFIG_DIR__,oldState=globalThis.__CHAT_BRIDGE_STATE_DIR__;
  globalThis.__CHAT_BRIDGE_CONFIG_DIR__=config;globalThis.__CHAT_BRIDGE_STATE_DIR__=state;
  try {
    const source=(await readFile(path.join(root,"src/main.js"),"utf8")).split('const cmd=args[0] || "help";')[0];
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const api=await new AsyncFunction("setTimeout","taskSpace",source+`
      const reg=await loadRegistry();
      return {reg,watchOnce,detectWebRateLimit,accountScope,setModel,setEffort,applyModelSpec,deferrableModelUiError,accountPage,
        bind:(id,a)=>taskAccounts.set(id,a),
        sender:(fn)=>{sendMessage=fn;},
        modelUI:(menu,snapshot)=>{openModelMenu=menu;state=snapshot;},
        override:(ensure,observe)=>{ensurePage=ensure;observeSession=observe;}};
    `)(callback=>callback(),async name=>({spaceId:name==="empty"?10:11,pages:async()=>name==="empty"?[]:[{label:"ready",url:async()=>"https://chatgpt.com/"}]}));
    assert.equal(api.accountScope(reg,"a"),scope("same"));
    assert.equal(api.deferrableModelUiError(new Error("Model/effort button disappeared before menu open")),true);
    assert.equal(api.deferrableModelUiError(new Error("Selector option matched 1 elements, but none can receive input; element is hidden or inert")),true);
    assert.equal(api.deferrableModelUiError(new Error("Requested model is unavailable")),false);
    api.bind(1,"a");
    const visited=[];
    api.override(async(_reg,chat)=>{
      visited.push(chat.id);
      if(chat.id==="a") await api.detectWebRateLimit({spaceId:1,evaluate:async()=>({candidates:["Too many requests"],dismissed:0})});
      return {page:{}};
    },async()=>({sessionState:"RUNNING_QUIET",recommendation:"WAIT",mode:"5.6 Pro"}));
    const results=await api.watchOnce(reg,null,null,{autoRecover:false});
    assert.deepEqual(visited,["a","b"]);
    assert.deepEqual(results.map(r=>r.state),["WEB_COOLDOWN","WEB_COOLDOWN","RUNNING_QUIET"]);
    const saved=JSON.parse(await readFile(path.join(state,"web-cooldowns",scope("same")+".json"),"utf8"));
    assert.equal(saved.strikes,1);
    const runtime=JSON.parse(await readFile(path.join(state,"runtime.json"),"utf8"));
    assert.equal(runtime.tasks.a.watchErrorCount,undefined);
    assert.equal(runtime.tasks.alias.status,"RUNNING");
    await rm(path.join(state,"web-cooldowns",scope("same")+".json"));
    tasks.a.watchErrorCount=2;
    tasks.a.controller="controller";
    reg.chats.controller={id:"controller",project:"A",account:"a",status:"active",role:"controller"};
    await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks}));
    visited.length=0;
    api.override(async(_reg,chat)=>{
      visited.push(chat.id);
      if(chat.id==="a")throw new Error("broken page");
      if(chat.id==="controller")throw Object.assign(new Error("controller cooling"),{code:"WEB_RATE_LIMITED",account:"a"});
      return {page:{}};
    },async()=>({sessionState:"RUNNING_QUIET"}));
    const callbackScan=await api.watchOnce(reg);
    assert.deepEqual(visited,["a","controller","alias","b"]);
    assert.equal(callbackScan[0].notification.reason,"WEB_COOLDOWN");
    assert.equal(JSON.parse(await readFile(path.join(state,"runtime.json"),"utf8")).tasks.a.status,"BLOCKED");
    visited.length=0;
    const delivered=[];
    api.sender(async(_page,message)=>delivered.push(message));
    api.override(async(_reg,chat)=>{visited.push(chat.id);return {page:{}};},async()=>({sessionState:"RUNNING_QUIET"}));
    await api.watchOnce(reg);
    assert.deepEqual(visited,["controller","alias","b"]);
    assert.equal(delivered.length,1);
    const afterDelivery=JSON.parse(await readFile(path.join(state,"runtime.json"),"utf8")).tasks.a;
    assert.equal(afterDelivery.status,"BLOCKED");
    assert.equal(afterDelivery.watchdogPendingNotification,undefined);
    assert.ok(afterDelivery.watchdogNotifiedAt);
    reg.projects.A.bindings.a={account:"a",spaceName:"empty",spaceId:10};
    reg.projects.B.bindings.a={account:"a",spaceName:"ready",spaceId:11};
    assert.equal((await api.accountPage(reg,"a")).label,"ready");
    await assert.rejects(api.accountPage(reg,"a","A"),/Open a managed ChatGPT page/);
    // Exercise the actual effort control against sliders with different maxima.
    let displayed="5.6 Pro";
    api.modelUI(async()=>{},async()=>({mode:displayed}));
    const oldDocument=globalThis.document;
    try {
      for(const max of [4,5]) {
        let value=0; const keys=[];
        globalThis.document={querySelector:()=>({getAttribute:name=>({"aria-valuemin":"0","aria-valuemax":String(max),"aria-valuenow":String(value)})[name]})};
        const page={evaluate:async fn=>fn(),focus:async()=>{},keyboard:{press:async key=>{keys.push(key);if(key==="End")value=max;}}};
        await api.setEffort(page,"Pro");
        assert.equal(value,max);assert.ok(keys.includes("End"));
        displayed="5.6 Extra High";
        await assert.rejects(api.setEffort(page,"Pro"),/not confirmed by the UI/);
        displayed="5.6 Pro";
      }
    } finally {globalThis.document=oldDocument;}
  } finally {
    globalThis.__CHAT_BRIDGE_CONFIG_DIR__=oldConfig;globalThis.__CHAT_BRIDGE_STATE_DIR__=oldState;
    await rm(dir,{recursive:true,force:true});
  }
});
