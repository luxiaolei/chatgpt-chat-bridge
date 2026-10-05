import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {openAttempt} from '../src/delivery-attempt.mjs';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const op='11111111-1111-4111-8111-111111111111';
async function fixture(){
  const state=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'bridge-attempt-')));
  const directory=path.join(state,'delivery-attempts',op,'1');await fs.mkdir(directory,{recursive:true,mode:0o700});
  const body='exact full instruction\n尾部🧪\n';
  const manifest={format:'chat-bridge-delivery-attempt-v1',operationId:op,claimOrdinal:1,messageSha256:sha(body)};
  const raw=JSON.stringify(manifest)+'\n';await fs.writeFile(path.join(directory,'manifest.json'),raw,{mode:0o600});
  return {state,directory,body,descriptor:{format:manifest.format,operationId:op,claimOrdinal:1,directory,manifestSha256:sha(raw)}};
}

test('same-claim evidence is private and a restarted writer cannot arm another Send',async()=>{
  const f=await fixture();
  try{
    const journal=await openAttempt(f.state,f.descriptor);
    await journal.record('BEFORE_INPUT',{lastUserId:'old'},f.body);
    await journal.record('INPUT_VERIFIED',{bodyHash:sha(f.body)});
    await journal.record('SEND_INTENT',{control:'click'});
    const restarted=await openAttempt(f.state,f.descriptor);
    await assert.rejects(()=>restarted.record('SEND_INTENT',{}),e=>e.code==='DELIVERY_ATTEMPT_ALREADY_RECORDED'&&e.deliveryStage==='SEND_ATTEMPTED');
    const files=await fs.readdir(f.directory);assert.equal(files.filter(n=>n.includes('SEND_INTENT')).length,1);
    const st=await fs.stat(path.join(f.directory,'40-SEND_INTENT.json'));assert.equal(st.mode&0o777,0o600);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('wrong full body, wrong path, changed manifest and public directory are rejected before evidence writes',async()=>{
  const f=await fixture();
  try{
    const j=await openAttempt(f.state,f.descriptor);
    await assert.rejects(()=>j.record('BEFORE_INPUT',{},f.body.trim()),/MESSAGE_MISMATCH/);
    await assert.rejects(()=>openAttempt(f.state,{...f.descriptor,directory:f.state}),/PATH_MISMATCH/);
    await assert.rejects(()=>openAttempt(f.state,{...f.descriptor,manifestSha256:'0'.repeat(64)}),/MANIFEST_CHANGED/);
    await fs.chmod(f.directory,0o755);await assert.rejects(()=>openAttempt(f.state,f.descriptor),/DIRECTORY_UNSAFE/);
    await fs.chmod(f.directory,0o700);assert.deepEqual(await fs.readdir(f.directory),['manifest.json']);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('complete private observations remain exact and have a bounded record budget',async()=>{
  const f=await fixture();
  try{
    const j=await openAttempt(f.state,f.descriptor),text='a'.repeat(8192)+'\nend 🧪\n';
    const ref=await j.record('OBSERVED',{text,userMessageId:'new-user'});
    assert.equal(JSON.parse(await fs.readFile(ref.path,'utf8')).data.text,text);
    assert.equal(sha(await fs.readFile(ref.path)),ref.sha256);
    for(let i=1;i<128;i++)await j.record('OBSERVED',{});
    await assert.rejects(()=>j.record('OBSERVED',{}),/BUDGET_EXCEEDED/);
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('a partial intent left by crash is not treated as permission to send again',async()=>{
  const f=await fixture();
  try{
    await fs.writeFile(path.join(f.directory,'40-SEND_INTENT.json'),'{partial',{mode:0o600});
    const j=await openAttempt(f.state,f.descriptor);
    await assert.rejects(()=>j.record('SEND_INTENT',{}),e=>e.deliveryStage==='SEND_ATTEMPTED');
    assert.equal(await fs.readFile(path.join(f.directory,'40-SEND_INTENT.json'),'utf8'),'{partial');
  }finally{await fs.rm(f.state,{recursive:true,force:true});}
});

test('real coordinator timeout retains exact witness and per-claim process/capture evidence without sending again',()=>{
  const code=`import importlib.util,pathlib,tempfile,subprocess,sys,json,hashlib
s=importlib.util.spec_from_file_location('coordinator',pathlib.Path('src/coordinator.py').resolve());c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
a=c.delivery_attempt_module()
with tempfile.TemporaryDirectory(prefix='bridge-claim-') as temp:
 state=pathlib.Path(temp).resolve()
 row=dict(id='11111111-1111-4111-8111-111111111111',attempts=1,claimed_at=123.5,message='exact',task_id='task',account_alias='a',account_id='identity-hash',project='P',session_ref=None,kind='dispatch',payload_hash='payload',caller_ref='owner',requested_model='Latest',requested_effort='High')
 ctx=a.prepare(state,row)
 try:a.prepare(state,row);raise AssertionError('same claim was rearmed')
 except FileExistsError:pass
 witness={'format':'chatgpt-native-getText-v1','bodyHash':'b'*64,'postSend':{'afterUrl':'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222','lastUserId':'u-new','sourceMessageId':'u-new','sourceBodyHash':'b'*64},'retainedExactField':'q'*8192}
 frame={'ok':False,'deliveryStage':'SEND_ATTEMPTED','code':'DELIVERY_UNCONFIRMED','nativeWitness':witness}
 script='import sys,time;print('+repr(json.dumps(frame))+',flush=True);time.sleep(20)'
 try:c.run_bridge([sys.executable,'-c',script],timeout=.3,attempt=ctx);raise AssertionError('timeout accepted')
 except subprocess.TimeoutExpired as exc:
  d=c.worker_diagnostic(None,exc.stderr,'dispatch',error=exc)
  assert d['nativeWitness']==witness
  assert d['worker']['capturedReceipt']['deliveryStage']=='SEND_ATTEMPTED'
 directory=pathlib.Path(ctx['directory'])
 assert json.loads((directory/'host-worker-started.json').read_text())['leaderPid']>0
 end=json.loads((directory/'host-worker-ended.json').read_text());assert end['timedOut'] is True and end['remoteExecutionStopped'] is False
 assert (directory/'stdout.bin').read_bytes()==(json.dumps(frame)+chr(10)).encode()
 index=a.inspect(state,row['id']);assert len(index['attempts'])==1 and not index['retryAuthorized'] and not index['deliveryProven']
 assert not a.inspect(state,'33333333-3333-4333-8333-333333333333')['deliveryProven']
 print(json.dumps({'timeout':'UNKNOWN','fullWitnessPreserved':True,'claimCount':len(index['attempts']),'remoteStopped':False}))
`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:15000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).fullWitnessPreserved,true);
});

test('conflicting machine receipts never become a retained positive witness',()=>{
  const code=`import importlib.util,pathlib,json,subprocess
s=importlib.util.spec_from_file_location('coordinator',pathlib.Path('src/coordinator.py').resolve());c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
a=json.dumps({'ok':False,'deliveryStage':'SEND_ATTEMPTED','code':'E','nativeWitness':{'x':1}})
b=json.dumps({'ok':False,'deliveryStage':'PRE_SEND','code':'E'})
e=subprocess.TimeoutExpired('worker',1,output=a,stderr=b)
assert 'nativeWitness' not in c.worker_diagnostic(None,b,'dispatch',error=e)
print('PASS')`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:5000});assert.equal(r.status,0,r.stdout+r.stderr);
});


test('real SQLite claim admission rejects UNKNOWN, altered claim and paused control before any browser call',()=>{
  const code=`import importlib.util,pathlib,tempfile,json,os,subprocess,sys
os.environ.pop('CHAT_BRIDGE_FROM_ACCOUNT_ID',None)
s=importlib.util.spec_from_file_location('coordinator',pathlib.Path('src/coordinator.py').resolve());c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
with tempfile.TemporaryDirectory(prefix='bridge-fence-') as temp:
 root=pathlib.Path(temp);config=root/'config';state=root/'state';config.mkdir();state.mkdir()
 reg={'accounts':{'a':{'identity':'synthetic-user'}},'projects':{'P':{'activeAccount':'a','bindings':{'a':{'projectUrl':'https://chatgpt.com/g/g-p-'+'a'*32+'/project','spaceName':'fixture'}}}},'chats':{'owner':{'id':'owner','project':'P','account':'a','role':'conductor','status':'active'},'worker':{'id':'worker','project':'P','account':'a','role':'worker','status':'active'}}}
 (config/'registry.json').write_text(json.dumps(reg));(state/'runtime.json').write_text(json.dumps({'tasks':{},'sessions':{},'projects':{}}))
 db=c.connection(config,state)
 op=c.submit(db,{'requestId':'evidence-fence','callerRef':'owner','sessionRef':'worker','message':'exact'})
 row=c.claim(db);module=c.delivery_attempt_module();ctx=module.prepare(state,row)
 assert module.verify_current(state,db,ctx)['id']==op['operationId']
 cmd=[sys.executable,str(pathlib.Path('src/coordinator.py').resolve()),'delivery-admission',str(config),str(state)]
 allowed=subprocess.run(cmd,input=json.dumps(ctx),text=True,capture_output=True);assert allowed.returncode==0,allowed.stderr
 db.execute("INSERT OR REPLACE INTO control_state(scope,mode,epoch,reason,updated_at) VALUES('global','PAUSED',99,'synthetic pause','now')");db.commit()
 denied=subprocess.run(cmd,input=json.dumps(ctx),text=True,capture_output=True);assert denied.returncode==2 and 'DELIVERY_ADMISSION_CHANGED' in denied.stderr,denied.stderr
 db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN' WHERE id=?",(row['id'],));db.commit()
 try:module.verify_current(state,db,ctx);raise AssertionError('UNKNOWN admitted')
 except ValueError as e:assert 'NO_LONGER_CURRENT' in str(e)
 db.execute("UPDATE operations SET status='DISPATCHING',attempts=attempts+1 WHERE id=?",(row['id'],));db.commit()
 try:module.verify_current(state,db,ctx);raise AssertionError('changed claim admitted')
 except ValueError as e:assert 'NO_LONGER_CURRENT' in str(e)
 before=db.total_changes;index=module.inspect(state,row['id']);assert db.total_changes==before and index['readOnly'] and not index['retryAuthorized']
 db.close()
 print('PASS')`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stdout+r.stderr);
});
