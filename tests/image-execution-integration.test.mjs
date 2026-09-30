import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile,realpath,mkdir,symlink} from 'node:fs/promises';
import path from 'node:path';
import {createRuntime} from '../src/runtime.js';
import {createEgoImageUi,inspectEgoImagePage} from '../src/capabilities/image/chatgpt-ego.ui.js';
import {imageCli,createHostImageArtifacts} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {createImageExecutionAdapter,imageExecutionPrompt,classifyImageObservation,assertImageSnapshot} from '../src/capabilities/image/chatgpt-ego.js';
import {fixture} from './image-persistence-fixtures.mjs';
import {snapshot,generated,selection,request} from './image-execution-fixtures.mjs';
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
  const ui=createEgoImageUi({page,inspectNative:async()=>({sendAvailable:true,generating:false}),assertOwnedRoute:async()=>{checks++;},selectResources:async()=>selection,assertSendAdmission:async()=>{}});
  await assert.rejects(ui.sendOnce(),/timeout/);assert.equal(clicks,1);assert.equal(presses,0);assert.equal(checks,1);
});
test('native primitives require a verified observer and enforce ownership before side effects',async()=>{
  const page={fill:async()=>assert.fail('must not fill'),click:async()=>assert.fail('must not click')};
  assert.throws(()=>createEgoImageUi({page}),/OBSERVER_UNVERIFIED/);
  const ui=createEgoImageUi({page,inspectNative:async()=>assert.fail('must not inspect'),assertOwnedRoute:async()=>{throw new Error('USER_CONTROL');},selectResources:async()=>selection,assertSendAdmission:async()=>{}});
  await assert.rejects(ui.sendOnce(),/USER_CONTROL/);await assert.rejects(ui.fill('fixture'),/USER_CONTROL/);
});
test('native upload is accepted only after existing upload and native readiness agree',async()=>{
  let uploaded=0;
  const page={fill:async()=>{},click:async()=>{}};
  let accepted=false;
  const ui=createEgoImageUi({page,assertOwnedRoute:async()=>{},selectResources:async()=>selection,assertSendAdmission:async()=>{},
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
    const prepared=await imageCli('prepare',{request:r,grantId:g.grantId,callerContext:{kind:'invented'}},{coordinated:f.call,liveAction:'start',callerEnv:f.env});
    assert.deepEqual(prepared.route,r.route);assert.deepEqual(prepared.payload.key,key);
    assert.equal(prepared.callerContext.kind,'local-owner');assert.equal(prepared.callerContext.owner.threadId,f.env.CODEX_THREAD_ID);
    assert.deepEqual((await imageCli('prepare',{key},{coordinated:f.call,liveAction:'reconcile',callerEnv:f.env})).route,r.route);
    await assert.rejects(imageCli('prepare',{key:{...key,callerRef:'invented'}},{coordinated:f.call,liveAction:'characterize'}),/IMAGE_ACCESS_DENIED/);
  }finally{await f.close();}
});
test('actual CLI prepare carries owner and explicit runtime into an env-less stripped-PATH Ego stage',async()=>{
  const globals=['__CHAT_BRIDGE_IMAGE_MODULE_PATH__','__CHAT_BRIDGE_COORDINATOR_PATH__','__CHAT_BRIDGE_STORE_PATH__','__CHAT_BRIDGE_CONFIG_DIR__','__CHAT_BRIDGE_STATE_DIR__','__CHAT_BRIDGE_IMAGE_PREPARED__','__CHAT_BRIDGE_ARGS__'];
  const names=['CODEX_THREAD_ID','CHAT_BRIDGE_FROM_ACCOUNT_ID','CHAT_BRIDGE_FROM_SPACE','CHAT_BRIDGE_IMAGE_DECODER','PATH'];
  const prior=Object.fromEntries(globals.map(name=>[name,globalThis[name]])),priorEnv=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    for(const mode of ['local-owner','remote-origin','revoked']) {
      for(const name of names){if(priorEnv[name]===undefined)delete process.env[name];else process.env[name]=priorEnv[name];}
      const f=await fixture();try {
        const base=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),registry=structuredClone(base);
        const projectId='g-p-'+'1'.repeat(32),conversationId='11111111-1111-1111-1111-111111111111';
        Object.assign(registry.projects.P.bindings.a,{projectId,projectUrl:`https://chatgpt.com/g/${projectId}/project`});Object.assign(registry.chats.w,{conversationId,url:`https://chatgpt.com/g/${projectId}/c/${conversationId}`});
        const stored=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{env:f.env,encoding:'utf8',input:JSON.stringify({base,next:registry})});assert.equal(stored.status,0,stored.stderr);
        const r=f.request({route:{...f.request().route,projectId,conversationId}}),g=f.grant(r);for(const feature of ['generate','export'])g.capabilities.features[feature].mode='ASSISTED';
        const {key}=f.setup(r,g),payload={request:r,grantId:g.grantId,key,operatorRef:f.owner,attemptId:'context-attempt',eventId:'context-begin',callerContext:{kind:'local-owner',owner:{threadId:f.env.CODEX_THREAD_ID}},runtimeConfig:{nodeExecutable:'/invented/node',decoderExecutable:'/invented/decoder'}};
        const decoderExecutable=MAGICK||path.join(f.root,'no-maintained-decoder');
        const clientEnv={...f.env,CHAT_BRIDGE_IMAGE_DECODER:decoderExecutable,...(mode==='remote-origin'?{CODEX_THREAD_ID:'',CHAT_BRIDGE_FROM_ACCOUNT_ID:f.accountId}:{})};
        const result=spawnSync(process.execPath,[path.resolve('src/capabilities/image/chatgpt-ego.cli.js'),'prepare','start'],{env:clientEnv,encoding:'utf8',input:JSON.stringify(payload)});assert.equal(result.status,0,result.stderr);
        const prepared=JSON.parse(result.stdout);assert.equal(prepared.callerContext.kind,mode==='remote-origin'?'remote-origin':'local-owner');
        assert.deepEqual(prepared.runtimeConfig,{nodeExecutable:process.execPath,decoderExecutable});
        Object.assign(globalThis,{__CHAT_BRIDGE_IMAGE_MODULE_PATH__:path.resolve('src/capabilities/image/chatgpt-ego.js'),__CHAT_BRIDGE_COORDINATOR_PATH__:path.resolve('src/coordinator.py'),__CHAT_BRIDGE_STORE_PATH__:path.resolve('src/state-store.py'),
          __CHAT_BRIDGE_CONFIG_DIR__:await realpath(f.config),__CHAT_BRIDGE_STATE_DIR__:await realpath(f.state),__CHAT_BRIDGE_IMAGE_PREPARED__:prepared,__CHAT_BRIDGE_ARGS__:['image','start']});
        // Real Python -> Node contract subprocess, with Node absent from the host
        // PATH as it is in Ego. This isolated path keeps that fact portable in CI.
        const python=spawnSync('python3',['-c','import sys; print(sys.executable)'],{env:f.env,encoding:'utf8'});assert.equal(python.status,0,python.stderr);
        const egoPath=path.join(f.root,'ego-path');await mkdir(egoPath);await symlink(python.stdout.trim(),path.join(egoPath,'python3'));
        for(const name of names)delete process.env[name];process.env.PATH=egoPath;
        assert.equal(spawnSync('node',['--version']).error?.code,'ENOENT');
        if(mode==='revoked')f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});
        for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])await import(`../src/${name}.js`);
        let rounds=0;const observed={url:registry.chats.w.url,online:true,conversationMode:'normal',messagesComplete:true,inputReady:true,sendAvailable:true,generating:false,composerText:'',attachments:[],alerts:[],
          messages:[{id:'old-user',role:'user',text:'fixture'},{id:'old-assistant',role:'assistant',images:[],settled:null,nativeProvenanceVerified:false}]};
        const page={url:async()=>registry.chats.w.url,fill:async()=>assert.fail('no manual Send'),click:async()=>assert.fail('no manual Send'),evaluate:async fn=>fn.toString().includes('/api/auth/session')?'one':structuredClone(observed)};
        const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0],AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
        const run=await new AsyncFunction('registry','page','round',source+`
          const reg=registry;loadRuntime=async()=>({tasks:{},projects:{},sessions:{}});ensurePage=async()=>{round();return {page,task:{spaceId:7}};};
          listTaskSpaces=async()=>[{id:7,ownership:'agent'}];assertWebAvailable=async()=>{};detectWebRateLimit=async()=>{};
          applyDispatchModel=async(_,chat,model,effort)=>({model,effort,observed:{raw:'Pro'}});return runNativeImage;
        `)(registry,page,()=>{rounds++;});
        // Uses the real main coordinated spawnSync; no fixture transport override.
        if(mode==='local-owner'){
          const started=await run('start',prepared.payload);assert.equal(started.action,'MANUAL_SEND_REQUIRED');assert.equal(rounds,1);assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');
          const bytes=png(),sha256=createHash('sha256').update(bytes).digest('hex');await writeFile(started.originalPath,bytes,{mode:0o600});
          observed.messages.push({id:'new-user',role:'user',text:started.prompt},{id:'new-assistant',role:'assistant',images:[],settled:null,nativeProvenanceVerified:false});
          const assist={key,operatorRef:f.owner,path:started.originalPath,originalRef:started.originalRef,sha256,mimeType:'image/png',
            officialSave:{confirmed:true,relationshipConfirmed:true,route:r.route,requestDigest:r.requestDigest,attemptId:started.attemptId,userMessageId:'new-user',parentUserId:'new-user',turnId:'new-assistant',promptHash:createHash('sha256').update(started.prompt.replace(/\s+/g,' ').trim()).digest('hex')}};
          const next=spawnSync(process.execPath,[path.resolve('src/capabilities/image/chatgpt-ego.cli.js'),'prepare','assist-observe'],{env:clientEnv,encoding:'utf8',input:JSON.stringify(assist)});assert.equal(next.status,0,next.stderr);
          globalThis.__CHAT_BRIDGE_IMAGE_PREPARED__=JSON.parse(next.stdout);
          if(MAGICK){const settled=await run('assist-observe',assist);assert.equal(settled.mode,'ASSISTED');assert.equal(settled.nativeReady,false);assert.equal(settled.status,'GENERATED');}
          else {await assert.rejects(run('assist-observe',assist),/DECODE_UNAVAILABLE/);assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');}
        }
        else {await assert.rejects(run('start',prepared.payload),mode==='remote-origin'?/IMAGE_OPERATOR_HOST_OWNER_REQUIRED/:/EXPIRED_OR_REVOKED/);assert.equal(rounds,0);assert.equal(f.api.inspect(key).attempts.length,0);}
        assert.equal(process.env.CODEX_THREAD_ID,undefined);assert.equal(process.env.CHAT_BRIDGE_FROM_ACCOUNT_ID,undefined);
        assert.equal(process.env.CHAT_BRIDGE_IMAGE_DECODER,undefined);assert.equal(process.env.PATH,egoPath);
      }finally{await f.close();}
    }
  }finally{
    for(const name of globals){if(prior[name]===undefined)delete globalThis[name];else globalThis[name]=prior[name];}
    for(const name of names){if(priorEnv[name]===undefined)delete process.env[name];else process.env[name]=priorEnv[name];}
  }
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
    const source={artifactRef:output.artifactRef,sha256,revisionId:exported.outputRevisions[0].revisionId,jobId:r.jobId,outputId:output.outputId};
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
  const root={querySelectorAll:selector=>selector.includes('generated-image')?[]:[user,assistant]},form={querySelectorAll:()=>[]},composer=element({},''),send=element({tag:'BUTTON','data-testid':'send-button'});
  composer.closest=send.closest=selector=>selector==='form'?form:null;
  const values={document:{querySelector:selector=>selector==='main, [role="main"]'?root:selector.includes('prompt-textarea')?composer:null,
    querySelectorAll:selector=>selector.startsWith('form:has(')||selector==='button'?[send]:selector.includes('prompt-textarea')?[composer]:[]},location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},
    navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const prior=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true});
    const result=await inspectEgoImagePage({evaluate:async(fn,arg)=>fn(arg)});
    assert.equal(result.messagesComplete,true);assert.equal(result.messages[0].id,'dom-user');assert.equal(result.sendAvailable,true);
    assert.equal(result.messages[1].parentUserId,null);assert.equal(result.messages[1].nativeProvenanceVerified,false);
    assert.deepEqual(result.messages[1].images,[]);assert.equal(result.messages[1].settled,null);
    assert.doesNotMatch(JSON.stringify(result),/private\/thumbnail|generated original|Generated!/);
  }finally{for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('observed rich-unit repeated identical IDs are unambiguous; distinct, missing and duplicate rendered IDs stay incomplete',async()=>{
  const element=(attrs={},text='',children=[])=>({tagName:'DIV',innerText:text,textContent:text,
    getAttribute:name=>attrs[name]??null,getClientRects:()=>[{}],closest:()=>null,
    querySelector:selector=>selector==='[data-chatgpt-selection-message-id]'?children.find(child=>child.getAttribute('data-chatgpt-selection-message-id'))||null:null,
    querySelectorAll:()=>children});
  const unit=(key,ids,selected)=>element({'data-chatgpt-search-unit-key':key,'data-chatgpt-search-message-ids':ids},'fixture',
    selected?[element({'data-chatgpt-selection-message-id':selected})]:[]);
  let nodes=[];
  const root={querySelectorAll:selector=>selector.includes('data-chatgpt-search-unit-key')?nodes:[]};
  const values={document:{querySelector:selector=>selector==='main, [role="main"]'?root:null,querySelectorAll:()=>[]},
    location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const prior=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true});
    for(const mode of ['repeated-identical','distinct','missing','duplicate-rendered']) {
      nodes=[unit('fallback-turn-0:0:user','public-user-1'),unit('fallback-turn-0:2:assistant','public-assistant-1 public-assistant-1','public-assistant-1'),
        unit('fallback-turn-1:0:user','public-user-2'),unit('fallback-turn-1:1:assistant','public-assistant-2 public-assistant-2','public-assistant-2')];
      if(mode==='distinct')nodes[1]=unit('fallback-turn-0:2:assistant','public-assistant-1 other-distinct-id','public-assistant-1');
      if(mode==='missing')nodes[1]=unit('fallback-turn-0:2:assistant','');
      if(mode==='duplicate-rendered')nodes.push(nodes[1]);
      const result=await inspectEgoImagePage({evaluate:async(fn,arg)=>fn(arg)});
      assert.equal(result.messagesComplete,mode==='repeated-identical',mode);
      if(mode==='repeated-identical')assert.deepEqual(result.messages.map(({id,role})=>({id,role})),[
        {id:'public-user-1',role:'user'},{id:'public-assistant-1',role:'assistant'},{id:'public-user-2',role:'user'},{id:'public-assistant-2',role:'assistant'}]);
      for(const message of result.messages.filter(message=>message.role==='assistant')){
        assert.equal(message.parentUserId,null);assert.equal(message.nativeProvenanceVerified,false);assert.equal(message.settled,null);assert.deepEqual(message.images,[]);
      }
    }
  }finally{for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('public image-only wrappers join mixed message layouts in DOM order and keep ambiguous image identity incomplete',async()=>{
  // Extend the existing public-DOM fixture with ancestry and document order.
  // IDs come only from attributes; neither fixture order nor previews provide IDs.
  const matches=(node,selector)=>selector.split(',').some(part=>{
    const value=part.trim(),attribute=/^\[([^\s=$\]]+)(?:(\$?=)"([^"]*)")?\]$/.exec(value);
    if(!attribute) return node.tagName.toLowerCase()===value;
    const actual=node.getAttribute(attribute[1]);
    return actual!==null && (!attribute[2] || (attribute[2]==='$='?actual.endsWith(attribute[3]):actual===attribute[3]));
  });
  const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
  const element=(attrs={},text='',children=[])=>{
    const node={tagName:attrs.tag||'DIV',children,parentElement:null,innerText:text,textContent:text,disabled:false,
      getAttribute:name=>attrs[name]??null,getClientRects:()=>[{}],naturalWidth:1254,naturalHeight:1254,complete:true,
      querySelectorAll:selector=>{const found=descendants(node).filter(child=>matches(child,selector));return Object.assign({length:found.length,[Symbol.iterator]:()=>found.values()},found);},
      querySelector:selector=>node.querySelectorAll(selector)[0]||null,
      closest:selector=>{let current=node;while(current && !matches(current,selector))current=current.parentElement;return current;},
      contains:other=>{let current=other;while(current && current!==node)current=current.parentElement;return current===node;},
      compareDocumentPosition:other=>{let top=node;while(top.parentElement)top=top.parentElement;const order=[top,...descendants(top)];return order.indexOf(node)<order.indexOf(other)?4:2;},
    };
    for(const child of children)child.parentElement=node;
    return node;
  };
  let root;
  const values={document:{querySelector:selector=>selector==='main, [role="main"]'?root:null,querySelectorAll:()=>[]},
    location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const prior=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const imageId='73f067bf-47c0-47fa-a2ef-20ac32a6ed82',r=request(),attempt={attemptId:'attempt-fixture',baselineTurnIds:['old-user','old-assistant']};
  const good=['image-only','repeated-identical','nested-identical','nested-role-alias','input-thumbnail','composer-thumbnail','composer-role-thumbnail','composer-search-thumbnail','multiple-galleries'];
  try {
    for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true});
    for(const mode of [...good,'distinct-ids','duplicate-wrapper','nested-distinct','missing-id','missing-role','missing-turn','heading-after','unrelated-heading','intervening-user','conflicting-role','preview-only','hidden-gallery','selection-conflict','identity-conflict']) {
      const preview=()=>element({tag:'BUTTON','data-testid':'generated-image-preview','aria-label':'Generated image 1'},'',[
        element({tag:'IMG',alt:'generated original',src:'https://private/preview'})]);
      const gallery=()=>element({'data-testid':'generated-image-gallery',...(mode==='hidden-gallery'?{hidden:''}:{})},'',[preview()]);
      const ids=mode==='distinct-ids'?imageId+' other-id':mode==='repeated-identical'?imageId+' '+imageId:imageId;
      let group=element(mode==='missing-id'?{}:{'data-chatgpt-search-message-ids':ids},'',mode==='preview-only'?[preview()]:[gallery()]);
      if(mode==='identity-conflict')group=element({'data-message-id':'other-id','data-chatgpt-search-message-ids':ids},'',[gallery()]);
      if(mode==='multiple-galleries')group=element({'data-chatgpt-search-message-ids':ids},'',[gallery(),gallery()]);
      if(mode==='nested-identical'||mode==='nested-distinct')group=element({'data-chatgpt-search-message-ids':mode==='nested-distinct'?'other-id':imageId},'',[group]);
      if(mode==='nested-role-alias')group=element({'data-message-author-role':'assistant','data-message-id':imageId},'',[group]);
      if(mode==='conflicting-role')group=element({'data-message-author-role':'assistant','data-message-id':imageId},'',[
        element({'data-message-author-role':'user','data-message-id':imageId},'',[group])]);
      const heading=element({tag:'H4','data-conversation-role':'assistant'},'Localized role heading');
      let region=[heading,group];
      if(mode==='missing-role')region=[group];
      if(mode==='heading-after')region=[group,heading];
      if(mode==='unrelated-heading')region=[element({},'',[heading]),element({},'',[group])];
      if(mode==='intervening-user')region=[heading,element({'data-conversation-role':'user'}),group];
      if(mode==='duplicate-wrapper')region.push(element({'data-chatgpt-search-message-ids':imageId},'',[gallery()]));
      const input=mode==='input-thumbnail'?element({'data-chatgpt-search-message-ids':'input-thumbnail-id'},'',[gallery()]):null;
      const user=element({'data-chatgpt-search-unit-key':'fallback-turn-2:0:user','data-chatgpt-search-message-ids':'new-user'},imageExecutionPrompt(r,attempt.attemptId),
        [element({'data-content-search-unit-key':'fallback-turn-2:0:user'},imageExecutionPrompt(r,attempt.attemptId)),...(input?[input]:[])]);
      root=element({},'',[
        element({'data-message-author-role':'user','data-message-id':'old-user'},'Old prompt'),
        element({'data-chatgpt-search-unit-key':'fallback-turn-1:1:assistant','data-chatgpt-search-message-ids':'old-assistant old-assistant'},'',[
          element({'data-content-search-unit-key':'fallback-turn-1:1:assistant','data-chatgpt-selection-message-id':mode==='selection-conflict'?'other-id':'old-assistant'})]),
        element(mode==='missing-turn'?{}:{'data-content-search-turn-key':'fallback-turn-2'},'',[user,element({},'',region)]),
        ...(mode.startsWith('composer-')?[element({tag:'FORM'},'',[element({
          'data-chatgpt-search-message-ids':'composer-input-id',
          ...(mode==='composer-role-thumbnail'?{'data-message-author-role':'assistant'}:{}),
          ...(mode==='composer-search-thumbnail'?{'data-chatgpt-search-unit-key':'input-preview:assistant'}:{}),
        },'',[gallery()])])]:[]),
      ]);
      const result=await inspectEgoImagePage({evaluate:async(fn,arg)=>fn(arg)}),complete=good.includes(mode);
      assert.equal(result.messagesComplete,complete,mode);
      if(complete) {
        assert.equal(result.messagesIncompleteReason,null,mode);
        assert.deepEqual(result.messages.map(({id})=>id),['old-user','old-assistant','new-user',imageId],mode);
        const assistant=result.messages.at(-1);assert.equal(assistant.role,'assistant');assert.equal(assistant.parentUserId,null);
        assert.equal(assistant.nativeProvenanceVerified,false);assert.equal(assistant.settled,null);assert.deepEqual(assistant.images,[]);
        const observed={...snapshot(r),...result};
        assert.equal(classifyImageObservation({request:r,attempt,snapshot:observed}).reason,'IMAGE_PARENT_USER_UNVERIFIED');
      } else {
        assert.match(result.messagesIncompleteReason,/^IMAGE_DOM_/i,mode);
        if(mode==='hidden-gallery'||mode==='missing-turn')assert.equal(result.messages.some(message=>message.id===imageId),false);
        assert.throws(()=>assertImageSnapshot(r,{...snapshot(r),...result}),/IMAGE_TURN_EVIDENCE_INCOMPLETE/,mode);
      }
      assert.doesNotMatch(JSON.stringify(result),/private\/preview|generated original|Localized role heading/);
    }
  }finally{for(const [key,descriptor] of prior){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}}
});

test('actual public composer Send control is unique, visible, enabled and shares the single-click selector',async()=>{
  let selectors,controls=[],composers=[];
  const form={querySelectorAll:()=>[]},otherForm={querySelectorAll:()=>[]};
  const element=(attrs={},owner=form)=>({tagName:'BUTTON',disabled:attrs.disabled||false,
    getAttribute:name=>attrs[name]??null,getClientRects:()=>attrs.hidden?[]:[{}],innerText:'',textContent:'',
    closest:selector=>selector==='form'?owner:selector.includes('data-message-author-role')&&attrs.messageWidget?{}:null,
    querySelector:()=>null,querySelectorAll:()=>[]});
  const composer=element(),send=()=>element({'aria-label':'Send'});
  const matches=()=>controls.filter(button=>button.closest('form')!==null && !button.disabled && button.getAttribute('aria-disabled')!=='true' &&
    !button.closest('[data-message-author-role]') && (button.getAttribute('data-testid')==='send-button'||/^Send(?: prompt| message)?$/i.test(button.getAttribute('aria-label')||'')));
  const root={querySelectorAll:()=>[]};
  const values={document:{querySelector:selector=>selector==='main, [role="main"]'?root:null,
    querySelectorAll:selector=>selector===selectors?.sendSelector?matches():selector===selectors?.composerSelector?composers:selector==='button'?controls:[]},
    location:{href:'https://chatgpt.com/c/11111111-1111-1111-1111-111111111111'},navigator:{onLine:true},getComputedStyle:()=>({display:'block',visibility:'visible'})};
  const prior=new Map(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try {
    for(const [key,value] of Object.entries(values))Object.defineProperty(globalThis,key,{value,configurable:true});
    for(const mode of ['aria-send','legacy-testid','hidden','disabled','aria-disabled','ambiguous-control','message-widget','other-form','missing-composer','ambiguous-composer','admission-denied']) {
      controls=[send()];composers=[composer];
      if(mode==='legacy-testid')controls=[element({'data-testid':'send-button'})];
      if(['hidden','disabled','message-widget'].includes(mode))controls=[element({'aria-label':'Send',[mode==='message-widget'?'messageWidget':mode]:true})];
      if(mode==='aria-disabled')controls=[element({'aria-label':'Send','aria-disabled':'true'})];
      if(mode==='ambiguous-control')controls.push(element({'data-testid':'send-button'}));
      if(mode==='other-form')controls=[element({'aria-label':'Send'},otherForm)];
      if(mode==='missing-composer')composers=[];
      if(mode==='ambiguous-composer')composers.push(element({},otherForm));
      let clicks=0,attempts=0,gates=0;
      const page={evaluate:async(fn,arg)=>{selectors=arg;return fn(arg);},fill:async()=>{},press:async()=>assert.fail('no Enter fallback'),click:async selector=>{
        assert.equal(gates,1);assert.equal(attempts,1);assert.equal(selector,selectors.sendSelector);assert.match(selector,/^form:has\(/);assert.match(selector,/aria-label="Send"/);
        assert.equal(matches().length,1);assert.equal(matches()[0].closest('form'),form);clicks++;throw new Error('CLICK_TIMEOUT');
      }};
      const ui=createEgoImageUi({page,inspectNative:inspectEgoImagePage,assertOwnedRoute:async()=>{},selectResources:async()=>selection,
        onSendAttempt:()=>{attempts++;},assertSendAdmission:async()=>{gates++;if(mode==='admission-denied')throw new Error('CURRENT_AUTHORITY_DENIED');}});
      const allowed=['aria-send','legacy-testid','admission-denied'].includes(mode);
      assert.equal((await ui.inspect()).sendAvailable,allowed,mode);
      await assert.rejects(ui.sendOnce(),mode==='admission-denied'?/CURRENT_AUTHORITY_DENIED/:allowed?/CLICK_TIMEOUT/:/IMAGE_SEND_CONTROL_UNAVAILABLE/);
      assert.equal(clicks,allowed&&mode!=='admission-denied'?1:0,mode);assert.equal(attempts,clicks);assert.equal(gates,allowed?1:0);
    }
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

test('ordinary commands check real image occupancy with no Node on Ego PATH',async()=>{
  const f=await fixture(),names=['__CHAT_BRIDGE_NODE_EXECUTABLE__','__CHAT_BRIDGE_IMAGE_PREPARED__','__CHAT_BRIDGE_COORDINATOR_PATH__','__CHAT_BRIDGE_CONFIG_DIR__','__CHAT_BRIDGE_STATE_DIR__'];
  const prior=Object.fromEntries(names.map(name=>[name,globalThis[name]])),oldPath=process.env.PATH;
  try {
    Object.assign(globalThis,{__CHAT_BRIDGE_NODE_EXECUTABLE__:process.execPath,__CHAT_BRIDGE_IMAGE_PREPARED__:undefined,__CHAT_BRIDGE_COORDINATOR_PATH__:path.resolve('src/coordinator.py'),__CHAT_BRIDGE_CONFIG_DIR__:f.config,__CHAT_BRIDGE_STATE_DIR__:f.state});
    const python=spawnSync('python3',['-c','import sys; print(sys.executable)'],{env:f.env,encoding:'utf8'});assert.equal(python.status,0,python.stderr);
    const egoPath=path.join(f.root,'ordinary-ego-path');await mkdir(egoPath);await symlink(python.stdout.trim(),path.join(egoPath,'python3'));
    process.env.PATH=egoPath;assert.equal(spawnSync('node',['--version']).error?.code,'ENOENT');
    for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])await import(`../src/${name}.js`);
    const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0],AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const occupancy=await new AsyncFunction(source+'return imageSessionOccupancy;')();
    const registry={accounts:{a:{identity:'one'}}},chat={account:'a',id:'w'};
    assert.equal(occupancy(registry,chat).occupied,false);
    const {key,job}=f.setup();f.begin(key,job);
    assert.equal(occupancy(registry,chat).occupied,true);
  } finally {
    for(const name of names){if(prior[name]===undefined)delete globalThis[name];else globalThis[name]=prior[name];}
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    await f.close();
  }
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
      revisionId:exported.outputRevisions[0].revisionId,jobId:r.jobId,outputId:output.outputId};
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
test('real final Send/upload gates reject authority, route, draft, baseline and attachment changes after awaited inspection',async t=>{
  const injected=['__CHAT_BRIDGE_IMAGE_MODULE_PATH__','__CHAT_BRIDGE_STATE_DIR__'],prior=Object.fromEntries(injected.map(key=>[key,globalThis[key]]));
  const oldDecoder=process.env.CHAT_BRIDGE_IMAGE_DECODER;
  try {
    for(const mode of ['clean','revocation','composer-change','route-change','baseline-change','attachment-change','decoder-missing','upload-revocation']) {
      await t.test(mode,{skip:mode==='upload-revocation'&&!MAGICK},async()=>{
      const f=await fixture();try {
        const base=JSON.parse(f.sql("select payload from documents where kind='registry'")[0][0]),registry=structuredClone(base);
        const projectId='g-p-'+'1'.repeat(32),conversationId='11111111-1111-1111-1111-111111111111';
        Object.assign(registry.projects.P.bindings.a,{projectId,projectUrl:`https://chatgpt.com/g/${projectId}/project`});
        Object.assign(registry.chats.w,{conversationId,url:`https://chatgpt.com/g/${projectId}/c/${conversationId}`});
        const stored=spawnSync('python3',[path.resolve('src/state-store.py'),'put',f.config,f.state,'registry'],{env:f.env,encoding:'utf8',input:JSON.stringify({base,next:registry})});assert.equal(stored.status,0,stored.stderr);
        let r=f.request({route:{...f.request().route,projectId,conversationId}}),g=f.grant(r);
        const requiresSource=['upload-revocation','decoder-missing'].includes(mode);
        if(requiresSource)g.capabilities.features.export.mode='ASSISTED';
        let {key,job}=f.setup(r,g);
        if(requiresSource) {
          const ready=f.generated(key,f.begin(key,job)),bytes=png(),sha256=createHash('sha256').update(bytes).digest('hex');
          const io=await createHostImageArtifacts({api:f.api,key,stateDir:await realpath(f.state),decode,coordinated:f.call}),inbox=await io.prepareInbox();
          await writeFile(inbox.originalPath,bytes,{mode:0o600});
          await io.importOfficialOriginal({...inbox,path:inbox.originalPath,operatorRef:f.owner,sha256,outputId:'output-1',mimeType:'image/png',officialSave:{confirmed:true,requestDigest:r.requestDigest,attemptId:ready.attempts[0].attemptId,turnId:'new-assistant',outputId:'output-1',originalRef:inbox.originalRef,route:r.route}});
          const output=f.api.inspect(key).outputs[0],baseRevision={artifactRef:output.artifactRef,sha256:output.sha256,revisionId:f.api.result(key).outputRevisions[0].revisionId,jobId:r.jobId,outputId:output.outputId};
          r=f.request({jobId:'gate-edit',operation:'edit',route:r.route,inputs:[{...baseRevision,role:'source'}],baseRevision});g=f.grant(r,'gate-edit-grant');({key}=f.setup(r,g));
        }
        for(const name of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])await import(`../src/${name}.js`);
        globalThis.__CHAT_BRIDGE_IMAGE_MODULE_PATH__=path.resolve('src/capabilities/image/chatgpt-ego.js');globalThis.__CHAT_BRIDGE_STATE_DIR__=await realpath(f.state);
        if(mode==='decoder-missing'||!MAGICK)delete process.env.CHAT_BRIDGE_IMAGE_DECODER;
        else process.env.CHAT_BRIDGE_IMAGE_DECODER=MAGICK;
        const observed={url:registry.chats.w.url,online:true,conversationMode:'normal',messagesComplete:true,inputReady:true,sendAvailable:true,generating:false,composerText:'',attachments:[],alerts:[],
          messages:[{id:'old-user',role:'user',text:'fixture'},{id:'old-assistant',role:'assistant',parentUserId:null,images:[],settled:null,nativeProvenanceVerified:false,characterization:[]}]};
        let inspections=0,sends=0,uploads=0,pageUrl=observed.url;
        const page={url:async()=>pageUrl,fill:async(_,text)=>{observed.composerText=text;},click:async()=>{sends++;},setInputFiles:async()=>{uploads++;observed.attachments=[{accepted:true}];},waitForFunction:async()=>{},evaluate:async fn=>{
          if(fn.toString().includes('/api/auth/session'))return 'one';
          if(fn.toString().includes('data-chat-bridge-upload-target')){f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});return {count:1};}
          inspections++;
          if(inspections===5){
            if(mode==='revocation')f.call('image-revoke',{issuerRef:f.owner,grantId:g.grantId});
            if(mode==='composer-change')observed.composerText='current human draft';
            if(mode==='route-change')observed.url=pageUrl=`https://chatgpt.com/g/g-p-${'2'.repeat(32)}/c/22222222-2222-2222-2222-222222222222`;
            if(mode==='baseline-change')observed.messages.push({id:'intervening-user',role:'user',text:'other message'});
            if(mode==='attachment-change')observed.attachments=[{accepted:true}];
          }
          return structuredClone(observed);
        }};
        const source=(await readFile(path.resolve('src/main.js'),'utf8')).split('const cmd=args[0] || "help";')[0],AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
        const run=await new AsyncFunction('f','registry','page',source+`
          const reg=registry;coordinated=(...args)=>f.call(...args);loadRuntime=async()=>({tasks:{},projects:{},sessions:{}});
          ensurePage=async()=>({page,task:{spaceId:7}});listTaskSpaces=async()=>[{id:7,ownership:'agent'}];
          assertWebAvailable=async()=>{};detectWebRateLimit=async()=>{};applyDispatchModel=async(_,chat,model,effort)=>({model,effort,observed:{raw:'Pro'}});
          return runNativeImage;
        `)(f,registry,page);
        const payload={request:r,grantId:g.grantId,key,attemptId:'gate-attempt',eventId:'gate-begin'};
        if(mode==='upload-revocation')await assert.rejects(run('start',payload),/EXPIRED_OR_REVOKED/);
        else if(mode==='decoder-missing'){
          const result=await run('start',payload);assert.equal(result.status,'FAILED_PRE_SEND');assert.equal(result.reason,'IMAGE_DECODER_REQUIRED');assert.equal(result.retryAllowed,false);
        }
        else {const result=await run('start',payload);assert.equal(result.status,'SUBMISSION_UNKNOWN');}
        assert.equal(sends,mode==='clean'?1:0,mode);assert.equal(uploads,0,mode);
        if(mode==='decoder-missing'){
          const saved=f.api.inspect(key);assert.equal(saved.status,'FAILED_PRE_SEND');assert.equal(saved.attempts[0].status,'FAILED_PRE_SEND');
          assert.equal(f.api.sessionOccupancy({accountId:f.accountId,conversationId},key).occupied,false);
        }else{
          assert.equal(f.api.inspect(key).status,'SUBMISSION_UNKNOWN');
          const replay=await run('start',{...payload,attemptId:'different',eventId:'different'});assert.equal(replay.action,'RECONCILE_ONLY');assert.equal(sends,mode==='clean'?1:0);
        }
        if(mode==='composer-change')assert.equal(observed.composerText,'current human draft');
      }finally{await f.close();}
      });
    }
  }finally{
    for(const key of injected){if(prior[key]===undefined)delete globalThis[key];else globalThis[key]=prior[key];}
    if(oldDecoder===undefined)delete process.env.CHAT_BRIDGE_IMAGE_DECODER;else process.env.CHAT_BRIDGE_IMAGE_DECODER=oldDecoder;
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
  assert.doesNotMatch(cli,/taskSpace\(|page\.fetch\(/);
  assert.match(cli,/action==='recovery-authorize'[\s\S]*?payload\.grant\?\.kind==='OUTPUT_RECOVERY'[\s\S]*?coordinated\('image-authorize',payload\)/);
});
