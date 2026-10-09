import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

test('public external UNKNOWN projection is local, atomic, owner-preserving and fail-closed',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-external-status-')),config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const cid='11111111-1111-4111-8111-111111111111',owner='22222222-2222-4222-8222-222222222222';
  const task={taskId:'T',project:'P',account:'a',sessionId:cid,status:'RECOVERING',completionMode:'external',updatedAt:'2026-10-09T10:34:44.579Z',
    controllerSessionRef:owner,replyToSessionRef:owner,localOwner:null,originalMessage:'original research',baselineAssistantCount:1,baselineAssistantId:'ready',
    recoveryAttempts:2,totalRecoveryAttempts:2,lastRecoveryAt:'2026-10-09T10:34:44.579Z'};
  await writeFile(path.join(config,'registry.json'),JSON.stringify({accounts:{a:{identity:'one'}},projects:{P:{rootController:'root'}},
    chats:{[cid]:{id:cid,project:'P',account:'a',role:'worker',status:'active'},[owner]:{id:owner,project:'P',account:'a',role:'root',status:'active'}}}));
  await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{T:task},sessions:{},projects:{}}));
  const marker=path.join(root,'ego-called'),fake=path.join(root,'ego-browser');
  await writeFile(fake,`#!/bin/sh\necho called > '${marker}'\nexit 99\n`,{mode:0o755});
  const scope=createHash('sha256').update('identity:one').digest('hex'),lock=path.join(state,`ui-pacing-${scope}.lock`);
  await mkdir(lock);await writeFile(path.join(lock,'pid'),String(process.pid));
  await writeFile(path.join(state,`ui-pacing-${scope}.last`),String(Date.now()/1000));
  const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:''};
  const cli=path.resolve('bin/chat-bridge'),store=path.resolve('src/state-store.py');
  const args=['task','set-status','T','--status','UNKNOWN','--session',cid,'--project','P','--account','a','--expected-updated-at',task.updatedAt];
  const invoke=(a=args,extra={})=>spawnSync(cli,a,{env:{...env,...extra},encoding:'utf8',timeout:5000});
  const call=(command,payload)=>spawnSync('python3',[store,command,config,state,'runtime'],{encoding:'utf8',input:payload?JSON.stringify(payload):undefined});
  const read=()=>JSON.parse(call('peek').stdout);
  const reset=value=>{const base=read(),next=structuredClone(base);if(value)next.tasks.T=value;else delete next.tasks.T;const r=call('put',{base,next});assert.equal(r.status,0,r.stderr);};
  try {
    assert.equal(call('get').status,0);
    assert.equal(invoke(['control','status','--project','P']).status,0);
    for(const status of ['RUNNING','DISPATCHED','RECOVERING','UNKNOWN']) {
      reset({...task,status});const result=invoke();assert.equal(result.status,0,result.stderr);
      const actual=JSON.parse(result.stdout),saved=read().tasks.T;
      assert.deepEqual(actual,saved);assert.equal(saved.status,'UNKNOWN');
      for(const key of Object.keys(task).filter(k=>!['status','updatedAt'].includes(k)))assert.deepEqual(saved[key],task[key],key);
      if(status==='UNKNOWN')assert.equal(saved.updatedAt,task.updatedAt);
      const replay=[...args];replay[replay.indexOf('--expected-updated-at')+1]=saved.updatedAt;
      assert.equal(invoke(replay).status,0);assert.deepEqual(read().tasks.T,saved);
    }
    reset(task);
    for(const [flag,value] of [['--status','RUNNING'],['--session','rebound'],['--project','other'],['--account','other'],['--expected-updated-at','2020-01-01T00:00:00Z']]) {
      const changed=[...args];changed[changed.indexOf(flag)+1]=value;
      assert.equal(invoke(changed).status,2);assert.deepEqual(read().tasks.T,task);
    }
    for(const value of [null,...['COMPLETE','FAILED','CANCELLED','BLOCKED','RESULT_RECORDED'].map(status=>({...task,status})),{...task,completionMode:'durable'}]) {
      reset(value);assert.equal(invoke().status,2);assert.deepEqual(read().tasks.T,value||undefined);
    }
    reset(task);
    for(const extra of [{CHAT_BRIDGE_FROM_SPACE:'41'},{CHAT_BRIDGE_FROM_ACCOUNT_ID:scope},{CHAT_BRIDGE_FROM_ACCOUNT_ID:'wrong'}]) {
      assert.equal(invoke(args,extra).status,2);assert.deepEqual(read().tasks.T,task);
    }
    assert.equal(invoke([...args,'--caller-ref',cid],{CHAT_BRIDGE_FROM_ACCOUNT_ID:scope}).status,2);
    assert.equal(invoke([...args,'--caller-ref',owner],{CHAT_BRIDGE_FROM_ACCOUNT_ID:scope}).status,0);
    reset(task);
    const concurrent=()=>new Promise((resolve,reject)=>{
      const child=spawn(cli,args,{env});let stdout='',stderr='';
      child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
      child.on('close',status=>resolve({status,stdout,stderr}));
    });
    const results=await Promise.all([concurrent(),concurrent()]);
    assert.deepEqual(results.map(r=>r.status).sort(),[0,2]);
    assert.match(results.find(r=>r.status===2).stderr,/VERSION_CONFLICT/);
    assert.equal(read().tasks.T.status,'UNKNOWN');
    await assert.rejects(access(marker));
    await access(path.join(lock,'pid'));
  } finally {await rm(root,{recursive:true,force:true});}
});
