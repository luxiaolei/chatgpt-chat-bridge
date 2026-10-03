
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import '../src/model-policy.js';
const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function waitForModelPicker('),source.indexOf('\nasync function modelSelectorAvailable('));
const fixtures=await Promise.all(['simple','full'].map(n=>readFile(new URL('./fixtures/model-menu-'+n+'.html',import.meta.url),'utf8')));
function parse(html) {
 const root={tag:'ROOT',attrs:{},children:[],parentElement:null,text:''};let stack=[root];
 for(const token of html.match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)||[]) {
  if(token.startsWith('<!--'))continue;
  if(token.startsWith('</')){stack.pop();continue;}
  if(token.startsWith('<')) {
   const tag=/^<([\w-]+)/.exec(token)?.[1];if(!tag)continue;
   const node={tag,attrs:Object.fromEntries([...token.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1],m[2]])),children:[],parentElement:stack.at(-1),text:''};
   stack.at(-1).children.push(node);if(!/\/>$/.test(token)&&!['input','br','img','hr','meta','link'].includes(tag))stack.push(node);
  }else stack.at(-1).text+=token;
 }
 const descendants=n=>n.children.flatMap(c=>[c,...descendants(c)]);
 const match=(n,selector)=>selector.split(',').some(part=>{
  const s=part.trim();if(!s.startsWith('['))return n.tag===s;
  const conditions=[...s.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)];
  return conditions.length>0&&conditions.every(m=>Object.hasOwn(n.attrs,m[1])&&(m[2]===undefined||n.attrs[m[1]]===m[2]));
 });
 for(const n of [root,...descendants(root)])Object.assign(n,{
  isConnected:true,
  getAttribute:name=>n.attrs[name]??null,hasAttribute:name=>Object.hasOwn(n.attrs,name),
  setAttribute:(name,value)=>{n.attrs[name]=value;},removeAttribute:name=>{delete n.attrs[name];},
  getClientRects:()=>[{}],getBoundingClientRect:()=>({left:10,top:10,width:20,height:20}),
  contains:child=>{for(let p=child;p;p=p.parentElement)if(p===n)return true;return false;},
  matches:s=>match(n,s),querySelectorAll:s=>descendants(n).filter(c=>match(c,s)),
  querySelector:s=>descendants(n).find(c=>match(c,s))||null,
  closest:s=>{let p=n;while(p&&!match(p,s))p=p.parentElement;return p;}
 });
 for(const n of [root,...descendants(root)])Object.defineProperty(n,"innerText",{get(){return (n.text+n.children.map(c=>c.innerText).join("")).trim();}});
 return root;
}
function fixture(options={}) {
 const root=parse(fixtures[options.advanced?1:0]),picker=root.querySelector('[data-model-picker-view]');
 const tracks=picker.children.filter(n=>n.attrs['aria-hidden']!==undefined);
 const radios=root.querySelectorAll('[role="menuitemradio"]'),slider=root.querySelector('[role="slider"]'),toggle=root.querySelector('[data-model-picker-view-toggle="true"]'),power=root.querySelector('[data-reasoning-slider="true"]');
 assert.equal(radios.length,3);assert.equal(slider.getAttribute('aria-hidden'),'true');
 if(options.initialModel)radios.forEach(r=>r.attrs['aria-checked']=String(r.innerText===options.initialModel));
 let pointerReady=!options.transitioning,animationReady=!options.transitioning,pendingCommit=null,blockedPolls=0;
 let opened=false,current=options.value??2,mode='High',focused=null,pendingSimpleReset=0,effortPolls=0,pickerClock=0;
 let effortReady=!options.effortTransitioning;
 const calls={inactiveClicks:0,modelClicks:0,modelAttempts:0,ineffectiveClicks:0,pointerChecks:0,commitChecks:0,toggles:0,send:0,waits:[],opens:0,viewPolls:0,effortFocus:0,earlyEffortFocus:0,arrows:0,effortPointerChecks:0};
 const switchView=view=>{
  picker.attrs['data-model-picker-view']=view;
  if(options.noTransitionAttribute)delete picker.attrs['data-transitions-ready'];
  else picker.attrs['data-transitions-ready']=String(animationReady);
  tracks.forEach((n,i)=>{const active=(view==='simple'?i===0:i===1);n.attrs['aria-hidden']=String(!active);n.attrs['data-active']=String(active);if(active)delete n.attrs.inert;else n.attrs.inert='';for(const child of n.querySelectorAll('[data-active]'))child.attrs['data-active']=String(active);});
  if(view==='simple'){delete power.attrs['aria-disabled'];delete power.attrs['data-disabled'];power.attrs.tabindex='0';}
  else{power.attrs['aria-disabled']='true';power.attrs['data-disabled']='';}
 };
 switchView(options.advanced?'advanced':'simple');slider.attrs['aria-valuenow']=String(current);
 toggle.click=()=>{if(!toggle.closest('[inert]')){calls.toggles++;switchView('advanced');}};
 radios.forEach(r=>r.click=()=>{calls.modelAttempts++;if(r.closest('[inert]')){calls.inactiveClicks++;switchView('advanced');return;}
   if(!pointerReady||!animationReady){calls.ineffectiveClicks++;return;}
   calls.modelClicks++;const commit=()=>{radios.forEach(x=>x.attrs['aria-checked']=String(x===r));switchView('simple');};
   if(options.delayedCommit)pendingCommit=commit;else commit();});
 const trigger={innerText:'High',attrs:{'aria-label':'Select ChatGPT model'},isConnected:true,
  getClientRects:()=>[{}],closest:()=>null,getAttribute:n=>trigger.attrs[n]??null,setAttribute:(n,v)=>trigger.attrs[n]=v,removeAttribute:n=>delete trigger.attrs[n],
  click:()=>opened=true};
 const document={
  querySelectorAll(selector){if(selector==='button')return [trigger];if(selector.includes('data-chat-bridge-model-button'))return trigger.attrs['data-chat-bridge-model-button']?[trigger]:[];
   return opened?root.querySelectorAll(selector):[];},
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;},
   elementFromPoint(){calls.pointerChecks++;const option=this.querySelector('[data-chat-bridge-model-option="1"]');if(option&&!option.closest('[inert],[aria-hidden="true"],[data-active="false"]'))return pointerReady?(option.querySelector('span')||option):power;calls.effortPointerChecks++;return effortReady?power:trigger;}
 };
 const evaluate=(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(arg)',{document,arg,getComputedStyle:()=>({display:'block',visibility:'visible',transform:pointerReady?'none':'translateX(24px)'})});
 const page={evaluate:async(fn,arg)=>{if(fn.toString().includes('const picker=pickers[0]')&&arg===(options.selectorPurpose||'model')){if(options.selectorError)throw options.selectorError;if(options.selectorResult)return options.selectorResult;}try{return evaluate(fn,arg);}catch(error){if(!options.wrapEvaluationErrors)throw error;throw Error('JavaScript evaluation failed: '+error.message);}},waitForFunction:async(fn,arg)=>{for(let i=0;i<6;i++){if(evaluate(fn,arg))return;
    if(pendingSimpleReset){calls.viewPolls++;if(--pendingSimpleReset===0)switchView('simple');}
    if(options.effortTransitioning&&calls.opens>=3&&!options.effortBlockedForever){effortPolls++;if(effortPolls>=1)picker.attrs['data-transitions-ready']='true';if(effortPolls>=2)effortReady=true;}
    if(document.querySelector('[data-chat-bridge-model-option="1"]')&&options.transitioning&&!options.pointerBlockedForever){
     blockedPolls++;if(blockedPolls>=1){animationReady=true;if(!options.noTransitionAttribute)picker.attrs['data-transitions-ready']='true';}if(blockedPolls>=2)pointerReady=true;
    }
    if(pendingCommit){calls.commitChecks++;if(!options.commitNever&&calls.commitChecks>=2){pendingCommit();pendingCommit=null;}}
   }throw Error('isolated UI readiness timeout');},
  waitForTimeout:async ms=>{calls.waits.push(ms);pickerClock+=ms;
   if(pendingSimpleReset){calls.viewPolls++;if(--pendingSimpleReset===0)switchView('simple');}
   if(options.effortTransitioning&&calls.opens>=3&&!options.effortBlockedForever){effortPolls++;if(effortPolls>=1)picker.attrs['data-transitions-ready']='true';if(effortPolls>=2)effortReady=true;}
  },
  focus:async selector=>{focused=document.querySelector(selector);calls.effortFocus++;if(!effortReady)calls.earlyEffortFocus++;assert.ok(focused);assert.equal(focused.closest('[inert]'),null);assert.equal(focused,power,'Only the actual Power keyboard control may receive focus');},
  mouse:{click:async()=>document.querySelector('[data-chat-bridge-model-option="1"]').click()},
  click:async selector=>{if(selector.includes('model-button')){if(options.interceptOnce){options.interceptOnce=false;throw Error('pointer intercepted by overlay');}assert.equal(opened,false);opened=true;calls.opens++;switchView(options.modelOpenView||'simple');
    if(options.reopenView&&calls.opens>=3){switchView('advanced');if(options.reopenView==='delayed'||(options.reopenView==='native-reopen'&&calls.opens>=4))pendingSimpleReset=2;}
    if(options.effortTransitioning&&calls.opens>=3)picker.attrs['data-transitions-ready']=String(effortPolls>=1);}else{const node=document.querySelector(selector);assert.ok(node);assert.equal(node.closest('[inert]'),null);node.click();}},
  keyboard:{press:async key=>{
   assert.ok(['Escape','ArrowLeft','ArrowRight'].includes(key),'Native Power accepts only observed arrow keys');if(key!=='Escape')assert.equal(focused,power);if(key==='Escape'){opened=false;if(!options.displayMismatch)mode=['Instant','Medium','High','Extra High','Pro'][current];return;}
   calls.arrows++;if(key==='ArrowLeft')current--;if(key==='ArrowRight')current++;if(key==='Home')current=0;if(key==='End')current=4;
   slider.attrs['aria-valuenow']=String(current);
  }},
 };
 const api=new Function('detectWebRateLimit','state','observedModel','selectModelLabel','modelPreset','Date',body+';return {setModel,setEffort,applyModelSpec};')(
  async()=>{},async()=>({mode}),globalThis.__CHAT_BRIDGE_MODEL_POLICY__.observedModel,globalThis.__CHAT_BRIDGE_MODEL_POLICY__.selectModelLabel,globalThis.__CHAT_BRIDGE_MODEL_POLICY__.modelPreset,{now:()=>pickerClock});
 return {api,page,calls,root,picker,slider,power,radios,toggle,switchView};
}
test('captured simple view never uses inactive model radios to select Latest',async()=>{
 const f=fixture();await f.api.setModel(f.page,'Latest');assert.equal(f.calls.inactiveClicks,0);assert.ok(f.calls.modelClicks>0);
});
test('captured High to Latest plus Extra High sequence reaches active Thinking and confirms the exact level',async()=>{
 const f=fixture();const r=await f.api.applyModelSpec(f.page,'Latest','Extra High');
 assert.equal(r.effort,'Extra High');assert.equal(f.slider.getAttribute('aria-valuenow'),'3');assert.equal(f.calls.inactiveClicks,0);assert.equal(f.calls.send,0);
});


test('advanced model view is reopened natively into Thinking and only Power receives arrows',async()=>{
 const f=fixture({advanced:true});await f.api.setEffort(f.page,'Extra High');
 assert.equal(f.slider.getAttribute('aria-valuenow'),'3');assert.equal(f.calls.send,0);
});
test('ambiguous native model toggle is rejected before selecting a radio',async()=>{
 const f=fixture();const duplicate=parse('<div data-model-picker-view-toggle="true" aria-label="Select model"></div>').children[0];
 duplicate.parentElement=f.toggle.parentElement;duplicate.parentElement.children.push(duplicate);
 await assert.rejects(f.api.setModel(f.page,'Latest'),/MODEL_VIEW_TOGGLE_AMBIGUOUS/);
 assert.equal(f.calls.modelClicks,0);assert.equal(f.calls.inactiveClicks,0);
});
test('duplicate active native slider is rejected rather than choosing a global first slider',async()=>{
 const f=fixture();const duplicate=parse('<span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span>').children[0];
 duplicate.parentElement=f.power;f.power.children.push(duplicate);
 await assert.rejects(f.api.setEffort(f.page,'Extra High'),/EFFORT_SELECTOR_AMBIGUOUS/);
 assert.equal(f.calls.send,0);
});
test('native range cannot silently downgrade Extra High and final displayed mismatch fails',async()=>{
 const f=fixture();f.slider.attrs['aria-valuemax']='2';
 await assert.rejects(f.api.setEffort(f.page,'Extra High'),/Requested thinking level is unavailable/);
 const g=fixture({displayMismatch:true});
 await assert.rejects(g.api.setEffort(g.page,'Extra High'),/not confirmed by the UI/);
 assert.equal(g.calls.send,0);
});


test('closed modern picker behind an overlay is classified after fallback and reset by native pointer',async()=>{
 const f=fixture({advanced:true,interceptOnce:true});await f.api.setEffort(f.page,'Extra High');
 assert.equal(f.slider.getAttribute('aria-valuenow'),'3');assert.equal(f.calls.send,0);
});
test('invalid native range never moves Power',async()=>{
 const f=fixture();f.slider.attrs['aria-valuemin']='invalid';
 await assert.rejects(f.api.setEffort(f.page,'Extra High'),/Thinking effort slider not available/);
 assert.equal(f.slider.getAttribute('aria-valuenow'),'2');
});

test('existing GPT-5.6 selection waits for transition and target-owned pointer before selecting Latest',async()=>{
 const f=fixture({initialModel:'GPT-5.6 Sol',transitioning:true});
 const r=await f.api.applyModelSpec(f.page,'Latest','Extra High');
 assert.equal(r.effort,'Extra High');assert.equal(f.radios.find(r=>r.innerText==='Latest').getAttribute('aria-checked'),'true');
 assert.equal(f.radios.find(r=>r.innerText==='GPT-5.6 Sol').getAttribute('aria-checked'),'false');
 assert.equal(f.calls.modelAttempts,1);assert.equal(f.calls.ineffectiveClicks,0);assert.ok(f.calls.pointerChecks>=2);assert.equal(f.calls.send,0);
});
test('native checked commit settles before closing and reopening for strict confirmation',async()=>{
 const f=fixture({initialModel:'GPT-5.6 Sol',delayedCommit:true});
 await f.api.setModel(f.page,'Latest');assert.equal(f.calls.modelAttempts,1);assert.ok(f.calls.commitChecks>=2);assert.equal(f.calls.send,0);
});
test('permanently blocked native target fails before a model click',async()=>{
 const f=fixture({initialModel:'GPT-5.6 Sol',transitioning:true,pointerBlockedForever:true});
 await assert.rejects(f.api.setModel(f.page,'Latest'),/MODEL_OPTION_NOT_READY/);
 assert.equal(f.calls.modelAttempts,0);assert.equal(f.calls.send,0);
});
test('a native menu without the optional transition attribute still uses target-owned pointer readiness',async()=>{
 const f=fixture({initialModel:'GPT-5.6 Sol',noTransitionAttribute:true});
 await f.api.setModel(f.page,'Latest');assert.equal(f.calls.modelAttempts,1);assert.equal(f.calls.send,0);
});
test('missing checked commit fails closed after one native click',async()=>{
 const f=fixture({initialModel:'GPT-5.6 Sol',delayedCommit:true,commitNever:true});
 await assert.rejects(f.api.setModel(f.page,'Latest'),/Model selection was not confirmed: Latest/);
 assert.equal(f.calls.modelAttempts,1);assert.equal(f.calls.send,0);
});

test('delayed native reopen settles into active Thinking before selecting exact Extra High',async()=>{
 const f=fixture({reopenView:'delayed',wrapEvaluationErrors:true});
 const result=await f.api.applyModelSpec(f.page,'Latest','Extra High');
 assert.equal(result.effort,'Extra High');assert.equal(f.slider.getAttribute('aria-valuenow'),'3');
 assert.ok(f.calls.viewPolls>=2);assert.equal(f.calls.opens,3);assert.equal(f.calls.inactiveClicks,0);assert.equal(f.calls.send,0);
});
test('one bounded native reopen recovers a stable advanced effort view without inactive input',async()=>{
 const f=fixture({reopenView:'native-reopen',wrapEvaluationErrors:true});
 await f.api.applyModelSpec(f.page,'Latest','Extra High');
 assert.equal(f.calls.opens,4);assert.equal(f.calls.modelAttempts,1);assert.equal(f.calls.inactiveClicks,0);
 assert.equal(f.slider.getAttribute('aria-valuenow'),'3');assert.equal(f.calls.send,0);
});
test('persistent advanced effort view fails with a fixed Node code after one bounded reopen',async()=>{
 const f=fixture({reopenView:'advanced-forever',wrapEvaluationErrors:true});
 await assert.rejects(f.api.applyModelSpec(f.page,'Latest','Extra High'),error=>
   error.code==='EFFORT_SELECTOR_NOT_READY'&&error.message==='EFFORT_SELECTOR_NOT_READY');
 assert.equal(f.calls.opens,4);assert.equal(f.calls.effortFocus,0);assert.equal(f.calls.arrows,0);
 assert.equal(f.slider.getAttribute('aria-valuenow'),'2');assert.equal(f.calls.send,0);
});
test('Thinking waits for native transition and target-owned Power readiness before focus',async()=>{
 const f=fixture({effortTransitioning:true});
 await f.api.applyModelSpec(f.page,'Latest','Extra High');
 assert.ok(f.calls.effortPointerChecks>=2);assert.equal(f.calls.earlyEffortFocus,0);assert.equal(f.calls.arrows,1);assert.equal(f.calls.send,0);
 const blocked=fixture({effortTransitioning:true,effortBlockedForever:true});
 await assert.rejects(blocked.api.applyModelSpec(blocked.page,'Latest','Extra High'),error=>error.code==='EFFORT_SELECTOR_NOT_READY');
 assert.equal(blocked.calls.effortFocus,0);assert.equal(blocked.calls.arrows,0);assert.equal(blocked.calls.send,0);
});
test('model readiness uses a validated fixed tagged result while unknown selector errors remain unchanged',async()=>{
 const invalid=fixture({modelOpenView:'unsupported',wrapEvaluationErrors:true});
 await assert.rejects(invalid.api.setModel(invalid.page,'Latest'),error=>error.code==='MODEL_SELECTOR_NOT_READY'&&error.message==='MODEL_SELECTOR_NOT_READY');
 for(const result of [
  {tag:'MODEL_PICKER_READINESS',code:'EFFORT_SELECTOR_NOT_READY'},
  {tag:'MODEL_PICKER_READINESS',code:'OTHER'},
  {tag:'MODEL_PICKER_READINESS',code:'MODEL_SELECTOR_NOT_READY',extra:'EFFORT_SELECTOR_NOT_READY'},
  {tag:'OTHER',code:'MODEL_SELECTOR_NOT_READY'},
 ]) {
  const f=fixture({selectorResult:result});
  await assert.rejects(f.api.setModel(f.page,'Latest'),/MODEL_PICKER_RESULT_INVALID/);
  assert.equal(f.calls.modelAttempts,0);assert.equal(f.calls.send,0);
 }
 for(const message of [
  'Other failure: EFFORT_SELECTOR_NOT_READY',
  'JavaScript evaluation failed: UNKNOWN\nEFFORT_SELECTOR_NOT_READY',
  'JavaScript evaluation failed: EFFORT_SELECTOR_NOT_READY extra',
  'JavaScript evaluation failed: EFFORT_SELECTOR_NOT_READY\nError: MODEL_SELECTOR_NOT_READY',
  'JavaScript evaluation failed: EFFORT_SELECTOR_NOT_READY',
 ]) {
  for(const code of [undefined,'UNRELATED']) {
   const original=new Error(message);if(code)original.code=code;
   const f=fixture({selectorError:original});
   await assert.rejects(f.api.setModel(f.page,'Latest'),error=>error===original&&error.code===code&&error.message===message);
   assert.equal(f.calls.modelAttempts,0);assert.equal(f.calls.send,0);
  }
 }
});
test('final receipt keeps readiness code and diagnostic while the producer send boundary remains monotonic',()=>{
 const start=source.lastIndexOf('  const payload={ok:false,deliveryStage:sendAttempted?');
 const end=source.indexOf('  throw error;',start)+'  throw error;'.length;
 assert.ok(start>0&&end>start);
 const emit=new Function('error','sendAttempted','console',source.slice(start,end));
 const capture=(error,attempted)=>{let receipt;assert.throws(()=>emit(error,attempted,{error:text=>{receipt=JSON.parse(text);}}),actual=>actual===error);return receipt;};
 const error=new Error('EFFORT_SELECTOR_NOT_READY');error.code=error.message;
 assert.deepEqual(capture(error,false),{ok:false,deliveryStage:'PRE_SEND',code:'EFFORT_SELECTOR_NOT_READY'});
 error.deliveryStage='PRE_SEND';
 assert.deepEqual(capture(error,true),{ok:false,deliveryStage:'SEND_ATTEMPTED',code:'EFFORT_SELECTOR_NOT_READY'});
 const unknown=new Error('Other failure: EFFORT_SELECTOR_NOT_READY');unknown.code='UNRELATED';
 assert.equal(capture(unknown,false).code,'UNRELATED');assert.equal(unknown.message,'Other failure: EFFORT_SELECTOR_NOT_READY');
});

test('unknown native readiness observation errors are never recoded or retried as selector readiness',async()=>{
 const f=fixture();const original=new Error('JavaScript evaluation failed: unrelated read failure');original.code='UNRELATED';
 const evaluate=f.page.evaluate;f.page.evaluate=async(fn,arg)=>{if(fn.toString().includes('const transitions=pickers[0]'))throw original;return evaluate(fn,arg);};
 await assert.rejects(f.api.applyModelSpec(f.page,'Latest','Extra High'),error=>error===original&&error.code==='UNRELATED');
 assert.equal(f.calls.opens,3);assert.equal(f.calls.arrows,0);assert.equal(f.calls.send,0);
});

test('canonical readiness keeps the existing bounded pre-send retry gate and never authorizes an attempted send',()=>{
 const script=[
  'import importlib.util,json,sys',
  'spec=importlib.util.spec_from_file_location("selector_retry_gate",sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
  'guard=module.pre_send_retry_after',
  'receipt={"ok":False,"deliveryStage":"PRE_SEND","code":"EFFORT_SELECTOR_NOT_READY"}',
  'rows=[{"pre_send_failures":n} for n in range(module.PRE_SEND_RETRY_LIMIT)]',
  'checks=[guard(rows[0],receipt)>0,guard(rows[-1],receipt) is None,guard(rows[0],dict(receipt,deliveryStage="SEND_ATTEMPTED")) is None,guard(rows[0],dict(receipt,code="JavaScript evaluation failed: EFFORT_SELECTOR_NOT_READY")) is None,guard(rows[0],dict(receipt,code="Other failure: EFFORT_SELECTOR_NOT_READY")) is None,guard(rows[0],None) is None]',
  'print(json.dumps(checks))',
 ].join('\n');
 const result=spawnSync('python3',['-c',script,new URL('../src/coordinator.py',import.meta.url).pathname],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),Array(6).fill(true));
});
test('trusted effort readiness result is validated in Node before any Power input',async()=>{
 const f=fixture({selectorPurpose:'effort',selectorResult:{tag:'MODEL_PICKER_READINESS',code:'EFFORT_SELECTOR_NOT_READY'},wrapEvaluationErrors:true});
 await assert.rejects(f.api.setEffort(f.page,'Extra High'),error=>error.code==='EFFORT_SELECTOR_NOT_READY'&&error.message==='EFFORT_SELECTOR_NOT_READY');
 assert.equal(f.calls.effortFocus,0);assert.equal(f.calls.arrows,0);assert.equal(f.calls.send,0);
});
