import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';

function python(code) {
  const result=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);
  return result.stdout.trim();
}
test("resource episodes are finite, exact-claim guarded, pause-aware, and routed only to the owner",()=>assert.equal(python(String.raw`import importlib.util,json,pathlib,tempfile
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("coordinator", "src/coordinator.py")
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);config=p/"config";state=p/"state";config.mkdir();state.mkdir()
 reg={"accounts":{"a":{"identity":"identity-a"}},"projects":{"P":{}},"chats":{"owner":{"id":"owner","project":"P","account":"a","role":"root","status":"active"}}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps({"tasks":{},"projects":{},"sessions":{}}))
 db=c.connection(config,state)
 def row(id="op",caller="owner",local=None):
  db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,role,message,task_id,created_at,updated_at,not_before,local_owner) VALUES(?,?,?,'QUEUED','P','a',?,?,'worker','exact-body',?,?,?,0,?)""",(id,id,"hash",c.account_id("identity-a"),caller,id,c.stamp(),c.stamp(),json.dumps(local) if local else None));db.commit()
 def claimed(id):
  db.execute("UPDATE operations SET status='DISPATCHING',attempts=attempts+1,claimed_at=?,not_before=0 WHERE id=?",(clock[0],id));db.commit()
  return db.execute("SELECT * FROM operations WHERE id=?",(id,)).fetchone()
 def result(id="op"):
  return json.loads(db.execute("SELECT result FROM operations WHERE id=?",(id,)).fetchone()[0] or "{}")
 assert c.advance_resource_wait({"waitedSec":100,"lastPhase":{"category":"mutex","at":2000}},1000,"capacity","CAPACITY_WAIT")["waitedSec"]==100
 clock=[1000.]
 receipt=lambda code,stage="PRE_SEND":dict(ok=False,deliveryStage=stage,code=code,reason="UI_LOCK_BUSY" if code=="PACING_DEFERRED" else code)
 with patch.object(c.time,"time",lambda:clock[0]):
  row();first=claimed("op");assert c.finish(db,first,"QUEUED","resource",30,resource_receipt=receipt("CAPACITY_WAIT"))["status"]=="QUEUED"
  assert result()["resourceWait"]["counters"]=={"capacity":1}
  clock[0]+=100;c.set_control_mode(db,"P","PAUSED")
  clock[0]+=4000;c.set_control_mode(db,"P","RUNNING")
  assert result()["resourceWait"]["waitedSec"]==100
  second=claimed("op");c.finish(db,second,"QUEUED","resource",30,resource_receipt=receipt("PACING_DEFERRED"))
  clock[0]+=1700;third=claimed("op");stale=dict(third);stale["attempts"]-=1
  assert c.finish(db,stale,"QUEUED","resource",30,resource_receipt=receipt("USER_DRAFT_PRESENT"))["status"]=="DISPATCHING"
  assert db.execute("SELECT count(*) FROM management_events").fetchone()[0]==0
  exhausted=c.finish(db,third,"QUEUED","resource",30,resource_receipt=receipt("USER_DRAFT_PRESENT"))
  assert exhausted["status"]=="FAILED_PRE_SEND" and exhausted["reason"]=="RESOURCE_WAIT_EXHAUSTED"
  assert result()["resourceWaitNotice"]["targetRef"]=="owner"
  assert result()["resourceWait"]["counters"]=={"capacity":1,"mutex":1,"draft":1}
  c.finish(db,third,"QUEUED","resource",30,resource_receipt=receipt("CAPACITY_WAIT"))
  assert db.execute("SELECT count(*) FROM management_events").fetchone()[0]==1
  assert db.execute("SELECT count(*) FROM management_deliveries").fetchone()[0]==1
  for i,(code,status,stage) in enumerate([("CAPACITY_WAIT","DELIVERY_UNKNOWN","SEND_ATTEMPTED"),("LOGIN_MISMATCH","QUEUED","PRE_SEND"),("NATIVE_ADMISSION_BLOCKED","QUEUED","PRE_SEND"),("SPACE_IN_USER_CONTROL","QUEUED","PRE_SEND")]):
   id="excluded"+str(i);row(id);r=claimed(id);c.finish(db,r,status,code,resource_receipt=receipt(code,stage));assert "resourceWait" not in result(id)
  for id,caller,local in [("missing","absent",None),("local","codex:test",{"kind":"codex","transport":"local-pull"})]:
   row(id,caller,local);r=claimed(id);c.finish(db,r,"QUEUED","resource",resource_receipt=receipt("CHAT_BUSY"))
   clock[0]+=1801;r=claimed(id);c.finish(db,r,"QUEUED","resource",resource_receipt=receipt("CHAT_BUSY"))
   assert result(id)["resourceWaitNotice"]["transport"]==("local-pull" if local else "WAITING_ROUTE")
  assert db.execute("SELECT count(*) FROM management_deliveries").fetchone()[0]==2
  reg["chats"]["owner"]["status"]="archived";reg["chats"]["successor"]={**reg["chats"]["owner"],"id":"successor","status":"active"}
  db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(reg),))
  db.execute("INSERT INTO session_successors VALUES('owner','logical','successor',2,?)",(c.stamp(),));db.commit()
  row("successor-op");r=claimed("successor-op");c.finish(db,r,"QUEUED","resource",resource_receipt=receipt("CAPACITY_WAIT"))
  clock[0]+=1801;r=claimed("successor-op");c.finish(db,r,"QUEUED","resource",resource_receipt=receipt("CAPACITY_WAIT"))
  assert result("successor-op")["resourceWaitNotice"]["targetRef"]=="successor"
  import subprocess,sys
  r=subprocess.run([sys.executable,"src/coordinator.py","retry",str(config),str(state),"--operation","op"],capture_output=True,text=True)
  assert r.returncode==0,r.stderr
  assert "resourceWait" not in result() and db.execute("SELECT count(*) FROM management_events").fetchone()[0]==4
 db.close()
print("PASS")`),"PASS"));

test("shared SQLite deadline restores busy timeout and propagates non-lock errors",()=>assert.equal(python(String.raw`import importlib.util,pathlib,tempfile,sqlite3,time
spec=importlib.util.spec_from_file_location("store","src/state-store.py");s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
with tempfile.TemporaryDirectory() as root:
 path=pathlib.Path(root)/"lock.sqlite3";holder=sqlite3.connect(path);db=sqlite3.connect(path)
 holder.execute("CREATE TABLE test(v)");holder.commit();holder.execute("BEGIN IMMEDIATE")
 db.execute("PRAGMA busy_timeout=30000");start=time.monotonic()
 try:s.begin_immediate(db,timeout=.12);raise AssertionError("lock admitted")
 except sqlite3.OperationalError as e:assert "locked" in str(e)
 assert .09<=time.monotonic()-start<.6
 assert db.execute("PRAGMA busy_timeout").fetchone()[0]==30000
 holder.rollback();s.begin_immediate(db,timeout=.12)
 try:s.begin_immediate(db,timeout=.12);raise AssertionError("nested transaction admitted")
 except sqlite3.OperationalError as e:assert "transaction" in str(e) and "locked" not in str(e)
 assert db.in_transaction;db.rollback()
 bounded=sqlite3.connect(path,factory=s.DeadlineConnection);bounded.deadline=time.monotonic()+.08
 holder.execute("BEGIN IMMEDIATE")
 try:bounded.execute("INSERT INTO test VALUES(1)");raise AssertionError("write admitted")
 except ValueError as e:assert str(e)=="STATE_STORE_WAIT_EXHAUSTED:BOOTSTRAP"
 holder.rollback();bounded.close();db.close();holder.close()
print("PASS")`),"PASS"));

test("startup evidence survives replacing installed bytes while the same process is alive",()=>assert.equal(python(String.raw`import importlib.util,pathlib,tempfile,json,os
spec=importlib.util.spec_from_file_location("release",str(pathlib.Path("src/release-version.py").resolve()));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);dummy=p/"dummy.py"
 dummy.write_text("import sys\ncode=sys._getframe().f_code\nvalue='old'\n")
 namespace={};exec(compile(dummy.read_bytes(),str(dummy),"exec"),namespace)
 manifest=p/"release-manifest.json"
 r.atomic_json(manifest,{"source":{"root":str(p),"commit":"a"*40,"tree":"b"*40,"clean":True},"files":[{"destination":str(dummy),"sha256":r.file_hash(dummy)}]})
 startup=r.startup_receipt(p,dummy,namespace["code"])
 assert startup["startupDisk"]["verified"]
 first=r.health(p,p);assert first["resident"]["alive"]
 assert first["resident"]["executingCode"][0]["loadedMatchesCurrent"],first
 original=(p/"coordinator-startup.json").read_bytes()
 dummy.write_text("import sys\ncode=sys._getframe().f_code\nvalue='replacement'\n")
 second=r.health(p,p)
 assert second["resident"]["alive"] and second["resident"]["pid"]==os.getpid()
 assert not second["currentDisk"]["verified"]
 assert not second["resident"]["executingCode"][0]["loadedMatchesCurrent"]
 assert second["resident"]["startupDisk"]["verified"]
 assert (p/"coordinator-startup.json").read_bytes()==original
 assert (p/"coordinator-startup.json").stat().st_mode&0o777==0o600
 stale=r.read_json(p/"coordinator-startup.json");stale["processIdentity"]="other-start";r.atomic_json(p/"coordinator-startup.json",stale)
 assert not r.health(p,p)["resident"]["alive"]
print("PASS")`),"PASS"));

test('registry no-op saves skip writes while real changes and registrations remain fenced',async()=>{
 const source=await readFile('src/main.js','utf8');
 const helper=source.slice(source.indexOf('async function saveRegistry('),source.indexOf('\nfunction opt(',source.indexOf('async function saveRegistry(')));
 const baselines=new WeakMap(),writes=[];
 const save=new Function('normalizeRegistry','stateBaselines','stored',helper+';return saveRegistry;')(r=>r,baselines,(...args)=>writes.push(args));
 const reg={chats:{}};baselines.set(reg,structuredClone(reg));
 await save(reg);assert.equal(writes.length,0);
 reg.chats.worker={id:'worker'};await save(reg);assert.equal(writes.length,1);
 await save(reg,{sessionId:'worker'});assert.equal(writes.length,2);
});

test('installed serve keeps its startup proof after disk replacement; health remains local',async()=>{
 const {mkdtemp,mkdir,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {default:path}=await import('node:path');
 const {spawn}=await import('node:child_process');
 const root=await mkdtemp(path.join(tmpdir(),'bridge-release-resident-'));
 const config=path.join(root,'config'),state=path.join(root,'state'),share=path.join(root,'share');
 await mkdir(config);await mkdir(state);
 await writeFile(path.join(config,'registry.json'),JSON.stringify({accounts:{},chats:{},projects:{}}));
 await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},projects:{},sessions:{}}));
 const guard=path.join(root,'no-ego');
 await writeFile(guard,'#!/bin/sh\nexit 97\n',{mode:0o700});
 const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,
   CHAT_BRIDGE_SHARE_DIR:share,CHAT_BRIDGE_BIN_DIR:path.join(root,'bin'),CHAT_BRIDGE_SKILLS_DIR:path.join(root,'skills'),
   EGO_BROWSER_BIN:guard,CHAT_BRIDGE_MAIN:path.join(share,'main.js')};
 let resident;
 try {
  const install=spawnSync('zsh',['scripts/install.sh'],{env,encoding:'utf8'});
  assert.equal(install.status,0,install.stderr);
  const manifest=JSON.parse(await readFile(path.join(share,'release-manifest.json'),'utf8'));
  assert.equal(new Set(manifest.files.map(f=>f.destination)).size,manifest.files.length);
  assert.ok(manifest.files.some(f=>f.source?.endsWith('/release-version.py')));
  assert.ok(manifest.files.some(f=>f.generated==='@generated:image-package'));
  const boot=spawnSync('python3',[path.join(share,'coordinator.py'),'status',config,state,'absent'],{env,encoding:'utf8'});
  assert.match(boot.stderr,/UNKNOWN_OPERATION/);
  resident=spawn('python3',[path.join(share,'coordinator.py'),'serve',config,state],{env,stdio:['ignore','pipe','pipe']});
  let stderr='';resident.stderr.on('data',data=>stderr+=data);
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('no RUNNING receipt: '+stderr)),5000);
   resident.stdout.once('data',data=>{clearTimeout(timer);assert.equal(JSON.parse(data).status,'RUNNING');resolve();});
   resident.once('exit',code=>{clearTimeout(timer);reject(Error('resident exited '+code+': '+stderr));});
  });
  const query=()=>{const r=spawnSync(path.join(root,'bin','chat-bridge'),['health'],{env,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).release;};
  const startup=await readFile(path.join(state,'coordinator-startup.json'));
  const first=query();
  assert.equal(first.currentDisk.verified,true);assert.equal(first.resident.alive,true);
  assert.ok(first.resident.executingCode.every(e=>e.loadedMatchesCurrent),JSON.stringify(first.resident.executingCode));
  const coordinator=path.join(share,'coordinator.py'),old=await readFile(coordinator,'utf8');
  await writeFile(coordinator,old.replace('RESOURCE_WAIT_LIMIT_SEC = 30 * 60','RESOURCE_WAIT_LIMIT_SEC = 30 * 61'));
  const second=query();
  assert.equal(second.resident.pid,resident.pid);assert.equal(second.resident.alive,true);
  assert.equal(second.currentDisk.verified,false);assert.equal(second.resident.startupDisk.verified,true);
  assert.equal(second.resident.executingCode.find(e=>e.path===coordinator).loadedMatchesCurrent,false);
  assert.deepEqual(await readFile(path.join(state,'coordinator-startup.json')),startup);
  assert.equal(second.freshChildren.executionObserved,false);
 } finally {
  if(resident && resident.exitCode===null) {resident.kill('SIGTERM');await new Promise(resolve=>resident.once('exit',resolve));}
  await rm(root,{recursive:true,force:true});
 }
});

test("resource exhaustion is visible to the exact local-pull owner without a fabricated result",()=>assert.equal(python(String.raw`import importlib.util,json,pathlib,tempfile,os
spec=importlib.util.spec_from_file_location("coordinator","src/coordinator.py");c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);config=p/"config";state=p/"state";config.mkdir();state.mkdir()
 (config/"registry.json").write_text(json.dumps({"accounts":{"a":{"identity":"fixture"}},"projects":{"P":{}},"chats":{}}))
 (state/"runtime.json").write_text(json.dumps({"tasks":{},"projects":{},"sessions":{}}))
 thread="11111111-1111-4111-8111-111111111111";caller="codex:"+thread
 os.environ["CODEX_THREAD_ID"]=thread
 owner={"kind":"codex","threadId":thread,"host":os.uname().nodename,"transport":"local-pull"}
 db=c.connection(config,state)
 db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,role,message,task_id,created_at,updated_at,not_before,attempts,claimed_at,local_owner,result)
 VALUES('local-op','local-op','hash','DISPATCHING','P','a',?,?,'worker','message','local-task',?,?,0,1,1,?,?)""",
 (c.account_id("fixture"),caller,c.stamp(),c.stamp(),json.dumps(owner),json.dumps({"resourceWait":{"id":"episode","startedAt":c.stamp(),"waitedSec":1800,"counters":{"capacity":1},"lastPhase":{"category":"capacity","at":0}}})))
 db.commit();row=db.execute("SELECT * FROM operations").fetchone()
 c.finish(db,row,"QUEUED","capacity",resource_receipt={"ok":False,"deliveryStage":"PRE_SEND","code":"CAPACITY_WAIT"})
 received=c.receive_local_result(db,{"taskId":"local-task","callerRef":caller})
 assert received["status"]=="PENDING" and received["transport"]=="local-pull"
 assert received["operation"]["reason"]=="RESOURCE_WAIT_EXHAUSTED"
 assert received["operation"]["resourceWaitNotice"]["transport"]=="local-pull"
 assert db.execute("SELECT count(*) FROM management_deliveries").fetchone()[0]==0
 assert db.execute("SELECT count(*) FROM task_results").fetchone()[0]==0
 db.close()
print("PASS")`),"PASS"));

test("unrouted resource notice survives a formal successor ACK and delivers once",()=>assert.equal(python(String.raw`import importlib.util,json,pathlib,tempfile,subprocess
spec=importlib.util.spec_from_file_location("coordinator","src/coordinator.py");c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);config=p/"config";state=p/"state";config.mkdir();state.mkdir()
 reg={"accounts":{"a":{"identity":"fixture"}},"projects":{"P":{}},"chats":{
 "old":{"id":"old","project":"P","account":"a","role":"conductor","status":"retired"},
 "next":{"id":"next","project":"P","account":"a","role":"conductor","status":"pending-rotation"}}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps({"tasks":{},"projects":{},"sessions":{}}))
 db=c.connection(config,state)
 db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,role,message,task_id,created_at,updated_at,not_before,attempts,claimed_at,result)
 VALUES('op','op','hash','DISPATCHING','P','a',?,'old','worker','exact-body','task',?,?,0,1,1,?)""",
 (c.account_id("fixture"),c.stamp(),c.stamp(),json.dumps({"resourceWait":{"id":"episode","startedAt":c.stamp(),"waitedSec":1800,"counters":{"capacity":1},"lastPhase":{"category":"capacity","at":0}}})))
 db.execute("""INSERT INTO logical_sessions(logical_ref,project,role,current_session_ref,epoch,state,pending_session_ref,rotation_id,updated_at) VALUES('logical','P','conductor','old',1,'ROTATING','next','rotation',?)""",(c.stamp(),));db.commit()
 operation=db.execute("SELECT * FROM operations WHERE id='op'").fetchone()
 c.finish(db,operation,"QUEUED","capacity",resource_receipt={"ok":False,"deliveryStage":"PRE_SEND","code":"CAPACITY_WAIT"})
 notice=db.execute("SELECT * FROM operations WHERE kind='management'").fetchone()
 assert notice["status"]=="WAITING_ROUTE" and notice["session_ref"]=="old"
 assert notice["event_id"]=="resource-wait:op:episode"
 assert db.execute("SELECT status FROM management_deliveries").fetchone()[0]=="WAITING_ROUTE"
 before=dict(db.execute("SELECT * FROM operations WHERE id='op'").fetchone())
 c.refresh_waiting_routes(db);assert db.execute("SELECT status FROM operations WHERE kind='management'").fetchone()[0]=="WAITING_ROUTE"
 # Commit through the formal ACK API, rather than fabricating a successor link.
 ack=c.rotation_ack(db,{"rotationId":"rotation","callerRef":"next","message":"synthetic successor ACK"},config,state)
 assert ack["state"]=="ACTIVE" and ack["currentSessionRef"]=="next"
 sends=[]
 def send(args,**kwargs):
  sends.append(args);return subprocess.CompletedProcess(args,0,json.dumps({"ok":True,"delivered":True}),"")
 c.run_bridge=send
 delivered=c.work_one(db)
 assert delivered["status"]=="SENT" and delivered["sessionRef"]=="next"
 assert sends[0][1:3]==["send","next"] and len(sends)==1
 assert c.work_one(db)["status"]=="IDLE" and len(sends)==1
 assert db.execute("SELECT count(*) FROM management_events").fetchone()[0]==1
 delivery=db.execute("SELECT * FROM management_deliveries").fetchone()
 assert delivery["status"]=="DELIVERED" and delivery["target_ref"]=="next"
 assert delivery["operation_id"]==notice["id"]
 assert dict(db.execute("SELECT * FROM operations WHERE id='op'").fetchone())==before
 db.close()
print("PASS")`),"PASS"));

test("dirty or unresolved installation sources never touch destinations or publish a verified manifest",()=>assert.equal(python(String.raw`import importlib.util,pathlib,tempfile,json,subprocess,os,shutil
spec=importlib.util.spec_from_file_location("release",str(pathlib.Path("src/release-version.py").resolve()));r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);repo=p/"source";(repo/"src").mkdir(parents=True);(repo/"scripts").mkdir()
 shutil.copyfile("src/release-version.py",repo/"src/release-version.py")
 shutil.copyfile("scripts/install.sh",repo/"scripts/install.sh")
 source=repo/"src/main.js";source.write_text("clean source")
 def git(*args):
  result=subprocess.run(["git","-C",str(repo),*args],capture_output=True,text=True);assert result.returncode==0,result.stderr;return result.stdout
 git("init","-q");git("add",".");git("-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-qm","private fixture")
 expected=r.source_release(repo)
 destination=p/"destination"
 for d in ("bin","share","skills"): (destination/d).mkdir(parents=True)
 (destination/"share/main.js").write_text("existing target")
 (destination/"bin/chat-bridge").write_text("existing CLI")
 manifest=destination/"share/release-manifest.json";manifest.write_text('{"existing":"manifest"}')
 env={**os.environ,"CHAT_BRIDGE_BIN_DIR":str(destination/"bin"),"CHAT_BRIDGE_SHARE_DIR":str(destination/"share"),"CHAT_BRIDGE_SKILLS_DIR":str(destination/"skills")}
 def snapshot():return {str(f.relative_to(destination)):f.read_bytes() for f in destination.rglob("*") if f.is_file()}
 original=snapshot()
 source.write_text("dirty tracked source")
 failed=subprocess.run(["zsh",str(repo/"scripts/install.sh")],env=env,capture_output=True,text=True)
 assert failed.returncode and "INSTALL_SOURCE_DIRTY" in failed.stderr and snapshot()==original
 # Publication must also reject a source changed after a clean preflight.
 mapping=p/"mapping";mapping.write_text(str(source)+"\t"+str(destination/"share/main.js")+"\n")
 try:r.install_manifest(repo,mapping,manifest,json.dumps(expected));raise AssertionError("dirty manifest published")
 except ValueError as error:assert "INSTALL_SOURCE_DIRTY" in str(error)
 assert snapshot()==original
 git("checkout","--","src/main.js");(repo/"untracked").write_text("untracked")
 failed=subprocess.run(["zsh",str(repo/"scripts/install.sh")],env=env,capture_output=True,text=True)
 assert failed.returncode and "INSTALL_SOURCE_DIRTY" in failed.stderr and snapshot()==original
 (repo/"untracked").unlink()
 (repo/".git/HEAD").write_text("f"*40+"\n")
 failed=subprocess.run(["zsh",str(repo/"scripts/install.sh")],env=env,capture_output=True,text=True)
 assert failed.returncode and "INSTALL_SOURCE_UNRESOLVED" in failed.stderr and snapshot()==original
 # Matching destination bytes never make a dirty/unresolved manifest verified.
 valid={"root":str(repo),"commit":"a"*40,"tree":"b"*40,"clean":True}
 for source_identity in ({**valid,"clean":False},{**valid,"tree":None},{**valid,"commit":"unresolved"}):
  r.atomic_json(manifest,{"source":source_identity,"files":[{"destination":str(destination/"share/main.js"),"sha256":r.file_hash(destination/"share/main.js")}]})
  assert not r.disk_release(destination/"share")["verified"]
print("PASS")`),"PASS"));
