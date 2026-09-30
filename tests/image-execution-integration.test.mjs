import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {createEgoImageUi,inspectEgoImagePage} from '../src/capabilities/image/chatgpt-ego.ui.js';
import {imageCli,createHostImageArtifacts} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {createImageExecutionAdapter} from '../src/capabilities/image/chatgpt-ego.js';
import {fixture} from './image-persistence-fixtures.mjs';
import {snapshot,generated,selection} from './image-execution-fixtures.mjs';
import {png,decode,MAGICK} from './image-artifacts-fixtures.mjs';
import {createHash} from 'node:crypto';

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
test('image facade requires native entry and forwards to real wired executor',async()=>{
  for(const action of ['start','reconcile']) {
    await assert.rejects(imageCli(action,{},{coordinated:()=>assert.fail('must not invoke')}),/IMAGE_NATIVE_ENTRY_REQUIRED/);
    let called=0;
    const executor={[action]:async()=>{called++;return {ok:true,status:'GENERATING'};}};
    assert.equal((await imageCli(action,{request:{},key:{}},{executor})).status,'GENERATING');assert.equal(called,1);
  }
});
test('prepare authenticates the persisted exact route without starting Ego',async()=>{
  const f=await fixture();try {
    const {r,g,key}=f.setup();
    const prepared=await imageCli('prepare',{request:r,grantId:g.grantId},{coordinated:f.call,liveAction:'start'});
    assert.deepEqual(prepared.route,r.route);assert.deepEqual(prepared.payload.key,key);
    assert.deepEqual((await imageCli('prepare',{key},{coordinated:f.call,liveAction:'reconcile'})).route,r.route);
    await assert.rejects(imageCli('prepare',{key:{...key,callerRef:'invented'}},{coordinated:f.call,liveAction:'characterize'}),/IMAGE_ACCESS_DENIED/);
  }finally{await f.close();}
});

test('assisted official Save bytes pass C decode/manifest and A export; same host source uses current grant',async()=>{
  const f=await fixture();try {
    const r=f.request(),g=f.grant(r);g.capabilities.features.export.mode='ASSISTED';
    const setup=f.setup(r,g),reserved=f.begin(setup.key,setup.job),ready=f.generated(setup.key,reserved);
    const bytes=png(),sha256=createHash('sha256').update(bytes).digest('hex');
    const io=await createHostImageArtifacts({api:f.api,key:setup.key,stateDir:await realpath(f.state),decode,coordinated:f.call});
    const inbox=await io.prepareInbox();await writeFile(inbox.originalPath,bytes,{mode:0o600});
    const input={operatorRef:f.owner,outputId:'output-1',originalRef:inbox.originalRef,path:inbox.originalPath,sha256,mimeType:'image/png',
      officialSave:{confirmed:true,requestDigest:r.requestDigest,attemptId:ready.attempts[0].attemptId,
        turnId:'new-assistant',outputId:'output-1',originalRef:inbox.originalRef,route:r.route}};
    const exported=await io.importOfficialOriginal(input);
    assert.equal(exported.status,'TECHNICALLY_VALIDATED',JSON.stringify(exported));assert.equal(exported.deliveryStatus,'NOT_RECEIVED');
    assert.equal(exported.manifest.deliveryStatus,'NOT_RECEIVED');assert.deepEqual(exported.manifest.exportModes,['ASSISTED']);
    const output=f.api.inspect(setup.key).outputs[0];assert.equal(output.sha256,sha256);assert.equal(output.width,2);
    assert.equal(f.sql('select count(*) from task_results')[0][0],0);
    const source={artifactRef:output.artifactRef,sha256,revisionId:'fixture-v1',jobId:r.jobId,outputId:output.outputId};
    const edit=f.request({jobId:'edit-1',operation:'edit',inputs:[{...source,role:'source'}],baseRevision:source});
    const editSetup=f.setup(edit,f.grant(edit,'grant-edit'));
    const editIO=await createHostImageArtifacts({api:f.api,key:editSetup.key,stateDir:await realpath(f.state),decode});
    const resolved=await editIO.resolveSource(edit.inputs[0]);assert.equal(resolved.turnId,'new-assistant');assert.equal(resolved.sha256,sha256);
    f.call('image-revoke',{issuerRef:f.owner,grantId:'grant-edit'});
    await assert.rejects(editIO.resolveSource(edit.inputs[0]),/EXPIRED_OR_REVOKED/);
  }finally{await f.close();}
});

test('assisted import refuses absent official confirmation, wrong turn, or native-mode relabeling before byte I/O',async()=>{
  const f=await fixture();try {
    const {r,key,job}=f.setup(),ready=f.generated(key,f.begin(key,job));
    const io=await createHostImageArtifacts({api:f.api,key,stateDir:await realpath(f.state),decode,coordinated:f.call});
    const inbox=await io.prepareInbox();
    const input={operatorRef:f.owner,path:inbox.originalPath,outputId:'output-1',originalRef:inbox.originalRef,sha256:'a'.repeat(64)};
    await assert.rejects(io.importOfficialOriginal(input),/OFFICIAL_SAVE_ATTESTATION/);
    input.officialSave={confirmed:true,requestDigest:r.requestDigest,attemptId:ready.attempts[0].attemptId,turnId:'wrong-turn',outputId:'output-1',originalRef:input.originalRef,route:r.route};
    await assert.rejects(io.importOfficialOriginal(input),/OFFICIAL_SAVE_ATTESTATION/);
    input.officialSave.turnId='new-assistant';
    await assert.rejects(io.importOfficialOriginal(input),/ORIGINAL_MODE_MISMATCH/);
  }finally{await f.close();}
});

test('visible preview and missing native lineage remain UNKNOWN, never settled generated evidence',async()=>{
  const r=(await import('./image-execution-fixtures.mjs')).request();
  const attempt={attemptId:'attempt-fixture',baselineTurnIds:['old-user','old-assistant']};
  const observed=generated(r);observed.messages.at(-1).nativeProvenanceVerified=false;
  const {classifyImageObservation}=await import('../src/capabilities/image/chatgpt-ego.js');
  observed.messages.at(-1).images=[];assert.equal(classifyImageObservation({request:r,attempt,snapshot:observed}).reason,'IMAGE_NATIVE_PROVENANCE_UNVERIFIED');
  observed.messages.at(-1).parentUserId=null;
  assert.equal(classifyImageObservation({request:r,attempt,snapshot:observed}).status,null);
  const live=generated(r);live.generating=true;live.messages.at(-1).settled=false;
  assert.equal(classifyImageObservation({request:r,attempt,snapshot:live}).status,'GENERATING');
});

test('production public DOM observer captures actual IDs/controls but gives previews no generated provenance',async()=>{
  const element=(attrs={},text='',children=[])=>({tagName:attrs.tag||'DIV',innerText:text,textContent:text,disabled:false,
    getAttribute:name=>attrs[name]??null,getClientRects:()=>[{}],closest:()=>null,
    querySelector:()=>null,querySelectorAll:()=>children,
    naturalWidth:32,naturalHeight:32,complete:true});
  const preview=element({tag:'IMG','alt':'generated original','src':'https://private/thumbnail'}),save=element({tag:'BUTTON','aria-label':'Save image'});
  const user=element({'data-message-author-role':'user','data-message-id':'dom-user'},'Generate one image.');
  const assistant=element({'data-message-author-role':'assistant','data-message-id':'dom-assistant'},'Generated!', [preview,save]);
  const root={querySelectorAll:()=>[user,assistant]},composer=element({},''),send=element({tag:'BUTTON','data-testid':'send-button'});
  const values={document:{querySelector:selector=>selector==='main, [role="main"]'?root:selector.includes('prompt-textarea')?composer:null,
    querySelectorAll:selector=>selector==='button'?[send]:[]},location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},
    navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const prior=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true});
    const result=await inspectEgoImagePage({evaluate:async fn=>fn()});
    assert.equal(result.messagesComplete,true);assert.equal(result.messages[0].id,'dom-user');assert.equal(result.sendAvailable,true);
    assert.equal(result.messages[1].parentUserId,null);assert.equal(result.messages[1].nativeProvenanceVerified,false);
    assert.deepEqual(result.messages[1].images,[]);assert.equal(result.messages[1].settled,null);
    assert.doesNotMatch(JSON.stringify(result),/private\/thumbnail|generated original|Generated!/);
  }finally{for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('live image CLI traverses existing account cooldown preflight before any Ego invocation',async()=>{
  const f=await fixture();try {
    const {r,g}=f.setup();await f.cooldown(true);
    const result=spawnSync(path.resolve('bin/chat-bridge'),['image','start'],{env:f.env,encoding:'utf8',input:JSON.stringify({request:r,grantId:g.grantId})});
    assert.equal(result.status,75,result.stdout+result.stderr);assert.match(result.stderr,/WEB_COOLDOWN_ACTIVE/);
    assert.doesNotMatch(result.stderr,/ego-browser not found/);assert.equal(f.api.inspect({grantId:g.grantId,callerRef:r.caller.ref,jobId:r.jobId,scope:r.scope}).attempts.length,0);
  }finally{await f.close();}
});

test('generic shared send/retry/stop/recovery/detach honor the real SQLite image reservation',async()=>{
  const f=await fixture();try {
    const {key,job}=f.setup();f.begin(key,job);
    for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy']) await import(`../src/${name}.js`);
    const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0];
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const registry={accounts:{a:{identity:'one'}},projects:{P:{bindings:{a:{spaceName:'space',spaceId:7}}}},chats:{w:{id:'w',project:'P',account:'a',status:'active',spaceName:'space',spaceId:7,page:'p',url:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'}}};
    const live={taskId:'T',sessionId:'w',project:'P',account:'a',status:'BLOCKED',updatedAt:'2026-01-01T00:00:00Z'};
    const helpers=await new AsyncFunction('f','registry','live',source+`
      const reg=registry;
      coordinated=(...args)=>f.call(...args);
      loadRuntime=async()=>({tasks:{T:live},projects:{},sessions:{}});
      return {assertImagePageFree,spaceProtection,gradedRecover,detachTerminalTaskPages};
    `)(f,registry,live);
    const page={url:async()=>registry.chats.w.url};
    await assert.rejects(helpers.assertImagePageFree(page),/IMAGE_SESSION_OCCUPIED/);
    assert.equal(helpers.spaceProtection(registry,{tasks:{}},{spaceName:'space',spaceId:7},{spaceId:7}).labels.has('p'),true);
    assert.equal((await helpers.gradedRecover(registry,registry.chats.w,page,live,{sessionState:'ERROR_RECOVERABLE'})).action,'RECONCILE_ONLY');
    assert.deepEqual(await helpers.detachTerminalTaskPages(registry),[]);
    assert.equal(f.api.sessionOccupancy({accountId:f.accountId,conversationId:'w'},key).reservedByJob,true);
    f.api.cancel(key,{eventId:'cancel-reservation',expectedRevision:f.api.inspect(key).revision,reason:'offline'});
    await assert.rejects(helpers.assertImagePageFree(page),/IMAGE_SESSION_OCCUPIED/);
  }finally{await f.close();}
});

test('real main factories execute ASSISTED reservation, exact-owner observation and controlled original import',async()=>{
  const f=await fixture();
  const injected=['__CHAT_BRIDGE_IMAGE_MODULE_PATH__','__CHAT_BRIDGE_STATE_DIR__'];
  const prior=Object.fromEntries(injected.map(key=>[key,globalThis[key]]));
  const oldDecoder=process.env.CHAT_BRIDGE_IMAGE_DECODER;
  try {
    const base=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),registry=structuredClone(base);
    const projectId='g-p-'+'1'.repeat(32),conversationId='11111111-1111-1111-1111-111111111111';
    registry.projects.P.bindings.a.projectId=projectId;
    registry.projects.P.bindings.a.projectUrl=`https://chatgpt.com/g/${projectId}/project`;
    Object.assign(registry.chats.w,{conversationId,url:`https://chatgpt.com/g/${projectId}/c/${conversationId}`});
    const stored=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{env:f.env,encoding:'utf8',input:JSON.stringify({base,next:registry})});
    assert.equal(stored.status,0,stored.stderr);
    const r=f.request({route:{...f.request().route,projectId,conversationId}}),g=f.grant(r);
    for(const feature of ['generate','export']) g.capabilities.features[feature].mode='ASSISTED';
    const {key}=f.setup(r,g);
    for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy']) await import(`../src/${name}.js`);
    const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0];
    globalThis.__CHAT_BRIDGE_IMAGE_MODULE_PATH__=path.resolve('src/capabilities/image/chatgpt-ego.js');
    globalThis.__CHAT_BRIDGE_STATE_DIR__=await realpath(f.state);
    if(MAGICK) process.env.CHAT_BRIDGE_IMAGE_DECODER=MAGICK;
    const observed={url:registry.chats.w.url,online:true,conversationMode:'normal',messagesComplete:true,
      inputReady:true,sendAvailable:true,generating:false,composerText:'',attachments:[],alerts:[],
      messages:[{id:'old-user',role:'user',text:'fixture'},{id:'old-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]}]};
    let ownership='agent',inspections=0;
    const page={url:async()=>registry.chats.w.url,fill:async()=>assert.fail('ASSISTED must not fill'),click:async()=>assert.fail('ASSISTED must not click'),
      evaluate:async fn=>{if(fn.toString().includes('/api/auth/session'))return 'one';inspections++;return structuredClone(observed);}};
    const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const run=await new AsyncFunction('f','registry','page','spaces',source+`
      const reg=registry;
      coordinated=(...args)=>f.call(...args);
      loadRuntime=async()=>({tasks:{},projects:{},sessions:{}});
      ensurePage=async()=>({page,task:{spaceId:7}});
      listTaskSpaces=spaces;
      assertWebAvailable=async()=>{};
      detectWebRateLimit=async()=>{};
      applyDispatchModel=async(_,chat,model,effort)=>({model,effort,observed:{raw:'Pro'}});
      return runNativeImage;
    `)(f,registry,page,async()=>[{id:7,ownership}]);
    const payload={request:r,grantId:g.grantId,key,operatorRef:f.owner,attemptId:'manual-attempt',eventId:'manual-begin'};
    const start=await run('start',payload);
    assert.equal(start.action,'MANUAL_SEND_REQUIRED');assert.equal(start.mode,'ASSISTED');assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');
    ownership='user';await assert.rejects(run('characterize',{key}),/USER_CONTROL/);ownership='agent';
    observed.messages.push({id:'new-user',role:'user',text:start.prompt},{id:'new-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]});
    const original=png(),sha256=createHash('sha256').update(original).digest('hex');await writeFile(start.originalPath,original,{mode:0o600});
    const proof={confirmed:true,relationshipConfirmed:true,route:r.route,requestDigest:r.requestDigest,attemptId:start.attemptId,
      userMessageId:'new-user',parentUserId:'new-user',turnId:'new-assistant',promptHash:createHash('sha256').update(start.prompt.replace(/\s+/g,' ').trim()).digest('hex')};
    const assist={key,operatorRef:f.owner,path:start.originalPath,originalRef:start.originalRef,sha256,mimeType:'image/png',officialSave:proof};
    await assert.rejects(run('assist-observe',{...assist,operatorRef:'codex:22222222-2222-4222-8222-222222222222'}),/OWNER_CONTRACT/);
    if(!MAGICK) {await assert.rejects(run('assist-observe',assist),/IMAGE_DECODER_REQUIRED/);return;}
    const settled=await run('assist-observe',assist);assert.equal(settled.status,'GENERATED');assert.equal(settled.mode,'ASSISTED');assert.equal(settled.nativeReady,false);
    assert.equal(f.api.sessionOccupancy({accountId:f.accountId,conversationId},key).occupied,false);
    const exported=await imageCli('import-original',settled.importPayload,{coordinated:f.call,stateDir:await realpath(f.state),decode});
    assert.equal(exported.status,'TECHNICALLY_VALIDATED');assert.equal(exported.deliveryStatus,'NOT_RECEIVED');assert.ok(inspections>0);
    const output=f.api.inspect(key).outputs[0],baseRevision={artifactRef:output.artifactRef,sha256:output.sha256,
      revisionId:'manual-v1',jobId:r.jobId,outputId:output.outputId};
    const edit=f.request({jobId:'manual-edit',operation:'edit',route:r.route,inputs:[{...baseRevision,role:'source'}],baseRevision});
    const editGrant=f.grant(edit,'manual-edit-grant');for(const feature of ['edit','export'])editGrant.capabilities.features[feature].mode='ASSISTED';
    const editKey=f.setup(edit,editGrant).key;
    const editStart=await run('start',{request:edit,grantId:editGrant.grantId,key:editKey,operatorRef:f.owner,attemptId:'manual-edit-attempt',eventId:'manual-edit-begin'});
    assert.equal(editStart.manualInput.sha256,sha256);assert.equal(editStart.manualInput.turnId,'new-assistant');
    observed.messages.push({id:'edit-user',role:'user',text:editStart.prompt},{id:'edit-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]});
    const edited=png({rgba:[99,66,33,255]}),editHash=createHash('sha256').update(edited).digest('hex');await writeFile(editStart.originalPath,edited,{mode:0o600});
    const editProof={...proof,requestDigest:edit.requestDigest,attemptId:editStart.attemptId,userMessageId:'edit-user',parentUserId:'edit-user',turnId:'edit-assistant',
      promptHash:createHash('sha256').update(editStart.prompt.replace(/\s+/g,' ').trim()).digest('hex')};
    const editAssist={key:editKey,operatorRef:f.owner,path:editStart.originalPath,originalRef:editStart.originalRef,sha256:editHash,mimeType:'image/png',officialSave:editProof};
    await assert.rejects(run('assist-observe',editAssist),/IMAGE_ASSISTED_INPUT_ATTESTATION_REQUIRED/);
    assert.equal(f.api.sessionOccupancy({accountId:f.accountId,conversationId},editKey).reservedByJob,true);
    editProof.input={confirmed:true,source:{...edit.inputs[0],sha256:'a'.repeat(64)},sourceTurnId:'new-assistant'};
    await assert.rejects(run('assist-observe',editAssist),/IMAGE_ASSISTED_INPUT_ATTESTATION_REQUIRED/);
    editProof.input.source=edit.inputs[0];
    const editedSettlement=await run('assist-observe',editAssist);assert.equal(editedSettlement.mode,'ASSISTED');
    const editExport=await imageCli('import-original',editedSettlement.importPayload,{coordinated:f.call,stateDir:await realpath(f.state),decode});
    assert.equal(editExport.status,'TECHNICALLY_VALIDATED');assert.equal(editExport.deliveryStatus,'NOT_RECEIVED');
    assert.equal(f.api.inspect(editKey).outputs[0].parentOutputId,output.outputId);
  } finally {
    for(const key of injected) {if(prior[key]===undefined)delete globalThis[key];else globalThis[key]=prior[key];}
    if(oldDecoder===undefined)delete process.env.CHAT_BRIDGE_IMAGE_DECODER;else process.env.CHAT_BRIDGE_IMAGE_DECODER=oldDecoder;
    await f.close();
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
    assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'IMAGE_ACCESS_DENIED');assert.equal(blocked.error.sendAttempted,false);
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
