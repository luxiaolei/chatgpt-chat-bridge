import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const source=await readFile('src/main.js','utf8'),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const start=source.indexOf('let pageAllocationOrdinal=0;'),end=source.indexOf('function samePhysicalSpace',start);
const home='https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/project';
async function fixture(change=()=>{}) {
  const binding={spaceName:'managed',spaceId:9,profileId:'P1',projectUrl:home};
  const reg={accounts:{a:{identity:'synthetic-login'}},projects:{P:{bindings:{a:binding}}},chats:{}};
  const f={reg,binding,records:[],releases:[],created:0,closed:0,reloaded:0,context:{unboundAny:false,unboundProjectIds:[]},
    tab:{label:'p9',targetId:'exact-native-target',url:home,type:'page',openedBy:'agent'},
    sample:{url:home,generating:false,approvalRequired:false,composerCount:1,composerRawText:'',composerAttachmentsEmpty:true}};
  await change(f);
  f.page={label:'p9',spaceId:9,targetId:f.pageTargetId??'exact-native-target',url:async()=>{f.urlReads=(f.urlReads||0)+1;if(f.urlError)throw f.urlError;return f.tab.url;},
    evaluate:async()=>true,reload:async options=>{assert.deepEqual(options,{waitUntil:'domcontentloaded',timeout:20000});assert.equal(f.intentPersisted,true);f.reloaded++;await f.onReload?.();}};
  f.tab.page=f.page;
  const task={spaceId:9,tabs:async()=>f.gone?[]:[f.tab],newPage:async()=>{f.created++;assert.equal(f.records.at(-1).phase,'ALLOCATION_INTENT');if(f.creationError)throw f.creationError;return f.page;},
    page:()=>{f.lazyCalls=(f.lazyCalls||0)+1;throw Error('lazy label handle must not be used');},
    cdp:async(method,params)=>{if(method==='Target.closeTarget'){assert.equal(params.targetId,'exact-native-target');f.closed++;if(f.closeError)throw f.closeError;f.gone=true;return 'closeResponse' in f?f.closeResponse:{success:true};}if(f.nativeError)throw f.nativeError;return 'nativeResponse' in f?f.nativeResponse:{targetInfos:f.gone?[]:[f.tab]};}};
  const ensureStart=source.indexOf('async function ensureProjectLocation'),ensureEnd=source.indexOf('\nasync function syncProject',ensureStart);
  const api=await new AsyncFunction('recordDeliveryStage','pageBudgetError','listTaskSpaces','stored','coordinated','projectHomeId','projectKey','assertInputSafe','state','composerIsEmpty','samePhysicalSpace','accountScope','opt','reg','crypto','projectRecord','accountManagedTask','openProjectPage','bindingFor','saveRegistry','touchRuntime','bindingExecutionReadiness','projectIdFromUrl','taskSpace',
    'const globalThis={__CHAT_BRIDGE_DELIVERY_ATTEMPT__:'+(f.direct?'null':'{}')+'};let sendAttempted=false;const bindingObserved=()=>false;const newManagedPage=(_reg,p,a,t,b)=>allocateManagedPage(t,b,p,a);'+source.slice(start,end)+source.slice(ensureStart,ensureEnd)+';return {allocateManagedPage,cleanupAllocatedPage,cleanupFailedAllocation,ensureProjectLocation,handoffAllocatedPage,releaseManagementPage};')(
    async(phase,data)=>{f.records.push({phase,data:structuredClone(data)});if(f.recordError===phase)throw Error('disk write refused');},
    e=>e.message==='page budget reached',async()=>f.spaces||[{id:9,name:'managed',profileId:'P1',ownership:'agent',createdBy:'agent'}],
    (_command,kind)=>kind==='registry'?reg:{tasks:{},sessions:{}},(command,payload)=>{
      if(command==='page-allocation-record'){f.realCoordinated?.(command,payload);f.records.push({phase:payload.phase,data:payload.data,requestId:payload.requestId});return {path:'allocation',sha256:'hash',bytes:1};}
      if(command==='page-release-record'||command==='page-termination-record'){f.releases.push(structuredClone({command,...payload}));if(f.intentError&&payload.phase==='INTENT')throw f.intentError;if(payload.phase==='INTENT'){f.intentPersisted=true;f.afterIntent?.();}return {path:'intent',sha256:'hash',bytes:1};}
      const referenced=Object.values(reg.chats).some(c=>c.page==='p9');
      return {...f.context,resourceRelease:{allowed:!referenced&&!f.denied&&payload.resourceTarget.profileId==='P1',reason:'PROTECTED'}};
    },()=>home.match(/g-p-[a-f0-9]{32}/)[0],
    url=>url.match(/g-p-[a-f0-9]{32}/)?.[0],async()=>{f.logins=(f.logins||0)+1;if(f.loginError)throw f.loginError;},async()=>{if(f.stateError)throw f.stateError;f.afterState?.();return {...f.sample};},
    s=>s.composerCount===1&&s.composerRawText===''&&s.composerAttachmentsEmpty===true,
    (a,b)=>a.spaceId===b.spaceId||a.spaceName===b.spaceName,()=>f.realScope||'login-hash',()=>null,reg,crypto,
    (r,p)=>r.projects[p],async()=>({task,spaceName:'managed',profileId:'P1'}),async()=>{if(f.projectFound)return home;throw Error('project not found');},
    (r,p,a)=>r.projects[p].bindings[a]||={},async()=>{},async()=>{if(f.runtimeError)throw f.runtimeError;},()=>({ready:true}),()=> 'g-p-'+'a'.repeat(32),async id=>{assert.equal(id,9);return task;});
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
test('management release uses the native bound tab Page rather than a lazy label handle and refuses invalid binding',async()=>{
  const x=await fixture();
  await x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true);
  assert.equal(x.f.closed,1);assert.equal(x.f.lazyCalls||0,0);assert.equal(x.f.created,0);
  for(const patch of [f=>{f.tab.page=null;},f=>{f.page.targetId='other';},f=>{f.page.spaceId=8;},f=>{f.page.label='other';},f=>{f.page.evaluate=null;}]) {
    const y=await fixture();patch(y.f);
    await assert.rejects(()=>y.api.releaseManagementPage(y.reg,'P','a','managed','p9','exact-native-target',true),/PAGE_BOUND_TARGET_UNVERIFIED/);
    assert.equal(y.f.closed,0);assert.equal(y.f.intentPersisted||false,false);assert.equal(y.f.lazyCalls||0,0);
  }
});
test('explicit home recovery reloads once before Page reads, then keeps every ordinary release guard',async()=>{
  const x=await fixture(f=>{f.urlError=Error('unresponsive Page');f.onReload=()=>{assert.equal(f.urlReads||0,0);f.urlError=null;};});
  const result=await x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,true);
  assert.equal(result.reloadAttempted,true);assert.equal(result.remoteExecutionStopped,false);
  assert.equal(x.f.reloaded,1);assert.equal(x.f.logins,1);assert.equal(x.f.closed,1);assert.equal(x.f.created,0);assert.equal(x.f.lazyCalls||0,0);
  assert.deepEqual(x.f.releases.map(r=>r.phase),['INTENT','RELEASED']);
  assert.equal(x.f.releases[0].data.reloadHome,true);assert.equal(x.f.releases[1].data.reloadAttempted,true);
});
test('home reload refuses changed metadata, native identity or permission before any Page call or mutation',async()=>{
  for(const patch of [f=>{f.denied=true;},f=>{f.reg.chats.current={page:'p9'};},
    ...['name','profileId','ownership','createdBy'].map(key=>f=>{f.spaces=[{id:9,name:'managed',profileId:'P1',ownership:'agent',createdBy:'agent',[key]:'changed'}];}),
    f=>{f.nativeError=Error('native unavailable');},f=>{f.nativeResponse={targetInfos:[{targetId:'exact-native-target',url:home,type:'worker'}]};},
    f=>{f.nativeResponse={targetInfos:[{targetId:'exact-native-target',url:home.replace('/project','/c/11111111-1111-4111-8111-111111111111'),type:'page'}]};}
  ]) {
    const x=await fixture(patch);
    await assert.rejects(()=>x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,true));
    assert.equal(x.f.reloaded,0);assert.equal(x.f.closed,0);assert.equal(x.f.intentPersisted||false,false);assert.equal(x.f.urlReads||0,0);
  }
  const missing=await fixture();delete missing.f.page.reload;
  await assert.rejects(()=>missing.api.releaseManagementPage(missing.reg,'P','a','managed','p9','exact-native-target',true,true),/RELOAD_UNAVAILABLE/);
  assert.equal(missing.f.intentPersisted||false,false);
});
test('scope and permission are rechecked after intent and before home reload',async()=>{
  for(const patch of [f=>{f.denied=true;},f=>{f.reg.chats.current={page:'p9'};},f=>{f.tab.targetId='replacement';},
    f=>{f.nativeResponse={targetInfos:[]};},f=>{f.spaces=[{id:9,name:'managed',profileId:'different',ownership:'agent',createdBy:'agent'}];}]) {
    const x=await fixture(f=>{f.afterIntent=()=>patch(f);});
    await assert.rejects(()=>x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,true));
    assert.equal(x.f.reloaded,0);assert.equal(x.f.closed,0);assert.deepEqual(x.f.releases.map(r=>r.phase),['INTENT','REFUSED']);
    assert.equal(x.f.releases[1].data.reloadAttempted,false);
  }
});
test('reload timeout or any later guard failure fences the exact target without another reload, close or allocation',async()=>{
  for(const patch of [f=>{throw Error('reload ACK unknown');},f=>{f.urlError=Error('still unresponsive');},
    f=>{f.loginError=Error('login changed');},f=>{f.stateError=Error('UI unknown');},f=>{f.sample.composerRawText='retained draft';},
    f=>{f.sample.generating=true;},f=>{f.sample.approvalRequired=true;},f=>{f.tab.targetId='replacement';},f=>{f.denied=true;}]) {
    const x=await fixture(f=>{f.onReload=()=>patch(f);});
    await assert.rejects(()=>x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,true),e=>e.allocationState==='UNKNOWN');
    assert.equal(x.f.reloaded,1);assert.equal(x.f.closed,0);assert.equal(x.f.created,0);
    assert.deepEqual(x.f.releases.map(r=>r.phase),['INTENT','UNKNOWN']);
    assert.equal(x.f.releases[1].data.reloadAttempted,true);assert.equal(x.f.releases[1].data.closeAttempted,false);
  }
});
const reloadUnknown={path:'/private/001-UNKNOWN.json',sha256:'a'.repeat(64)};
test('explicit termination uses only captured browser metadata and a distinct intent before one close',async()=>{
  const x=await fixture(f=>{f.urlError=Error('renderer unresponsive');f.loginError=Error('renderer unresponsive');f.stateError=Error('renderer unresponsive');});
  const result=await x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,false,reloadUnknown);
  assert.equal(result.rendererStateVerified,false);assert.equal(result.remoteExecutionStopped,false);assert.equal(result.deliveryProven,false);
  assert.equal(x.f.closed,1);assert.equal(x.f.reloaded,0);assert.equal(x.f.created,0);assert.equal(x.f.urlReads||0,0);assert.equal(x.f.logins||0,0);
  assert.deepEqual(x.f.releases.map(r=>[r.command,r.phase]),[['page-termination-record','INTENT'],['page-termination-record','RELEASED']]);
  assert.deepEqual(x.f.releases[0].terminateAfterReloadUnknown,reloadUnknown);
});
test('termination rejects failed exclusive intent and fresh identity/reference drift before any close',async()=>{
  for(const patch of [f=>{f.intentError=Error('exclusive intent exists');},f=>{f.denied=true;},f=>{f.nativeResponse={targetInfos:[]};},
    f=>{f.nativeResponse={targetInfos:[{targetId:'exact-native-target',type:'page',url:'https://chatgpt.com/'}]};},
    f=>{f.afterIntent=()=>{f.denied=true;};},f=>{f.afterIntent=()=>{f.reg.chats.current={page:'p9'};};},
    f=>{f.afterIntent=()=>{f.tab.targetId='replacement';};},f=>{f.afterIntent=()=>{f.spaces=[{id:9,name:'managed',profileId:'changed',ownership:'agent',createdBy:'agent'}];};},
    f=>{f.afterIntent=()=>{f.nativeResponse={targetInfos:[]};};}]) {
    const x=await fixture(patch);
    await assert.rejects(()=>x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,false,reloadUnknown));
    assert.equal(x.f.closed,0);assert.equal(x.f.reloaded,0);assert.equal(x.f.urlReads||0,0);
  }
  const conflict=await fixture();
  await assert.rejects(()=>conflict.api.releaseManagementPage(conflict.reg,'P','a','managed','p9','exact-native-target',true,true,reloadUnknown),/RELOAD_CONFLICT/);
  assert.equal(conflict.f.releases.length,0);
});
test('termination requires exact close ACK plus native and Space disappearance; any uncertainty records UNKNOWN',async()=>{
  for(const patch of [f=>{f.closeError=Error('ACK lost');},f=>{f.closeResponse={success:false};},
    f=>{f.nativeResponse={targetInfos:[{targetId:'exact-native-target',type:'page',url:home}]};},
    f=>{f.spaceRetained=true;},f=>{f.nativeAfterCloseError=true;}]) {
    const x=await fixture(patch);
    if(x.f.nativeAfterCloseError){const cdp=x.task.cdp;x.task.cdp=async(...args)=>{if(x.f.closed&&args[0]==='Target.getTargets')throw Error('inventory unreadable');return cdp(...args);};}
    if(x.f.spaceRetained){const tabs=x.task.tabs;x.task.tabs=async()=>x.f.closed?[x.f.tab]:tabs();}
    await assert.rejects(()=>x.api.releaseManagementPage(x.reg,'P','a','managed','p9','exact-native-target',true,false,reloadUnknown),e=>e.allocationState==='UNKNOWN');
    assert.equal(x.f.closed,1);assert.equal(x.f.reloaded,0);assert.deepEqual(x.f.releases.map(r=>r.phase),['INTENT','UNKNOWN']);
    assert.equal(x.f.releases.at(-1).data.closeAttempted,true);
  }
});
test('native inventory must confirm the captured target before close and only an explicit success acknowledges close',async()=>{
  for(const patch of [f=>{f.nativeError=Error('Target domain unavailable');},...[undefined,{}, {targetInfos:[]},{targetInfos:[{targetId:'other'}]},{targetInfos:[null,{targetId:'exact-native-target'}]},{targetInfos:[{targetId:'exact-native-target'},{targetId:'exact-native-target'}]}].map(response=>f=>{f.nativeResponse=response;})]) {
    const x=await fixture(patch),page=await x.api.allocateManagedPage(x.task,x.binding,'P','a'),result={};
    await x.api.cleanupFailedAllocation(x.reg,x.task,page,result);
    assert.equal(x.f.closed,0);assert.equal(result.allocationState,'RETAINED');
    assert.ok(!x.f.records.some(r=>r.phase==='PAGE_RELEASED'));
  }
  for(const response of [undefined,{}, {success:false}]) {
    const x=await fixture(f=>{f.closeResponse=response;}),page=await x.api.allocateManagedPage(x.task,x.binding,'P','a'),result={};
    await x.api.cleanupFailedAllocation(x.reg,x.task,page,result);
    assert.equal(x.f.closed,1);assert.equal(result.allocationState,'UNKNOWN');
    assert.ok(!x.f.records.some(r=>r.phase==='PAGE_RELEASED'));
  }
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

test('direct allocation cannot bypass an unknown physical scope across fresh VM invocations and new nonces',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-allocation-vm-')),config=path.join(root,'config'),stateDir=path.join(root,'state');
 await mkdir(config);await mkdir(stateDir);
 const reg={accounts:{a:{identity:'one'},b:{identity:'one'}},projects:{P:{bindings:{a:{spaceName:'managed',spaceId:9,profileId:'P1',projectUrl:home}}}},chats:{}};
 await writeFile(path.join(config,'registry.json'),JSON.stringify(reg));await writeFile(path.join(stateDir,'runtime.json'),JSON.stringify({tasks:{}}));
 const scope=crypto.createHash('sha256').update('identity:one').digest('hex');
 const real=(command,payload)=>{const r=spawnSync('python3',[path.resolve('src/coordinator.py'),command,config,stateDir],{encoding:'utf8',input:JSON.stringify(payload)});if(r.status)throw Error(r.stderr);return JSON.parse(r.stdout);};
 try {
  const first=await fixture(f=>{f.direct=true;f.realScope=scope;f.realCoordinated=real;f.creationError=Error('native create ACK unknown');});
  await assert.rejects(()=>first.api.allocateManagedPage(first.task,first.binding,'P','a'),e=>e.allocationState==='UNKNOWN');assert.equal(first.f.created,1);
  for(const alias of ['a','b']) {
   const next=await fixture(f=>{f.direct=true;f.realScope=scope;f.realCoordinated=real;f.reg.accounts.b={identity:'one'};});
   await assert.rejects(()=>next.api.allocateManagedPage(next.task,next.binding,'P',alias),/PAGE_ALLOCATION_UNRESOLVED/);assert.equal(next.f.created,0);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
