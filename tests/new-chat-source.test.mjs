import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';

for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import('../src/'+file+'.js');
const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const prefix=main.split('const cmd=args[0] || "help";')[0];
const newBody=main.slice(main.indexOf('else if(cmd==="new"){')+'else if(cmd==="new"){'.length,main.indexOf('\n}\nelse throw new Error("Unknown command:'));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const uuid='11111111-1111-4111-8111-111111111111', messageId='22222222-2222-4222-8222-222222222222';
const temporary='local-chatgpt:33333333-3333-4333-8333-333333333333';
const project='g-p-'+'a'.repeat(32), home='https://chatgpt.com/g/'+project+'-test/project';
const permanent=home.replace('/project','/c/'+uuid), transient=home.replace('/project','/c/'+encodeURIComponent(temporary));
const request='Reply only CANARY.\n\n~~~text\nowned source code block\n~~~\n\nReply only CANARY.';
const getter='getText(){let e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:this.dictation.document;return(0,T.g)(e,this.plainTextMode?void 0:this.markdownEditor?.serialize)}';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');

class Element {
  constructor(tag,attrs={},text=''){this.tagName=tag;this.attrs=attrs;this.innerText=text;this.textContent=text;this.children=[];this.parentElement=null;}
  append(node){this.children.push(node);node.parentElement=this;return node;}
  getAttribute(name){return this.attrs[name]??null;}
  matches(selector){return selector.split(',').some(part=>{
    part=part.trim();const tag=part.match(/^[a-z]+/i)?.[0];
    if(tag&&tag.toUpperCase()!==this.tagName)return false;
    if(!part.includes('['))return !!tag;
    return [...part.matchAll(/\[([^\s=\]^]+)(\$?=)?"?([^"\]]*)"?\]/g)].every(([,key,op,value])=>
      op==='='?this.getAttribute(key)===value:op==='$='?String(this.getAttribute(key)||'').endsWith(value):this.getAttribute(key)!==null);
  });}
  closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null;}
  contains(other){return this===other||this.children.some(n=>n.contains(other));}
  querySelectorAll(selector){const found=[];for(const n of this.children){if(n.matches(selector))found.push(n);found.push(...n.querySelectorAll(selector));}return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getBoundingClientRect(){return {width:100,height:40,left:0,top:0};}
  getClientRects(){return [this.getBoundingClientRect()];}
}

function fixture(change=()=>{}){
  const root=new Element('MAIN'),unit=root.append(new Element('DIV',{'data-chatgpt-search-unit-key':'turn:user','data-chatgpt-search-message-ids':messageId}));
  const bubble=unit.append(new Element('DIV',{'data-user-message-bubble':'true'}));
  const outer=bubble.append(new Element('DIV',{'data-search-result-target':''},request));
  const copy=outer.append(new Element('SPAN')).append(new Element('BUTTON',{'aria-label':'Copy'}));
  const copyFn=()=>{}, copyRef={current:outer};
  const frames=Array.from({length:32},()=>({memoizedProps:{},return:null}));
  frames.forEach((f,i)=>f.return=frames[i+1]||null);
  frames[10].memoizedProps={conversationId:temporary,message:request};
  frames[13].memoizedProps={copyPlainTextFromSource:true,message:request,onCopy:copyFn,copyContentRef:copyRef};
  frames[14].memoizedProps={messageId,conversationId:temporary,copyPlainTextFromSource:true,message:request,onCopy:copyFn,copyContentRef:copyRef};
  frames[31].memoizedProps={messageId:'another-message-owner'};
  outer.__reactFiber$fixture=frames[0];
  const copyFrames=Array.from({length:17},()=>({memoizedProps:{},return:null}));
  copyFrames.forEach((f,i)=>f.return=copyFrames[i+1]||frames[0]);
  copyFrames[0].memoizedProps={'aria-label':'Copy',type:'button',onClick:()=>{}};
  copyFrames[6].memoizedProps={onCopy:()=>{}};
  copyFrames[9].memoizedProps={'data-markdown-copy':''};
  copyFrames[12].memoizedProps={onCopy:()=>{}};
  copy.__reactFiber$fixture=copyFrames[0];
  const composer=new Element('DIV'),doc={content:{size:request.length},textBetween:()=>request};
  composer.pmViewDesc={node:doc};
  const editor={...new Function('T','return {'+getter+'};')({g:()=>request}),view:{dom:composer,state:{doc}},dictation:{document:doc},plainTextMode:false,markdownEditor:{serialize:()=>request}};
  composer.parentElement={__reactFiber$editor:{memoizedProps:{onSubmit:new Function('return e=>{eg(j.getText(),e)}')()},memoizedState:{memoizedState:{deps:[null,editor]}}}};
  const send=new Element('BUTTON',{'data-testid':'send-button'}), f={root,unit,bubble,outer,copy,frames,copyFrames,composer,editor,source:frames[14].memoizedProps,url:home,sends:0,polls:0,persisted:[],printed:[],closed:0,now:Date.now(),trace:[],skipTemporary:false};
  f.reg={accounts:{a:{identity:'verified-user'}},projects:{P:{activeAccount:'a',bindings:{a:{projectUrl:home,projectId:project}}}},chats:{}};
  f.binding=f.reg.projects.P.bindings.a;
  f.document={title:'Canary',visibilityState:'visible',body:root,querySelector(selector){
    if(selector==='main'||selector==='[role="main"]')return root;
    if(selector.includes('contenteditable="true"'))return composer;
    if(selector==='button[data-testid="send-button"]')return send;
    return null;
  },querySelectorAll(selector){
    if(selector.includes('contenteditable="true"'))return [composer];
    if(selector==='[data-message-author-role]')return [];
    if(selector.includes('[data-chatgpt-search-unit-key')||selector.includes('[data-content-search-unit-key'))return f.sends||f.beforeUserId?[unit]:[];
    if(selector==='button')return f.sends?[copy]:[send];
    return [];
  }};
  f.page={label:'p-test',spaceId:2,url:async()=>f.url,goto:async url=>{f.url=url;},waitForSelector:async()=>{},fill:async(_selector,text)=>{assert.equal(text,request);composer.innerText=text;},
    waitForTimeout:async ms=>{f.now+=ms;if(f.sends&&ms>=150){f.polls++;f.url=f.skipTemporary||f.polls>=2?permanent:transient;f.onPoll?.(f);}},
    waitForURL:async re=>assert.match(f.url,re),close:async()=>{f.closed++;},
    click:async selector=>{assert.equal(selector,'button[data-testid="send-button"]');f.sends++;unit.attrs['data-chatgpt-search-message-ids']=messageId;composer.innerText='';f.url=f.skipTemporary?permanent:transient;},
    evaluate:async(fn,...args)=>{
      assert.ok(args.length<=1,'evaluate has exactly zero or one JSON argument');
      const arg=args.length?JSON.parse(JSON.stringify(args[0])):undefined;
      const value=await fn(...(args.length?[arg]:[]));
      if(value&&typeof value==='object'&&'lastUserSource'in value)f.trace.push(JSON.parse(JSON.stringify(value)));
      return value;
    }};
  change(f);if(f.beforeUserId)unit.attrs['data-chatgpt-search-message-ids']=f.beforeUserId;return f;
}

async function inBrowser(f,fn){
  const globals={document:f.document,location:{get href(){return f.url;},get pathname(){return new URL(f.url).pathname;}},
    navigator:{onLine:true},MutationObserver:class{observe(){}disconnect(){}},Node:{ELEMENT_NODE:1},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    fetch:async()=>({json:async()=>({user:{id:'verified-user'}})}),
    __CHAT_BRIDGE_ARGS__:['new','--project','P','--account','a','--role','canary','--name','canary','--message',request,'--strict-model']};
  const prior=new Map(Object.keys(globals).concat('__CHAT_BRIDGE_WATCH').map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const now=Date.now;
  try{
    for(const [k,value]of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value});
    delete globalThis.__CHAT_BRIDGE_WATCH;Date.now=()=>f.now;
    const setup=[
      'const reg=f.reg;',
      'assertImagePageFree=async()=>{};',
      'detectWebRateLimit=async()=>{};',
      'openBoundTask=async()=>({task:{spaceId:2},binding:f.binding});',
      'newManagedPage=async()=>f.page;',
      'openProjectPage=async()=>{f.url=f.binding.projectUrl;};',
      "applyModelSpec=async()=>({model:'Latest',effort:'High'});",
      'saveRegistry=async value=>{f.persisted.push(JSON.parse(JSON.stringify(value)));};',
      'touchRuntime=async()=>{};',
      'print=value=>f.printed.push(value);',
      "return {state,deliveryObserved,sendMessage,nativeSubmissionWitness,captureNewConversationSource,runNew:async()=>{const project='P',accountArg='a';"+newBody+'}};'
    ].join('\n');
    const api=await new AsyncFunction('f',prefix+setup)(f);
    return await fn(api);
  }finally{Date.now=now;for(const [k,d]of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
}

// Captured 2026-10-04 maintenance canary: source at outer fiber14,
// Copy control joins that exact fiber at31, a foreign ancestor occurs only later.
// Bodies and identities are synthetic; this does not replay an old task.
test('captured owned Copy chrome yields the nearest exact source tuple without crossing another message owner',async()=>{
  const f=fixture();f.sends=1;f.url=transient;
  await inBrowser(f,async({state})=>{
    const snapshot=await state(f.page,'ids');
    assert.equal(snapshot.lastUserSource?.messageId,messageId);
    assert.equal(snapshot.lastUserSource?.conversationId,temporary);
    assert.equal(snapshot.lastUserSource?.text,request);
  });
});

test('actual new → native getter → temporary source → permanent URL confirms once and registers only the permanent conversation',async()=>{
  const f=fixture();
  await inBrowser(f,async({runNew})=>runNew());
  assert.equal(f.sends,1);assert.equal(f.persisted.length,1);assert.equal(f.closed,0);
  assert.deepEqual(Object.keys(f.reg.chats),[uuid]);
  assert.equal(f.reg.chats[uuid].status,'active');assert.equal(f.reg.chats[uuid].url,permanent);
  const delivery=f.printed[0].delivery;
  assert.equal(delivery.delivered,true);assert.equal(delivery.lastUserId,messageId);
  assert.equal(delivery.nativeWitness.bodyHash,sha(request));
  assert.equal(delivery.nativeWitness.conversationId,uuid);
  assert.equal(delivery.nativeWitness.sourceConversationId,temporary);
});

test('a permanent URL plus temporary source without a prior temporary-stage proof stays unconfirmed and unregistered',async()=>{
  const f=fixture(x=>x.skipTemporary=true);
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),e=>e.code==='DELIVERY_UNCONFIRMED'));
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);assert.deepEqual(f.reg.chats,{});
  assert.equal(f.closed,0);
});

test('owned source still rejects arbitrary controls, skipped content, foreign owner, split tuple and wrong body',async()=>{
  for(const change of [
    f=>f.copy.attrs['aria-label']='Run',
    f=>f.copy.attrs['data-thread-find-skip']='true',
    f=>f.copyFrames[4].memoizedProps.messageId='foreign-copy-owner',
    f=>f.copyFrames[16].return={memoizedProps:{...f.source},return:null},
    f=>f.copyFrames[9].memoizedProps={},
    f=>f.frames[15].memoizedProps={...f.source},
    f=>f.source.copyPlainTextFromSource=false,
    f=>f.source.messageId='foreign-message-owner',
    f=>delete f.source.conversationId,
    f=>f.source.message=request+' wrong native footer'
  ]){
    const f=fixture(change);
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),e=>e.code==='DELIVERY_UNCONFIRMED'));
    assert.equal(f.sends,1);assert.equal(f.persisted.length,0);assert.deepEqual(f.reg.chats,{});
  }
});

test('mapped delivery rejects changed message, exact body, temporary CID, Project, old ID, non-UUID URL and stale witness',async()=>{
  const oldId='44444444-4444-4444-8444-444444444444';
  const variants=[
    f=>{f.source.messageId=oldId;f.unit.attrs['data-chatgpt-search-message-ids']=oldId;},
    f=>f.source.message=request+' changed footer',
    f=>{f.source.conversationId='local-chatgpt:'+oldId;f.frames[10].memoizedProps.conversationId=f.source.conversationId;},
    f=>f.url=permanent.replace(project,'g-p-'+'b'.repeat(32)),
    f=>{f.source.messageId=oldId;f.unit.attrs['data-chatgpt-search-message-ids']=oldId;},
    f=>f.url=home.replace('/project','/c/not-a-persistent-uuid'),
    f=>f.now+=16000
  ];
  for(let i=0;i<variants.length;i++){
    const f=fixture(x=>{if(i===4)x.beforeUserId=oldId;x.onPoll=value=>{if(value.polls>=2)variants[i](value);};});
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),e=>e.code==='DELIVERY_UNCONFIRMED'));
    assert.ok(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),'valid temporary source was actually observed');
    assert.equal(f.sends,1);assert.equal(f.persisted.length,0);assert.deepEqual(f.reg.chats,{});
  }
});

test('temporary source conflict remains unconfirmed after the original tuple reappears',async()=>{
  const other='local-chatgpt:44444444-4444-4444-8444-444444444444';
  const f=fixture(x=>x.onPoll=value=>{
    value.source.conversationId=value.polls===2?other:temporary;
    value.frames[10].memoizedProps.conversationId=value.source.conversationId;
  });
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),e=>{
    assert.equal(e.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');
    assert.equal(e.nativeWitness.postSend.sourceCondition,'BOUND_SOURCE');return e.code==='DELIVERY_UNCONFIRMED';
  }));
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
});

test('source upgrading to the real persistent CID confirms through the existing direct source proof',async()=>{
  const f=fixture(x=>x.onPoll=value=>{if(value.polls>=2){value.source.conversationId=uuid;value.frames[10].memoizedProps.conversationId=uuid;}});
  await inBrowser(f,async({runNew})=>runNew());
  assert.equal(f.sends,1);assert.equal(f.persisted.length,1);
  assert.equal(f.printed[0].delivery.nativeWitness.sourceConversationId,uuid);
  assert.equal(f.printed[0].delivery.nativeWitness.conversationId,uuid);
});

test('new registration rejects a later URL change and preserves the confirmed first-send witness on the error',async()=>{
  const f=fixture(x=>x.page.waitForURL=async()=>{x.url=permanent.replace(uuid,'55555555-5555-4555-8555-555555555555');});
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
    assert.equal(error.code,'NEW_CONVERSATION_CHANGED_BEFORE_REGISTRATION');
    assert.equal(error.nativeWitness.messageId,messageId);
    assert.equal(error.nativeWitness.postSend.afterUrl,permanent);
    assert.equal(error.nativeWitness.postSend.phase,'NEW_SESSION_REGISTRATION');return true;
  }));
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);assert.deepEqual(f.reg.chats,{});
});

test('malformed source CID cannot create a temporary continuity proof',async()=>{
  const f=fixture();f.sends=1;f.url=permanent;
  await inBrowser(f,async({state,nativeSubmissionWitness,captureNewConversationSource})=>{
    const witness=await nativeSubmissionWitness(f.page,request,'verified-user');
    witness.url=home;
    const before={url:home,targetUrl:home,expectedMessage:request,expectedIdentity:'verified-user',nativeWitness:witness,userMessageIds:[]};
    const after=await state(f.page,'ids');
    after.lastUserSource.conversationId=null;
    captureNewConversationSource(before,after);
    assert.equal(before.nativeSourceContinuity,undefined);
  });
});
