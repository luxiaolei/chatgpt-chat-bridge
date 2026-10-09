import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import '../src/session-policy.js';
const source=await readFile(process.env.CHAT_BRIDGE_ENSURE_POOL_TEST_MAIN||'src/main.js','utf8'),AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const section=(a,z)=>source.slice(source.indexOf(a),source.indexOf(z,source.indexOf(a)));
const projectId='g-p-'+'a'.repeat(32),home='https://chatgpt.com/g/'+projectId+'/project',cid='11111111-1111-4111-8111-111111111111',url=home.replace('/project','/c/'+cid);

async function run(change={}) {
  const name='chat-bridge-agent-a',binding={account:'a',spaceName:name,spaceId:2,profileId:'P1',projectUrl:home};
  const previous={identity:'login-a',account:'a',spaceName:name+'-overflow',spaceId:32,profileId:'P1',createdAt:'fixed'};
  const head={...previous,spaceName:name+'-overflow-2',spaceId:41,previousSpaces:[previous]};
  const reg={accounts:{a:{identity:'login-a'}},spaces:{primary:{name,spaceId:2,profileId:'P1',identity:'login-a',ownership:'agent'}},projects:{P:{bindings:{a:binding}}},capacityOverflow:{'login-a|P1':head}};
  const chat={id:cid,role:'original-worker',project:'P',account:'a',url,spaceName:change.fromOverflow?head.spaceName:name,spaceId:change.fromOverflow?41:2,profileId:'P1',page:null};reg.chats={[cid]:chat};
  const before=structuredClone(reg),calls={created:0,goto:0,saved:0,spaces:[],opened:[]};
  const spaces=[binding,head,previous].map(e=>({id:e.spaceId,name:e.spaceName,profileId:'P1',ownership:'agent',createdBy:'agent'}));
  const targetSpace=change.targetSpace||41;
  const inventory=new Map([2,41,32].map(id=>[id,[...Array(8)].map((_,i)=>({label:'p'+i,targetId:id+'-'+i,url:'about:blank',openedBy:'agent'}))]));
  const target={label:'p4',targetId:'original-target',url,openedBy:change.unowned?'user':'agent'};
  if(!change.missingTarget)inventory.get(targetSpace)[4]=target;
  if(change.duplicate)inventory.get(32)[4]={...target,targetId:'duplicate'};
  if(change.unlabelled)delete target.label;
  if(change.missingTargetId)delete target.targetId;
  if(change.foreignProject)target.url=url.replace(projectId,'g-p-'+'b'.repeat(32));
  if(change.wrongProfile)spaces[1].profileId='P2';
  if(change.userSpace)spaces[1].ownership='user';
  if(change.wrongID)spaces[1].id=99;
  let targetReads=0;
  const tasks=new Map([2,41,32].map(id=>[id,{spaceId:id,name:spaces.find(s=>s.id===id)?.name,
    tabs:async()=>{if(id===targetSpace&&++targetReads===2){if(change.targetRace)inventory.get(id)[4]={...target,targetId:'changed'};if(change.targetInPlace)target.targetId='changed';}return inventory.get(id);},
    pages:async()=>{
      if(id===targetSpace&&change.lateTargetRace)inventory.get(id)[4]={...target,targetId:'recycled-target'};
      if(id===targetSpace&&change.lateOwnershipRace)inventory.get(id)[4]={...target,openedBy:'user'};
      return inventory.get(id).filter(t=>t.label).map(t=>({label:t.label,url:async()=>change.pageRace&&t===target?home:t.url,goto:async()=>{calls.goto++;}}));
    },
    newPage:async()=>{calls.created++;throw Error('unexpected creation');}}]));
  const taskAccounts=new Map();
  const api=await new AsyncFunction('crypto','slug','listTaskSpaces','taskSpace','taskAccounts','accountScope','saveRegistry','openBoundTask','pagesOf','sameConversationUrl','projectKey','newManagedPage','waitForConversationReady','openConversationFromProject',
    section('function capacityScope','\nfunction capacityBackoffSec')+section('function managedSpacePlan','\nasync function accountManagedTask')+section('async function overflowManagedTask','\nasync function newManagedPage')+'const assertPhysicalPageAvailable=()=>{};'+section('async function ensurePage','\nfunction hashText')+';return ensurePage;')(
    crypto,x=>x,async()=>spaces,async id=>{assert.equal(typeof id,'number');calls.spaces.push(id);return tasks.get(id);},taskAccounts,()=> 'scope-a',async()=>{calls.saved++;},
    async(_r,_p,_a,options={})=>{const b=options.spaceOverride||binding;calls.opened.push({id:b.spaceId,requireExisting:options.requireExistingSpace});const s=spaces.find(s=>s.id===b.spaceId&&s.name===b.spaceName);if(!s||s.profileId!==b.profileId||s.ownership!=='agent')throw Error('space changed');return {task:tasks.get(b.spaceId),binding:b};},
    async task=>task.pages(),globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,value=>value?.match(/g-p-[a-f0-9]{32}/)?.[0],
    async()=>{calls.created++;throw Error('capacity waiting');},async()=>{
      if(change.waitTargetRace)inventory.get(targetSpace)[4]={...target,targetId:'recycled-after-ready'};
      if(change.waitOwnershipRace)inventory.get(targetSpace)[4]={...target,openedBy:'user'};
      if(change.waitSpaceOwnership)spaces.find(s=>s.id===targetSpace).ownership='user';
      if(change.waitSpaceProfile)spaces.find(s=>s.id===targetSpace).profileId='P2';
    },async()=>{throw Error('unexpected navigation');}
  );
  let result,error;try{result=await api(reg,chat,{pauseOnUserControl:true});}catch(e){error=e;}
  assert.deepEqual(reg.projects,before.projects);assert.deepEqual(reg.capacityOverflow,before.capacityOverflow);assert.equal(calls.goto,0);
  return {result,error,calls,chat,before};
}

test('normal observation and watch reuse the unique original CID in the full verified existing pool',async()=>{
  for(const change of [{},{targetSpace:32},{fromOverflow:true,targetSpace:2}]) {
    const f=await run(change);assert.ifError(f.error);assert.equal(f.result.task.spaceId,change.targetSpace||41);assert.equal(f.chat.page,'p4');assert.equal(f.chat.id,cid);
    assert.equal(f.calls.created,0);assert.equal(f.calls.saved,1);assert.equal(f.calls.opened.at(-1).requireExisting,true);
  }
});

test('pool rediscovery rejects duplicate, unowned, foreign or changed original targets without allocating',async()=>{
  for(const change of [{duplicate:true},{unowned:true},{unlabelled:true},{missingTargetId:true},{wrongProfile:true},{userSpace:true},{wrongID:true},{targetRace:true},{targetInPlace:true},{pageRace:true},{lateTargetRace:true},{lateOwnershipRace:true},{waitTargetRace:true},{waitOwnershipRace:true},{waitSpaceOwnership:true},{waitSpaceProfile:true}]) {
    const f=await run(change);assert.match(f.error?.message||'',/CONVERSATION_POOL_TAB_|OVERFLOW_|SPACE_IN_USER_CONTROL|space changed/,JSON.stringify(change));assert.equal(f.calls.created,0);assert.equal(f.calls.saved,0);assert.deepEqual(f.chat,f.before.chats[cid]);
  }
});

test('an unrelated Project or missing CID never becomes the original conversation',async()=>{
  for(const change of [{foreignProject:true},{missingTarget:true}]) {
    const f=await run(change);assert.match(f.error.message,/capacity waiting/);assert.equal(f.chat.page,null);assert.equal(f.calls.saved,0);
  }
});
