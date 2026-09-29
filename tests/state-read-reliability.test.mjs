import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const store=path.resolve('src/state-store.py');
const local=path.resolve('src/local-query.py');
const web=path.resolve('src/web-preflight.py');
const capacity=path.resolve('src/capacity-preflight.py');
const call=(script,...args)=>spawnSync('python3',[script,...args],{encoding:'utf8',timeout:15000});
async function fixture(fn) {
 const root=await mkdtemp(path.join(tmpdir(),'bridge-read-reliability-'));
 const config=path.join(root,'config'),state=path.join(root,'state');
 await mkdir(config);await mkdir(state);
 const projectId='g-p-0123456789abcdef0123456789abcdef';
 const reg={defaultAccount:'a',defaultProject:'P',accounts:{a:{identity:'one'}},projects:{P:{activeAccount:'a',bindings:{a:{spaceName:'managed',projectId,projectUrl:'https://chatgpt.com/g/'+projectId+'/project'}}}},chats:{C:{id:'C',role:'worker',project:'P',account:'a',status:'active'}},spaces:{managed:{identity:'one',projects:[{id:projectId}]}}};
 const rt={tasks:{T:{taskId:'T',role:'worker',project:'P',account:'a',sessionId:'C',status:'RUNNING'}},sessions:{}};
 await writeFile(path.join(config,'registry.json'),JSON.stringify(reg));
 await writeFile(path.join(state,'runtime.json'),JSON.stringify(rt));
 try {const r=call(store,'get',config,state,'runtime');assert.equal(r.status,0,r.stderr);await fn({root,config,state,reg,rt});}
 finally {await rm(root,{recursive:true,force:true});}
}

test('routine local status does not rewrite either JSON projection',async()=>fixture(async({config,state,rt})=>{
 const files=[path.join(config,'registry.json'),path.join(state,'runtime.json')];
 const before=await Promise.all(files.map(p=>stat(p,{bigint:true})));
 const r=call(local,'runtime',config,state);assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),rt);
 const after=await Promise.all(files.map(p=>stat(p,{bigint:true})));
 for(let i=0;i<files.length;i++) {assert.equal(after[i].ino,before[i].ino,files[i]);assert.equal(after[i].mtimeNs,before[i].mtimeNs,files[i]);}
}));

test('watch admission reads authoritative tasks rather than a stale JSON projection',async()=>fixture(async({config,state})=>{
 await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},sessions:{}}));
 const r=call(web,'watch',config,state,'watch','--account','a');
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'1');
}));

test('capacity selection counts authoritative load rather than stale projected load',async()=>fixture(async({config,state})=>{
 await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{},sessions:{}}));
 const r=call(capacity,'capacity',config,state,'--project','P');
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).accounts[0].activeTasks,1);
}));

test('peek does not initialize or create a missing state directory',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'bridge-peek-empty-'));
 try {
  const r=call(store,'peek',path.join(root,'config'),path.join(root,'state'),'runtime');
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});assert.deepEqual(await readdir(root),[]);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('peek returns authoritative state without repairing a stale projection',async()=>fixture(async({config,state,rt})=>{
 const stale=JSON.stringify({tasks:{}});const file=path.join(state,'runtime.json');await writeFile(file,stale);
 const r=call(store,'peek',config,state,'runtime');assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),rt);
 assert.equal(await readFile(file,'utf8'),stale);
 // Explicit compatibility repair remains supported for older integrations.
 const repaired=call(store,'get',config,state,'runtime');assert.equal(repaired.status,0,repaired.stderr);
 assert.deepEqual(JSON.parse(await readFile(file,'utf8')),rt);
}));
