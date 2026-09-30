import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageRequest,classifyImageCapabilities,initialImageJob,applyImageEvent,imageJobKey} from '../src/capabilities/image/contract.js';
import {normalizeImageBatch,imageBatchDecision} from '../src/capabilities/image/batch.js';

const at='2026-09-30T10:00:00Z',createdAt='2026-09-30T09:59:00Z',deadlineAt='2026-09-30T11:00:00Z';
const copy = value=>JSON.parse(JSON.stringify(value));
function fixture(n=1, budget={}) {
  const grants=Array.from({length:n},(_,i)=>{
    const request=normalizeImageRequest({jobId:`image-${i}`,operation:'generate',caller:{kind:'chat',ref:'worker'},
      scope:{tenantId:'t1',namespace:'design',purpose:'offline-test',workgroupId:null},controllerTaskId:'task-1',
      route:{project:'P',projectId:'g-p-test',accountAlias:'a',accountId:'a'.repeat(64),sessionRef:`worker-${i}`,conversationId:`worker-${i}`},
      prompt:`synthetic square ${i}`,budget:{maxAttempts:3,maxOutputs:1,maxDurationMs:3600000,deadlineAt,allowPaidApi:false},
      authorizedOutput:{targetRef:'store:t1',retentionHours:24},requestedModel:'Latest',requestedEffort:'Pro'});
    const capabilities=classifyImageCapabilities(request.route,{version:'offline-fixture/v1',observedAt:createdAt,
      modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true},
      features:{generate:{mode:'ASSISTED',evidence:['artifact:fixture:probe']},export:{mode:'ASSISTED',evidence:['artifact:fixture:save']}}});
    return {grantId:`grant-${i}`,controllerTaskId:'task-1',controllerOperationId:'controller-op',request,capabilities,
      expiresAt:deadlineAt,sourceExternalizationAuthorized:false};
  });
  const jobs=grants.map(g=>initialImageJob(g,createdAt));
  const batch=normalizeImageBatch({batchId:'batch-1',createdAt,
    budget:{maxAttempts:n*3,maxItemAttempts:3,maxGenerationCalls:n*3,maxDurationMs:3600000,deadlineAt,allowPaidApi:false,...budget},
    items:jobs.map((j,i)=>({itemId:`item-${i}`,jobId:j.jobId,requestDigest:j.requestDigest,consumerRef:'consumer-1'}))});
  const event=(i,event)=>jobs[i]=applyImageEvent(jobs[i],{eventId:`event-${i}-${jobs[i].revision}`,expectedRevision:jobs[i].revision,...event},grants[i],{at});
  const begin=(i=0)=>event(i,{type:'beginAttempt',attemptId:`attempt-${i}-${jobs[i].attempts.length+1}`,baselineTurnIds:['old-turn'],
    modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}});
  const observe=(i,status,patch={})=>event(i,{type:'observation',attemptId:jobs[i].attempts.at(-1).attemptId,route:jobs[i].route,
    status,evidenceRef:'artifact:fixture:observation',...patch});
  const generated=(i=0)=>observe(i,'GENERATED',{userMessageId:`user-${i}`,turnId:`turn-${i}`,candidateOutputIds:[`output-${i}`]});
  const exported=(i=0,status='VERIFIED')=>event(i,{type:'export',attemptId:jobs[i].attempts.at(-1).attemptId,
    route:jobs[i].route,evidenceRef:'artifact:fixture:export',outputs:[{outputId:`output-${i}`,jobId:jobs[i].jobId,
      attemptId:jobs[i].attempts.at(-1).attemptId,turnId:`turn-${i}`,artifactRef:`artifact:fixture:output-${i}`,
      sha256:String(i%10).repeat(64),mimeType:'image/png',byteLength:123,width:16,height:16,sourceHashes:[],parentOutputId:null,baseRevisionId:null,
      capabilityVersion:grants[i].capabilities.version,capabilityObservedAt:createdAt,warnings:[],
      validation:{status,verifierVersion:'synthetic-test-only/v1',checkedAt:at,checks:{magic:true,mime:true,decode:true,hash:true,count:true}}}]});
  const receive=(i=0)=>({schemaVersion:'chatbridge.image.receipt.v1',receiptId:`receipt-${i}`,consumerRef:'consumer-1',
    jobId:jobs[i].jobId,requestDigest:jobs[i].requestDigest,outputId:jobs[i].outputs[0].outputId,
    artifactRef:jobs[i].outputs[0].artifactRef,sha256:jobs[i].outputs[0].sha256,receivedAt:at,status:'RECEIVED',reason:null});
  const admissions=()=>jobs.map(j=>({key:imageJobKey(j.request,j.grantId),requestDigest:j.requestDigest,
    allowed:true,expiresAt:deadlineAt,reason:null,quotaRemaining:null}));
  const decide=(patch={})=>imageBatchDecision(batch,{jobs,receipts:[],admissions:admissions(),at,...patch});
  return {batch,jobs,begin,observe,generated,exported,receive,admissions,decide};
}

test('restart resumes each boundary with the exact job/attempt/turn; UNKNOWN never creates another attempt',()=>{
  const f=fixture();
  const proposal=f.decide();assert.equal(proposal.items[0].action,'CONTINUE_EXISTING');
  assert.deepEqual(f.decide(),proposal);assert.equal(f.jobs[0].attempts.length,0);
  f.begin();
  assert.equal(f.decide().items[0].action,'RECONCILE_EXISTING');
  const unknown=f.decide();assert.equal(unknown.budgetUsage.generationCallReservations,1);
  const restarted=imageBatchDecision(copy(f.batch),{jobs:copy(f.jobs),receipts:[],admissions:copy(f.admissions()),at});
  assert.deepEqual(restarted,unknown);assert.equal(restarted.items[0].attemptId,'attempt-0-1');
  f.observe(0,'GENERATING',{userMessageId:'user-0'});assert.equal(f.decide().items[0].action,'OBSERVE_EXISTING');
  f.generated();assert.equal(f.decide().items[0].action,'EXPORT_EXISTING');
  assert.deepEqual(f.decide().items[0].missingOutputIds,['output-0']);
  f.exported(0,'UNVERIFIED');assert.equal(f.decide().items[0].action,'VALIDATE_EXISTING');
  f.exported();assert.equal(f.decide().items[0].action,'RECEIVE_EXISTING');
  const received=f.decide({receipts:[f.receive(),copy(f.receive())]});
  assert.equal(received.items[0].action,'AWAIT_CONTROLLER_ACK');assert.deepEqual(received.items[0].receiptIds,['receipt-0']);
  assert.equal(received.businessApproval,'NOT_EVALUATED');assert.equal(received.receivedCount,1);
  assert.equal(received.recommendationsOnly,true);assert.ok(Object.isFrozen(received.items[0]));
  assert.equal(received.reservationsPersisted,false);
});

test('nine explicit count=1 items with seven originals are PARTIAL regardless of supplied snapshot order',()=>{
  const f=fixture(9);
  for(let i=0;i<9;i++){f.begin(i);f.generated(i);if(i<7)f.exported(i);}
  const before=copy(f.jobs),receipts=Array.from({length:7},(_,i)=>f.receive(i));
  const r=f.decide({jobs:[...f.jobs].reverse(),receipts});
  assert.equal(r.status,'PARTIAL');assert.equal(r.validatedCount,7);assert.equal(r.missingCount,2);assert.equal(r.receivedCount,7);
  assert.deepEqual(r.items.slice(0,7).map(i=>i.action),Array(7).fill('AWAIT_CONTROLLER_ACK'));
  assert.deepEqual(r.items.slice(7).map(i=>i.action),['EXPORT_EXISTING','EXPORT_EXISTING']);
  assert.deepEqual(r.items[7].missingOutputIds,['output-7']);assert.deepEqual(f.jobs,before);
  assert.deepEqual(f.decide({receipts}),r);
});

test('one collage cannot fill unlinked items; repeated original bytes do not certify independent images',()=>{
  const f=fixture(9);f.begin();f.generated();f.exported();
  assert.equal(f.decide().missingCount,8);
  f.begin(1);f.generated(1);f.exported(1);
  f.jobs[1].outputs[0].sha256=f.jobs[0].outputs[0].sha256;
  const r=f.decide();assert.equal(r.uniqueCount,1);assert.equal(r.status,'PARTIAL');
  assert.deepEqual(r.duplicateItemIds,['item-1']);assert.equal(r.items[1].reason,'DUPLICATE_BATCH_OUTPUT');
});

test('only proven FAILED_PRE_SEND can propose a same-job retry and every saved attempt consumes budget',()=>{
  const f=fixture(2,{maxGenerationCalls:2});f.begin();f.observe(0,'FAILED_PRE_SEND',{beforeSend:true});
  let r=f.decide();assert.equal(r.items[0].action,'RETRY_PRE_SEND');
  assert.equal(r.items[0].jobId,f.jobs[0].jobId);assert.equal(r.budgetUsage.generationCallReservations,1);
  assert.equal(r.items[1].reason,'BATCH_GENERATION_CALL_BUDGET');assert.deepEqual(f.decide(),r);
  f.begin();r=f.decide();assert.equal(r.budgetUsage.generationCallReservations,2);
  assert.equal(r.items[0].action,'RECONCILE_EXISTING');assert.equal(r.items[1].reason,'BATCH_GENERATION_CALL_BUDGET');
  const failed=fixture();failed.begin();failed.observe(0,'FAILED');
  assert.equal(failed.decide().items[0].action,'WAIT');assert.equal(failed.decide().items[0].reason,'REMOTE_SETTLEMENT_UNPROVEN');
});

test('item, whole-batch, call and elapsed/deadline limits gate proposals without refunding UNKNOWN',()=>{
  for(const [budget,reason] of [[{maxItemAttempts:1},'ITEM_ATTEMPT_BUDGET'],[{maxAttempts:1},'BATCH_ATTEMPT_BUDGET'],[{maxGenerationCalls:1},'BATCH_GENERATION_CALL_BUDGET']]) {
    const f=fixture(1,budget);f.begin();f.observe(0,'FAILED_PRE_SEND',{beforeSend:true});
    assert.equal(f.decide().items[0].reason,reason);
  }
  const f=fixture(2,{maxAttempts:1,maxGenerationCalls:1});
  assert.equal(f.decide().items[0].action,'CONTINUE_EXISTING');assert.equal(f.decide().items[1].action,'WAIT');
  f.begin();assert.equal(f.decide().items[0].action,'RECONCILE_EXISTING');
  assert.equal(f.decide({at:deadlineAt}).budgetUsage.generationCallReservations,1);
  assert.equal(f.decide({at:deadlineAt}).items[0].action,'BLOCKED');
  const expired=fixture(1,{maxDurationMs:60000});assert.equal(expired.decide().items[0].reason,'BATCH_DEADLINE');
  const missing=fixture(2);assert.equal(missing.decide({jobs:[missing.jobs[0]],admissions:[missing.admissions()[0]]}).items[0].reason,'BATCH_SNAPSHOT_INCOMPLETE');
});

test('holds keep exact reasons and unknown quota is null, with no account or route replacement',()=>{
  const f=fixture();f.begin();
  const reasons=[['IMAGE_QUOTA_EXHAUSTED','QUOTA'],['WEB_COOLDOWN_ACTIVE','RATE_LIMIT'],['LOGIN_REQUIRED','AUTH'],
    ['CAPABILITY_UNKNOWN:generate','CAPABILITY'],['IMAGE_USER_CONTROL_PAUSED','MANUAL_PAUSE'],['ADMISSION_PAUSED','PROJECT_CONTROL'],['CAPACITY_WAIT','CAPACITY']];
  for(const [reason,category] of reasons) {
    const admissions=f.admissions();Object.assign(admissions[0],{allowed:false,expiresAt:null,reason});
    const item=f.decide({admissions}).items[0];
    assert.equal(item.reason,reason);assert.equal(item.reasonCategory,category);assert.equal(item.resumeAction,'RECONCILE_EXISTING');
    assert.equal(item.quotaRemaining,null);assert.equal(item.attemptId,'attempt-0-1');
  }
  assert.equal(f.decide({admissions:[]}).items[0].reason,'CURRENT_ADMISSION_REQUIRED');
  const fresh=fixture(),zero=fresh.admissions();zero[0].quotaRemaining=0;
  assert.equal(fresh.decide({admissions:zero}).items[0].reason,'IMAGE_QUOTA_EXHAUSTED');
  fresh.begin();fresh.generated();fresh.exported();
  assert.equal(fresh.decide({admissions:zero}).items[0].action,'RECEIVE_EXISTING');
});

test('cancelled late originals remain quarantined and never replace good files or become receipt evidence',()=>{
  const f=fixture();f.begin();f.generated();f.exported();
  const good=copy(f.jobs[0].outputs);
  f.jobs[0].lateOutputs=[{...copy(good[0]),artifactRef:'artifact:fixture:late',sha256:'f'.repeat(64)}];
  f.jobs[0].cancelRequestedAt=at;
  const r=f.decide();assert.equal(r.items[0].action,'WAIT');assert.equal(r.items[0].reason,'IMAGE_CANCEL_REQUESTED');
  assert.deepEqual(r.items[0].lateOutputIds,['output-0']);assert.deepEqual(f.jobs[0].outputs,good);assert.equal(r.receivedCount,0);
  const lateReceipt={...f.receive(),artifactRef:'artifact:fixture:late',sha256:'f'.repeat(64)};
  assert.throws(()=>f.decide({receipts:[lateReceipt]}),/RECEIPT_BINDING/);
  assert.equal(f.decide({receipts:[f.receive()],admissions:[]}).items[0].action,'AWAIT_CONTROLLER_ACK');
});

test('identity changes, count>1, false pre-send proof and foreign producer receipts fail closed',()=>{
  const f=fixture();f.begin();f.generated();f.exported();
  assert.throws(()=>normalizeImageBatch({...f.batch,items:[{...f.batch.items[0],jobId:'other'}]}),/DIGEST_MISMATCH/);
  for(const patch of [{jobId:'other'},{requestDigest:'a'.repeat(64)},{consumerRef:'other'},{sha256:'a'.repeat(64)}])
    assert.throws(()=>f.decide({receipts:[{...f.receive(),...patch}]}),/RECEIPT_BINDING/);
  const admissions=f.admissions();admissions[0].key.grantId='other';
  assert.throws(()=>f.decide({admissions}),/ADMISSION_BINDING/);
  const jobs=copy(f.jobs);jobs[0].outputs[0].attemptId='other';assert.throws(()=>f.decide({jobs}),/OUTPUT_BINDING/);
  const mult=copy(f.jobs);mult[0].request=normalizeImageRequest({...mult[0].request,requestDigest:undefined,count:2,
    budget:{...mult[0].request.budget,maxOutputs:2}});assert.throws(()=>f.decide({jobs:mult}),/COUNT_ONE_REQUIRED/);
  const pre=fixture();pre.begin();pre.jobs[0].attempts[0].status='FAILED_PRE_SEND';pre.jobs[0].status='FAILED_PRE_SEND';
  assert.throws(()=>pre.decide(),/PRE_SEND_PROOF/);
  assert.throws(()=>imageBatchDecision(f.batch,{jobs:f.jobs,at}),/AUTHORITATIVE_INPUTS_REQUIRED/);
});
