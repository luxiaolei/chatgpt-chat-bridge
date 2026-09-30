// Offline only: actual product gates and resolver, explicit synthetic UI ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {normalizeExecutionRequest,imageExecutionPrompt,imagePromptHash,imageExecutionGate,resolveAssistedImageInputs,
  IMAGE_INPUT_MAX_BYTES,IMAGE_INPUT_TOTAL_MAX_BYTES} from '../src/capabilities/image/chatgpt-ego.js';
import {imageCli,createHostImageArtifacts} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {request,grant,scenario} from './image-execution-fixtures.mjs';
import {fixture} from './image-persistence-fixtures.mjs';
import {png,decode,MAGICK} from './image-artifacts-fixtures.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const base={artifactRef:'artifact:fixture:source',sha256:'2'.repeat(64),revisionId:'source-r1',jobId:'parent-1',outputId:'source-1'};
const ref={artifactRef:'artifact:fixture:reference',sha256:'3'.repeat(64),revisionId:'reference-r1',jobId:'parent-2',outputId:'reference-1'};
const two=()=>request({operation:'edit',inputs:[{...base,role:'source'},{...ref,role:'reference'}],baseRevision:base});
const assisted=r=>{const g=grant(r);g.capabilities.features.edit.mode='ASSISTED';
  g.capabilities.features.multiReference={mode:'ASSISTED',evidence:['urn:offline:two-input-owner-handoff']};return g;};
const sources=r=>r.inputs.map(source=>({source,revision:{revisionId:source.revisionId,output:{byteLength:100}}}));

test('two-input execution binds ordered source/reference and refuses duplicate/third/refine input',()=>{
  const r=two();assert.deepEqual(normalizeExecutionRequest(r),r);
  assert.match(imageExecutionPrompt(r,'attempt-1'),/image 1 \(source\).*image 2 \(reference\)/);
  for(const [inputs,code] of [[r.inputs.toReversed(),/INPUT_ORDER/],
    [[r.inputs[0],{...r.inputs[1],role:'source'}],/SOURCE_REQUIRED/],
    [[r.inputs[0],{...r.inputs[1],sha256:r.inputs[0].sha256}],/DUPLICATE_INPUT/],
    [[r.inputs[0],{...r.inputs[1],artifactRef:r.inputs[0].artifactRef}],/DUPLICATE_INPUT/],
    [[...r.inputs,{...ref,artifactRef:'artifact:third',role:'reference'}],/MULTI_REFERENCE/]]) {
    assert.throws(()=>normalizeExecutionRequest({...r,requestDigest:undefined,inputs}),code);
  }
  assert.throws(()=>normalizeExecutionRequest({...r,requestDigest:undefined,operation:'refine',conversationPolicy:'same-source'}),/MULTI_REFERENCE/);
  const changed=request({...r,requestDigest:undefined,inputs:[{...ref,role:'source'},{...base,role:'reference'}],baseRevision:ref});
  assert.notEqual(changed.requestDigest,r.requestDigest);
});

test('frozen ed77 single-input v1 request and prompt hashes remain unchanged',()=>{
  // Golden values captured from ed77edf, without importing old code at test time.
  const cases=[
    [request(),'2e9e95cfa447da25ee95224d365ab4422c3fb64a354a1f38136097ea597b9553','3fe25432655a6865d6e46d0f5e14ec382ef9896b0f89a1f3f0f1bbad21ab07c5'],
    [request({operation:'edit',inputs:[{...base,role:'source'}],baseRevision:base}),'368d9b76abb2136078921388395b49819b2e0293e8e2aae1c30e2038b18501ab','c5366f5fb547e98077a6734c8edf0353119d6c6cfaf7da89f2d988a7c252ea16'],
    [request({operation:'refine',inputs:[{...base,role:'source'}],baseRevision:base,conversationPolicy:'same-source'}),'1f5430a51ebea2f327b19204c600a4b0617e6bd1858effacc2bfc36cd63f4dba','c6ef6bffd1c812f4b24f57bcd68da8ada53e242af9c7b2c7add29303dacf3043'],
  ];
  for(const [r,digest,promptHash] of cases){assert.equal(normalizeExecutionRequest(r).requestDigest,digest);assert.equal(imagePromptHash(imageExecutionPrompt(r,'attempt-1')),promptHash);}
});

test('native/unknown multiReference is blocked before UI, resolution or reservation even with assisted edit',async()=>{
  for(const mode of ['NATIVE','UNKNOWN']) {
    const r=two(),g=assisted(r);g.capabilities.features.multiReference.mode=mode;
    const x=scenario({r,g});x.ports.resolveSource=async()=>assert.fail('must not resolve');
    const result=await x.adapter().start(r,x.options);
    assert.equal(result.status,'BLOCKED');assert.match(result.reason,mode==='NATIVE'?/NATIVE_UNSUPPORTED/:/UNKNOWN:multiReference/);
    assert.equal(x.job().attempts.length,0);assert.equal(x.state.selects,0);assert.equal(x.state.lanes,0);
  }
  const r=two(),g=assisted(r);g.capabilities.features.multiReference.evidence=[];
  assert.equal(imageExecutionGate(r,g.capabilities).reason,'CAPABILITY_UNVERIFIED:multiReference');
});

test('ordinary trusted sizes enforce per-file and shared 10 MiB envelope before resolving or reserving',async()=>{
  assert.equal(IMAGE_INPUT_MAX_BYTES,10*1024*1024);assert.equal(IMAGE_INPUT_TOTAL_MAX_BYTES,IMAGE_INPUT_MAX_BYTES);
  for(const [sizes,error] of [[[1,IMAGE_INPUT_MAX_BYTES+1],/FILE_TOO_LARGE/],
    [[IMAGE_INPUT_MAX_BYTES,1],/INPUT_TOTAL_TOO_LARGE/],[[1,null],/FILE_TOO_LARGE/]]) {
    const r=two(),x=scenario({r,g:assisted(r)});x.api.authorizeIO=async()=>({allowed:true,sources:sources(r).map((item,i)=>({...item,revision:{...item.revision,output:{byteLength:sizes[i]}}}))});
    x.ports.resolveSource=async()=>assert.fail('budget must precede source I/O');
    await assert.rejects(x.adapter().start(r,x.options),error);assert.equal(x.job().attempts.length,0);assert.equal(x.state.lanes,0);
  }
});

test('two-input handoff returns every resolved original in order with zero upload/fill/Send and single alias',async()=>{
  const r=two(),x=scenario({r,g:assisted(r)}),calls=[];
  x.api.authorizeIO=async()=>({allowed:true,sources:sources(r)});
  x.ports.resolveSource=async source=>{calls.push(source.role);return {...source,path:'/offline/'+source.role,mimeType:'image/png',turnId:'turn-'+source.role};};
  const result=await x.adapter().start(r,x.options);
  assert.equal(result.action,'MANUAL_SEND_REQUIRED');assert.deepEqual(result.manualInputs.map(i=>i.role),['source','reference']);
  assert.deepEqual(result.manualInput,result.manualInputs[0]);assert.deepEqual(calls,['source','reference','source','reference']);
  assert.equal(x.state.sends+x.state.fills+x.state.uploads,0);assert.equal(x.job().attempts.length,1);
});

test('resolver metadata cannot change either granted input; authority change during second resolve prevents handoff',async()=>{
  const r=two();
  await assert.rejects(resolveAssistedImageInputs(r,{key:{},api:{authorizeIO:async()=>({allowed:true,sources:sources(r)})},
    resolveSource:async source=>({...source,sha256:source.role==='reference'?'f'.repeat(64):source.sha256})}),/BINDING_MISMATCH/);
  let changed=false;
  await assert.rejects(resolveAssistedImageInputs(r,{key:{},api:{authorizeIO:async()=>({allowed:true,sources:sources(r).map((item,i)=>changed&&i===1?{...item,revision:{...item.revision,revisionId:'forged'}}:item)})},
    resolveSource:async source=>{if(source.role==='reference')changed=true;return source;}}),/REVISION_MISMATCH/);
});

async function exportParent(f,id,bytes) {
  const r=f.request({jobId:id}),g=f.grant(r,'grant-'+id);g.capabilities.features.export.mode='ASSISTED';
  const entry=f.setup(r,g),started=f.begin(entry.key,entry.job);
  const turnId='turn-'+id,ready=f.api.record(entry.key,{eventId:'observed-'+id,expectedRevision:started.revision,attemptId:started.attempts[0].attemptId,
    route:r.route,status:'GENERATED',userMessageId:'user-'+id,turnId,candidateOutputIds:['output-1'],evidenceRef:'urn:offline:parent-'+id});
  const io=await createHostImageArtifacts({api:f.api,key:entry.key,stateDir:await realpath(f.state),decode,coordinated:f.call}),inbox=await io.prepareInbox();
  await writeFile(inbox.originalPath,bytes,{mode:0o600});
  const result=await io.importOfficialOriginal({...inbox,path:inbox.originalPath,operatorRef:f.owner,sha256:hash(bytes),outputId:'output-1',mimeType:'image/png',
    officialSave:{confirmed:true,requestDigest:r.requestDigest,attemptId:ready.attempts[0].attemptId,turnId,outputId:'output-1',originalRef:inbox.originalRef,route:r.route}});
  assert.equal(result.status,'TECHNICALLY_VALIDATED');const revision=result.outputRevisions[0];
  return {artifactRef:revision.output.artifactRef,sha256:revision.output.sha256,revisionId:revision.revisionId,jobId:id,outputId:'output-1'};
}
async function setupTwo(f) {
  const base=await exportParent(f,'first-parent',png()),reference=await exportParent(f,'second-parent',png({rgba:[3,6,9,255]}));
  const r=f.request({jobId:'two-edit',operation:'edit',inputs:[{...base,role:'source'},{...reference,role:'reference'}],baseRevision:base});
  const g=f.grant(r,'two-edit-grant');g.capabilities.features.edit.mode='ASSISTED';g.capabilities.features.export.mode='ASSISTED';
  g.capabilities.features.multiReference={mode:'ASSISTED',evidence:['urn:offline:two-input-owner-handoff']};
  return {...f.setup(r,g),base,reference};
}

test('actual ordered coordinator/host resolver rejects forged or changed second original and decode-time revocation',async()=>{
  const f=await fixture();try {
    const {r,key,g}=await setupTwo(f),stateDir=await realpath(f.state),io=await createHostImageArtifacts({api:f.api,key,stateDir,decode});
    const resolved=await resolveAssistedImageInputs(r,{api:f.api,key,resolveSource:io.resolveSource});
    assert.deepEqual(resolved.map(i=>i.role),['source','reference']);
    const recordPath=resolved[1].path.replace(/original-([^/]+)\.bin$/,'record-$1.json'),record=await readFile(recordPath),original=await readFile(resolved[1].path);
    const forged=JSON.parse(record);forged.binding.turnId='self-declared-provenance';await writeFile(recordPath,JSON.stringify(forged));
    await assert.rejects(resolveAssistedImageInputs(r,{api:f.api,key,resolveSource:io.resolveSource}),/SOURCE_BINDING_MISMATCH/);await writeFile(recordPath,record);
    await writeFile(resolved[1].path,png({rgba:[10,11,12,255]}));
    await assert.rejects(resolveAssistedImageInputs(r,{api:f.api,key,resolveSource:io.resolveSource}),/HASH_MISMATCH/);await writeFile(resolved[1].path,original);
    const bad={...r,requestDigest:undefined,jobId:'forged-second',inputs:[r.inputs[0],{...r.inputs[1],revisionId:'self-declared-r1'}]};
    const badRequest=f.request(bad),badGrant={...g,grantId:'forged-second-grant',request:badRequest};f.authorize(badGrant);
    f.fail('image-submit',{grantId:badGrant.grantId,request:badRequest},/SOURCE_REVISION_MISMATCH/);
    let decodes=0;const revoked=await createHostImageArtifacts({api:f.api,key,stateDir,decode:async(...args)=>{
      const value=await decode(...args);if(++decodes===2)f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});return value;}});
    await assert.rejects(resolveAssistedImageInputs(r,{api:f.api,key,resolveSource:revoked.resolveSource}),/EXPIRED_OR_REVOKED/);
    assert.equal(f.api.inspect(key).attempts.length,0);
  } finally {await f.close();}
});

test('real CLI blocks native two-input start before Ego/bootstrap and before any attempt reservation',async()=>{
  const f=await fixture();try {
    const entry=await setupTwo(f),r=f.request({...entry.r,requestDigest:undefined,jobId:'native-two-edit'}),g=f.grant(r,'native-two-grant');
    g.capabilities.features.multiReference={mode:'NATIVE',evidence:['urn:offline:synthetic-native-multi']};
    const {key}=f.setup(r,g),payload={request:r,grantId:g.grantId,operatorRef:f.owner};
    const prepared=await imageCli('prepare',payload,{coordinated:f.call,liveAction:'start',callerEnv:f.env});
    assert.deepEqual(prepared,{ok:false,status:'BLOCKED',reason:'IMAGE_MULTI_REFERENCE_NATIVE_UNSUPPORTED',retryAllowed:false});
    const command=spawnSync('zsh',[path.resolve('bin/chat-bridge'),'image','start'],{env:f.env,input:JSON.stringify(payload),encoding:'utf8'});
    assert.equal(command.status,2,command.stdout+command.stderr);assert.equal(JSON.parse(command.stdout).status,'BLOCKED');
    assert.equal(f.api.inspect(key).attempts.length,0);
  } finally {await f.close();}
});

test('actual main requires ordered owner attestations for both fresh sources and exports the full revision lineage', {skip:!MAGICK},async()=>{
  const f=await fixture(),injected=['__CHAT_BRIDGE_IMAGE_MODULE_PATH__','__CHAT_BRIDGE_STATE_DIR__'];
  const prior=Object.fromEntries(injected.map(key=>[key,globalThis[key]])),oldDecoder=process.env.CHAT_BRIDGE_IMAGE_DECODER;
  try {
    const entry=await setupTwo(f);
    const baseRegistry=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),registry=structuredClone(baseRegistry);
    const projectId='g-p-'+'1'.repeat(32),conversationId='11111111-1111-1111-1111-111111111111';
    Object.assign(registry.projects.P.bindings.a,{projectId,projectUrl:`https://chatgpt.com/g/${projectId}/project`});
    Object.assign(registry.chats.w,{conversationId,url:`https://chatgpt.com/g/${projectId}/c/${conversationId}`});
    const stored=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{env:f.env,encoding:'utf8',input:JSON.stringify({base:baseRegistry,next:registry})});
    assert.equal(stored.status,0,stored.stderr);
    // These parent originals may originate in another conversation in the same
    // authorized Project; edit uses existing policy, never the late-refine exception.
    const r=f.request({...entry.r,requestDigest:undefined,jobId:'main-two-edit',route:{...entry.r.route,projectId,conversationId}});
    const g=f.grant(r,'main-two-grant');for(const feature of ['edit','multiReference','export'])g.capabilities.features[feature]={mode:'ASSISTED',evidence:['urn:offline:manual-two']};
    const {key}=f.setup(r,g);
    for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])await import(`../src/${name}.js`);
    const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0];
    globalThis.__CHAT_BRIDGE_IMAGE_MODULE_PATH__=path.resolve('src/capabilities/image/chatgpt-ego.js');
    globalThis.__CHAT_BRIDGE_STATE_DIR__=await realpath(f.state);process.env.CHAT_BRIDGE_IMAGE_DECODER=MAGICK;
    const observed={url:registry.chats.w.url,online:true,conversationMode:'normal',messagesComplete:true,inputReady:true,sendAvailable:true,
      generating:false,composerText:'',attachments:[],alerts:[],messages:[{id:'old-user',role:'user',text:'fixture'},{id:'old-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]}]};
    let effects=0;
    const page={url:async()=>registry.chats.w.url,fill:async()=>{effects++;assert.fail('no fill');},click:async()=>{effects++;assert.fail('no click');},
      evaluate:async fn=>fn.toString().includes('/api/auth/session')?'one':structuredClone(observed)};
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const run=await new AsyncFunction('f','registry','page',source+`
      const reg=registry;coordinated=(...args)=>f.call(...args);
      loadRuntime=async()=>({tasks:{},projects:{},sessions:{}});ensurePage=async()=>({page,task:{spaceId:7}});
      listTaskSpaces=async()=>[{id:7,ownership:'agent'}];assertWebAvailable=async()=>{};detectWebRateLimit=async()=>{};
      applyDispatchModel=async(_,chat,model,effort)=>({model,effort,observed:{raw:'Pro'}});return runNativeImage;
    `)(f,registry,page);
    const start=await run('start',{request:r,key,grantId:g.grantId,operatorRef:f.owner,attemptId:'two-manual-attempt',eventId:'two-manual-begin'});
    assert.equal(start.action,'MANUAL_SEND_REQUIRED');assert.deepEqual(start.manualInputs.map(i=>i.role),['source','reference']);assert.equal(effects,0);
    observed.messages.push({id:'two-user',role:'user',text:start.prompt},{id:'two-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]});
    const original=png({rgba:[120,110,100,255]});await writeFile(start.originalPath,original,{mode:0o600});
    const proof={confirmed:true,relationshipConfirmed:true,route:r.route,requestDigest:r.requestDigest,attemptId:start.attemptId,
      userMessageId:'two-user',parentUserId:'two-user',turnId:'two-assistant',promptHash:hash(start.prompt.replace(/\s+/g,' ').trim())};
    const payload={key,operatorRef:f.owner,path:start.originalPath,originalRef:start.originalRef,sha256:hash(original),mimeType:'image/png',officialSave:proof};
    const inputs=r.inputs.map((source,index)=>({confirmed:true,source,sourceTurnId:start.manualInputs[index].turnId}));
    for(const bad of [{input:inputs[0]},{inputs:[inputs[0]]},{inputs:inputs.toReversed()},
      {inputs:[inputs[0],{...inputs[1],confirmed:false}]},{inputs:[inputs[0],{...inputs[1],sourceTurnId:'self-declared-turn'}]}]) {
      await assert.rejects(run('assist-observe',{...payload,officialSave:{...proof,...bad}}),/INPUT_ATTESTATION_REQUIRED/);
      assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');
    }
    await assert.rejects(run('assist-observe',{...payload,operatorRef:'codex:22222222-2222-4222-8222-222222222222',officialSave:{...proof,inputs}}),/OWNER_CONTRACT/);
    const settled=await run('assist-observe',{...payload,officialSave:{...proof,inputs}});
    assert.equal(settled.mode,'ASSISTED');assert.equal(settled.nativeReady,false);assert.equal(effects,0);
    const exported=await imageCli('import-original',settled.importPayload,{coordinated:f.call,stateDir:await realpath(f.state),decode});
    assert.equal(exported.status,'TECHNICALLY_VALIDATED');const revision=exported.outputRevisions[0];
    assert.deepEqual(revision.inputs,r.inputs);assert.deepEqual(revision.output.sourceHashes,r.inputs.map(i=>i.sha256));assert.deepEqual(revision.parent,r.baseRevision);
    assert.deepEqual(f.api.result(key).outputRevisions,[revision]);
  } finally {
    for(const key of injected){if(prior[key]===undefined)delete globalThis[key];else globalThis[key]=prior[key];}
    if(oldDecoder===undefined)delete process.env.CHAT_BRIDGE_IMAGE_DECODER;else process.env.CHAT_BRIDGE_IMAGE_DECODER=oldDecoder;
    await f.close();
  }
});
