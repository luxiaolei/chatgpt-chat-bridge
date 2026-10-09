import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
for(const name of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) await import(`../src/${name}.js`);
const source=(await readFile(new URL("../src/main.js",import.meta.url),"utf8")).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project",name="chat-bridge-agent-a";
async function fixture(change=()=>{}) {
  const binding={spaceName:name,spaceId:7,profileId:"P1",projectUrl:home};
  const f={binding,reg:{chats:{},accounts:{a:{identity:"login-a"}},projects:{P:{bindings:{a:binding}}}},runtime:{tasks:{}},closed:[],queries:0,
    tabs:[{label:"p1",url:"chrome://newtab/",active:false,openedBy:"agent"},{label:"p2",url:home,active:false,openedBy:"agent"}],
    context:{sessionRefs:[],unboundProjectIds:[],unboundAny:false},snapshot:{approvalRequired:false,generating:false,composerCount:1,composerAttachmentsEmpty:true,composerRawText:""}};
  change(f);
  const run=await new AsyncFunction("f","name",source+`
    releasePhysicalPage=async(_r,t,page)=>{await page.close();if((await t.tabs()).some(tab=>tab.label===page.label))throw Error('PAGE_CLOSE_UNCONFIRMED');};
    loadRuntime=async()=>f.runtime;
    listTaskSpaces=async()=>f.spaces||[{id:7,name,profileId:'P1',ownership:'agent',createdBy:'agent'}];
    imageSessionOccupancy=()=>({occupied:false});
    state=async page=>{(f.observedPages||=[]).push(page.label);return {...f.snapshot,...f.snapshots?.[page.label],url:await page.url()};};
    assertInputSafe=async(page,identity,url,options)=>{f.guardCalls=(f.guardCalls||0)+1;if(f.guardError)throw f.guardError;f.beforeCloseGuard?.(page);return identity;};
    coordinated=command=>{if(command!=='page-reclaim-context')throw Error(command);f.queries++;return f.context;};
    const pages=f.tabs.map(tab=>tab.page={label:tab.label,targetId:tab.targetId||='native-'+tab.label,spaceId:f.expectedSpaceId||7,evaluate:async()=>{},url:async()=>tab.url,close:async()=>{f.closed.push(tab.label);if(f.closeError)throw f.closeError;if(!f.closeUnconfirmed)f.tabs=f.tabs.filter(t=>t.label!==tab.label);}});
    openBoundTask=async(_r,_p,_a,options)=>{
      f.opens=(f.opens||0)+1;if(f.pausedProject===_p)throw Error('paused');if(!options.requireExistingSpace||options.spaceOverride.spaceId!==(f.expectedSpaceId||7))throw Error('exact existing Space required');
      return {binding:{...f.binding,...options.spaceOverride},task:{spaceId:f.expectedSpaceId||7,pages:async()=>pages,tabs:async()=>f.tabs}};
    };
    return await pruneManagedOrphanTabs(f.reg,f.allProjects?null:'P','a');
  `)(f,name);
  f.out=run;return f;
}

test("global orphan cleanup reuses the guarded helper once per verified Space",async()=>{
  const blank=await fixture();assert.deepEqual(blank.closed,["p1"]);assert.equal(blank.out.length,1);assert.ok(blank.queries>=2);
  const project=await fixture(f=>{f.tabs.shift();});assert.deepEqual(project.closed,["p2"]);
});

test("automatic orphan cleanup cannot bypass UNKNOWN, actual Project, registered CID or uncertain-close protections",async()=>{
  for(const change of [
    f=>{f.context.unboundAny=true;},
    f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];},
    f=>{f.tabs=f.tabs.slice(1);f.tabs[0].url=home.replace("a".repeat(32),"b".repeat(32));},
    f=>{f.tabs=f.tabs.slice(1);f.tabs[0].url=home.replace(/project$/,"c/11111111-1111-4111-8111-111111111111");},
    f=>{f.tabs=f.tabs.slice(1);f.tabs[0].url=home.replace(/project$/,"c/11111111-1111-4111-8111-111111111111");f.reg.chats.s={id:"s",spaceName:name,spaceId:7,page:"old",url:f.tabs[0].url};},
    f=>{f.tabs=f.tabs.slice(1);f.tabs[0].active=true;},
    f=>{f.tabs=f.tabs.slice(1);f.tabs[0].openedBy="user";},
    f=>{f.tabs=f.tabs.slice(1);f.snapshot.approvalRequired=true;},
    f=>{f.tabs=f.tabs.slice(1);f.snapshot.composerRawText="draft";},
    f=>{f.runtime.tasks.t={project:"P",account:"a",status:"RUNNING"};}
  ])assert.deepEqual((await fixture(change)).closed,[]);
  let observed;await assert.rejects(()=>fixture(f=>{observed=f;f.closeError=Error("close acknowledgement unknown");}),/acknowledgement unknown/);assert.deepEqual(observed.closed,["p1"]);
  await assert.rejects(()=>fixture(f=>{observed=f;f.closeUnconfirmed=true;}),/PAGE_CLOSE_UNCONFIRMED/);assert.deepEqual(observed.closed,["p1"]);
});

test("a precisely placed live conversation protects itself while an unrelated orphan is reclaimed",async()=>{
  const cid="11111111-1111-4111-8111-111111111111",setup=f=>{
    const url=home.replace(/project$/,"c/"+cid);
    f.reg.chats[cid]={id:cid,project:"P",account:"a",role:"worker",status:"active",spaceName:name,spaceId:7,profileId:"P1",page:"live",url};
    f.runtime.tasks.live={taskId:"live",project:"P",account:"a",sessionId:cid,status:"RUNNING"};
    f.tabs.push({label:"live",url,active:true,openedBy:"agent"});
  };
  const f=await fixture(setup);assert.deepEqual(f.closed,["p1"]);assert.equal(f.reg.chats[cid].page,"live");assert.equal(f.runtime.tasks.live.status,"RUNNING");
  const project=await fixture(f=>{setup(f);f.tabs.shift();f.context.sessionRefs=[cid];});assert.deepEqual(project.closed,["p2"]);assert.deepEqual(project.observedPages,["p2","p2"]);
  for(const change of [
    f=>{delete f.reg.chats[cid];},f=>{delete f.reg.chats[cid].page;},f=>{f.reg.chats[cid].spaceId=8;},f=>{f.reg.chats[cid].profileId="P2";},
    f=>{f.tabs.at(-1).url=home.replace(/project$/,"c/33333333-3333-4333-8333-333333333333");},
    f=>{f.runtime.tasks.live.project="HZOS";},f=>{f.runtime.tasks.live.account="foreign";f.reg.accounts.foreign={identity:"other-login"};},
    f=>{f.runtime.tasks.live.watchdogPausedForUserControl=true;},f=>{f.context.unboundAny=true;},f=>{f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];}
  ])assert.deepEqual((await fixture(f=>{setup(f);change(f);})).closed,[]);
});

test("a blocked first home cannot starve another safe page or another verified Project in the Space",async()=>{
  const later=await fixture(f=>{
    f.tabs.shift();f.tabs.push({...f.tabs[0],label:"p3"});
    f.snapshots={p2:{generating:true}};
  });
  assert.deepEqual(later.closed,["p3"]);
  for(const paused of [false,true]) {
    const f=await fixture(f=>{
      f.allProjects=true;f.tabs.shift();
      const other=home.replace("a".repeat(32),"b".repeat(32));
      f.reg.projects.Q={bindings:{a:{...f.binding,projectUrl:other}}};
      f.tabs.push({...f.tabs[0],label:"p3",url:other});
      f.context.unboundProjectIds=["g-p-"+"a".repeat(32)];
      if(paused)f.pausedProject="P";
    });
    assert.deepEqual(f.closed,["p3"]);assert.equal(f.out.length,1);
  }
});

test("orphan close checks the login and rechecks late draft, approval, generation, UNKNOWN and tab control",async()=>{
  for(const change of [
    f=>{f.guardError=Error("INPUT_LOGIN_MISMATCH");},
    f=>{f.beforeCloseGuard=()=>{f.snapshot.composerRawText="new draft";};},
    f=>{f.beforeCloseGuard=()=>{f.snapshot.approvalRequired=true;};},
    f=>{f.beforeCloseGuard=()=>{f.snapshot.generating=true;};},
    f=>{f.beforeCloseGuard=()=>{f.context.unboundAny=true;};},
    f=>{f.beforeCloseGuard=()=>{f.tabs[0].active=true;};},
    f=>{f.beforeCloseGuard=()=>{f.tabs[0].openedBy="user";};}
    ,f=>{f.beforeCloseGuard=()=>{f.spaces=[{id:7,name,profileId:"P1",ownership:"user",createdBy:"agent"}];};}
  ]) {
    const f=await fixture(f=>{f.tabs.shift();change(f);});
    assert.deepEqual(f.closed,[]);assert.equal(f.guardCalls,1);
  }
});

test("an unplaced task permits only unrelated Projects proven by its immutable route",async()=>{
  const setup=f=>{
    f.tabs.shift();f.runtime.tasks.t={taskId:"t",project:"Q",account:"a",sessionId:null,status:"RUNNING"};
    f.context.unplacedTaskScopes=[{taskId:"t",project:"Q",account:"a",sessionId:null,projectIds:["g-p-"+"b".repeat(32)]}];
  };
  assert.deepEqual((await fixture(setup)).closed,["p2"]);
  for(const change of [
    f=>{f.context.unplacedTaskScopes=[];},
    f=>{f.context.unplacedTaskScopes[0].taskId="other";},
    f=>{f.context.unplacedTaskScopes[0].projectIds=["g-p-"+"a".repeat(32)];},
    f=>{f.runtime.tasks.t.watchdogPausedForUserControl=true;},
    f=>{f.context.unboundAny=true;},
    f=>{f.beforeCloseGuard=()=>{f.context.unplacedTaskScopes=[];};},
    f=>{f.beforeCloseGuard=()=>{f.runtime.tasks.late={taskId:"late",project:"P",account:"a",status:"RUNNING"};};}
  ])assert.deepEqual((await fixture(f=>{setup(f);change(f);})).closed,[]);
});

test("scoped orphan cleanup covers only the exactly verified remembered overflow without chat attachments",async()=>{
  const setup=f=>{f.expectedSpaceId=9;f.reg.capacityOverflow={"login-a|P1":{identity:"login-a",profileId:"P1",spaceName:name+"-overflow",spaceId:9,account:"a"}};f.spaces=[{id:9,name:name+"-overflow",profileId:"P1",ownership:"agent",createdBy:"agent"}];};
  const safe=await fixture(setup);assert.deepEqual(safe.closed,["p1"]);assert.equal(safe.out[0].spaceId,9);assert.deepEqual(safe.reg.chats,{});
  for(const change of [
    f=>{f.reg.capacityOverflow["login-a|P1"].identity="foreign";},f=>{f.reg.capacityOverflow["login-a|P1"].profileId="P2";},
    f=>{f.reg.capacityOverflow["login-a|P1"].spaceId=8;},f=>{f.spaces[0].profileId="P2";},f=>{f.spaces[0].id=8;},
    f=>{f.spaces[0].ownership="user";},f=>{f.spaces[0].createdBy="user";},f=>{f.spaces.push({...f.spaces[0],id:10});}
  ]){const blocked=await fixture(f=>{setup(f);change(f);});assert.deepEqual(blocked.closed,[]);assert.equal(blocked.opens||0,0);}
  const unknown=await fixture(f=>{setup(f);f.context.unboundAny=true;});assert.deepEqual(unknown.closed,[]);
  const unplaced=await fixture(f=>{setup(f);f.runtime.tasks.t={taskId:"t",project:"P",account:"a",status:"RUNNING"};});assert.deepEqual(unplaced.closed,[]);
});
