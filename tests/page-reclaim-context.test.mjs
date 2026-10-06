import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";

test("reclaim reads preserve UNKNOWN, alias identity and exact claim while excluding native Codex pools",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"bridge-reclaim-")),config=path.join(root,"config"),state=path.join(root,"state");
  await mkdir(config);await mkdir(state);
  const pid="g-p-"+"a".repeat(32),cid="11111111-1111-4111-8111-111111111111",current="22222222-2222-4222-8222-222222222222";
  await writeFile(path.join(config,"registry.json"),JSON.stringify({accounts:{a:{identity:"one"},alias:{identity:"one"},b:{identity:"two"}},projects:{P:{bindings:{a:{projectUrl:"https://chatgpt.com/g/"+pid+"/project"},alias:{projectUrl:"https://chatgpt.com/g/"+pid+"/project"}}}},chats:{}}));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks:{}}));
  const env={...process.env};delete env.CHAT_BRIDGE_FROM_ACCOUNT_ID;delete env.CHAT_BRIDGE_FROM_SPACE;
  const call=(command,payload,extra={})=>spawnSync("python3",[path.resolve("src/coordinator.py"),command,config,state],{input:JSON.stringify(payload),encoding:"utf8",env:{...env,...extra}});
  const sql=(code,argv=[])=>{const r=spawnSync("python3",["-c",code,path.join(state,"bridge.sqlite3"),...argv],{encoding:"utf8",env});assert.equal(r.status,0,r.stderr);return r.stdout;};
  try{
    assert.equal(call("list",{}).status,0);
    sql(`import sqlite3,sys,json,hashlib,time
d=sqlite3.connect(sys.argv[1]);scope=lambda x:hashlib.sha256(('identity:'+x).encode()).hexdigest()
rows=[('unknown','a','one','P','DELIVERY_UNKNOWN',sys.argv[2],None),('unbound','alias','one','P','DELIVERY_UNKNOWN',None,None),('future','a','one','P','QUEUED',None,None),('queued-bound','a','one','P','QUEUED','queued-session',None),('sent','a','one','P','SENT','sent-session',None),('result-recorded','a','one','P','SENT','result-session',None),('foreign','b','two','P','DELIVERY_UNKNOWN',None,None),('native','a','one','P','DELIVERY_UNKNOWN','native-session','{}'),('failed','a','one','P','FAILED_PRE_SEND','failed-session',None),(sys.argv[3],'a','one','P','DISPATCHING',None,None)]
for id,a,identity,p,status,sid,native in rows:
 d.execute('INSERT INTO operations (id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before,attempts,claimed_at,native_target) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(id,id,'hash',status,p,a,scope(identity),'controller',sid,id,'body','t-'+id,'now','now',0,1,time.time(),native))
d.execute("INSERT INTO task_results (task_id,result_version,event_id,status,summary,payload_hash,recorded_at) VALUES ('t-result-recorded','1','e','COMPLETE','done','hash','now')")
d.commit()`,[cid,current]);
    const before=await readFile(path.join(state,"bridge.sqlite3"));
    const first=call("page-reclaim-context",{account:"a"});assert.equal(first.status,0,first.stderr);
    const context=JSON.parse(first.stdout);assert.deepEqual(context.sessionRefs,[cid,"queued-session","sent-session"]);assert.deepEqual(context.unboundProjectIds,[pid]);assert.equal(context.unboundAny,false);
    assert.deepEqual(await readFile(path.join(state,"bridge.sqlite3")),before);
    assert.equal(call("page-reclaim-context",{account:"a"},{CHAT_BRIDGE_FROM_ACCOUNT_ID:"foreign"}).status,2);
    assert.equal(call("page-reclaim-context",{account:"missing"}).status,2);
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute(\"DELETE FROM operations WHERE id='unbound'\");d.commit()");
    const prepare=spawnSync("python3",["-c",`import sqlite3,sys,json;sys.path.insert(0,sys.argv[1]);import delivery_attempt;d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row;print(json.dumps(delivery_attempt.prepare(sys.argv[3],d.execute('SELECT * FROM operations WHERE id=?',(sys.argv[4],)).fetchone())))`,path.resolve("src"),path.join(state,"bridge.sqlite3"),state,current],{encoding:"utf8",env});
    assert.equal(prepare.status,0,prepare.stderr);const attempt=JSON.parse(prepare.stdout);
    const admitted=call("page-reclaim-context",{account:"a",attempt});assert.equal(admitted.status,0,admitted.stderr);assert.deepEqual(JSON.parse(admitted.stdout).unboundProjectIds,[]);
    assert.equal(call("page-reclaim-context",{account:"b",attempt}).status,2);
    const stale={...attempt,claimOrdinal:2};assert.equal(call("page-reclaim-context",{account:"a",attempt:stale}).status,2);
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN' WHERE id=?\",(sys.argv[2],));d.commit()",[current]);
    assert.equal(call("page-reclaim-context",{account:"a",attempt}).status,2);
    const retained=call("page-reclaim-context",{account:"alias"});assert.equal(retained.status,0,retained.stderr);assert.deepEqual(JSON.parse(retained.stdout).unboundProjectIds,[pid]);
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);d.execute(\"UPDATE operations SET project='missing' WHERE id=?\",(sys.argv[2],));d.commit()",[current]);
    assert.equal(JSON.parse(call("page-reclaim-context",{account:"a"}).stdout).unboundAny,true);
    sql(`import sqlite3,sys,json;d=sqlite3.connect(sys.argv[1]);d.execute("UPDATE operations SET project='P' WHERE id=?",(sys.argv[2],));r=json.loads(d.execute("SELECT payload FROM documents WHERE kind='registry'").fetchone()[0]);r['projects']['P']['bindings']['a']['projectUrl']=r['projects']['P']['bindings']['a']['projectUrl'].replace('https://chatgpt.com','https://foreign.example');d.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(r),));d.commit()`,[current]);
    const foreignUrl=JSON.parse(call("page-reclaim-context",{account:"a"}).stdout);assert.equal(foreignUrl.unboundAny,true);assert.deepEqual(foreignUrl.unboundProjectIds,[]);
    const finalBytes=await readFile(path.join(state,"bridge.sqlite3"));call("page-reclaim-context",{account:"a"});assert.deepEqual(await readFile(path.join(state,"bridge.sqlite3")),finalBytes);
  }finally{await rm(root,{recursive:true,force:true});}
});
