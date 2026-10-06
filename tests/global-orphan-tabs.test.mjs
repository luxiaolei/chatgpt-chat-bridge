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
    context:{sessionRefs:[],unboundProjectIds:[],unboundAny:false},snapshot:{approvalRequired:false,generating:false,composerCount:1,composerRawText:""}};
  change(f);
  const run=await new AsyncFunction("f","name",source+`
    loadRuntime=async()=>f.runtime;
    listTaskSpaces=async()=>[{id:7,name,profileId:'P1',ownership:'agent',createdBy:'agent'}];
    imageSessionOccupancy=()=>({occupied:false});
    state=async()=>f.snapshot;
    coordinated=command=>{if(command!=='page-reclaim-context')throw Error(command);f.queries++;return f.context;};
    const pages=f.tabs.map(tab=>({label:tab.label,url:async()=>tab.url,close:async()=>{f.closed.push(tab.label);if(f.closeError)throw f.closeError;}}));
    openBoundTask=async(_r,_p,_a,options)=>{
      if(!options.requireExistingSpace||options.spaceOverride.spaceId!==7)throw Error('exact existing Space required');
      return {binding:{...f.binding,...options.spaceOverride},task:{spaceId:7,pages:async()=>pages,tabs:async()=>f.tabs}};
    };
    return await pruneManagedOrphanTabs(f.reg,'P','a');
  `)(f,name);
  f.out=run;return f;
}

test("global orphan cleanup reuses the guarded helper once per verified Space",async()=>{
  const blank=await fixture();assert.deepEqual(blank.closed,["p1"]);assert.equal(blank.out.length,1);assert.equal(blank.queries,1);
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
});
