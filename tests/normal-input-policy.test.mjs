import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import '../src/task-policy.js';

test('draft backup is complete, durable and private before any mutation',async()=>{
  const source=await fs.readFile('src/main.js','utf8'),root=await fs.mkdtemp(path.join(tmpdir(),'bridge-draft-'));
  const code=source.slice(source.indexOf('async function saveDraftBackup'),source.indexOf('\nasync function assertInputSafe'));
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const save=await new AsyncFunction('fs','pathMod','crypto','STATE_DIR',code+';return saveDraftBackup;')(fs,path,crypto,root);
  try {
    const original={rawText:' first\nsecond ',text:'first\nsecond',document:{type:'doc',content:[{type:'paragraph'},{type:'paragraph'}]},composerHtml:'<div>first<p>second</p></div>',formHtml:'<form>complete</form>'};
    const receipt=await save(original),bytes=await fs.readFile(receipt.path),backup=JSON.parse(bytes);
    assert.equal((await fs.stat(receipt.path)).mode&0o777,0o600);assert.equal((await fs.stat(path.dirname(receipt.path))).mode&0o777,0o700);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),receipt.sha256);
    for(const [key,value] of Object.entries(original))assert.deepEqual(backup[key],value);
    await fs.chmod(path.dirname(receipt.path),0o755);await assert.rejects(()=>save(original),/DIRECTORY_UNSAFE/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('discard policy is exact Project/login opt-in and never inherited by another Project',()=>{
  const home='https://chatgpt.com/g/g-p-'+'a'.repeat(32)+'/project',url=home.replace('project','c/11111111-1111-4111-8111-111111111111');
  const reg={accounts:{a:{identity:'login'}},projects:{
    P:{bindings:{a:{projectUrl:home}},lifecycle:{draftPolicy:'discard'}},
    other:{bindings:{a:{projectUrl:home.replace('a'.repeat(32),'b'.repeat(32))}}}
  }};
  const policy=globalThis.__CHAT_BRIDGE_TASK_POLICY__.draftDiscardProject;
  assert.equal(policy(reg,'login',url),'P');assert.equal(policy(reg,'wrong',url),null);assert.equal(policy(reg,'login',url.replace('chatgpt.com','foreign.test')),null);
  assert.equal(policy(reg,'login',url.replace('a'.repeat(32),'b'.repeat(32))),null);
  reg.projects.duplicate=structuredClone(reg.projects.P);assert.equal(policy(reg,'login',url),null);
});

test('public policy persists explicit management opt-in without waking Ego',async()=>{
  const root=await fs.mkdtemp(path.join(tmpdir(),'bridge-policy-')),config=path.join(root,'config'),state=path.join(root,'state'),marker=path.join(root,'ego-woke');
  await fs.mkdir(config);await fs.mkdir(state);
  await fs.writeFile(path.join(root,'ego-browser'),'#!/bin/sh\ntouch "'+marker+'"\nexit 99\n',{mode:0o755});
  await fs.writeFile(path.join(config,'registry.json'),JSON.stringify({accounts:{a:{identity:'login'}},projects:{P:{bindings:{}},other:{bindings:{}}},chats:{worker:{id:'worker',project:'P',account:'a',role:'worker',status:'active'}}}));
  await fs.writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},projects:{},sessions:{}}));
  const env={...process.env,PATH:root+path.delimiter+process.env.PATH,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,
    CHAT_BRIDGE_MAIN:path.resolve('src/main.js'),CHAT_BRIDGE_FROM_ACCOUNT_ID:'',CHAT_BRIDGE_FROM_SPACE:''};
  const call=(args,extra={})=>spawnSync('zsh',[path.resolve('bin/chat-bridge'),'policy',...args],{env:{...env,...extra},encoding:'utf8',timeout:15000});
  const show=project=>{const r=call(['show','--project',project]);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  try {
    const before=show('P');assert.equal(before.rootController,'conductor');assert.equal(before.lifecycle.draftPolicy,'preserve');assert.equal(before.lifecycle.maxOverflowSpaces,1);
    const args=['set','--project','P','--draft-policy','discard','--max-overflow-spaces','2'];
    let r=call(args);assert.equal(r.status,2);assert.match(r.stderr,/requires --confirm/);assert.deepEqual(show('P'),before);
    r=call([...args,'--confirm']);assert.equal(r.status,0,r.stderr);assert.equal(show('P').lifecycle.draftPolicy,'discard');assert.equal(show('P').lifecycle.maxOverflowSpaces,2);
    assert.equal(show('other').lifecycle.draftPolicy,'preserve');assert.equal(show('other').lifecycle.maxOverflowSpaces,1);
    r=call(['set','--project','P','--auto-reconcile','true','--min-gap-sec','0','--instruction',' keep ']);assert.equal(r.status,0,r.stderr);
    assert.equal(show('P').lifecycle.autoReconcile,true);assert.equal(show('P').lifecycle.minGapSec,0);assert.equal(show('P').lifecycle.instruction,'keep');
    const saved=show('P');
    for(const [options,extra] of [
      [['set','--project','P','--max-overflow-spaces','3','--confirm'],{}],
      [['set','--project','P','--draft-policy','discard','--confirm','--caller-ref','worker'],{CHAT_BRIDGE_FROM_ACCOUNT_ID:crypto.createHash('sha256').update('identity:login').digest('hex')}],
      [['set','--project','P','--draft-policy','discard','--confirm'],{CHAT_BRIDGE_FROM_SPACE:'unverified'}]
    ]) {r=call(options,extra);assert.equal(r.status,2);assert.deepEqual(show('P'),saved);}
    await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('authoritative discard admission preserves UNKNOWN, pause and partial-input fences',()=>{
  const code=String.raw`import importlib.util,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location("c","src/coordinator.py");c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
with tempfile.TemporaryDirectory() as root:
 p=pathlib.Path(root);config=p/"config";state=p/"state";config.mkdir();state.mkdir()
 home="https://chatgpt.com/g/g-p-"+"a"*32+"/project";sid="11111111-1111-4111-8111-111111111111";url=home.replace("project","c/"+sid)
 reg={"accounts":{"a":{"identity":"login"}},"projects":{"P":{"bindings":{"a":{"projectUrl":home}},"lifecycle":{"draftPolicy":"discard"}}},"chats":{}}
 (config/"registry.json").write_text(json.dumps(reg));(state/"runtime.json").write_text(json.dumps({"tasks":{},"projects":{},"sessions":{}}))
 db=c.connection(config,state);payload={"project":"P","identity":"login","targetUrl":url,"attempt":None}
 assert c.draft_discard_admission(db,payload)["ok"]
 def rejected():
  try:c.draft_discard_admission(db,payload)
  except ValueError:return
  raise AssertionError("unsafe draft admitted")
 for status in ["DELIVERY_UNKNOWN","DISPATCHING","SUPERSEDED","FAILED_PRE_SEND","QUEUED"]:
  db.execute("INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before) VALUES('op','op','hash',?,'P','a',?,'owner',?,'worker','body','task',?,?,0)",(status,c.account_id("login"),sid,c.stamp(),c.stamp()));db.commit()
  if status in {"FAILED_PRE_SEND","QUEUED"}:
   for phase in ["17-DRAFT_DISCARD_INTENT.json","20-BEFORE_INPUT.json","40-SEND_INTENT.json"]:
    target=state/"delivery-attempts"/"op"/"1"/phase;target.parent.mkdir(parents=True,exist_ok=True);target.write_text("{}");rejected();target.unlink()
  else:rejected()
  db.execute("DELETE FROM operations");db.commit()
 for mode in ["PAUSED","DRAINING"]:
  db.execute("INSERT OR REPLACE INTO control_state(scope,mode,epoch,updated_at) VALUES('project:P',?,1,?)",(mode,c.stamp()));db.commit();rejected()
 db.execute("DELETE FROM control_state WHERE scope='project:P'");db.commit()
 for paused in [{"projects":{"P":{"watchdogPausedForUserControl":True}}},{"sessions":{sid:{"watchdogPausedForUserControl":True}}},{"tasks":{"t":{"sessionId":sid,"watchdogPausedForUserControl":True}}}]:
  db.execute("UPDATE documents SET payload=? WHERE kind='runtime'",(json.dumps(paused),));db.commit();rejected()
 db.execute("UPDATE documents SET payload=? WHERE kind='runtime'",(json.dumps({"tasks":{},"projects":{},"sessions":{}}),));db.commit()
 from types import SimpleNamespace
 original=c.delivery_attempt_module
 claim={"id":"current","kind":"send","project":"P","account_id":c.account_id("login"),"session_ref":None,"native_target":None,"workgroup_id":None}
 c.delivery_attempt_module=lambda:SimpleNamespace(verify_current=lambda *args:claim)
 payload["attempt"]={"synthetic":True};rejected();payload["reclaim"]=True;assert c.draft_discard_admission(db,payload)["ok"]
 c.delivery_attempt_module=original;payload["attempt"]=None;payload.pop("reclaim")
 reg["projects"]["P"]["lifecycle"]["draftPolicy"]="preserve";db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(reg),));db.commit();rejected()
 print("PASS")`;
  const result=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:15000});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'PASS');
});
