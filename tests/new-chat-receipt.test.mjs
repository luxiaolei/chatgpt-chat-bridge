import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('uncertain first creation keeps a non-routing original-operation candidate, holds only unresolved future creation, and preserves accepted/legacy UNKNOWN',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-new-receipt-')),config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const projectId='g-p-'+'a'.repeat(32),cid='11111111-1111-4111-8111-111111111111',uid='22222222-2222-4222-8222-222222222222';
  const projectUrl='https://chatgpt.com/g/'+projectId+'/project',afterUrl=projectUrl.replace('/project','/c/'+cid);
  const reg={accounts:{a:{identity:'one'},b:{identity:'two'}},projects:{P:{activeAccount:'a',bindings:{a:{projectId,projectUrl},b:{projectId,projectUrl}}}},
    chats:{controller:{id:'controller',project:'P',account:'a',role:'conductor',status:'active'}}};
  await writeFile(path.join(config,'registry.json'),JSON.stringify(reg));await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
  const worker=path.join(root,'fake-bridge'),receipt={ok:false,deliveryStage:'SEND_ATTEMPTED',code:'DELIVERY_UNCONFIRMED',
    nativeWitness:{format:'chatgpt-native-getText-v1',requestHash:'a'.repeat(64),bodyHash:'b'.repeat(64),accountIdentityHash:'c'.repeat(64),
      postSend:{phase:'POST_SEND_CONFIRMATION',beforeUrl:projectUrl,targetUrl:projectUrl,afterUrl,lastUserId:uid,sourceMessageId:null,
        sourceConversationId:null,missingCondition:'NATIVE_SOURCE_MESSAGE_ID_MISSING',sourceCondition:'UNOWNED_COPY_CONTROL',
        nativeBodyHash:'b'.repeat(64),nativeBodyLength:80,sourceBodyHash:null,observedAt:new Date().toISOString()}}};
  await writeFile(worker,'#!/bin/sh\nprintf '+JSON.stringify(JSON.stringify(receipt)+'\n')+'\nexit 1\n',{mode:0o755});
  const env={...process.env,CHAT_BRIDGE_BIN:worker,EGO_BROWSER_BIN:'/nonexistent/never-wake-ego'};
  for(const key of ['CHAT_BRIDGE_FROM_ACCOUNT_ID','CHAT_BRIDGE_FROM_SPACE','CODEX_THREAD_ID'])delete env[key];
  const invoke=(command,payload,...args)=>spawnSync('python3',[path.resolve('src/coordinator.py'),command,config,state,...args],
    {encoding:'utf8',input:payload?JSON.stringify(payload):undefined,env});
  const call=(command,payload,...args)=>{const r=invoke(command,payload,...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const sql=(code,...args)=>{const r=spawnSync('python3',['-c','import sqlite3,json,sys\nc=sqlite3.connect(sys.argv[1])\n'+code,path.join(state,'bridge.sqlite3'),...args],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return r.stdout;};
  const request={requestId:'first',callerRef:'controller',project:'P',account:'a',role:'worker',message:'PRIVATE_SYNTHETIC_REQUEST'};
  try{
    const op=call('submit',request),unknown=call('work-one');
    assert.equal(unknown.operationId,op.operationId);assert.equal(unknown.status,'DELIVERY_UNKNOWN');assert.equal(unknown.sessionRef,null);
    const candidate=unknown.uncertainNewSession;
    assert.equal(candidate?.format,'uncertain-new-session-v1');
    assert.equal(candidate.operationId,op.operationId);assert.equal(candidate.taskId,op.taskId);
    assert.equal(candidate.observedConversationId,cid);assert.equal(candidate.observedUrl,afterUrl);
    assert.equal(candidate.routable,false);assert.equal(candidate.deliveryConfirmed,false);assert.equal(candidate.postSendIdentityVerified,false);
    assert.equal(candidate.sourceMessageId,null);assert.equal(candidate.lastUserId,uid);
    assert.equal(candidate.callerRef,'controller');assert.equal(candidate.role,'worker');
    assert.equal(JSON.stringify(candidate).includes('PRIVATE_SYNTHETIC_REQUEST'),false);
    assert.equal(call('submit',request).operationId,op.operationId); // Idempotent readback, no resend.
    call('configure',{type:'account',accountId:op.accountId,shortName:'A',acceptNewTasks:false,maxActiveTasks:2});
    const {account:_account,...unboundRequest}=request;
    const blocked=invoke('submit',{...unboundRequest,requestId:'second-account-b'});
    assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/ROLE_CREATION_UNCONFIRMED/);
    const otherAffinity=call('submit',{...unboundRequest,requestId:'different-existing-affinity',affinityKey:'other'});
    assert.equal(otherAffinity.status,'QUEUED');call('cancel',null,otherAffinity.operationId);
    assert.equal(call('status',null,op.operationId).status,'DELIVERY_UNKNOWN');
    const stored=JSON.parse(await readFile(path.join(config,'registry.json'),'utf8'));
    assert.deepEqual(Object.keys(stored.chats),['controller']);
    // Seed an already-authorized owner acceptance in this isolated fixture only.
    sql("c.execute(\"INSERT INTO task_results(task_id,result_version,event_id,status,summary,payload_hash,recorded_at,acceptance_status,owner_ref) VALUES (?,?,?,?,?,?,?,?,?)\",(sys.argv[2],'v1','accepted-fixture','COMPLETE','synthetic result','hash','2026-10-04T00:00:00Z','ACCEPTED','controller'))\nc.commit()",op.taskId);
    const next=call('submit',{...unboundRequest,requestId:'after-owner-acceptance'});
    assert.equal(next.status,'QUEUED');assert.equal(next.account,'b');call('cancel',null,next.operationId);
    assert.deepEqual(call('status',null,op.operationId),unknown); // Acceptance does not rewrite transport uncertainty.
    sql("r=json.loads(c.execute('SELECT result FROM operations WHERE id=?',(sys.argv[2],)).fetchone()[0]);r.pop('newSession');c.execute('UPDATE operations SET result=? WHERE id=?',(json.dumps(r),sys.argv[2]));c.execute('DELETE FROM task_results');c.commit()",op.operationId);
    const legacyBefore=call('status',null,op.operationId);
    const legacyNext=call('submit',{...unboundRequest,requestId:'legacy-unknown-is-not-backfilled'});
    assert.equal(legacyNext.status,'QUEUED');
    assert.deepEqual(call('status',null,op.operationId),legacyBefore);
  }finally{await rm(root,{recursive:true,force:true});}
});
