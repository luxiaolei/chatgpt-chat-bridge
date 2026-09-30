import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath,symlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {normalizeExecutionRequest,imageExecutionProbe,imageExecutionPrompt,imagePromptHash,imageAttemptBaseline,
  classifyImageObservation,stageImageSource,createImageExecutionAdapter} from '../src/capabilities/image/chatgpt-ego.js';
import {request,grant,snapshot,generated,image,scenario,selection,time,clone,digest} from './image-execution-fixtures.mjs';
const attempt={attemptId:'attempt-fixture',baselineTurnIds:['old-user','old-assistant'],userMessageId:null,turnId:null};
const classify=(s,r=request(),a=attempt)=>classifyImageObservation({request:r,attempt:a,snapshot:s});

test('generation remains UNKNOWN until feature-specific native observation is integrated',()=>{
  const p=imageExecutionProbe(request().route);assert.equal(p.nativeReady,false);assert.equal(p.capabilities.features.generate.mode,'UNKNOWN');
  assert.equal(p.originalExport.status,'EXPORT_UNAVAILABLE');assert.equal(p.businessApproval,'NOT_EVALUATED');
});
test('single-image boundary refuses multi-output, multiple refs, masks and reference generation',()=>{
  const source={artifactRef:'artifact:fixture:source',sha256:'2'.repeat(64),revisionId:'r1',jobId:null,outputId:null};
  const edit={operation:'edit',inputs:[{...source,role:'source'}],baseRevision:source};
  assert.equal(normalizeExecutionRequest(request(edit)).operation,'edit');
  assert.throws(()=>normalizeExecutionRequest(request({count:2})),/COUNT_UNSUPPORTED/);
  assert.throws(()=>normalizeExecutionRequest(request({...edit,inputs:[...edit.inputs,{...source,artifactRef:'artifact:other',role:'reference'}]})),/MULTI_REFERENCE/);
  assert.throws(()=>normalizeExecutionRequest(request({inputs:[{...source,role:'reference'}]})),/REFERENCE_GENERATION/);
  const mask={artifactRef:'artifact:mask',sha256:'3'.repeat(64),sourceSha256:source.sha256,sourceRevisionId:'r1',width:16,height:16,coordinateSpace:'source-pixels',mode:'native-region'};
  assert.throws(()=>normalizeExecutionRequest(request({...edit,mask})),/MASK_UNSUPPORTED/);
});
test('attempt prompt binds digest and attempt, uses ratio and does not include a local file path',()=>{
  const r=request();const text=imageExecutionPrompt(r,'attempt-fixture');
  assert.match(text,/1:1/);assert.match(text,/ChatBridge image attempt [a-f0-9]{64}/);
  assert.notEqual(text,imageExecutionPrompt(r,'attempt-other'));
  assert.equal(imagePromptHash(text),imagePromptHash(text.replace(/\n/g,'   ')));
});
test('baseline requires stable unique message IDs and an honestly verified model',()=>{
  const r=request();assert.deepEqual(imageAttemptBaseline(r,snapshot(r),selection).baselineTurnIds,attempt.baselineTurnIds);
  assert.throws(()=>imageAttemptBaseline(r,snapshot(r),{model:null,effort:'Pro',raw:'Pro',verified:false}),/MODEL_SELECTION/);
  assert.throws(()=>imageAttemptBaseline(r,snapshot(r,{messagesComplete:false}),selection),/EVIDENCE_INCOMPLETE/);
  const s=snapshot(r);s.messages[1].id=s.messages[0].id;
  assert.throws(()=>imageAttemptBaseline(r,s,selection),/EVIDENCE_AMBIGUOUS/);
});
for(const [name,patch,code] of [
  ['user-owned',{ownership:'user'},'USER_CONTROL'],['delegated',{ownership:'agentDelegatedToUser'},'USER_CONTROL'],
  ['identity missing',{identityVerified:false},'ROUTE_UNVERIFIED'],['project missing',{projectVerified:false},'ROUTE_UNVERIFIED'],
  ['temporary chat',{conversationMode:'temporary'},'TEMPORARY'],['unknown chat mode',{conversationMode:null},'TEMPORARY'],
  ['challenge',{challengeRequired:true},'CHALLENGE'],['login',{loginRequired:true},'LOGIN'],
  ['quota',{quotaLimited:true},'COOLDOWN'],['offline',{online:false},'OFFLINE'],
  ['draft',{composerText:'user work'},'DRAFT'],['busy',{generating:true},'BUSY'],
  ['old attachment',{attachments:[{accepted:true}]},'EXISTING_ATTACHMENT'],
]) test(`pre-send gate: ${name} produces no submit action`,async()=>{
  const x=scenario({snapshotPatch:patch});await assert.rejects(x.adapter().start(x.r,x.options),new RegExp(code));
  assert.equal(x.state.sends,0);assert.equal(x.job().attempts.length,0);assert.equal(x.state.lanes,0);
});
test('each exact route component is checked, never project-only affinity',()=>{
  for(const field of Object.keys(request().route)) {
    const s=generated();s.route={...s.route,[field]:'other'};
    assert.throws(()=>classify(s),/ROUTE_MISMATCH/);
  }
});
test('native output is candidate-only, has stable output identity and cannot be technical success',()=>{
  const value=classify(generated());assert.equal(value.status,'GENERATED');
  assert.equal(value.candidateOutputIds.length,1);assert.equal(value.candidates[0].originalBytesVerified,false);
  assert.deepEqual(value,classify(generated()));assert.equal(value.outputs,undefined);
});
for(const [name,patch] of [
  ['input reference',{sourceReference:true}],['unknown reference provenance',{sourceReference:undefined}],
  ['old asset',{createdByTurnId:'old-assistant'}],['wrong owner',{ownerTurnId:'old-assistant'}],
  ['thumbnail',{thumbnail:true}],['placeholder',{placeholder:true}],['loading',{renderState:'loading'}],
  ['zero-sized',{width:0}],['ordinary image',{kind:'embedded'}],['alt text only',{proof:'alt-generated-image'}],
  ['missing native ID',{nativeAssetId:null}],
]) test(`candidate rejection: ${name}`,()=>{
  const s=generated();s.messages.at(-1).images=[image(patch)];
  assert.equal(classify(s).status,'FAILED');assert.equal(classify(s).reason,'IMAGE_NO_GENERATED_OUTPUT');
});
test('text saying generated, no new turn, and composer images do not produce output',()=>{
  const s=generated();s.messages.at(-1).images=[];s.messages.at(-1).text='I have generated the image.';
  assert.equal(classify(s).status,'FAILED');
  const old=snapshot();old.messages.at(-1).images=[image()];old.attachments=[image()];
  assert.equal(classify(old).status,null);
});
test('explicit native refusal is distinguished from text-only completion',()=>{
  assert.equal(classify(generated(request(),'attempt-fixture',{refusalTurnId:'new-assistant'})).reason,'IMAGE_REQUEST_REFUSED');
});
test('accepted user, active generation, output arrival are separate observations',()=>{
  const s=generated();s.messages.pop();assert.equal(classify(s).status,'GENERATING');assert.equal(classify(s).turnId,null);
  const active=generated();active.messages.at(-1).images=[];active.messages.at(-1).settled=false;active.generating=true;
  assert.equal(classify(active).reason,'IMAGE_OUTPUT_NOT_YET_OBSERVED');
  assert.equal(classify(generated()).status,'GENERATED');
});
test('wrong/new duplicate user, intervening user, changed assistant or parent fail closed',()=>{
  const wrong=generated();wrong.messages[2].promptHash='0'.repeat(64);assert.equal(classify(wrong).status,null);
  const duplicate=generated();duplicate.messages.push({...duplicate.messages[2],id:'other-user'});assert.equal(classify(duplicate).reason,'IMAGE_USER_TURN_AMBIGUOUS');
  const intervening=generated();intervening.messages.push({id:'human-user',role:'user',promptHash:'0'.repeat(64)});assert.throws(()=>classify(intervening),/INTERVENING/);
  assert.throws(()=>classify(generated(),request(),{...attempt,turnId:'known-assistant'}),/TURN_CHANGED/);
  const parent=generated();parent.messages.at(-1).parentUserId=null;assert.equal(classify(parent).reason,'IMAGE_PARENT_USER_UNVERIFIED');
  parent.messages.at(-1).parentUserId='other-user';assert.throws(()=>classify(parent),/PARENT_USER/);
});
test('more than one output and duplicate output evidence are not silently truncated',()=>{
  const s=generated();s.messages.at(-1).images.push(image({nativeAssetId:'other'}));assert.throws(()=>classify(s),/COUNT_MISMATCH/);
  s.messages.at(-1).images[1]=image();assert.throws(()=>classify(s),/EVIDENCE_AMBIGUOUS/);
});
test('single shot commits UNKNOWN and baseline before fill/click, returns separate export handoff',async()=>{
  const x=scenario();const fill=x.ui.fill;x.ui.fill=async text=>{assert.equal(x.job().status,'SUBMISSION_UNKNOWN');assert.equal(x.job().attempts.length,1);return fill(text);};
  const result=await x.adapter().start(x.r,x.options);
  assert.equal(result.status,'GENERATED');assert.equal(x.state.sends,1);assert.equal(x.state.lanes,0);assert.equal(x.state.maxLanes,1);
  assert.deepEqual(x.state.guards,['before-reservation','before-send']);assert.equal(result.handoff.originalExportStatus,'EXPORT_UNAVAILABLE');
  assert.equal(result.handoff.requestDigest,x.r.requestDigest);assert.equal(result.handoff.candidateOutputIds.length,1);
  assert.equal(result.outputs,undefined);assert.ok(x.evidence.size>0);
});
test('reconcile retains a settled candidate after export failure despite a later generating snapshot',async()=>{
  const x=scenario();await x.adapter().start(x.r,x.options);
  const job=x.job();job.status='EXPORT_UNAVAILABLE';job.attempts[0].status='EXPORT_UNAVAILABLE';x.setJob(job);
  const live=generated(x.r,x.options.attemptId);live.generating=true;live.messages.at(-1).settled=false;
  x.state.snapshotPatch=live;
  const count=x.evidence.size,result=await x.adapter().reconcile(x.key);
  assert.equal(result.status,'EXPORT_UNAVAILABLE');assert.equal(result.observationReason,'IMAGE_KNOWN_GENERATION_RETAINED');
  assert.equal(x.evidence.size,count);assert.deepEqual(x.job().attempts[0].candidateOutputIds,job.attempts[0].candidateOutputIds);assert.equal(x.state.sends,1);
});
test('absence of durable session port cannot be replaced by an in-process lock or allowed flag',async()=>{
  const x=scenario();delete x.ports.assertSessionAdmission;
  await assert.rejects(x.adapter().start(x.r,x.options),/INTEGRATION_REQUIRED/);
  assert.equal(x.state.sends,0);assert.equal(x.state.lanes,0);
});
test('cross-job session conflict stops before reservation and is never rerouted',async()=>{
  const x=scenario();x.ports.assertSessionAdmission=async()=>{throw new Error('IMAGE_SESSION_BUSY');};
  await assert.rejects(x.adapter().start(x.r,x.options),/SESSION_BUSY/);assert.equal(x.job().attempts.length,0);assert.equal(x.state.sends,0);
});
test('missing feature evidence never invokes a UI port',async()=>{
  for(const mode of ['UNKNOWN']) {
    const r=request(),g=grant(r);g.capabilities.features.generate.mode=mode;
    const x=scenario({r,g});const result=await x.adapter().start(x.r,x.options);
    assert.equal(result.ok,false);assert.equal(x.state.lanes,0);assert.equal(x.state.sends,0);
  }
});
test('ASSISTED start reserves exact baseline and returns manual prompt without upload/fill/send',async()=>{
  const r=request(),g=grant(r);g.capabilities.features.generate.mode='ASSISTED';
  const x=scenario({r,g}),result=await x.adapter().start(r,x.options);
  assert.equal(result.mode,'ASSISTED');assert.equal(result.action,'MANUAL_SEND_REQUIRED');
  assert.equal(result.status,'SUBMISSION_UNKNOWN');assert.equal(x.job().attempts.length,1);
  assert.equal(result.prompt,imageExecutionPrompt(r,result.attemptId));
  assert.equal(x.state.sends,0);assert.equal(x.state.fills,0);assert.equal(x.state.uploads,0);
  assert.equal((await x.adapter().start(r,x.options)).action,'RECONCILE_ONLY');
});
test('lost begin acknowledgement leaves durable UNKNOWN; reconstruction cannot resend',async()=>{
  const x=scenario(),begin=x.api.beginAttempt;x.api.beginAttempt=(...args)=>{begin(...args);throw new Error('LOST_BEGIN_ACK');};
  await assert.rejects(x.adapter().start(x.r,x.options),/LOST_BEGIN_ACK/);
  assert.equal(x.job().status,'SUBMISSION_UNKNOWN');assert.equal(x.state.sends,0);
  assert.equal((await x.adapter().start(x.r,{...x.options,attemptId:'other-attempt',eventId:'other-event'})).action,'RECONCILE_ONLY');
  assert.equal(x.state.sends,0);
});
test('a replayed effect admission cannot trigger the upload/fill/click',async()=>{
  const x=scenario(),begin=x.api.beginAttempt;x.api.beginAttempt=(...args)=>({...begin(...args),effectAdmission:'RECONCILE_ONLY'});
  assert.equal((await x.adapter().start(x.r,x.options)).action,'RECONCILE_ONLY');assert.equal(x.state.sends,0);assert.equal(x.state.fills,0);
});
test('click timeout may have sent: no fallback, UNKNOWN, later original-turn reconcile only',async()=>{
  const x=scenario();x.ui.sendOnce=async()=>{x.state.sends++;x.state.sent=true;throw new Error('CLICK_TIMEOUT');};
  const result=await x.adapter().start(x.r,x.options);assert.equal(result.status,'SUBMISSION_UNKNOWN');assert.equal(x.state.sends,1);
  assert.equal((await x.adapter().start(x.r,x.options)).action,'RECONCILE_ONLY');
  const recovered=await x.adapter().reconcile(x.key);assert.equal(recovered.status,'GENERATED');assert.equal(x.state.sends,1);assert.equal(x.state.lanes,0);
});
test('lost observation acknowledgement reconciles state without another generation',async()=>{
  const x=scenario(),record=x.api.record;x.api.record=(...args)=>{record(...args);throw new Error('LOST_OBSERVATION_ACK');};
  assert.equal((await x.adapter().start(x.r,x.options)).status,'SUBMISSION_UNKNOWN');assert.equal(x.job().status,'GENERATED');
  assert.equal((await x.adapter().reconcile(x.key)).status,'GENERATED');assert.equal(x.state.sends,1);
});
test('late observation after cancel or budget does not deliver a usable handoff',async()=>{
  for(const cancel of [true,false]) {
    const x=scenario();x.ui.sendOnce=async()=>{x.state.sends++;x.state.sent=false;};
    await x.adapter().start(x.r,x.options);x.state.sent=true;
    if(cancel) x.api.cancel(x.key,{eventId:'cancel',expectedRevision:x.job().revision});else x.state.now+=70000;
    const result=await x.adapter().reconcile(x.key);
    assert.equal(result.handoff,undefined);assert.notEqual(result.status,'GENERATED');assert.ok(x.job().warnings.includes('LATE_RESULT_NOT_ADOPTED'));
    assert.equal(x.state.sends,1);
  }
});
test('human takeover after fill preserves user draft and proves only no send',async()=>{
  const x=scenario(),fill=x.ui.fill;x.ui.fill=async text=>{await fill(text);x.state.snapshotPatch={ownership:'user'};};
  const result=await x.adapter().start(x.r,x.options);assert.equal(result.status,'FAILED_PRE_SEND');assert.equal(x.state.sends,0);
  assert.ok(x.state.text.includes('ChatBridge image attempt'));assert.equal(x.state.lanes,0);
});
test('evidence storage failure after send retains UNKNOWN, does not assert an unstored receipt',async()=>{
  const x=scenario();x.ports.evidenceSink=async()=>{throw new Error('STORAGE_DOWN');};
  const result=await x.adapter().start(x.r,x.options);assert.equal(result.status,'SUBMISSION_UNKNOWN');assert.equal(x.job().status,'SUBMISSION_UNKNOWN');
  assert.equal(result.handoff,undefined);assert.equal(x.state.sends,1);
});
test('no baseline evidence after a send is unknown rather than failed or permission to resend',async()=>{
  const x=scenario();x.ui.sendOnce=async()=>{x.state.sends++;};
  const result=await x.adapter().start(x.r,x.options);assert.equal(result.status,'SUBMISSION_UNKNOWN');assert.equal(result.retryAllowed,false);assert.equal(x.state.sends,1);
});

async function sourceFixture(operation='edit') {
  const dir=await realpath(await mkdtemp(path.join(tmpdir(),'image-execution-source-')));
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),file=path.join(dir,'source.png');await writeFile(file,bytes);
  const source={artifactRef:'artifact:fixture:source',sha256:digest(bytes),revisionId:'revision-1',jobId:operation==='refine'?'parent-job':null,outputId:operation==='refine'?'parent-output':null};
  const r=request({operation,inputs:[{...source,role:'source'}],baseRevision:source,conversationPolicy:operation==='refine'?'same-source':'existing'});
  return {dir,bytes,file,r,resolved:{...source,path:file,mimeType:'image/png',route:r.route,turnId:'parent-turn'},close:()=>rm(dir,{recursive:true,force:true})};
}
test('source is hashed, MIME-bound, privately staged, immutable against original replacement, then cleaned',async()=>{
  const f=await sourceFixture();let staged;
  try {
    staged=await stageImageSource(f.r,f.resolved);assert.notEqual(staged.path,f.file);assert.equal((await stat(staged.path)).mode & 0o777,0o600);
    await writeFile(f.file,'changed');assert.deepEqual(await readFile(staged.path),f.bytes);
    await staged.release();await assert.rejects(stat(staged.path),{code:'ENOENT'});
  }finally{if(staged)await staged.release();await f.close();}
});
test('source revision/hash/MIME/symlink/count are not inferred from a filename or old callback',async()=>{
  const f=await sourceFixture();try{
    await assert.rejects(stageImageSource(f.r,{...f.resolved,revisionId:'old'}),/BINDING_MISMATCH/);
    await assert.rejects(stageImageSource(f.r,{...f.resolved,mimeType:'image/jpeg'}),/MIME_MISMATCH/);
    const link=path.join(f.dir,'link.png');await symlink(f.file,link);await assert.rejects(stageImageSource(f.r,{...f.resolved,path:link}),/SYMLINK/);
    await writeFile(f.file,'other');await assert.rejects(stageImageSource(f.r,f.resolved),/HASH_MISMATCH/);
  }finally{await f.close();}
});
test('refine requires exact saved parent turn, source revision and route, not an opaque named old image',async()=>{
  const f=await sourceFixture('refine');try{
    await assert.rejects(stageImageSource(f.r,f.resolved),/SOURCE_CONVERSATION/);
    await assert.rejects(stageImageSource(f.r,{...f.resolved,route:{...f.r.route,conversationId:'other'}},{sourceTurnId:'parent-turn'}),/SOURCE_CONVERSATION/);
    const staged=await stageImageSource(f.r,f.resolved,{sourceTurnId:'parent-turn'});await staged.release();
  }finally{await f.close();}
});
test('single-image edit uploads accepted staged input and removes it even when upload fails',async()=>{
  for(const accepted of [true,false]) {
    const f=await sourceFixture();let stagedPath;
    try {
      const x=scenario({r:f.r});x.ports.resolveSource=async()=>f.resolved;
      x.ui.upload=async staged=>{stagedPath=staged.path;x.state.uploads++;x.state.attached=[{accepted}];return {accepted};};
      const result=await x.adapter().start(x.r,x.options);
      assert.equal(result.status,accepted?'GENERATED':'FAILED_PRE_SEND');assert.equal(x.state.sends,accepted?1:0);
      await assert.rejects(stat(stagedPath),{code:'ENOENT'});assert.equal(x.state.lanes,0);
    }finally{await f.close();}
  }
});
