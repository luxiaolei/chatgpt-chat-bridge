import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('initialized admission and exact local owner reads skip projections; bootstrap and read errors remain explicit', async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-local-read-'));
  const config=path.join(root,'config'),state=path.join(root,'state'),runtime=path.join(root,'runtime');
  await Promise.all([config,state,runtime].map(p=>mkdir(p)));
  const script=path.join(runtime,'coordinator.py'),store=path.join(runtime,'state-store.py');
  const storeSource=await readFile('src/state-store.py','utf8');
  await writeFile(script,await readFile('src/coordinator.py'));
  await writeFile(store,storeSource);
  const thread='11111111-1111-4111-8111-111111111111',callerRef='codex:'+thread;
  const registry={defaultProject:'P',accounts:{a:{identity:'one'}},projects:{P:{bindings:{a:{projectUrl:'https://chatgpt.com/g/p/project'}},
    workgroups:{parent:{},child:{parentWorkgroupId:'parent'}}}},
    chats:{w:{id:'w',project:'P',account:'a',role:'worker',status:'active'}}};
  const env={...process.env,CODEX_THREAD_ID:thread,CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:'',EGO_BROWSER_BIN:'/does-not-exist'};
  const raw=(command,args=[],payload=null,dir=state)=>spawnSync('python3',['-B',script,command,config,dir,...args],{
    input:payload?JSON.stringify(payload):undefined,encoding:'utf8',env,timeout:4000});
  const call=(...args)=>{const r=raw(...args);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const deny=(command,args,payload,pattern,dir)=>{const r=raw(command,args,payload,dir);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);};
  const sql=(code,dir=state)=>{
    const r=spawnSync('python3',['-B','-c','import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);'+code+';db.close()',path.join(dir,'bridge.sqlite3')],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();
  };
  const snapshot=async()=>({registry:await readFile(path.join(config,'registry.json'),'utf8'),runtime:await readFile(path.join(state,'runtime.json'),'utf8'),
    database:sql("print(json.dumps(list(db.iterdump())))")});
  try{
    await writeFile(path.join(config,'registry.json'),JSON.stringify(registry));
    await writeFile(path.join(state,'runtime.json'),'{}');
    // A fresh deployment still bootstraps the required queue/control schema.
    assert.equal(call('admission-check').project,'P');
    const op=call('submit',[],{callerRef,requestId:'local-read',taskId:'READ-1',project:'P',sessionRef:'w',message:'synthetic bounded task'});
    const contract={taskId:op.taskId,callerRef,project:'P',sessionRef:'w'};
    await writeFile(store,storeSource.replace('def project(path, document):\n','def project(path, document):\n    raise RuntimeError("UNEXPECTED_COMPATIBILITY_PROJECTION")\n'));
    await writeFile(path.join(config,'registry.json'),'{"defaultProject":"stale-wrong-project"}');
    await writeFile(path.join(state,'runtime.json'),'stale projection must stay unchanged');
    const before=await snapshot();
    assert.equal(call('admission-check').project,'P');
    assert.equal(call('admission-check',['P','--workgroup','child']).control.mode,'RUNNING');
    assert.deepEqual(call('local-owner-contract',[],contract),op.localOwner);
    for(const change of [{taskId:'foreign'},{project:'foreign'},{sessionRef:'foreign'},{callerRef:'codex:foreign'}])
      deny('local-owner-contract',[],{...contract,...change},/LOCAL_OWNER_CONTRACT_MISMATCH/);
    assert.deepEqual(await snapshot(),before);

    for(const [scope,mode] of [['global','PAUSED'],['project:P','DRAINING'],['workgroup:P:parent','PAUSED']]){
      sql(`db.execute('INSERT INTO control_state VALUES (?,?,?,?,?)',(${JSON.stringify(scope)},${JSON.stringify(mode)},1,'synthetic','2026-10-01T00:00:00Z'));db.commit()`);
      const held=await snapshot();
      deny('admission-check',['P','--workgroup','child'],null,new RegExp('ADMISSION_'+mode));
      assert.deepEqual(await snapshot(),held);
      sql('db.execute("DELETE FROM control_state");db.commit()');
    }
    // Initialized WAL reads must work while another connection holds the writer slot.
    const locked=spawnSync('python3',['-B','-c',String.raw`
import json,sqlite3,subprocess,sys
db=sqlite3.connect(sys.argv[1]);db.execute('BEGIN IMMEDIATE')
for command,args,payload in [('admission-check',['P'],None),('local-owner-contract',[],json.loads(sys.argv[5]))]:
    r=subprocess.run([sys.executable,'-B',sys.argv[2],command,sys.argv[3],sys.argv[4],*args],input=json.dumps(payload) if payload else None,text=True,capture_output=True,timeout=3)
    assert r.returncode==0,r.stderr
db.rollback();db.close();print('read under writer lock passed')
`,path.join(state,'bridge.sqlite3'),script,config,state,JSON.stringify(contract)],{encoding:'utf8',env,timeout:5000});
    assert.equal(locked.status,0,locked.stderr);
    assert.deepEqual(await snapshot(),before);
    sql("db.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN' WHERE id=?\",("+JSON.stringify(op.operationId)+",));db.commit()");
    const unknown=await snapshot();
    deny('local-owner-contract',[],contract,/LOCAL_OWNER_CONTRACT_MISMATCH/);
    assert.deepEqual(await snapshot(),unknown);

    const corrupt=path.join(root,'corrupt');await mkdir(corrupt);await writeFile(path.join(corrupt,'bridge.sqlite3'),'not a SQLite database');
    deny('admission-check',['P'],null,/file is not a database/,corrupt);
    deny('local-owner-contract',[],contract,/file is not a database/,corrupt);
    assert.equal(await readFile(path.join(corrupt,'bridge.sqlite3'),'utf8'),'not a SQLite database');

    // A legacy documents-only store receives only the necessary first schema bootstrap.
    await writeFile(store,storeSource);await writeFile(path.join(config,'registry.json'),JSON.stringify(registry));
    const legacy=path.join(root,'legacy');await mkdir(legacy);await writeFile(path.join(legacy,'runtime.json'),'{}');
    const setup=spawnSync('python3',['-B',store,'get',config,legacy,'registry'],{encoding:'utf8',env});
    assert.equal(setup.status,0,setup.stderr);
    assert.equal(sql("print(db.execute(\"SELECT count(*) FROM sqlite_master WHERE name='control_state'\").fetchone()[0])",legacy),'0');
    assert.equal(call('admission-check',[],null,legacy).project,'P');
    deny('local-owner-contract',[],contract,/LOCAL_OWNER_CONTRACT_MISMATCH/,legacy);
    const missing=path.join(root,'missing');await mkdir(missing);
    deny('native-admission',['synthetic-operation'],null,/unable to open database file/,missing);
    const absent=await readFile(path.join(missing,'bridge.sqlite3')).then(()=>false,e=>e.code==='ENOENT');assert.equal(absent,true);
  } finally {await rm(root,{recursive:true,force:true});}
});
