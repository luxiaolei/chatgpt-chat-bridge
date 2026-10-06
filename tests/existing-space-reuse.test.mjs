import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as SPACE_CATALOG from '../src/space-catalog.js';
const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function openBoundTask('),source.indexOf('\nfunction samePhysicalSpace('));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const name='chat-bridge-agent-a-overflow-e7be810d';
const available=()=>[{id:32,name,profileId:'Profile 1',ownership:'agent',createdBy:'agent'}];

async function fixture(options={}) {
 const canonical={account:'a',spaceName:'chat-bridge-agent-a',spaceId:7,profileId:'Profile 1'};
 const reg={accounts:{a:{identity:'login-a'},foreign:{identity:'foreign-login'}},projects:{P:{bindings:{a:canonical}}},spaces:options.spaces||{}};
 if(options.noIdentity)delete reg.accounts.a.identity;
 const original=structuredClone(reg),calls=[],accounts=new Map(options.priorAccount?[[32,'foreign']]:[]);
 let inventory=structuredClone(options.inventory??available());
 const override=options.canonical?null:{spaceName:name,spaceId:options.expectedId===undefined?32:options.expectedId,profileId:options.expectedProfile===undefined?'Profile 1':options.expectedProfile};
 const taskSpace=async(target,creation)=>{
  calls.push({target,creation});
  const existing=inventory.find(s=>s.id===target||s.name===target);
  if(existing&&creation?.profileId)throw Error('taskSpace profileId only applies when creating a new task space; "'+existing.name+'" already exists');
  if(!existing&&!creation?.profileId)throw Error('Missing space must receive an explicit creation profile');
  const id=existing?.id??90;
  if(options.afterOpen)inventory=options.afterOpen(inventory);
  return {spaceId:options.returnedId??id};
 };
 const open=await new AsyncFunction('bindingFor','assertWebAvailable','bindingObserved','repairProjectObservation','listTaskSpaces','SPACE_CATALOG','taskSpace','taskAccounts','accountScope','saveRegistry',helper+';return openBoundTask;')(
  r=>r.projects.P.bindings.a,async()=>{},()=>true,()=>{throw Error('Repair forbidden');},
  options.noInventory?undefined:async()=>structuredClone(inventory),SPACE_CATALOG,taskSpace,accounts,
  (r,a)=>r.accounts[a]?.identity||a,()=>{throw Error('Registry write forbidden');});
 let result,error;try{result=await open(reg,'P','a',{spaceOverride:override,requireExistingSpace:!!options.requireExistingSpace});}catch(e){error=e;}
 assert.deepEqual(reg,original,'canonical registry changed');
 return {result,error,calls,accounts};
}

test('existing overflow reuse observes the exact ID and omits creation-only profile',async()=>{
 const f=await fixture();assert.ifError(f.error);assert.equal(f.result.task.spaceId,32);
 assert.deepEqual(f.calls,[{target:32,creation:undefined}]);
});
test('explicit missing overflow creation retains its requested profile',async()=>{
 const f=await fixture({inventory:[],expectedId:null});assert.ifError(f.error);
 assert.deepEqual(f.calls,[{target:name,creation:{profileId:'Profile 1'}}]);
});
test('cleanup refuses a vanished overflow without creating a replacement',async()=>{
 const f=await fixture({inventory:[],requireExistingSpace:true});assert.match(f.error?.message||'',/SPACE_NOT_FOUND/);assert.deepEqual(f.calls,[]);
});
test('canonical existing-space behavior is unchanged',async()=>{
 const f=await fixture({canonical:true,inventory:[{id:7,name:'chat-bridge-agent-a',profileId:'Profile 1',ownership:'agent'}]});
 assert.ifError(f.error);assert.deepEqual(f.calls,[{target:'chat-bridge-agent-a',creation:undefined}]);
});
for(const [title,options,condition] of [
 ['wrong Profile',{inventory:[{...available()[0],profileId:'Profile 2'}]},/SPACE_PROFILE_MISMATCH/],
 ['unknown expected Profile',{expectedProfile:null},/SPACE_PROFILE_MISMATCH/],
 ['duplicate names',{inventory:[...available(),{...available()[0],id:33}]},/AMBIGUOUS_SPACE/],
 ['named target ID mismatch',{inventory:[{...available()[0],id:33}]},/SPACE_ID_MISMATCH/],
 ['expected ID belongs to another name',{inventory:[{...available()[0],name:'another-space'}]},/SPACE_ID_MISMATCH/],
 ['duplicate ID under another name',{inventory:[...available(),{...available()[0],name:'another-space'}]},/SPACE_ID_MISMATCH/],
 ['recorded foreign login',{spaces:{foreign:{name,spaceId:32,identity:'foreign-login'}}},/SPACE_ACCOUNT_CHANGED/],
 ['missing registered login',{noIdentity:true},/TARGET_IDENTITY_UNVERIFIED/],
 ['unavailable inventory API',{noInventory:true},/SPACE_ENUMERATION_UNAVAILABLE/],
 ['user ownership',{inventory:[{...available()[0],ownership:'user'}]},/SPACE_IN_USER_CONTROL/],
 ['delegated user ownership',{inventory:[{...available()[0],ownership:'agentDelegatedToUser'}]},/SPACE_IN_USER_CONTROL/],
])test('existing overflow refuses '+title+' before opening it',async()=>{
 const f=await fixture(options);assert.match(f.error?.message||'',condition);assert.equal(f.calls.length,0);
});
test('backend ID change is refused before recording account occupancy',async()=>{
 const f=await fixture({returnedId:33});assert.match(f.error?.message||'',/SPACE_ID_MISMATCH/);assert.equal(f.accounts.size,0);
});
test('Profile change during reuse is refused without registry writes',async()=>{
 const f=await fixture({afterOpen:rows=>rows.map(s=>({...s,profileId:'Profile 2'}))});
 assert.match(f.error?.message||'',/SPACE_PROFILE_MISMATCH/);assert.equal(f.accounts.size,0);
});
test('existing conflicting in-process account guard remains enforced',async()=>{
 const f=await fixture({priorAccount:true});assert.match(f.error?.message||'',/conflicting ChatGPT accounts/);
 assert.equal(f.accounts.get(32),'foreign');
});

for(const [title,ownership] of [['missing',undefined],['unknown','unknown']]) {
 test('initial '+title+' ownership is refused before opening or recording occupancy',async()=>{
  const f=await fixture({inventory:[{...available()[0],ownership}]});
  assert.match(f.error?.message||'',/SPACE_OWNERSHIP_UNVERIFIED/);assert.equal(f.calls.length,0);assert.equal(f.accounts.size,0);
 });
 test(title+' ownership after opening is refused before recording occupancy',async()=>{
  const f=await fixture({afterOpen:rows=>rows.map(s=>({...s,ownership}))});
  assert.match(f.error?.message||'',/SPACE_OWNERSHIP_UNVERIFIED/);assert.equal(f.calls.length,1);assert.equal(f.accounts.size,0);
 });
}
