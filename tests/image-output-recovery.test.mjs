import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {fixture} from './image-persistence-fixtures.mjs';
import {png,fixtureDecode,MAGICK} from './image-artifacts-fixtures.mjs';
import {imageCli,createHostImageArtifacts,imageCallerEnvironment} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {imageJobKey,normalizeImageRequest,normalizeOutputRecoveryGrant} from '../src/capabilities/image/contract.js';
import {imageExecutionPrompt,imagePromptHash} from '../src/capabilities/image/chatgpt-ego.js';

// Seed expiry only in this fixture's private SQLite store after positive admission.
function expireFixtureGrant(f,grantId) {
  assert.match(grantId,/^[a-z0-9-]+$/);
  const [payload,revoked]=f.sql(`select payload,revoked_at from image_grants where grant_id='${grantId}'`)[0];
  assert.equal(revoked,null);
  const before=JSON.parse(payload),expiresAt='2000-01-01T00:00:00.000Z';
  f.sql(`update image_grants set payload=json_set(payload,'$.expiresAt','${expiresAt}') where grant_id='${grantId}'`);
  const [after,revokedAfter]=f.sql(`select payload,revoked_at from image_grants where grant_id='${grantId}'`)[0];
  assert.deepEqual(JSON.parse(after),{...before,expiresAt});
  assert.equal(revokedAfter,null);
}

async function setup(f,{expiry=false,route}={}) {
  const r=f.request(route?{route}:{}),g=f.grant(r);
  for(const name of ['generate','export'])g.capabilities.features[name].mode='ASSISTED';
  const s=f.setup(r,g);s.job=f.begin(s.key,s.job);
  if(expiry)expireFixtureGrant(f,g.grantId);
  else f.call('image-revoke',{grantId:g.grantId,issuerRef:f.owner});
  const grant={kind:'OUTPUT_RECOVERY',grantId:'recover-1',controllerOperationId:f.op.operationId,controllerTaskId:f.op.taskId,
    key:s.key,requestDigest:r.requestDigest,attemptId:'attempt-1',route:r.route,userMessageId:'new-user',turnId:'new-assistant',
    evidenceRef:'artifact:fixture:official-viewer',expiresAt:new Date(Date.now()+600000).toISOString(),targetRef:r.authorizedOutput.targetRef,
    consumerRef:'receiver-1',destinationRef:'store:receiver-1',maxByteLength:1000000};
  const recovery={recoveryGrantId:grant.grantId,requestDigest:r.requestDigest,attemptId:grant.attemptId,route:r.route,userMessageId:grant.userMessageId,turnId:grant.turnId};
  return {...s,grant,recovery};
}
const authorize=(f,s)=>f.call('image-authorize',{issuerRef:f.owner,grant:s.grant});
const query=(s,patch={})=>({...s.key,...s.recovery,action:'observe',...patch});
const observation=(s,revision=2)=>({eventId:'late-generated',expectedRevision:revision,attemptId:'attempt-1',route:s.r.route,status:'GENERATED',userMessageId:'new-user',turnId:'new-assistant',candidateOutputIds:['output-1'],evidenceRef:'artifact:fixture:late'});

test('recovery is owner-issued, immutable, bounded and cannot grant ordinary effects',async()=>{
  const f=await fixture();try {
    const s=await setup(f);const before=f.api.inspect(s.key);
    await assert.rejects(imageCli('recovery-authorize',{issuerRef:f.owner,grant:s.g},{coordinated:f.call}),/IMAGE_RECOVERY_REQUIRED/);
    f.fail('image-authorize',{issuerRef:'other',grant:s.grant},/OWNER_REQUIRED/);
    for(const patch of [{controllerOperationId:'other'},{controllerTaskId:'other'},{requestDigest:'f'.repeat(64)},
      {attemptId:'other'},{route:{...s.r.route,conversationId:'other'}},{userMessageId:'old-user'},
      {targetRef:'store:other'},{key:{...s.key,jobId:'other'}}])f.fail('image-authorize',{issuerRef:f.owner,grant:{...s.grant,...patch}},/ACCESS_DENIED|RECOVERY_BINDING|TURN_BINDING/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...s.grant,expiresAt:new Date(Date.now()-1).toISOString()}},/RECOVERY_EXPIRY/);
    const at='2030-01-01T00:00:00.000Z',expires=ms=>new Date(Date.parse(at)+ms).toISOString();
    assert.equal(normalizeOutputRecoveryGrant({...s.grant,expiresAt:expires(3600000)},at).expiresAt,expires(3600000));
    for(const ms of [0,3600001])assert.throws(()=>normalizeOutputRecoveryGrant({...s.grant,expiresAt:expires(ms)},at),/RECOVERY_EXPIRY/);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...s.grant,expiresAt:new Date(Date.now()+7200000).toISOString()}},/RECOVERY_EXPIRY/);
    assert.equal(authorize(f,s).idempotent,false);assert.equal(authorize(f,s).idempotent,true);
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...s.grant,consumerRef:'other'}},/GRANT_CONFLICT/);
    const wrongKey={...s.key,grantId:s.grant.grantId};
    for(const command of ['image-io-admission','image-inspect'])f.fail(command,wrongKey,/RECOVERY_EFFECT_FORBIDDEN/);
    f.fail('image-submit',{grantId:s.grant.grantId,request:s.r},/RECOVERY_EFFECT_FORBIDDEN/);
    f.fail('image-apply',{...wrongKey,event:{type:'beginAttempt',...observation(s)}},/RECOVERY_EFFECT_FORBIDDEN/);
    f.fail('image-apply',{...s.key,recovery:s.recovery,event:{type:'beginAttempt',...observation(s)}},/RECOVERY_EFFECT_FORBIDDEN/);
    for(const action of ['send','upload','beginAttempt'])assert.throws(()=>f.api.authorizeRecovery(s.key,s.recovery,action),/IMAGE_SCHEMA/);
    for(const action of ['start','submit'])await assert.rejects(imageCli(action,{key:s.key,recovery:s.recovery,request:s.r,grantId:s.g.grantId},{coordinated:f.call,executor:{start:()=>assert.fail('generation invoked')}}),/RECOVERY_EFFECT_FORBIDDEN/);
    assert.deepEqual(f.api.inspect(s.key),before);assert.equal(f.sql('select count(*) from image_jobs')[0][0],1);
  }finally{await f.close();}
});

test('query-only recovery admission rechecks exact binding, authenticated owner, current pause/cooldown and revocation',async()=>{
  const f=await fixture();try {
    const s=await setup(f);authorize(f,s);
    const paths=[path.join(f.config,'registry.json'),path.join(f.state,'runtime.json')],before=await Promise.all(paths.map(p=>readFile(p,'utf8')));
    assert.equal(f.call('image-output-io-admission',query(s)).allowed,true);
    assert.deepEqual(await Promise.all(paths.map(p=>readFile(p,'utf8'))),before);
    for(const patch of [{requestDigest:'a'.repeat(64)},{attemptId:'other'},{userMessageId:'other'},{turnId:'other'},
      {route:{...s.r.route,conversationId:'other'}},{scope:{...s.key.scope,tenantId:'other'}}])f.fail('image-output-io-admission',query(s,patch),/RECOVERY_BINDING/);
    f.fail('image-output-io-admission',query(s),/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
    f.fail('image-output-io-admission',query(s),/HOST_OWNER_REQUIRED/,{CHAT_BRIDGE_FROM_ACCOUNT_ID:f.accountId});
    f.control('pause');f.fail('image-output-io-admission',query(s),/ADMISSION_PAUSED/);f.control('resume');
    f.putRuntime({tasks:{[f.op.taskId]:{watchdogPausedForUserControl:true}}});f.fail('image-output-io-admission',query(s),/USER_CONTROL_PAUSED/);f.putRuntime({tasks:{}});
    await f.cooldown(true);f.fail('image-output-io-admission',query(s),/WEB_COOLDOWN_ACTIVE/);await f.cooldown(false);
    f.call('image-revoke',{issuerRef:f.owner,grantId:s.grant.grantId});f.fail('image-output-io-admission',query(s),/RECOVERY_EXPIRED_OR_REVOKED/);
    assert.equal(f.api.inspect(s.key).attempts.length,1);
  }finally{await f.close();}
});

test('recovery expiry and unsupported native attempts stay explicit; prepare pins recovery without ordinary authority',async()=>{
  const f=await fixture();try {
    const s=await setup(f);authorize(f,s);
    const prepared=await imageCli('prepare',{key:s.key,recovery:s.recovery},{coordinated:f.call,liveAction:'characterize',callerEnv:f.env});
    assert.deepEqual(prepared.callerContext.recovery,s.recovery);
    assert.equal(imageCallerEnvironment(prepared,'image-output-io-admission',query(s),{}).CODEX_THREAD_ID,f.env.CODEX_THREAD_ID);
    assert.throws(()=>imageCallerEnvironment(prepared,'image-output-io-admission',query(s,{turnId:'other'}),{}),/SCOPE_MISMATCH/);
    assert.throws(()=>imageCallerEnvironment(prepared,'image-apply',{...s.key,event:observation(s)},{}),/SCOPE_MISMATCH/);
    await assert.rejects(imageCli('prepare',{key:s.key,recovery:s.recovery},{coordinated:f.call,liveAction:'download-original',callerEnv:f.env}),/RECOVERY_EFFECT_FORBIDDEN/);
    expireFixtureGrant(f,s.grant.grantId);
    f.fail('image-output-io-admission',query(s),/RECOVERY_EXPIRED_OR_REVOKED/);
    f.generated(s.key,s.job); // Positive synthetic completion frees only this fixture's session.
    const native=f.request({jobId:'native'}),n=f.setup(native,f.grant(native,'native-grant'));f.begin(n.key,n.job);
    f.call('image-revoke',{issuerRef:f.owner,grantId:'native-grant'});
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...s.grant,grantId:'recover-native',key:n.key,requestDigest:native.requestDigest,expiresAt:new Date(Date.now()+60000).toISOString()}},/RECOVERY_MODE_UNSUPPORTED/);
  }finally{await f.close();}
});

test('expired official bytes remain late, immutable and receivable only by the actual pinned receiver; new refine grant names exact late revision',async()=>{
  const f=await fixture();try {
    const s=await setup(f,{expiry:true}),original=f.api.inspect(s.key);authorize(f,s);
    f.fail('image-io-admission',s.key,/EXPIRED_OR_REVOKED/);
    const io=await createHostImageArtifacts({api:f.api,key:s.key,recovery:s.recovery,stateDir:await realpath(f.state),decode:fixtureDecode,coordinated:f.call});
    const inbox=await io.prepareInbox(),bytes=png();await writeFile(inbox.originalPath,bytes,{mode:0o600});
    const verified=await io.verifyAssistedOriginal({...inbox,path:inbox.originalPath,operatorRef:f.owner});
    let job=f.api.record(s.key,observation(s),{recovery:s.recovery});
    const proof={confirmed:true,requestDigest:s.r.requestDigest,attemptId:'attempt-1',turnId:'new-assistant',outputId:'output-1',originalRef:inbox.originalRef,route:s.r.route};
    const input={path:inbox.originalPath,originalRef:inbox.originalRef,sha256:verified.sha256,mimeType:'image/png',operatorRef:f.owner,outputId:'output-1',officialSave:proof};
    const result=await io.importOfficialOriginal(input);assert.equal(result.status,'BLOCKED');assert.equal(result.businessApproval,'NOT_EVALUATED');
    assert.equal(result.outputRevisions.length,0);assert.equal(result.lateOutputRevisions.length,1);
    job=f.api.inspect(s.key);assert.equal(job.outputs.length,0);assert.equal(job.lateOutputs.length,1);assert.equal(job.attempts.length,1);
    assert.deepEqual(job.request,original.request);assert.equal(job.grantId,original.grantId);assert.ok(job.warnings.includes('LATE_RESULT_NOT_ADOPTED'));
    assert.equal(f.sql('select count(*) from task_results')[0][0],0);
    const output=job.lateOutputs[0],binding={outputId:output.outputId,artifactRef:output.artifactRef,sha256:output.sha256,consumerRef:s.grant.consumerRef,destinationRef:s.grant.destinationRef};
    for(const patch of [{consumerRef:'other'},{destinationRef:'store:other'},{sha256:'a'.repeat(64)},{outputId:'fake'}])await assert.rejects(io.receiveExisting({...binding,...patch}),/RECEIVER_BINDING|OUTPUT_NOT_VERIFIED/);
    await assert.rejects(imageCli('recovery-receive',{key:s.key,recovery:s.recovery,...binding,receipt:{status:'RECEIVED'}},{coordinated:f.call,stateDir:await realpath(f.state),decode:fixtureDecode}),/RECEIVER_BINDING/);
    const receipt=await io.receiveExisting(binding);assert.equal(receipt.receipt.status,'RECEIVED');assert.equal(receipt.businessApproval,'NOT_EVALUATED');
    assert.equal((await io.receiveExisting(binding)).reused,true);
    const src={jobId:job.jobId,outputId:output.outputId,artifactRef:output.artifactRef,sha256:output.sha256,revisionId:result.lateOutputRevisions[0].revisionId};
    const refine=f.request({jobId:'refine-1',operation:'refine',conversationPolicy:'same-source',inputs:[{...src,role:'source'}],baseRevision:src});
    const fresh=f.grant(refine,'fresh-refine');
    f.fail('image-authorize',{issuerRef:f.owner,grant:{...fresh,sourceExternalizationAuthorized:false}},/EXTERNALIZATION_NOT_AUTHORIZED/);
    const staleSrc={...src,revisionId:'other'},stale=normalizeImageRequest({...refine,requestDigest:undefined,jobId:'stale-refine',inputs:[{...staleSrc,role:'source'}],baseRevision:staleSrc});
    f.authorize(f.grant(stale,'stale-grant'));f.fail('image-submit',{grantId:'stale-grant',request:stale},/REVISION_MISMATCH/);
    const child=f.setup(refine,fresh),childIO=await createHostImageArtifacts({api:f.api,key:child.key,stateDir:await realpath(f.state),decode:fixtureDecode});
    assert.equal((await childIO.resolveSource(refine.inputs[0])).sha256,output.sha256);
    assert.deepEqual(f.api.inspect(s.key),job);f.call('image-revoke',{issuerRef:f.owner,grantId:fresh.grantId});
    await assert.rejects(childIO.resolveSource(refine.inputs[0]),/EXPIRED_OR_REVOKED/);
    await writeFile(inbox.originalPath,png({rgba:[99,33,66,255]}),{mode:0o600});
    await assert.rejects(io.verifyAssistedOriginal({...input}),/HASH_MISMATCH/);
    f.call('image-revoke',{issuerRef:f.owner,grantId:s.grant.grantId});
    await assert.rejects(io.importOfficialOriginal(input),/RECOVERY_EXPIRED_OR_REVOKED/);
    assert.deepEqual(f.api.inspect(s.key),job);
  }finally{await f.close();}
});

test('real prepare → main ASSISTED observe → original-key import retains late status and rejects wrong visible turn',async()=>{
  const f=await fixture(),names=['__CHAT_BRIDGE_IMAGE_MODULE_PATH__','__CHAT_BRIDGE_STATE_DIR__','__CHAT_BRIDGE_IMAGE_PREPARED__'],prior=Object.fromEntries(names.map(k=>[k,globalThis[k]]));
  try {
    const base=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),registry=structuredClone(base),projectId='g-p-'+'1'.repeat(32),conversationId='11111111-1111-1111-1111-111111111111';
    Object.assign(registry.projects.P.bindings.a,{projectId,projectUrl:`https://chatgpt.com/g/${projectId}/project`});Object.assign(registry.chats.w,{conversationId,url:`https://chatgpt.com/g/${projectId}/c/${conversationId}`});
    const saved=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{env:f.env,encoding:'utf8',input:JSON.stringify({base,next:registry})});assert.equal(saved.status,0,saved.stderr);
    const s=await setup(f,{route:{...f.request().route,projectId,conversationId}});authorize(f,s);
    const io=await createHostImageArtifacts({api:f.api,key:s.key,recovery:s.recovery,stateDir:await realpath(f.state),decode:fixtureDecode,coordinated:f.call}),inbox=await io.prepareInbox();await writeFile(inbox.originalPath,png(),{mode:0o600});
    const prompt=imageExecutionPrompt(s.r,'attempt-1'),proof={confirmed:true,relationshipConfirmed:true,route:s.r.route,requestDigest:s.r.requestDigest,attemptId:'attempt-1',userMessageId:'new-user',parentUserId:'new-user',turnId:'new-assistant',promptHash:imagePromptHash(prompt)};
    const payload={key:s.key,recovery:s.recovery,operatorRef:f.owner,path:inbox.originalPath,originalRef:inbox.originalRef,officialSave:proof};
    const prepared=await imageCli('prepare',payload,{coordinated:f.call,liveAction:'assist-observe',callerEnv:{...f.env,CHAT_BRIDGE_IMAGE_DECODER:MAGICK||''}});
    globalThis.__CHAT_BRIDGE_IMAGE_MODULE_PATH__=path.resolve('src/capabilities/image/chatgpt-ego.js');globalThis.__CHAT_BRIDGE_STATE_DIR__=await realpath(f.state);globalThis.__CHAT_BRIDGE_IMAGE_PREPARED__=prepared;
    for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])await import(`../src/${name}.js`);
    const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0];
    const snapshot={url:registry.chats.w.url,online:true,conversationMode:'normal',messagesComplete:true,inputReady:true,sendAvailable:true,generating:false,composerText:'',attachments:[],alerts:[],messages:[{id:'old-user',role:'user',text:'fixture'},{id:'old-assistant',role:'assistant'},{id:'new-user',role:'user',text:prompt},{id:'new-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]}]};
    const page={url:async()=>snapshot.url,fill:async()=>assert.fail('no compose'),click:async()=>assert.fail('no Send'),evaluate:async fn=>fn.toString().includes('/api/auth/session')?'one':structuredClone(snapshot)};
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const run=await new AsyncFunction('f','registry','page',source+`const reg=registry;coordinated=(...a)=>f.call(...a);loadRuntime=async()=>({tasks:{}});ensurePage=async()=>({page,task:{spaceId:7}});listTaskSpaces=async()=>[{id:7,ownership:'agent'}];assertWebAvailable=async()=>{};detectWebRateLimit=async()=>{};return runNativeImage;`)(f,registry,page);
    await assert.rejects(run('start',payload),/RECOVERY_EFFECT_FORBIDDEN/);
    await assert.rejects(run('assist-observe',{...payload,officialSave:{...proof,turnId:'other'}}),/RECOVERY_TURN_BINDING/);
    if(!MAGICK){await assert.rejects(run('assist-observe',payload),/IMAGE_DECODER_REQUIRED/);return;}
    const observed=await run('assist-observe',payload);assert.equal(observed.status,'BLOCKED');assert.equal(observed.nativeReady,false);assert.equal(observed.importPayload.sha256.length,64);
    const imported=await imageCli('import-original',observed.importPayload,{coordinated:f.call,stateDir:await realpath(f.state),decode:fixtureDecode});assert.equal(imported.status,'BLOCKED');assert.equal(imported.lateOutputRevisions.length,1);assert.equal(f.api.inspect(s.key).attempts.length,1);
  }finally{for(const k of names){if(prior[k]===undefined)delete globalThis[k];else globalThis[k]=prior[k];}await f.close();}
});
