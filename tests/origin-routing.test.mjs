import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=path.resolve(import.meta.dirname,'..');

test('an observed origin Space selects its login for a bound Project without --account',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'bridge-origin-'));
  try {
    const config=path.join(dir,'config'),state=path.join(dir,'state'),capture=path.join(dir,'script.txt'),fake=path.join(dir,'ego');
    await mkdir(config);await mkdir(state);
    const registry={defaultAccount:'a',defaultProject:'P',accounts:{a:{identity:'user-a'},b:{identity:'user-b'}},
      projects:{P:{activeAccount:'a',bindings:{a:{spaceName:'A',projectUrl:'https://chatgpt.com/g/g-p-a/project'},b:{spaceName:'B',projectUrl:'https://chatgpt.com/g/g-p-b/project'}}}},
      spaces:{B:{name:'B',account:'b',identity:'user-b'}},chats:{}};
    await writeFile(path.join(config,'registry.json'),JSON.stringify(registry));
    await writeFile(fake,'#!/bin/sh\ncat > "$CAPTURE"\n',{mode:0o755});
    const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake,CAPTURE:capture,CHAT_BRIDGE_FROM_SPACE:'B'};
    const run=(...args)=>spawnSync(path.join(root,'bin/chat-bridge'),args,{env,encoding:'utf8'});
    const same=run('event','list','--project','P');
    assert.equal(same.status,0,same.stderr);
    assert.equal(JSON.parse(same.stdout).account,'b');
    await assert.rejects(readFile(capture,'utf8'),{code:'ENOENT'});
    const explicit=run('event','list','--project','P','--account','a');
    assert.equal(explicit.status,0,explicit.stderr);
    assert.equal(JSON.parse(explicit.stdout).account,'a');
    await assert.rejects(readFile(capture,'utf8'),{code:'ENOENT'});
    const help=spawnSync(path.join(root,'bin/chat-bridge'),['help'],
      {env:{...env,CHAT_BRIDGE_FROM_SPACE:'unrelated'},encoding:'utf8'});
    assert.equal(help.status,0,help.stderr);
    const unknownOrigin=spawnSync(path.join(root,'bin/chat-bridge'),['send','worker','hello','--project','P'],
      {env:{...env,CHAT_BRIDGE_FROM_SPACE:''},encoding:'utf8'});
    assert.equal(unknownOrigin.status,2);
    assert.match(unknownOrigin.stderr,/AMBIGUOUS_PROJECT_ACCOUNT/);
    const store=path.join(root,'src/state-store.py');
    const current=spawnSync('python3',[store,'get',config,state,'registry'],{encoding:'utf8'});
    assert.equal(current.status,0,current.stderr);
    const base=JSON.parse(current.stdout), next=structuredClone(base);
    delete next.projects.P.bindings.b;
    const updated=spawnSync('python3',[store,'put',config,state,'registry'],{
      input:JSON.stringify({base,next}),encoding:'utf8'
    });
    assert.equal(updated.status,0,updated.stderr);
    const missing=run('event','list','--project','P');
    assert.equal(missing.status,2);
    assert.match(missing.stderr,/PROJECT_NOT_BOUND_FOR_ORIGIN_ACCOUNT/);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('an unqualified watch enters the browser separately for each eligible account',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'bridge-watch-scope-'));
  try {
    const config=path.join(dir,'config'),state=path.join(dir,'state'),capture=path.join(dir,'calls.txt'),fake=path.join(dir,'ego');
    await mkdir(config);await mkdir(state);
    await writeFile(path.join(config,'registry.json'),JSON.stringify({defaultAccount:'a',accounts:{a:{identity:'user-a'},b:{identity:'user-b'},alias:{identity:'user-a'}},
      projects:{P:{activeAccount:'a'},Q:{activeAccount:'b'}},chats:{}}));
    await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{one:{project:'P',account:'a',status:'RUNNING'},two:{project:'Q',account:'b',status:'RUNNING'},three:{project:'P',account:'alias',status:'RUNNING'}}}));
    await writeFile(fake,'#!/bin/sh\nhead -n 1 >> "$CAPTURE"\ncat >/dev/null\n',{mode:0o755});
    const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake,CAPTURE:capture};
    const result=spawnSync(path.join(root,'bin/chat-bridge'),['watch','--quiet'],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const calls=(await readFile(capture,'utf8')).trim().split('\n').map(row=>JSON.parse(row.slice(row.indexOf('=')+1).trim().replace(/;$/,'')));
    assert.deepEqual(calls.map(args=>args[args.indexOf('--account')+1]),['a','b','alias']);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('stable login origin survives Space rename and rejects unknown identities',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'bridge-account-origin-'));
  try {
    const config=path.join(dir,'config'),state=path.join(dir,'state'),capture=path.join(dir,'script.txt'),fake=path.join(dir,'ego');
    await mkdir(config);await mkdir(state);
    await writeFile(path.join(config,'registry.json'),JSON.stringify({defaultAccount:'a',defaultProject:'P',
      accounts:{a:{identity:'user-a'},b:{identity:'user-b'}},
      projects:{P:{activeAccount:'a',bindings:{a:{spaceName:'old A',projectUrl:'https://chatgpt.com/g/g-p-a/project'},b:{spaceName:'renamed B',projectUrl:'https://chatgpt.com/g/g-p-b/project'}}}},chats:{},spaces:{}}));
    await writeFile(fake,'#!/bin/sh\ncat > "$CAPTURE"\n',{mode:0o755});
    const accountId=createHash('sha256').update('identity:user-b').digest('hex');
    const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake,CAPTURE:capture,CHAT_BRIDGE_FROM_ACCOUNT_ID:accountId};
    const result=spawnSync(path.join(root,'bin/chat-bridge'),['event','list','--project','P'],{env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).account,'b');
    await assert.rejects(readFile(capture,'utf8'),{code:'ENOENT'});
    const bad=spawnSync(path.join(root,'bin/chat-bridge'),['event','list','--project','P'],{env:{...env,CHAT_BRIDGE_FROM_ACCOUNT_ID:'user-x'},encoding:'utf8'});
    assert.equal(bad.status,2);
    assert.match(bad.stderr,/ORIGIN_ACCOUNT_NOT_VERIFIED/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
