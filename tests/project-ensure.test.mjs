import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {isDeepStrictEqual} from "node:util";

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
    "projectRecord","bindingObserved","accountManagedTask","pagesOf","openProjectPage","saveRegistry","newManagedPage",
    "createProjectViaUI","bindingFor","touchRuntime","projectIdFromUrl","bindingExecutionReadiness",
    code+"; return ensureProjectLocation;"
  )(projectRecord,bindingObserved,accountManagedTask,pagesOf,openProjectPage,saveRegistry,async()=>page,createProjectViaUI,bindingFor,touchRuntime,
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

test("Project Ensure preserves existing conversation and draft tabs on both setup paths", async()=>{
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const projectUrl="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"-p/project";
  for (const bound of [false,true]) {
    const existing={label:"p2",url:"https://chatgpt.com/c/existing",draft:"unsent human text",generating:true};
    const before=structuredClone(existing),setup={label:"p3"},task={spaceId:7,newPage:async()=>setup};
    const reg={accounts:{a:{identity:"one"}},projects:{P:{bindings:bound?{a:{projectUrl}}:{}}}};
    const ensure=await new AsyncFunction("projectRecord","bindingObserved","accountManagedTask","pagesOf",
      "newManagedPage","openProjectPage","saveRegistry","createProjectViaUI","bindingFor","touchRuntime",
      "projectIdFromUrl","bindingExecutionReadiness","openBoundTask",extract("ensureProjectLocation","syncProject")+"; return ensureProjectLocation;"
    )((r,p)=>r.projects[p],()=>bound,async()=>({task,spaceName:"managed",profileId:"P1"}),async()=>[existing],
      async(_r,_p,_a,t)=>t.newPage(),async page=>{
        assert.equal(page,setup,"must not navigate a pre-existing conversation");return projectUrl;
      },async()=>{},async()=>{throw Error("existing project must be reused");},(r,p,a)=>r.projects[p].bindings[a]||= {account:a},
      async()=>{},()=>"g-p-"+"a".repeat(32),()=>({ready:true,missing:[]}),async()=>({task,binding:reg.projects.P.bindings.a}));
    const result=await ensure(reg,"P","a");
    assert.equal(result.status,bound?"PROJECT_NOT_ACCESSIBLE":"READY");
    if(bound)assert.equal(result.error,"PROJECT_HOME_UNAVAILABLE");
    assert.deepEqual(existing,before);
    assert.equal(reg.projects.P.bindings.a.controlPage,bound?undefined:"p3");
  }
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

test("sync ignores sidebar chats from other Projects and preserves existing attachments", async()=>{
  const code=extract("syncProject","stopGeneration");
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const a="g-p-"+"a".repeat(32), b="g-p-"+"b".repeat(32);
  const one="11111111-1111-1111-1111-111111111111", two="22222222-2222-2222-2222-222222222222";
  const otherAccount="33333333-3333-3333-3333-333333333333";
  const targetUrl=`https://chatgpt.com/g/${a}-target/project`;
  const reg={chats:{[one]:{project:"Target",spaceName:"original-space",spaceId:3,page:"p7"},
    [two]:{project:"Other",spaceName:"other-space",spaceId:4,page:"p9"},
    [otherAccount]:{project:"Target",account:"different-account"}}};
  const binding={projectUrl:targetUrl,spaceName:"bound-space",spaceId:5};
  const page={reload:async()=>{},waitForSelector:async()=>{},waitForTimeout:async()=>{},
    evaluate:async()=>[
      {title:"Target chat",url:`https://chatgpt.com/g/${a}-target/c/${one}`},
      {title:"Other chat",url:`https://chatgpt.com/g/${b}-other/c/${two}`},
      {title:"Shared chat",url:`https://chatgpt.com/g/${a}-target/c/${otherAccount}`}
    ]};
  let saved=0;
  const sync=await new AsyncFunction("openProjectPage","detectWebRateLimit","projectIdFromUrl","saveRegistry","touchRuntime",
    code+"; return syncProject;"
  )(async()=>targetUrl,async()=>{},value=>String(value).match(/\/g\/(g-p-[^/]+)/)?.[1]||null,
    async()=>{saved++;},async()=>{});
  const found=await sync(reg,page,"Target","account",binding);
  assert.deepEqual(found.map(x=>x.id),[one]);
  assert.equal(reg.chats[one].spaceName,"original-space");
  assert.equal(reg.chats[one].page,"p7");
  assert.deepEqual(reg.chats[two],{project:"Other",spaceName:"other-space",spaceId:4,page:"p9"});
  assert.deepEqual(reg.chats[otherAccount],{project:"Target",account:"different-account"});
  assert.equal(saved,1);
});

test("bound ensure reads its exact home without reclaim or allocation, including active and UNKNOWN",async()=>{
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project";
  for(const unsafe of [null,"active","UNKNOWN","draft","approval","generating","user","wrong-Project","missing-page","wrong-Space","login","readiness","late-url","late-draft","unknown-generation","attachment","late-user","late-page","late-profile","late-target","late-identity","late-binding","late-requirements"]) {
    const binding={account:"a",spaceName:"managed",spaceId:7,profileId:"P1",projectUrl:home,controlPage:"p1"};
    const preserved={draft:unsafe==="draft"?"keep human draft":"",attachment:unsafe==="attachment"};
    const before=structuredClone(preserved),calls={allocations:0,reclaim:0,navigations:0,closes:0,saved:0,input:0,waits:0};
    const reg={accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}}};
    let url=unsafe==="wrong-Project"?home.replace("a".repeat(32),"b".repeat(32)):home;
    const page={label:"p1",url:async()=>url,close:async()=>{calls.closes++;},goto:async()=>{calls.navigations++;},reload:async()=>{calls.navigations++;},fill:async()=>{throw Error("draft mutation forbidden");}};
    let ownership=unsafe==="user"?"user":"agent",missing=false,profile="P1",targetId="target-one";
    const task={spaceId:7,tabs:async()=>[{label:"p1",url,targetId,openedBy:ownership,active:unsafe==="active"}]};
    const ensure=await new AsyncFunction("projectRecord","bindingObserved","openBoundTask","pagesOf","assertInputSafe","waitForProjectReady","state","projectHomeId","projectKey","projectIdFromUrl","saveRegistry","bindingExecutionReadiness","newManagedPage","reclaimOrphanManagedPage","accountManagedTask","openProjectPage","isDeepStrictEqual",extract("ensureProjectLocation","syncProject")+";return ensureProjectLocation;")(
      (r,p)=>r.projects[p],()=>true,async(_r,_p,_a,options)=>{
        assert.equal(options.spaceOverride.spaceName,"managed");assert.equal(options.spaceOverride.profileId,"P1");assert.equal(options.requireExistingSpace,true);assert.equal(options.pauseOnUserControl,true);
        if(profile!=="P1")throw Error("SPACE_PROFILE_MISMATCH");
        if(unsafe==="wrong-Space")throw Error("SPACE_ID_MISMATCH");return {task,binding};
      },async()=>unsafe==="missing-page"||missing?[]:[page],async(p,identity,target,options)=>{
        calls.input++;assert.equal(p,page);assert.equal(identity,"login-a");assert.equal(target,home);assert.deepEqual(options,{reclaim:true});
        if(url!==home)throw Error("DELIVERY_TARGET_MISMATCH");
        if(unsafe==="login")throw Error("INPUT_LOGIN_MISMATCH");
        if(preserved.draft)throw Error("USER_DRAFT_PRESENT");
        if(preserved.attachment)throw Error("USER_DRAFT_PRESENT");
        if(["approval","generating"].includes(unsafe))throw Error(unsafe==="approval"?"APPROVAL_REQUIRED":"CHAT_BUSY");
        if(calls.input===2){
          if(unsafe==="late-user")ownership="user";
          if(unsafe==="late-page")missing=true;
          if(unsafe==="late-profile")profile="P2";
          if(unsafe==="late-target")targetId="replacement-target";
          if(unsafe==="late-identity")reg.accounts.a.identity="changed-login";
          if(unsafe==="late-binding")binding.spaceId=99;
          if(unsafe==="late-requirements")reg.projects.P.requiredTools=["new-tool"];
        }
      },async()=>{
        calls.waits++;if(unsafe==="readiness")throw Error("Project UI did not become ready");
        if(unsafe==="late-url")url=home.replace(/project$/,"c/11111111-1111-4111-8111-111111111111");
        if(unsafe==="late-draft")preserved.draft="new human draft";
      },async()=>({url,generating:unsafe==="unknown-generation"?undefined:false,approvalRequired:false}),
      value=>/\/project$/.test(value)?String(value).match(/g-p-[0-9a-f]{32}/)?.[0]:null,
      value=>String(value).match(/g-p-[0-9a-f]{32}/)?.[0],value=>String(value).match(/g-p-[0-9a-f]{32}/)?.[0],
      async(_reg,registration,readPaths)=>{assert.equal(registration,null);assert.deepEqual(readPaths,[["accounts","a"],["projects","P"]]);calls.saved++;},()=>({ready:true,missing:[]}),
      async()=>{calls.allocations++;throw Error("allocation forbidden");},async()=>{calls.reclaim++;throw Error("reclaim forbidden");},
      async()=>{throw Error("Space allocation forbidden");},async()=>{calls.navigations++;throw Error("navigation forbidden");},isDeepStrictEqual);
    const good=[null,"active","UNKNOWN"].includes(unsafe);
    const result=await ensure(reg,"P","a",{create:true,confirm:true});
    assert.equal(result.status,good?"READY":"PROJECT_NOT_ACCESSIBLE",unsafe);
    if(good){assert.equal((await ensure(reg,"P","a")).status,"READY");assert.equal(calls.saved,2);assert.equal(calls.input,4);assert.equal(calls.waits,2);}
    else {assert.equal(calls.saved,0);assert.match(result.error,/PROJECT_HOME_|SPACE_ID_MISMATCH|SPACE_PROFILE_MISMATCH|DELIVERY_TARGET_MISMATCH|INPUT_LOGIN_MISMATCH|USER_DRAFT_PRESENT|APPROVAL_REQUIRED|CHAT_BUSY|Project UI did not become ready/,unsafe);}
    assert.equal(calls.allocations,0,unsafe);assert.equal(calls.reclaim,0,unsafe);assert.equal(calls.navigations,0,unsafe);assert.equal(calls.closes,0,unsafe);
    assert.deepEqual(preserved,unsafe==="late-draft"?{...before,draft:"new human draft"}:before,unsafe);
    assert.equal(binding.controlPage,"p1");
  }
});
