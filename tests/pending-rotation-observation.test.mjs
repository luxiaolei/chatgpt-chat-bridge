import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import '../src/session-policy.js';
const source=await readFile('src/main.js','utf8');
const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const id='11111111-1111-4111-8111-111111111111',projectId='g-p-'+'a'.repeat(32);
const url='https://chatgpt.com/g/'+projectId+'/c/'+id;

async function fixture(change={}){
  const chat={id,url,project:'P',account:'a',role:'lead',status:'pending-rotation'};
  const reg={chats:{[id]:chat}},runtime={sessions:{},tasks:{protected:{watchdogPausedForUserControl:true}}};
  const binding={spaceName:'chat-bridge-agent-a-overflow',spaceId:42,profileId:'Profile 1'};
  const scope={sessionRef:id,url,project:'P',account:'a',accountId:'a',accountIdentity:'login-a',projectId,binding,anchor:'exact-current',operationId:'sent-original'};
  const snapshot={url,lastAssistant:'actual successor reply',lastAssistantId:'assistant',lastUserSource:{text:'exact source'},composerText:'user draft',observedAt:new Date().toISOString()};
  let queries=0,printed,reads=0,logins=0;
  const page={url:async()=>url,waitForFunction:async()=>{},evaluate:async()=>{logins++;return change.login||'login-a';}};
  const values={reg,runtime,cmd:change.cmd||'status',args:[change.cmd||'status',id],
    coordinated:(command,payload)=>{assert.equal(command,'observation-context');assert.deepEqual(payload,{pendingSession:id});queries++;return {...scope,anchor:change.race&&queries===2?'changed':'exact-current'};},
    opt:name=>change[name]||null,
    listTaskSpaces:async()=>[{id:change.spaceId||42,name:binding.spaceName,ownership:change.ownership||'agent',createdBy:'agent',profileId:change.profile||'Profile 1'}],
    loadRuntime:async()=>({...runtime,sessions:change.pause||(change.pauseAfterRead&&reads)||(change.pauseAfterLogin&&logins)?{[id]:{watchdogPausedForUserControl:true}}:{},
      tasks:{...runtime.tasks,...(change.pauseTaskAfterRead&&reads?{target:{sessionId:id,watchdogPausedForUserControl:true}}:{})}}),
    taskSpace:async()=>({spaceId:42,tabs:async()=>change.tabs||[{url,label:'p4',openedBy:'agent'}],page:()=>page,newPage:()=>{throw Error('unexpected page allocation');}}),
    taskAccounts:new Map(),accountScope:(_reg,alias)=>alias,assertWebAvailable:async()=>{},
    state:async(_page,mode)=>{assert.equal(mode,'ids');reads++;return {...snapshot,url:change.url||url};},
    projectKey:value=>value.match(/g-p-[0-9a-f]{32}/)?.[0],
    sameConversationUrl:globalThis.__CHAT_BRIDGE_SESSION_POLICY__.sameConversationUrl,
    convId:value=>value.match(/\/c\/([^/]+)/)?.[1]||value,recoveryRequired:()=>false,
    print:value=>printed=value};
  const code=section('async function observeOperation(','\nasync function ensurePage')+'\n'+
    section('else if(["read","status"].includes(cmd)','\nelse if(["read","evidence"').replace(/^else /,'');
  return {run:async()=>{await new AsyncFunction(...Object.keys(values),code)(...Object.values(values));return {printed,queries,reads};},reg,runtime};
}

test('public exact pending status/read reuse the readonly observer, preserving draft, ACK barrier and pauses',async()=>{
  for(const cmd of ['status','read']){
    const f=await fixture({cmd}),before=structuredClone({reg:f.reg,runtime:f.runtime});
    const result=await f.run();
    assert.equal(result.queries,2);assert.equal(result.reads,1);
    if(cmd==='read')assert.equal(result.printed,'actual successor reply');
    else {assert.equal(result.printed.readOnly,true);assert.equal(result.printed.status,'pending-rotation');assert.equal(result.printed.composerText,'user draft');assert.equal(result.printed.lastUserSource.text,'exact source');}
    assert.deepEqual({reg:f.reg,runtime:f.runtime},before);
  }
  const f=await fixture(),body=section('function resolveChat(','\nasync function pagesOf')+'\n'+
    section('else if(["read","evidence","status"','\n  const background=').replace(/^else /,'')+'\n}';
  for(const cmd of ['send','ask','stream','model','effort','stop','retry','recover','resend']){
    const fn=new AsyncFunction('reg','convId','activeAccount','cmd','args','project','accountArg',body);
    await assert.rejects(fn(f.reg,v=>v,()=> 'a',cmd,[cmd,id],null,null),/Unknown active chat/);
  }
  const lifecycle=section('  const chat=resolveChat(reg,key,project,accountArg,true);','\n  assertImageSessionFree(reg,chat);');
  const guard=new Function('reg','convId','activeAccount','key','project','accountArg',section('function resolveChat(','\nasync function pagesOf')+'\n'+lifecycle);
  assert.throws(()=>guard(f.reg,v=>v,()=> 'a',id,null,null),/ROTATION_ACK_REQUIRED/);
});

test('pending observation rejects wrong login, route, attachment, ownership, pause and a concurrent ACK',async()=>{
  for(const change of [{login:'foreign'},{project:'foreign'},{account:'foreign'},{spaceId:1},{ownership:'user'},{profile:'foreign'},{pause:true},{tabs:[]},{tabs:[{url,label:'p4',openedBy:'user'}]},{tabs:[{url,label:'p4',openedBy:'agent'},{url,label:'p5',openedBy:'agent'}]},{url:url.replace(id,'22222222-2222-4222-8222-222222222222')},{race:true}]){
    const f=await fixture(change),before=structuredClone({reg:f.reg,runtime:f.runtime});
    await assert.rejects(f.run(),/OPERATION_|OBSERVATION_/);
    assert.deepEqual({reg:f.reg,runtime:f.runtime},before);
  }
});

test('a user pause arriving during pending sampling rejects the sample without state writes',async()=>{
  for(const change of [{pauseAfterRead:true},{pauseAfterLogin:true},{pauseTaskAfterRead:true}]){
    const f=await fixture(change),before=structuredClone({reg:f.reg,runtime:f.runtime});
    await assert.rejects(f.run(),/OPERATION_OBSERVATION_USER_CONTROL_PAUSED/);
    assert.deepEqual({reg:f.reg,runtime:f.runtime},before);
  }
});
