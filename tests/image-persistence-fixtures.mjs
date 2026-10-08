import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {normalizeImageRequest,classifyImageCapabilities,imageJobKey,createImageJobAPI} from '../src/capabilities/image/contract.js';

export async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),'image-persistence-')),config=path.join(root,'config'),state=path.join(root,'state');
 await mkdir(config);await mkdir(state);
 const thread='11111111-1111-4111-8111-111111111111',owner='codex:'+thread,accountId=createHash('sha256').update('identity:one').digest('hex');
 const projectId='g-p-'+'1'.repeat(32);
 const registry={accounts:{a:{identity:'one'},a2:{identity:'one'},b:{identity:'two'}},projects:{P:{bindings:Object.fromEntries(['a','a2'].map(a=>[a,{projectId,projectUrl:`https://chatgpt.com/g/${projectId}/project`,profileId:'fixture-profile'}]))}},chats:{w:{id:'w',project:'P',account:'a',role:'worker',status:'active'},'w-alias':{id:'w',conversationId:'w',project:'P',account:'a2',role:'worker-alias',status:'active'},root:{id:'root',project:'P',account:'a',role:'conductor',status:'active'}}};
 await writeFile(path.join(config,'registry.json'),JSON.stringify(registry));await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
 const worker=path.join(root,'worker');await writeFile(worker,'#!/bin/sh\nprintf \'{"delivered":true,"modelSelection":{"model":"Latest","effort":"Pro"}}\\n\'\n',{mode:0o755});
 const env={...process.env,CODEX_THREAD_ID:thread,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:'',CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,CHAT_BRIDGE_BIN:worker,EGO_BROWSER_BIN:'/nonexistent/no-browser-in-image-tests'};
 const coordinator=path.resolve('src/coordinator.py');
 const raw=(command,payload,extra={})=>spawnSync('python3',[coordinator,command,config,state],{encoding:'utf8',input:JSON.stringify(payload),env:{...env,...extra}});
 const call=(command,payload,extra)=>{const r=raw(command,payload,extra);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const fail=(command,payload,error,extra)=>{const r=raw(command,payload,extra);assert.equal(r.status,2,r.stdout+r.stderr);assert.match(r.stderr,error);};
 const callAsync=async(command,payload,extra={})=>{
   const child=execFile('python3',[coordinator,command,config,state],{encoding:'utf8',env:{...env,...extra}});
   child.stdin.end(JSON.stringify(payload));
   return await new Promise(resolve=>{let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('close',code=>resolve({code,out,err}));});
 };
 const op=call('submit',{callerRef:owner,requestId:'controller-1',taskId:'controller-1',project:'P',sessionRef:'w',message:'OFFLINE CONTROL ONLY: initialize image target and reply READY, not a terminal result. Do not issue an image prompt.',model:'Latest',effort:'Pro'});
 assert.equal(call('work-one',{}).status,'SENT');
 const request=(patch={})=>normalizeImageRequest({jobId:'image-1',operation:'generate',caller:{kind:'chat',ref:'w'},scope:{tenantId:'t1',namespace:'design',purpose:'offline-test',workgroupId:null},controllerTaskId:op.taskId,route:{project:'P',projectId,accountAlias:'a',accountId,sessionRef:'w',conversationId:'w'},prompt:'synthetic square fixture',budget:{maxAttempts:2,maxOutputs:2,maxDurationMs:600000,deadlineAt:new Date(Date.now()+3600000).toISOString(),allowPaidApi:false},authorizedOutput:{targetRef:'store:t1',retentionHours:24},requestedModel:'Latest',requestedEffort:'Pro',...patch});
 const capabilities=r=>classifyImageCapabilities(r.route,{version:'offline-fixture/v1',observedAt:new Date(Date.now()-1000).toISOString(),modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true},features:Object.fromEntries(['generate','edit','refine','export','batch'].map(f=>[f,{mode:'NATIVE',evidence:['artifact:fixture:probe']}]))});
 const grant=(r,id='grant-1',patch={})=>({grantId:id,controllerOperationId:op.operationId,controllerTaskId:op.taskId,request:r,sourceExternalizationAuthorized:true,expiresAt:r.budget.deadlineAt,capabilities:capabilities(r),...patch});
 const authorize=g=>call('image-authorize',{issuerRef:owner,grant:g});
 const api=createImageJobAPI({coordinated:call});
 const setup=(r=request(),g=grant(r))=>{authorize(g);return {r,g,key:imageJobKey(r,g.grantId),job:api.submit(r,{grantId:g.grantId})};};
 const begin=(key,job,id='attempt-1')=>api.beginAttempt(key,{eventId:'start-'+id,expectedRevision:job.revision,attemptId:id,baselineTurnIds:['old-user','old-assistant'],modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true}});
 const generated=(key,job,ids=['output-1'],status='GENERATED')=>api.record(key,{eventId:'obs-'+job.revision,expectedRevision:job.revision,attemptId:job.attempts.at(-1).attemptId,route:job.route,status,userMessageId:'new-user',turnId:'new-assistant',candidateOutputIds:ids,evidenceRef:'artifact:fixture:new-turn'});
 const output=(job,id='output-1',patch={})=>({outputId:id,jobId:job.jobId,attemptId:job.attempts.at(-1).attemptId,turnId:'new-assistant',artifactRef:'artifact:t1:'+id,sha256:'d'.repeat(64),mimeType:'image/png',byteLength:123,width:16,height:16,sourceHashes:job.request.inputs.map(i=>i.sha256),parentOutputId:job.request.baseRevision?.outputId ?? null,baseRevisionId:job.request.baseRevision?.revisionId ?? null,capabilityVersion:job.attempts.at(-1).capabilities.version,capabilityObservedAt:job.attempts.at(-1).capabilities.observedAt,warnings:[],validation:{status:'VERIFIED',verifierVersion:'synthetic-test-only/v1',checkedAt:new Date().toISOString(),checks:{magic:true,mime:true,decode:true,hash:true,count:true}},...patch});
 const exported=(key,job,outputs=[output(job)])=>api.export(key,{eventId:'export-'+job.revision,expectedRevision:job.revision,attemptId:job.attempts.at(-1).attemptId,route:job.route,outputs,evidenceRef:'artifact:fixture:original-byte-checks'});
 const sql=query=>{const r=spawnSync('python3',['-c','import sqlite3,sys,json; d=sqlite3.connect(sys.argv[1]); print(json.dumps(d.execute(sys.argv[2]).fetchall())); d.commit()',path.join(state,'bridge.sqlite3'),query],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};

 const control=sub=>{const r=spawnSync('python3',[coordinator,'control',config,state,sub,'--project','P','--confirm'],{encoding:'utf8',env});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
 const putRuntime=next=>{const base=JSON.parse(sql("select payload from documents where kind='runtime'")[0][0]);const r=spawnSync('python3',[path.resolve('src/state-store.py'),'put',config,state,'runtime'],{encoding:'utf8',input:JSON.stringify({base,next}),env});assert.equal(r.status,0,r.stderr);};
 const cooldown=async active=>{const dir=path.join(state,'web-cooldowns');await mkdir(dir,{recursive:true});const file=path.join(dir,accountId+'.json');if(active)await writeFile(file,JSON.stringify({until:new Date(Date.now()+60000).toISOString()}));else await rm(file,{force:true});};
 return {control,putRuntime,cooldown,root,config,state,env,owner,op,accountId,raw,call,callAsync,fail,api,request,capabilities,grant,authorize,setup,begin,generated,output,exported,sql,close:()=>rm(root,{recursive:true,force:true})};
}
