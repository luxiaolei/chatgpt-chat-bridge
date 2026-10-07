import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const script=String.raw`
import importlib.util,tempfile,pathlib,json,os,sys,hashlib,subprocess,copy,shlex
spec=importlib.util.spec_from_file_location("coordinator",pathlib.Path("src/coordinator.py").resolve())
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
case=sys.argv[1]
owner="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";candidate="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
late="cccccccc-cccc-cccc-cccc-cccccccccccc";second="dddddddd-dddd-dddd-dddd-dddddddddddd"
project="g-p-"+"a"*32;url=lambda cid:"https://chatgpt.com/g/"+project+"/c/"+cid
with tempfile.TemporaryDirectory(prefix="bridge-quarantine-") as root:
 config=pathlib.Path(root)/"config";state=pathlib.Path(root)/"state";config.mkdir();state.mkdir()
 reg={"version":2,"accounts":{"a":{"identity":"one"},"alias":{"identity":"one"}},"projects":{"P":{"rootController":"lead","bindings":{"a":{"projectUrl":"https://chatgpt.com/g/"+project+"/project","profileId":"Profile 1"}}}},"chats":{owner:{"id":owner,"url":url(owner),"project":"P","account":"a","role":"lead","status":"active"}}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps({"version":2,"tasks":{},"sessions":{},"projects":{}}))
 db=c.connection(config,state)
 cp=lambda sid,version:c.checkpoint(db,{"project":"P","role":"lead","sessionRef":sid,"summary":"unfinished; old UNKNOWN preserved","version":version})
 cp(owner,"before")
 old=c.rotation_prepare(db,{"project":"P","role":"lead","handoff":c.checkpoint_handoff(c.latest_checkpoint(db,"P","lead"))})
 db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',attempts=8,result=? WHERE id=?",(json.dumps({"worker":{"error":"legacy timeout"}}),old["operationId"]));db.commit()
 original=dict(db.execute("SELECT * FROM operations WHERE id=?",(old["operationId"],)).fetchone())
 captured={**original,"status":"DISPATCHING","claimed_at":"old-claim"}
 def rejected(fn,contains=None):
  try:fn()
  except ValueError as e:
   if contains:assert contains in str(e),str(e)
   return
  raise AssertionError("invalid operation accepted")
 def dump():return "\n".join(db.iterdump())
 payload={"operationId":old["operationId"],"reason":"legacy child cannot be proven stopped"}
 preview=c.rotation_quarantine(db,payload)
 if case=="public-readonly-preview":
  before=dump();projection=(config/"registry.json").read_bytes()
  result=subprocess.run([sys.executable,"src/coordinator.py","control",str(config),str(state),"rotation-quarantine","--operation",old["operationId"],"--reason",payload["reason"]],text=True,capture_output=True)
  assert result.returncode==0,result.stderr
  assert json.loads(result.stdout)["state"]=="QUARANTINE_PREVIEW"
  assert dump()==before and (config/"registry.json").read_bytes()==projection
 elif case=="readonly-preview":
  before=dump();projection=(config/"registry.json").read_bytes()
  reader=c.connection(config,state,initialize=False);reader.execute("PRAGMA query_only=ON");reader.execute("BEGIN")
  assert c.rotation_quarantine(reader,payload)["expected"]==preview["expected"]
  writer=c.connection(config,state,initialize=False);writer.execute("BEGIN IMMEDIATE");writer.rollback();writer.close();reader.close()
  assert dump()==before and (config/"registry.json").read_bytes()==projection
 elif case=="quarantine-race":
  original_begin=c.begin_immediate
  def race(database):
   database.execute("UPDATE logical_sessions SET epoch=epoch+1");database.commit();original_begin(database)
  c.begin_immediate=race
  rejected(lambda:c.rotation_quarantine(db,{**payload,"confirm":True,"expected":preview["expected"]}),"ORIGINAL_REQUIRED")
  assert db.execute("SELECT count(*) FROM management_events").fetchone()[0]==0
 else:
  event=c.rotation_quarantine(db,{**payload,"confirm":True,"expected":preview["expected"]})["eventId"]
  assert dict(db.execute("SELECT * FROM operations WHERE id=?",(old["operationId"],)).fetchone())==original
  assert c.rotation_quarantine(db,{**payload,"confirm":True,"expected":preview["expected"]})["alreadyRecorded"]
  def put(cid,status="active",registration=None,account="a",base=None,role="lead"):
   base=base or c.registry(db);new=copy.deepcopy(base)
   new["chats"][cid]={"id":cid,"url":url(cid),"project":"P","role":role,"account":account,"status":status}
   if case=="wrong-project-url":new["chats"][cid]["url"]=url(cid).replace(project,"g-p-"+"f"*32)
   if case=="wrong-cid-url":new["chats"][cid]["url"]=url(late)
   if case=="wrong-registration-account":new["chats"][cid]["account"]="alias"
   if case=="wrong-role":new["chats"][cid]["role"]="lead";new["chats"][cid]["logicalRef"]="foreign"
   p={"base":base,"next":new}
   if registration is not None:p["registration"]=registration
   return subprocess.run([sys.executable,str(pathlib.Path("src/state-store.py").resolve()),"put",str(config),str(state),"registry"],input=json.dumps(p),text=True,capture_output=True)
  def fenced(result):
   assert result.returncode!=0 and "ROTATION_REGISTRATION_FENCED" in result.stderr,result.stderr
   evidence=json.loads(db.execute("SELECT evidence FROM reconciliation_attempts ORDER BY rowid DESC LIMIT 1").fetchone()[0])
   assert evidence["nativeDeliveryProof"] is False
   if case in {"old-unknown-descriptor","stale-attempt","stale-claimed-at"}:
    assert evidence["verifiedExpiredClaim"]["expired"] is True
    assert evidence["verifiedExpiredClaim"]["operationId"]==registration["attempt"]["operationId"]
  def prepare():return c.rotation_prepare(db,{"project":"P","role":"lead","quarantineEvent":event})
  if case=="legacy-before-prepare":fenced(put(late,base=reg))
  elif case=="stale-checkpoint":rejected(prepare,"CHECKPOINT")
  elif case=="unauthorized-quarantine":
   os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]="f"*64
   rejected(lambda:c.rotation_quarantine(db,{**payload,"callerRef":owner,"confirm":True,"expected":preview["expected"]}),"ORIGIN")
  elif case in {"finish-stale-management","finish-stale-callback"}:
   stale=copy.deepcopy(original);stale.update(id="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",request_key="stale-fixture",status="DISPATCHING",claimed_at="newer",attempts=9)
   stale["kind"]="management" if case=="finish-stale-management" else "callback"
   stale["event_id"]="synthetic-event" if stale["kind"]=="management" else "result:synthetic"
   stale["session_ref"]=owner
   keys=list(stale);db.execute("INSERT INTO operations("+",".join(keys)+") VALUES("+",".join("?" for k in keys)+")",[stale[k] for k in keys])
   if stale["kind"]=="management":
    db.execute("INSERT INTO management_deliveries(event_id,target_ref,status,updated_at) VALUES(?,?,?,?)",(stale["event_id"],owner,"PENDING","before"))
   else:
    db.execute("INSERT INTO task_results(task_id,result_version,event_id,status,summary,payload_hash,recorded_at,callback_status) VALUES(?,?,?,?,?,?,?,?)",("T","v1",stale["event_id"],"COMPLETE","fixture","hash","before","PENDING"))
   db.commit();before=dump();c.finish(db,{**stale,"attempts":8,"claimed_at":"older"},"SENT")
   assert dump()==before
  elif case=="finish-unknown":
   before=dump();c.finish(db,captured,"SENT",session_ref=late);assert dump()==before
  else:
   cp(owner,"after")
   if case=="wrong-logical-ref":rejected(lambda:c.rotation_prepare(db,{"project":"P","role":"lead","logicalRef":"other","quarantineEvent":event}),"LOGICAL")
   elif case=="wrong-prepare-event":rejected(lambda:c.rotation_prepare(db,{"project":"P","role":"lead","quarantineEvent":"foreign"}),"EVENT")
   elif case=="wrong-handoff":rejected(lambda:c.rotation_prepare(db,{"project":"P","role":"lead","quarantineEvent":event,"handoff":"arbitrary"}),"CHECKPOINT")
   elif case=="unauthorized-prepare":
    os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]="f"*64
    rejected(lambda:c.rotation_prepare(db,{"project":"P","role":"lead","quarantineEvent":event,"callerRef":owner}),"ORIGIN")
   elif case=="prepare-race":
    original_begin=c.begin_immediate
    def race(database):
     database.execute("UPDATE logical_sessions SET epoch=epoch+1");database.commit();original_begin(database)
    c.begin_immediate=race;rejected(prepare,"CAS")
    assert db.execute("SELECT count(*) FROM operations").fetchone()[0]==1
   else:
    fresh=prepare()
    assert db.execute("SELECT event_id FROM operations WHERE id=?",(fresh["operationId"],)).fetchone()[0]==event
    row=c.claim(db);assert row["id"]==fresh["operationId"]
    descriptor=c.delivery_attempt_module().prepare(state,row)
    registration={"attempt":descriptor,"sessionId":candidate,"messageSha256":hashlib.sha256(row["message"].encode()).hexdigest()}
    if case=="old-unknown-descriptor":
     db.execute("UPDATE operations SET status='DISPATCHING',claimed_at='old' WHERE id=?",(old["operationId"],));db.commit()
     registration["attempt"]=c.delivery_attempt_module().prepare(state,db.execute("SELECT * FROM operations WHERE id=?",(old["operationId"],)).fetchone())
     db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',claimed_at=? WHERE id=?",(original["claimed_at"],old["operationId"]));db.commit()
    if case=="unbounded-descriptor":registration["attempt"]={**descriptor,"directory":"x"*100000,"arbitrary":"y"*100000}
    if case=="candidate-already-registered":
     changed=c.registry(db);changed["chats"][candidate]={"id":candidate,"url":url(candidate),"project":"P","role":"worker","account":"a","status":"active"}
     db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(changed),));db.commit()
    if case=="stale-attempt":db.execute("UPDATE operations SET attempts=attempts+1 WHERE id=?",(row["id"],));db.commit()
    if case=="stale-claimed-at":db.execute("UPDATE operations SET claimed_at='later' WHERE id=?",(row["id"],));db.commit()
    if case=="wrong-epoch":db.execute("UPDATE logical_sessions SET epoch=epoch+1");db.commit()
    if case=="wrong-event":db.execute("UPDATE operations SET event_id='wrong' WHERE id=?",(row["id"],));db.commit()
    if case=="wrong-owner":db.execute("UPDATE logical_sessions SET current_session_ref=?",(late,));db.commit()
    if case=="forged-descriptor":registration["attempt"]={**descriptor,"manifestSha256":"f"*64}
    if case=="wrong-body":registration["messageSha256"]="f"*64
    if case=="wrong-origin":os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]="f"*64
    if case=="missing-descriptor":registration=None
    if case in {"stale-attempt","stale-claimed-at","wrong-epoch","wrong-event","wrong-owner","forged-descriptor","wrong-body","wrong-origin","missing-descriptor","old-unknown-descriptor","unbounded-descriptor","wrong-project-url","wrong-cid-url","wrong-registration-account","wrong-role","candidate-already-registered"}:
     projection=(config/"registry.json").read_bytes();fenced(put(candidate,"pending-rotation",registration))
     if case=="candidate-already-registered":assert c.registry(db)["chats"][candidate]["role"]=="worker"
     else:assert candidate not in c.registry(db)["chats"]
     assert (config/"registry.json").read_bytes()==projection
     if case=="unbounded-descriptor":
      evidence=db.execute("SELECT evidence FROM reconciliation_attempts ORDER BY rowid DESC LIMIT 1").fetchone()[0]
      assert len(evidence)<2500 and "arbitrary" not in evidence,evidence
    elif case=="finish-stale-claim":
     db.execute("UPDATE operations SET attempts=attempts+1 WHERE id=?",(row["id"],));db.commit()
     before=dump();c.finish(db,row,"SENT",session_ref=late);assert dump()==before
    else:
     result=put(candidate,"pending-rotation",registration);assert result.returncode==0,result.stderr
     assert c.registry(db)["chats"][candidate]["status"]=="pending-rotation"
     fenced(put(late,base=reg));c.finish(db,row,"SENT",session_ref=candidate)
     ack={"rotationId":fresh["rotationId"],"callerRef":candidate,"message":"skills/tools/host/model verified"}
     if case=="pending-observation":
      attached=c.registry(db);attached["chats"][candidate].update(spaceName="chat-bridge-agent-a-overflow",spaceId=42,profileId="Profile 1",page="p4")
      db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(attached),));db.commit()
      before=dump();projection=(config/"registry.json").read_bytes()
      reader=c.connection(config,state,initialize=False);reader.execute("PRAGMA query_only=ON")
      context=c.observation_context(reader,None,pending_session=candidate)
      assert context["sessionRef"]==candidate and context["operationId"]==row["id"]
      assert dump()==before and (config/"registry.json").read_bytes()==projection
      reader.close()
      result=subprocess.run([sys.executable,"src/coordinator.py","observation-context",str(config),str(state)],input=json.dumps({"pendingSession":candidate}),text=True,capture_output=True)
      assert result.returncode==0,result.stderr
      assert json.loads(result.stdout)["anchor"]==context["anchor"] and dump()==before
      rejected(lambda:c.observation_context(db,row["id"]),"UNKNOWN_BROWSER")
      changes=[
       "UPDATE operations SET status='DELIVERY_UNKNOWN' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET kind='dispatch' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET force_new=0 WHERE id='"+row["id"]+"'",
       "UPDATE operations SET caller_ref='foreign' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET account_id='foreign' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET session_ref='foreign' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET payload_hash='foreign' WHERE id='"+row["id"]+"'",
       "UPDATE operations SET workgroup_id='foreign' WHERE id='"+row["id"]+"'",
       "UPDATE logical_sessions SET state='ACTIVE'",
       "UPDATE logical_sessions SET pending_session_ref=NULL",
       "UPDATE logical_sessions SET epoch=epoch+1",
       "UPDATE logical_sessions SET current_session_ref='foreign'"
      ]
      for change in changes:
       db.execute("SAVEPOINT invalid_observation");db.execute(change)
       rejected(lambda:c.observation_context(db,None,pending_session=candidate),"OBSERVATION")
       db.execute("ROLLBACK TO invalid_observation");db.execute("RELEASE invalid_observation")
      for field,value in [("status","active"),("account","alias"),("project","foreign"),("role","foreign"),("workgroupId","foreign"),("url",url(late))]:
       changed=c.registry(db);changed["chats"][candidate][field]=value
       db.execute("SAVEPOINT invalid_observation");db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(changed),))
       rejected(lambda:c.observation_context(db,None,pending_session=candidate),"OBSERVATION")
       db.execute("ROLLBACK TO invalid_observation");db.execute("RELEASE invalid_observation")
      assert dump()==before and (config/"registry.json").read_bytes()==projection
     elif case=="ack-wrong-caller":
      os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      rejected(lambda:c.rotation_ack(db,{**ack,"callerRef":owner},config,state),"ACK")
     elif case=="ack-empty-verification":
      os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      rejected(lambda:c.rotation_ack(db,{**ack,"message":""},config,state),"ACK")
     elif case=="ack-wrong-operation":
      db.execute("UPDATE operations SET event_id='wrong' WHERE id=?",(row["id"],));db.commit()
      os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      rejected(lambda:c.rotation_ack(db,ack,config,state),"PROOF")
     elif case=="ack-no-origin":rejected(lambda:c.rotation_ack(db,ack,config,state),"ACK")
     elif case=="ack-extra-active":
      changed=c.registry(db);changed["chats"][late]={"id":late,"url":url(late),"project":"P","role":"lead","account":"alias","status":"active"}
      db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(changed),));db.commit()
      os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      rejected(lambda:c.rotation_ack(db,ack,config,state),"UNIQUE")
     else:
      os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      if case=="generated-public-ack":
       command=next(line for line in row["message"].splitlines() if line.startswith("chat-bridge control rotation-ack "))
       argv=shlex.split(command.replace("<successor-session-ref>",candidate).replace("<verification-summary>",'"skills host model verified"'))
       assert argv[:3]==["chat-bridge","control","rotation-ack"]
       wrong_checks=0
       if "--caller-ref" in argv:
        foreign="ffffffff-ffff-ffff-ffff-ffffffffffff"
        assert put(foreign,role="worker").returncode==0
        for wrong in (owner,foreign):
         before=dump();wrong_args=list(argv);wrong_args[wrong_args.index("--caller-ref")+1]=wrong
         result=subprocess.run([sys.executable,"src/coordinator.py","control",str(config),str(state),*wrong_args[2:]],text=True,capture_output=True)
         assert result.returncode!=0 and "ROTATION_QUARANTINE_ACK_SUCCESSOR_REQUIRED" in result.stderr,result.stderr
         assert dump()==before;wrong_checks+=1
       result=subprocess.run([sys.executable,"src/coordinator.py","control",str(config),str(state),*argv[2:]],text=True,capture_output=True)
       assert result.returncode==0,result.stderr
       accepted=json.loads(result.stdout);assert wrong_checks==2
      else:
       accepted=c.rotation_ack(db,ack,config,state)
      assert accepted["epoch"]==2
      fenced(put(late,base=reg))
      assert c.rotation_quarantine(db,{**payload,"callerRef":candidate,"confirm":True,"expected":preview["expected"]})["epoch"]==2
      base=c.registry(db);new=copy.deepcopy(base);new["chats"][candidate]["page"]="metadata"
      metadata=subprocess.run([sys.executable,"src/state-store.py","put",str(config),str(state),"registry"],input=json.dumps({"base":base,"next":new}),text=True,capture_output=True);assert metadata.returncode==0,metadata.stderr
      assert put(late,role="worker").returncode==0
      os.environ.pop("CHAT_BRIDGE_FROM_ACCOUNT_ID",None)
      later=c.rotation_prepare(db,{"project":"P","role":"lead","handoff":"normal subsequent handoff"})
      assert later["currentSessionRef"]==candidate and later["nextEpoch"]==3
      assert db.execute("SELECT event_id FROM operations WHERE id=?",(later["operationId"],)).fetchone()[0]==event
      row2=c.claim(db);descriptor2=c.delivery_attempt_module().prepare(state,row2)
      result=put(second,"pending-rotation",{"attempt":descriptor2,"sessionId":second,"messageSha256":hashlib.sha256(row2["message"].encode()).hexdigest()});assert result.returncode==0,result.stderr
      c.finish(db,row2,"SENT",session_ref=second);os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
      accepted=c.rotation_ack(db,{"rotationId":later["rotationId"],"callerRef":second,"message":"current successor verified"},config,state)
      assert accepted["epoch"]==3 and accepted["currentSessionRef"]==second
      fenced(put(owner,base=c.registry(db)))
      active=[x["id"] for x in c.registry(db)["chats"].values() if x.get("role")=="lead" and x.get("status","active")=="active"]
      assert active==[second],active
  assert dict(db.execute("SELECT * FROM operations WHERE id=?",(old["operationId"],)).fetchone())==original
 db.close()
print("PASS",case)
`;

for(const name of ["positive-chain","readonly-preview","quarantine-race","legacy-before-prepare","stale-checkpoint","wrong-logical-ref","prepare-race","finish-unknown","finish-stale-claim","stale-attempt","stale-claimed-at","wrong-epoch","wrong-event","wrong-owner","forged-descriptor","wrong-body","wrong-origin","missing-descriptor","ack-no-origin","ack-extra-active","unauthorized-quarantine","wrong-prepare-event","wrong-handoff","unauthorized-prepare","old-unknown-descriptor","unbounded-descriptor","wrong-project-url","wrong-cid-url","wrong-registration-account","wrong-role","ack-wrong-caller","ack-empty-verification","ack-wrong-operation","public-readonly-preview","finish-stale-management","finish-stale-callback","candidate-already-registered","generated-public-ack","pending-observation"]) {
  test("actual SQLite rotation quarantine: "+name,()=>{
    const env={...process.env,PYTHONDONTWRITEBYTECODE:"1"};
    // Only the private fixture child loses inherited origin; the parent stays unchanged.
    for(const key of Object.keys(env))if(key.startsWith("CHAT_BRIDGE_FROM_"))delete env[key];
    const result=spawnSync("python3",["-c",script,name],{encoding:"utf8",env,timeout:15000});
    assert.equal(result.status,0,result.stdout+result.stderr);
  });
}
