import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,realpath,readdir,stat,unlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fixture} from './image-persistence-fixtures.mjs';
import {png,fixtureDecode} from './image-artifacts-fixtures.mjs';
import {imageCli,createHostImageArtifacts} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {imageReceiptStorageKey} from '../src/capabilities/image/manifest.js';
import {sha256} from '../src/capabilities/image/verifier.js';
import {normalizeImageBatch} from '../src/capabilities/image/batch.js';

async function original(f,{id='image-1',color=1,exported=true,late=false}={}) {
  const r=f.request({jobId:id}),g=f.grant(r,`grant-${id}`);
  if(late)for(const feature of ['generate','export'])g.capabilities.features[feature].mode='ASSISTED';
  const s=f.setup(r,g);s.job=f.begin(s.key,s.job,`attempt-${id}`);
  if(late)f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});
  s.job=f.generated(s.key,s.job,[`output-${id}`]);
  const recoveryGrant=late?{kind:'OUTPUT_RECOVERY',grantId:`recover-${id}`,controllerOperationId:f.op.operationId,controllerTaskId:f.op.taskId,
    key:s.key,requestDigest:r.requestDigest,attemptId:`attempt-${id}`,route:r.route,userMessageId:'new-user',turnId:'new-assistant',
    evidenceRef:'artifact:fixture:official',expiresAt:new Date(Date.now()+600000).toISOString(),targetRef:r.authorizedOutput.targetRef,
    consumerRef:'consumer-1',destinationRef:'store:receiver-1',maxByteLength:1000000}:null;
  if(late)f.call('image-authorize',{issuerRef:f.owner,grant:recoveryGrant});
  const recovery=late?{recoveryGrantId:recoveryGrant.grantId,requestDigest:r.requestDigest,attemptId:`attempt-${id}`,route:r.route,userMessageId:'new-user',turnId:'new-assistant'}:null;
  const stateDir=await realpath(f.state),io=await createHostImageArtifacts({api:f.api,key:s.key,stateDir,decode:fixtureDecode,coordinated:f.call,recovery});
  const bytes=png({rgba:[color,22,77,255]}),file=path.join(f.root,`${id}.png`);await writeFile(file,bytes,{mode:0o600});
  if(exported){const result=await io.exportOriginal({path:await realpath(file),originalRef:`urn:fixture:${id}`,kind:late?'OFFICIAL_HANDOFF':'NATIVE_ORIGINAL',outputId:`output-${id}`,sha256:sha256(bytes),mimeType:'image/png'});assert.equal(result.ok,true,JSON.stringify(result));}
  const job=f.api.inspect(s.key),output=job.outputs[0]??job.lateOutputs[0];
  return {...s,job,output,io,stateDir,bytes,recovery,recoveryGrant};
}
function delivery(f,s,patch={}) {
  return {kind:'OUTPUT_DELIVERY',grantId:`deliver-${s.r.jobId}`,controllerOperationId:f.op.operationId,controllerTaskId:f.op.taskId,
    key:s.key,requestDigest:s.r.requestDigest,route:s.r.route,
    output:{jobId:s.r.jobId,outputId:s.output.outputId,artifactRef:s.output.artifactRef,sha256:s.output.sha256,
      revisionId:(f.api.result(s.key).outputRevisions[0]??f.api.result(s.key).lateOutputRevisions[0]).revisionId},
    consumerRef:'consumer-1',destinationRef:'store:receiver-1',maxByteLength:1000000,expiresAt:new Date(Date.now()+600000).toISOString(),...patch};
}
const authorize=(f,g)=>f.call('image-authorize',{issuerRef:f.owner,grant:g});
const query=(s,g)=>({...s.key,deliveryGrantId:g.grantId});
const receive=(f,s,g,extra={})=>imageCli('delivery-receive',{key:s.key,deliveryGrantId:g.grantId},{coordinated:f.call,stateDir:s.stateDir,decode:fixtureDecode,...extra});
const historical=(f,s,g)=>f.call('image-delivery-receipt',query(s,g));
function batch(f,records) {
  const b=normalizeImageBatch({batchId:'batch-1',createdAt:new Date(Date.now()-1000).toISOString(),
    budget:{maxAttempts:records.length,maxItemAttempts:2,maxGenerationCalls:records.length,maxDurationMs:600000,deadlineAt:records[0].r.budget.deadlineAt,allowPaidApi:false},
    items:records.map((s,i)=>({itemId:`item-${i}`,jobId:s.r.jobId,requestDigest:s.r.requestDigest,consumerRef:'consumer-1'}))});
  f.call('image-batch-create',{issuerRef:f.owner,batch:b,keys:records.map(s=>s.key)});
  return ()=>f.call('image-batch-decision',{issuerRef:f.owner,batchId:b.batchId});
}

test('delivery fixes actual ordinary revision, original owner/scope/controller and one destination; no generation authority',async()=>{
  const f=await fixture();try {
    const s=await original(f),g=delivery(f,s),before=f.api.inspect(s.key);
    f.fail('image-authorize',{issuerRef:'other',grant:g},/OWNER_REQUIRED/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:g},/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
    f.fail('image-authorize',{issuerRef:f.owner,grant:g},/HOST_OWNER_REQUIRED/,{CHAT_BRIDGE_FROM_ACCOUNT_ID:f.accountId});
    for(const patch of [{requestDigest:'f'.repeat(64)},{controllerTaskId:'other'},{controllerOperationId:'other'},
      {route:{...g.route,conversationId:'other'}},{key:{...g.key,scope:{...g.key.scope,tenantId:'other'}}},
      {output:{...g.output,revisionId:'other'}},{output:{...g.output,sha256:'f'.repeat(64)}},{output:{...g.output,artifactRef:'artifact:other'}}])
      f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,...patch}},/ACCESS_DENIED|DELIVERY_BINDING|OUTPUT_BINDING/);
    assert.equal(authorize(f,g).idempotent,false);assert.equal(authorize(f,g).idempotent,true);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,consumerRef:'other'}},/GRANT_CONFLICT/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,grantId:'different-destination',destinationRef:'store:other'}},/DESTINATION_CONFLICT/);
    const wrong={...s.key,grantId:g.grantId};
    for(const command of ['image-io-admission','image-inspect'])f.fail(command,wrong,/DELIVERY_EFFECT_FORBIDDEN/);
    f.fail('image-submit',{grantId:g.grantId,request:s.r},/DELIVERY_EFFECT_FORBIDDEN/);
    f.fail('image-apply',{...wrong,event:{type:'beginAttempt'}},/DELIVERY_EFFECT_FORBIDDEN/);
    for(const action of ['start','submit','prepare','import-original'])await assert.rejects(imageCli(action,{key:s.key,deliveryGrantId:g.grantId,grantId:s.g.grantId,request:s.r},{coordinated:f.call,liveAction:'start'}),/DELIVERY_EFFECT_FORBIDDEN/);
    await assert.rejects(imageCli('delivery-receive',{key:s.key,deliveryGrantId:g.grantId,receipt:{status:'RECEIVED'}},{coordinated:f.call}),/DELIVERY_PAYLOAD/);
    assert.deepEqual(f.api.inspect(s.key),before);assert.equal(f.sql('select count(*) from image_jobs')[0][0],1);
  }finally{await f.close();}
});

test('new delivery uses its own bounded current authority, original SQLite creation retention ceiling and existing controls',async()=>{
  const f=await fixture();try {
    const s=await original(f),g=delivery(f,s);f.call('image-revoke',{issuerRef:f.owner,grantId:s.g.grantId});
    authorize(f,g);assert.equal(f.call('image-delivery-io-admission',query(s,g)).allowed,true);
    for(const patch of [{expiresAt:new Date(Date.now()-1).toISOString()},{expiresAt:new Date(Date.now()+3601000).toISOString()}])
      f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,grantId:'bad-time',...patch}},/DELIVERY_EXPIRY/);
    f.control('pause');f.fail('image-delivery-io-admission',query(s,g),/ADMISSION_PAUSED/);f.control('resume');
    f.putRuntime({tasks:{[f.op.taskId]:{watchdogPausedForUserControl:true}}});f.fail('image-delivery-io-admission',query(s,g),/USER_CONTROL_PAUSED/);f.putRuntime({tasks:{}});
    await f.cooldown(true);f.fail('image-delivery-io-admission',query(s,g),/WEB_COOLDOWN_ACTIVE/);await f.cooldown(false);
    const created=f.sql("select created_at from image_jobs")[0][0];
    f.sql("update image_jobs set created_at='2020-01-01T00:00:00+00:00'");
    f.fail('image-delivery-io-admission',query(s,g),/RETENTION_DEADLINE/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,grantId:'fresh-aged'}},/RETENTION_DEADLINE/);
    f.sql("update image_jobs set created_at='not-a-trusted-timestamp'");f.fail('image-authorize',{issuerRef:f.owner,grant:{...g,grantId:'bad-origin'}},/RETENTION_TIMESTAMP/);
    f.sql(`update image_jobs set created_at='${created}'`);
    const facts=f.api.inspect(s.key);assert.equal(facts.request.authorizedOutput.retentionHours,24);
    const received=await receive(f,s,g);assert.equal(received.retentionOrigin,created);
    assert.equal(Date.parse(received.retentionDeadline),Date.parse(created)+24*3600000);
    assert.deepEqual(f.api.inspect(s.key),facts);
    f.api.cancel(s.key,{eventId:'cancel-after-output',expectedRevision:facts.revision});
    f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});f.fail('image-delivery-io-admission',query(s,g),/EXPIRED_OR_REVOKED/);
    assert.equal(historical(f,s,g).deliveries[0].receipt.status,'RECEIVED');
  }finally{await f.close();}
});

test('recorded worker result admits only fresh existing-output delivery; receive and ACK remain separate',async()=>{
  const f=await fixture();try {
    const s=await original(f),late=await original(f,{id:'late-before-result',late:true}),pendingRequest=f.request({jobId:'pending-before-result'});
    const pending=f.setup(pendingRequest,f.grant(pendingRequest,'grant-pending'));
    const facts=f.api.inspect(s.key),lateFacts=f.api.inspect(late.key),g=delivery(f,s),receiverBase=path.join(s.stateDir,'image-received');
    const result=f.call('result',{taskId:f.op.taskId,status:'COMPLETE',summary:'offline saved original awaiting controller review'});
    assert.equal(result.resultRecorded,true);assert.equal(result.acceptanceStatus,null);
    assert.deepEqual(f.sql("select status from operations where kind='dispatch'"),[['SENT']]);
    assert.throws(()=>f.api.authorizeIO(s.key),/IMAGE_CONTROLLER_RESULT_RECORDED/);
    assert.throws(()=>f.begin(pending.key,pending.job),/IMAGE_CONTROLLER_RESULT_RECORDED/);
    const later=f.request({jobId:'new-after-result'}),laterGrant=f.grant(later,'grant-after-result');f.authorize(laterGrant);
    f.fail('image-submit',{grantId:laterGrant.grantId,request:later},/IMAGE_CONTROLLER_RESULT_RECORDED/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...late.recoveryGrant,grantId:'recovery-after-result'}},/IMAGE_CONTROLLER_RESULT_RECORDED/);
    assert.throws(()=>f.api.authorizeRecovery(late.key,late.recovery,'receive',{consumerRef:'consumer-1',destinationRef:'store:receiver-1'}),/IMAGE_CONTROLLER_RESULT_RECORDED/);
    await assert.rejects(stat(receiverBase),e=>e.code==='ENOENT');
    authorize(f,g);assert.equal(f.call('image-delivery-io-admission',query(s,g)).allowed,true);
    f.control('pause');await assert.rejects(receive(f,s,g),/ADMISSION_PAUSED/);await assert.rejects(stat(receiverBase),e=>e.code==='ENOENT');f.control('resume');
    f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});await assert.rejects(receive(f,s,g),/EXPIRED_OR_REVOKED/);await assert.rejects(stat(receiverBase),e=>e.code==='ENOENT');
    const fresh=delivery(f,s,{grantId:'delivery-after-result'});authorize(f,fresh);
    const received=await receive(f,s,fresh),observed=historical(f,s,fresh).deliveries[0];
    assert.equal(received.receipt.status,'RECEIVED');assert.equal(received.businessApproval,'NOT_EVALUATED');
    assert.deepEqual(observed.receipt,received.receipt);assert.equal(observed.copyHealth,'VERIFIED');
    assert.deepEqual(f.api.inspect(s.key),facts);assert.deepEqual(f.api.inspect(late.key),lateFacts);
    assert.deepEqual(f.sql('select acceptance_status from task_results'),[[null]]);
    const unused=delivery(f,s,{grantId:'delivery-not-received',consumerRef:'consumer-never',destinationRef:'store:never'});authorize(f,unused);
    assert.equal(historical(f,s,unused).deliveries[0].receipt,null);
    f.call('ack',{taskId:f.op.taskId,resultVersion:'1',callerRef:f.owner,status:'ACCEPTED',message:'offline explicit controller review'});
    assert.equal(historical(f,s,unused).deliveries[0].receipt,null);
    assert.deepEqual(f.api.inspect(late.key),lateFacts);assert.equal(f.api.result(s.key).businessApproval,'NOT_EVALUATED');
  }finally{await f.close();}
});

test('receive rechecks async revocation; concurrent retry converges on immutable consumer bytes and receipt',async()=>{
  const f=await fixture();try {
    const s=await original(f),g=delivery(f,s);authorize(f,g);let revoked=false;
    await assert.rejects(receive(f,s,g,{decode:async(bytes,options)=>{
      const decoded=await fixtureDecode(bytes,options);if(!revoked){revoked=true;f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});}return decoded;
    }}),/EXPIRED_OR_REVOKED/);
    const root=path.join(s.stateDir,'image-received',sha256(g.destinationRef));assert.deepEqual(await readdir(root),[]);
    const fresh=delivery(f,s,{grantId:'renewed-delivery'});authorize(f,fresh);
    const results=await Promise.all([receive(f,s,fresh),receive(f,s,fresh)]);
    assert.deepEqual(results[0].receipt,results[1].receipt);assert.equal(results[0].businessApproval,'NOT_EVALUATED');
    const saved=historical(f,s,fresh).deliveries[0];assert.equal(saved.copyHealth,'VERIFIED');
    f.control('pause');assert.deepEqual(historical(f,s,fresh).deliveries[0].receipt,saved.receipt);f.control('resume');
    f.call('image-revoke',{issuerRef:f.owner,grantId:fresh.grantId});assert.deepEqual(historical(f,s,fresh).deliveries[0].receipt,saved.receipt);
    assert.equal(f.sql('select count(*) from task_results')[0][0],0);
  }finally{await f.close();}
});

test('concurrent owner grants cannot race into two destinations; expiry blocks receive but history is queryable',async()=>{
  const f=await fixture();try {
    const s=await original(f),a=delivery(f,s,{grantId:'race-a'}),b={...a,grantId:'race-b',destinationRef:'store:other'};
    const outcomes=await Promise.all([a,b].map(grant=>f.callAsync('image-authorize',{issuerRef:f.owner,grant})));
    assert.deepEqual(outcomes.map(r=>r.code).sort(),[0,2]);assert.match(outcomes.find(r=>r.code===2).err,/DESTINATION_CONFLICT/);
    const winner=[a,b][outcomes.findIndex(r=>r.code===0)],short={...winner,grantId:'short-delivery',expiresAt:new Date(Date.now()+1800).toISOString()};
    authorize(f,short);await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(short.expiresAt)-Date.now()+20)));
    f.fail('image-delivery-io-admission',query(s,short),/EXPIRED_OR_REVOKED/);
    assert.equal(historical(f,s,short).deliveries[0].reason,'RECEIVER_STORE_MISSING');
    const before=f.api.inspect(s.key);
    f.sql(`update image_jobs set document=json_set(document,'$.cancelRequestedAt','${new Date().toISOString()}')`);
    f.fail('image-delivery-io-admission',query(s,winner),/CANCEL_REQUESTED/);
    assert.equal(f.api.inspect(s.key).attempts.length,before.attempts.length);
  }finally{await f.close();}
});

test('historical reader is authenticated and observes missing/corrupt copy without fetch, repair, or fake receipt',async()=>{
  const f=await fixture();try {
    const s=await original(f),g=delivery(f,s);authorize(f,g);
    const receiverBase=path.join(s.stateDir,'image-received');
    const missing=historical(f,s,g);assert.equal(missing.deliveries[0].reason,'RECEIVER_STORE_MISSING');await assert.rejects(stat(receiverBase),e=>e.code==='ENOENT');
    f.fail('image-delivery-receipt',query(s,g),/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
    f.fail('image-delivery-receipt',{...query(s,g),receipt:{status:'RECEIVED'}},/IMAGE_SCHEMA/);
    const received=await receive(f,s,g),root=path.join(receiverBase,sha256(g.destinationRef));
    const key=imageReceiptStorageKey(received.receipt),copy=path.join(root,`received-${key}.bin`),receiptPath=path.join(root,`receipt-${key}.json`);
    await unlink(copy);const lost=historical(f,s,g).deliveries[0];assert.equal(lost.copyHealth,'MISSING');assert.deepEqual(lost.receipt,received.receipt);await assert.rejects(stat(copy),e=>e.code==='ENOENT');
    await writeFile(copy,Buffer.from('corrupt'),{mode:0o600});assert.equal(historical(f,s,g).deliveries[0].copyHealth,'CORRUPT');assert.equal((await readFile(copy)).toString(),'corrupt');
    await writeFile(receiptPath,JSON.stringify({...received.receipt,consumerRef:'other'}),{mode:0o600});const foreign=historical(f,s,g).deliveries[0];assert.equal(foreign.receipt,null);assert.equal(foreign.reason,'RECEIPT_BINDING');
    const absent=path.join(f.root,'missing-state'),cli=spawnSync(path.resolve('bin/chat-bridge'),['image','delivery','receipt'],{env:{...f.env,CHAT_BRIDGE_STATE_DIR:absent},input:JSON.stringify({key:s.key,deliveryGrantId:g.grantId}),encoding:'utf8'});
    assert.equal(cli.status,2);await assert.rejects(stat(absent),e=>e.code==='ENOENT');
  }finally{await f.close();}
});

test('nine exact jobs with seven actual ordinary receiver receipts stay PARTIAL and resume only two missing originals',async()=>{
  const f=await fixture();try {
    const records=[];for(let i=0;i<9;i++)records.push(await original(f,{id:`image-${i}`,color:i+1,exported:i<7}));
    const read=batch(f,records);
    for(const s of records.slice(0,7)){const g=delivery(f,s);authorize(f,g);await receive(f,s,g);}
    const result=read();assert.equal(result.receiverEvidence,'RECEIVER_EVIDENCE_AVAILABLE');assert.equal(result.decision.status,'PARTIAL');
    assert.equal(result.decision.validatedCount,7);assert.equal(result.decision.receivedCount,7);assert.equal(result.decision.lateReceivedCount,0);
    assert.deepEqual(result.decision.items.slice(0,7).map(i=>i.action),Array(7).fill('AWAIT_CONTROLLER_ACK'));
    assert.deepEqual(result.decision.items.slice(7).map(i=>i.action),['EXPORT_EXISTING','EXPORT_EXISTING']);
    assert.deepEqual(result.budgetUsage,{attempts:9,generationCallReservations:9});assert.deepEqual(read(),result);
  }finally{await f.close();}
});

test('one shared reader records existing recovery late receipts separately from ordinary delivery and preserves generation holds',async()=>{
  const f=await fixture();try {
    const late=await original(f,{id:'late',late:true}),ordinary=await original(f,{id:'ordinary',color:88}),g=delivery(f,ordinary);
    const read=batch(f,[late,ordinary]);
    f.fail('image-authorize',{issuerRef:f.owner,grant:delivery(f,late)},/OUTPUT_NOT_VERIFIED/);
    const binding={outputId:late.output.outputId,artifactRef:late.output.artifactRef,sha256:late.output.sha256,consumerRef:'consumer-1',destinationRef:'store:receiver-1'};
    await late.io.receiveExisting(binding);authorize(f,g);
    // Fresh output-only rights work with the old generation grant revoked.
    f.call('image-revoke',{issuerRef:f.owner,grantId:ordinary.g.grantId});
    assert.equal(read().decision.items[1].action,'RECEIVE_EXISTING');await receive(f,ordinary,g);
    const result=read();assert.equal(result.decision.status,'PARTIAL');assert.equal(result.decision.validatedCount,1);assert.equal(result.decision.lateValidatedCount,1);
    assert.equal(result.decision.receivedCount,1);assert.equal(result.decision.lateReceivedCount,1);assert.equal(result.decision.businessApproval,'NOT_EVALUATED');
    assert.equal(result.decision.items[0].action,'BLOCKED');assert.equal(result.decision.items[0].resumeAction,'REVIEW_LATE_OUTPUT');assert.deepEqual(result.decision.items[0].missingOutputIds,[]);
    assert.equal(result.decision.items[0].lateDeliveryStatus,'RECEIVED');assert.equal(f.api.inspect(late.key).outputs.length,0);assert.equal(f.api.inspect(late.key).lateOutputs.length,1);
    assert.deepEqual(result.budgetUsage,{attempts:2,generationCallReservations:2});
  }finally{await f.close();}
});
