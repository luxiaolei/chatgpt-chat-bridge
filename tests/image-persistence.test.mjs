import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './image-persistence-fixtures.mjs';
import {normalizeImageRequest,unknownImageCapabilities,imageJobKey,validateImageShape,applyImageEvent} from '../src/capabilities/image/contract.js';
const withFixture = fn => async()=>{const f=await fixture();try{await fn(f);}finally{await f.close();}};

test('image persistence survives process restart and never becomes a controller result/cache task',withFixture(f=>{
 const {r,g,key,job}=f.setup();assert.equal(job.status,'SUBMITTED');assert.equal(job.jobId,'image-1');assert.notEqual(job.controllerTaskId,job.jobId);
 assert.deepEqual(f.api.submit(r,{grantId:g.grantId}),job);assert.deepEqual(f.api.inspect(key),job);
 const result=f.api.result(key);validateImageShape(result,'Result');assert.equal(result.businessApproval,'NOT_EVALUATED');assert.equal(result.prompt,undefined);
 assert.deepEqual(f.sql('select count(*) from operations'),[[1]]);assert.deepEqual(f.sql('select count(*) from task_results'),[[0]]);
 assert.deepEqual(f.sql('select count(*) from image_jobs'),[[1]]);
 assert.equal(f.sql("select payload from documents where kind='runtime'")[0][0].includes('image-1'),false);
}));
test('image grants require exact controller identity; caller, token and namespace cannot self-authorize',withFixture(f=>{
 const r=f.request(),g=f.grant(r),key=imageJobKey(r,g.grantId);
 f.fail('image-submit',{grantId:'invented',request:r},/IMAGE_ACCESS_DENIED/);
 f.fail('image-authorize',{issuerRef:f.owner,grant:g},/IMAGE_GRANT_HOST_OWNER_REQUIRED/,{CHAT_BRIDGE_FROM_ACCOUNT_ID:f.accountId});
 f.fail('image-authorize',{issuerRef:'w',grant:g},/GRANT_OWNER/);
 f.fail('image-authorize',{issuerRef:f.owner,grant:g},/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
 f.authorize(g);f.api.submit(r,{grantId:g.grantId});
 f.fail('image-inspect',{...key,scope:{...key.scope,tenantId:'t2'}},/IMAGE_ACCESS_DENIED/);
 f.fail('image-inspect',{...key,callerRef:'pretend-admin'},/IMAGE_ACCESS_DENIED/);
 f.fail('image-inspect',key,/IMAGE_ACCESS_DENIED/,{CHAT_BRIDGE_FROM_ACCOUNT_ID:'f'.repeat(64)});
 f.fail('image-inspect',key,/IMAGE_ORIGIN_UNVERIFIED/,{CHAT_BRIDGE_FROM_SPACE:'unverified'});
 f.fail('image-submit',{grantId:g.grantId,request:{...r,authorized:true}},/IMAGE_SCHEMA/);
 assert.equal(f.call('image-inspect',key,{CHAT_BRIDGE_FROM_ACCOUNT_ID:f.accountId}).jobId,r.jobId);
}));
test('same caller/job changed request conflicts, and cross-tenant grants do not leak existence',withFixture(f=>{
 const {r,g,key}=f.setup();
 const changed=normalizeImageRequest({...r,requestDigest:undefined,prompt:'other'});
 const g2=f.grant(changed,'grant-2');f.authorize(g2);
 f.fail('image-submit',{grantId:g2.grantId,request:changed},/IMAGE_IDEMPOTENCY_CONFLICT/);
 f.fail('image-submit',{grantId:g.grantId,request:changed},/IMAGE_REQUEST_NOT_GRANTED/);
 const other=normalizeImageRequest({...r,requestDigest:undefined,scope:{...r.scope,tenantId:'t2'}}),g3=f.grant(other,'grant-3');f.authorize(g3);
 f.fail('image-submit',{grantId:g3.grantId,request:other},/IMAGE_ACCESS_DENIED/);
 assert.equal(f.api.inspect(key).requestDigest,r.requestDigest);
}));
test('original export is bound to a new turn and byte verification, not text self-report',withFixture(f=>{
 let {r,key,job}=f.setup();job=f.begin(key,job);assert.equal(job.status,'SUBMISSION_UNKNOWN');
 job=f.generated(key,job);assert.equal(job.status,'GENERATED');assert.equal(job.outputs.length,0);
 const out=f.output(job);job=f.exported(key,job,[out]);assert.equal(job.status,'TECHNICALLY_VALIDATED');assert.equal(f.api.result(key).missingCount,0);
 assert.equal(job.outputs[0].sha256,out.sha256);assert.equal(job.outputs[0].turnId,'new-assistant');
 validateImageShape(f.api.result(key),'Result');assert.equal(f.sql('select count(*) from task_results')[0][0],0);
 const event={eventId:'self-claim',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'TECHNICALLY_VALIDATED',evidenceRef:'artifact:text'};
 f.fail('image-apply',{...key,event:{...event,type:'observation'}},/IMAGE_OBSERVATION_STATUS|IMAGE_SCHEMA/);
}));
test('UNKNOWN capability is durable BLOCKED; only a separately authorized evidence snapshot can enable an attempt',withFixture(f=>{
 const r=f.request(),g=f.grant(r,'grant-unknown',{capabilities:unknownImageCapabilities(r.route)});let {job,key}=f.setup(r,g);
 assert.equal(job.status,'BLOCKED');assert.match(job.reason,/CAPABILITY_UNKNOWN/);
 f.fail('image-apply',{...key,event:{type:'beginAttempt',eventId:'start',expectedRevision:1,attemptId:'a1',baselineTurnIds:[],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}}},/CAPABILITY_UNKNOWN/);
 const verified=f.grant(r,'grant-observed');f.authorize(verified);key=imageJobKey(r,verified.grantId);
 assert.equal(f.begin(key,job).status,'SUBMISSION_UNKNOWN');
}));
test('UNKNOWN is not resent; exact event replay, conflict and CAS survive lost responses',withFixture(async f=>{
 let {r,key,job}=f.setup();job=f.begin(key,job);
 f.fail('image-apply',{...key,event:{type:'beginAttempt',eventId:'double',expectedRevision:job.revision,attemptId:'a2',baselineTurnIds:[],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}}},/RECONCILE_REQUIRED/);
 const event={type:'reconcile',eventId:'unknown-check',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'SUBMISSION_UNKNOWN',evidenceRef:'artifact:fixture:inconclusive'};
 const reconciled=f.call('image-apply',{...key,event});assert.equal(reconciled.status,'SUBMISSION_UNKNOWN');assert.deepEqual(f.call('image-apply',{...key,event}),reconciled);
 f.fail('image-apply',{...key,event:{...event,evidenceRef:'artifact:changed'}},/IMAGE_EVENT_CONFLICT/);
 const e1={...event,eventId:'race-1',expectedRevision:reconciled.revision},e2={...e1,eventId:'race-2'};
 const responses=await Promise.all([f.callAsync('image-apply',{...key,event:e1}),f.callAsync('image-apply',{...key,event:e2})]);
 assert.deepEqual(responses.map(r=>r.code).sort(),[0,2]);assert.match(responses.find(r=>r.code===2).err,/IMAGE_REVISION_CONFLICT/);
 assert.equal(f.api.inspect(key).revision,reconciled.revision+1);
}));
test('only proven pre-send failure admits bounded retry; no unknown delivery reset',withFixture(f=>{
 let {r,key,job}=f.setup();job=f.begin(key,job);
 const event={type:'reconcile',eventId:'not-sent',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'FAILED_PRE_SEND',evidenceRef:'artifact:fixture:before-send'};
 f.fail('image-apply',{...key,event},/NOT_SUBMITTED_PROOF/);
 job=f.call('image-apply',{...key,event:{...event,beforeSend:true}});job=f.begin(key,job,'attempt-2');
 job=f.call('image-apply',{...key,event:{...event,eventId:'not-sent-2',expectedRevision:job.revision,attemptId:'attempt-2',beforeSend:true}});
 f.fail('image-apply',{...key,event:{type:'beginAttempt',eventId:'third',expectedRevision:job.revision,attemptId:'attempt-3',baselineTurnIds:[],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}}},/ATTEMPT_BUDGET/);
}));
test('partial generation/export retains known outputs; verified count remains incomplete until every output arrives',withFixture(f=>{
 const r=f.request({count:2});let {key,job}=f.setup(r);job=f.begin(key,job);job=f.generated(key,job,['output-1'],'PARTIAL');
 job=f.exported(key,job);assert.equal(job.status,'PARTIAL');assert.equal(f.api.result(key).missingCount,1);
 job=f.generated(key,job,['output-1','output-2']);job=f.exported(key,job,[f.output(job,'output-2')]);
 assert.equal(job.status,'TECHNICALLY_VALIDATED');assert.deepEqual(job.outputs.map(o=>o.outputId),['output-1','output-2']);
}));
test('finite cancellation distinguishes never submitted from stop requested and quarantines late originals',withFixture(f=>{
 const first=f.setup();const cancelled=f.api.cancel(first.key,{eventId:'cancel-before',expectedRevision:1,reason:'test only'});assert.equal(cancelled.status,'CANCELLED');
 const r=f.request({jobId:'image-2'});let {key,job}=f.setup(r,f.grant(r,'grant-2'));job=f.begin(key,job);
 job=f.api.cancel(key,{eventId:'cancel-running',expectedRevision:job.revision,reason:'stop request, not receipt'});assert.equal(job.status,'CANCEL_REQUESTED');
 job=f.generated(key,job);assert.equal(job.status,'CANCEL_REQUESTED');assert.equal(job.lateObservations.length,1);
 job=f.exported(key,job);assert.equal(job.outputs.length,0);assert.equal(job.lateOutputs.length,1);assert.equal(job.status,'CANCEL_REQUESTED');
 assert.match(job.warnings.join(','),/LATE_RESULT_NOT_ADOPTED/);assert.equal(f.api.result(key).businessApproval,'NOT_EVALUATED');
}));
test('revoked authorization blocks new work while late evidence remains inspectable without adoption',withFixture(f=>{
 let {r,g,key,job}=f.setup();job=f.begin(key,job);f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});
 job=f.generated(key,job);assert.equal(job.status,'BLOCKED');job=f.exported(key,job);assert.equal(job.lateOutputs.length,1);assert.equal(job.outputs.length,0);
 const future=new Date(Date.parse(r.budget.deadlineAt)+1000).toISOString();
 const late=applyImageEvent(job,{type:'reconcile',eventId:'late-expiry',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'GENERATED',userMessageId:'new-user',turnId:'new-assistant',candidateOutputIds:['output-1'],evidenceRef:'artifact:fixture:late'},g,{at:future});
 assert.equal(late.status,'BLOCKED');
}));
test('model, route, old image and unverified output counterexamples fail closed',withFixture(f=>{
 let {r,key,job}=f.setup();
 const start={type:'beginAttempt',eventId:'start-wrong',expectedRevision:1,attemptId:'attempt-1',baselineTurnIds:['old-assistant'],modelSelection:{model:'Latest',effort:'Extra High',raw:'Extra High',verified:true}};
 f.fail('image-apply',{...key,event:start},/MODEL_SELECTION_MISMATCH/);job=f.begin(key,job);
 const event={type:'observation',eventId:'bad',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'GENERATED',userMessageId:'new-user',turnId:'old-assistant',candidateOutputIds:['output-1'],evidenceRef:'artifact:fixture:old'};
 f.fail('image-apply',{...key,event},/NEW_TURN_REQUIRED/);
 f.fail('image-apply',{...key,event:{...event,route:{...r.route,accountAlias:'b'}}},/ROUTE_MISMATCH/);
 job=f.generated(key,job);const out=f.output(job),exp={type:'export',eventId:'bad-export',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,outputs:[out],evidenceRef:'artifact:fixture:bytes'};
 f.fail('image-apply',{...key,event:{...exp,outputs:[{...out,turnId:'old-assistant'}]}},/OUTPUT_BINDING_MISMATCH/);
 f.fail('image-apply',{...key,event:{...exp,outputs:[{...out,sourceHashes:['a'.repeat(64)]}]}},/OUTPUT_LINEAGE_MISMATCH/);
 f.fail('image-apply',{...key,event:{...exp,outputs:[{...out,validation:{...out.validation,checks:{...out.validation.checks,decode:false}}}]}},/VERIFICATION_INCOMPLETE/);
 job=f.exported(key,job,[{...out,validation:{...out.validation,status:'UNVERIFIED'}}]);assert.equal(job.status,'EXPORTED');
 job=f.exported(key,job,[out]);assert.equal(job.status,'TECHNICALLY_VALIDATED');
 f.fail('image-apply',{...key,event:{...exp,eventId:'overwrite',expectedRevision:job.revision,outputs:[{...out,sha256:'a'.repeat(64)}]}},/OUTPUT_CONFLICT/);
}));
test('same-source refine resolves an exact verified parent rather than last image or external namespace',withFixture(f=>{
 let {key,job}=f.setup();job=f.begin(key,job);job=f.generated(key,job);job=f.exported(key,job);const out=job.outputs[0];
 const base={artifactRef:out.artifactRef,sha256:out.sha256,revisionId:'asset-r1',outputId:out.outputId,jobId:job.jobId};
 const r=f.request({jobId:'refine-1',operation:'refine',conversationPolicy:'same-source',baseRevision:base,inputs:[{...base,role:'source'}]});
 const refined=f.setup(r,f.grant(r,'grant-refine'));assert.equal(refined.job.status,'SUBMITTED');
 const bad=f.request({jobId:'refine-bad',operation:'refine',conversationPolicy:'same-source',baseRevision:{...base,sha256:'b'.repeat(64)},inputs:[{...base,sha256:'b'.repeat(64),role:'source'}]});
 f.authorize(f.grant(bad,'grant-bad'));f.fail('image-submit',{grantId:'grant-bad',request:bad},/SOURCE_NOT_VERIFIED/);
 const unapproved=f.grant(r,'grant-no-externalize',{sourceExternalizationAuthorized:false});f.fail('image-authorize',{issuerRef:f.owner,grant:unapproved},/SOURCE_EXTERNALIZATION_NOT_AUTHORIZED/);
}));

test('lost beginAttempt reply never re-grants the UI side effect on replay',withFixture(f=>{
 const {key,job}=f.setup();const event={type:'beginAttempt',eventId:'start-once',expectedRevision:job.revision,attemptId:'a1',baselineTurnIds:[],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}};
 const first=f.call('image-apply',{...key,event});assert.equal(first.effectAdmission,'NEWLY_RESERVED');
 const replay=f.call('image-apply',{...key,event});assert.equal(replay.effectAdmission,'RECONCILE_ONLY');assert.equal(replay.revision,first.revision);
 assert.equal(f.api.inspect(key).effectAdmission,undefined);assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');
}));

test('image admission reuses pause/drain, cooldown, user control and controller-result gates',withFixture(async f=>{
 const {key,job}=f.setup();
 const start={type:'beginAttempt',eventId:'resource-start',expectedRevision:job.revision,attemptId:'a1',baselineTurnIds:[],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}};
 f.control('pause');assert.equal(f.api.inspect(key).status,'SUBMITTED');f.fail('image-apply',{...key,event:start},/ADMISSION_PAUSED/);
 f.control('drain');f.fail('image-apply',{...key,event:start},/ADMISSION_DRAINING/);f.control('resume');
 await f.cooldown(true);f.fail('image-apply',{...key,event:start},/WEB_COOLDOWN_ACTIVE/);await f.cooldown(false);
 f.putRuntime({tasks:{[f.op.taskId]:{taskId:f.op.taskId,project:'P',account:'a',sessionId:'w',watchdogPausedForUserControl:true}}});
 f.fail('image-apply',{...key,event:start},/IMAGE_USER_CONTROL_PAUSED/);f.putRuntime({tasks:{}});
 f.call('result',{taskId:f.op.taskId,status:'COMPLETE',summary:'synthetic controller result; not a real image'});
 f.fail('image-apply',{...key,event:start},/IMAGE_CONTROLLER_RESULT_RECORDED/);
 assert.equal(f.api.inspect(key).status,'SUBMITTED');assert.deepEqual(f.sql('PRAGMA integrity_check'),[['ok']]);
}));

test('late observation after terminal failure cannot promote or adopt an output',withFixture(f=>{
 let {r,key,job}=f.setup();job=f.begin(key,job);
 job=f.api.record(key,{eventId:'terminal-failure',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'FAILED',evidenceRef:'artifact:fixture:failure'});
 job=f.generated(key,job);assert.equal(job.status,'FAILED');job=f.exported(key,job);assert.equal(job.status,'FAILED');assert.equal(job.lateOutputs.length,1);assert.equal(job.outputs.length,0);
}));

test('export-only request binds the persisted original turn and never asks for a fabricated new user turn',withFixture(f=>{
 let {key,job}=f.setup();job=f.begin(key,job);job=f.generated(key,job);job=f.exported(key,job);const original=job.outputs[0];
 const base={artifactRef:original.artifactRef,sha256:original.sha256,revisionId:'original-r1',outputId:original.outputId,jobId:job.jobId};
 const r=f.request({jobId:'export-only',operation:'export',inputs:[{...base,role:'source'}],baseRevision:base});
 ({key,job}=f.setup(r,f.grant(r,'grant-export')));assert.equal(job.sourceTurnId,original.turnId);
 job=f.begin(key,job);assert.equal(job.effectAdmission,'READ_ONLY_EXPORT');
 job=f.api.record(key,{eventId:'source-observed',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'GENERATED',turnId:original.turnId,candidateOutputIds:['copy-original'],evidenceRef:'artifact:fixture:source-original'});
 job=f.exported(key,job,[f.output(job,'copy-original',{sha256:original.sha256,turnId:original.turnId})]);assert.equal(job.status,'TECHNICALLY_VALIDATED');
 assert.equal(job.attempts[0].userMessageId,null);assert.equal(job.outputs[0].parentOutputId,original.outputId);
}));

test('a second same-request grant cannot silently renew an already bound attempt',withFixture(f=>{
 let {r,g,key,job}=f.setup();job=f.begin(key,job);
 const g2=f.grant(r,'grant-other-snapshot');f.authorize(g2);
 const event={type:'reconcile',eventId:'cross-grant',expectedRevision:job.revision,attemptId:'attempt-1',route:r.route,status:'SUBMISSION_UNKNOWN',evidenceRef:'artifact:fixture:inconclusive'};
 f.fail('image-apply',{...imageJobKey(r,g2.grantId),event},/IMAGE_ATTEMPT_GRANT_MISMATCH/);
 assert.equal(f.api.inspect(key).grantId,g.grantId);
}));
