import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import "../src/task-policy.js";
import "../src/session-policy.js";
import "../src/page-pool.js";

test('confirmed SENT with an exact technically terminal task releases occupancy without business ACK',()=>{
  const code=String.raw`import json,pathlib,tempfile,subprocess,sys,os,hashlib,copy
sys.path.insert(0,str(pathlib.Path("src").resolve()));import coordinator as c
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);config=p/"config";state=p/"state";config.mkdir();state.mkdir()
 pid="g-p-"+"a"*32;sid="11111111-1111-4111-8111-111111111111";owner="22222222-2222-4222-8222-222222222222";home="https://chatgpt.com/g/"+pid+"/project"
 reg={"accounts":{"a":{"identity":"login"}},"projects":{"P":{"bindings":{"a":{"projectUrl":home}}}},"chats":{sid:{"id":sid,"project":"P","account":"a","role":"worker","url":home.replace("project","c/"+sid)},owner:{"id":owner,"project":"P","account":"a","role":"conductor"}}}
 task={"taskId":"T","project":"P","account":"a","sessionId":sid,"role":"worker","controllerSessionRef":owner,"status":"CANCELLED"}
 rt={"tasks":{"T":task}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps(rt));db=c.connection(config,state)
 db.execute("INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before) VALUES('op','op','hash','SENT','P','a',?,? ,?,'worker','body','T',?,?,0)",(c.account_id("login"),owner,sid,c.stamp(),c.stamp()));db.commit()
 env=dict(os.environ);env.pop("CHAT_BRIDGE_FROM_ACCOUNT_ID",None);env.pop("CHAT_BRIDGE_FROM_SPACE",None)
 def context():
  before=[tuple(r) for r in db.execute("SELECT * FROM operations")],[tuple(r) for r in db.execute("SELECT * FROM documents")]
  r=subprocess.run([sys.executable,"src/coordinator.py","page-reclaim-context",str(config),str(state)],input=json.dumps({"account":"a"}),capture_output=True,text=True,env=env);assert r.returncode==0,r.stderr
  assert before==([tuple(r) for r in db.execute("SELECT * FROM operations")],[tuple(r) for r in db.execute("SELECT * FROM documents")])
  assert db.execute("SELECT count(*) FROM task_results").fetchone()[0]==0
  return json.loads(r.stdout)["sessionRefs"]
 def put(kind,value):db.execute("UPDATE documents SET payload=? WHERE kind=?",(json.dumps(value),kind));db.commit()
 for status in ["CANCELLED","FAILED"]:
  task["status"]=status;put("runtime",rt);assert context()==[],"terminal task remains permanently occupied"
 for field,value in [("status","BLOCKED"),("status","RUNNING"),("watchdogPendingNotification",True),("externalResponsePending",True),("watchdogPausedForUserControl",True),("taskId","other"),("project","other"),("account","other"),("sessionId","other"),("role","other"),("controllerSessionRef","other")]:
  changed=copy.deepcopy(rt);changed["tasks"]["T"][field]=value;put("runtime",changed);assert context()==[sid],field
 put("runtime",{"tasks":{}});assert context()==[sid];put("runtime",rt)
 for status in ["DELIVERY_UNKNOWN","DISPATCHING","SUPERSEDED","QUEUED"]:
  db.execute("UPDATE operations SET status=?",(status,));db.commit();assert context()==[sid]
 db.execute("UPDATE operations SET status='SENT',kind='rotation'");db.commit();assert context()==[]
 changed=copy.deepcopy(reg);changed["projects"]["P"]["bindings"]["a"]["projectUrl"]=home.replace("chatgpt.com","foreign.test");put("registry",changed);assert context()==[sid]
 put("registry",reg);db.execute("UPDATE operations SET status='SENT'");db.commit();assert context()==[]
 print("PASS")`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'PASS');
});

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

test("capacity occupancy uses authoritative pre-send wait and cancellation, preserving UNKNOWN",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"bridge-capacity-reclaim-")),config=path.join(root,"config"),state=path.join(root,"state");
  await mkdir(config);await mkdir(state);
  const home="https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/project";
  await writeFile(path.join(config,"registry.json"),JSON.stringify({accounts:{a:{identity:"one"}},projects:{P:{bindings:{a:{account:"a",spaceName:"managed",spaceId:9,profileId:"P1",projectUrl:home}}}},chats:{}}));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({tasks:{}}));
  const env={...process.env};delete env.CHAT_BRIDGE_FROM_ACCOUNT_ID;delete env.CHAT_BRIDGE_FROM_SPACE;
  const call=(command,payload,args=[])=>spawnSync("python3",[path.resolve("src/coordinator.py"),command,config,state,...args],{input:JSON.stringify(payload),encoding:"utf8",env});
  const sql=code=>{const r=spawnSync("python3",["-c",code,path.resolve("src"),path.join(state,"bridge.sqlite3")],{encoding:"utf8",env});assert.equal(r.status,0,r.stderr);return r.stdout;};
  try{
    assert.equal(call("list",{}).status,0);
    sql(`import sqlite3,sys,hashlib,time
sys.path.insert(0,sys.argv[1]);import coordinator as c
d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row
d.execute("INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,role,message,task_id,created_at,updated_at,not_before,attempts,claimed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",('33333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333333','hash','DISPATCHING','P','a',hashlib.sha256(b'identity:one').hexdigest(),'controller','worker','body','waiting','now','now',0,1,time.time()));d.commit()
r=d.execute("SELECT * FROM operations WHERE id='33333333-3333-4333-8333-333333333333'").fetchone()
receipt={'ok':False,'deliveryStage':'PRE_SEND','code':'CAPACITY_WAIT','reason':'PAGE_BUDGET'}
c.mark_capacity_wait(d,r,receipt);c.finish(d,dict(r),'QUEUED','CAPACITY_WAITING',15,resource_receipt=receipt)`);
    const context=(attempt=null)=>{const r=call("page-reclaim-context",{account:"a",attempt});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
    const source=await readFile(path.resolve("src/main.js"),"utf8"),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
    const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
    const code=section("function samePhysicalSpace","\nfunction spaceProtection")+section("async function reclaimOrphanManagedPage","\nasync function overflowManagedTask");
    const projectHomeId=new Function(section("function projectHomeId(","\nfunction projectKey(")+";return projectHomeId;")();
    const reclaim=async(change=()=>{})=>{
      const docs=JSON.parse(sql("import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);print(json.dumps({k:json.loads(v) for k,v in d.execute('SELECT kind,payload FROM documents')}))"));
      let closed=0;
      const page={label:"p9",url:async()=>home,close:async()=>{closed++;}};
      const task={spaceId:9,pages:async()=>[page],tabs:async()=>[{label:"p9",url:home,active:false,openedBy:"agent"}]};
      const helper=await new AsyncFunction("loadRuntime","activeTaskStatus","orphanManagedPageCandidates","state","projectHomeId","coordinated","sameConversationUrl","composerIsEmpty",code+";return reclaimOrphanManagedPage;")(
        async()=>docs.runtime,globalThis.__CHAT_BRIDGE_TASK_POLICY__.activeTaskStatus,globalThis.__CHAT_BRIDGE_PAGE_POOL__.orphanManagedPageCandidates,
        async()=>{change();return {approvalRequired:false,generating:false,composerCount:1,composerRawText:"",composerAttachmentsEmpty:true};},
        projectHomeId,()=>context(),globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,globalThis.__CHAT_BRIDGE_TASK_POLICY__.composerIsEmpty);
      await helper(docs.registry,task,docs.registry.projects.P.bindings.a,"a");return closed;
    };
    const proof=context().preSendCapacityWaits;
    assert.deepEqual(proof,[{taskId:"waiting",project:"P",account:"a",sessionId:null}]);
    assert.equal(await reclaim(),1);
    const attempt=JSON.parse(sql(`import sqlite3,sys,json
sys.path.insert(0,sys.argv[1]);import coordinator as c,delivery_attempt
d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row
d.execute("UPDATE operations SET not_before=0 WHERE id='33333333-3333-4333-8333-333333333333'");d.commit()
row=c.claim(d);print(json.dumps(delivery_attempt.prepare(${JSON.stringify(state)},row)))`));
    assert.deepEqual(context(attempt).preSendCapacityWaits,[]); // Current claim ownership is not current PRE_SEND proof.
    assert.equal(context(attempt).capacityWaitRefusals.waiting,"OPERATION_DISPATCHING");
    assert.equal(await reclaim(),0);
    sql(`import sqlite3,sys
sys.path.insert(0,sys.argv[1]);import coordinator as c
d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row
r=d.execute("SELECT * FROM operations WHERE id='33333333-3333-4333-8333-333333333333'").fetchone()
c.finish(d,dict(r),'QUEUED','CAPACITY_WAITING',15,resource_receipt={'ok':False,'deliveryStage':'PRE_SEND','code':'CAPACITY_WAIT'})`);
    assert.equal(call("cancel",{},["33333333-3333-4333-8333-333333333333"]).status,0);
    assert.deepEqual(context().preSendCapacityWaits,proof);
    assert.equal(await reclaim(),1); // The cancelled operation's stale WAITING task is non-occupying; no task mutation.
    assert.equal(sql("import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);print(json.loads(d.execute(\"SELECT payload FROM documents WHERE kind='runtime'\").fetchone()[0])['tasks']['waiting']['status'])").trim(),"WAITING_CAPACITY");
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[2]);d.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN' WHERE id='33333333-3333-4333-8333-333333333333'\");d.commit()");
    assert.deepEqual(context().preSendCapacityWaits,[]);
    assert.equal(context().capacityWaitRefusals.waiting,"OPERATION_DELIVERY_UNKNOWN");
    assert.equal(context().unboundAny,false);assert.equal(context().unboundProjectIds.length,1);
    assert.equal(await reclaim(),0);
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[2]);d.execute(\"UPDATE operations SET status='QUEUED',reason='CAPACITY_WAITING' WHERE id='33333333-3333-4333-8333-333333333333'\");d.commit()");
    const saved=sql("import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row;print(json.dumps(dict(d.execute(\"SELECT * FROM operations WHERE id='33333333-3333-4333-8333-333333333333'\").fetchone())))");
    for(const [field,value,reason] of [
      ["status","SENT","OPERATION_SENT"],["status","SUPERSEDED","OPERATION_SUPERSEDED"],
      ["kind","callback","OPERATION_SCOPE_MISMATCH"],["native_target","{}","OPERATION_SCOPE_MISMATCH"],
      ["account_id","foreign","OPERATION_SCOPE_MISMATCH"],["account_alias","other","OPERATION_SCOPE_MISMATCH"],
      ["project","other","OPERATION_SCOPE_MISMATCH"],["session_ref","other","OPERATION_SCOPE_MISMATCH"],
      ["role","other","OPERATION_SCOPE_MISMATCH"],["caller_ref","other","OPERATION_SCOPE_MISMATCH"],
      ["reason",null,"OPERATION_PHASE_UNPROVEN"],["attempts",0,"OPERATION_PHASE_UNPROVEN"],
      ["result",null,"OPERATION_PHASE_UNPROVEN"],["result","{","OPERATION_PHASE_UNPROVEN"],
      ["result",JSON.stringify({resourceWait:{lastPhase:{category:"inactive",reason:"TimeoutExpired"}}}),"OPERATION_PHASE_UNPROVEN"]
    ]) {
      sql(`import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);d.execute("UPDATE operations SET ${field}=? WHERE id='33333333-3333-4333-8333-333333333333'",(${value===null?"None":JSON.stringify(value)},));d.commit()`);
      const refused=context();assert.deepEqual(refused.preSendCapacityWaits,[],field);assert.equal(refused.capacityWaitRefusals.waiting,reason,field);
      sql(`import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);r=json.loads(${JSON.stringify(saved)});d.execute("UPDATE operations SET ${field}=? WHERE id='33333333-3333-4333-8333-333333333333'",(r[${JSON.stringify(field)}],));d.commit()`);
    }
    for(const flag of ["watchdogPausedForUserControl","watchdogPendingNotification","externalResponsePending"]) {
      sql(`import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);r=json.loads(d.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()[0]);r['tasks']['waiting'][${JSON.stringify(flag)}]=True;d.execute("UPDATE documents SET payload=? WHERE kind='runtime'",(json.dumps(r),));d.commit()`);
      assert.deepEqual(context().preSendCapacityWaits,[]);assert.equal(context().capacityWaitRefusals.waiting,"TASK_PAUSED_OR_PENDING");assert.equal(await reclaim(),0);
      sql(`import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);r=json.loads(d.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()[0]);r['tasks']['waiting'].pop(${JSON.stringify(flag)});d.execute("UPDATE documents SET payload=? WHERE kind='runtime'",(json.dumps(r),));d.commit()`);
    }
    sql("import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);r=json.loads(d.execute(\"SELECT payload FROM documents WHERE kind='registry'\").fetchone()[0]);r['projects']['P']['bindings']['a']['projectUrl']=r['projects']['P']['bindings']['a']['projectUrl'].replace('https://chatgpt.com','https://foreign.example');d.execute(\"UPDATE documents SET payload=? WHERE kind='registry'\",(json.dumps(r),));d.commit()");
    assert.deepEqual(context().preSendCapacityWaits,[]);assert.equal(context().capacityWaitRefusals.waiting,"TASK_PROJECT_UNVERIFIED");
    sql("import sqlite3,sys,json;d=sqlite3.connect(sys.argv[2]);r=json.loads(d.execute(\"SELECT payload FROM documents WHERE kind='registry'\").fetchone()[0]);r['projects']['P']['bindings']['a']['projectUrl']=r['projects']['P']['bindings']['a']['projectUrl'].replace('https://foreign.example','https://chatgpt.com');d.execute(\"UPDATE documents SET payload=? WHERE kind='registry'\",(json.dumps(r),));d.commit()");
    sql(`import sqlite3,sys
d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row
r=dict(d.execute("SELECT * FROM operations WHERE id='33333333-3333-4333-8333-333333333333'").fetchone());r.update(id='other',request_key='other',status='DELIVERY_UNKNOWN')
d.execute('INSERT INTO operations ('+','.join(r)+') VALUES ('+','.join('?' for _ in r)+')',list(r.values()));d.commit()`);
    assert.deepEqual(context().preSendCapacityWaits,[]);assert.equal(context().capacityWaitRefusals.waiting,"OPERATION_DELIVERY_UNKNOWN");
    assert.equal(await reclaim(),0);
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[2]);d.execute(\"DELETE FROM operations WHERE id='other'\");d.commit()");
    assert.equal(await reclaim(()=>sql(`import sqlite3,sys
sys.path.insert(0,sys.argv[1]);import coordinator as c
d=sqlite3.connect(sys.argv[2]);d.row_factory=sqlite3.Row
d.execute("UPDATE operations SET not_before=0 WHERE id='33333333-3333-4333-8333-333333333333'");d.commit()
r=c.claim(d);c.finish(d,dict(r),'DELIVERY_UNKNOWN','TimeoutExpired')`)),0);
    assert.equal(context().capacityWaitRefusals.waiting,"OPERATION_DELIVERY_UNKNOWN");
    sql("import sqlite3,sys;d=sqlite3.connect(sys.argv[2]);d.execute('DELETE FROM operations');d.commit()");
    assert.deepEqual(context().preSendCapacityWaits,[]);assert.equal(context().capacityWaitRefusals.waiting,"OPERATION_MISSING");assert.equal(await reclaim(),0);
    const bytes=await readFile(path.join(state,"bridge.sqlite3"));context();assert.deepEqual(await readFile(path.join(state,"bridge.sqlite3")),bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});
