import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';

for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy','event-journal'])
  await import(`../src/${file}.js`);
const source=(await readFile(new URL('../src/main.js',import.meta.url),'utf8')).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const progress={taskId:'T',project:'P',role:'worker',status:'COMPLETE',github:'https://example/T',updatedAt:'2026-09-30T00:00:00Z'};

function fixture() {
  return {calls:[],events:[],reg:{defaultAccount:'new',accounts:{new:{identity:'new-login'},owner:{identity:'owner-login'}},
    projects:{P:{activeAccount:'new',rootController:'00-g',lifecycle:{autoReconcile:true,minGapSec:0},
      bindings:{new:{projectUrl:'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/project'},owner:{projectUrl:'https://chatgpt.com/g/g-p-fedcba9876543210fedcba9876543210/project'}}}},
    chats:{root:{id:'root',project:'P',account:'owner',role:'00-g',status:'active',url:'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111'}}},
    runtime:{tasks:{T:{...progress}},projects:{P:{}},sessions:{}}};
}
async function harness(f) {
  return new AsyncFunction('f',source+`
    const reg=f.reg;
    loadRuntime=async()=>{if((f.loads=(f.loads||0)+1)===f.loadFailAt)throw new Error('STATE_READ_DEFERRED');return structuredClone(f.runtime);};
    saveRuntime=async value=>{if((f.saves=(f.saves||0)+1)===f.saveFailAt || f.saveAlwaysFail)throw new Error('STATE_STORE_DEFERRED');f.runtime=structuredClone(value);};
    assertWebAvailable=async account=>{f.calls.push(['cooldown',account]);};
    ensurePage=async(_reg,chat,options)=>{f.calls.push(['page',chat.id,options]);if(f.pause){const e=new Error('user control');e.code='SPACE_IN_USER_CONTROL';throw e;}return {page:{}};};
    observeSession=async()=>({inputReady:true,generating:false,composerCount:1,composerRawText:f.observed?.composerText||'',sessionState:'IDLE_COMPLETE',...f.observed});
    sendMessage=async(_page,message)=>{f.calls.push(['send',message]);f.markerAtSend=structuredClone(f.runtime.projects.P.pendingReconcileEvent);if(f.deliveryError||f.preSendError){const e=new Error('DELIVERY_UNCONFIRMED');e.code='DELIVERY_UNCONFIRMED';e.deliveryStage=f.preSendError?'PRE_SEND':'SEND_ATTEMPTED';throw e;}return {delivered:true};};
    emitTaskEvent=async(task,type,data)=>f.emit?f.emit(task,type,data):(f.events.push({taskId:task.taskId,type,data}),{cursor:'event-'+f.events.length});
    coordinated=(command,payload)=>{f.calls.push([command,payload]);return f.coordinate?f.coordinate(command,payload):{status:'QUEUED',operationId:'op'};};
    detachTerminalTaskPages=async()=>[];
    pruneManagedOrphanTabs=async()=>[];
    return {maybeNotifyProjectReconcile,notifyController,watchProject:watchOnce,gradedRecover};
  `)(f);
}
const sent=f=>f.calls.filter(([kind])=>kind==='send');

test('legacy reconcile uses the existing unique root on its actual account',async()=>{
  const f=fixture(),api=await harness(f);
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'SENT');
  assert.deepEqual(f.calls.find(([kind])=>kind==='cooldown'),['cooldown','owner']);
  assert.equal(f.runtime.projects.P.lastReconcileNotification.ownerSessionRef,'root');
  assert.equal(await api.maybeNotifyProjectReconcile(f.reg,'P'),null);
  assert.equal(sent(f).length,1);
});

test('account-scoped watchdog visits the legacy owner lane instead of activeAccount',async()=>{
  const f=fixture(),api=await harness(f);
  const results=await api.watchProject(f.reg,'P','owner',{skipTasks:true});
  assert.equal(results[0]?.projectLifecycle.state,'SENT');
  assert.equal(sent(f).length,1);
});

test('persisted task owner and archived committed successor win over duplicate root roles',async()=>{
  const f=fixture();
  f.runtime.tasks.T.replyToSessionRef='old';
  f.reg.chats.old={id:'old',project:'P',account:'new',role:'00-g',status:'archived',successorSessionRef:'root'};
  f.reg.chats.other={id:'other',project:'P',account:'new',role:'00-g',status:'active'};
  const api=await harness(f),out=await api.maybeNotifyProjectReconcile(f.reg,'P');
  assert.equal(out.ownerSessionRef,'root');
  assert.equal(sent(f).length,1);
});

test('explicit account never migrates a persisted owner',async()=>{
  const f=fixture();f.runtime.tasks.T.controllerSessionRef='root';
  const api=await harness(f),out=await api.maybeNotifyProjectReconcile(f.reg,'P','new');
  assert.equal(out.state,'OWNER_ACCOUNT_MISMATCH');
  assert.equal(sent(f).length,0);
  assert.equal(f.calls.length,0);
});

test('zero, multiple, missing exact, foreign and cyclic owners refuse without root fallback',async()=>{
  for(const mode of ['zero','multiple','missing','foreign','cycle','sibling']) {
    const f=fixture();
    if(mode==='zero') f.reg.chats={};
    if(mode==='multiple') f.reg.chats.other={...f.reg.chats.root,id:'other',account:'new'};
    if(mode==='missing') f.runtime.tasks.T.replyToSessionRef='missing';
    if(mode==='foreign') {f.runtime.tasks.T.replyToSessionRef='foreign';f.reg.chats.foreign={...f.reg.chats.root,id:'foreign',project:'Q',successorSessionRef:'root'};}
    if(mode==='cycle') {f.runtime.tasks.T.replyToSessionRef='old';f.reg.chats.old={id:'old',project:'P',status:'archived',successorSessionRef:'old'};}
    if(mode==='sibling') {f.runtime.tasks.T.replyToSessionRef='root';f.reg.chats.root.workgroupId='B';}
    const api=await harness(f),out=await api.maybeNotifyProjectReconcile(f.reg,'P');
    assert.notEqual(out.state,'SENT',mode);
    assert.equal(sent(f).length,0,mode);
    assert.equal(f.calls.length,0,mode);
  }
});

test('group reconcile follows its exact successor and ignores running sibling work',async()=>{
  const f=fixture();
  f.reg.projects.P.workgroups={A:{controllerSessionRef:'old'},B:{controllerSessionRef:'sibling'}};
  f.reg.chats.old={id:'old',project:'P',status:'archived',successorSessionRef:'root'};
  f.reg.chats.root.workgroupId='A';
  f.runtime.tasks.T.workgroupId='A';
  f.runtime.tasks.B={taskId:'B',project:'P',workgroupId:'B',status:'RUNNING'};
  const api=await harness(f),out=await api.maybeNotifyProjectReconcile(f.reg,'P',null,'A');
  assert.equal(out.state,'SENT');
  assert.equal(out.ownerSessionRef,'root');
  assert.equal(await api.maybeNotifyProjectReconcile(f.reg,'P',null,'B'),null);
  assert.equal(await api.maybeNotifyProjectReconcile(f.reg,'P'),null);
  assert.equal(f.runtime.projects.P.lastReconcileNotification,undefined);
  assert.equal(f.runtime.tasks.B.status,'RUNNING');
});

test('generating, draft, input-unready and user-controlled owners remain unsent',async()=>{
  for(const observed of [{generating:true},{composerText:'human draft'},{inputReady:false}]) {
    const f=fixture();f.reg.projects.P.activeAccount='owner';f.observed=observed;
    const out=await (await harness(f)).maybeNotifyProjectReconcile(f.reg,'P');
    assert.equal(out.state,'ROOT_BUSY');assert.equal(sent(f).length,0);
  }
  const f=fixture();f.reg.projects.P.activeAccount='owner';f.pause=true;
  const api=await harness(f);
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'USER_CONTROLLED');
  f.pause=false;f.calls=[];
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'USER_CONTROLLED');
  assert.equal(f.calls.length,0);
  assert.equal(f.runtime.projects.P.watchdogPausedForUserControl,true);
});

test('exact Web notification delegates original ownership and successor routing to coordinator',async()=>{
  const f=fixture(),task={...progress,sessionId:'worker',controllerSessionRef:'retired-owner',account:'new'};
  const api=await harness(f),out=await api.notifyController(f.reg,task,'owner notice');
  assert.equal(out.queued,true);
  assert.equal(f.calls[0][0],'callback');
  assert.equal(f.calls[0][1].targetRef,'retired-owner');
});

test('group and owner task pauses stay local and local lifecycle owners never fall back to Web',async()=>{
  for(const mode of ['group','owner','local']) {
    const f=fixture();f.runtime.tasks.T.controllerSessionRef='root';
    if(mode==='group') {
      f.reg.projects.P.workgroups={A:{controllerSessionRef:'root'}};
      f.runtime.tasks.T.workgroupId='A';
      f.runtime.projects.P.workgroups={A:{watchdogPausedForUserControl:true}};
    }
    if(mode==='owner') f.runtime.tasks.owner={taskId:'owner',project:'P',sessionId:'root',role:'00-g',status:'BLOCKED',watchdogPausedForUserControl:true};
    if(mode==='local') f.runtime.tasks.T.controllerSessionRef='codex:11111111-1111-4111-8111-111111111111';
    const out=await (await harness(f)).maybeNotifyProjectReconcile(f.reg,'P',null,mode==='group'?'A':null);
    assert.equal(out.state,mode==='local'?'LOCAL_OWNER_REQUIRES_PULL':'USER_CONTROLLED');
    assert.equal(f.calls.length,0);
  }
});

test('unconfirmed lifecycle delivery retains its event and never retries on a later scan',async()=>{
  const f=fixture();f.deliveryError=true;
  const api=await harness(f),first=await api.maybeNotifyProjectReconcile(f.reg,'P');
  assert.equal(first.state,'DELIVERY_UNCONFIRMED');
  assert.equal(f.runtime.projects.P.lastReconcileProgressAt,undefined);
  assert.equal(f.runtime.projects.P.pendingReconcileEvent.deliveryStage,'SEND_ATTEMPTED');
  f.deliveryError=false;
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'DELIVERY_UNCONFIRMED');
  assert.equal(sent(f).length,1);
});

test('lifecycle reserves its attempted event before Send and state failures cannot duplicate it',async()=>{
  for(const mode of ['reservation-save','receipt-save','receipt-read']) {
    const f=fixture();f.loads=0;f.saves=0;
    if(mode==='reservation-save') f.saveFailAt=1;
    if(mode==='receipt-save') f.saveFailAt=2;
    if(mode==='receipt-read') f.loadFailAt=2;
    const api=await harness(f),first=await api.maybeNotifyProjectReconcile(f.reg,'P');
    if(mode==='reservation-save') {assert.equal(first.state,'NOT_SENT');assert.equal(sent(f).length,0);}
    else {
      assert.equal(first.state,'DELIVERY_UNCONFIRMED',mode);
      assert.equal(f.markerAtSend.deliveryStage,'SEND_ATTEMPTED');
      assert.equal(f.markerAtSend.attemptedOwnerSessionRef,'root');
      assert.equal(f.markerAtSend.attemptedTargetUrl,f.reg.chats.root.url);
      assert.equal(f.markerAtSend.eventKey,first.eventKey);
    }
    const second=await api.maybeNotifyProjectReconcile(f.reg,'P');
    assert.equal(second.state,mode==='reservation-save'?'SENT':'DELIVERY_UNCONFIRMED',mode);
    assert.equal(sent(f).length,1,mode);
  }
  const f=fixture();f.saveAlwaysFail=true;
  const failure=await (await harness(f)).maybeNotifyProjectReconcile(f.reg,'P');
  assert.match(failure.error,/STATE_STORE_DEFERRED/);assert.equal(failure.deliveryStage,'PRE_SEND');
  assert.equal(sent(f).length,0);
});

test('only an explicit pre-send failure releases the lifecycle attempt reservation',async()=>{
  const f=fixture();f.preSendError=true;
  const api=await harness(f);
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'NOT_SENT');
  assert.notEqual(f.runtime.projects.P.pendingReconcileEvent.deliveryStage,'SEND_ATTEMPTED');
  f.preSendError=false;
  assert.equal((await api.maybeNotifyProjectReconcile(f.reg,'P')).state,'SENT');
});

test('unconfirmed watchdog continuation blocks the existing task instead of recovering it again',async()=>{
  const f=fixture();f.deliveryError=true;f.observed={sessionState:'IDLE_INCOMPLETE'};
  f.reg.projects.P.lifecycle.autoReconcile=false;
  f.reg.chats.worker={id:'worker',project:'P',account:'new',role:'worker',status:'active'};
  Object.assign(f.runtime.tasks.T,{status:'RUNNING',sessionId:'worker',account:'new',controllerSessionRef:'root'});
  const api=await harness(f);
  await api.watchProject(f.reg,'P','new',{skipLifecycle:true});
  assert.equal(f.runtime.tasks.T.status,'BLOCKED');
  assert.equal(f.runtime.tasks.T.blockedReason,'DELIVERY_UNCONFIRMED');
  f.deliveryError=false;
  await api.watchProject(f.reg,'P','new',{skipLifecycle:true});
  assert.equal(sent(f).length,1);
});

test('local owner notices use replayable local events without Web delivery or acceptance',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-owner-notice-'));
  const config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const f=fixture(),thread='11111111-1111-4111-8111-111111111111',ref='codex:'+thread;
  f.reg.projects.P.lifecycle.autoReconcile=false;
  f.reg.chats.worker={id:'worker',project:'P',account:'new',role:'worker',status:'active'};
  await writeFile(path.join(config,'registry.json'),JSON.stringify(f.reg));
  await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},projects:{},sessions:{}}));
  const env={...process.env,CODEX_THREAD_ID:thread,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:'',EGO_BROWSER_BIN:'/no-ego'};
  const call=(command,payload)=>{
    const r=spawnSync('python3',[path.resolve('src/coordinator.py'),command,config,state],{encoding:'utf8',input:JSON.stringify(payload),env});
    assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  try {
    const op=call('submit',{callerRef:ref,project:'P',sessionRef:'worker',requestId:'local-notice',taskId:'LOCAL-NOTICE',message:'bounded fixture'});
    f.coordinate=call;
    f.emit=(task,type,data)=>globalThis.__CHAT_BRIDGE_EVENTS__.appendEvent(state,{project:task.project,account:task.account,taskId:task.taskId,type,data});
    const task={taskId:op.taskId,project:'P',account:'new',sessionId:'worker',controllerSessionRef:ref,replyToSessionRef:ref,localOwner:op.localOwner,watchdogPendingNotification:'owner notice'};
    const api=await harness(f),out=await api.notifyController(f.reg,task,'owner notice');
    assert.equal(out.status,'RECORDED_LOCAL');
    assert.equal(out.sent,false);assert.equal(out.queued,false);assert.equal(out.recorded,true);
    assert.equal(out.target,ref);assert.equal(out.receiptSupported,false);
    assert.equal(task.watchdogPendingNotification,undefined);
    const again=await api.notifyController(f.reg,structuredClone(task),'owner notice');
    assert.equal(again.eventCursor,out.eventCursor);
    const rows=globalThis.__CHAT_BRIDGE_EVENTS__.listEvents;
    assert.equal((await rows(state,{project:'P',account:'new'})).length,1);
    const localRead=()=>JSON.parse(execFileSync('python3',[path.resolve('src/local-query.py'),'event-list',config,state,'--project','P','--account','new','--type','CONTROLLER_NOTICE_LOCAL'],{encoding:'utf8',env}));
    assert.deepEqual(localRead(),localRead());
    assert.equal(localRead().events[0].data.ownerRef,ref);
    assert.deepEqual(call('list',{}).operations.map(x=>x.kind),['dispatch']);
    assert.equal(call('receive',{taskId:op.taskId,callerRef:ref}).status,'PENDING');
    assert.equal(f.calls.some(([kind])=>kind==='callback'),false);
    assert.equal(sent(f).length,0);
    const wrongProject=await api.notifyController(f.reg,{...task,project:'Q'},'foreign project');
    assert.match(wrongProject.failures[0].reason,/LOCAL_OWNER_CONTRACT_MISMATCH/);
    const wrongHost=await api.notifyController(f.reg,{...task,localOwner:{...task.localOwner,host:'foreign'}},'foreign host');
    assert.match(wrongHost.failures[0].reason,/LOCAL_OWNER_TARGET_MISMATCH/);
    const invalid=await api.notifyController(f.reg,{...task,replyToSessionRef:'root'},'mismatch');
    assert.equal(invalid.recorded,undefined);assert.equal(invalid.sent,false);
    assert.equal((await rows(state,{project:'P',account:'new'})).length,1);
    delete task.replyToSessionRef;
    task.stallNoticeAttemptAt='2026-10-01T12:00:00Z';
    assert.equal((await api.notifyController(f.reg,task,'owner notice')).recorded,true);
    assert.equal((await rows(state,{project:'P',account:'new'})).length,2);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('preflight admits only the actual legacy owner account, including successor',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-owner-preflight-'));
  const config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const f=fixture();f.runtime.tasks.T.controllerSessionRef='old';
  f.reg.chats.old={id:'old',project:'P',account:'new',role:'00-g',status:'archived',successorSessionRef:'root'};
  const script=path.resolve('src/web-preflight.py');
  const run=account=>execFileSync('python3',[script,'watch',config,state,'watch','--project','P','--skip-tasks','--account',account],{encoding:'utf8'}).trim();
  try {
    await writeFile(path.join(config,'registry.json'),JSON.stringify(f.reg));
    await writeFile(path.join(state,'runtime.json'),JSON.stringify(f.runtime));
    assert.equal(run('owner'),'1');assert.equal(run('new'),'0');
    for(const mode of ['zero','missing','multiple','foreign','cycle','owner-paused','sibling','local','unconfirmed']) {
      const invalid=fixture();
      if(mode==='zero') invalid.reg.chats={};
      if(mode==='missing') invalid.runtime.tasks.T.replyToSessionRef='missing';
      if(mode==='multiple') invalid.reg.chats.other={...invalid.reg.chats.root,id:'other',account:'new'};
      if(mode==='foreign') {invalid.runtime.tasks.T.replyToSessionRef='foreign';invalid.reg.chats.foreign={...invalid.reg.chats.root,id:'foreign',project:'Q'};}
      if(mode==='cycle') {invalid.runtime.tasks.T.replyToSessionRef='cycle';invalid.reg.chats.cycle={...invalid.reg.chats.root,id:'cycle',status:'archived',successorSessionRef:'cycle'};}
      if(mode==='owner-paused') invalid.runtime.tasks.owner={taskId:'owner',project:'P',sessionId:'root',role:'00-g',status:'BLOCKED',watchdogPausedForUserControl:true};
      if(mode==='sibling') invalid.reg.chats.root.workgroupId='B';
      if(mode==='local') invalid.runtime.tasks.T.controllerSessionRef='codex:11111111-1111-4111-8111-111111111111';
      if(mode==='unconfirmed') invalid.runtime.projects.P.pendingReconcileEvent={deliveryStage:'SEND_ATTEMPTED'};
      await writeFile(path.join(config,'registry.json'),JSON.stringify(invalid.reg));
      await writeFile(path.join(state,'runtime.json'),JSON.stringify(invalid.runtime));
      assert.equal(run('owner'),'0',mode);assert.equal(run('new'),'0',mode);
    }
    const worker=path.join(root,'watch');await writeFile(worker,'#!/bin/sh\nprintf \'%s\\n\' "$@"\n',{mode:0o755});
    await writeFile(path.join(config,'registry.json'),JSON.stringify(f.reg));
    await writeFile(path.join(state,'runtime.json'),JSON.stringify(f.runtime));
    const args=execFileSync('python3',[script,'watch-all',config,state,worker,'watch','--project','P'],{encoding:'utf8'});
    assert.match(args,/--account\nowner\n/);
    f.runtime.tasks.T.controllerSessionRef=undefined;
    await writeFile(path.join(state,'runtime.json'),JSON.stringify(f.runtime));
    assert.equal(run('owner'),'1');assert.equal(run('new'),'0');
  } finally {await rm(root,{recursive:true,force:true});}
});
