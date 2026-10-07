import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile,mkdtemp,mkdir,writeFile,readdir,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

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
    return [...part.matchAll(/\[([^\s=$\]^]+)(\$?=)?"?([^"\]]*)"?\]/g)].every(([,key,op,value])=>
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
  const form=root.append(new Element('FORM'));form.append(composer);
  form.__reactFiber$editor={memoizedProps:{onSubmit:new Function('return e=>{eg(j.getText(),e)}')()},memoizedState:{memoizedState:{deps:[null,editor]}}};
  const send=new Element('BUTTON',{'data-testid':'send-button'}), f={root,unit,bubble,outer,copy,frames,copyFrames,composer,editor,source:frames[14].memoizedProps,url:home,sends:0,polls:0,persisted:[],printed:[],closed:0,now:Date.now(),trace:[],skipTemporary:false};
  f.reg={accounts:{a:{identity:'verified-user'}},projects:{P:{activeAccount:'a',bindings:{a:{projectUrl:home,projectId:project}}}},chats:{}};
  f.binding=f.reg.projects.P.bindings.a;
  f.document={title:'Canary',visibilityState:'visible',body:root,querySelector(selector){
    if(selector==='main'||selector==='[role="main"]')return root;
    if(selector==='form')return form;
    if(selector.includes('contenteditable="true"'))return composer;
    if(selector==='button[data-testid="send-button"]')return send;
    return null;
  },querySelectorAll(selector){
    if(selector.includes('contenteditable="true"'))return [composer];
    if(selector==='[data-message-author-role]')return [];
    if(selector.includes('[data-chatgpt-search-unit-key')||selector.includes('[data-content-search-unit-key'))return f.sends||f.beforeUserId?[unit].filter(node=>node.matches(selector)):[];
    if(selector==='button')return [...(f.sends?[copy]:[send]),...(f.busy?[new Element('BUTTON',{'data-testid':'stop-button','aria-label':'Stop generating'})]:[])];
    if(selector==='input[type="file"]'&&f.attachment)return [{files:[{name:'synthetic.pdf'}]}];
    if(selector.includes('[role="alert"]')&&(f.approval||f.errorText))return [root.append(new Element('DIV',{},f.errorText||'Codex Tasks\nAllow ChatGPT to use Codex Tasks?'))];
    return [];
  }};
  f.page={label:'p-test',spaceId:2,url:async()=>f.url,goto:async url=>{f.url=url;},waitForSelector:async()=>{},reload:async()=>{f.reloads=(f.reloads||0)+1;f.onReload?.(f);},waitForFunction:async()=>{},fill:async(_selector,text)=>{assert.equal(text,request);composer.innerText=composer.textContent=text;},
    waitForTimeout:async ms=>{f.now+=ms;if(f.sends&&ms>=150){f.polls++;f.url=f.skipTemporary||f.polls>=2?permanent:transient;f.onPoll?.(f);}},
    waitForURL:async re=>assert.match(f.url,re),close:async()=>{f.closed++;},
    click:async selector=>{assert.equal(selector,'button[data-testid="send-button"]');f.sends++;unit.attrs['data-chatgpt-search-message-ids']=messageId;composer.innerText=composer.textContent='';f.url=f.skipTemporary?permanent:transient;},
    evaluate:async(fn,...args)=>{
      assert.ok(args.length<=1,'evaluate has exactly zero or one JSON argument');
      const arg=args.length?JSON.parse(JSON.stringify(args[0])):undefined;
      const value=await fn(...(args.length?[arg]:[]));
      if(value&&typeof value==='object'&&'lastUserSource'in value){f.trace.push(JSON.parse(JSON.stringify(value)));f.onStateReturn?.(f,value);}
      return value;
    }};
  change(f);if(f.beforeUserId)unit.attrs['data-chatgpt-search-message-ids']=f.beforeUserId;return f;
}

async function inBrowser(f,fn){
  const globals={document:f.document,location:{get href(){return f.url;},get origin(){return new URL(f.url).origin;},get pathname(){return new URL(f.url).pathname;}},
    navigator:{get onLine(){return f.online!==false;}},MutationObserver:class{observe(){}disconnect(){}},Node:{ELEMENT_NODE:1},
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    fetch:async()=>{f.authCalls=(f.authCalls||0)+1;f.onAuth?.(f,f.authCalls);return {ok:true,json:async()=>({user:{id:f.login||'verified-user'}})};},
    __CHAT_BRIDGE_ARGS__:['new','--project','P','--account','a','--role','canary','--name','canary','--message',request,'--strict-model'],
    ...(f.attempt?{__CHAT_BRIDGE_DELIVERY_ATTEMPT__:f.attempt.descriptor,
      __CHAT_BRIDGE_STATE_DIR__:f.attempt.state,
      __CHAT_BRIDGE_COORDINATOR_PATH__:fileURLToPath(new URL('../src/coordinator.py',import.meta.url))}:{})};
  const prior=new Map(Object.keys(globals).concat('__CHAT_BRIDGE_WATCH').map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  const now=Date.now;
  try{
    for(const [k,value]of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value});
    delete globalThis.__CHAT_BRIDGE_WATCH;Date.now=()=>f.now;
    const setup=[
      'const reg=f.reg;',
      'stored=(command,kind)=>{if(command!=="peek"||!["registry","runtime"].includes(kind))throw Error("TEST_UNEXPECTED_STORE");return structuredClone(kind==="registry"?f.reg:f.runtime||{sessions:{},tasks:{}});};',
      'loadRuntime=async()=>{f.onRuntime?.(f);return structuredClone(f.runtime||{sessions:{},tasks:{}});};',
      'coordinated=(command,context)=>{if(command==="image-session-occupancy")return {occupied:!!f.imageOccupied};if(command==="admission-check")return {ok:true,control:{mode:f.paused?"PAUSED":"RUNNING"}};if(!f.attempt||command!=="delivery-admission"||context.operationId!==f.attempt.descriptor.operationId)throw new Error("TEST_UNEXPECTED_ADMISSION"); f.admissions=(f.admissions||0)+1;if(f.denyAdmission)throw new Error("DELIVERY_ATTEMPT_NO_LONGER_CURRENT");return {ok:true};};',
      'assertImagePageFree=async()=>{if(f.imageOccupied)throw Error("IMAGE_SESSION_OCCUPIED_RECONCILE_ONLY");};',
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
  await inBrowser(f,async({state,runNew})=>{assert.equal((await state(f.page)).composerAttachmentsEmpty,true);await runNew();});
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

test('new retains real creation proof and shared send advances the same native alias through fresh user IDs',async()=>{
  const f=fixture();
  await inBrowser(f,async({runNew})=>{
    await runNew();
    assert.deepEqual(f.reg.chats[uuid].nativeCreationWitness,{...f.printed[0].delivery.nativeWitness,project:'P',account:'a'});
  });
  f.skipTemporary=true;
  const click=f.page.click;
  for(const nextId of ['55555555-5555-4555-8555-555555555555','66666666-6666-4666-8666-666666666666']){
    f.reg=JSON.parse(JSON.stringify(f.persisted.at(-1)));
    await inBrowser(f,async({sendMessage})=>{
      f.page.click=async selector=>{await click(selector);f.source.messageId=nextId;f.unit.attrs['data-chatgpt-search-message-ids']=nextId;};
      const delivery=await sendMessage(f.page,request,permanent);
      assert.equal(delivery.nativeWitness.sourceBinding?.format,'registered-temporary-conversation-v1');
      assert.equal(delivery.nativeWitness.sourceBinding.creationMessageId,messageId);
      assert.equal(delivery.nativeWitness.messageId,nextId);
      assert.equal(f.reg.chats[uuid].nativeLastWitness.messageId,nextId);
    });
  }
  assert.equal(f.sends,3);
});

test('persistent-start alias rejects absent or changed creation, scope, prior UID, body, getter and fresh source',async()=>{
  const variants=[
    f=>delete f.reg.chats[uuid].nativeCreationWitness,
    f=>f.reg.chats[uuid].nativeCreationWitness.sourceBinding.format='invented',
    f=>f.reg.chats[uuid].nativeCreationWitness.sourceBinding.messageId='foreign',
    f=>f.reg.chats[uuid].nativeCreationWitness.sourceBinding.bodyHash='f'.repeat(64),
    f=>f.reg.chats[uuid].nativeCreationWitness.accountIdentityHash='f'.repeat(64),
    f=>f.reg.chats[uuid].nativeCreationWitness.getterHash='f'.repeat(64),
    f=>f.reg.chats[uuid].nativeCreationWitness.serializerHash='f'.repeat(64),
    f=>{f.reg.accounts.alias={identity:'verified-user'};f.reg.projects.P.bindings.alias=f.binding;f.reg.chats[uuid].account='alias';},
    f=>{f.reg.projects.alias={bindings:{a:f.binding}};f.reg.chats[uuid].project='alias';},
    f=>f.reg.chats[uuid].nativeCreationWitness.sourceBinding.persistentUrl=permanent.replace(project,'g-p-'+'b'.repeat(32)),
    f=>f.reg.chats[uuid].nativeCreationWitness.sourceBinding.temporaryUrl=transient.replace(encodeURIComponent(temporary),'local-chatgpt%3A44444444-4444-4444-8444-444444444444'),
    f=>f.reg.chats[uuid].account='foreign',
    f=>f.reg.chats[uuid].project='foreign',
    f=>f.reg.chats[uuid].status='pending-rotation',
    f=>{f.source.messageId='44444444-4444-4444-8444-444444444444';f.unit.attrs['data-chatgpt-search-message-ids']=f.source.messageId;},
    f=>f.source.message=request+' changed prior full body',
    f=>f.frames[15].memoizedProps={...f.source},
    f=>f.onPoll=value=>{value.source.message=request+' changed current full body';},
    f=>f.onPoll=value=>{value.source.conversationId='local-chatgpt:44444444-4444-4444-8444-444444444444';value.frames[10].memoizedProps.conversationId=value.source.conversationId;},
    f=>f.onPoll=value=>{value.url=permanent.replace(uuid,'77777777-7777-4777-8777-777777777777');},
    f=>f.onPoll=value=>{value.now+=16000;}
  ];
  for(const change of variants){
    const f=fixture();
    await inBrowser(f,async({runNew,sendMessage})=>{
      await runNew();f.skipTemporary=true;change(f);
      const saved=structuredClone(f.reg),click=f.page.click;
      f.page.click=async selector=>{await click(selector);f.source.messageId='55555555-5555-4555-8555-555555555555';f.unit.attrs['data-chatgpt-search-message-ids']=f.source.messageId;};
      await assert.rejects(sendMessage(f.page,request,permanent),/DELIVERY_UNCONFIRMED|TARGET_IDENTITY_UNVERIFIED|NATIVE_EXISTING_SOURCE_UNVERIFIED/);
      assert.deepEqual(f.reg,saved,'rejection never manufactures or advances native proof');
    });
    assert.ok(f.sends<=2);
  }
});

test('registered native alias does not wash away a current source contradiction when the expected tuple returns',async()=>{
  for(const fault of ['body','alias','owner','url']){
    const f=fixture();
    await inBrowser(f,async({runNew,sendMessage})=>{
      await runNew();f.skipTemporary=true;
      const click=f.page.click;
      f.page.click=async selector=>{await click(selector);f.source.messageId='55555555-5555-4555-8555-555555555555';f.unit.attrs['data-chatgpt-search-message-ids']=f.source.messageId;};
      f.onPoll=value=>{
        const bad=value.polls===3;
        value.source.message=bad&&fault==='body'?request+' foreign body':request;
        value.source.conversationId=bad&&fault==='alias'?'local-chatgpt:44444444-4444-4444-8444-444444444444':temporary;
        value.frames[10].memoizedProps.conversationId=value.source.conversationId;
        value.frames[15].memoizedProps=bad&&fault==='owner'?{...value.source}:{};
        value.url=bad&&fault==='url'?permanent.replace(uuid,'77777777-7777-4777-8777-777777777777'):permanent;
      };
      await assert.rejects(sendMessage(f.page,request,permanent),error=>{
        assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');return true;
      });
      assert.equal(f.reg.chats[uuid].nativeLastWitness,undefined);
    });
    assert.equal(f.sends,2);
  }
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

for(const gap of ['message-unmounted','fiber-not-ready'])test('qualified temporary anchor survives '+gap+' without creating or replacing a proof',async()=>{
  const f=fixture(x=>{
    const query=x.document.querySelectorAll;
    if(gap==='message-unmounted')x.document.querySelectorAll=selector=>x.polls===2&&
      (selector.includes('[data-chatgpt-search-unit-key')||selector.includes('[data-content-search-unit-key'))?[]:query(selector);
    else x.onPoll=value=>{value.outer.__reactFiber$fixture=value.polls===2?null:value.frames[0];};
  });
  let failure;
  await inBrowser(f,async({runNew})=>{try{await runNew();}catch(error){failure=error;}});
  const anchor=f.trace.find(s=>s.url===transient&&s.lastUserSource?.messageId===messageId);
  const absent=f.trace.find(s=>s.url===permanent&&s.lastUserSource===null&&
    (gap==='message-unmounted'?s.lastUserId===null:s.lastUserSourceCondition==='SOURCE_OWNER_NOT_FOUND'));
  assert.ok(anchor,'a qualified temporary source precedes the gap');
  assert.ok(absent,'the actual state getter observed the intended absent source');
  if(failure)throw failure;
  assert.equal(f.sends,1);assert.equal(f.persisted.length,1);
  const binding=f.printed[0].delivery.nativeWitness.sourceBinding;
  assert.equal(binding.sourceConversationId,temporary);
  assert.equal(binding.temporaryObservedAt,anchor.observedAt);
  assert.equal(binding.firstGap?.reason,'SOURCE_ABSENT');
  assert.equal(binding.firstGap?.observedAt,absent.observedAt);
});

test('ambiguous or foreign source during migration remains a conflict after the original tuple returns',async()=>{
  const conditions={'duplicate-owner':'SOURCE_OWNER_AMBIGUOUS','foreign-owner':'FOREIGN_MESSAGE_OWNER','ambiguous-message-id':'MESSAGE_ID_AMBIGUOUS'};
  for(const fault of Object.keys(conditions)){
    const f=fixture(x=>x.onPoll=value=>{
      value.frames[15].memoizedProps=value.polls===2&&fault==='duplicate-owner'?{...value.source}:{};
      value.frames[3].memoizedProps=value.polls===2&&fault==='foreign-owner'?{messageId:'foreign-owner'}:{};
      value.unit.attrs['data-chatgpt-search-message-ids']=value.polls===2&&fault==='ambiguous-message-id'?messageId+' another-user':messageId;
    });
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
      assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');
      assert.equal(error.nativeWitness.postSend.temporarySourceProof,null);
      assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.reason,'SOURCE_UNVERIFIED');
      assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.sourceCondition,conditions[fault]);
      return error.code==='DELIVERY_UNCONFIRMED';
    }));
    assert.ok(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),'qualified temporary source was observed');
    assert.ok(f.trace.some(s=>s.lastUserSource===null&&s.lastUserSourceCondition===conditions[fault]),'the exact source conflict was observed');
    assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
  }
});

test('a changed exact body cannot be washed away by a later valid direct persistent source',async()=>{
  const f=fixture(x=>x.onPoll=value=>{
    value.source.message=value.polls===2?request+' altered footer':request;
    if(value.polls>=3){value.source.conversationId=uuid;value.frames[10].memoizedProps.conversationId=uuid;}
  });
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
    const conflict=error.nativeWitness.postSend.temporarySourceFirstConflict;
    assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');
    assert.equal(conflict?.reason,'SOURCE_BODY_CHANGED');
    assert.equal(conflict?.sourceBodyHash,sha(request+' altered footer'));
    assert.equal(JSON.stringify(conflict).includes('altered footer'),false);
    return error.code==='DELIVERY_UNCONFIRMED';
  }));
  assert.ok(f.trace.some(s=>s.lastUserSource?.conversationId===uuid&&s.lastUserSource?.text===request),'later direct source was actually valid');
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
});

test('a different permanent CID observed during a source gap is never adopted after recovery',async()=>{
  const other='55555555-5555-4555-8555-555555555555';
  const f=fixture(x=>{
    const query=x.document.querySelectorAll;
    x.document.querySelectorAll=selector=>x.polls===2&&
      (selector.includes('[data-chatgpt-search-unit-key')||selector.includes('[data-content-search-unit-key'))?[]:query(selector);
    x.onPoll=value=>{if(value.polls>=3)value.url=permanent.replace(uuid,other);};
  });
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
    assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.reason,'PERSISTENT_CONVERSATION_CHANGED');
    return error.code==='DELIVERY_UNCONFIRMED';
  }));
  assert.ok(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),'qualified temporary source was observed');
  assert.ok(f.trace.some(s=>s.url===permanent&&s.lastUserSource===null&&s.lastUserId===null),'the first permanent CID was observed during a real source gap');
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
});

test('a different temporary CID observed during a source gap remains a conflict after recovery',async()=>{
  const other='local-chatgpt:66666666-6666-4666-8666-666666666666';
  const changed=transient.replace(encodeURIComponent(temporary),encodeURIComponent(other));
  const f=fixture(x=>{
    const query=x.document.querySelectorAll;
    x.document.querySelectorAll=selector=>x.polls===2&&
      (selector.includes('[data-chatgpt-search-unit-key')||selector.includes('[data-content-search-unit-key'))?[]:query(selector);
    x.onPoll=value=>{if(value.polls===2)value.url=changed;};
  });
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
    assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');
    assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.reason,'SOURCE_CONVERSATION_CHANGED');
    assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.url,changed);
    return error.code==='DELIVERY_UNCONFIRMED';
  }));
  assert.ok(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),'qualified original temporary source was observed');
  assert.ok(f.trace.some(s=>s.url===changed&&s.lastUserSource===null&&s.lastUserId===null),'different temporary URL was observed during a real source gap');
  assert.ok(f.trace.some(s=>s.url===permanent&&s.lastUserSource?.conversationId===temporary),'original source returned on the final permanent URL');
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
});

test('qualified temporary anchor survives unavailable Copy ownership until complete owned source returns',async()=>{
  const f=fixture(x=>x.onPoll=value=>{
    value.copy.__reactFiber$fixture=value.polls===2?null:value.copyFrames[0];
  });
  let failure;
  await inBrowser(f,async({runNew})=>{try{await runNew();}catch(error){failure=error;}});
  const anchor=f.trace.find(s=>s.url===transient&&s.lastUserSource?.messageId===messageId);
  const absent=f.trace.find(s=>s.url===permanent&&s.lastUserSource===null&&s.lastUserSourceCondition==='UNOWNED_COPY_CONTROL');
  assert.ok(anchor,'qualified temporary source precedes unavailable Copy ownership');
  assert.ok(absent,'actual state getter observed the unavailable Copy fiber');
  assert.ok(f.trace.some(s=>s.url===permanent&&s.lastUserSourceCondition==='BOUND_SOURCE'&&s.lastUserSource?.text===request),'complete owned source returned');
  if(failure)throw failure;
  assert.equal(f.sends,1);assert.equal(f.persisted.length,1);
  const binding=f.printed[0].delivery.nativeWitness.sourceBinding;
  assert.equal(binding.temporaryObservedAt,anchor.observedAt);
  assert.equal(binding.firstGap?.sourceCondition,'UNOWNED_COPY_CONTROL');
  assert.equal(binding.firstGap?.observedAt,absent.observedAt);
});

test('a foreign Copy owner stays contradictory after complete direct source ownership returns',async()=>{
  const f=fixture(x=>x.onPoll=value=>{
    value.copyFrames[4].memoizedProps=value.polls===2?{messageId:'foreign-copy-owner'}:{};
    if(value.polls>=3){value.source.conversationId=uuid;value.frames[10].memoizedProps.conversationId=uuid;}
  });
  await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
    assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT');
    assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.reason,'SOURCE_UNVERIFIED');
    assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict?.sourceCondition,'FOREIGN_COPY_OWNER');
    return error.code==='DELIVERY_UNCONFIRMED';
  }));
  assert.ok(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),'qualified temporary source was observed');
  assert.ok(f.trace.some(s=>s.lastUserSource===null&&s.lastUserSourceCondition==='FOREIGN_COPY_OWNER'),'actual foreign Copy owner was observed');
  assert.ok(f.trace.some(s=>s.lastUserSource?.conversationId===uuid&&s.lastUserSource?.text===request),'later direct owned source was observed');
  assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
});

test('permanently unowned Copy source remains unconfirmed with or without an earlier qualified anchor',async()=>{
  for(const missingAtStart of [false,true]){
    const f=fixture(x=>x.onPoll=value=>{
      value.copy.__reactFiber$fixture=missingAtStart||value.polls>=2?null:value.copyFrames[0];
    });
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),error=>{
      assert.equal(error.nativeWitness.postSend.missingCondition,'NATIVE_SOURCE_MESSAGE_ID_MISSING');
      assert.equal(error.nativeWitness.postSend.sourceCondition,'UNOWNED_COPY_CONTROL');
      assert.equal(error.nativeWitness.postSend.temporarySourceProof,null);
      assert.equal(error.nativeWitness.postSend.temporarySourceFirstConflict,null);
      if(missingAtStart)assert.equal(error.nativeWitness.postSend.temporarySourceFirstGap,null);
      else assert.equal(error.nativeWitness.postSend.temporarySourceFirstGap?.sourceCondition,'UNOWNED_COPY_CONTROL');
      return error.code==='DELIVERY_UNCONFIRMED';
    }));
    assert.equal(f.trace.some(s=>s.url===transient&&s.lastUserSource?.messageId===messageId),!missingAtStart,'anchor requirement is unchanged');
    assert.equal(f.sends,1);assert.equal(f.persisted.length,0);assert.deepEqual(f.reg.chats,{});
  }
});


async function journalFixture(){
  const state=await realpath(await mkdtemp(path.join(os.tmpdir(),'bridge-send-journal-')));
  const op='77777777-7777-4777-8777-777777777777',directory=path.join(state,'delivery-attempts',op,'1');
  await mkdir(directory,{recursive:true,mode:0o700});
  const manifest={format:'chat-bridge-delivery-attempt-v1',operationId:op,claimOrdinal:1,
    messageSha256:sha(request),project:'P',account:'a',sessionRef:null};
  const raw=JSON.stringify(manifest)+'\n';await writeFile(path.join(directory,'manifest.json'),raw,{mode:0o600});
  return {state,directory,descriptor:{format:manifest.format,operationId:op,claimOrdinal:1,directory,manifestSha256:sha(raw)}};
}

test('actual native send persists original baseline, intent and source before a final receipt exists',async()=>{
  const journal=await journalFixture();
  try{
    const f=fixture(x=>x.attempt=journal);await inBrowser(f,async({runNew})=>runNew());
    assert.equal(f.sends,1);assert.equal(f.admissions,1);
    const files=await readdir(journal.directory);
    for(const name of ['10-TARGET_OBSERVED.json','20-BEFORE_INPUT.json','30-INPUT_VERIFIED.json','40-SEND_INTENT.json','50-SEND_RETURNED.json','70-DELIVERY_CONFIRMED.json'])assert.ok(files.includes(name),name);
    const verified=JSON.parse(await readFile(path.join(journal.directory,'30-INPUT_VERIFIED.json'),'utf8'));
    assert.equal(verified.data.nativeBody,request);assert.equal(verified.data.nativeWitness.bodyHash,sha(request));
    const samples=await Promise.all(files.filter(n=>n.includes('-OBSERVED-')).map(async n=>JSON.parse(await readFile(path.join(journal.directory,n),'utf8'))));
    assert.ok(samples.some(x=>x.data.snapshot.lastUserId===messageId&&x.data.snapshot.lastUserSource.text===request));
    assert.ok(samples.some(x=>x.data.snapshot.url===permanent));
    const repeat=fixture(x=>x.attempt=journal);
    await inBrowser(repeat,async({runNew})=>assert.rejects(runNew(),/EEXIST/));
    assert.equal(repeat.sends,0,'same persisted claim does not trigger another Send');
    assert.equal(repeat.closed,0,'an uncertain prior send never licenses closing its page');
  }finally{await rm(journal.state,{recursive:true,force:true});}
});

test('current-claim admission refusal stops the native send and retains the original input evidence',async()=>{
  const journal=await journalFixture();
  try{
    const f=fixture(x=>{x.attempt=journal;x.denyAdmission=true;});
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),/NO_LONGER_CURRENT/));
    assert.equal(f.sends,0);assert.equal(f.admissions,1);
    const files=await readdir(journal.directory);assert.ok(files.includes('30-INPUT_VERIFIED.json'));assert.ok(!files.includes('40-SEND_INTENT.json'));
  }finally{await rm(journal.state,{recursive:true,force:true});}
});

test('unconfirmed persistent URL with temporary source keeps full evidence without registering or resending',async()=>{
  const journal=await journalFixture();
  try{
    const f=fixture(x=>{x.attempt=journal;x.skipTemporary=true;});
    await inBrowser(f,async({runNew})=>assert.rejects(runNew(),e=>e.code==='DELIVERY_UNCONFIRMED'));
    assert.equal(f.sends,1);assert.equal(f.persisted.length,0);
    const saved=JSON.parse(await readFile(path.join(journal.directory,'90-ERROR.json'),'utf8'));
    assert.equal(saved.data.nativeWitness.postSend.lastUserId,messageId);
    assert.equal(saved.data.nativeWitness.postSend.afterUrl,permanent);
    assert.equal(saved.data.nativeWitness.postSend.sourceConversationId,temporary);
    assert.equal(saved.data.nativeWitness.postSend.missingCondition,'NATIVE_TEMPORARY_SOURCE_PROOF_MISSING');
  }finally{await rm(journal.state,{recursive:true,force:true});}
});

test('existing persistent temporary source recovers before input or stops before physical Send',async()=>{
  for(const recovers of [true,false]){
    const oldId='77777777-7777-4777-8777-777777777777';
    const f=fixture(x=>{
      x.skipTemporary=true;x.url=permanent;x.beforeUserId=oldId;x.source.messageId=oldId;
      x.reg.chats[uuid]={id:uuid,status:'active',project:'P',account:'a',url:permanent};
    });
    const originalClick=f.page.click,originalFill=f.page.fill;
    f.fills=0;f.reloads=0;
    f.page.fill=async(...args)=>{f.fills++;await originalFill(...args);};
    f.page.click=async selector=>{await originalClick(selector);f.source.messageId=messageId;};
    f.page.reload=async()=>{
      assert.equal(f.fills,0);assert.equal(f.sends,0);f.reloads++;
      if(recovers){f.source.conversationId=uuid;f.frames[10].memoizedProps.conversationId=uuid;}
    };
    f.page.waitForFunction=async()=>{};
    const saved=structuredClone(f.reg);
    await inBrowser(f,async({sendMessage})=>{
      if(recovers)assert.equal((await sendMessage(f.page,request,permanent)).delivered,true);
      else await assert.rejects(sendMessage(f.page,request,permanent),e=>e.deliveryStage==='PRE_SEND'&&e.code==='NATIVE_EXISTING_SOURCE_UNVERIFIED');
    });
    assert.equal(f.reloads,1);assert.equal(f.sends,recovers?1:0);assert.equal(f.fills,recovers?1:0);
    assert.equal(f.closed,0);assert.deepEqual(f.reg,saved);assert.equal(f.persisted.length,0);
  }
});

function existingFixture(){
  const oldId='77777777-7777-4777-8777-777777777777';
  const f=fixture(x=>{x.skipTemporary=true;x.url=permanent;x.beforeUserId=oldId;x.source.messageId=oldId;
    x.reg.chats[uuid]={id:uuid,status:'active',project:'P',account:'a',url:permanent};});
  const fill=f.page.fill,click=f.page.click;f.fills=0;
  f.page.fill=async(...args)=>{f.beforeInputStateCount=f.trace.length;f.fills++;await fill(...args);};
  f.page.click=async selector=>{await click(selector);f.source.messageId=messageId;};
  f.onReload=x=>{x.source.conversationId=uuid;x.frames[10].memoizedProps.conversationId=uuid;};
  return f;
}

test('existing source recovery fails closed on missing proof, controls and changed after-reload scope/body/UI',async()=>{
  const cases=[
    [false,f=>{f.copy.__reactFiber$fixture=null;}],
    [false,f=>{f.paused=true;}],
    [false,f=>{f.runtime={sessions:{[uuid]:{watchdogPausedForUserControl:true}}};}],
    [false,f=>{f.online=false;}],
    [false,f=>{f.busy=true;}],
    [false,f=>{f.approval=true;}],
    [false,f=>{f.composer.textContent='protected draft';}],
    [false,f=>{f.attachment=true;}],
    [false,f=>{f.imageOccupied=true;}],
    [false,f=>{f.errorText='Conversation reached maximum limit';}],
    [true,f=>{f.login='foreign';}],
    [true,f=>{f.url=permanent.replace(uuid,'88888888-8888-4888-8888-888888888888');}],
    [true,f=>{for(const n of [10,13,14])f.frames[n].memoizedProps.message=request+' ';}],
    [true,f=>{f.source.messageId='88888888-8888-4888-8888-888888888888';f.unit.attrs['data-chatgpt-search-message-ids']=f.source.messageId;}],
    [true,f=>{f.source.conversationId='88888888-8888-4888-8888-888888888888';f.frames[10].memoizedProps.conversationId=f.source.conversationId;}],
    [true,f=>{f.reg.chats[uuid].role='changed concurrently';}],
    [true,f=>{f.busy=true;}],
    [true,f=>{f.approval=true;}],
    [true,f=>{f.composer.textContent='new draft';}],
    [true,f=>{f.attachment=true;}],
    [true,f=>{f.imageOccupied=true;}],
    [true,f=>{f.errorText='Unable to load conversation';}],
    [true,f=>{f.composer.closest('form').__reactFiber$editor.memoizedProps.onSubmit=()=>{};}],
    [true,()=>{throw Error('synthetic reload failed');}]
  ];
  for(const [afterReload,change] of cases){
    const f=existingFixture();if(afterReload){const settle=f.onReload;f.onReload=x=>{settle(x);change(x);};}else change(f);
    await inBrowser(f,async({sendMessage})=>assert.rejects(sendMessage(f.page,request,permanent),e=>e.deliveryStage==='PRE_SEND',String(change)));
    assert.equal(f.reloads||0,afterReload?1:0);assert.equal(f.fills,0);assert.equal(f.sends,0);
    assert.equal(f.closed,0);assert.equal(f.persisted.length,0);
  }
});

test('normal same-claim journal retains full source before reload and the fresh direct baseline before input',async()=>{
  const journal=await journalFixture();
  try{
    const f=existingFixture();f.attempt=journal;
    await inBrowser(f,async({sendMessage})=>assert.equal((await sendMessage(f.page,request,permanent)).delivered,true));
    assert.equal(f.reloads,1);assert.equal(f.fills,1);assert.equal(f.sends,1);
    const names=await readdir(journal.directory),samples=await Promise.all(names.filter(n=>n.includes('-OBSERVED-')).map(async n=>JSON.parse(await readFile(path.join(journal.directory,n)))));
    const intent=samples.find(x=>x.data.stage==='SOURCE_SETTLING_RELOAD_INTENT'),settled=samples.find(x=>x.data.stage==='SOURCE_SETTLING_RELOAD_RETURNED');
    assert.equal(intent.data.snapshot.lastUserSource.text,request);assert.equal(intent.data.snapshot.lastUserSource.conversationId,temporary);
    assert.equal(settled.data.snapshot.lastUserSource.text,request);assert.equal(settled.data.snapshot.lastUserSource.conversationId,uuid);
    const baseline=JSON.parse(await readFile(path.join(journal.directory,'20-BEFORE_INPUT.json')));
    assert.equal(baseline.data.snapshot.lastUserId,intent.data.snapshot.lastUserId);
    assert.equal(baseline.data.snapshot.lastUserSource.conversationId,uuid);assert.ok(!f.reg.chats[uuid].nativeCreationWitness);
  }finally{await rm(journal.state,{recursive:true,force:true});}
});

test('existing source recovery rechecks control, user pause and registry after final Auth before reload or input',async()=>{
  for(const authNumber of [5,8])for(const change of [f=>{f.paused=true;},f=>{f.runtime={sessions:{[uuid]:{watchdogPausedForUserControl:true}}};},
    f=>{f.reg.chats[uuid].role='changed during Auth';}]){
    const f=existingFixture();f.onAuth=(x,n)=>{if(n===authNumber)change(x);};
    await inBrowser(f,async({sendMessage})=>assert.rejects(sendMessage(f.page,request,permanent),e=>e.deliveryStage==='PRE_SEND'));
    assert.equal(f.reloads||0,authNumber===5?0:1);assert.equal(f.fills,0);assert.equal(f.sends,0);assert.equal(f.closed,0);assert.equal(f.persisted.length,0);
  }
});

test('final source guard resamples draft, prior UID/body and Image after its runtime wait',async()=>{
  for(const change of [f=>{f.composer.textContent='new draft';},f=>{for(const n of [10,13,14])f.frames[n].memoizedProps.message=request+' late body';},
    f=>{f.source.messageId='88888888-8888-4888-8888-888888888888';f.unit.attrs['data-chatgpt-search-message-ids']=f.source.messageId;},f=>{f.imageOccupied=true;}]){
    const f=existingFixture();let changed=false;f.onRuntime=x=>{if(!changed&&x.authCalls>=8){changed=true;change(x);}};
    await inBrowser(f,async({sendMessage})=>assert.rejects(sendMessage(f.page,request,permanent),e=>e.deliveryStage==='PRE_SEND'));
    assert.equal(changed,true);assert.equal(f.reloads,1);assert.equal(f.fills,0);assert.equal(f.sends,0);assert.equal(f.persisted.length,0);
  }
});

test('final source/UI return rechecks a user pause before input using the actual healthy boundary',async()=>{
  const probe=existingFixture();
  await inBrowser(probe,async({sendMessage})=>assert.equal((await sendMessage(probe.page,request,permanent)).delivered,true));
  const lastSample=probe.beforeInputStateCount;assert.ok(lastSample>0);
  const f=existingFixture();let injected=false;
  f.onStateReturn=x=>{if(x.trace.length===lastSample){x.runtime={sessions:{[uuid]:{watchdogPausedForUserControl:true}}};injected=true;}};
  await inBrowser(f,async({sendMessage})=>assert.rejects(sendMessage(f.page,request,permanent),e=>e.deliveryStage==='PRE_SEND'));
  assert.equal(injected,true);assert.equal(f.reloads,1);assert.equal(f.fills,0);assert.equal(f.sends,0);assert.equal(f.persisted.length,0);
});
