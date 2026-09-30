import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const coordinator = path.resolve("src/coordinator.py");

async function fixture({twoAccounts=false}={}) {
  const root=await mkdtemp(path.join(tmpdir(),"bridge-v09-"));
  const config=path.join(root,"config"), state=path.join(root,"state"), log=path.join(root,"worker.log");
  await mkdir(config); await mkdir(state);
  const accounts={a:{identity:"one",label:"A"}};
  const bindings={a:{projectUrl:"https://chatgpt.com/g/g-p-"+ "a".repeat(32)+"/project",projectId:"g-p-"+ "a".repeat(32),spaceName:"agent-a",profileId:"Profile 1"}};
  if(twoAccounts){
    accounts.b={identity:"two",label:"B"};
    bindings.b={projectUrl:"https://chatgpt.com/g/g-p-"+ "b".repeat(32)+"/project",projectId:"g-p-"+ "b".repeat(32),spaceName:"agent-b",profileId:"Profile 2"};
  }
  const registry={
    defaultProject:"P",defaultAccount:"a",accounts,
    projects:{P:{name:"P",activeAccount:"a",rootController:"conductor",bindings,workgroups:{},businessState:"REPLANNING",durableStateRef:"https://example.invalid/issues/1"}},
    chats:{controller:{id:"controller",project:"P",account:"a",role:"conductor",status:"active",model:"Latest",effort:"High"}}
  };
  await writeFile(path.join(config,"registry.json"),JSON.stringify(registry));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({version:2,projects:{},tasks:{},sessions:{}}));
  const fake=path.join(root,"bridge-worker");
  await writeFile(fake,`#!/bin/sh
printf '%s\n' "$*" >> "${log}"
if [ -n "$CHAT_BRIDGE_TEST_FAIL_STAGE" ]; then
  printf '[error] {"ok":false,"deliveryStage":"%s","code":"%s"}\\n' "$CHAT_BRIDGE_TEST_FAIL_STAGE" "\${CHAT_BRIDGE_TEST_FAIL_CODE:-SIMULATED}" >&2
  exit 1
fi
if [ "$1" = "new" ]; then
  if [ "$CHAT_BRIDGE_TEST_STDERR_RECEIPT" = "1" ]; then
    printf '{"id":"new-worker","ok":true,"baselineAssistantCount":1,"baselineAssistantHash":"h","baselineAssistantId":"a1","modelSelection":{"model":"GPT-6","effort":"Pro"}}\\n' >&2
  else
    printf '{"id":"new-worker","ok":true,"baselineAssistantCount":1,"baselineAssistantHash":"h","baselineAssistantId":"a1","modelSelection":{"model":"GPT-6","effort":"Pro"}}\\n'
  fi
elif [ "$1" = "send" ]; then
  printf '{"ok":true,"delivered":true}\\n'
elif [ "$1" = "task" ]; then
  printf '{"ok":true}\\n'
elif [ "$1" = "stop" ]; then
  printf '{"stopped":true}\\n'
elif [ "$1" = "evidence" ]; then
  printf '%s\\n' "$CHAT_BRIDGE_TEST_EVIDENCE"
fi
`,{mode:0o755});
  const call=(command,args=[],payload=null,env={})=>{
    const result=spawnSync("python3",[coordinator,command,config,state,...args],{
      input:payload?JSON.stringify(payload):undefined,encoding:"utf8",
      env:{...process.env,CHAT_BRIDGE_FROM_ACCOUNT_ID:"",CHAT_BRIDGE_FROM_SPACE:"",CHAT_BRIDGE_BIN:fake,...env}
    });
    return result;
  };
  return {root,config,state,log,fake,call};
}

test("queue persists and forwards requested model/effort to new worker and task record", async()=>{
  const f=await fixture();
  try{
    let r=f.call("submit",[],{requestId:"m1",callerRef:"controller",role:"worker",message:"do it",model:"Latest",effort:"Pro",resourcePolicyVersion:"r1"});
    assert.equal(r.status,0,r.stderr);
    const op=JSON.parse(r.stdout);
    assert.equal(op.requestedModel,"Latest"); assert.equal(op.requestedEffort,"Pro");
    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");
    const log=await readFile(f.log,"utf8");
    assert.match(log,/\bnew --project P --account a --name worker\b/);
    assert.match(log,/--model Latest/); assert.match(log,/--effort Pro/);
    assert.match(log,/\btask set\b/); assert.match(log,/--resource-policy-version r1/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("same logical new role is atomically reserved", async()=>{
  const f=await fixture({twoAccounts:true});
  try{
    let r=f.call("submit",[],{requestId:"r1",callerRef:"controller",role:"reviewer",message:"one"});
    assert.equal(r.status,0,r.stderr);
    r=f.call("submit",[],{requestId:"r2",callerRef:"controller",role:"reviewer",message:"two"});
    assert.equal(r.status,2); assert.match(r.stderr,/ROLE_PLACEMENT_RESERVED/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("callback rejects unknown task and queue result resolves persisted owner", async()=>{
  const f=await fixture();
  try{
    let r=f.call("callback",[],{taskId:"missing",targetRef:"controller",message:"x"});
    assert.equal(r.status,2); assert.match(r.stderr,/CALLBACK_TASK_NOT_REGISTERED/);
    r=f.call("submit",[],{requestId:"q1",callerRef:"controller",role:"worker",message:"do it"});
    assert.equal(r.status,0,r.stderr);
    const taskId=JSON.parse(r.stdout).taskId;
    r=f.call("result",["--task",taskId,"--status","COMPLETE","--summary","done","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    const cb=JSON.parse(r.stdout);
    assert.equal(cb.callback.kind,"callback"); assert.equal(cb.callback.sessionRef,"controller");
    const dup=f.call("result",["--task",taskId,"--status","COMPLETE","--summary","done","--result-version","1"]);
    assert.equal(dup.status,0,dup.stderr); assert.equal(JSON.parse(dup.stdout).callback.operationId,cb.callback.operationId);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("worker receipt may be machine JSON on stderr without becoming unknown", async()=>{
  const f=await fixture();
  try{
    let r=f.call("submit",[],{requestId:"s1",callerRef:"controller",role:"worker",message:"do it"});
    assert.equal(r.status,0,r.stderr);
    r=f.call("work-one",[],null,{CHAT_BRIDGE_TEST_STDERR_RECEIPT:"1"});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).status,"SENT");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("only a proven pre-send failure can be retried; attempted delivery stays unknown", async()=>{
  const f=await fixture();
  try{
    const parse=r=>{ assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); };
    const first=parse(f.call("submit",[],{requestId:"pre-1",callerRef:"controller",role:"worker-a",taskId:"PRE-1",message:"one"}));
    const failed=parse(f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND"}));
    assert.equal(failed.status,"FAILED_PRE_SEND");
    assert.equal(failed.reason,"PRE_SEND_SIMULATED");
    const secondRequest=f.call("submit",[],{requestId:"pre-2",callerRef:"controller",role:"worker-a",taskId:"PRE-1",message:"one"});
    assert.equal(secondRequest.status,2);
    assert.match(secondRequest.stderr,/TASK_ID_ALREADY_DISPATCHED/);
    assert.equal(parse(f.call("retry",["--operation",first.operationId])).status,"QUEUED");
    assert.equal(parse(f.call("work-one")).status,"SENT");

    const callback=parse(f.call("callback",[],{taskId:"PRE-1",targetRef:"controller",message:"done"}));
    assert.equal(parse(f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND"})).status,"FAILED_PRE_SEND");
    assert.equal(parse(f.call("retry",["--operation",callback.operationId])).status,"QUEUED");
    assert.equal(parse(f.call("work-one")).status,"SENT");

    const management=parse(f.call("control",["broadcast","--project","P","--kind","NOTICE","--message","check","--event","pre-send-event","--confirm"])).deliveries[0];
    assert.equal(parse(f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND"})).status,"FAILED_PRE_SEND");
    assert.equal(parse(f.call("retry",["--operation",management.operationId])).status,"QUEUED");
    assert.equal(parse(f.call("work-one")).status,"SENT");

    const second=parse(f.call("submit",[],{requestId:"attempt-1",callerRef:"controller",role:"worker-b",taskId:"ATTEMPT-1",message:"two"}));
    const attempted=parse(f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"SEND_ATTEMPTED"}));
    assert.equal(attempted.status,"DELIVERY_UNKNOWN");
    assert.equal(attempted.reason,"SEND_ATTEMPTED_SIMULATED");
    const retry=f.call("retry",["--operation",second.operationId]);
    assert.equal(retry.status,2);
    assert.match(retry.stderr,/RETRY_REQUIRES_PROVEN_PRE_SEND_FAILURE/);
    const duplicate=f.call("submit",[],{requestId:"attempt-2",callerRef:"controller",role:"worker-b",taskId:"ATTEMPT-1",message:"again"});
    assert.equal(duplicate.status,2);
    assert.match(duplicate.stderr,/TASK_DELIVERY_UNKNOWN_RECONCILE_REQUIRED/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("transient pre-send transport faults stay queued for a bounded safe retry", async()=>{
  const f=await fixture();
  try{
    const parse=r=>{ assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); };
    const first=parse(f.call("submit",[],{requestId:"pre-transient",callerRef:"controller",role:"worker",taskId:"PRE-TRANSIENT",message:"one"}));
    const deferred=parse(f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND",CHAT_BRIDGE_TEST_FAIL_CODE:"MODEL_MENU_NOT_READY"}));
    assert.equal(deferred.status,"QUEUED");
    assert.match(deferred.reason,/PRE_SEND_RETRY/);
    const status=parse(f.call("control",["status","--project","P"])).projects[0];
    assert.equal(status.operationSummary.pendingBusiness,1);
    assert.equal(status.completion.state,"IN_PROGRESS");
    const wake=spawnSync("python3",["-c","import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('update operations set not_before=0 where id=?',(sys.argv[2],));db.commit()",path.join(f.state,"bridge.sqlite3"),first.operationId],{encoding:"utf8"});
    assert.equal(wake.status,0,wake.stderr);
    assert.equal(parse(f.call("work-one")).status,"SENT");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("transient pre-send retry stops at the limit and becomes visible for review", async()=>{
  const f=await fixture();
  try{
    const parse=r=>{ assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); };
    const first=parse(f.call("submit",[],{requestId:"pre-limit",callerRef:"controller",role:"worker",taskId:"PRE-LIMIT",message:"one"}));
    // Pacing/capacity claims are not failed send attempts.
    const waits=spawnSync("python3",["-c","import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('update operations set attempts=20');db.commit()",path.join(f.state,"bridge.sqlite3")],{encoding:"utf8"});
    assert.equal(waits.status,0,waits.stderr);
    const fail=()=>f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND",CHAT_BRIDGE_TEST_FAIL_CODE:"MODEL_MENU_NOT_READY"});
    assert.equal(parse(fail()).status,"QUEUED");
    for(let attempt=0;attempt<1;attempt++){
      const wake=spawnSync("python3",["-c","import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('update operations set not_before=0 where id=?',(sys.argv[2],));db.commit()",path.join(f.state,"bridge.sqlite3"),first.operationId],{encoding:"utf8"});
      assert.equal(wake.status,0,wake.stderr);
      assert.equal(parse(fail()).status,"QUEUED");
    }
    const wake=spawnSync("python3",["-c","import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('update operations set not_before=0 where id=?',(sys.argv[2],));db.commit()",path.join(f.state,"bridge.sqlite3"),first.operationId],{encoding:"utf8"});
    assert.equal(wake.status,0,wake.stderr);
    assert.equal(parse(fail()).status,"FAILED_PRE_SEND");
    const status=parse(f.call("control",["status","--project","P"])).projects[0];
    assert.equal(status.operationSummary.failedPreSend,1);
    assert.equal(status.completion.state,"NO_KNOWN_WORK");
    assert.equal(parse(f.call("retry",["--operation",first.operationId])).status,"QUEUED");
    assert.equal(parse(fail()).status,"QUEUED");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("unknown dispatch, callback and management require exact bound Chat evidence and leave an audit", async()=>{
  const f=await fixture();
  try{
    const parse=r=>{ assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); };
    const dispatch=parse(f.call("submit",[],{requestId:"reconcile-d",callerRef:"controller",sessionRef:"controller",message:"synthetic dispatch",taskId:"reconcile-task"}));
    const callback=parse(f.call("result",["--task","reconcile-task","--summary","synthetic result","--status","COMPLETE"])).callback;
    const management=parse(f.call("control",["broadcast","--project","P","--kind","RELOAD","--message","synthetic reload","--event","reconcile-event","--confirm"])).deliveries[0];
    const operations=[dispatch,callback,management];
    for(const op of operations){
      const updated=spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN',reason='LOST_RECEIPT' WHERE id=?\",(sys.argv[2],)); d.commit()",path.join(f.state,"bridge.sqlite3"),op.operationId],{encoding:"utf8"});
      assert.equal(updated.status,0,updated.stderr);
    }
    parse(f.call("control",["pause","--project","P","--confirm"]));
    const blockedMigration=parse(f.call("migration-check",[],{account:"a"}));
    assert.equal(blockedMigration.safe,false);
    assert.equal(blockedMigration.unknownOperations.length,3);
    const accountId=createHash("sha256").update("identity:one").digest("hex");
    const evidence=(op,messageId,hash)=>JSON.stringify({ok:true,project:"P",account:"a",accountId,sessionRef:"controller",
      url:"https://chatgpt.com/g/g-p-"+"a".repeat(32)+"/c/controller",observedAt:"2026-09-26T12:00:00Z",
      matches:[{messageId,textHash:hash}]});
    const messageOf=id=>spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(d.execute('SELECT message FROM operations WHERE id=?',(sys.argv[2],)).fetchone()[0])",path.join(f.state,"bridge.sqlite3"),id],{encoding:"utf8"}).stdout.trim();
    for(const [index,op] of operations.entries()){
      const hash=createHash("sha256").update(messageOf(op.operationId).replace(/\s+/g," ").trim()).digest("hex");
      const env={CHAT_BRIDGE_TEST_EVIDENCE:evidence(op,"message-"+index,index===0?"0".repeat(64):hash)};
      let outcome=parse(f.call("reconcile",["--operation",op.operationId],null,env));
      if(index===0){
        assert.equal(outcome.outcome,"STILL_UNKNOWN");
        assert.equal(parse(f.call("status",[op.operationId])).status,"DELIVERY_UNKNOWN");
        env.CHAT_BRIDGE_TEST_EVIDENCE=evidence(op,"message-"+index,hash);
        outcome=parse(f.call("reconcile",["--operation",op.operationId],null,env));
      }
      assert.equal(outcome.outcome,"RECONCILED_DELIVERED");
      assert.equal(parse(f.call("status",[op.operationId])).status,"SENT");
      assert.equal(outcome.evidence.messageId,"message-"+index);
    }
    const audit=spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(d.execute('SELECT count(*) FROM reconciliation_attempts').fetchone()[0]); print(d.execute(\"SELECT status FROM management_deliveries WHERE event_id='reconcile-event'\").fetchone()[0]); print(d.execute(\"SELECT callback_status FROM task_results WHERE task_id='reconcile-task'\").fetchone()[0])",path.join(f.state,"bridge.sqlite3")],{encoding:"utf8"});
    assert.equal(audit.status,0,audit.stderr);
    assert.equal(audit.stdout.trim(),"4\nDELIVERED\nDELIVERED");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("queued notifications wait for a committed successor and then follow it", async()=>{
  for(const kind of ["management","callback"]) {
    const f=await fixture();
    try {
      const parse=r=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
      let op;
      if(kind==="management") op=parse(f.call("control",["broadcast","--project","P","--message","continue","--event","rotation-wake","--confirm"])).deliveries[0];
      else {
        const task=parse(f.call("submit",[],{requestId:"rotation-task",callerRef:"controller",role:"worker",message:"work"}));
        parse(f.call("cancel",[task.operationId]));
        op=parse(f.call("result",["--task",task.taskId,"--summary","done","--status","COMPLETE"])).callback;
      }
      const sql=script=>{
        const r=spawnSync("python3",["-c","import sqlite3,json,sys;db=sqlite3.connect(sys.argv[1]);"+script+";db.commit()",path.join(f.state,"bridge.sqlite3")],{encoding:"utf8"});
        assert.equal(r.status,0,r.stderr);
      };
      sql("reg=json.loads(db.execute(\"select payload from documents where kind='registry'\").fetchone()[0]);reg['chats']['controller']['status']='retired';reg['chats']['successor']={**reg['chats']['controller'],'id':'successor','status':'active'};db.execute(\"update documents set payload=? where kind='registry'\",(json.dumps(reg),))");
      assert.equal(parse(f.call("work-one")).status,"WAITING_ROUTE");
      assert.equal(parse(f.call("status",[op.operationId])).status,"WAITING_ROUTE");
      sql("db.execute(\"insert into session_successors values(?,?,?,?,?)\",('controller','project:P:role:conductor','successor',2,'2026-09-30T00:00:00Z'))");
      const sent=parse(f.call("work-one"));
      assert.equal(sent.status,"SENT");assert.equal(sent.sessionRef,"successor");
      assert.match(await readFile(f.log,"utf8"),/^send successor /m);
      if(kind==="management") assert.equal(parse(f.call("control",["ack","--event","rotation-wake","--caller-ref","successor","--status","ACKNOWLEDGED","--message","received"])).status,"ACKNOWLEDGED");
    } finally {await rm(f.root,{recursive:true,force:true});}
  }
});

test("retired management target is superseded only after a committed controller successor", async()=>{
  const f=await fixture();
  try {
    const parse=r=>{ assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout); };
    const management=parse(f.call("control",["broadcast","--project","P","--kind","RELOAD","--message","obsolete reload","--event","obsolete-event","--confirm"])).deliveries[0];
    const marked=spawnSync("python3",["-c",
      "import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); d.execute(\"UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_EXIT_1' WHERE id=?\",(sys.argv[2],)); d.commit()",
      path.join(f.state,"bridge.sqlite3"),management.operationId],{encoding:"utf8"});
    assert.equal(marked.status,0,marked.stderr);
    const successorScript=`
import json,sqlite3,sys
db=sqlite3.connect(sys.argv[1]); row=db.execute("select payload from documents where kind='registry'").fetchone()
reg=json.loads(row[0]); old=reg['chats']['controller']; old['status']='retired'; old['retiredAt']='2026-09-28T00:00:00Z'
reg['chats']['successor']={'id':'successor','project':'P','account':'a','role':'conductor','status':'active','model':'Latest','effort':'High'}
db.execute("update documents set payload=? where kind='registry'",(json.dumps(reg),))
db.execute("insert into session_successors(old_session_ref,logical_ref,successor_ref,epoch,committed_at) values(?,?,?,?,?)",('controller','project:P:role:conductor','successor',2,'2026-09-28T00:01:00Z'))
db.execute("insert into logical_sessions(logical_ref,project,role,current_session_ref,epoch,state,updated_at) values(?,?,?,?,?,?,?)",('project:P:role:conductor','P','conductor','successor',2,'ACTIVE','2026-09-28T00:01:00Z'))
db.commit()
`;
    const changed=spawnSync("python3",["-c",successorScript,path.join(f.state,"bridge.sqlite3")],{encoding:"utf8"});
    assert.equal(changed.status,0,changed.stderr);
    const outcome=parse(f.call("reconcile",["--operation",management.operationId]));
    assert.equal(outcome.outcome,"RECONCILED_SUPERSEDED");
    assert.equal(parse(f.call("status",[management.operationId])).status,"RECONCILED_SUPERSEDED");
    const status=parse(f.call("control",["status","--project","P"])).projects[0];
    assert.equal(status.operationSummary.unknown,0);
    assert.equal(status.operationSummary.reconciledSuperseded,1);
    assert.notEqual(status.completion.state,"NEEDS_REVIEW");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("persistent pause/drain blocks new business admission and resume reopens it", async()=>{
  const f=await fixture();
  try{
    let r=f.call("control",["pause","--project","P","--reason","upgrade","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).mode,"PAUSED");
    r=f.call("submit",[],{requestId:"p1",callerRef:"controller",role:"worker",message:"blocked"});
    assert.equal(r.status,2); assert.match(r.stderr,/ADMISSION_PAUSED/);
    r=f.call("control",["resume","--project","P","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).mode,"RUNNING");
    r=f.call("submit",[],{requestId:"p2",callerRef:"controller",role:"worker",message:"allowed"});
    assert.equal(r.status,0,r.stderr);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("workgroup scope is exact and group pause blocks queued sends", async()=>{
  const f=await fixture();
  try{
    const getRegistry=()=>JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"}).stdout);
    const putRegistry=(next)=>{
      const base=getRegistry();
      const put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{input:JSON.stringify({base,next}),encoding:"utf8"});
      assert.equal(put.status,0,put.stderr);
    };
    const reg=getRegistry();
    reg.chats.owner={id:"owner",project:"P",account:"a",role:"group-owner",status:"active",model:"Latest",effort:"High",workgroupId:"A"};
    putRegistry(reg);
    let r=f.call("configure",[],{type:"workgroup",project:"P",workgroupId:"A",name:"Group A",controllerSessionRef:"owner",charterIssue:"#31"});
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).workgroup.revision,1);
    r=f.call("configure",[],{type:"workgroup",project:"P",workgroupId:"A",name:"Group A",controllerSessionRef:"owner",charterIssue:"#31",expectedRevision:1});
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).changed,false);
    r=f.call("submit",[],{requestId:"wg-1",callerRef:"owner",role:"worker",workgroup:"A",message:"group work"});
    assert.equal(r.status,0,r.stderr); const op=JSON.parse(r.stdout); assert.equal(op.workgroupId,"A");
    r=f.call("control",["pause","--project","P","--workgroup","A","--caller-ref","owner","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).scope,"workgroup:P:A");
    r=f.call("work-one"); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"QUEUED");
    r=f.call("control",["resume","--project","P","--workgroup","A","--caller-ref","controller","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    spawnSync("python3",["-c","import sqlite3,sys,time; d=sqlite3.connect(sys.argv[1]); d.execute('update operations set not_before=? where id=?',(time.time(),sys.argv[2])); d.commit()",path.join(f.state,"bridge.sqlite3"),op.operationId]);
    r=f.call("work-one"); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("management broadcast previews, delivers through background send, and records ACK", async()=>{
  const f=await fixture();
  try{
    let r=f.call("control",["broadcast","--project","P","--kind","RELOAD","--message","read skills"]);
    assert.equal(r.status,0,r.stderr);
    const dry=JSON.parse(r.stdout); assert.equal(dry.dryRun,true); assert.equal(dry.targets.length,1);
    r=f.call("control",["broadcast","--project","P","--kind","RELOAD","--message","read skills","--event","evt-1","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).deliveries.length,1);
    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");
    const log=await readFile(f.log,"utf8");
    assert.match(log,/send controller/); assert.match(log,/--background/);
    r=f.call("control",["ack","--event","evt-1","--caller-ref","controller","--status","ACKNOWLEDGED","--message","ok"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"ACKNOWLEDGED");
    r=f.call("control",["status","--project","P"]);
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).managementEvents[0].acknowledged,1);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("cancelled management delivery is not reported as pending", async()=>{
  const f=await fixture();
  try{
    let r=f.call("control",["broadcast","--project","P","--kind","RELOAD","--message","stale","--event","stale-event","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    const operation=JSON.parse(r.stdout).deliveries[0];
    r=f.call("cancel",[operation.operationId]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("control",["status","--project","P"]);
    assert.equal(r.status,0,r.stderr);
    const project=JSON.parse(r.stdout).projects[0];
    assert.equal(project.management.pending,0);
    assert.equal(project.attention.pendingManagement,0);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});


test("two-phase controller rotation commits successor and late result follows it", async()=>{
  const f=await fixture();
  try{
    // Seed one in-flight task whose owning controller is the old controller.
    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    assert.equal(get.status,0,get.stderr);
    const base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks ||= {};
    next.tasks["late-task"]={taskId:"late-task",project:"P",account:"a",role:"worker",sessionId:"worker-old",
      status:"RUNNING",controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    let r=f.call("control",["rotation-prepare","--project","P","--role","conductor","--handoff","continue P","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    const rotation=JSON.parse(r.stdout); assert.equal(rotation.state,"ROTATING");
    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");

    // Real chat-bridge new would register the new conversation; emulate only that side effect.
    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"});
    assert.equal(get.status,0,get.stderr);
    const rbase=JSON.parse(get.stdout), rnext=structuredClone(rbase);
    rnext.chats["new-worker"]={id:"new-worker",project:"P",account:"a",role:"conductor-next",status:"active",
      model:"Latest",effort:"High",url:"https://chatgpt.com/c/new-worker"};
    put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{
      input:JSON.stringify({base:rbase,next:rnext}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    r=f.call("control",["rotation-ack","--rotation",rotation.rotationId,"--message","skills and host verified"]);
    assert.equal(r.status,0,r.stderr);
    const committed=JSON.parse(r.stdout);
    assert.equal(committed.currentSessionRef,"new-worker"); assert.equal(committed.state,"ACTIVE");

    r=f.call("result",["--task","late-task","--status","COMPLETE","--summary","late result","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    const reported=JSON.parse(r.stdout);
    assert.equal(reported.callback.sessionRef,"new-worker");

    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"});
    const saved=JSON.parse(get.stdout);
    assert.equal(saved.chats.controller.status,"retired");
    assert.equal(saved.chats.controller.successorSessionRef,"new-worker");
    assert.equal(saved.chats["new-worker"].role,"conductor");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("result is recorded before callback delivery and controller ACK completes business task", async()=>{
  const f=await fixture();
  try{
    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    const base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks={t1:{taskId:"t1",project:"P",account:"a",role:"worker",sessionId:"w1",status:"RUNNING",
      controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()}};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    let r=f.call("result",["--task","t1","--status","COMPLETE","--summary","done","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    let rt=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"}).stdout);
    assert.equal(rt.tasks.t1.status,"RESULT_RECORDED");
    r=f.call("work-one"); assert.equal(r.status,0,r.stderr);
    r=f.call("ack",["--task","t1","--result-version","1","--caller-ref","controller","--status","ACCEPTED","--message","reviewed"]);
    assert.equal(r.status,0,r.stderr);
    rt=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"}).stdout);
    assert.equal(rt.tasks.t1.status,"COMPLETE"); assert.equal(rt.tasks.t1.controllerAckStatus,"ACCEPTED");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("valid result waits for a missing owner and resumes the original callback after restoration", async()=>{
  const f=await fixture();
  try{
    const getRegistry=()=>JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"}).stdout);
    const putRegistry=(next)=>{
      const base=getRegistry();
      const put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{
        input:JSON.stringify({base,next}),encoding:"utf8"});
      assert.equal(put.status,0,put.stderr);
    };
    const getRuntime=()=>JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"}).stdout);
    const base=getRuntime(), next=structuredClone(base);
    next.tasks={missingOwner:{taskId:"missingOwner",project:"P",account:"a",role:"worker",sessionId:"w1",status:"RUNNING",
      controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()}};
    const put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    const hidden=getRegistry(); hidden.chats.controller.status="retired"; putRegistry(hidden);
    let r=f.call("result",["--task","missingOwner","--status","COMPLETE","--summary","saved","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    let saved=JSON.parse(r.stdout);
    assert.equal(saved.callback,null); assert.equal(saved.callbackStatus,"WAITING_ROUTE");
    const status=JSON.parse(f.call("control",["status","--project","P"]).stdout).projects[0];
    assert.equal(status.results.callbackWaitingRoute,1); assert.equal(status.completion.state,"AWAITING_ACK");
    let db=spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(d.execute('select owner_ref,callback_status from task_results where task_id=?',(sys.argv[2],)).fetchone())",path.join(f.state,"bridge.sqlite3"),"missingOwner"],{encoding:"utf8"});
    assert.equal(db.status,0,db.stderr); assert.match(db.stdout,/controller.*WAITING_ROUTE/);

    const restored=getRegistry(); restored.chats.controller.status="active"; putRegistry(restored);
    r=f.call("work-one"); assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");
    db=spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(d.execute('select callback_status from task_results where task_id=?',(sys.argv[2],)).fetchone()[0])",path.join(f.state,"bridge.sqlite3"),"missingOwner"],{encoding:"utf8"});
    assert.equal(db.stdout.trim(),"DELIVERED");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("workgroup scope propagates through result, callback outbox and status readback", async()=>{
  const f=await fixture();
  try{
    const get=()=>JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"}).stdout);
    const put=next=>{const r=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{input:JSON.stringify({base:get(),next}),encoding:"utf8"}); assert.equal(r.status,0,r.stderr);};
    const reg=get(); reg.chats.owner={id:"owner",project:"P",account:"a",role:"group-owner",status:"active",workgroupId:"A"}; put(reg);
    let r=f.call("control",["workgroup","--project","P","--workgroup-id","A","--name","Group A","--controller-session-ref","owner","--charter-issue","#31","--dry-run","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).dryRun,true); assert.equal(get().projects.P.workgroups.A,undefined);
    r=f.call("control",["workgroup","--project","P","--workgroup-id","A","--name","Group A","--controller-session-ref","owner","--charter-issue","#31","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).readback.workgroup.revision,1);
    const rt=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"}).stdout);
    rt.tasks={wg:{taskId:"wg",project:"P",account:"a",role:"worker",sessionId:"worker",workgroupId:"A",status:"RUNNING",controllerSessionRef:"owner",replyToSessionRef:"owner",updatedAt:new Date().toISOString()}};
    const runtimeBase=JSON.parse(spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"}).stdout);
    let putRuntime=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{input:JSON.stringify({base:runtimeBase,next:rt}),encoding:"utf8"}); assert.equal(putRuntime.status,0,putRuntime.stderr);
    r=f.call("result",["--task","wg","--status","COMPLETE","--summary","group done","--result-version","1"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).workgroupId,"A");
    const row=spawnSync("python3",["-c","import sqlite3,sys; d=sqlite3.connect(sys.argv[1]); print(d.execute('select workgroup_id from task_results where task_id=\\\"wg\\\"').fetchone()[0]); print(d.execute('select workgroup_id from operations where task_id=\\\"wg\\\" and kind=\\\"callback\\\"').fetchone()[0])",path.join(f.state,"bridge.sqlite3")],{encoding:"utf8"});
    assert.equal(row.status,0,row.stderr); assert.deepEqual(row.stdout.trim().split("\n"),["A","A"]);
    r=f.call("control",["status","--project","P","--workgroup","A"]); assert.equal(r.status,0,r.stderr);
    const status=JSON.parse(r.stdout).projects[0].workgroups[0]; assert.equal(status.ownerSessionRef,"owner"); assert.equal(status.results.recorded,1);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("older result ACK cannot advance a newer result and duplicate ACK is idempotent", async()=>{
  const f=await fixture();
  try{
    const get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    const base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks={versioned:{taskId:"versioned",project:"P",account:"a",role:"worker",sessionId:"w1",status:"RUNNING",
      controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()}};
    const put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);
    for(const version of ["1","2"]){
      const r=f.call("result",["--task","versioned","--status","COMPLETE","--summary","v"+version,"--result-version",version]);
      assert.equal(r.status,0,r.stderr);
    }
    let r=f.call("ack",["--task","versioned","--result-version","1","--caller-ref","controller","--status","ACCEPTED","--message","old"]);
    assert.equal(r.status,2); assert.match(r.stderr,/STALE_RESULT_ACK/);
    r=f.call("ack",["--task","versioned","--result-version","2","--caller-ref","controller","--status","ACCEPTED","--message","new"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"ACCEPTED");
    r=f.call("ack",["--task","versioned","--result-version","2","--caller-ref","controller","--status","ACCEPTED","--message","new"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).idempotent,true);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});


test("web control mutations require project-root/admin authority; host can bootstrap admin", async()=>{
  const f=await fixture();
  try{
    const { createHash }=await import("node:crypto");
    const origin=createHash("sha256").update("identity:one").digest("hex");
    let r=f.call("control",["pause","--project","P","--confirm"],null,{CHAT_BRIDGE_FROM_ACCOUNT_ID:origin});
    assert.equal(r.status,2); assert.match(r.stderr,/CONTROL_CALLER_REF_REQUIRED/);

    r=f.call("control",["pause","--project","P","--caller-ref","controller","--confirm"],null,{CHAT_BRIDGE_FROM_ACCOUNT_ID:origin});
    assert.equal(r.status,0,r.stderr);
    f.call("control",["resume","--project","P","--confirm"]);

    r=f.call("control",["pause","--all","--caller-ref","controller","--confirm"],null,{CHAT_BRIDGE_FROM_ACCOUNT_ID:origin});
    assert.equal(r.status,2); assert.match(r.stderr,/CONTROL_ADMIN_REQUIRED/);

    r=f.call("control",["admin-add","--target-ref","controller","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("control",["pause","--all","--caller-ref","controller","--confirm"],null,{CHAT_BRIDGE_FROM_ACCOUNT_ID:origin});
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).scope,"global");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("stop running is an explicit persisted control request", async()=>{
  const f=await fixture();
  try{
    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    const base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks={tstop:{taskId:"tstop",project:"P",account:"a",role:"worker",sessionId:"controller",status:"RUNNING",updatedAt:new Date().toISOString()}};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    let r=f.call("control",["stop","--project","P","--task","tstop","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).stopRequests.length,1);
    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,"SENT");
    const log=await readFile(f.log,"utf8");
    assert.match(log,/stop controller/); assert.match(log,/--background/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});


test("checkpoint is idempotent and rotation can use latest checkpoint when old Chat cannot summarize", async()=>{
  const f=await fixture();
  try{
    let r=f.call("checkpoint",["--project","P","--role","conductor","--session-ref","controller",
      "--version","cp1","--summary","milestone done","--github","https://github.test/issue/1",
      "--decisions","keep invariant","--next","finish review"]);
    assert.equal(r.status,0,r.stderr);
    const first=JSON.parse(r.stdout);
    const duplicate=f.call("checkpoint",["--project","P","--role","conductor","--session-ref","controller",
      "--version","cp1","--summary","milestone done","--github","https://github.test/issue/1",
      "--decisions","keep invariant","--next","finish review"]);
    assert.equal(duplicate.status,0,duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).id||JSON.parse(duplicate.stdout).checkpointId,first.checkpointId);

    r=f.call("control",["rotation-prepare","--project","P","--role","conductor","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    const rotation=JSON.parse(r.stdout);
    assert.equal(rotation.state,"ROTATING");
    const log=await readFile(f.log,"utf8").catch(()=> "");
    assert.equal(log,"");
  } finally { await rm(f.root,{recursive:true,force:true}); }
});


test("Project requirements block placement until the bound location is attested", async()=>{
  const f=await fixture();
  try{
    let r=f.call("control",["requirements","--project","P","--context-version","ctx-v1",
      "--tools","ChatGPT Computer,git","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("submit",[],{requestId:"ready-1",callerRef:"controller",role:"worker",message:"should wait"});
    assert.equal(r.status,2); assert.match(r.stderr,/NO_ELIGIBLE_ACCOUNT_BINDING/);

    r=f.call("control",["attest-location","--project","P","--account","a","--context-version","ctx-v1",
      "--tools","ChatGPT Computer,git","--confirm"]);
    assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).executionReady,true);
    r=f.call("submit",[],{requestId:"ready-2",callerRef:"controller",role:"worker",message:"ready"});
    assert.equal(r.status,0,r.stderr);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});


test("context-exhausted worker rotation resumes the same task id only after successor ACK", async()=>{
  const f=await fixture();
  try{
    // Register a worker conversation and an active task blocked by hard context exhaustion.
    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"});
    let base=JSON.parse(get.stdout), next=structuredClone(base);
    next.chats.worker1={id:"worker1",project:"P",account:"a",role:"worker",status:"active",
      model:"Latest",effort:"High",url:"https://chatgpt.com/c/worker1"};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    base=JSON.parse(get.stdout); next=structuredClone(base);
    next.tasks.tctx={taskId:"tctx",project:"P",account:"a",role:"worker",sessionId:"worker1",
      status:"BLOCKED",blockedReason:"CONTEXT_EXHAUSTED",controllerSessionRef:"controller",replyToSessionRef:"controller",
      originalMessage:"continue durable work",requestedModel:"Latest",requestedEffort:"High",updatedAt:new Date().toISOString()};
    put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    let r=f.call("checkpoint",["--task","tctx","--version","ctx-cp1","--summary","half done",
      "--github","https://github.test/issue/2","--next","finish remaining"]);
    assert.equal(r.status,0,r.stderr);

    r=f.call("control",["rotation-prepare","--project","P","--role","worker","--confirm"]);
    assert.equal(r.status,0,r.stderr);
    const rotation=JSON.parse(r.stdout);
    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).status,"SENT");

    // Emulate the real new Chat registration caused by the rotation new operation.
    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"});
    base=JSON.parse(get.stdout); next=structuredClone(base);
    next.chats["new-worker"]={id:"new-worker",project:"P",account:"a",role:"worker-next",status:"active",
      model:"Latest",effort:"High",url:"https://chatgpt.com/c/new-worker"};
    put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    r=f.call("control",["rotation-ack","--rotation",rotation.rotationId,"--message","verified"]);
    assert.equal(r.status,0,r.stderr);
    const ack=JSON.parse(r.stdout);
    assert.deepEqual(ack.resumedTasks,["tctx"]);
    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    const rt=JSON.parse(get.stdout);
    assert.equal(rt.tasks.tctx.taskId,"tctx");
    assert.equal(rt.tasks.tctx.sessionId,"new-worker");
    assert.equal(rt.tasks.tctx.status,"DISPATCHED");
    assert.equal(rt.tasks.tctx.rotationResumePending,true);

    r=f.call("work-one");
    assert.equal(r.status,0,r.stderr);
    const log=await readFile(f.log,"utf8");
    assert.match(log,/send new-worker/);
    assert.match(log,/ROTATION RESUME/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("retired predecessor cannot ACK results after controller successor commits", async()=>{
  const f=await fixture();
  try{
    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    let base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks.tlate={taskId:"tlate",project:"P",account:"a",role:"worker",sessionId:"w",
      status:"RUNNING",controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);

    let r=f.call("control",["rotation-prepare","--project","P","--role","conductor","--handoff","handoff","--confirm"]);
    const rotation=JSON.parse(r.stdout);
    r=f.call("work-one"); assert.equal(r.status,0,r.stderr);
    get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"registry"],{encoding:"utf8"});
    base=JSON.parse(get.stdout); next=structuredClone(base);
    next.chats["new-worker"]={id:"new-worker",project:"P",account:"a",role:"conductor-next",status:"active",
      model:"Latest",effort:"High",url:"https://chatgpt.com/c/new-worker"};
    put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"registry"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);
    r=f.call("control",["rotation-ack","--rotation",rotation.rotationId,"--message","verified"]);
    assert.equal(r.status,0,r.stderr);

    r=f.call("result",["--task","tlate","--status","COMPLETE","--summary","late","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("ack",["--task","tlate","--result-version","1","--caller-ref","controller","--status","ACCEPTED","--message","old"]);
    assert.equal(r.status,2); assert.match(r.stderr,/RESULT_ACK_TARGET_MISMATCH/);
    r=f.call("ack",["--task","tlate","--result-version","1","--caller-ref","new-worker","--status","ACCEPTED","--message","new"]);
    assert.equal(r.status,0,r.stderr);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("control status distinguishes no work, in progress, awaiting ACK and complete", async()=>{
  const f=await fixture();
  try{
    let r=f.call("control",["status","--project","P"]);
    assert.equal(r.status,0,r.stderr);
    const initialStatus=JSON.parse(r.stdout).projects[0];
    assert.equal(initialStatus.completion.state,"NO_KNOWN_WORK");
    assert.equal(initialStatus.businessState,"REPLANNING");
    assert.equal(initialStatus.durableStateRef,"https://example.invalid/issues/1");
    assert.deepEqual(initialStatus.admission,{mode:"RUNNING",acceptingNewWork:true,reason:null});
    assert.deepEqual(initialStatus.attention,{blockedTasks:0,failedTasks:0,unknownOperations:0,pendingBusiness:0,
      pendingCallbacks:0,pendingManagement:0,awaitingControllerAck:0,awaitingDurable:0});
    assert.equal(initialStatus.execution.state,"IDLE");

    let get=spawnSync("python3",[path.resolve("src/state-store.py"),"get",f.config,f.state,"runtime"],{encoding:"utf8"});
    let base=JSON.parse(get.stdout), next=structuredClone(base);
    next.tasks.ts={taskId:"ts",project:"P",account:"a",role:"worker",sessionId:"w",
      status:"RUNNING",controllerSessionRef:"controller",replyToSessionRef:"controller",updatedAt:new Date().toISOString()};
    let put=spawnSync("python3",[path.resolve("src/state-store.py"),"put",f.config,f.state,"runtime"],{
      input:JSON.stringify({base,next}),encoding:"utf8"});
    assert.equal(put.status,0,put.stderr);
    r=f.call("control",["status","--project","P"]);
    const running=JSON.parse(r.stdout).projects[0];
    assert.equal(running.completion.state,"IN_PROGRESS");
    assert.equal(running.execution.state,"RUNNING_STALE");

    r=f.call("result",["--task","ts","--status","COMPLETE","--summary","done","--result-version","1"]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("control",["status","--project","P"]);
    const awaiting=JSON.parse(r.stdout).projects[0];
    assert.equal(awaiting.completion.state,"AWAITING_ACK");
    assert.equal(awaiting.execution.state,"QUEUED");
    assert.equal(awaiting.results.awaitingControllerAck,1);

    r=f.call("work-one",[],null,{CHAT_BRIDGE_TEST_FAIL_STAGE:"PRE_SEND"});
    assert.equal(r.status,0,r.stderr);
    assert.equal(JSON.parse(r.stdout).status,"FAILED_PRE_SEND");
    const undelivered=JSON.parse(f.call("control",["status","--project","P"]).stdout).projects[0];
    assert.equal(undelivered.results.awaitingControllerAck,1);
    assert.equal(undelivered.attention.awaitingControllerAck,1);
    r=f.call("ack",["--task","ts","--result-version","1","--caller-ref","controller","--status","ACCEPTED","--message","ok"]);
    assert.equal(r.status,0,r.stderr);
    r=f.call("control",["status","--project","P"]);
    const final=JSON.parse(r.stdout).projects[0];
    assert.equal(final.completion.state,"COMPLETE");
    assert.equal(final.completion.knownComplete,true);
    assert.equal(final.execution.state,"IDLE");
    assert.equal(final.execution.failedPreSend,0);
    assert.equal(final.execution.historicalFailedPreSend,1);
    assert.equal(final.operations.find(op=>op.status==="FAILED_PRE_SEND").count,1);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});

test("resumed control retains its persisted scope and epoch", async()=>{
  const f=await fixture();
  try {
    const parse=r=>{assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
    parse(f.call("control",["pause","--project","P","--reason","maintenance","--confirm"]));
    parse(f.call("control",["resume","--project","P","--reason","ready","--confirm"]));
    const control=parse(f.call("control",["status","--project","P"])).projects[0].control;
    assert.equal(control.mode,"RUNNING");
    assert.equal(control.epoch,2);
    assert.equal(control.scope,"project:P");
    assert.equal(control.reason,"ready");
    assert.ok(control.updatedAt);
    parse(f.call("control",["pause","--all","--reason","global hold","--confirm"]));
    assert.equal(parse(f.call("control",["status","--project","P"])).projects[0].control.scope,"global");
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test("current generation stays visible beside historical transport faults", async()=>{
  const r=spawnSync("python3",["-c",`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('coordinator',sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rt={'sessions':{'s':{'generating':True,'observedAt':m.stamp()}}}
task={'sessionId':'s','status':'RUNNING'}
def summary(mode):
    return m.execution_summary(rt,[task],mode,0,0,0,0,5,1,0,0,0,0)
print(json.dumps({'running':summary('RUNNING'),'paused':summary('PAUSED')}))
`,coordinator],{encoding:"utf8"});
  assert.equal(r.status,0,r.stderr);
  const value=JSON.parse(r.stdout);
  assert.equal(value.running.state,"GENERATING");
  assert.equal(value.running.failedPreSend,5);
  assert.equal(value.running.deliveryUnknown,1);
  assert.equal(value.paused.state,"PAUSED");
});

test("a task id cannot be dispatched twice, including when prior delivery is unknown", async()=>{
  const f=await fixture();
  try{
    let r=f.call("submit",[],{requestId:"u1",callerRef:"controller",role:"worker",taskId:"T-BLOCK",message:"one"});
    assert.equal(r.status,0,r.stderr);
    const first=JSON.parse(r.stdout);
    r=f.call("submit",[],{requestId:"u2",callerRef:"controller",role:"worker",taskId:"T-BLOCK",message:"duplicate"});
    assert.equal(r.status,2);
    assert.match(r.stderr,/TASK_ID_ALREADY_DISPATCHED/);
    const sql=spawnSync("python3",["-c",
      "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute(\"update operations set status='DELIVERY_UNKNOWN' where id=?\",(sys.argv[2],));db.commit()",
      path.join(f.state,"bridge.sqlite3"),first.operationId],{encoding:"utf8"});
    assert.equal(sql.status,0,sql.stderr);
    r=f.call("submit",[],{requestId:"u3",callerRef:"controller",role:"worker",taskId:"T-BLOCK",message:"retry"});
    assert.equal(r.status,2);
    assert.match(r.stderr,/TASK_DELIVERY_UNKNOWN_RECONCILE_REQUIRED/);
    const old=spawnSync("python3",["-c",
      "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute(\"update operations set status='SUPERSEDED' where id=?\",(sys.argv[2],));db.commit()",
      path.join(f.state,"bridge.sqlite3"),first.operationId],{encoding:"utf8"});
    assert.equal(old.status,0,old.stderr);
    r=f.call("control",["status","--project","P"]);
    assert.equal(JSON.parse(r.stdout).projects[0].completion.state,"NEEDS_REVIEW");
    r=f.call("submit",[],{requestId:"u4",callerRef:"controller",role:"worker",taskId:"T-BLOCK",message:"retry"});
    assert.equal(r.status,2);
    assert.match(r.stderr,/TASK_DELIVERY_UNKNOWN_RECONCILE_REQUIRED/);
  } finally { await rm(f.root,{recursive:true,force:true}); }
});
