import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import '../src/session-policy.js';
const source=await readFile('src/main.js','utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const cid='11111111-1111-4111-8111-111111111111',projectId='g-p-'+'a'.repeat(32);
const url='https://chatgpt.com/g/'+projectId+'/c/'+cid;
const primary='chat-bridge-agent-a',profile='Profile 1';
const mapping=(id,name)=>({spaceId:id,spaceName:name,profileId:profile,identity:'login-a',account:'a',createdAt:'2026-10-07T00:00:00Z'});

async function fixture(change={}){
  const head=mapping(42,primary+'-overflow-2'),previous=mapping(41,primary+'-overflow');
  head.previousSpaces=[previous];
  const reg={accounts:{a:{identity:'login-a'}},projects:{P:{bindings:{a:{spaceName:primary,spaceId:1,profileId:profile}}}},
    chats:{[cid]:{id:cid,project:'P',account:'a',url}},spaces:{primary:{name:primary,spaceId:1,identity:'login-a',profileId:profile,ownership:'agent'}},
    capacityOverflow:{['login-a|'+profile]:head}};
  const runtime={sessions:{},tasks:{other:{sessionId:'other',watchdogPausedForUserControl:true}},capacity:{retained:true}};
  const operation={id:'original',status:'DELIVERY_UNKNOWN',session_ref:cid,attempts:48,result:{original:true}};
  const calls={newPages:[],created:[],gotos:[],spaces:[],state:0,contexts:0};
  const tab=(label,target=url,openedBy='agent')=>({label,url:target,openedBy,active:false});
  const full=id=>Array.from({length:8},(_,n)=>tab('p'+id+'-'+n,url.replace(cid,'22222222-2222-4222-8222-222222222222')));
  const inventories=new Map([[1,full(1)],[42,change.headTabs??[tab('p42','about:blank')]],[41,change.previousTabs??full(41)]]);
  if(change.primaryTabs)inventories.set(1,change.primaryTabs);
  const available=[{id:1,name:primary,profileId:profile,ownership:'agent',createdBy:'agent'},
    ...[head,previous].map(m=>({id:m.spaceId,name:m.spaceName,profileId:profile,ownership:'agent',createdBy:'agent'}))];
  change.mutate?.({reg,runtime,operation,available,inventories});
  const scope={operationId:'original',taskId:'original-task',project:'P',account:'a',accountId:'scope-a',sessionRef:cid,
    projectId,anchor:'original-anchor',accountIdentity:'login-a',url,binding:reg.projects.P.bindings.a};
  const pages=new Map();
  function page(id,label,target){
    const p={label,url:async()=>change.pageUrl||target,waitForFunction:async()=>{},
      evaluate:async()=>change.login||'login-a',goto:async value=>{calls.gotos.push({id,value});target=value;inventories.get(id).find(t=>t.label===label).url=value;},
      close:async()=>{throw Error('read-only observation must not close pages');}};
    pages.set(id+':'+label,p);return p;
  }
  const values={crypto,slug:value=>value,reg,taskAccounts:new Map(),accountScope:()=>scope.accountId,
    opt:key=>key==='project'?'P':'a',
    coordinated:()=>{calls.contexts++;return {...scope,anchor:change.anchorRace&&calls.contexts>1?'changed':'original-anchor'};},
    loadRuntime:async()=>({...runtime,sessions:change.paused||(change.pauseDuringSample&&calls.state)?{[cid]:{watchdogPausedForUserControl:true}}:runtime.sessions}),
    assertWebAvailable:async()=>{},listTaskSpaces:async()=>available,
    taskSpace:async target=>{
      assert.equal(typeof target,'number','observation must open only an existing Space by verified ID');
      calls.spaces.push(target);const info=available.find(x=>x.id===target);assert.ok(info,'must not create a Space');
      if(change.overflowIdRace && target===42){info.id=99;inventories.set(99,inventories.get(42));target=99;}
      return {spaceId:target,name:change.taskNameWrong&&target===42?'foreign-name':info.name,tabs:async()=>inventories.get(target),
        page:label=>pages.get(target+':'+label)||page(target,label,inventories.get(target).find(x=>x.label===label)?.url),
        newPage:async()=>{calls.newPages.push(target);if(inventories.get(target).length>=8||change.allocationRace===target)throw Error('Page budget reached (8/8) in space');
          const label='created-'+target;inventories.get(target).push(tab(label,'about:blank'));calls.created.push(target);return page(target,label,'about:blank');}};
    },
    pageBudgetError:error=>/page budget reached/i.test(error.message),saveRegistry:async()=>{throw Error('no registry writes');},
    state:async(p,mode)=>{assert.equal(mode,true);calls.state++;change.afterSample?.({available,inventories});return {url:await p.url(),observedAt:'2026-10-07T00:00:00Z',userMessages:[],composerText:'protected draft',generating:true,lastAssistant:'reply',lastAssistantId:'assistant',messageCount:2};},
    sameConversationUrl:globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,
    projectKey:value=>value.match(/g-p-[0-9a-f]{32}/)?.[0],recoveryRequired:()=>false};
  const code=section('function managedSpacePlan','\nasync function accountManagedTask')+'\n'+
    section('async function overflowManagedTask','\nasync function newManagedPage')+'\n'+section('async function observeOperation','\nasync function ensurePage');
  const observe=await new AsyncFunction(...Object.keys(values),code+';return observeOperation;')(...Object.values(values));
  const before=structuredClone({reg,runtime,operation});
  return {calls,run:()=>observe(reg,'original'),unchanged:()=>assert.deepEqual({reg,runtime,operation},before)};
}

test('UNKNOWN observation reuses the unique existing overflow CID after the primary budget refusal',async()=>{
  const f=await fixture({headTabs:[{label:'exact',url,openedBy:'agent'}]});
  const result=await f.run();assert.equal(result.readOnly,true);assert.equal(result.messageSent,false);
  assert.deepEqual(f.calls.newPages,[1]);assert.deepEqual(f.calls.created,[]);assert.deepEqual(f.calls.gotos,[]);f.unchanged();
});

test('UNKNOWN observation allocates the known CID once in existing available head or previous Space',async()=>{
  for(const previous of [false,true]){
    const f=await fixture(previous?{headTabs:Array.from({length:8},(_,n)=>({label:'full-'+n,url:'about:blank',openedBy:'agent'})),previousTabs:[]}:{});
    const result=await f.run();assert.equal(result.readOnly,true);
    assert.deepEqual(f.calls.created,[previous?41:42]);assert.deepEqual(f.calls.newPages,[1,previous?41:42]);
    assert.deepEqual(f.calls.gotos,[{id:previous?41:42,value:url}]);f.unchanged();
  }
});

test('UNKNOWN observation rejects duplicate or unowned target tabs in the entire existing pool',async()=>{
  for(const change of [
    {headTabs:[{label:'one',url,openedBy:'agent'},{label:'two',url,openedBy:'agent'}]},
    {headTabs:[{label:'one',url,openedBy:'agent'}],previousTabs:[{label:'two',url,openedBy:'agent'}]},
    {headTabs:[{label:'user',url,openedBy:'user'}]},
    {headTabs:[{url,openedBy:'agent'}]},
    {primaryTabs:[{label:'user',url,openedBy:'user'}]},
    {primaryTabs:[{label:'one',url,openedBy:'agent'},{label:'two',url,openedBy:'agent'}]}
  ]){const f=await fixture(change);await assert.rejects(f.run(),/OPERATION_OBSERVATION_/);assert.deepEqual(f.calls.created,[]);f.unchanged();}
});

test('UNKNOWN observation refuses missing, changed, foreign or user-owned overflow mappings without creating a Space',async()=>{
  const changes=[
    ({reg})=>{delete reg.capacityOverflow['login-a|'+profile];},
    ({reg})=>{reg.capacityOverflow['login-a|'+profile].identity='foreign';},
    ({reg})=>{reg.capacityOverflow['login-a|'+profile].profileId='foreign';},
    ({reg})=>{reg.capacityOverflow['login-a|'+profile].spaceId=99;},
    ({reg})=>{reg.capacityOverflow['login-a|'+profile].previousSpaces[0].identity='foreign';},
    ({available})=>{available[1].ownership='user';},
    ({available})=>{available[1].createdBy='user';},
    ({available})=>{available[1].profileId='foreign';},
    ({available})=>{available.push({...available[1],id:99});},
    ({available})=>{available.splice(1,1);}
  ];
  for(const mutate of changes){const f=await fixture({mutate});await assert.rejects(f.run());assert.deepEqual(f.calls.created,[]);f.unchanged();}
});

test('existing-only UNKNOWN observation rejects the normal legacy foreign-Profile rename path',async()=>{
  const f=await fixture({headTabs:[{label:'exact',url,openedBy:'agent'}],mutate:({reg,available})=>{
    const legacy=primary+'-overflow',head=reg.capacityOverflow['login-a|'+profile];
    head.spaceName=legacy;delete head.previousSpaces;
    available[1].name=legacy+'-'+crypto.createHash('sha256').update(profile).digest('hex').slice(0,8);
    available[2].id=16;available[2].profileId='foreign';
  }});
  await assert.rejects(f.run(),/OVERFLOW_MAPPING_CHANGED/);
  assert.deepEqual(f.calls.created,[]);assert.deepEqual(f.calls.gotos,[]);f.unchanged();
});

test('existing-only observer checks returned Space ID and name against the original mapping',async()=>{
  for(const change of [{overflowIdRace:true},{taskNameWrong:true}]){
    const f=await fixture(change);await assert.rejects(f.run(),/OVERFLOW_SPACE_VERIFICATION_FAILED/);
    assert.deepEqual(f.calls.created,[]);assert.deepEqual(f.calls.gotos,[]);f.unchanged();
  }
});

test('UNKNOWN observation stops when the whole pool is full or the single selected allocation races',async()=>{
  const full=Array.from({length:8},(_,n)=>({label:'full-'+n,url:'about:blank',openedBy:'agent'}));
  for(const change of [{headTabs:full,previousTabs:full},{allocationRace:42,previousTabs:[]}]){
    const f=await fixture(change);await assert.rejects(f.run(),/budget|CAPACITY/i);
    assert.deepEqual(f.calls.created,[]);assert.ok(f.calls.newPages.length<=2);f.unchanged();
  }
});

test('overflow observation retains exact login, Project, pause and anchor rejection',async()=>{
  for(const change of [{login:'foreign'},{pageUrl:url.replace(projectId,'g-p-'+'b'.repeat(32))},{paused:true},{pauseDuringSample:true},{anchorRace:true}]){
    const f=await fixture({...change,headTabs:[{label:'exact',url,openedBy:'agent'}]});
    await assert.rejects(f.run(),/OPERATION_|OBSERVATION_/);f.unchanged();
  }
});

test('overflow observation rejects late Space takeover, duplicate CID and target Tab ownership changes',async()=>{
  for(const afterSample of [
    ({available})=>{available[1].ownership='agentDelegatedToUser';},
    ({available})=>{available[2].profileId='foreign';},
    ({inventories})=>{inventories.get(42)[0].openedBy='user';},
    ({inventories})=>{inventories.get(1)[0].url=url;},
    ({inventories})=>{inventories.get(41)[0].url=url;}
  ]){
    const f=await fixture({headTabs:[{label:'exact',url,openedBy:'agent'}],afterSample});
    await assert.rejects(f.run(),/OPERATION_OBSERVATION_/);f.unchanged();
  }
});
