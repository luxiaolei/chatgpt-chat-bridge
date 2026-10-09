import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import * as evidence from '../src/delivery-attempt.mjs';

const source=await fs.readFile(new URL('../src/main.js',import.meta.url),'utf8');
const record=source.slice(source.indexOf('async function recordDeliveryStage('),source.indexOf('function deliveryStageSnapshot('));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import('../src/'+file+'.js');
const spaceCatalog=await import('../src/space-catalog.js');

test('an opt-in direct send records its stage without a coordinator attempt',async()=>{
  const calls=[];
  const journal={manifest:{},record:async(...args)=>{calls.push(args);return {path:'private/20-BEFORE_INPUT.json'};}};
  const run=new AsyncFunction('journal',`const globalThis={};let directRequestJournal=journal,deliveryAttemptPromise=null;${record}return recordDeliveryStage('BEFORE_INPUT',{targetUrl:'synthetic'},'body');`);
  assert.deepEqual(await run(journal),{path:'private/20-BEFORE_INPUT.json'});
  assert.deepEqual(calls,[['BEFORE_INPUT',{targetUrl:'synthetic'},'body']]);
  assert.equal(await run(null),null);
});

test('direct requests have an opt-in private journal initializer',()=>{
  assert.equal(typeof evidence.openDirectRequest,'function');
});

const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const cid='11111111-1111-4111-8111-111111111111';
const url='https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'/c/'+cid;
async function fixture(change={}){
  const state=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bridge-direct-')));
  const body='synthetic full request\n尾部🧪\n';
  const request={format:'chat-bridge-direct-request-v1',operationId:'outbox:original',claimToken:'original-claim',
    owner:{agentId:'original-agent',principal:'original-principal'},jobId:'job',generation:1,attempt:1,
    contextSha256:sha('context'),project:'P',account:'a',accountId:sha('identity:login'),sessionRef:cid,targetUrl:url,
    callerRef:cid,taskId:'T',messageSha256:sha(body),requestedModel:'GPT-6',requestedEffort:'High',
    deadlineAt:Date.now()+60000,route:{projectId:'g-p-'+'a'.repeat(32),profileId:'P1',identityHash:sha('login')},...change};
  request.requestId=sha(JSON.stringify([request.operationId,request.claimToken]));
  const requestFile=path.join(state,'request.json'),raw=JSON.stringify(request)+'\n';
  await fs.writeFile(requestFile,raw,{mode:0o600});
  const expected=Object.fromEntries(['project','account','accountId','sessionRef','targetUrl','callerRef','taskId','messageSha256','requestedModel','requestedEffort','route'].map(k=>[k,request[k]]));
  return {state,body,request,requestFile,raw,expected,descriptor:{requestId:request.requestId,requestFile,expectedHash:sha(raw)}};
}

test('the actual send router binds its original CLI before pause changes or the first UI call',async()=>{
  for(const mismatch of [false,true]){
    const f=await fixture(mismatch?{callerRef:'wrong-caller'}:{});try{
      const calls=[],globals={...globalThis,__CHAT_BRIDGE_ARGS__:['send',cid,f.body,'--project','P','--account','a','--task','T',
        '--caller-ref',cid,'--model','GPT-6','--effort','High','--request-id',f.request.requestId,'--request-file',f.requestFile,'--expected-hash',f.descriptor.expectedHash],
        __CHAT_BRIDGE_STATE_DIR__:f.state,__CHAT_BRIDGE_CONFIG_DIR__:f.state,
        __CHAT_BRIDGE_COORDINATOR_PATH__:new URL('../src/coordinator.py',import.meta.url).pathname};
      const reg={accounts:{a:{identity:'login'}},projects:{P:{bindings:{a:{projectUrl:url.replace('/c/'+cid,'/project'),profileId:'P1'}}}},
        chats:{[cid]:{id:cid,project:'P',account:'a',url,status:'active',name:'synthetic'}}};
      const split=source.indexOf('const cmd=args[0] || "help";');
      const run=new AsyncFunction('f','globalThis','console',source.slice(0,split)+`
        loadRegistry=async()=>f.reg;assertImageSessionFree=()=>{};
        clearUserControlPause=async()=>{f.calls.push('pause');return false;};
        ensurePage=async()=>{f.calls.push('ui');
          await fs.stat(pathMod.join(STATE_DIR,'direct-requests',f.id,'00-REQUEST_INTENT.json'));
          throw new Error('SYNTHETIC_FIRST_UI');};
        `+source.slice(split));
      await assert.rejects(()=>run({reg,calls,id:f.request.requestId},globals,{log:()=>{},error:()=>{}}),
        mismatch?/DIRECT_REQUEST_SCOPE_MISMATCH/:/SYNTHETIC_FIRST_UI/);
      assert.deepEqual(calls,mismatch?[]:['ui']);
    }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('automatic opt-in requests preserve and refuse user control while legacy foreground keeps explicit resume',async()=>{
  for(const [optIn,paused] of [[true,true],[true,false],[false,true]]){
    const f=await fixture();try{
      const calls=[],runtime={tasks:{T:{sessionId:cid,project:'P',account:'a',watchdogPausedForUserControl:paused}},
        projects:{P:{watchdogPausedForUserControl:paused}}},baseline=structuredClone(runtime);
      const globals={...globalThis,__CHAT_BRIDGE_SPACE_CATALOG__:spaceCatalog,
        __CHAT_BRIDGE_ARGS__:['send',cid,f.body,'--project','P','--account','a','--task','T','--caller-ref',cid,'--model','GPT-6','--effort','High',
          ...(optIn?['--request-id',f.request.requestId,'--request-file',f.requestFile,'--expected-hash',f.descriptor.expectedHash]:[])],
        __CHAT_BRIDGE_STATE_DIR__:f.state,__CHAT_BRIDGE_CONFIG_DIR__:f.state,
        __CHAT_BRIDGE_COORDINATOR_PATH__:new URL('../src/coordinator.py',import.meta.url).pathname};
      const reg={accounts:{a:{identity:'login'}},projects:{P:{bindings:{a:{spaceName:'managed',spaceId:7,
        projectUrl:url.replace('/c/'+cid,'/project'),profileId:'P1'}}}},chats:{[cid]:{id:cid,project:'P',account:'a',url,status:'active',name:'synthetic'}}};
      const split=source.indexOf('const cmd=args[0] || "help";');
      const run=new AsyncFunction('f','globalThis','console',source.slice(0,split)+`
        loadRegistry=async()=>f.reg;assertImageSessionFree=()=>{};loadRuntime=async()=>structuredClone(f.runtime);
        saveRuntime=async value=>{f.runtime=value;};bindingObserved=()=>true;assertWebAvailable=async()=>{};
        const listTaskSpaces=async()=>[{id:7,name:'managed',profileId:'P1',ownership:f.paused?'user':'agent'}];
        const originalClear=clearUserControlPause,originalEnsure=ensurePage;
        clearUserControlPause=async chat=>{f.calls.push('resume');return originalClear(chat);};
        ensurePage=async(...args)=>{f.calls.push('ensure');f.pauseGate=args[2].pauseOnUserControl;
          if(f.optIn&&f.paused)return originalEnsure(...args);throw new Error('SYNTHETIC_FIRST_UI');};
        `+source.slice(split));
      const input={reg,calls,runtime,optIn,paused};
      await assert.rejects(()=>run(input,globals,{log:()=>{},error:()=>{}}),optIn&&paused?/SPACE_IN_USER_CONTROL/:/SYNTHETIC_FIRST_UI/);
      assert.equal(input.pauseGate,optIn);assert.deepEqual(calls,optIn?['ensure']:['resume','ensure']);
      if(optIn)assert.deepEqual(input.runtime,baseline);
      else {assert.equal(input.runtime.tasks.T.watchdogPausedForUserControl,undefined);assert.equal(input.runtime.projects.P.watchdogPausedForUserControl,undefined);}
    }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('direct intent is durable and retains the original caller claim without a fake queue operation',async()=>{
  const f=await fixture();try{
    const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected);
    assert.equal(await fs.readFile(j.reference.manifestPath,'utf8'),f.raw);
    assert.equal(j.reference.manifestSha256,sha(f.raw));
    const intent=JSON.parse(await fs.readFile(path.join(j.reference.directory,'00-REQUEST_INTENT.json')));
    assert.equal(intent.requestId,f.request.requestId);assert.equal(intent.operationId,'outbox:original');
    assert.equal(intent.claimToken,'original-claim');assert.equal(intent.claimOrdinal,undefined);
    assert.equal(intent.format,f.request.format);assert.equal(intent.manifestSha256,sha(f.raw));
    assert.equal((await fs.stat(j.reference.manifestPath)).mode&0o077,0);
    await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,f.expected),/DIRECT_REQUEST_ALREADY_RECORDED/);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('private file, exact CLI scope, route, body, claim and deadline are checked before intent',async()=>{
  for(const change of ['project','account','accountId','sessionRef','targetUrl','callerRef','taskId','messageSha256','requestedModel','requestedEffort','route']){
    const f=await fixture();try{
      await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,{...f.expected,[change]:'wrong'}),/DIRECT_REQUEST_SCOPE_MISMATCH/);
      await assert.rejects(()=>fs.stat(path.join(f.state,'direct-requests',f.request.requestId)),{code:'ENOENT'});
    }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
  for(const kind of ['hash','symlink','mode','expired','revoked','nonce']){
    const f=await fixture(kind==='expired'?{deadlineAt:Date.now()-1}:{});try{
      if(kind==='hash')f.descriptor.expectedHash='0'.repeat(64);
      if(kind==='symlink'){const link=f.requestFile+'.link';await fs.symlink(f.requestFile,link);f.descriptor.requestFile=link;}
      if(kind==='mode')await fs.chmod(f.requestFile,0o644);
      if(kind==='revoked')await fs.writeFile(f.requestFile+'.revoked','caller ended',{mode:0o600});
      if(kind==='nonce')f.descriptor.requestId='0'.repeat(64);
      await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,f.expected),/DIRECT_REQUEST_/);
    }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('revocation or changed source fences new action intent while keeping post-Send UID and full source',async()=>{
  const f=await fixture();try{
    const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected);
    await j.record('SEND_INTENT',{targetUrl:url});
    await fs.writeFile(f.requestFile+'.revoked','caller ended',{mode:0o600});
    assert.throws(()=>j.assertCurrent(),/DIRECT_REQUEST_REVOKED/);
    await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,f.expected),
      error=>error.code==='DIRECT_REQUEST_ALREADY_RECORDED'&&error.deliveryStage==='SEND_ATTEMPTED');
    await assert.rejects(()=>j.record('BEFORE_INPUT',{targetUrl:url},f.body),/DIRECT_REQUEST_REVOKED/);
    const uid='22222222-2222-4222-8222-222222222222';
    const data={lastUserId:uid,nativeBody:f.body,nativeWitness:{messageId:uid,postSend:{phase:'POST_SEND_CONFIRMATION'}},
      snapshot:{url,lastUserId:uid,lastUserSource:{messageId:uid,conversationId:cid,text:f.body}}};
    const saved=await j.record('DELIVERY_CONFIRMED',data);
    assert.deepEqual(JSON.parse(await fs.readFile(saved.path)).data,data);
    await assert.rejects(()=>j.record('SEND_INTENT',{targetUrl:url}),/DIRECT_REQUEST_REVOKED/);
    await fs.unlink(f.requestFile+'.revoked');await fs.appendFile(f.requestFile,' ');
    assert.throws(()=>j.assertCurrent(),/DIRECT_REQUEST_CHANGED/);
    await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,f.expected),
      error=>error.code==='DIRECT_REQUEST_ALREADY_RECORDED'&&error.deliveryStage==='SEND_ATTEMPTED');
    await j.record('SCRIPT_FINISHED',{sendAttempted:true,succeeded:true});
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('caller expiry or revocation during the source file read is rechecked before action',async()=>{
  for(const kind of ['revoked','expired']){
  const f=await fixture();try{
    const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import assert from 'node:assert/strict';
      import {openDirectRequest} from ${JSON.stringify(new URL('../src/delivery-attempt.mjs',import.meta.url).href)};
      const j=await openDirectRequest(${JSON.stringify(f.state)},${JSON.stringify(f.descriptor)},${JSON.stringify(f.expected)});
      const read=fs.readSync;fs.readSync=(...args)=>{const n=read(...args);${kind==='revoked'?`fs.writeFileSync(${JSON.stringify(f.requestFile+'.revoked')},'caller ended',{mode:0o600});`:`Date.now=()=>${f.request.deadlineAt};`}return n;};
      syncBuiltinESMExports();assert.throws(()=>j.assertCurrent(),/${kind==='revoked'?'DIRECT_REQUEST_REVOKED':'DIRECT_REQUEST_EXPIRED'}/);`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('the direct deadline is checked again at action intent, with evidence retained after expiry',async()=>{
  const f=await fixture({deadlineAt:Date.now()+1000});try{
    const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected);
    await j.record('BEFORE_INPUT',{targetUrl:url},f.body);
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,f.request.deadlineAt-Date.now())+10));
    await assert.rejects(()=>j.record('SEND_INTENT',{targetUrl:url}),/DIRECT_REQUEST_EXPIRED/);
    await j.record('INPUT_VERIFIED',{nativeWitness:{url,accountIdentityHash:sha('login')},nativeBody:f.body});
    await j.record('ERROR',{deliveryStage:'PRE_SEND',code:'DIRECT_REQUEST_EXPIRED'});
    await assert.rejects(()=>fs.stat(path.join(j.reference.directory,'40-SEND_INTENT.json')),{code:'ENOENT'});
    await assert.rejects(()=>evidence.openDirectRequest(f.state,f.descriptor,f.expected),
      error=>error.code==='DIRECT_REQUEST_ALREADY_RECORDED'&&error.deliveryStage==='SEND_ATTEMPTED');
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('a caller with empty stdout can locate the same immutable request and native UID after child exit',async()=>{
  const f=await fixture();try{
    const script=`import {openDirectRequest} from ${JSON.stringify(new URL('../src/delivery-attempt.mjs',import.meta.url).href)};
      const j=await openDirectRequest(${JSON.stringify(f.state)},${JSON.stringify(f.descriptor)},${JSON.stringify(f.expected)});
      await j.record('SEND_INTENT',{targetUrl:${JSON.stringify(url)}});
      await j.record('ERROR',{deliveryStage:'SEND_ATTEMPTED',nativeBody:${JSON.stringify(f.body)},
        nativeWitness:{postSend:{phase:'POST_SEND_CONFIRMATION',lastUserId:'22222222-2222-4222-8222-222222222222'}}});`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');
    const dir=path.join(f.state,'direct-requests',f.request.requestId);
    assert.equal(sha(await fs.readFile(path.join(dir,'manifest.json'))),f.descriptor.expectedHash);
    const saved=JSON.parse(await fs.readFile(path.join(dir,'90-ERROR.json')));
    assert.equal(saved.requestId,f.request.requestId);assert.equal(saved.claimToken,f.request.claimToken);
    assert.equal(saved.data.nativeBody,f.body);assert.equal(saved.data.nativeWitness.postSend.lastUserId,'22222222-2222-4222-8222-222222222222');
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('the actual Send boundary rereads revocation after durable intent for click and Enter',async()=>{
  const trigger=source.slice(source.indexOf('async function triggerSend('),source.indexOf('function nativeWitnessReceipt('));
  for(const click of [true,false]){
    const f=await fixture();try{
      const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected),calls=[];
      const run=new AsyncFunction('j','revoke','page','snapshot',`let sendAttempted=false;
        const COMPOSER_SELECTOR='synthetic',globalThis={};
        const assertDirectRequestCurrent=()=>j.assertCurrent(),assertRecoveryTaskCurrent=()=>{},assertInputTarget=()=>{};
        const state=async()=>snapshot,coordinated=()=>({ok:true,control:{mode:'RUNNING'}});
        const recordDeliveryStage=async(...args)=>{const result=await j.record(...args);await revoke();return result;};
        ${trigger}return triggerSend(page,snapshot.url);`);
      const page={evaluate:async()=>click,click:async()=>calls.push('click'),press:async()=>calls.push('enter')};
      await assert.rejects(()=>run(j,()=>fs.writeFile(f.requestFile+'.revoked','caller ended',{mode:0o600}),page,{url,approvalRequired:false}),
        error=>error.code==='DIRECT_REQUEST_REVOKED'&&error.deliveryStage==='SEND_ATTEMPTED');
      assert.deepEqual(calls,[]);assert.ok(await fs.stat(path.join(j.reference.directory,'40-SEND_INTENT.json')));
    }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('the actual sender retains UID/source after revocation and rejects mismatched or late source',async()=>{
  for(const scenario of ['confirmed','body-mismatch','outside-window']){
  const accepted=scenario==='confirmed',correctSource=scenario!=='body-mismatch';
  const f=await fixture();try{
    const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected);
    const old='33333333-3333-4333-8333-333333333333',uid='22222222-2222-4222-8222-222222222222';
    const before={url,observedAt:new Date().toISOString(),lastUserId:old,userMessageIds:[old],
      lastUserSourceCondition:'BOUND_SOURCE',lastUserSource:{messageId:old,conversationId:cid,text:'prior source'},
      inputReady:true,composerCount:1,composerPresent:true,composerRawText:'',composerText:'',composerAttachmentsEmpty:true,generating:false,approvalRequired:false};
    const after={...before,lastUserId:uid,userMessageIds:[old,uid],messageCount:2,
      lastUserSource:{messageId:uid,conversationId:cid,text:correctSource?f.body:f.body+'wrong'},observedAt:new Date().toISOString()};
    const witness={format:'chatgpt-native-getText-v1',body:f.body,url,accountIdentity:'login',
      requestHash:sha(f.body.replace(/\s+/g,' ').trim()),bodyHash:sha(f.body),getterSource:'synthetic admitted getter',serializerSource:'synthetic admitted serializer',observedAt:before.observedAt};
    const calls=[];
    const page={label:'synthetic',fill:async()=>calls.push('fill'),evaluate:async()=>true,waitForTimeout:async()=>{},
      click:async()=>{calls.push('send');await fs.writeFile(f.requestFile+'.revoked','caller ended',{mode:0o600});}};
    const prefix=source.split('const cmd=args[0] || "help";')[0];
    const run=new AsyncFunction('f',prefix+`
      const reg={accounts:{a:{identity:'login'}},chats:{[f.cid]:{id:f.cid,project:'P',account:'a',url:f.url,status:'active'}}};
      directRequestJournal=f.journal;state=async()=>structuredClone(f.before);
      assertImagePageFree=async()=>{};detectWebRateLimit=async()=>{};assertInputSafe=async()=> 'login';
      nativeSubmissionWitness=async(_p,_m,_i,capabilityOnly)=>{if(capabilityOnly)return {supported:true};f.witness.observedAt=new Date().toISOString();return f.witness;};
      waitForDelivery=async(_p,before,_t,observation)=>{f.after.observedAt=new Date(f.outsideWindow?before.directObservationWindow.deadlineAt+1:Date.now()).toISOString();observation.latest=f.after;return f.after;};
      return sendMessage(f.page,f.body,f.url,'login');`);
    const pending=run({cid,url,journal:j,before,after,witness,page,body:f.body,outsideWindow:scenario==='outside-window'});
    const condition=scenario==='outside-window'?'DIRECT_OBSERVATION_OUTSIDE_WINDOW':'NATIVE_SOURCE_BODY_MISMATCH';
    if(accepted){const delivery=await pending;assert.equal(delivery.lastUserId,uid);assert.equal(delivery.nativeBody,undefined);}
    else await assert.rejects(()=>pending,error=>error.code==='DELIVERY_UNCONFIRMED'&&error.deliveryCondition===condition);
    assert.deepEqual(calls,['fill','send']);
    const saved=JSON.parse(await fs.readFile(path.join(j.reference.directory,accepted?'70-DELIVERY_CONFIRMED.json':'90-ERROR.json'))).data;
    assert.equal(saved.nativeBody,f.body);assert.deepEqual(saved.snapshot.lastUserSource,after.lastUserSource);
    assert.equal(saved.nativeWitness.messageId,accepted?uid:null);assert.equal(saved.nativeWitness.postSend.lastUserId,uid);
    assert.equal(saved.nativeWitness.postSend.phase,'POST_SEND_CONFIRMATION');
    assert.equal(saved.nativeWitness.postSend.missingCondition,accepted?null:condition);
    assert.equal(saved.before.lastUserId,old);
    const input=JSON.parse(await fs.readFile(path.join(j.reference.directory,'30-INPUT_VERIFIED.json'))),
      intent=JSON.parse(await fs.readFile(path.join(j.reference.directory,'40-SEND_INTENT.json'))),
      returned=JSON.parse(await fs.readFile(path.join(j.reference.directory,'50-SEND_RETURNED.json')));
    assert.ok(Date.parse(input.data.nativeWitness.observedAt)<=Date.parse(input.recordedAt));
    assert.ok(Date.parse(input.data.nativeWitness.observedAt)<Date.parse(intent.recordedAt));
    assert.ok(Date.parse(intent.recordedAt)<=returned.data.observationWindow.startedAt);
    assert.deepEqual(saved.nativeWitness.postSend.observationWindow,returned.data.observationWindow);
    assert.equal(returned.data.observationWindow.deadlineAt-returned.data.observationWindow.startedAt,8000);
    assert.ok(Date.parse(saved.nativeWitness.postSend.observedAt)>=returned.data.observationWindow.startedAt);
    if(!accepted){assert.equal(saved.deliveryStage,'SEND_ATTEMPTED');await assert.rejects(()=>fs.stat(path.join(j.reference.directory,'70-DELIVERY_CONFIRMED.json')),{code:'ENOENT'});}
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
  }
});

test('opt-in allocation keeps the existing physical-scope journal under the same request ID',async()=>{
  const f=await fixture();try{
    const j=await evidence.openDirectRequest(f.state,f.descriptor,f.expected),physical=[];
    const allocation=source.slice(source.indexOf('async function recordAllocationStage('),source.indexOf('async function allocateManagedPage('));
    const run=new AsyncFunction('j','rid','physical',`const globalThis={};let pageAllocationRequest=null,directRequestJournal=j;
      const opt=name=>name==='request-id'?rid:null,recordDeliveryStage=(...args)=>j.record(...args);
      const coordinated=(command,data)=>{physical.push({command,...data});return {path:'physical'};};
      ${allocation}return recordAllocationStage('ALLOCATION_INTENT',{allocationOrdinal:1,project:'P',account:'a',profileId:'P1'});`);
    assert.deepEqual(await run(j,f.request.requestId,physical),{path:'physical'});
    assert.equal(physical[0].command,'page-allocation-record');assert.equal(physical[0].requestId,f.request.requestId);
    const stage=JSON.parse(await fs.readFile(path.join(j.reference.directory,'01-ALLOCATION_INTENT-001.json')));
    assert.equal(stage.requestId,f.request.requestId);assert.equal(stage.data.allocationOrdinal,1);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});
