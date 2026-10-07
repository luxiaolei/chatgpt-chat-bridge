import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import('../src/'+file+'.js');
const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const prefix=main.split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const url='https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'/c/11111111-1111-4111-8111-111111111111';
const home=url.replace(/\/c\/[^/]+$/,'/project'), message='Complete synthetic request\nExact footer.';
const section=(start,end)=>main.slice(main.indexOf(start)+start.length,main.indexOf(end));
const modelBody=section('if(cmd==="model"){','\n  if(cmd==="effort"){').replace(/\n  }\s*$/,'');
const effortBody=section('if(cmd==="effort"){','\n  if(cmd==="stop")').replace(/\n  }\s*$/,'');
const newBody=section('else if(cmd==="new"){','\n}\nelse throw new Error("Unknown command:');
function node(text='',options={}) {
  const attrs=options.attrs||{};
  const item={innerText:text,textContent:text,disabled:!!options.disabled,parentElement:null,
    getAttribute:k=>attrs[k]??null,setAttribute:(k,v)=>{attrs[k]=v;},removeAttribute:k=>{delete attrs[k];},
    getClientRects:()=>options.hidden?[]:[{}],getBoundingClientRect:()=>({left:0,top:0,width:100,height:40}),
    closest:s=>s.includes('data-message')||s.includes('search-unit')?options.message||null:
      s.includes('nav')?options.sidebar||null:null,
    matches:s=>s==='main, [role="main"]'&&!!options.root,contains:n=>n===item||!!options.contains?.includes(n),
    querySelector:()=>options.containsMessage||null,querySelectorAll:()=>[]};
  return item;
}
function fixture(change={}) {
  const composer=node(change.raw??''), root=node('',{root:true}), form=node(), send=node('Send',{attrs:{'data-testid':'send-button'}});
  composer.closest=s=>s==='form'?form:null;
  if(change.unknownRaw)composer.textContent=undefined;
  const composers=change.count===0?[]:change.count===2?[composer,node('')]:[composer];
  const buttons=[send], calls=[], chat={id:'11111111-1111-4111-8111-111111111111',project:'P',account:'a',url,model:'Latest',effort:'High'};
  root.contains=n=>n===root||n===form||composers.includes(n)||buttons.includes(n);
  form.querySelectorAll=s=>s==='button'?buttons:change.attachment&&s.includes('Remove ')?[{}]:[];
  const f={composers,composer,root,buttons,calls,chat,currentUrl:url,login:change.nullLogin?null:change.login??'verified-user',change,closed:0,
    reg:{accounts:change.noIdentity?{}:{a:{identity:'verified-user'}},chats:{[chat.id]:chat},
      projects:{P:{activeAccount:'a',lifecycle:change.discard?{draftPolicy:'discard'}:{},bindings:{a:{projectUrl:home}}}}}};
  composer.outerHTML='<div id="prompt-textarea">'+(change.raw||'')+'</div>';form.outerHTML='<form>'+composer.outerHTML+'</form>';
  if(change.discard&&!change.plainComposer) {
    const doc={get content(){return {size:composer.textContent.length};},textBetween:()=>composer.innerText,
      toJSON:()=>({type:'doc',content:[{type:'paragraph',text:composer.textContent}]})};
    const getter='getText(){let e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:this.dictation.document;return(0,T.g)(e,this.plainTextMode?void 0:this.markdownEditor?.serialize)}';
    const editor={...new Function('T','return {'+getter+'};')({g:node=>node.textBetween()}),view:{dom:composer,state:{doc,tr:{delete:()=>{}}},composing:false},dictation:{document:doc},plainTextMode:false,markdownEditor:{serialize:node=>node.textBetween()}};
    editor.view.dispatch=()=>{calls.push('discard');if(change.clearFails)throw Error('uncertain native clear');if(!change.clearNotEmpty)composer.textContent=composer.innerText='';};
    composer.pmViewDesc={node:doc};composer.parentElement={__reactFiber$fixture:{memoizedProps:{onSubmit:new Function('return e=>{eg(j.getText(),e)}')()},memoizedState:{memoizedState:{deps:[editor]}}}};
    f.nativeDoc=doc;f.nativeEditor=editor;
  }
  f.document={title:'Synthetic',visibilityState:'visible',body:root,querySelector:s=>
    s==='main'||s==='[role="main"]'?root:s==='form'?form:
    s.includes('prompt-textarea')?composers[0]||null:s==='button[data-testid="send-button"]'?send:null,
    querySelectorAll:s=>s.includes('contenteditable="true"')?composers:s==='button'?buttons:[]};
  f.page={label:'synthetic',spaceId:2,url:async()=>f.currentUrl,goto:async u=>{f.currentUrl=u;},waitForSelector:async()=>{},
    fill:async(_s,text)=>{calls.push('fill');if(text===''&&change.clearNotEmpty)return;if(text===''&&change.clearFails)throw Error('uncertain clear');composer.textContent=composer.innerText=change.partialFill?'partial user content':change.emptyFill?'':text;if(change.loginAfterFill)f.login=change.loginAfterFill;if(change.fillFails)throw Error('fill transport failed');},
    keyboard:{press:async key=>calls.push('key:'+key),insertText:async text=>{calls.push('insert');composer.textContent=composer.innerText=text;}},
    focus:async()=>calls.push('focus'),waitForTimeout:async()=>{},close:async()=>{f.closed++;},
    click:async()=>{calls.push('send');composer.textContent=composer.innerText='';if(f.currentUrl===home)f.currentUrl=url;},waitForURL:async()=>{},
    evaluate:async(fn,arg)=>fn(arg)};
  return f;
}
async function run(f,fn) {
  const values={document:f.document,location:{get href(){return f.currentUrl;},get origin(){return new URL(f.currentUrl).origin;},get pathname(){return new URL(f.currentUrl).pathname;}},
    navigator:{onLine:true},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),
    MutationObserver:class{observe(){}disconnect(){}},Node:{ELEMENT_NODE:1},
    fetch:async(path,options)=>{f.calls.push('auth');assert.equal(path,'/api/auth/session');assert.equal(options?.cache,'no-store');assert.equal(options?.credentials,'same-origin');if(f.change.draftDuringLogin)f.composer.textContent=f.composer.innerText='new user draft';if(f.change.loginUnavailable)throw Error('offline');
      return {ok:!f.change.badResponse,json:async()=>({user:{id:f.login}})};},
    __CHAT_BRIDGE_INPUT_RESUMED_USER_CONTROL__:!!f.change.resumedUserControl,
    __CHAT_BRIDGE_ARGS__:['new','--project','P','--account','a','--message',message,'--strict-model']};
  const saved=new Map([...Object.keys(values),'__CHAT_BRIDGE_WATCH'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    for(const[k,v]of Object.entries(values))Object.defineProperty(globalThis,k,{value:v,configurable:true,writable:true});
    delete globalThis.__CHAT_BRIDGE_WATCH;
    const setup=[
      'const reg=f.reg, page=f.page, chat=f.chat;',
      // This input-policy fixture mocks prior native source and delivery; binding has its own native-DOM tests.
      'const sampleState=state;state=async(...args)=>{const snapshot=await sampleState(...args);if(snapshot.url===url)Object.assign(snapshot,{lastUserId:"22222222-2222-4222-8222-222222222222",userMessageIds:["22222222-2222-4222-8222-222222222222"],lastUserSourceCondition:"BOUND_SOURCE",lastUserSource:{messageId:"22222222-2222-4222-8222-222222222222",conversationId:chat.id,text:"Previous synthetic request"}});return snapshot;};',
      'assertImagePageFree=async()=>{};detectWebRateLimit=async()=>{};recordDeliveryStage=async()=>{};',
      'if(f.change.afterIntent)recordDeliveryStage=async phase=>{if(phase==="DRAFT_DISCARD_INTENT")f.change.afterIntent(f);};',
      "coordinated=command=>{if(f.change.paused)throw Error('DRAFT_DISCARD_ADMISSION_DENIED');return command==='page-reclaim-context'?{sessionRefs:[],unboundProjectIds:[],unboundAny:false}:{ok:true};};",
      "saveDraftBackup=async backup=>{f.backup=backup;return {sha256:'synthetic',bytes:1};};",
      "applyModelSpec=async()=>{f.calls.push('model');return {model:'Latest',effort:'High'};};",
      "setEffort=async()=>{f.calls.push('effort');return true;};saveRegistry=async()=>{};touchRuntime=async()=>{};print=()=>{};",
      'openBoundTask=async()=>({task:{spaceId:2},binding:f.reg.projects.P.bindings.a});',
      'if(f.change.reclaim){loadRuntime=async()=>({tasks:{t:{taskId:"t",sessionId:chat.id,project:"P",account:"a",status:"CANCELLED"}}});imageSessionOccupancy=()=>({occupied:false});}',
      'newManagedPage=async()=>page;openProjectPage=async()=>{f.currentUrl=home;};',
      "waitForDelivery=async()=>({url:f.currentUrl,lastUser:message,lastUserId:'33333333-3333-4333-8333-333333333333',lastUserSource:{text:message,messageId:'33333333-3333-4333-8333-333333333333',conversationId:chat.id},lastUserSourceCondition:'BOUND_SOURCE',observedAt:new Date().toISOString(),messageCount:1,composerText:''});",
      'return {state,prepare:()=>assertInputSafe(page,"verified-user",url,{discardDraft:true}),send:()=>sendMessage(page,message,url),dispatch:()=>applyDispatchModel(page,chat,"Latest","High"),',
      "model:async()=>{const positionals=()=>['Latest'],opt=()=>null;"+modelBody+'},',
      "effort:async()=>{const positionals=()=>['High'];"+effortBody+'},',
      "new:async()=>{const project='P',accountArg='a';"+newBody+'},',
      'reclaim:()=>reclaimIdlePageSlot(reg,"P","a",{spaceId:2,page:()=>page,tabs:async()=>[{label:page.label,url:f.currentUrl,active:true,openedBy:"agent"}]},reg.projects.P.bindings.a),loader:()=>recoverConversationLoadError(page)};'
    ].join('\n');
    const api=await new AsyncFunction('f','message','url','home',prefix+setup)(f,message,url,home);
    return await fn(api);
  } finally {for(const[k,d]of saved){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
}
test('actual input entry points reject raw drafts and unverified fresh login before all input/model effects',async t=>{
  const cases=[['space',{raw:' '}],['tab',{raw:'\t'}],['LF',{raw:'\n'}],['NBSP',{raw:'\u00a0'}],
    ['missing',{count:0}],['duplicate',{count:2}],['unknown raw',{unknownRaw:true}],
    ['wrong login',{login:'other-user'}],['unavailable login',{loginUnavailable:true}],
    ['HTTP failure',{badResponse:true}],['missing login ID',{nullLogin:true}],['missing registered identity',{noIdentity:true}],['draft arriving during login',{draftDuringLogin:true}]];
  for(const[name,change]of cases)await t.test(name,async()=>{
    for(const entry of ['send','dispatch','model','effort','new']) {
      const f=fixture(change);
      const expected=change.count===0?'CHAT_BUSY':change.noIdentity?'TARGET_IDENTITY_UNVERIFIED':change.login?'INPUT_LOGIN_MISMATCH':change.loginUnavailable||change.badResponse||change.nullLogin?'INPUT_LOGIN_UNAVAILABLE':'USER_DRAFT_PRESENT';
      await run(f,api=>assert.rejects(api[entry](),error=>error.message===expected,entry));
      assert.deepEqual(f.calls.filter(x=>/^(fill|key:|insert|send|model|effort)/.test(x)),[],entry);
      if(change.raw||change.count!=null||change.unknownRaw)assert.equal(f.closed,0,entry+' retains uncertain draft');
    }
  });
});
test('authorized Project draft discard backs up raw text and enters the normal send/model path',async()=>{
  for(const raw of [' ','first paragraph\nsecond paragraph']) {
    for(const entry of ['send','dispatch','new']) {
      const f=fixture({raw,discard:true});
      await run(f,api=>api[entry]());
      assert.equal(f.backup?.rawText,raw,entry);
      assert.equal(f.calls.filter(x=>x==='discard').length,1,entry);assert.equal(f.calls.filter(x=>x==='fill').length,entry==='dispatch'?0:1,entry);
    }
  }
});
test('selected terminal reclaim reaches the actual input guard and native draft discard',async()=>{
  const raw='保留第一段\n第二段 🧪',f=fixture({raw,discard:true,reclaim:true});
  Object.assign(f.chat,{status:'active',spaceId:2,spaceName:'managed',profileId:'P1',page:f.page.label});
  Object.assign(f.reg.projects.P.bindings.a,{spaceId:2,spaceName:'managed',profileId:'P1'});
  await run(f,api=>api.reclaim());
  assert.equal(f.backup?.rawText,raw);assert.equal(f.backup?.document?.type,'doc');
  assert.equal(f.calls.filter(x=>x==='discard').length,1);assert.ok(f.calls.filter(x=>x==='auth').length>=4);
  assert.equal(f.closed,1);assert.equal(f.chat.page,null);assert.equal(f.chat.attachmentEpoch,1);
  assert.deepEqual(f.calls.filter(x=>/^(fill|key:|insert|send|model|effort)/.test(x)),[]);
});
test('authorized discard still preserves a changed draft, paused owner and partial Bridge input',async()=>{
  for(const change of [{draftDuringLogin:true},{paused:true},{resumedUserControl:true},{fillFails:true,partialFill:true}]) {
    const f=fixture({raw:'old draft',discard:true,...change});
    await run(f,api=>assert.rejects(api.send()));
    assert.equal(f.calls.includes('send'),false);
    if(change.draftDuringLogin)assert.equal(f.composer.textContent,'new user draft');
    if(change.paused||change.resumedUserControl)assert.equal(f.composer.textContent,'old draft');
  }
});
test('intent persistence cannot clear new draft, foreign CID or an unrendered FileList',async()=>{
  for(const kind of ['draft','cid','file-list','document','login','generation','approval']) {
    const original='backed-up old draft',f=fixture({raw:original,discard:true,afterIntent:f=>{
      if(kind==='draft')f.composer.textContent=f.composer.innerText='new user draft';
      if(kind==='cid'){f.currentUrl=url.replace(f.chat.id,'22222222-2222-4222-8222-222222222222');f.composer.textContent=f.composer.innerText='foreign unbacked draft';}
      if(kind==='file-list'){const query=f.document.querySelectorAll;f.document.querySelectorAll=s=>s==='input[type="file"]'?[{files:{length:1}}]:query(s);}
      if(kind==='document')f.nativeDoc.toJSON=()=>({type:'doc',changed:true});
      if(kind==='login')f.login='other-user';
      if(kind==='generation')f.buttons.push(node('Stop generating',{attrs:{'data-testid':'stop-button'}}));
      if(kind==='approval'){const query=f.document.querySelectorAll;f.document.querySelectorAll=s=>s==='[role="alert"], [data-testid*="error" i]'?[node('Codex Tasks Allow ChatGPT to use Codex Tasks?')]:query(s);}
    }});
    await run(f,api=>assert.rejects(api.prepare()));
    assert.equal(f.backup.rawText,original,kind);assert.equal(f.calls.includes('discard'),false,kind);assert.equal(f.calls.includes('fill'),false,kind);assert.equal(f.calls.includes('send'),false,kind);
    assert.equal(f.composer.textContent,kind==='draft'?'new user draft':kind==='cid'?'foreign unbacked draft':original,kind);
  }
});
test('unavailable atomic editor capability is explicit and never falls back to fill or DOM clear',async()=>{
  for(const change of [{plainComposer:true},{unsupportedView:true},{composing:true}]) {
    const f=fixture({raw:'keep',discard:true,...change});
    if(change.unsupportedView)f.nativeEditor.view.dispatch=undefined;
    if(change.composing)f.nativeEditor.view.composing=true;
    await run(f,api=>assert.rejects(api.prepare(),/DRAFT_DISCARD_UNSUPPORTED/));
    assert.equal(f.composer.textContent,'keep');assert.equal(f.calls.includes('discard'),false);assert.equal(f.calls.includes('fill'),false);
  }
});
test('discard permission never bypasses attachment, composer, login or clear acknowledgement guards',async()=>{
  for(const change of [{attachment:true},{count:2},{login:'wrong-user'},{loginAfterFill:'wrong-user'},{clearNotEmpty:true},{clearFails:true}]) {
    const f=fixture({raw:' ',discard:true,...change});
    await run(f,api=>assert.rejects(api.send()));
    assert.equal(f.calls.includes('send'),false);
    assert.equal(f.calls.some(x=>x.startsWith('key:')),false);
    if(change.attachment||change.count||change.login)assert.equal(f.backup,undefined);
    assert.equal(f.calls.filter(x=>x==='discard').length,change.clearNotEmpty||change.clearFails||change.loginAfterFill?1:0);
  }
});
test('multi-node native draft backup preserves the complete editor document and form',async()=>{
  const f=fixture({raw:'firstsecond',discard:true});
  f.composer.outerHTML='<div id="prompt-textarea"><p>first</p><p>second</p></div>';
  f.composer.innerText='first\nsecond';f.nativeDoc.toJSON=()=>({type:'doc',content:f.composer.textContent?[{type:'paragraph',text:'first'},{type:'paragraph',text:'second'}]:[]});
  f.document.querySelector('form').outerHTML='<form>'+f.composer.outerHTML+'</form>';
  await run(f,api=>api.prepare());
  assert.equal(f.backup.rawText,'firstsecond');assert.equal(f.backup.text,'first\nsecond');
  assert.equal(f.backup.document.content.length,2);assert.match(f.backup.formHtml,/<p>second<\/p>/);
});
test('semantic empty p/br allows one complete send and read-only state performs no login request',async()=>{
  const f=fixture();f.composer.innerText='\n'; // Empty paragraph/br has no semantic textContent.
  await run(f,async api=>{
    const snapshot=await api.state(f.page);assert.equal(snapshot.composerText,'');assert.equal(snapshot.composerAttachmentsEmpty,true);assert.deepEqual(f.calls,[]);
    const receipt=await api.send();assert.equal(receipt.delivered,true);assert.equal(receipt.lastUserId,'33333333-3333-4333-8333-333333333333');
  });
  assert.equal(f.calls.filter(x=>x==='fill').length,1);assert.equal(f.calls.filter(x=>x==='send').length,1);
  assert.equal(f.calls.filter(x=>x==='auth').length,1);
});
test('empty fallback rechecks login and only an unchanged account may type and send',async()=>{
  for(const loginAfterFill of [null,'other-user']) {
    const f=fixture({fillFails:true,emptyFill:true,loginAfterFill});
    await run(f,async api=>{if(loginAfterFill)await assert.rejects(api.send(),/INPUT_LOGIN_MISMATCH/);else assert.equal((await api.send()).delivered,true);});
    assert.deepEqual(f.calls.filter(x=>/^(key:|insert|send)/.test(x)),loginAfterFill?[]:['key:ControlOrMeta+A','key:Backspace','insert','send']);
  }
});
test('partial fill failure preserves unknown content without destructive keyboard fallback',async()=>{
  const f=fixture({fillFails:true,partialFill:true});
  await run(f,api=>assert.rejects(api.send()));
  assert.equal(f.composer.textContent,'partial user content');
  assert.deepEqual(f.calls.filter(x=>/^(key:|insert|send)/.test(x)),[]);
});
test('loader recovery selects only one current platform Retry, excludes historical prose/buttons and approval',async t=>{
  for(const kind of ['history','sidebar','wrapper','current','duplicate','approval','disabled'])await t.test(kind,async()=>{
    const f=fixture({count:0}), owner=node('Could not load this ChatGPT conversation',{attrs:{'data-message-author-role':'user'}});
    const historical=['history','wrapper'].includes(kind);
    const error=node('Could not load this ChatGPT conversation',{message:kind==='history'?owner:null,containsMessage:kind==='wrapper'?owner:null});
    const button=node('Retry',{message:historical?owner:null,sidebar:kind==='sidebar'?{}:null,disabled:kind==='disabled'});
    const approval=node('Codex Tasks\nAllow ChatGPT to use Codex Tasks?',{attrs:{role:'alert'}});
    const errors=kind==='approval'?[error,approval]:[error], buttons=kind==='duplicate'?[button,node('Retry')]:[button];
    f.document.body.innerText=owner.innerText;f.root.contains=n=>errors.includes(n)||buttons.includes(n);
    f.document.querySelectorAll=s=>s==='button'?buttons:s.includes('data-chat-bridge-conversation-retry')?[]:
      s.includes('[role="alert"]')?errors:s.startsWith('main div')?errors:
      s==='[data-message-author-role]'?historical?[owner]:[]:[];
    f.page.keyboard.press=async key=>f.calls.push('key:'+key);
    await run(f,async api=>{
      if(kind==='approval')await assert.rejects(api.loader(),/APPROVAL_REQUIRED/);
      else assert.equal(await api.loader(),kind==='current');
    });
    assert.equal(f.calls.includes('key:Enter'),kind==='current');
    assert.equal(button.getAttribute('data-chat-bridge-conversation-retry')==='1',kind==='current'||kind==='approval');
  });
});

test('immutable conversation target rejects same-account navigation before every fallback effect and Send',async()=>{
  const foreign=url.replace('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
  const prepare=()=>{
    const f=fixture(), effects=[];
    f.reg.chats.foreign={...f.chat,id:'22222222-2222-4222-8222-222222222222',url:foreign};
    for(const name of ['fill','focus','click']) {
      const original=f.page[name];f.page[name]=async(...args)=>{effects.push({effect:name,url:f.currentUrl});return original(...args);};
    }
    for(const name of ['press','insertText']) {
      const original=f.page.keyboard[name];f.page.keyboard[name]=async(...args)=>{effects.push({effect:name+':'+args[0],url:f.currentUrl});return original(...args);};
    }
    return {f,effects};
  };
  for(const phase of ['fill-failure','focus','select','backspace','fill-success']) {
    const {f,effects}=prepare();
    const fill=f.page.fill,focus=f.page.focus,press=f.page.keyboard.press;
    f.page.fill=async(...args)=>{
      if(phase==='fill-success'){await fill(...args);f.currentUrl=foreign;return;}
      f.calls.push('fill-failed');if(phase==='fill-failure')f.currentUrl=foreign;throw Error('synthetic fill failure');
    };
    f.page.focus=async(...args)=>{await focus(...args);if(phase==='focus')f.currentUrl=foreign;};
    f.page.keyboard.press=async key=>{await press(key);if(phase==='select'&&key==='ControlOrMeta+A'||phase==='backspace'&&key==='Backspace')f.currentUrl=foreign;};
    await run(f,api=>assert.rejects(api.send(),error=>error.message==='DELIVERY_TARGET_MISMATCH'&&error.deliveryStage==='PRE_SEND',phase));
    assert.deepEqual(effects.filter(x=>x.url===foreign),[],phase+' never acts on the foreign conversation');
    assert.equal(f.calls.includes('send'),false,phase);
    if(phase==='fill-failure')assert.equal(f.calls.includes('focus'),false);
  }
  for(const entry of ['dispatch','model','effort']) {
    const {f,effects}=prepare();f.currentUrl=foreign;
    await run(f,api=>assert.rejects(api[entry](),/DELIVERY_TARGET_MISMATCH/,entry));
    assert.deepEqual(effects,[]);assert.deepEqual(f.calls.filter(x=>/^(model|effort)/.test(x)),[]);
  }
});
