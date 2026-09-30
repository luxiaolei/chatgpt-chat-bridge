import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dispatchNative} from '../src/native-codex.mjs';

const workerThread='22222222-2222-4222-8222-222222222222';

test('native adapter validates target, catalog and busy state before start; unknown send is not retried',async()=>{
  const target={host:hostname(),threadId:workerThread,cwd:process.cwd(),socket:'/unused'};
  for(const scenario of ['good','busy','foreign','model','effort','cwd','unknown']) {
    const calls=[];
    const client={close(){},async rpc(method,p){
      calls.push(method);
      if(method==='thread/read')return {thread:{id:workerThread,cwd:scenario==='cwd'?'/tmp':process.cwd(),originator:scenario==='foreign'?'codex_desktop':'chat_bridge_native',status:{type:scenario==='busy'?'active':'idle'},canAcceptDirectInput:true,model:'gpt-6-astra',reasoningEffort:'xhigh'}};
      if(method==='model/list')return {data:[{model:'gpt-6-astra',supportedReasoningEfforts:[{reasoningEffort:'xhigh'}]}]};
      if(method==='turn/start') {assert.equal(p.clientUserMessageId,'op');if(scenario==='unknown')throw Error('LOST_RESPONSE');return {turn:{id:'turn'}};}
      throw Error(method);
    }};
    const receipt=await dispatchNative({nativeTarget:target,operationId:'op',message:'hello',model:scenario==='model'?'not-available':'gpt-6-astra',effort:scenario==='effort'?'ultra':'xhigh'},async()=>client);
    assert.equal(calls.filter(m=>m==='turn/start').length,['good','unknown'].includes(scenario)?1:0);
    if(scenario==='good') {assert.equal(receipt.turnId,'turn');assert.equal(receipt.modelSelection.executionObserved,false);}
    else assert.equal(receipt.deliveryStage,scenario==='unknown'?'SEND_ATTEMPTED':'PRE_SEND');
  }
});

test('native queue is durable, isolated from Web pools, pause-aware, correlated, and owner ACK is separate',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-native-'));
  const config=path.join(root,'config'),state=path.join(root,'state'),socket=path.join(root,'native.sock');
  await mkdir(config);await mkdir(state);
  await writeFile(path.join(config,'registry.json'),JSON.stringify({projects:{P:{name:"P"}},chats:{},accounts:{}}));
  await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
  const fake=path.join(root,'codex'),saved=path.join(root,'turn.json');
  await writeFile(fake,`#!/usr/bin/env node
const fs=require('fs'),input=JSON.parse(process.argv[3]);
let turn;try{turn=JSON.parse(fs.readFileSync(process.env.NATIVE_SAVED))}catch{}
let receipt;
if(input.action==='send') {
 turn={turnId:'native-turn',message:input.message,clientUserMessageId:input.operationId,status:'inProgress'};
 fs.writeFileSync(process.env.NATIVE_SAVED,JSON.stringify(turn));
 if(process.env.NATIVE_DROP==='1')process.exit(1);
 receipt={ok:true,delivered:true,turnId:turn.turnId,clientUserMessageId:input.operationId,nativeTarget:input.nativeTarget};
} else if(input.action==='read') {
 receipt=turn?.message===input.message&&turn.clientUserMessageId===input.operationId?{ok:true,delivered:true,turnId:turn.turnId,turnStatus:turn.status,assistantText:'native evidence',clientUserMessageId:input.operationId}:{ok:false,code:'NATIVE_TURN_NOT_PROVEN',deliveryStage:'PRE_SEND'};
} else if(input.action==='cancel') {
 if(input.turnId!==turn.turnId)process.exit(3);
 turn.status='interrupted';fs.writeFileSync(process.env.NATIVE_SAVED,JSON.stringify(turn));receipt={ok:true,interruptRequested:true,turnId:turn.turnId};
} else throw Error(input.action);
console.log(JSON.stringify(receipt));
`,{mode:0o755});
  const owner='11111111-1111-4111-8111-111111111111',callerRef='codex:'+owner;
  const env={...process.env,CODEX_THREAD_ID:owner,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:'',CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,CHAT_BRIDGE_NODE_BIN:fake,NATIVE_SAVED:saved,NATIVE_CWD:root,EGO_BROWSER_BIN:'/never-wake-ego'};
  const raw=(cmd,payload,args=[],extra={})=>spawnSync(path.resolve('bin/chat-bridge'),['queue',cmd,...args],{input:JSON.stringify(payload),encoding:'utf8',env:{...env,...extra}});
  const call=(cmd,payload,args=[],extra={})=>{const r=raw(cmd,payload,args,extra);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const input={requestId:'native-1',callerRef,project:'P',runtime:'codex',nativeHost:hostname(),nativeThread:workerThread,nativeCwd:root,nativeSocket:socket,message:'Bounded work',taskId:'NATIVE-1'};
  try {
    const op=call('submit',input);assert.equal(op.runtime,'codex');assert.equal(op.requestedModel,'gpt-6-astra');assert.equal(op.requestedEffort,'xhigh');
    assert.equal(call('submit',input).operationId,op.operationId);
    assert.match(raw('submit',{...input,requestId:'second',taskId:'NATIVE-2'}).stderr,/TARGET_SESSION_BUSY/);
    call('control',null,['pause','--project','P','--confirm']);
    assert.equal(call('work-one',{}).reason,'ADMISSION_PAUSED');
    call('control',null,['resume','--project','P','--confirm']);
    // Reset only test admission delay, without waiting five seconds.
    spawnSync('python3',['-c','import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute("UPDATE operations SET not_before=0");d.commit()',path.join(state,'bridge.sqlite3')]);
    const sent=call('work-one',{});assert.equal(sent.status,'SENT');assert.equal(sent.turnId,'native-turn');
    const observed=call('native-read',null,[op.operationId]);assert.equal(observed.assistantText,'native evidence');assert.equal(observed.turnId,sent.turnId);
    assert.equal(call('native-cancel',null,[op.operationId,'--confirm']).interruptRequested,true);
    assert.equal(call('native-read',null,[op.operationId]).turnStatus,'interrupted');
    const report={taskId:op.taskId,status:'COMPLETE',summary:'artifact checked'};
    assert.match(raw('result',report).stderr,/NATIVE_RESULT_WORKER_MISMATCH/);
    assert.equal(call('result',report,[],{CODEX_THREAD_ID:workerThread}).callbackStatus,'WAITING_LOCAL');
    const received=call('receive',{taskId:op.taskId,callerRef});assert.equal(received.acceptanceStatus,null);
    assert.equal(call('ack',{taskId:op.taskId,callerRef,status:'ACCEPTED',resultVersion:'1'}).status,'ACCEPTED');
    assert.equal(call('status',null,[op.operationId]).taskStatus,'COMPLETE');
    assert.deepEqual(JSON.parse(await readFile(path.join(config,'registry.json'),'utf8')).chats,{});
    assert.deepEqual(JSON.parse(await readFile(path.join(state,'runtime.json'),'utf8')).tasks,{});
    const selectedChoice={id:'native',runtime:'codex',model:'gpt-6-astra',effort:'xhigh',nativeHost:hostname(),nativeThread:workerThread,nativeCwd:root,nativeSocket:socket};
    const advice={version:1,messageSha256:createHash('sha256').update(input.message).digest('hex'),choiceId:'native',selectedChoice,choices:[selectedChoice],reason:'Authorized candidate'};
    const routingAdvicePath=path.join(root,'advice.json');await writeFile(routingAdvicePath,JSON.stringify(advice));
    const nextInput={...input,requestId:'uncertain',taskId:'NATIVE-2',model:'gpt-6-astra',effort:'xhigh',routingAdvicePath};
    assert.match(raw('submit',{...nextInput,message:'changed'}).stderr,/ROUTING_ADVICE_MISMATCH/);
    assert.match(raw('submit',{...nextInput,model:'gpt-6-luna'}).stderr,/ROUTING_ADVICE_MISMATCH/);
    const next=call('submit',nextInput);
    assert.equal(next.routingAdvice.advice.choiceId,'native');assert.match(next.routingAdvice.receiptSha256,/^[a-f0-9]{64}$/);
    assert.equal(call('submit',nextInput).operationId,next.operationId);
    assert.equal(call('work-one',{},[],{NATIVE_DROP:'1'}).status,'DELIVERY_UNKNOWN');
    assert.equal(call('work-one',{}).status,'IDLE');
    assert.equal(call('reconcile',null,['--operation',next.operationId]).outcome,'RECONCILED_DELIVERED');
    assert.equal(call('status',null,[next.operationId]).turnId,'native-turn');
  } finally {await rm(root,{recursive:true,force:true});}
});
