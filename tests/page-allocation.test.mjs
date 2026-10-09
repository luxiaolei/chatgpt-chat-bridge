import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
const source=await readFile('src/main.js','utf8'),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const start=source.indexOf('let pageAllocationOrdinal=0;'),end=source.indexOf('function samePhysicalSpace',start);
const home='https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/project';
async function fixture(change=()=>{}) {
  const binding={spaceName:'managed',spaceId:9,profileId:'P1',projectUrl:home};
  const reg={accounts:{a:{identity:'synthetic-login'}},projects:{P:{bindings:{a:binding}}},chats:{}};
  const f={reg,binding,records:[],created:0,closed:0,context:{unboundAny:false,unboundProjectIds:[]},
    tab:{label:'p9',targetId:'exact-native-target',url:home,openedBy:'agent'},
    sample:{url:home,generating:false,approvalRequired:false,composerCount:1,composerRawText:'',composerAttachmentsEmpty:true}};
  await change(f);
  f.page={label:'p9',targetId:f.pageTargetId??'exact-native-target',url:async()=>f.tab.url,
    evaluate:async()=>true};
  const task={spaceId:9,tabs:async()=>f.gone?[]:[f.tab],newPage:async()=>{f.created++;assert.equal(f.records.at(-1).phase,'ALLOCATION_INTENT');if(f.creationError)throw f.creationError;return f.page;},
    cdp:async(method,params)=>{if(method==='Target.closeTarget'){assert.equal(params.targetId,'exact-native-target');f.closed++;if(f.closeError)throw f.closeError;f.gone=true;return {success:true};}return {targetInfos:f.gone?[]:[f.tab]};}};
  const ensureStart=source.indexOf('async function ensureProjectLocation'),ensureEnd=source.indexOf('\nasync function syncProject',ensureStart);
  const api=await new AsyncFunction('recordDeliveryStage','pageBudgetError','listTaskSpaces','stored','coordinated','projectHomeId','projectKey','assertInputSafe','state','composerIsEmpty','samePhysicalSpace','accountScope','opt','reg','crypto','projectRecord','accountManagedTask','openProjectPage','bindingFor','saveRegistry','touchRuntime','bindingExecutionReadiness','projectIdFromUrl',
    'const globalThis={__CHAT_BRIDGE_DELIVERY_ATTEMPT__:'+(f.direct?'null':'{}')+'};let sendAttempted=false;const bindingObserved=()=>false;const newManagedPage=(_reg,p,a,t,b)=>allocateManagedPage(t,b,p,a);'+source.slice(start,end)+source.slice(ensureStart,ensureEnd)+';return {allocateManagedPage,cleanupAllocatedPage,cleanupFailedAllocation,ensureProjectLocation};')(
    async(phase,data)=>{f.records.push({phase,data:structuredClone(data)});if(f.recordError===phase)throw Error('disk write refused');},
    e=>e.message==='page budget reached',async()=>[{id:9,name:'managed',profileId:'P1',ownership:'agent',createdBy:'agent'}],
    (_command,kind)=>kind==='registry'?reg:{tasks:{},sessions:{}},(command,payload)=>{
      if(command==='page-allocation-record'){f.records.push({phase:payload.phase,data:payload.data,requestId:payload.requestId});return {path:'allocation',sha256:'hash',bytes:1};}
      if(command==='page-release-record'){if(payload.phase==='INTENT'){f.intentPersisted=true;f.afterIntent?.();}return {path:'intent',sha256:'hash',bytes:1};}
      const referenced=Object.values(reg.chats).some(c=>c.page==='p9');
      return {...f.context,resourceRelease:{allowed:!referenced&&!f.denied,reason:'PROTECTED'}};
    },()=>home.match(/g-p-[a-f0-9]{32}/)[0],
    url=>url.match(/g-p-[a-f0-9]{32}/)?.[0],async()=>{f.logins=(f.logins||0)+1;},async()=>{f.afterState?.();return {...f.sample};},
    s=>s.composerCount===1&&s.composerRawText===''&&s.composerAttachmentsEmpty===true,
    (a,b)=>a.spaceId===b.spaceId||a.spaceName===b.spaceName,()=> 'login-hash',()=>null,reg,crypto,
    (r,p)=>r.projects[p],async()=>({task,spaceName:'managed',profileId:'P1'}),async()=>{if(f.projectFound)return home;throw Error('project not found');},
    (r,p,a)=>r.projects[p].bindings[a]||={},async()=>{},async()=>{if(f.runtimeError)throw f.runtimeError;},()=>({ready:true}),()=> 'g-p-'+'a'.repeat(32));
  return {...f,f,api,task};
}
test('allocation persists intent before calling native and distinguishes a budget refusal from an unknown allocation',async()=>{
  const budget=await fixture(f=>{f.creationError=Error('page budget reached');});
  await assert.rejects(()=>budget.api.allocateManagedPage(budget.task,budget.binding,'P','a'),e=>!e.allocationState);
  assert.deepEqual(budget.f.records.map(r=>r.phase),['ALLOCATION_INTENT','ALLOCATION_REFUSED']);
  for(const patch of [f=>{f.creationError=Error('connection lost after create');},f=>{f.pageTargetId='';},f=>{f.recordError='PAGE_ALLOCATED';}]) {
    const x=await fixture(patch);
    await assert.rejects(()=>x.api.allocateManagedPage(x.task,x.binding,'P','a'),e=>e.allocationState==='UNKNOWN');
    assert.equal(x.f.created,1);assert.equal(x.f.closed,0);
  }
});
test('failed allocation cleanup closes only its unchanged owned idle target and confirms disappearance',async()=>{
  const x=await fixture();const page=await x.api.allocateManagedPage(x.task,x.binding,'P','a');
  const outcome=Error('navigation failed');await x.api.cleanupFailedAllocation(x.reg,x.task,page,outcome);
  assert.equal(outcome.pageCleanup.state,'RELEASED');assert.equal(x.f.closed,1);
  assert.deepEqual(x.f.records.map(r=>r.phase),['ALLOCATION_INTENT','PAGE_ALLOCATED','PAGE_RELEASE_INTENT','PAGE_RELEASED']);
});
test('target replacement, attachment, unknown protection, draft, generation and uncertain close retain evidence and prohibit reallocation',async()=>{
  for(const patch of [
    f=>{f.afterState=()=>{f.tab.targetId='recycled';};},
    f=>{f.reg.chats.worker={page:'p9',spaceId:9};},
    f=>{f.denied=true;},f=>{f.sample.composerRawText='unsent draft';},
    f=>{f.sample.generating=true;},f=>{f.closeError=Error('close ACK lost');}
  ]) {
    const x=await fixture(patch);const page=await x.api.allocateManagedPage(x.task,x.binding,'P','a');
    const outcome=Error('original failure');await x.api.cleanupFailedAllocation(x.reg,x.task,page,outcome);
    assert.equal(outcome.message,'original failure');assert.ok(['RETAINED','UNKNOWN'].includes(outcome.allocationState));
    assert.equal(x.f.created,1);assert.equal(x.f.closed,x.f.closeError?1:0);
    assert.ok(!x.f.records.some(r=>r.phase==='PAGE_RELEASED'));
  }
});
test('actual unbound ensure early returns release their owned root page with a direct persisted request',async()=>{
  for(const options of [{},{create:true}]) {
    const x=await fixture(f=>{f.direct=true;delete f.reg.projects.P.bindings.a;f.tab.url=f.sample.url='https://chatgpt.com/';});
    const result=await x.api.ensureProjectLocation(x.reg,'P','a',options);
    assert.equal(result.status,options.create?'NEEDS_APPROVAL':'NEEDS_PROJECT_SETUP');
    assert.equal(result.pageCleanup.state,'RELEASED');assert.equal(x.f.closed,1);
    assert.ok(x.f.records.every(r=>r.requestId));
  }
});
test('final UI is sampled after release intent and new drafts or target drift refuse the exact close',async()=>{
  for(const patch of [f=>{f.sample.composerRawText='late draft';},f=>{f.tab.targetId='new-instance';}]) {
    const x=await fixture(f=>{f.afterIntent=()=>patch(f);});const p=await x.api.allocateManagedPage(x.task,x.binding,'P','a');
    const result={};await x.api.cleanupFailedAllocation(x.reg,x.task,p,result);
    assert.equal(x.f.intentPersisted,true);assert.equal(x.f.closed,0);assert.equal(result.allocationState,'RETAINED');
  }
});

test('registry handoff remains intact when the later runtime update fails',async()=>{
  const x=await fixture(f=>{f.direct=true;delete f.reg.projects.P.bindings.a;f.projectFound=true;f.runtimeError=Error('runtime unavailable');});
  await assert.rejects(()=>x.api.ensureProjectLocation(x.reg,'P','a',{}),/runtime unavailable/);
  assert.equal(x.reg.projects.P.bindings.a.controlPage,'p9');assert.equal(x.f.closed,0);
});
