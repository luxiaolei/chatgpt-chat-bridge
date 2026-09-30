import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('local Codex owner survives restart, receives replayable results and alone can ACK', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-local-owner-'));
  const config=path.join(root,'config'), state=path.join(root,'state');
  await mkdir(config); await mkdir(state);
  const thread='11111111-1111-4111-8111-111111111111', callerRef='codex:'+thread;
  const worker=path.join(root,'worker');
  await writeFile(worker,'#!/bin/sh\nprintf \'{"delivered":true,"modelSelection":{"model":"Latest","effort":"High"}}\\n\'\n',{mode:0o755});
  await writeFile(path.join(config,'registry.json'),JSON.stringify({
    accounts:{a:{identity:'one'}},projects:{P:{bindings:{a:{projectUrl:'https://chatgpt.com/g/p/project'}}}},
    chats:{w:{id:'w',project:'P',account:'a',role:'worker',status:'active'},
      root:{id:'root',project:'P',account:'a',role:'conductor',status:'active'}}
  }));
  await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
  const env={...process.env,CODEX_THREAD_ID:thread,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:'',
    CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,CHAT_BRIDGE_BIN:worker,
    EGO_BROWSER_BIN:'/does-not-exist/no-browser-for-local-queue'};
  const raw=(command,payload,extra={})=>spawnSync(path.resolve('bin/chat-bridge'),['queue',command],{
    input:JSON.stringify(payload),encoding:'utf8',env:{...env,...extra}
  });
  const call=(command,payload,extra)=>{
    const r=raw(command,payload,extra);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
  };
  const fails=(command,payload,error,extra)=>{
    const r=raw(command,payload,extra);assert.equal(r.status,2,r.stdout);assert.match(r.stderr,error);
  };
  try {
    const input={callerRef,requestId:'local-1',taskId:'LOCAL-1',project:'P',sessionRef:'w',message:'bounded test',effort:'High'};
    fails('submit',input,/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:''});
    fails('submit',input,/LOCAL_CALLER_CONTEXT_MISMATCH/,{CHAT_BRIDGE_FROM_SPACE:'web'});
    fails('submit',{...input,project:undefined},/LOCAL_CALLER_REQUIRES_PROJECT_AND_SESSION/);
    fails('submit',{...input,sessionRef:undefined,role:'worker'},/LOCAL_CALLER_REQUIRES_PROJECT_AND_SESSION/);
    fails('submit',{...input,project:'foreign'},/PROJECT_NOT_REGISTERED/);
    const op=call('submit',input);
    assert.equal(op.localOwner.threadId,thread);
    assert.equal(op.localOwner.transport,'local-pull');
    assert.equal(call('submit',input).operationId,op.operationId);
    fails('submit',{...input,message:'changed'},/IDEMPOTENCY_CONFLICT/);
    fails('submit',input,/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222'});
    const contract={taskId:op.taskId,callerRef,project:'P',sessionRef:'w'};
    assert.deepEqual(call('local-owner-contract',contract),op.localOwner);
    fails('local-owner-contract',{...contract,project:'foreign'},/LOCAL_OWNER_CONTRACT_MISMATCH/);
    fails('local-owner-contract',{...contract,sessionRef:'root'},/LOCAL_OWNER_CONTRACT_MISMATCH/);
    const source=await readFile('src/main.js','utf8');
    const a=source.indexOf('function taskOwner('), z=source.indexOf('\nconst DEFAULT_ACCOUNT',a);
    const ownerFn=new Function('coordinated','resolveControllerTarget',source.slice(a,z)+';return taskOwner;')(
      call,()=>{throw Error('must not resolve local owner as web Chat');});
    assert.deepEqual(ownerFn({},op.taskId,'P','w',callerRef,callerRef),op.localOwner);
    assert.throws(()=>ownerFn({},op.taskId,'P','w',callerRef,'root'),/LOCAL_OWNER_TARGET_MISMATCH/);
    assert.equal(call('receive',{taskId:op.taskId,callerRef}).status,'PENDING');
    assert.equal(call('receive',{taskId:op.taskId,callerRef,waitSeconds:0.05}).status,'PENDING');
    fails('receive',{taskId:op.taskId,callerRef,waitSeconds:'NaN'},/WAIT_SECONDS/);
    fails('receive',{taskId:op.taskId,callerRef,waitSeconds:56},/WAIT_SECONDS/);
    assert.equal(call('work-one',{}).status,'SENT');
    // The immutable dispatch owner wins over a stale runtime projection.
    const store=spawnSync('python3',[path.resolve('src/state-store.py'),'put',config,state,'runtime'],{
      input:JSON.stringify({base:{tasks:{}},next:{tasks:{[op.taskId]:{taskId:op.taskId,project:'P',account:'a',
        sessionId:'w',controllerSessionRef:'root',replyToSessionRef:'root',status:'DISPATCHED'}}}}),encoding:'utf8'});
    assert.equal(store.status,0,store.stderr);
    const reported={taskId:op.taskId,status:'COMPLETE',summary:'verified local artifact',resultVersion:'1'};
    const report=call('result',reported);
    assert.equal(report.callbackStatus,'WAITING_LOCAL');
    assert.equal(report.callback,null);
    assert.equal(call('result',reported).eventId,report.eventId);
    fails('result',{...reported,summary:'changed'},/RESULT_VERSION_CONFLICT/);
    // A receiver can disappear between reporting and reading. No web fallback is generated.
    assert.equal(call('work-one',{}).status,'IDLE');
    const received=call('receive',{taskId:op.taskId,callerRef});
    assert.equal(received.status,'RESULT_AVAILABLE');
    assert.equal(received.summary,reported.summary);
    assert.equal(received.acceptanceStatus,null);
    assert.deepEqual(call('receive',{taskId:op.taskId,callerRef}),received);
    fails('receive',{taskId:op.taskId,callerRef:'root'},/LOCAL_RESULT_OWNER_MISMATCH/);
    fails('receive',{taskId:op.taskId,callerRef},/LOCAL_CALLER_CONTEXT_MISMATCH/,{CODEX_THREAD_ID:''});
    const ack={taskId:op.taskId,callerRef,resultVersion:'1',status:'ACCEPTED',message:'artifact checked'};
    fails('ack',{...ack,callerRef:'root'},/RESULT_ACK_TARGET_MISMATCH/);
    fails('ack',ack,/LOCAL_CALLER_CONTEXT_MISMATCH/,{CHAT_BRIDGE_FROM_ACCOUNT_ID:createHash('sha256').update('identity:one').digest('hex')});
    assert.equal(call('ack',ack).status,'ACCEPTED');
    assert.equal(call('ack',ack).idempotent,true);
    assert.equal(call('receive',{taskId:op.taskId,callerRef}).callbackStatus,'RECEIVED_LOCAL');
    assert.equal(call('list',{}).operations[0].taskStatus,'COMPLETE');
    fails('ack',{...ack,status:'REJECTED'},/RESULT_ALREADY_ACKED/);
    assert.equal(call('list',{}).operations.length,1);
  } finally {await rm(root,{recursive:true,force:true});}
});
