import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as crypto from 'node:crypto';

const source=await readFile('src/main.js','utf8');
const normalize=source.slice(source.indexOf('function normalizeRegistry('),source.indexOf('function normalizeRuntime('));
const functions=source.slice(source.indexOf('async function loadRegistry()'),source.indexOf('function opt('));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const store=path.resolve('src/state-store.py');

async function fixture(fn) {
  const root=await mkdtemp(path.join(tmpdir(),'bridge-registry-cas-'));
  const config=path.join(root,'config'),state=path.join(root,'state');
  await mkdir(config);await mkdir(state);
  const raw={version:2,defaultAccount:'a',accounts:{a:{identity:'fixture-login'}},
    projects:{P:{name:'P',activeAccount:'a',rootController:'owner',businessProjectId:'fixture',
      bindings:{a:{account:'a',spaceName:'chat-bridge-agent-a',spaceId:16,profileId:'Profile 2'}}}},
    chats:{C:{id:'C',project:'P',account:'a',role:'owner',status:'active',
      spaceName:'old-user-space',spaceId:5,page:'p154',profileId:'Profile 2'}},spaces:{}};
  await writeFile(path.join(config,'registry.json'),JSON.stringify(raw));
  await writeFile(path.join(state,'runtime.json'),JSON.stringify({tasks:{}}));
  const stored=(command,kind,payload)=>{
    const r=spawnSync('python3',[store,command,config,state,kind],{
      encoding:'utf8',timeout:15000,input:payload===undefined?undefined:JSON.stringify(payload)});
    if(r.status!==0) throw new Error(r.stderr||'state store failed');
    return JSON.parse(r.stdout);
  };
  try {
    stored('get','registry');
    const api=await new AsyncFunction('stored','crypto',`
      const DEFAULT_ACCOUNT='default',stateBaselines=new WeakMap();
      const emptyRegistry=()=>({version:2,accounts:{},projects:{},chats:{},spaces:{}});
      const defaultSpaceName=()=>{throw Error('unexpected default binding');};
      const projectIdFromUrl=()=>{throw Error('unexpected URL migration');};
      ${normalize}
      ${functions}
      return {loadRegistry,saveRegistry};
    `)(stored,crypto);
    await fn({api,stored,config,raw});
  } finally {await rm(root,{recursive:true,force:true});}
}

test('normalized legacy attachment saves against raw SQLite baseline, not a fabricated null page',async()=>fixture(async({api,stored,raw})=>{
  const reg=await api.loadRegistry();
  assert.equal(reg.chats.C.page,null);
  assert.equal(reg.chats.C.spaceName,'chat-bridge-agent-a');
  assert.deepEqual(stored('peek','registry'),raw,'load must not mutate the authoritative registry');
  reg.chats.C.page='p20';reg.chats.C.pageSpaceId=16;
  await api.saveRegistry(reg);
  assert.equal(stored('peek','registry').chats.C.page,'p20');
  assert.equal(stored('peek','registry').chats.C.legacySpaceId,5);
}));

test('raw registry CAS still rejects a genuinely concurrent attachment change without overwriting it',async()=>fixture(async({api,stored})=>{
  const reg=await api.loadRegistry();reg.chats.C.page='p20';
  const base=stored('peek','registry'),next=structuredClone(base);next.chats.C.page='p21';
  stored('put','registry',{base,next});
  await assert.rejects(api.saveRegistry(reg),/STATE_CONFLICT/);
  assert.deepEqual(stored('peek','registry'),next);
}));

test('registry read stays non-writing and unrelated concurrent metadata is retained on save',async()=>fixture(async({api,stored,config})=>{
  const projection=path.join(config,'registry.json'),before=await stat(projection,{bigint:true});
  const reg=await api.loadRegistry();
  const after=await stat(projection,{bigint:true});
  assert.equal(before.ino,after.ino);assert.equal(before.mtimeNs,after.mtimeNs);
  const base=stored('peek','registry'),next=structuredClone(base);next.operatorNote='concurrent-owner-note';
  stored('put','registry',{base,next});
  reg.chats.C.page='p20';await api.saveRegistry(reg);
  const current=stored('peek','registry');
  assert.equal(current.operatorNote,'concurrent-owner-note');assert.equal(current.chats.C.page,'p20');
}));
