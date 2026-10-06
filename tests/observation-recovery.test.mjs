import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import '../src/task-policy.js';
const source=await readFile('src/main.js','utf8');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const start=source.indexOf('async function reattachTask(');
const code='const {composerIsEmpty}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n'+source.slice(start,source.indexOf('\nasync function ensurePage',start));
async function fixture(overrides={}) {
  const chat={id:'sid',project:'P',account:'a',role:'critic',spaceName:'user-space',spaceId:0,page:'p0',url:'https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/c/sid'};
  const binding={spaceName:'chat-bridge-agent-a',profileId:'Profile 1',projectUrl:'https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/project'};
  const task={taskId:'T',sessionId:'sid',project:'P',account:'a',status:'RUNNING',watchdogPausedForUserControl:true};
  const runtime={tasks:{T:task,other:{watchdogPausedForUserControl:true}},projects:{P:{watchdogPausedForUserControl:true}}};
  const reg={projects:{P:{bindings:{a:binding}}},chats:{sid:chat},accounts:{a:{identity:'login-a'}}};
  let saved=0;
  const page={label:'p7',url:async()=>chat.url,waitForFunction:async()=>{},evaluate:async()=>overrides.login||'login-a',goto:async()=>{throw Error('unexpected navigation');}};
  const space={spaceId:9,tabs:async()=>[{label:'p7',url:chat.url,openedBy:'agent'}],page:()=>page};
  const snapshot={composerPresent:true,composerText:overrides.draft||'',composerCount:1,composerAttachmentsEmpty:true,composerRawText:overrides.draft||'',errorTexts:[],generating:false};
  const taskAccounts=new Map(overrides.accountConflict?[[9,'foreign']]:[]);
  const values={stored:()=>structuredClone(reg),taskAccounts,accountScope:(_reg,alias)=>alias,loadRuntime:async()=>runtime,activeTaskStatus:s=>s==='RUNNING',bindingFor:()=>binding,
    listTaskSpaces:async()=>[{id:9,name:binding.spaceName,ownership:overrides.ownership||'agent',createdBy:'agent',profileId:'Profile 1'}],
    assertWebAvailable:async()=>{},taskSpace:async()=>space,newManagedPage:async()=>{throw Error('unexpected new page');},waitForConversationReady:async()=>{assert.equal(taskAccounts.get(9),'a');},
    projectKey:url=>url.match(/g-p-[a-f0-9]{32}/)?.[0],state:async()=>snapshot,saveRegistry:async()=>saved++,saveRuntime:async()=>saved++,
    observeSession:async()=>snapshot,emitTaskEvent:async()=>{},
    coordinated:(_command,payload)=>{
      if(overrides.race) throw Error('REATTACH_OWNER_CHANGED');
      saved++;const next={...chat,...payload.attachment};
      if(payload.resumeWatch) delete task.watchdogPausedForUserControl;
      return {chat:next,task};
    }};
  const fn=await new AsyncFunction(...Object.keys(values),code+';return reattachTask;')(...Object.values(values));
  return {fn,chat,reg,runtime,get saved(){return saved;}};
}
test('reattach requires explicit confirmation and exact task',async()=>{
  const f=await fixture();await assert.rejects(f.fn(f.reg,f.chat,'T'),/CONFIRM/);
  await assert.rejects(f.fn(f.reg,f.chat,'wrong',{confirm:true}),/IDENTITY/);assert.equal(f.saved,0);
});
test('reattach never takes a user Space or wrong login',async()=>{
  for(const overrides of [{ownership:'user'},{login:'foreign-login'}]) {
    const f=await fixture(overrides);await assert.rejects(f.fn(f.reg,f.chat,'T',{confirm:true,resumeWatch:true}),/MANAGED_SPACE|LOGIN_MISMATCH/);
    assert.equal(f.saved,0);assert.equal(f.runtime.tasks.T.watchdogPausedForUserControl,true);
  }
});
test('reattach preserves nonempty composer and original attachment',async()=>{
  const f=await fixture({draft:'user draft'});await assert.rejects(f.fn(f.reg,f.chat,'T',{confirm:true,resumeWatch:true}),/DRAFT/);
  assert.equal(f.saved,0);assert.equal(f.reg.chats.sid.spaceName,'user-space');
});
test('reattach resumes only exact task and sends nothing',async()=>{
  const f=await fixture();const r=await f.fn(f.reg,f.chat,'T',{confirm:true,resumeWatch:true});
  assert.equal(r.messageSent,false);assert.equal(r.oldTabUntouched,true);assert.equal(r.sessionId,'sid');assert.equal(f.reg.chats.sid.page,'p7');
  assert.equal(f.runtime.tasks.T.watchdogPausedForUserControl,undefined);
  assert.equal(f.runtime.tasks.other.watchdogPausedForUserControl,true);assert.equal(f.runtime.projects.P.watchdogPausedForUserControl,true);
});
test('reattach without resume retains task observation pause',async()=>{
  const f=await fixture();await f.fn(f.reg,f.chat,'T',{confirm:true});assert.equal(f.runtime.tasks.T.watchdogPausedForUserControl,true);
});
const rawStart=source.indexOf('    function assistantSource(');
const rawCode=source.slice(rawStart,source.indexOf("    const legacy=",rawStart));
function extract(props,id='mid') {
  const fiber={memoizedProps:props,return:null};
  const n={matches:()=>true,__reactFiberTest:fiber};
  return new Function('node','id','location',rawCode+'; return assistantSource(node,id);')(n,id,{pathname:'/g/P/c/sid'});
}
test('message-bound raw Markdown preserves JSON escapes, unicode and multiline strings',()=>{
  const raw=JSON.stringify({op:'write_artifact',name:'a.json',text:JSON.stringify({message:'中文 "quotes"\n\\x_**'})});
  const out=extract({streamId:'sid:mid',conversationId:'sid',children:raw});assert.equal(out.text,raw);assert.deepEqual(JSON.parse(out.text),JSON.parse(raw));
  assert.equal(out.textSource,'message-bound-markdown-source');
});
test('raw extraction fails closed on wrong message, conversation or nontext source',()=>{
  assert.equal(extract({streamId:'sid:other',conversationId:'sid',children:'wrong'}),null);
  assert.equal(extract({streamId:'other:mid',conversationId:'other',children:'wrong'}),null);
  assert.equal(extract({streamId:'sid:mid',conversationId:'sid',children:['parts']}),null);
});
test('global orphan cleanup excludes unrelated agent workspaces',async()=>{
  const a=source.indexOf('async function pruneManagedOrphanTabs'),z=source.indexOf('\nasync function watchOnce',a);
  let touched=0;
  const fn=await new AsyncFunction('listTaskSpaces','loadRuntime','taskSpace',source.slice(a,z)+';return pruneManagedOrphanTabs;')(
    async()=>[{id:1,name:'Other tool workspace',ownership:'agent',createdBy:'agent'},{id:2,name:'chat-bridge-agent-foreign',ownership:'agent',createdBy:'agent'}],
    async()=>({tasks:{}}),async()=>{touched++;throw Error('must not open unrelated space');});
  assert.deepEqual(await fn({projects:{P:{bindings:{a:{spaceName:'chat-bridge-agent-a'}}}}}),[]);assert.equal(touched,0);
});

test('failed atomic attachment commit leaves both original registry and pause unchanged',async()=>{
  const f=await fixture({race:true});await assert.rejects(f.fn(f.reg,f.chat,'T',{confirm:true,resumeWatch:true}),/OWNER_CHANGED/);
  assert.equal(f.saved,0);assert.equal(f.reg.chats.sid.spaceName,'user-space');assert.equal(f.runtime.tasks.T.watchdogPausedForUserControl,true);
});

test('reattach records verified account scope before readiness and rejects conflicting scope',async()=>{
  const f=await fixture({accountConflict:true});await assert.rejects(f.fn(f.reg,f.chat,'T',{confirm:true}),/ACCOUNT_SCOPE_CONFLICT/);
  assert.equal(f.saved,0);
});

test('reattach CAS uses raw registry rather than normalized attachment projection',async()=>{
  const f=await fixture();const normalized={...f.chat,spaceName:'chat-bridge-agent-a',spaceId:null,page:null};
  const r=await f.fn(f.reg,normalized,'T',{confirm:true});assert.equal(r.previous.spaceName,'user-space');
});

test('message selection excludes zero-area hidden history clones but retains offscreen real messages',()=>{
  const a=source.indexOf('    function renderedMessage('),z=source.indexOf('    const legacy=',a);
  const fn=new Function('root','getComputedStyle',source.slice(a,z)+';return renderedMessage;')(
    {contains:n=>n.inRoot!==false},n=>({display:n.display||'block',visibility:n.visibility||'visible'}));
  const node=(id,width=768,height=30,extra={})=>({id,closest:()=>false,getBoundingClientRect:()=>({width,height,y:-8000}),...extra});
  const realOld=node('old'),realNew=node('new'),clone=node('older-hidden-clone',0,0);
  assert.deepEqual([realOld,realNew,clone].filter(fn).map(n=>n.id),['old','new']);
  assert.equal(fn(node('outside',768,30,{inRoot:false})),false);
  assert.equal(fn(node('aria-hidden',768,30,{closest:()=>({})})),false);
  assert.equal(fn(node('css-hidden',768,30,{visibility:'hidden'})),false);
  assert.equal(fn(node('display-none',768,30,{display:'none'})),false);
});

const observerStart=source.indexOf("async function observeOperation(");
const observerCode=source.slice(observerStart,source.indexOf("\nasync function ensurePage",observerStart));
async function operationFixture(change={}) {
  const cid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", projectId="g-p-"+"a".repeat(32);
  const scope={operationId:"op",taskId:"legacy-no-runtime",project:"P",account:"a",accountId:"scope-a",
    sessionRef:cid,projectId,anchor:"anchor",accountIdentity:"login",url:"https://chatgpt.com/g/"+projectId+"/c/"+cid,
    binding:{spaceName:"chat-bridge-agent-a",profileId:"Profile 1"}};
  let contextReads=0, opened=0;
  const snapshot={url:scope.url,observedAt:new Date().toISOString(),userMessages:[],composerText:"untouched draft",
    online:false,errorTexts:["Network error"],recoveryControls:[{label:"Retry",disabled:false}],pageWasDiscarded:false,
    generating:true,lastAssistantId:"assistant",lastAssistant:"body",messageCount:2};
  const page={label:"p1",url:async()=>change.url||scope.url,waitForFunction:async()=>{},
    evaluate:async()=>change.login||"login",goto:async()=>opened++};
  const params={coordinated:()=>({...scope,anchor:change.race&&contextReads++?"changed":"anchor"}),
    opt:key=>key==="project"?"P":"a",listTaskSpaces:async()=>[{id:1,name:scope.binding.spaceName,ownership:change.ownership||"agent",createdBy:"agent",profileId:"Profile 1"}],
    loadRuntime:async()=>({tasks:change.paused?{x:{sessionId:cid,watchdogPausedForUserControl:true}}:{},sessions:{}}),
    assertWebAvailable:async()=>{},taskSpace:async()=>({spaceId:1,tabs:async()=>[{label:"p1",url:scope.url,openedBy:"agent"}],page:()=>page,newPage:async()=>{throw Error("unexpected allocation");}}),
    taskAccounts:new Map(),accountScope:()=>scope.accountId,waitForConversationReady:async()=>{throw Error("read-only observer must never run retry-capable readiness");},
    recoveryRequired:()=>true,sameConversationUrl:(a,b)=>a===b,projectKey:url=>url.match(/g-p-[a-f0-9]{32}/)?.[0],state:async()=>snapshot};
  const fn=await new AsyncFunction(...Object.keys(params),observerCode+";return observeOperation;")(...Object.values(params));
  return {run:()=>fn({},"op"),get opened(){return opened;}};
}
test("operation observer reads existing conversation without runtime task, send or draft changes",async()=>{
  const f=await operationFixture(), result=await f.run();
  assert.equal(result.messageSent,false);assert.equal(result.draftChars,15);
  assert.equal(result.online,false);assert.deepEqual(result.errorTexts,["Network error"]);assert.equal(result.recoveryRequired,true);
  assert.deepEqual(result.recoveryControls,[{label:"Retry",disabled:false}]);
  assert.equal(result.generating,true);assert.equal(result.readOnly,true);assert.equal(f.opened,0);
});
test("operation observer rejects wrong login, URL, user Space, pause and changed anchor",async()=>{
  for(const [change,reason] of [[{login:"wrong"},/LOGIN/],[{url:"https://chatgpt.com/c/wrong"},/CONVERSATION/],
      [{ownership:"user"},/MANAGED_SPACE/],[{paused:true},/USER_CONTROL/],[{race:true},/CHANGED/]]) {
    const f=await operationFixture(change);await assert.rejects(f.run(),reason);assert.equal(f.opened,0);
  }
});
