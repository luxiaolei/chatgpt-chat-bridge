import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

const script=String.raw`
import importlib.util, tempfile, pathlib, json, os, sys, hashlib, subprocess
spec=importlib.util.spec_from_file_location("coordinator", pathlib.Path("src/coordinator.py").resolve())
c=importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
case=sys.argv[1]
os.environ.pop("CHAT_BRIDGE_FROM_ACCOUNT_ID",None);os.environ.pop("CHAT_BRIDGE_FROM_SPACE",None)
sid="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
candidate="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
uid="cccccccc-cccc-cccc-cccc-cccccccccccc"
project="g-p-"+"a"*32
sha=lambda x:hashlib.sha256(x.encode()).hexdigest()
with tempfile.TemporaryDirectory() as root:
    config=pathlib.Path(root)/"config";state=pathlib.Path(root)/"state";config.mkdir();state.mkdir()
    reg={"version":2,"accounts":{"a":{"identity":"one"}},"projects":{"P":{"rootController":"conductor","bindings":{"a":{"projectUrl":"https://chatgpt.com/g/"+project+"/project","projectId":project,"spaceName":"chat-bridge-agent-a","profileId":"Profile 1"}}}},
         "chats":{sid:{"id":sid,"project":"P","account":"a","role":"conductor","status":"active"}}}
    (config/"registry.json").write_text(json.dumps(reg))
    (state/"runtime.json").write_text(json.dumps({"version":2,"tasks":{},"sessions":{},"projects":{}}))
    db=c.connection(config,state)
    rotation=c.rotation_prepare(db,{"project":"P","role":"conductor","handoff":"checkpoint CP-1\nunfinished only"})
    op=rotation["operationId"]
    row=dict(db.execute("SELECT * FROM operations WHERE id=?",(op,)).fetchone())
    body=row["message"]
    witness={"format":"chatgpt-native-getText-v1","requestHash":sha(" ".join(body.split())),
             "bodyHash":sha(body),"normalizedBodyHash":sha(" ".join(body.split())),
             "accountIdentityHash":sha("one"),"url":"https://chatgpt.com/g/"+project+"/project",
             "getterHash":"1"*64,"serializerHash":"2"*64,"observedAt":c.stamp(),"messageId":None}
    db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',attempts=6,result=? WHERE id=?",
               (json.dumps({"nativeWitness":witness,"worker":{"prior":"retained"}}),op));db.commit()
    calls=[]
    def observe(command):
        calls.append(command)
        context=c.observation_context(db,op,candidate if "--candidate" in command else None)
        result={**{k:context[k] for k in ("operationId","taskId","project","account","accountId","sessionRef","anchor","url")},
                "ok":True,"format":"operation-native-observation-v1","observedAt":c.stamp(),"messageSent":False,
                "generating":case=="draft","draftChars":42 if case=="draft" else 0,
                "online":True,"errorTexts":[],"recoveryControls":[],"recoveryRequired":False,"pageWasDiscarded":False,
                "userMessages":[{"id":uid,"userSource":{"messageId":uid,"conversationId":candidate,"text":body}}]}
        if case=="offline":result["online"]=False
        if case=="network-error":result["errorTexts"]=["Network error"]
        if case=="discarded":result["pageWasDiscarded"]=True
        if case=="recovery-ui":result["recoveryRequired"]=True
        if case=="pacing":return subprocess.CompletedProcess(command,75,"",json.dumps({"ok":False,"deliveryStage":"PRE_SEND","status":"DEFERRED","reason":"UI_LOCK_BUSY","code":"PACING_DEFERRED","retryAfterSec":5}))
        if case=="identity-error":return subprocess.CompletedProcess(command,1,"",json.dumps({"ok":False,"deliveryStage":"PRE_SEND","code":"OPERATION_OBSERVATION_LOGIN_MISMATCH"}))
        if case=="transport":return subprocess.CompletedProcess(command,1,"","connection reset by peer")
        if case=="timeout":raise subprocess.TimeoutExpired(command,10,stderr=b"timed out")
        if case=="wrong-login":result["accountId"]="wrong"
        if case=="wrong-project":result["url"]=result["url"].replace(project,"g-p-"+"d"*32)
        if case=="wrong-cid":result["sessionRef"]="eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"
        if case=="wrong-uid":result["userMessages"][0]["id"]="different"
        if case=="temporary":result["userMessages"][0]["userSource"]["conversationId"]="local-chatgpt:"+candidate
        if case=="wrong-body":result["userMessages"][0]["userSource"]["text"]+="extra"
        if case=="missing":result["userMessages"]=[]
        if case=="duplicate":result["userMessages"]*=2
        if case=="stale-observation":result["observedAt"]="2000-01-01T00:00:00Z"
        if case=="observation-race":
            db.execute("UPDATE operations SET attempts=attempts+1 WHERE id=?",(op,));db.commit()
        return subprocess.CompletedProcess(command,0,json.dumps(result),"")
    c.run_bridge=observe
    if case=="wrong-predecessor-project":
        reg["chats"][sid]["project"]="Other"
        db.execute("UPDATE documents SET payload=? WHERE kind=\'registry\'",(json.dumps(reg),));db.commit()
    if case=="wrong-handoff":
        db.execute("UPDATE operations SET original_message='different' WHERE id=?",(op,));db.commit()
    if case=="wrong-witness":
        witness["accountIdentityHash"]="f"*64
        db.execute("UPDATE operations SET result=? WHERE id=?",(json.dumps({"nativeWitness":witness}),op));db.commit()
    if case=="wrong-epoch":
        db.execute("UPDATE logical_sessions SET epoch=epoch+1");db.commit()
    if case=="occupied":
        reg["chats"][candidate]={"id":candidate,"project":"P","account":"a","role":"other","status":"active"}
        db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(reg),));db.commit()
    if case=="pending":
        db.execute("UPDATE logical_sessions SET pending_session_ref=?",(candidate,));db.commit()
    if case in {"source-cid-conflict","historical-first-conflict"}:
        witness["postSend"]={"sourceConversationId":sid} if case=="source-cid-conflict" else {"sourceConversationId":candidate,"sourceBodyHash":sha(body),"missingCondition":"NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT","temporarySourceFirstConflict":{"reason":"SOURCE_BODY_CHANGED","sourceBodyHash":sha("different")}}
        db.execute("UPDATE operations SET result=? WHERE id=?",(json.dumps({"nativeWitness":witness}),op));db.commit()
    if case in {"prior-cid","prior-user"}:
        prior={"nativeWitness":witness}
        if case=="prior-cid":prior["newSession"]={"observedConversationId":sid}
        else:witness["postSend"]={"sourceMessageId":sid}
        db.execute("UPDATE operations SET result=? WHERE id=?",(json.dumps(prior),op));db.commit()
    before="\n".join(db.iterdump())
    payload={"operationId":op,"candidate":candidate}
    negative=case in {"wrong-login","wrong-project","wrong-cid","wrong-uid","temporary","wrong-body","missing","duplicate",
                     "stale-observation","wrong-handoff","wrong-witness","wrong-epoch","occupied","pending","prior-cid","prior-user","wrong-predecessor-project","source-cid-conflict","historical-first-conflict","offline","network-error","discarded","recovery-ui"}
    if negative:
        try:c.rotation_recover(db,payload);raise AssertionError("accepted invalid evidence")
        except ValueError as e:
            expected={"source-cid-conflict":"PRIOR_IDENTITY_CONFLICT","historical-first-conflict":"PRIOR_IDENTITY_CONFLICT","offline":"UNHEALTHY","network-error":"UNHEALTHY","discarded":"UNHEALTHY","recovery-ui":"UNHEALTHY","wrong-predecessor-project":"LOGICAL_MISMATCH","wrong-login":"IDENTITY_MISMATCH","wrong-project":"IDENTITY_MISMATCH","wrong-cid":"IDENTITY_MISMATCH",
                      "wrong-uid":"SOURCE_IDENTITY","temporary":"SOURCE_IDENTITY","wrong-body":"NOT_UNIQUE","missing":"NOT_UNIQUE",
                      "duplicate":"NOT_UNIQUE","stale-observation":"TIME_INVALID","wrong-handoff":"HANDOFF_MISMATCH",
                      "prior-cid":"PRIOR_IDENTITY_CONFLICT","prior-user":"PRIOR_IDENTITY_CONFLICT","wrong-witness":"WITNESS_MISMATCH","wrong-epoch":"HANDOFF_MISMATCH","occupied":"OCCUPIED","pending":"LOGICAL_MISMATCH"}[case]
            assert expected in str(e), str(e)
        assert "\n".join(db.iterdump())==before
    elif case in {"pacing","identity-error","transport","timeout"}:
        try:c.observe_operation(db,op,candidate);raise AssertionError("failed observation accepted")
        except ValueError as e:
            detail=e.detail
            assert detail["deliveryStatus"]=="DELIVERY_UNKNOWN" and detail["retryOriginalOperation"] is False
            expected={"pacing":"DEFERRED","identity-error":"IDENTITY_REJECTED","transport":"UNKNOWN","timeout":"UNKNOWN"}[case]
            assert detail["observation"]["outcome"]==expected
            if case=="pacing":assert detail["observation"]["receipt"]["retryAfterSec"]==5 and detail["readDeferred"]["retryAfterSec"]==5
            if case=="transport":assert detail["observation"]["receipt"] is None and "connection reset" in detail["observation"]["worker"]["stderrTail"]
        assert "\n".join(db.iterdump())==before
    elif case=="observation-race":
        try:c.rotation_recover(db,payload);raise AssertionError("accepted changed operation")
        except ValueError as e:assert "CHANGED" in str(e)
        assert db.execute("SELECT status FROM operations").fetchone()[0]=="DELIVERY_UNKNOWN"
    elif case=="missing-task-observe":
        db.execute("UPDATE operations SET kind='dispatch',session_ref=? WHERE id=?",(sid,op));db.commit()
        before="\n".join(db.iterdump())
        result=c.observe_operation(db,op)
        assert result["sessionRef"]==sid
        assert json.loads(db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()[0])["tasks"]=={}
        assert "\n".join(db.iterdump())==before
        assert all(command[1]=="operation-evidence" for command in calls)
    else:
        preview=c.rotation_recover(db,payload)
        assert preview["state"]=="RECOVERY_PREVIEW" and "\n".join(db.iterdump())==before
        assert preview["proof"]["historicalBeforeUserId"] is None
        if case=="stale-preview":
            db.execute("UPDATE operations SET attempts=attempts+1 WHERE id=?",(op,));db.commit()
            try:c.rotation_recover(db,{**payload,"confirm":True,"expected":preview["expected"]});raise AssertionError("accepted stale preview")
            except ValueError as e:assert "PREVIEW_CHANGED" in str(e)
        elif case in {"candidate-op-race","candidate-logical-race"}:
            original=c.begin_immediate
            def race(database):
                table="operations" if case=="candidate-op-race" else "logical_sessions"
                conflict=dict(database.execute("SELECT * FROM "+table).fetchone())
                if table=="operations":conflict.update(id="competitor",request_key="competitor",rotation_id=None,kind="dispatch",session_ref=candidate)
                else:conflict.update(logical_ref="competitor",role="other",rotation_id="other",pending_session_ref=candidate)
                keys=list(conflict)
                database.execute("INSERT INTO "+table+" ("+",".join(keys)+") VALUES ("+",".join("?" for _ in keys)+")",[conflict[k] for k in keys]);database.commit();original(database)
            c.begin_immediate=race
            try:c.rotation_recover(db,{**payload,"confirm":True,"expected":preview["expected"]});raise AssertionError("accepted occupied candidate race")
            except ValueError as e:assert "OCCUPIED" in str(e)
            assert db.execute("SELECT status FROM operations WHERE id=?",(op,)).fetchone()[0]=="DELIVERY_UNKNOWN"
        elif case=="cas-race":
            original=c.begin_immediate
            def race(database):
                database.execute("UPDATE logical_sessions SET epoch=epoch+1");database.commit();original(database)
            c.begin_immediate=race
            try:c.rotation_recover(db,{**payload,"confirm":True,"expected":preview["expected"]});raise AssertionError("accepted CAS race")
            except ValueError as e:assert "CAS_CHANGED" in str(e)
        else:
            result=c.rotation_recover(db,{**payload,"confirm":True,"expected":preview["expected"]})
            assert result["state"]=="RECOVERED_PENDING_ACK"
            logical=db.execute("SELECT * FROM logical_sessions").fetchone()
            assert logical["current_session_ref"]==sid and logical["pending_session_ref"]==candidate and logical["epoch"]==1
            saved=c.registry(db);assert saved["chats"][sid]["status"]=="active" and saved["chats"][candidate]["status"]=="pending-rotation"
            saved_op=db.execute("SELECT * FROM operations WHERE id=?",(op,)).fetchone()
            assert saved_op["status"]=="SENT" and saved_op["attempts"]==6
            assert json.loads(saved_op["result"])["nativeWitness"]==witness
            assert json.loads(saved_op["result"])["worker"]=={"prior":"retained"}
            for caller,origin in [(candidate,None),(sid,c.account_id("one")),(candidate,c.account_id("other"))]:
                if origin:os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=origin
                else:os.environ.pop("CHAT_BRIDGE_FROM_ACCOUNT_ID",None)
                try:c.rotation_ack(db,{"rotationId":rotation["rotationId"],"callerRef":caller,"message":"verified"},config,state);raise AssertionError("invalid ACK accepted")
                except ValueError:pass
                assert c.registry(db)["chats"][sid]["status"]=="active"
            os.environ["CHAT_BRIDGE_FROM_ACCOUNT_ID"]=c.account_id("one")
            ack=c.rotation_ack(db,{"rotationId":rotation["rotationId"],"callerRef":candidate,"message":"skills, host, model and durable work verified"},config,state)
            assert ack["currentSessionRef"]==candidate and ack["epoch"]==2
            assert c.registry(db)["chats"][sid]["status"]=="retired"
            assert ack["resumedTasks"]==[]
            try:c.rotation_ack(db,{"rotationId":rotation["rotationId"],"callerRef":candidate,"message":"again"},config,state);raise AssertionError("duplicate ACK")
            except ValueError:pass
        assert all(command[1]=="operation-evidence" for command in calls)
    db.close()
`;

for(const name of ["success","draft","wrong-login","wrong-project","wrong-cid","wrong-uid","temporary","wrong-body","missing","duplicate","stale-observation","wrong-handoff","wrong-witness","wrong-epoch","occupied","pending","observation-race","stale-preview","cas-race","missing-task-observe","prior-cid","prior-user","wrong-predecessor-project","source-cid-conflict","historical-first-conflict","candidate-op-race","candidate-logical-race","offline","network-error","discarded","recovery-ui","pacing","identity-error","transport","timeout"]) {
  test("existing rotation / operation observation: "+name,()=>{
    const env={...process.env,PYTHONDONTWRITEBYTECODE:"1"};
    delete env.CHAT_BRIDGE_FROM_ACCOUNT_ID;delete env.CHAT_BRIDGE_FROM_SPACE;delete env.CODEX_THREAD_ID;
    const result=spawnSync("python3",["-c",script,name],{encoding:"utf8",env});
    assert.equal(result.status,0,result.stderr+"\n"+result.stdout);
  });
}
