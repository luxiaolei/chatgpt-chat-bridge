// Offline fixture. Executes the real state/observeSession/status implementations.
// It supplies only DOM/native-source properties and in-memory runtime I/O.
import assert from 'node:assert/strict';
for (const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import('../src/'+file+'.js');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
class Element {
  constructor(tag,attrs={},text=''){this.tagName=tag;this.attrs=attrs;this.innerText=text;this.textContent=text;this.children=[];this.parentElement=null;}
  append(node){this.children.push(node);node.parentElement=this;return node;}
  getAttribute(name){return this.attrs[name]??null;}
  matches(selector){return selector.split(',').some(part=>{
    part=part.trim();
    const descendant=part.match(/^(main|\[role="main"\]) (div|span|p)$/i);
    if(descendant)return this.tagName===descendant[2].toUpperCase()&&!!this.parentElement?.closest(descendant[1]);
    const tag=part.match(/^[a-z]+/i)?.[0];
    if(tag&&tag.toUpperCase()!==this.tagName)return false;
    if(!part.includes('['))return !!tag;
    const attrs=[...part.matchAll(/\[([^\s\]=~|^$*]+)(?:([*^$]?=)"([^"\]]*)"(?:\s+(i))?)?\]/g)];
    if(!attrs.length)return false;
    return attrs.every(([,key,op,value,insensitive])=>{
      const actual=this.getAttribute(key);if(actual===null)return false;
      if(!op)return true;
      const text=insensitive?String(actual).toLowerCase():String(actual),expected=insensitive?value.toLowerCase():value;
      return op==='='?text===expected:op==='$='?text.endsWith(expected):op==='^='?text.startsWith(expected):text.includes(expected);
    });
  });}
  closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null;}
  contains(node){return this===node||this.children.some(n=>n.contains(node));}
  querySelectorAll(selector){return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  getBoundingClientRect(){return {width:100,height:40,left:0,top:0};}
  getClientRects(){return [this.getBoundingClientRect()];}
  click(){this.clicked=(this.clicked||0)+1;}
}
export async function statusFixture(main, options={}) {
  const cid=options.cid||'11111111-1111-4111-8111-111111111111';
  const uid=options.uid||'22222222-2222-4222-8222-222222222222';
  const aid=options.aid||'33333333-3333-4333-8333-333333333333';
  const body=options.body??'  Exact source\n~~~json\n{"a":1}\n~~~\n尾部 🧪\n';
  const url=options.url||'https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'-test/c/'+cid;
  const documentBody=new Element('BODY'), root=documentBody.append(new Element('MAIN'));
  const sidebar=documentBody.append(new Element('SECTION',{'data-app-action-sidebar-section':'','data-app-action-sidebar-section-heading':'Recents'}));
  const addedButtons=[];
  const button=(parent,label)=>{const b=parent.append(new Element('BUTTON',{},label));addedButtons.push(b);return b;};
  const user=root.append(new Element('DIV',{'data-chatgpt-search-unit-key':'u:user','data-chatgpt-search-message-ids':options.renderedIds||uid}));
  const bubble=user.append(new Element('DIV',{'data-user-message-bubble':'true'}));
  const outer=bubble.append(new Element('DIV',{'data-search-result-target':''},options.renderedText??'collapsed rendered preview'));
  outer.__reactFiber$fixture={memoizedProps:{messageId:uid,conversationId:options.sourceCid||cid,
    message:body,copyPlainTextFromSource:true,...options.sourceProps},return:null};
  if(options.missingSource)delete outer.__reactFiber$fixture;
  const assistant=root.append(new Element('DIV',{'data-chatgpt-search-unit-key':'a:assistant','data-chatgpt-search-message-ids':aid}));
  const markdown=assistant.append(new Element('DIV',{'data-markdown-text-style':'assistant-message'},options.assistantRenderedText??'rendered assistant'));
  markdown.__reactFiber$fixture={memoizedProps:{streamId:cid+':'+aid,conversationId:cid,children:options.assistantText||'Old assistant must not become a parent proof.'},return:null};
  if(options.sidebarRetry)button(sidebar.append(new Element('DIV',{role:'status'},'Unable to load history')), 'Retry');
  for(const label of options.currentControls||[])button(assistant,label);
  if(options.mainRetry)button(root.append(new Element('DIV',{role:'alert'},'Something went wrong')),'Retry');
  if(options.globalApproval)documentBody.append(new Element('DIV',{role:'alert'},'Codex Tasks\nAllow ChatGPT to use Codex Tasks?'));
  if(options.mainError)root.append(new Element('DIV',{role:'alert'},options.mainError));
  const composer=new Element('DIV'), send=root.append(new Element('BUTTON',{'data-testid':'send-button'}));
  const document={title:'Status fixture',visibilityState:'visible',body:documentBody,
    querySelector(selector){
      if(selector==='main'||selector==='[role="main"]')return root;
      if(selector.includes('contenteditable="true"'))return composer;
      if(selector==='button[data-testid="send-button"]')return send;
      return documentBody.querySelector(selector);
    },
    querySelectorAll(selector){
      if(selector.includes('contenteditable="true"'))return [composer];
      return documentBody.querySelectorAll(selector);
    }};
  const f={chat:{id:cid,project:options.project||'P',account:options.account||'a',role:'r',url,status:'active',effort:'High'},
    runtime:{sessions:{},tasks:{}},printed:[],evaluateArgs:[],
    saveRuntimeError:options.saveRuntimeError||null,observeOptions:options.observeOptions||{}};
  if(options.linkedTask)f.runtime.tasks['fixture-task']={taskId:'fixture-task',project:f.chat.project,sessionId:cid,role:'r',status:'RUNNING',completionMode:'external',baselineAssistantCount:0,baselineAssistantId:'previous-assistant',baselineAssistantHash:'previous-hash'};
  f.page={url:async()=>url,evaluate:async(fn,arg)=>{f.evaluateArgs.push(structuredClone(arg));return await fn(structuredClone(arg));}};
  const globals={document,location:{href:url,pathname:new URL(url).pathname},navigator:{onLine:true},
    MutationObserver:class{observe(){}disconnect(){}},Node:{ELEMENT_NODE:1},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    __CHAT_BRIDGE_ARGS__:options.args||['status',cid,'--account',f.chat.account]};
  if(options.observedAt) {
    const OriginalDate=Date, at=Date.parse(options.observedAt);
    assert.ok(Number.isFinite(at));
    globals.Date=class extends OriginalDate {constructor(...args){super(...(args.length?args:[at]));}static now(){return at;}};
  }
  const prior=new Map([...Object.keys(globals),'__CHAT_BRIDGE_WATCH'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  try {
    for(const [k,value]of Object.entries(globals))Object.defineProperty(globalThis,k,{configurable:true,value});
    delete globalThis.__CHAT_BRIDGE_WATCH;
    const prefix=main.split('const cmd=args[0] || "help";')[0];
    const start=main.indexOf('  if(cmd==="status"){');
    const end=main.indexOf('  if(cmd==="send"){',start);
    assert.ok(start>0&&end>start,'exact status dispatcher is present');
    const setup=`
      const reg={}; const chat=f.chat, page=f.page;
      detectWebRateLimit=async()=>{};
      loadRuntime=async()=>structuredClone(f.runtime);
      saveRuntime=async rt=>{if(f.saveRuntimeError)throw f.saveRuntimeError;f.runtime=structuredClone(rt);};
      print=value=>f.printed.push(structuredClone(value));
      return {status:async()=>{const cmd="status";${main.slice(start,end)}},
        heartbeat:async()=>observeSession(chat,page,null,f.observeOptions),state:async()=>state(page,'ids'),control:async()=>nativeRetry(page,{allowContinue:f.allowContinue})};`;
    const api=await new AsyncFunction('f',prefix+setup)(f);
    if(options.controlAction){f.allowContinue=options.controlAction==='recover';f.printed.push(await api.control());}
    else if(options.heartbeat)f.printed.push(await api.heartbeat());
    else if(options.directState)f.printed.push(await api.state());
    else await api.status();
    return {snapshot:f.printed.at(-1),cached:f.runtime.sessions[cid],evaluateArgs:f.evaluateArgs,clicks:addedButtons.map(b=>({label:b.innerText,count:b.clicked||0}))};
  } finally {
    for(const [k,d]of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}
  }
}
