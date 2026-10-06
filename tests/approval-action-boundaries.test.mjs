
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for(const file of ['control-routing','page-pool','liveness-policy','task-policy','web-policy','model-policy','session-policy'])
  await import('../src/'+file+'.js');
const source=(await readFile(new URL('../src/main.js',import.meta.url),'utf8')).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const url='https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef/c/12345678-1234-1234-1234-123456789abc';
const chat={id:'12345678-1234-1234-1234-123456789abc',role:'conductor',project:'P',account:'a',url,page:'p1',spaceName:'managed',spaceId:7};
const pending={approvalRequired:true,online:false,composerPresent:false,inputReady:false,generating:false,errorTexts:['Codex Tasks\nAllow ChatGPT to use Codex Tasks?']};
async function build(f,extra='') {
  return new AsyncFunction('f',source+`
    const reg=f.reg;
    loadRuntime=async()=>structuredClone(f.rt);
    saveRuntime=async x=>{f.rt=structuredClone(x);f.calls.push('save-runtime');};
    saveRegistry=async()=>f.calls.push('save-registry');
    notifyController=async()=>{f.calls.push('notify');return {sent:true};};
    assertWebAvailable=async()=>{};
    detectWebRateLimit=async()=>{};
    resolveChat=()=>f.chat;
  `+extra+`;return {watchOnce,sendMessage,recoverConversationLoadError};`)(f);
}
test('real readiness path preserves pending approval before missing-composer load recovery',async()=>{
  const f={chat,calls:[],reg:{chats:{[chat.id]:chat},projects:{P:{bindings:{a:{spaceName:'managed'}}}}},
    rt:{tasks:{T:{taskId:'T',project:'P',sessionId:chat.id,status:'RUNNING',watchErrorCount:2,recoveryAttempts:0}},sessions:{},projects:{}}};
  let clock=Date.now(); f.clock=class extends Date {static now(){clock+=1000;return clock;}};
  f.page={label:'p1',url:async()=>url,waitForSelector:async()=>{throw Error('composer absent');},waitForTimeout:async()=>{},
    evaluate:async()=>{f.calls.push('load-error-DOM-evaluate');return {loadError:true,count:1};},
    focus:async()=>f.calls.push('focus-retry'),keyboard:{press:async k=>f.calls.push('key-'+k)}};
  const api=await build(f,`
    const Date=f.clock;
    openBoundTask=async()=>({binding:{spaceName:'managed',spaceId:7},task:{spaceId:7,tabs:async()=>[{label:'p1',openedBy:'agent',url:f.chat.url}]}});
    pagesOf=async()=>[f.page];
    state=async()=>{f.calls.push('approval-state-read');return ${JSON.stringify(pending)};};
  `);
  const result=await api.watchOnce(f.reg,'P','a',{skipLifecycle:true});
  assert.equal(result[0].state,'WAITING_USER_APPROVAL');
  assert.equal(f.rt.tasks.T.status,'RUNNING');
  assert.equal(f.rt.tasks.T.watchErrorCount,2);
  assert.equal(f.rt.tasks.T.recoveryAttempts,0);
  assert.equal(f.calls.some(x=>['key-Enter','focus-retry','notify'].includes(x)),false);
  assert.equal(chat.page,'p1');
});
test('approval during support inspection, fill or native witness prevents submit and preserves the current draft',async()=>{
  for(const phase of ['support','fill','witness']) {
    const f={chat,calls:[],reg:{chats:{[chat.id]:chat},accounts:{a:{identity:'identity'}}},rt:{tasks:{},sessions:{},projects:{}},approval:false,phase,draft:''};
    f.page={spaceId:7,fill:async(_selector,text)=>{f.calls.push('fill');f.draft=text;if(phase==='fill')f.approval=true;},
      waitForTimeout:async()=>{},evaluate:async fn=>String(fn).includes("/api/auth/session")?"identity":false,press:async()=>f.calls.push('send-Enter')};
    const api=await build(f,`
      assertImagePageFree=async()=>{};
      state=async()=>({url:f.chat.url,approvalRequired:f.approval,inputReady:true,generating:false,composerText:f.draft,composerCount:1,composerAttachmentsEmpty:true,composerRawText:f.draft,userMessageIds:[]});
      nativeSubmissionWitness=async(_page,_request,_identity,capabilityOnly=false)=>{if(f.phase===(capabilityOnly?'support':'witness'))f.approval=true;return null;};
      waitForDelivery=async()=>{throw new Error('PROBE_STOP_AFTER_REAL_TRIGGER');};
    `);
    await assert.rejects(api.sendMessage(f.page,'continue',url),error=>error.message==='APPROVAL_REQUIRED'&&error.deliveryStage==='PRE_SEND');
    assert.equal(f.calls.includes('send-Enter'),false);
    assert.equal(f.calls.includes('fill'),phase!=='support');
    assert.equal(f.draft,phase==='support'?'':'continue');
  }
});
test('load recovery rechecks approval after focus and never falls through to click',async()=>{
  const f={calls:[],reg:{},rt:{},approval:false};
  const api=await build(f,`state=async()=>({approvalRequired:f.approval});`);
  const page={evaluate:async()=>({loadError:true,count:1}),focus:async()=>{f.approval=true;},
    keyboard:{press:async()=>f.calls.push('Enter')},click:async()=>f.calls.push('click')};
  await assert.rejects(api.recoverConversationLoadError(page),/APPROVAL_REQUIRED/);
  assert.deepEqual(f.calls,[]);
});
