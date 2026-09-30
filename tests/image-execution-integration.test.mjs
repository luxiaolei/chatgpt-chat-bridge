import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {createEgoImageUi} from '../src/capabilities/image/chatgpt-ego.ui.js';
import {imageCli} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {createImageExecutionAdapter} from '../src/capabilities/image/chatgpt-ego.js';
import {fixture} from './image-persistence-fixtures.mjs';
import {snapshot,generated,selection} from './image-execution-fixtures.mjs';

function fakeUi(f,r) {
  const state={sends:0,fill:'',sent:false,inside:false,released:0};
  const ui={inspect:async()=>state.sent?generated(r,'sqlite-attempt'):snapshot(r,{composerText:state.fill}),
    selectResources:async()=>selection,fill:async value=>{state.fill=value;},
    sendOnce:async()=>{state.sends++;state.sent=true;}};
  const ports={api:f.api,withUi:async(route,fn)=>{assert.deepEqual(route,r.route);assert.equal(state.inside,false);state.inside=true;try{return await fn(ui);}finally{state.inside=false;state.released++;}},
    // SYNTHETIC ADMISSION ONLY. Production requires the missing durable cross-job guard.
    assertSessionAdmission:async()=>{},evidenceSink:async()=> 'artifact:fixture:offline-observation'};
  return {ports,ui,state};
}

test('native send primitive uses one documented page.click and never Enter fallback',async()=>{
  let clicks=0,presses=0,checks=0;
  const page={fill:async()=>{},click:async()=>{clicks++;throw new Error('timeout');},press:async()=>{presses++;}};
  const ui=createEgoImageUi({page,inspectNative:async()=>({sendAvailable:true,generating:false}),assertOwnedRoute:async()=>{checks++;},selectResources:async()=>selection});
  await assert.rejects(ui.sendOnce(),/timeout/);assert.equal(clicks,1);assert.equal(presses,0);assert.equal(checks,1);
});
test('native primitives require a verified observer and enforce ownership before side effects',async()=>{
  const page={fill:async()=>assert.fail('must not fill'),click:async()=>assert.fail('must not click')};
  assert.throws(()=>createEgoImageUi({page}),/OBSERVER_UNVERIFIED/);
  const ui=createEgoImageUi({page,inspectNative:async()=>assert.fail('must not inspect'),assertOwnedRoute:async()=>{throw new Error('USER_CONTROL');},selectResources:async()=>selection});
  await assert.rejects(ui.sendOnce(),/USER_CONTROL/);await assert.rejects(ui.fill('fixture'),/USER_CONTROL/);
});
test('native upload is accepted only after existing upload and native readiness agree',async()=>{
  let uploaded=0;
  const page={fill:async()=>{},click:async()=>{}};
  let accepted=false;
  const ui=createEgoImageUi({page,assertOwnedRoute:async()=>{},selectResources:async()=>selection,
    uploadImage:async()=>{uploaded++;},inspectNative:async()=>({inputReady:true,generating:false,attachments:[{accepted}]})});
  assert.equal((await ui.upload({path:'/synthetic-only',mimeType:'image/png'})).accepted,false);
  accepted=true;assert.equal((await ui.upload({path:'/synthetic-only',mimeType:'image/png'})).accepted,true);assert.equal(uploaded,2);
});
test('public image start/reconcile are closed before coordinator or browser calls',async()=>{
  for(const action of ['start','reconcile']) {
    const result=await imageCli(action,{authorized:true},{coordinated:()=>assert.fail('must not invoke')});
    assert.equal(result.status,'BLOCKED');assert.equal(result.deliveryStage,'PRE_SEND');assert.equal(result.retryAllowed,false);
  }
});
test('SQLite real contract accepts adapter-generated events and reconstructed reconcile never sends twice',async()=>{
  const f=await fixture();try {
    const {r,g,key}=f.setup();const {ports,state,ui}=fakeUi(f,r);
    const start=createImageExecutionAdapter(ports);
    const result=await start.start(r,{grantId:g.grantId,attemptId:'sqlite-attempt',eventId:'sqlite-begin'});
    assert.equal(result.status,'GENERATED');assert.equal(state.sends,1);assert.equal(state.inside,false);
    const saved=f.api.inspect(key);assert.equal(saved.attempts[0].turnId,'new-assistant');assert.equal(saved.outputs.length,0);
    const reconstructed=createImageExecutionAdapter(ports);
    assert.equal((await reconstructed.start(r,{grantId:g.grantId,attemptId:'different',eventId:'different'})).action,'RECONCILE_ONLY');
    assert.equal((await reconstructed.reconcile(key)).status,'GENERATED');assert.equal(state.sends,1);
    assert.equal(f.sql('select count(*) from task_results')[0][0],0);
    assert.equal(f.sql('select count(*) from image_events')[0][0],3);
  }finally{await f.close();}
});
test('SQLite lost begin response survives restart and UNKNOWN never becomes an automatic resend',async()=>{
  const f=await fixture();try {
    const {r,g,key}=f.setup();const {ports,state}=fakeUi(f,r),begin=f.api.beginAttempt;
    ports.api={...f.api,beginAttempt:(...args)=>{begin(...args);throw new Error('LOST_ACK');}};
    await assert.rejects(createImageExecutionAdapter(ports).start(r,{grantId:g.grantId,attemptId:'sqlite-attempt',eventId:'sqlite-begin'}),/LOST_ACK/);
    assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');assert.equal(state.sends,0);
    ports.api=f.api;
    assert.equal((await createImageExecutionAdapter(ports).start(r,{grantId:g.grantId,attemptId:'other',eventId:'other'})).action,'RECONCILE_ONLY');
    assert.equal(state.sends,0);assert.equal(f.sql('select count(*) from image_events')[0][0],1);
  }finally{await f.close();}
});
test('local CLI submit/inspect/result/cancel uses granted ImageJob state but never controller result or Ego',async()=>{
  const f=await fixture();try {
    const r=f.request(),g=f.grant(r);f.authorize(g);
    const call=(action,payload)=>{
      const result=spawnSync(path.resolve('bin/chat-bridge'),['image',action],{env:f.env,encoding:'utf8',input:JSON.stringify(payload)});
      assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout);
    };
    const job=call('submit',{request:r,grantId:g.grantId});assert.equal(job.status,'SUBMITTED');
    const key={grantId:g.grantId,callerRef:r.caller.ref,jobId:r.jobId,scope:r.scope};
    assert.equal(call('inspect',key).requestDigest,r.requestDigest);assert.equal(call('result',key).businessApproval,'NOT_EVALUATED');
    const cancel=call('cancel',{key,event:{eventId:'cancel-cli',expectedRevision:job.revision,reason:'offline test'}});assert.equal(cancel.status,'CANCELLED');
    assert.equal(f.sql('select count(*) from task_results')[0][0],0);assert.equal(f.sql('select count(*) from operations')[0][0],1);
  }finally{await f.close();}
});
test('runtime image facade uses JSON stdin, preserves #58 probe and reports blocked live execution',async()=>{
  const f=await fixture();try {
    const runtime=createRuntime({bin:path.resolve('bin/chat-bridge'),env:f.env});
    const probe=await runtime.image.probe();assert.equal(probe.ok,true);assert.equal(probe.data.nativeReady,false);
    assert.equal((await runtime.probe({capability:'imageParts'})).supported,true);
    const r=f.request();assert.equal((await runtime.image.validate({request:r})).data.requestDigest,r.requestDigest);
    const blocked=await runtime.image.start({request:r,grantId:'no-grant'});
    assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'IMAGE_EXECUTION_INTEGRATION_REQUIRED');assert.equal(blocked.error.sendAttempted,false);
  }finally{await f.close();}
});
test('ungranted CLI submissions reject and do not leak prompts in stderr',async()=>{
  const f=await fixture();try {
    const secret='SYNTHETIC_PRIVATE_PROMPT_MUST_NOT_LEAK';
    const result=spawnSync(path.resolve('bin/chat-bridge'),['image','submit'],{env:f.env,encoding:'utf8',input:JSON.stringify({request:f.request({prompt:secret}),grantId:'missing'})});
    assert.equal(result.status,2);assert.doesNotMatch(result.stderr,new RegExp(secret));assert.equal(JSON.parse(result.stderr).code,'IMAGE_ACCESS_DENIED');
    assert.equal(f.sql('select count(*) from image_jobs')[0][0],0);
  }finally{await f.close();}
});
test('install source packages ESM image module directory; it is not run or used to enable native automation',async()=>{
  const script=await readFile(new URL('../scripts/install.sh',import.meta.url),'utf8');
  assert.match(script,/capabilities\/image\/package.json/);assert.match(script,/cp -R .*src\/capabilities\/image/);
  const cli=await readFile(new URL('../src/capabilities/image/chatgpt-ego.cli.js',import.meta.url),'utf8');
  assert.doesNotMatch(cli,/taskSpace\(|page\.fetch\(|image-authorize/);
});
