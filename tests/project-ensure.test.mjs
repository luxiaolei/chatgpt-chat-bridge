import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const source=await readFile(path.resolve("src/main.js"),"utf8");

function extract(name,nextName){
  const start=source.indexOf("async function "+name);
  const end=source.indexOf("\nasync function "+nextName,start);
  assert.ok(start>=0 && end>start,name);
  return source.slice(start,end);
}

test("Project Ensure is conservative until create+confirm and records real binding", async()=>{
  const code=extract("ensureProjectLocation","syncProject");
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const saved=[], touched=[];
  const projectRecord=(reg,name)=>reg.projects[name];
  const bindingObserved=()=>false;
  const page={label:"p1"};
  const task={spaceId:7,newPage:async()=>page};
  const accountManagedTask=async()=>({task,spaceName:"chat-bridge-agent-a",profileId:"Profile 1"});
  const pagesOf=async()=>[];
  const openProjectPage=async()=>{throw new Error("not found")};
  const saveRegistry=async reg=>saved.push(structuredClone(reg));
  const createProjectViaUI=async()=> "https://chatgpt.com/g/g-p-"+ "a".repeat(32)+"-p/project";
  const bindingFor=(reg,name,account)=>{
    reg.projects[name].bindings ||= {};
    return reg.projects[name].bindings[account] ||= {account};
  };
  const touchRuntime=async(...args)=>touched.push(args);
  const ensure=await new AsyncFunction(
    "projectRecord","bindingObserved","accountManagedTask","pagesOf","openProjectPage","saveRegistry",
    "createProjectViaUI","bindingFor","touchRuntime","projectIdFromUrl","bindingExecutionReadiness",
    code+"; return ensureProjectLocation;"
  )(projectRecord,bindingObserved,accountManagedTask,pagesOf,openProjectPage,saveRegistry,createProjectViaUI,bindingFor,touchRuntime,
    value=>String(value).match(/\/g\/(g-p-[^/]+)/)?.[1]||null,
    ()=>({ready:true,missing:[]}));

  let reg={accounts:{a:{}},projects:{P:{bindings:{}}}};
  assert.equal((await ensure(reg,"P","a",{})).status,"NEEDS_LOGIN");

  reg={accounts:{a:{identity:"one"}},projects:{P:{bindings:{}}}};
  assert.equal((await ensure(reg,"P","a",{})).status,"NEEDS_PROJECT_SETUP");
  assert.equal((await ensure(reg,"P","a",{create:true})).status,"NEEDS_APPROVAL");
  const ready=await ensure(reg,"P","a",{create:true,confirm:true});
  assert.equal(ready.status,"READY"); assert.equal(ready.created,true);
  assert.equal(reg.projects.P.bindings.a.spaceName,"chat-bridge-agent-a");
  assert.equal(reg.projects.P.bindings.a.profileId,"Profile 1");
  assert.match(reg.projects.P.bindings.a.projectId,/^g-p-[a-f0-9]{32}/);
  assert.equal(saved.length,1); assert.equal(touched.length,1);
});

test("managed Space is one per verified login/Profile and user ownership is a hard boundary", async()=>{
  const planStart=source.indexOf("function managedSpacePlan");
  const accountStart=source.indexOf("async function accountManagedTask");
  const accountEnd=source.indexOf("\nasync function createProjectViaUI",accountStart);
  const code=source.slice(planStart,accountEnd);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const slug=s=>String(s).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const crypto=await import("node:crypto");
  const task={spaceId:5};
  let available=[{id:5,name:"chat-bridge-agent-a",profileId:"P1",ownership:"agent"}];
  let calls=[];
  const taskAccounts=new Map();
  const accountScope=(reg,account)=>reg.accounts[account].identity;
  const fn=await new AsyncFunction("listTaskSpaces","taskSpace","slug","crypto","taskAccounts","accountScope",
    code+"; return accountManagedTask;"
  )(async()=>available,async(...args)=>{calls.push(args);return task;},slug,crypto,taskAccounts,accountScope);

  const reg={accounts:{a:{identity:"one",label:"A"}},spaces:{m:{identity:"one",accountName:"A",profileId:"P1"}}};
  const result=await fn(reg,"a");
  assert.equal(result.spaceName,"chat-bridge-agent-a"); assert.equal(result.profileId,"P1");
  assert.equal(calls[0][0],"chat-bridge-agent-a");
  assert.equal(taskAccounts.get(5),"a");

  available=[{id:5,name:"chat-bridge-agent-a",profileId:"P1",ownership:"user"}];
  await assert.rejects(()=>fn(reg,"a"),error=>error?.code==="SPACE_IN_USER_CONTROL");

  const multi={accounts:{a:{identity:"one",label:"A"}},spaces:{
    one:{identity:"one",accountName:"A",profileId:"P1"},
    two:{identity:"one",accountName:"A",profileId:"P2"}
  }};
  available=[];
  await assert.rejects(()=>fn(multi,"a"),/PROFILE_AMBIGUOUS_FOR_LOGIN/);
  const explicit=await fn(multi,"a","P2");
  assert.match(explicit.spaceName,/^chat-bridge-agent-a-[a-f0-9]{8}$/);
});

test("Project creation UI recognizes the current Add new project aria label", ()=>{
  assert.match(source,/add new project/i);
});

test("Project creation UI requires one create control and one confirmation", async()=>{
  const code=extract("createProjectViaUI","ensureProjectLocation");
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  let evalCount=0, focused=[], pressed=[], filled=[], clicks=[];
  const page={
    goto:async url=>assert.equal(url,"https://chatgpt.com/"),
    waitForTimeout:async()=>{},
    evaluate:async()=>{
      evalCount++;
      if(evalCount===1) return {count:1,actionable:true};
      if(evalCount===2) return true;
      return true;
    },
    waitForSelector:async(sel,opts)=>{
      assert.equal(opts.state,"visible");
      assert.ok(sel==='[role="dialog"]' || sel.includes('[role="dialog"] input'));
      return true;
    },
    fill:async(sel,value)=>{filled.push([sel,value]);},
    waitForFunction:async()=>true,
    focus:async sel=>focused.push(sel),
    keyboard:{press:async key=>pressed.push(key),insertText:async()=>{}},
    click:async sel=>clicks.push(sel),
    waitForURL:async re=>assert.ok(re.test("/g/g-p-"+ "a".repeat(32)+"/project")),
    url:async()=> "https://chatgpt.com/g/g-p-"+ "a".repeat(32)+"-demo/project"
  };
  const create=await new AsyncFunction("detectWebRateLimit","waitForProjectReady",
    code+"; return createProjectViaUI;"
  )(async()=>{},async()=>true);
  const url=await create(page,"Demo");
  assert.match(url,/g-p-/);
  assert.deepEqual(filled,[['[data-chat-bridge-project-name="1"]',"Demo"]]);
  assert.deepEqual(clicks,['[data-chat-bridge-create-project="1"]']);
  assert.equal(focused.length,1); assert.deepEqual(pressed,["Enter"]);
});

test("Project creation toggles Projects section when Add new project is covered", async()=>{
  const code=extract("createProjectViaUI","ensureProjectLocation");
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  let evalCount=0, clicks=[];
  const page={
    goto:async()=>{}, waitForTimeout:async()=>{},
    evaluate:async()=>{
      evalCount++;
      if(evalCount===1) return {count:1,actionable:false};
      if(evalCount===2) return true;
      if(evalCount===3) return {count:1,actionable:true};
      if(evalCount===4) return true;
      return true;
    },
    click:async sel=>clicks.push(sel),
    waitForSelector:async()=>true,
    fill:async()=>{},
    waitForFunction:async()=>true,
    focus:async()=>{},
    keyboard:{press:async()=>{},insertText:async()=>{}},
    waitForURL:async()=>{},
    url:async()=> "https://chatgpt.com/g/g-p-"+ "b".repeat(32)+"-demo/project"
  };
  const create=await new AsyncFunction("detectWebRateLimit","waitForProjectReady",
    code+"; return createProjectViaUI;"
  )(async()=>{},async()=>true);
  await create(page,"Demo");
  assert.deepEqual(clicks,['[data-chat-bridge-projects-toggle="1"]','[data-chat-bridge-create-project="1"]']);
});
