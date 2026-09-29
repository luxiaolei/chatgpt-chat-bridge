import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('health separates fresh observations, stale RUNNING records, manual ownership and historical errors',()=>{
 const code=`import importlib.util,json,pathlib
from datetime import datetime,timezone
spec=importlib.util.spec_from_file_location('local_query',pathlib.Path('src/local-query.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rt={'tasks':{'A':{'taskId':'A','sessionId':'CA','status':'RUNNING'},'B':{'taskId':'B','sessionId':'CB','status':'RUNNING','watchdogPausedForUserControl':True},'C':{'taskId':'C','sessionId':'CC','status':'RUNNING'},'D':{'taskId':'D','status':'COMPLETE','lastWatchError':'CONVERSATION_REATTACH_FAILED: old'}},'sessions':{'CA':{'observedAt':'2026-09-29T12:00:00Z','generating':True},'CB':{'observedAt':'2026-09-29T12:00:00Z','generating':True},'CC':{'observedAt':'2026-09-29T10:00:00Z','generating':True}}}
print(json.dumps(m.health({},rt,datetime(2026,9,29,12,1,tzinfo=timezone.utc))))`;
 const r=spawnSync('python3',['-c',code],{encoding:'utf8',timeout:10000});
 assert.equal(r.status,0,r.stderr);const h=JSON.parse(r.stdout);
 assert.equal(h.liveBrowserInspected,false);assert.equal(h.trackedNonterminalTasks,3);
 assert.equal(h.recentlyObservedGenerating,1);assert.equal(h.userControlPaused,1);
 assert.equal(h.staleOrMissingObservations,1);assert.equal(h.historicalLastErrorFamilies.CONVERSATION_REATTACH_FAILED,1);
 assert.equal(h.taskStatusCounts.COMPLETE,1);
});

test('health command exits locally even when no browser binary is available',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-health-'));
 const config=path.join(root,'config'),state=path.join(root,'state');
 await mkdir(config);await mkdir(state);
 await writeFile(path.join(config,'registry.json'),JSON.stringify({projects:{},accounts:{},chats:{}}));
 await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},sessions:{}}));
 try {
  const r=spawnSync('zsh',['bin/chat-bridge','health'],{encoding:'utf8',timeout:15000,
    env:{...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:path.join(root,'does-not-exist')}});
  assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).schema,'chat-bridge.health.v1');
 } finally {await rm(root,{recursive:true,force:true});}
});
