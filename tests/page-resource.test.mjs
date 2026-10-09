import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import {openAttempt} from '../src/delivery-attempt.mjs';
const coordinator=path.resolve('src/coordinator.py'),store=path.resolve('src/state-store.py');
const home='https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/project',scope=crypto.createHash('sha256').update('identity:one').digest('hex');
async function fixture(mode='UNKNOWN') {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-resource-')),config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const binding={account:'a',projectUrl:home,spaceName:'managed',spaceId:9,profileId:'P1'};
  const registry={accounts:{a:{identity:'one'}},projects:{P:{activeAccount:'a',bindings:{a:binding}}},chats:{owner:{id:'owner',project:'P',account:'a',role:'conductor',status:'active'}}};
  await writeFile(path.join(config,'registry.json'),JSON.stringify(registry));await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
  const worker=path.join(root,'worker'),count=path.join(root,'count');
  await writeFile(worker,`#!/bin/sh\nprintf x >> '${count}'\nprintf '%s\\n' '{"ok":false,"code":"CAPACITY_WAIT","deliveryStage":"PRE_SEND","allocationState":"${mode}","pageCleanup":{"state":"${mode}","targetId":"target-one"}}'\nexit 1\n`,{mode:0o755});
  const run=(command,payload,...args)=>spawnSync('python3',[coordinator,command,config,state,...args],{encoding:'utf8',input:payload?JSON.stringify(payload):undefined,env:{...process.env,CHAT_BRIDGE_BIN:worker}});
  const call=(command,payload,...args)=>{const r=run(command,payload,...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  call('list');
  const target={project:'P',account:'a',accountId:scope,spaceName:'managed',spaceId:9,profileId:'P1',page:'p9',targetId:'target-one',url:home,purpose:'MANAGEMENT_TERMINATION'};
  const payload={account:'a',resourceTarget:target,confirm:true};
  const put=(kind,next)=>{const r=spawnSync('python3',[store,'peek',config,state,kind],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);const saved=spawnSync('python3',[store,'put',config,state,kind],{encoding:'utf8',input:JSON.stringify({base:JSON.parse(r.stdout),next})});assert.equal(saved.status,0,saved.stderr);};
  const rawOperation=id=>{const r=spawnSync('python3',['-c','import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row; print(json.dumps(dict(c.execute("SELECT * FROM operations WHERE id=?",(sys.argv[2],)).fetchone()),sort_keys=True))',path.join(state,'bridge.sqlite3'),id],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;};
  return {root,config,state,registry,call,run,target,payload,put,rawOperation,count,worker};
}
test('allocation UNKNOWN or retained target cannot become a capacity retry on this or the next tick',async()=>{
  for(const mode of ['UNKNOWN','RETAINED']) {
    const f=await fixture(mode);try{
      const op=f.call('submit',{requestId:'original',callerRef:'owner',project:'P',account:'a',role:'worker',message:'synthetic'});
      assert.equal(f.call('work-one').status,'DELIVERY_UNKNOWN');
      const raw=f.rawOperation(op.operationId);assert.ok(raw.includes(mode));assert.ok(raw.includes('target-one'));
      assert.equal(f.call('work-one').status,'IDLE');assert.equal((await readFile(f.count,'utf8')).length,1);
      assert.equal(f.rawOperation(op.operationId),raw);
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
});
test('exact resource termination preserves legacy UNKNOWN; lost close ACK fences every subsequent attempt',async()=>{
  const f=await fixture();try{
    const op=f.call('submit',{requestId:'legacy',callerRef:'owner',project:'P',account:'a',role:'worker',message:'synthetic'});f.call('work-one');
    const legacy=spawnSync('python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE operations SET reclaim_route=NULL WHERE id=?',(sys.argv[2],)); c.commit()",path.join(f.state,'bridge.sqlite3'),op.operationId],{encoding:'utf8'});assert.equal(legacy.status,0,legacy.stderr);
    const original=f.rawOperation(op.operationId),ctx=f.call('page-reclaim-context',f.payload);
    assert.equal(ctx.unboundAny,true);assert.equal(ctx.resourceRelease.allowed,true);
    assert.equal(f.call('page-reclaim-context',{...f.payload,confirm:false}).resourceRelease.allowed,false);
    const intent=f.call('page-release-record',{...f.payload,phase:'INTENT'});
    assert.equal((await stat(intent.path)).mode&0o777,0o600);
    assert.equal(f.call('page-release-status',f.payload).phase,'INTENT');
    assert.equal(f.call('page-reclaim-context',f.payload).resourceRelease.allowed,false);
    assert.equal(f.call('page-reclaim-context',{...f.payload,releaseIntent:intent}).resourceRelease.allowed,true);
    f.call('page-release-record',{...f.payload,releaseIntent:intent,phase:'UNKNOWN',data:{closeAttempted:true}});
    assert.equal(f.call('page-release-status',f.payload).phase,'UNKNOWN');
    assert.equal(f.call('page-reclaim-context',{...f.payload,releaseIntent:intent}).resourceRelease.allowed,false);
    assert.notEqual(f.run('page-release-record',{...f.payload,phase:'INTENT'}).status,0);
    assert.equal(f.rawOperation(op.operationId),original);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('ensure blocks replacement of a disappeared target after uncertain close but permits confirmed release or refusal',async()=>{
  const source=await readFile('src/main.js','utf8'),start=source.indexOf('async function ensurePage'),end=source.indexOf('\nfunction hashText',start),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  for(const phase of ['INTENT','UNKNOWN','REFUSED','RELEASED']) {
    const f=await fixture();try{
      const intent=f.call('page-release-record',{...f.payload,phase:'INTENT'});
      if(phase!=='INTENT') f.call('page-release-record',{...f.payload,releaseIntent:intent,phase,data:{closeAttempted:phase!=='REFUSED',closeAcknowledged:true,targetAbsent:true}});
      const chat={id:'11111111-1111-4111-8111-111111111111',project:'P',account:'a',url:home.replace('/project','/c/11111111-1111-4111-8111-111111111111'),page:'p9',pageTargetId:'target-one',spaceId:9,pageSpaceId:9,spaceName:'managed',profileId:'P1'};
      const page={label:'new-page',targetId:'new-target',goto:async()=>{},url:async()=>chat.url};let opens=0,creates=0;
      const ensure=await new AsyncFunction('coordinated','accountScope','openBoundTask','pagesOf','newManagedPage','waitForConversationReady','sameConversationUrl','saveRegistry','handoffAllocatedPage',source.slice(start,end)+';return ensurePage;')(
        f.call,()=>scope,async()=>{opens++;return {binding:f.registry.projects.P.bindings.a,task:{spaceId:9}};},async()=>[],async()=>{creates++;return {page};},async()=>{},(a,b)=>a===b,async()=>{},async()=>{});
      if(['INTENT','UNKNOWN'].includes(phase)) {
        await assert.rejects(()=>ensure(f.registry,chat),/PAGE_TARGET_RELEASE_FENCED/);assert.equal(opens,0);assert.equal(creates,0);
      } else { await ensure(f.registry,chat);assert.equal(opens,1);assert.equal(creates,1);assert.equal(chat.pageTargetId,'new-target'); }
    }finally{await rm(f.root,{recursive:true,force:true});}
  }
});
test('direct allocation has immutable provenance and cannot clean an attached or paused target',async()=>{
  const f=await fixture();try{
    const data={allocationOrdinal:1,project:'P',account:'a',accountId:scope,spaceId:9,spaceName:'managed',profileId:'P1',projectUrl:null};
    const requestId='ensure-one';f.call('page-allocation-record',{requestId,phase:'ALLOCATION_INTENT',data});
    assert.notEqual(f.run('page-allocation-record',{requestId,phase:'ALLOCATION_INTENT',data}).status,0);
    f.call('page-allocation-record',{requestId,phase:'PAGE_ALLOCATED',data:{...data,page:'p9',targetId:'target-one'}});
    const payload={account:'a',resourceTarget:{...f.target,url:'https://chatgpt.com/',purpose:'OWNED_TEMPORARY',allocatedHere:true,requestId,allocationOrdinal:1,projectUrl:null}};
    assert.equal(f.call('page-reclaim-context',payload).resourceRelease.allowed,true);
    const drift={...payload,resourceTarget:{...payload.resourceTarget,targetId:'replacement'}};
    assert.equal(f.call('page-reclaim-context',drift).resourceRelease.allowed,false);
    const reg=structuredClone(f.registry);reg.projects.P.bindings.a.controlPage='p9';f.put('registry',reg);
    assert.equal(f.call('page-reclaim-context',payload).resourceRelease.reason,'PHYSICAL_TARGET_CONTROL_PAGE');
    f.put('registry',f.registry);f.put('runtime',{tasks:{},projects:{P:{watchdogPausedForUserControl:true}}});
    assert.equal(f.call('page-reclaim-context',payload).resourceRelease.reason,'PHYSICAL_TARGET_PAUSED');
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('terminal original task never grants release after another task has reused its target',async()=>{
  const f=await fixture();try{
    const cid='11111111-1111-4111-8111-111111111111',chat={id:cid,project:'P',account:'a',role:'worker',status:'active',url:home.replace('/project','/c/'+cid),page:'p9',pageTargetId:'target-one',spaceId:9,spaceName:'managed',profileId:'P1',attachmentEpoch:1};
    const reg=structuredClone(f.registry);reg.chats[cid]=chat;f.put('registry',reg);
    f.put('runtime',{tasks:{A:{taskId:'A',sessionId:cid,project:'P',account:'a',status:'COMPLETE'},B:{taskId:'B',sessionId:cid,project:'P',account:'a',status:'QUEUED'}}});
    const payload={account:'a',candidate:chat,resourceTarget:{...f.target,url:chat.url,purpose:'TERMINAL_ALLOCATION'}};
    assert.equal(f.call('page-reclaim-context',payload).resourceRelease.reason,'PHYSICAL_TARGET_EXECUTION_PROTECTED');
    const changed=structuredClone(reg);changed.chats[cid].attachmentEpoch=2;f.put('registry',changed);
    assert.equal(f.call('page-reclaim-context',payload).resourceRelease.reason,'PHYSICAL_TARGET_ATTACHMENT_CHANGED');
    f.put('runtime',{tasks:{A:{taskId:'A',sessionId:cid,project:'P',account:'a',status:'COMPLETE'}}});
    for(const patch of [c=>{delete c.pageTargetId;},c=>{delete c.profileId;},c=>{c.spaceId=8;}]) {
      reg.chats[cid]={...chat};patch(reg.chats[cid]);f.put('registry',reg);
      const legacy={...payload,candidate:reg.chats[cid]};
      assert.equal(f.call('page-reclaim-context',legacy).resourceRelease.reason,'PHYSICAL_TARGET_ALLOCATION_UNPROVEN');
      assert.notEqual(f.run('page-release-record',{...legacy,phase:'INTENT'}).status,0);
    }
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('a newly allocated completed target can be released while old unbound UNKNOWN remains unchanged',async()=>{
  const f=await fixture();try {
    const cid='22222222-2222-4222-8222-222222222222';
    await writeFile(f.worker,'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify({ok:true,id:cid,delivered:true})+'\n')+');\n',{mode:0o755});
    const op=f.call('submit',{requestId:'new-allocation',callerRef:'owner',project:'P',account:'a',role:'new-worker',message:'synthetic'});
    assert.equal(f.call('work-one').status,'SENT');
    const directory=path.join(await realpath(f.state),'delivery-attempts',op.operationId,'1'),raw=await readFile(path.join(directory,'manifest.json'));
    const journal=await openAttempt(f.state,{format:'chat-bridge-delivery-attempt-v1',operationId:op.operationId,claimOrdinal:1,directory,manifestSha256:crypto.createHash('sha256').update(raw).digest('hex')});
    await journal.record('PAGE_ALLOCATED',{allocationOrdinal:1,project:'P',account:'a',accountId:scope,spaceId:9,spaceName:'managed',profileId:'P1',page:'p9',targetId:'target-one'});
    await journal.record('SCRIPT_FINISHED',{succeeded:true});
    const chat={id:cid,project:'P',account:'a',role:'new-worker',status:'active',url:home.replace('/project','/c/'+cid),page:'p9',pageTargetId:'target-one',spaceId:9,spaceName:'managed',profileId:'P1',attachmentEpoch:1};
    const reg=structuredClone(f.registry);reg.chats[cid]=chat;f.put('registry',reg);
    f.put('runtime',{tasks:{[op.taskId]:{taskId:op.taskId,sessionId:cid,project:'P',account:'a',role:'new-worker',status:'RESULT_RECORDED'}}});
    const old=f.call('submit',{requestId:'old-unknown',callerRef:'owner',project:'P',account:'a',role:'old-worker',message:'old synthetic'});
    const legacy=spawnSync('python3',['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN',reclaim_route=NULL WHERE id=?\",(sys.argv[2],)); c.commit()",path.join(f.state,'bridge.sqlite3'),old.operationId],{encoding:'utf8'});assert.equal(legacy.status,0,legacy.stderr);
    const original=f.rawOperation(old.operationId),payload={account:'a',candidate:chat,resourceTarget:{...f.target,url:chat.url,purpose:'TERMINAL_ALLOCATION'}};
    const decision=f.call('page-reclaim-context',payload);assert.equal(decision.unboundAny,true);assert.equal(decision.resourceRelease.allowed,true,JSON.stringify(decision.resourceRelease));
    const intent=f.call('page-release-record',{...payload,phase:'INTENT'});
    f.call('page-release-record',{...payload,releaseIntent:intent,phase:'RELEASED',data:{closeAttempted:true,closeAcknowledged:true,targetAbsent:true}});
    assert.equal(f.rawOperation(old.operationId),original);
  }finally{await rm(f.root,{recursive:true,force:true});}
});

test('direct scope fences end only at a certain refusal, recorded handoff or confirmed release',async()=>{
 const f=await fixture();try{
  const data={allocationOrdinal:1,project:'P',account:'a',accountId:scope,spaceId:9,spaceName:'managed',profileId:'P1',projectUrl:home};
  const record=(requestId,phase,value=data)=>f.call('page-allocation-record',{requestId,phase,data:value});
  record('refused','ALLOCATION_INTENT');record('refused','ALLOCATION_REFUSED');
  record('owned','ALLOCATION_INTENT');const allocated={...data,page:'p9',targetId:'target-one'};record('owned','PAGE_ALLOCATED',allocated);
  assert.notEqual(f.run('page-allocation-record',{requestId:'next',phase:'ALLOCATION_INTENT',data}).status,0);
  record('owned','PAGE_HANDED_OFF',allocated);record('next','ALLOCATION_INTENT');record('next','ALLOCATION_REFUSED');
  record('retained','ALLOCATION_INTENT');record('retained','PAGE_ALLOCATED',{...allocated,targetId:'target-two'});
  record('retained','PAGE_RELEASE_UNKNOWN',{...allocated,targetId:'target-two',closeAttempted:false,state:'RETAINED'});
  assert.notEqual(f.run('page-allocation-record',{requestId:'after-retained',phase:'ALLOCATION_INTENT',data}).status,0);
  const payload={...f.payload,resourceTarget:{...f.target,targetId:'target-two'}};
  const intent=f.call('page-release-record',{...payload,phase:'INTENT'});f.call('page-release-record',{...payload,releaseIntent:intent,phase:'RELEASED',data:{closeAttempted:true,closeAcknowledged:true,targetAbsent:true}});
  record('after-retained','ALLOCATION_INTENT');
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test('direct journal rejects dot path components without creating stage files',async()=>{
 const f=await fixture();try{
  const data={allocationOrdinal:1,project:'P',account:'a',accountId:scope,spaceId:9,spaceName:'managed',profileId:'P1',projectUrl:home};
  for(const requestId of ['.','..']) {
   const r=f.run('page-allocation-record',{requestId,phase:'ALLOCATION_INTENT',data});assert.notEqual(r.status,0);assert.match(r.stderr,/PAGE_ALLOCATION_REQUEST_INVALID/);
  }
  await assert.rejects(stat(path.join(f.state,'page-allocations')),e=>e.code==='ENOENT');
 }finally{await rm(f.root,{recursive:true,force:true});}
});
