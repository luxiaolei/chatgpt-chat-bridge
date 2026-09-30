import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {normalizeImageBatch} from '../src/capabilities/image/batch.js';
import {fixture} from './image-persistence-fixtures.mjs';

function create(f,records,budget={},batchId='batch-1') {
  const batch=normalizeImageBatch({batchId,createdAt:new Date(Date.now()-1000).toISOString(),
    budget:{maxAttempts:records.length*2,maxItemAttempts:2,maxGenerationCalls:records.length*2,
      maxDurationMs:600000,deadlineAt:records[0].r.budget.deadlineAt,allowPaidApi:false,...budget},
    items:records.map((s,i)=>({itemId:`item-${i}`,jobId:s.r.jobId,requestDigest:s.r.requestDigest,consumerRef:'consumer-1'}))});
  const payload={issuerRef:f.owner,batch,keys:records.map(s=>s.key)};
  return {batch,payload,saved:f.call('image-batch-create',payload)};
}
const read=(f,command='decision')=>f.call('image-batch-'+command,{batchId:'batch-1',issuerRef:f.owner});
function startEvent(job,id='attempt-1') {
  return {type:'beginAttempt',eventId:'begin-'+id,expectedRevision:job.revision,attemptId:id,
    baselineTurnIds:['old-user','old-assistant'],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}};
}
function complete(f,s,i,exported=true) {
  let job=f.begin(s.key,s.job,`attempt-${i}`);
  job=f.api.record(s.key,{eventId:`generated-${i}`,expectedRevision:job.revision,attemptId:`attempt-${i}`,route:job.route,
    status:'GENERATED',userMessageId:`new-user-${i}`,turnId:`new-assistant-${i}`,candidateOutputIds:[`output-${i}`],evidenceRef:'artifact:fixture:generated'});
  if(exported)job=f.api.export(s.key,{eventId:`exported-${i}`,expectedRevision:job.revision,attemptId:`attempt-${i}`,route:job.route,
    outputs:[f.output(job,`output-${i}`,{turnId:`new-assistant-${i}`,sha256:String(i).repeat(64)})],evidenceRef:'artifact:fixture:original'});
  return job;
}

test('batch create authenticates exact owner/scope/job/digest and preserves immutable linkage across restart',async()=>{
  const f=await fixture();try {
    const a=f.setup(),r=f.request({jobId:'image-2'}),b=f.setup(r,f.grant(r,'grant-2'));
    const {batch,payload,saved}=create(f,[a,b]);assert.equal(saved.revision,1);assert.equal(saved.idempotent,false);
    assert.equal(f.call('image-batch-create',payload).idempotent,true);
    assert.deepEqual(read(f,'inspect').batch,batch);assert.equal(f.sql('select count(*) from image_batch_items')[0][0],2);
    const changed={...batch,batchDigest:undefined,budget:{...batch.budget,maxAttempts:99}};
    f.fail('image-batch-create',{...payload,batch:changed},/IMAGE_BATCH_CONFLICT/);
    f.fail('image-batch-create',{...payload,issuerRef:'other'},/IMAGE_GRANT_OWNER_REQUIRED/);
    f.fail('image-batch-inspect',{batchId:'batch-1',issuerRef:'other'},/IMAGE_BATCH_ACCESS_DENIED/);
    f.fail('image-batch-inspect',{batchId:'batch-1',issuerRef:f.owner},/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
    assert.throws(()=>normalizeImageBatch({...batch,batchDigest:undefined,items:[]}),/ITEM_COUNT/);
  }finally{await f.close();}
});

test('a job cannot change batch/budget, cross scope, or masquerade as another immutable request',async()=>{
  const f=await fixture();try {
    const a=f.setup();const first=create(f,[a]);
    assert.throws(()=>create(f,[a],{},'other-batch'),/IMAGE_BATCH_JOB_ALREADY_LINKED/);
    const {batchDigest,...body}=first.batch;
    f.fail('image-batch-create',{...first.payload,batch:{...body,batchId:'bad-digest',items:[{...body.items[0],requestDigest:'a'.repeat(64)}]}},/IMAGE_BATCH_JOB_BINDING/);
    const r=f.request({jobId:'other-scope',scope:{...a.r.scope,tenantId:'t2'}}),b=f.setup(r,f.grant(r,'other-grant'));
    assert.throws(()=>create(f,[a,b],{},'cross-scope'),/IMAGE_BATCH_SCOPE_MISMATCH/);
    assert.equal(f.sql('select count(*) from image_batches')[0][0],1);
  }finally{await f.close();}
});

test('ordinary beginAttempt cannot bypass batch totals; reservations and job CAS commit or roll back together',async()=>{
  const f=await fixture();try {
    const a=f.setup(),r=f.request({jobId:'image-2'}),b=f.setup(r,f.grant(r,'grant-2'));
    create(f,[a,b],{maxGenerationCalls:1});
    const event=startEvent(a.job),key=a.key;
    f.fail('image-apply',{...key,event:{...event,modelSelection:{...event.modelSelection,model:'Other'}}},/MODEL_SELECTION_MISMATCH/);
    assert.equal(read(f).revision,1);assert.equal(read(f).budgetUsage.attempts,0);
    const reserved=f.call('image-apply',{...key,event,expectedBatchRevision:1});assert.equal(reserved.effectAdmission,'NEWLY_RESERVED');
    assert.equal(read(f).revision,2);assert.equal(read(f).budgetUsage.generationCallReservations,1);
    assert.equal(f.call('image-apply',{...key,event,expectedBatchRevision:1}).effectAdmission,'RECONCILE_ONLY');
    assert.equal(read(f).revision,2);
    f.fail('image-apply',{...b.key,event:startEvent(b.job,'attempt-2')},/IMAGE_BATCH_GENERATION_CALL_BUDGET/);
    assert.equal(f.api.inspect(b.key).attempts.length,0);assert.equal(read(f).revision,2);
    assert.equal(read(f).decision.items[0].action,'RECONCILE_EXISTING');
  }finally{await f.close();}
});

test('concurrent ordinary starts on independent sessions consume exactly one remaining batch slot',async()=>{
  const f=await fixture();try {
    const a=f.setup(),base=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),next=structuredClone(base);
    next.chats.w2={id:'w2',project:'P',account:'a',role:'worker2',status:'active'};
    const stored=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{encoding:'utf8',env:f.env,input:JSON.stringify({base,next})});assert.equal(stored.status,0,stored.stderr);
    const op=f.call('submit',{callerRef:f.owner,requestId:'controller-2',taskId:'controller-2',project:'P',sessionRef:'w2',message:'offline only',model:'Latest',effort:'Pro'});
    assert.equal(f.call('work-one',{}).status,'SENT');
    const r=f.request({jobId:'image-2',controllerTaskId:op.taskId,route:{...a.r.route,sessionRef:'w2',conversationId:'w2'}});
    const b=f.setup(r,f.grant(r,'grant-2',{controllerOperationId:op.operationId,controllerTaskId:op.taskId}));
    create(f,[a,b],{maxAttempts:1});
    const results=await Promise.all([a,b].map((s,i)=>f.callAsync('image-apply',{...s.key,event:startEvent(s.job,`attempt-${i}`)})));
    assert.deepEqual(results.map(r=>r.code).sort(),[0,2]);assert.match(results.find(r=>r.code===2).err,/IMAGE_BATCH_ATTEMPT_BUDGET/);
    assert.equal(read(f).budgetUsage.attempts,1);assert.equal(read(f).revision,2);
    assert.equal(f.sql("select count(*) from image_events where json_extract(document,'$.status')='SUBMISSION_UNKNOWN'")[0][0],1);
  }finally{await f.close();}
});

test('stale batch/job revisions and proven pre-send retries preserve every conservative reservation',async()=>{
  const f=await fixture();try {
    const a=f.setup(),r=f.request({jobId:'image-2'}),b=f.setup(r,f.grant(r,'grant-2'));
    create(f,[a,b],{maxItemAttempts:1});let job=f.begin(a.key,a.job);
    job=f.api.record(a.key,{eventId:'not-sent',expectedRevision:job.revision,attemptId:'attempt-1',route:job.route,status:'FAILED_PRE_SEND',beforeSend:true,evidenceRef:'artifact:fixture:pre-send'});
    f.fail('image-apply',{...b.key,event:startEvent(b.job,'second'),expectedBatchRevision:1},/IMAGE_BATCH_REVISION_CONFLICT/);
    f.fail('image-apply',{...a.key,event:startEvent(job,'retry')},/IMAGE_BATCH_ITEM_ATTEMPT_BUDGET/);
    assert.equal(read(f).budgetUsage.generationCallReservations,1);
    const old=startEvent(b.job,'old');old.expectedRevision=999;
    f.fail('image-apply',{...b.key,event:old},/IMAGE_REVISION_CONFLICT/);assert.equal(read(f).revision,2);
    f.begin(b.key,b.job,'second');assert.equal(read(f).budgetUsage.attempts,2);
  }finally{await f.close();}
  const retry=await fixture();try {
    const s=retry.setup();create(retry,[s]);let job=retry.begin(s.key,s.job);
    job=retry.api.record(s.key,{eventId:'pre-send',expectedRevision:job.revision,attemptId:'attempt-1',route:job.route,
      status:'FAILED_PRE_SEND',beforeSend:true,evidenceRef:'artifact:fixture:before-send'});
    assert.equal(read(retry).decision.items[0].action,'RETRY_PRE_SEND');
    retry.begin(s.key,job,'attempt-2');assert.equal(read(retry).budgetUsage.generationCallReservations,2);
    assert.equal(read(retry).decision.items[0].action,'RECONCILE_EXISTING');
  }finally{await retry.close();}
});

test('batch decisions and normal starts obey existing pause/drain/cooldown/manual and physical-session controls',async()=>{
  const f=await fixture();try {
    const s=f.setup();create(f,[s]);
    for(const [control,reason] of [['pause','ADMISSION_PAUSED'],['drain','ADMISSION_DRAINING']]) {
      f.control(control);assert.equal(read(f).decision.items[0].reason,reason);
      f.fail('image-apply',{...s.key,event:startEvent(s.job)},new RegExp(reason));assert.equal(read(f).budgetUsage.attempts,0);
    }
    f.control('resume');await f.cooldown(true);
    assert.equal(read(f).decision.items[0].reason,'WEB_COOLDOWN_ACTIVE');await f.cooldown(false);
    f.putRuntime({tasks:{[f.op.taskId]:{watchdogPausedForUserControl:true}}});
    assert.equal(read(f).decision.items[0].reason,'IMAGE_USER_CONTROL_PAUSED');f.putRuntime({tasks:{}});
    const r=f.request({jobId:'other-image'}),other=f.setup(r,f.grant(r,'other-grant'));f.begin(other.key,other.job,'other-attempt');
    assert.equal(read(f).decision.items[0].reason,'IMAGE_SESSION_BUSY');
    f.fail('image-apply',{...s.key,event:startEvent(s.job)},/IMAGE_SESSION_BUSY/);assert.equal(read(f).revision,1);
  }finally{await f.close();}
});

test('9→7 resumes only missing originals; producer artifacts/caller receipts never become RECEIVED',async()=>{
  const f=await fixture();try {
    const records=Array.from({length:9},(_,i)=>{const r=f.request({jobId:`image-${i}`});return f.setup(r,f.grant(r,`grant-${i}`));});
    create(f,records);
    for(let i=0;i<9;i++)complete(f,records[i],i,i<7);
    const result=read(f);assert.equal(result.receiverEvidence,'RECEIVER_EVIDENCE_UNAVAILABLE');
    assert.equal(result.decision.status,'PARTIAL');assert.equal(result.decision.validatedCount,7);assert.equal(result.decision.missingCount,2);
    assert.equal(result.decision.receivedCount,0);assert.equal(result.decision.businessApproval,'NOT_EVALUATED');
    assert.deepEqual(result.decision.items.slice(0,7).map(i=>i.action),Array(7).fill('RECEIVE_EXISTING'));
    assert.deepEqual(result.decision.items.slice(7).map(i=>i.missingOutputIds),[['output-7'],['output-8']]);
    assert.deepEqual(result.decision.items.slice(7).map(i=>i.action),['EXPORT_EXISTING','EXPORT_EXISTING']);
    f.fail('image-batch-decision',{batchId:'batch-1',issuerRef:f.owner,receipts:[{status:'RECEIVED'}]},/IMAGE_BATCH_PAYLOAD/);
    assert.deepEqual(read(f).decision,result.decision);assert.equal(read(f).budgetUsage.attempts,9);
  }finally{await f.close();}
});

test('revocation/stop/deadline holds keep UNKNOWN and late evidence available without authorizing I/O',async()=>{
  const f=await fixture();try {
    const s=f.setup();create(f,[s]);let job=f.begin(s.key,s.job);
    f.call('image-revoke',{issuerRef:f.owner,grantId:s.g.grantId});
    const unknown=read(f);assert.equal(unknown.decision.items[0].resumeAction,'RECONCILE_EXISTING');assert.equal(unknown.budgetUsage.generationCallReservations,1);
    job=f.generated(s.key,job);job=f.exported(s.key,job);
    assert.equal(job.outputs.length,0);assert.equal(job.lateOutputs.length,1);
    const result=read(f),item=result.decision.items[0];
    assert.equal(item.action,'BLOCKED');assert.equal(item.reason,'IMAGE_GRANT_EXPIRED_OR_REVOKED');
    assert.deepEqual(item.lateOutputIds,['output-1']);assert.equal(result.decision.validatedCount,0);
    assert.equal(read(f,'inspect').jobs[0].lateOutputs.length,1);
    f.fail('image-io-admission',s.key,/IMAGE_GRANT_EXPIRED_OR_REVOKED/);
  }finally{await f.close();}
  const f2=await fixture();try {
    const s=f2.setup();create(f2,[s],{maxDurationMs:1});
    f2.fail('image-apply',{...s.key,event:startEvent(s.job)},/IMAGE_BATCH_DEADLINE/);
    f2.fail('image-io-admission',s.key,/IMAGE_BATCH_DEADLINE/);
    assert.equal(read(f2).decision.items[0].reason,'IMAGE_BATCH_DEADLINE');assert.equal(read(f2).budgetUsage.attempts,0);
  }finally{await f2.close();}
  const stopped=await fixture();try {
    const s=stopped.setup();create(stopped,[s]);const job=stopped.begin(s.key,s.job);
    stopped.api.cancel(s.key,{eventId:'cancel',expectedRevision:job.revision});
    const r=read(stopped);assert.equal(r.decision.items[0].reason,'IMAGE_CANCEL_REQUESTED');
    assert.equal(r.decision.items[0].resumeAction,'RECONCILE_EXISTING');assert.equal(r.budgetUsage.generationCallReservations,1);
  }finally{await stopped.close();}
});

test('real local batch CLI performs query-only reads, rejects fabricated evidence and never starts Ego or creates a missing DB',async()=>{
  const f=await fixture();try {
    const s=f.setup(),batch=normalizeImageBatch({batchId:'batch-1',createdAt:new Date(Date.now()-1000).toISOString(),
      budget:{maxAttempts:2,maxItemAttempts:2,maxGenerationCalls:2,maxDurationMs:600000,deadlineAt:s.r.budget.deadlineAt,allowPaidApi:false},
      items:[{itemId:'item-1',jobId:s.r.jobId,requestDigest:s.r.requestDigest,consumerRef:'consumer-1'}]});
    const cli=(action,payload,env={})=>spawnSync(path.resolve('bin/chat-bridge'),['image','batch',action],{env:{...f.env,...env},encoding:'utf8',input:JSON.stringify(payload)});
    const created=cli('create',{issuerRef:f.owner,batch,keys:[s.key]});assert.equal(created.status,0,created.stderr);
    const paths=[path.join(f.config,'registry.json'),path.join(f.state,'runtime.json')],before=await Promise.all(paths.map(p=>readFile(p,'utf8')));
    for(const action of ['inspect','decision']) {const r=cli(action,{batchId:'batch-1',issuerRef:f.owner});assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).revision,1);}
    assert.deepEqual(await Promise.all(paths.map(p=>readFile(p,'utf8'))),before);
    assert.equal(cli('decision',{batchId:'batch-1',issuerRef:f.owner,admissions:[{allowed:true}]}).status,2);
    const absent=path.join(f.root,'absent-state');assert.equal(cli('inspect',{batchId:'batch-1',issuerRef:f.owner},{CHAT_BRIDGE_STATE_DIR:absent}).status,2);
    await assert.rejects(stat(absent),e=>e.code==='ENOENT');
  }finally{await f.close();}
});
