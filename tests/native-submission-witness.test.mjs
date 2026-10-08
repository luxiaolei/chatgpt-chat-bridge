
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const fixture=JSON.parse(await readFile(new URL('./native-submission-fixture.json',import.meta.url),'utf8'));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const helper=source.slice(source.indexOf('async function nativeSubmissionWitness('),source.indexOf('\nasync function sendMessage('));
const getter='getText(){let e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:this.dictation.document;return(0,T.g)(e,this.plainTextMode?void 0:this.markdownEditor?.serialize)}';
const prepare=new AsyncFunction('crypto','COMPOSER_SELECTOR','normalizedEvidenceText','saveDraftBackup',helper+';return nativeSubmissionWitness;');
const prepareProbe=new AsyncFunction(helper+';return nativeSubmissionProbe;');
async function inspect(change=()=>{},capabilityOnly=false) {
 const doc={content:{size:fixture.request.length},textBetween:()=>fixture.request};
 const composer={pmViewDesc:{node:doc},parentElement:null};
 const editor={...new Function('T','return {'+getter+'};')({g:()=>fixture.body}),view:{dom:composer,state:{doc}},dictation:{document:doc},plainTextMode:false,markdownEditor:{serialize:()=>fixture.body}};
 const host={__reactFiber$fixture:{memoizedProps:{onSubmit:new Function('return e=>{eg(j.getText(),e)}')()},memoizedState:{memoizedState:{deps:[null,editor]}}}};
 composer.parentElement=host;
 const env={composers:[composer],id:'registered-user-id',email:'verified@example.test',identity:'verified@example.test',request:fixture.request};
 change({doc,composer,editor,host,env});
 const prior=new Map(['document','location','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 try {
 Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:()=>env.composers}});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111'}});
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>({json:async()=>({user:{email:env.email,id:env.id}})})});
 const save=async(backup,directory)=>{
  if(env.retentionFailure) throw new Error('PRIVATE_RETENTION_FAILED');
  env.retained={backup,directory};
  return {path:'/private/native-format-evidence.json',sha256:'f'.repeat(64),bytes:JSON.stringify(backup).length};
 };
 if(env.discardBackup) return await (await prepareProbe())({selector:'composer',expectedIdentity:env.identity,discardBackup:env.discardBackup});
 return await (await prepare(crypto,'composer',v=>v.replace(/\s+/g,' ').trim(),save))({...env.page,evaluate:async(fn,args)=>fn(args)},env.request,env.identity,capabilityOnly);
 } finally {for(const [k,d] of prior){if(d)Object.defineProperty(globalThis,k,d);else delete globalThis[k];}}
}
test('native getter requires unique composer/doc, verified account and exact characterized submit path',async()=>{
 const witness=await inspect();
 assert.equal((await inspect(({env})=>env.identity='registered-user-id')).body,fixture.body);
 assert.equal(witness.body,fixture.body);
 assert.equal(witness.requestHash,crypto.createHash('sha256').update(fixture.request.replace(/\s+/g,' ').trim()).digest('hex'));
 for(const change of [
 ({env})=>env.email='other@example.test',({env})=>env.identity=null,({env})=>env.composers.push({}),
 ({editor})=>editor.view.dom={},({editor})=>editor.dictation.document={},({editor})=>editor.view.state.doc={},
 ({editor})=>editor.getText=()=>fixture.body,({editor})=>editor.plainTextMode=true,({env})=>env.request+=' changed footer',
 ({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{},
 ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor}),
 ({editor})=>editor.markdownEditor.serialize=null]) await assert.rejects(inspect(change),/NATIVE_SUBMISSION_UNVERIFIED/);
});


test('persisted/error witness metadata never contains secret body, identity or native implementation source',()=>{
 const receiptSource=source.slice(source.indexOf('function nativeWitnessReceipt('),source.indexOf('\nasync function nativeSubmissionWitness('));
 const redact=new Function('crypto','normalizedEvidenceText',receiptSource+';return nativeWitnessReceipt;')(crypto,v=>v.replace(/\s+/g,' ').trim());
 const witness={format:'chatgpt-native-getText-v1',body:'SECRET-BODY-12345 private footer',accountIdentity:'SECRET-ACCOUNT-98765',
 getterSource:'SECRET-GETTER-CODE',serializerSource:'SECRET-SERIALIZER-CODE',requestHash:'a'.repeat(64),bodyHash:'b'.repeat(64),url:'https://chatgpt.com/c/bound',observedAt:new Date().toISOString()};
 const serialized=JSON.stringify(redact(witness,'actual-message'));
 for(const secret of ['SECRET-BODY','SECRET-ACCOUNT','SECRET-GETTER','SECRET-SERIALIZER']) assert.equal(serialized.includes(secret),false);
 assert.equal(redact(witness).requestHash,witness.requestHash);
 assert.equal(redact(witness).bodyHash,witness.bodyHash);
 assert.equal(redact(witness,'actual-message').messageId,'actual-message');
});

const currentFormat=JSON.parse(await readFile(new URL('./native-submission-current-fixture.json',import.meta.url),'utf8'));
const characterizedShape=JSON.parse(await readFile(new URL('./native-submission-characterized-shape-fixture.json',import.meta.url),'utf8'));
function inspectCharacterized(change=()=>{},capabilityOnly=false) {
 return inspect(context=>{
  const {doc,editor,host}=context,native={body:fixture.body,getterCalls:0,serializerCalls:0};
  doc.type={schema:{marks:{literalPaste:{}}}};
  doc.content.content=[{type:{name:'paragraph'}}];doc.childCount=1;
  doc.child=()=>doc.content.content[0];doc.descendants=()=>{};
  const serialize=new Function('C','s','T','o','e','t','return ('+characterizedShape.serializerSource+');')(
   {m:class{constructor(value){assert.equal(value,doc);}removeMark(){return {doc};}}},
   {b:value=>value},{g:()=>false},{b:()=>null},
   {serialize:()=>{native.serializerCalls++;return native.body+'\n';}},new Map());
  editor.markdownEditor.serialize=serialize;
  editor.getText=new Function('M','return {'+characterizedShape.getter+'};')({g:(value,serializer)=>{
   native.getterCalls++;assert.equal(value,doc);if(native.error)throw native.error;
   if(Object.hasOwn(native,'output'))return native.output;
   return serializer(value);
  }}).getText;
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+characterizedShape.submit)();
  change({...context,native});
 },capabilityOnly);
}

test('complete observed FORMAT shape admits only its native getter/serializer with exact document binding',async()=>{
 for(const key of ['submit','getter','serializerSource'])
  assert.equal(crypto.createHash('sha256').update(characterizedShape[key]).digest('hex'),characterizedShape[key==='serializerSource'?'serializerSha256':key+'Sha256']);
 let native;
 const witness=await inspectCharacterized(context=>{
  native=context.native;
  Object.defineProperty(context.editor.dictation,'document',{get:()=>context.doc});
 });
 assert.equal(witness.body,fixture.body);
 assert.equal(witness.getterSource,characterizedShape.getter);
 assert.equal(witness.serializerSource,characterizedShape.serializerSource);
 assert.equal(native.getterCalls,1);assert.equal(native.serializerCalls,1);
 const support=await inspectCharacterized(context=>{
  context.doc.textBetween=()=>{throw new Error('capability must not read body');};
  context.native.error=new Error('capability must not call getter');
 },true);
 assert.equal(support.supported,true);
});

test('characterized submit shape tolerates identifier renaming without accepting a different expression',async()=>{
 for(const submit of ['v=>submit(editor.getText(),v)','$e=>_send($editor.getText(),$e)'])
  assert.equal((await inspectCharacterized(({host})=>{
   host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+submit)();
  })).body,fixture.body);
 for(const submit of [
  'e=>dh(rE.getText().trim(),e)','e=>dh(rE.getText(e),e)','e=>dh(rE.getText(),other)',
  'e=>dh(rE.getText(),e,extra)','e=>dh(other.getText(),e)||extra()',
  'e=>{dh(rE.getText(),e);extra()}','e=>e(rE.getText(),e)','e=>dh(e.getText(),e)',
  'e=>rE(rE.getText(),e)',
 ]) await assert.rejects(inspectCharacterized(({host})=>{
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+submit)();
 }),error=>{assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');return true;});
});

test('uncharacterized getter or serializer stays FORMAT UNSUPPORTED with zero native calls',async()=>{
 for(const field of ['getter','serializer','getterToString','serializerToString']) {
  let native,calls=0;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   const spoof=()=>{calls++;return fixture.body;};
   if(field.startsWith('getter')) {context.editor.getText=spoof;if(field==='getterToString')spoof.toString=()=>characterizedShape.getter;}
   else {context.editor.markdownEditor.serialize=spoof;if(field==='serializerToString')spoof.toString=()=>characterizedShape.serializerSource;}
  }),error=>{assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');return true;});
  assert.equal(calls,0);assert.equal(native.getterCalls,0);assert.equal(native.serializerCalls,0);
 }
});

test('characterized implementations use intrinsic source and never custom toString or opaque method accessors',async()=>{
 let calls=0;
 const witness=await inspectCharacterized(({editor})=>{
  editor.getText.toString=editor.markdownEditor.serialize.toString=()=>{calls++;throw new Error('custom toString');};
  for(const fn of [editor.getText,editor.markdownEditor.serialize]) Object.defineProperty(fn,Symbol.toPrimitive,{get(){calls++;throw new Error('custom primitive');}});
 });
 assert.equal(witness.body,fixture.body);assert.equal(calls,0);
 for(const field of ['getText','serialize']) {
  await assert.rejects(inspectCharacterized(({editor})=>{
   Object.defineProperty(field==='getText'?editor:editor.markdownEditor,field,{get(){calls++;throw new Error('opaque method');}});
  },true),error=>{assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');return true;});
  assert.equal(calls,0);
 }
});

test('characterized shape rejects foreign/changed docs, account, full request and ambiguous editor binding',async()=>{
 for(const change of [
  ({editor})=>Object.defineProperty(editor.dictation,'document',{get:()=>({})}),
  ({editor})=>editor.view.state.doc={},({editor})=>editor.view.dom={},
  ({composer})=>composer.pmViewDesc.node={},({editor})=>editor.plainTextMode=true,
  ({env})=>env.email='other@example.test',({env})=>env.request+=' changed footer',
  ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor}),
  ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor,getText:()=>fixture.body}),
 ]) await assert.rejects(inspectCharacterized(change),/NATIVE_SUBMISSION_UNVERIFIED/);
 for(const changeDoc of [({editor})=>editor.dictation.document={},({editor})=>editor.view.state.doc={},({composer})=>composer.pmViewDesc.node={}])
  await assert.rejects(inspectCharacterized(context=>{
   context.doc.descendants=()=>changeDoc(context);
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
 for(const output of ['',42]) await assert.rejects(inspectCharacterized(({native})=>native.output=output),/NATIVE_SUBMISSION_UNVERIFIED/);
 await assert.rejects(inspectCharacterized(({native})=>native.error=new Error('native getter failure')),/native getter failure/);
 const witness=await inspectCharacterized(({host,editor})=>{
  host.__reactFiber$fixture.memoizedState.next={memoizedState:{deps:[editor]}};
 });
 assert.equal(witness.body,fixture.body);
});

test('function source spoofing, proxies and bound functions cannot admit an unknown characterized method',async()=>{
 for(const field of ['getText','serialize','onSubmit']) for(const kind of ['toPrimitive','accessorToString','proxy','bound']) {
  let calls=0,native;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   const holder=field==='getText'?context.editor:field==='serialize'?context.editor.markdownEditor:context.host.__reactFiber$fixture.memoizedProps;
   const original=holder[field],originalSource=Function.prototype.toString.call(original);
   let spoof=()=>{calls++;throw new Error('unverified function invoked');};
   if(kind==='toPrimitive') spoof[Symbol.toPrimitive]=()=>{calls++;return originalSource;};
   if(kind==='accessorToString') Object.defineProperty(spoof,'toString',{get(){calls++;return ()=>originalSource;}});
   if(kind==='proxy') spoof=new Proxy(original,{apply(){calls++;return fixture.body;}});
   if(kind==='bound') spoof=original.bind(context.editor);
   holder[field]=spoof;
  },true),error=>{assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');return true;});
  assert.equal(calls,0);assert.equal(native.getterCalls,0);assert.equal(native.serializerCalls,0);
 }
});

test('native witness uses one validated method snapshot and rejects changes before or during the getter',async()=>{
 for(const stage of ['before','during']) for(const field of ['getText','serialize','dictation','markdownEditor','view','composer']) {
  let native,calls=0;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   const change=()=>{
    const {editor,env}=context;
    if(field==='getText') editor.getText=()=>{calls++;return fixture.body;};
    if(field==='serialize') editor.markdownEditor.serialize=()=>{calls++;return fixture.body;};
    if(field==='dictation') editor.dictation={document:{...context.doc}};
    if(field==='markdownEditor') editor.markdownEditor={...editor.markdownEditor};
    if(field==='view') editor.view={...editor.view};
    if(field==='composer') env.composers.push({});
   };
   if(stage==='before') context.doc.textBetween=()=>{change();return fixture.request;};
   else context.doc.descendants=change;
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(calls,0);assert.equal(native.getterCalls,stage==='before'?0:1);
 }
});

test('document validation cannot swap an uncharacterized method into capability or body admission',async()=>{
 for(const capabilityOnly of [true,false]) {
  let native,calls=0;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   Object.defineProperty(context.editor.dictation,'document',{get(){
    context.editor.getText=()=>{calls++;return fixture.body;};
    return context.doc;
   }});
  },capabilityOnly),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(calls,0);assert.equal(native.getterCalls,0);
 }
 for(const field of ['dictation','view','composer']) {
  let native;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   context.doc.textBetween=()=>{
    if(field==='dictation') context.editor.dictation.document={...context.doc};
    if(field==='view') context.editor.view.state.doc={...context.doc};
    if(field==='composer') context.composer.pmViewDesc.node={...context.doc};
    return fixture.request;
   };
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(native.getterCalls,0);
 }
});

test('dictation accessors follow the native getter path without treating an unsampled descriptor as another document',async()=>{
 let reads=0,native;
 const witness=await inspectCharacterized(context=>{
  native=context.native;
  const dictation=context.editor.dictation;
  Object.defineProperty(dictation,'document',{get(){reads++;return context.doc;}});
  Object.defineProperty(context.editor,'dictation',{get(){reads++;return dictation;}});
 });
 assert.equal(witness.body,fixture.body);assert(reads>0);
 assert.equal(native.getterCalls,1);assert.equal(native.serializerCalls,1);
 let calls=0;
 await assert.rejects(inspectCharacterized(({editor})=>{
  editor.getText=()=>fixture.body;
  Object.defineProperty(editor,'dictation',{get(){calls++;throw new Error('unknown shape must not read dictation');}});
 },true),error=>{assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');return true;});
 assert.equal(calls,0);
 await assert.rejects(inspectCharacterized(({editor})=>{
  Object.defineProperty(editor,'dictation',{get:()=>({document:{}})});
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
});

// Root NSV2-R1/R2 are offline counterexamples built from the characterized getter
// and synthetic dependencies. No private DOM or body is copied into these cases.
test('NSV2-R1 native execution cannot consume a foreign default document hidden by accessor ABA',async t=>{
 const observations=[];
 for(const foreignAt of [null,4,5,'after-getter']) {
  let reads=0,getterCalls=0,foreignGetterCalls=0;
  const outcome=await inspectCharacterized(context=>{
   const {doc,editor}=context,foreign={syntheticBody:'FOREIGN SYNTHETIC BODY'};
   const serializer=editor.markdownEditor.serialize;
   editor.getText=new Function('M','return {'+characterizedShape.getter+'};')({g:(actualDoc,actualSerializer)=>{
    getterCalls++;
    assert.equal(actualSerializer,serializer);
    if(actualDoc!==doc) {foreignGetterCalls++;assert.equal(actualDoc,foreign);return foreign.syntheticBody;}
    return fixture.body;
   }}).getText;
   Object.defineProperty(editor.dictation,'document',{get(){
    reads++;
    return (foreignAt==='after-getter'?getterCalls>0:reads===foreignAt)?foreign:doc;
   }});
  }).then(witness=>({status:'ACCEPTED',bodyIsOriginal:witness.body===fixture.body}),
   error=>({status:'REJECTED',error:error.message}));
  observations.push({foreignAt,reads,getterCalls,foreignGetterCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.foreignGetterCalls,0,'the actual native getter must consume only the verified document');
  if(row.status==='ACCEPTED') assert.equal(row.bodyIsOriginal,true,'foreign body must never become a witness');
  else assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  if(row.foreignAt===null) assert.equal(row.status,'ACCEPTED');
  if(row.foreignAt==='after-getter') assert.equal(row.status,'REJECTED','post-getter document conflicts still reject');
 }
});

test('NSV2-R2 capability and body require a complete bounded ancestor scan before editor uniqueness',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const mode of [
  'second-at-15','second-at-16','complete-16','incomplete-17','cycle','opaque-return','prototype-limit'
 ]) {
  let native,returnGetterCalls=0;
  const outcome=await inspectCharacterized(context=>{
   native=context.native;
   const first=context.host.__reactFiber$fixture;
   const lastAncestor=mode==='second-at-16'||mode==='incomplete-17'?16:15;
   let current=first;
   for(let ancestor=1;ancestor<=lastAncestor;ancestor++) {
    current.return={};
    current=current.return;
   }
   current.return=mode==='cycle'?first:null;
   if(mode==='opaque-return') Object.defineProperty(current,'return',{get(){returnGetterCalls++;return first;}});
   if(mode==='prototype-limit') {
    delete current.return;
    let owner=current;
    for(let depth=0;depth<8;depth++) {const parent={};Object.setPrototypeOf(owner,parent);owner=parent;}
    owner.return=first;
   }
   if(mode.startsWith('second-at-')) {
    current.memoizedProps=first.memoizedProps;
    current.memoizedState={memoizedState:{deps:[{...context.editor}]}};
   }
  },capabilityOnly).then(witness=>({status:'ACCEPTED',valid:capabilityOnly?witness.supported:witness.body===fixture.body}),
   error=>({status:'REJECTED',error:error.message}));
  observations.push({capabilityOnly,mode,returnGetterCalls,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  const expected=row.mode==='complete-16'?'ACCEPTED':'REJECTED';
  assert.equal(row.returnGetterCalls,0,'opaque ancestor links must never be invoked');
  assert.equal(row.status,expected,JSON.stringify({capabilityOnly:row.capabilityOnly,mode:row.mode}));
  if(row.status==='ACCEPTED') assert.equal(row.valid,true);
  else {
   assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
   assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
  }
  if(row.capabilityOnly) {assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);}
 }
});

// Only synthetic hook/editor dependencies; the characterized native methods stay unchanged.
function configureHookScanField(context,field,kind,{sameEditor=false,counts={opaqueCalls:0}}={}) {
 const {host,editor}=context,fiber=host.__reactFiber$fixture,first=fiber.memoizedState;
 const hidden={memoizedState:{deps:[sameEditor?editor:{...editor}]},next:null};
 let owner,key,linked;
 if(field==='entry') {
  fiber.return={memoizedProps:fiber.memoizedProps,return:null};
  owner=fiber.return;key='memoizedState';linked=hidden;
 } else if(field==='next') {owner=first;key='next';linked=hidden;}
 else {
  first.next={next:null};
  if(field==='state') {owner=first.next;key='memoizedState';linked=hidden.memoizedState;}
  else {first.next.memoizedState={};owner=first.next.memoizedState;key='deps';linked=hidden.memoizedState.deps;}
 }
 if(kind==='accessor') Object.defineProperty(owner,key,{get(){counts.opaqueCalls++;return linked;}});
 else {
  const depth=kind==='prototype-8'?8:7;
  for(let i=0;i<depth;i++) {const parent={};Object.setPrototypeOf(owner,parent);owner=parent;}
  owner[key]=linked;
 }
 return counts;
}

test('NSV2-R2-HOOK opaque or exhausted hook scan fields cannot hide a second editor',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const field of ['next','entry','state','deps']) for(const kind of ['accessor','prototype-8']) {
  let native;const counts={opaqueCalls:0};
  const outcome=await inspectCharacterized(context=>{
   native=context.native;configureHookScanField(context,field,kind,{counts});
  },capabilityOnly).then(witness=>({status:'ACCEPTED',valid:capabilityOnly?witness.supported:witness.body===fixture.body}),
   error=>({status:'REJECTED',error:error.message}));
  observations.push({capabilityOnly,field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.opaqueCalls,0,JSON.stringify(row));
  assert.equal(row.status,'REJECTED',JSON.stringify(row));
  assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
 }
});

test('NSV2-R2-HOOK finite data links preserve compatibility at prototype and hook bounds',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const mode of ['entry','next','state','deps','complete-64','incomplete-65','cycle']) {
  let native;const counts={opaqueCalls:0};
  const outcome=await inspectCharacterized(context=>{
   native=context.native;
   if(['entry','next','state','deps'].includes(mode)) configureHookScanField(context,mode,'prototype-7',{sameEditor:true,counts});
   else {
    const first=context.host.__reactFiber$fixture.memoizedState;
    let hook=first;
    for(let i=1;i<64;i++) {hook.next={memoizedState:{deps:[context.editor]}};hook=hook.next;}
    if(mode==='incomplete-65') hook.next={memoizedState:{deps:[{...context.editor}]}};
    if(mode==='cycle') hook.next=first;
   }
  },capabilityOnly).then(witness=>({status:'ACCEPTED',valid:capabilityOnly?witness.supported:witness.body===fixture.body}),
   error=>({status:'REJECTED',error:error.message}));
  observations.push({capabilityOnly,mode,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  const rejected=['incomplete-65','cycle'].includes(row.mode);
  assert.equal(row.status,rejected?'REJECTED':'ACCEPTED',JSON.stringify(row));
  assert.equal(row.opaqueCalls,0);
  if(rejected) assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  else assert.equal(row.valid,true);
  assert.equal(row.getterCalls,rejected||row.capabilityOnly?0:1);
  assert.equal(row.serializerCalls,rejected||row.capabilityOnly?0:1);
 }
});

test('NSV2-R2-HOOK unknown FORMAT diagnostics retain incomplete hook scans without executing opaque links',async t=>{
 const observations=[];
 for(const field of ['next','entry','state','deps']) for(const kind of ['accessor','prototype-8']) {
  let captured,native;const counts={opaqueCalls:0};
  await assert.rejects(inspectCharacterized(context=>{
   captured=context.env;native=context.native;
   configureHookScanField(context,field,kind,{counts});
   context.host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{};
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  observations.push({field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,
   truncated:captured.retained.backup.truncated,limit:captured.retained.backup.limit});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.opaqueCalls,0);assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
  assert.equal(row.truncated,true,JSON.stringify(row));assert.equal(row.limit,'HOOK_SCAN_INCOMPLETE',JSON.stringify(row));
 }
});

// Exercise actual probe paths with synthetic object graphs, without a live page or private body.
function configureScanProperty(owner,key,kind,linked,counts) {
 delete owner[key];
 if(kind==='accessor') Object.defineProperty(owner,key,{configurable:true,enumerable:true,get(){counts.opaqueCalls++;return linked;}});
 else {
  const depth=kind==='prototype-8'?8:kind==='prototype-7'?7:0;
  for(let i=0;i<depth;i++) {const parent={};Object.setPrototypeOf(owner,parent);owner=parent;}
  owner[key]=linked;
 }
}
function configureOwnershipEdge(context,field,kind,counts,foreign=false) {
 const {host,editor}=context,second={...editor,view:{...editor.view,dom:foreign?{}:context.composer}};
 const deps=host.__reactFiber$fixture.memoizedState.memoizedState.deps=[editor,second];
 if(foreign) for(const key of ['getText','markdownEditor','dictation'])
  Object.defineProperty(second,key,{get(){counts.opaqueCalls++;throw new Error('known foreign editor must not be inspected');}});
 const [owner,key,linked]=field==='dependency'?[deps,'1',second]:
  field==='view'?[second,'view',second.view]:[second.view,'dom',second.view.dom];
 configureScanProperty(owner,key,kind,linked,counts);
}
const ownershipOutcome=capabilityOnly=>witness=>({status:'ACCEPTED',witnessPresent:witness!=null,
 valid:capabilityOnly?witness?.supported===true:witness?.body===fixture.body});
const ownershipError=error=>({status:'REJECTED',error:error.message});

test('NSV2-OWNERSHIP unreadable dependency view or DOM cannot hide a second editor in any shared mode',async t=>{
 const observations=[];
 for(const mode of ['capability','body','discard']) for(const field of ['dependency','view','dom']) for(const kind of ['accessor','prototype-8']) {
  let native;const counts={opaqueCalls:0,transactionReads:0};
  const outcome=await inspectCharacterized(context=>{
   native=context.native;configureOwnershipEdge(context,field,kind,counts);
   if(mode==='discard') {
    context.env.discardBackup={document:{synthetic:true}};
    Object.defineProperty(context.editor.view.state,'tr',{get(){counts.transactionReads++;throw new Error('SYNTHETIC_DISCARD_MUTATION_BOUNDARY');}});
   }
  },mode==='capability').then(ownershipOutcome(mode==='capability'),ownershipError);
  observations.push({mode,field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.status,'REJECTED',JSON.stringify(row));
  assert.match(row.error,row.mode==='discard'?/DRAFT_DISCARD_UNSUPPORTED/:/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.opaqueCalls,0);assert.equal(row.transactionReads,0);
  assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
 }
});

test('NSV2-OWNERSHIP complete data and depth7 distinguish a second owner from a known foreign DOM',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const field of ['dependency','view','dom']) for(const kind of ['data','prototype-7']) for(const foreign of [false,true]) {
  let native;const counts={opaqueCalls:0};
  const outcome=await inspectCharacterized(context=>{
   native=context.native;configureOwnershipEdge(context,field,kind,counts,foreign);
  },capabilityOnly).then(ownershipOutcome(capabilityOnly),ownershipError);
  observations.push({capabilityOnly,field,kind,foreign,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.status,row.foreign?'ACCEPTED':'REJECTED',JSON.stringify(row));
  assert.equal(row.opaqueCalls,0);
  if(row.foreign) assert.equal(row.valid,true);
  else assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.getterCalls,row.foreign&&!row.capabilityOnly?1:0);
  assert.equal(row.serializerCalls,row.foreign&&!row.capabilityOnly?1:0);
 }
});

test('NSV2-OWNERSHIP root props and document entry reads cannot become absent or legacy fallback',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const field of ['react-entry','props','onSubmit','pmViewDesc','node']) for(const kind of (field==='react-entry'?['accessor']:['accessor','prototype-8'])) {
  let native;const counts={opaqueCalls:0};
  const outcome=await inspectCharacterized(context=>{
   native=context.native;
   const {composer,host,editor}=context,first=host.__reactFiber$fixture;
   const hidden={memoizedProps:first.memoizedProps,memoizedState:{memoizedState:{deps:[{...editor}]}},return:null};
   let owner,key,linked;
   if(field==='react-entry') {owner=composer;key='__reactFiber$hidden';linked=hidden;}
   else if(field==='pmViewDesc') {owner=composer;key='pmViewDesc';linked=composer.pmViewDesc;}
   else if(field==='node') {owner=composer.pmViewDesc;key='node';linked=context.doc;}
   else {
    first.return=hidden;
    if(field==='props') {owner=hidden;key='memoizedProps';linked=hidden.memoizedProps;}
    else {hidden.memoizedProps={};owner=hidden.memoizedProps;key='onSubmit';linked=first.memoizedProps.onSubmit;}
   }
   configureScanProperty(owner,key,kind,linked,counts);
  },capabilityOnly).then(ownershipOutcome(capabilityOnly),ownershipError);
  observations.push({capabilityOnly,field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.status,'REJECTED',JSON.stringify(row));assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.opaqueCalls,0);assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
 }
});

test('NSV2-OWNERSHIP format matching cannot filter out another composer-bound editor',async t=>{
 const observations=[];
 for(const capabilityOnly of [true,false]) for(const handler of ['unmatched-data','missing']) for(const foreign of [false,true]) {
  let native;
  const outcome=await inspectCharacterized(context=>{
   native=context.native;
   const {host,editor,composer}=context,first=host.__reactFiber$fixture;
   first.return={memoizedProps:handler==='missing'?{}:{onSubmit:()=>{}},
    memoizedState:{memoizedState:{deps:[{...editor,view:{...editor.view,dom:foreign?{}:composer}}]}},return:null};
  },capabilityOnly).then(ownershipOutcome(capabilityOnly),ownershipError);
  observations.push({capabilityOnly,handler,foreign,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.status,row.foreign?'ACCEPTED':'REJECTED',JSON.stringify(row));
  if(row.foreign) assert.equal(row.valid,true);else assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.getterCalls,row.foreign&&!row.capabilityOnly?1:0);
  assert.equal(row.serializerCalls,row.foreign&&!row.capabilityOnly?1:0);
 }
});

test('NSV2-OWNERSHIP sameBinding rejects fields made opaque before or during native execution',async t=>{
 const observations=[];
 const fields=['view','dom','state','doc','markdownEditor','getText','serialize','plainTextMode','pmViewDesc','node'];
 for(const phase of ['before-capability','before-body','after-body']) for(const [index,field] of fields.entries()) {
  let native,reads=0,armed=false;const counts={opaqueCalls:0};
  const kind=index%2?'prototype-8':'accessor';
  const outcome=await inspectCharacterized(context=>{
   native=context.native;const {editor,composer,doc}=context;
   const view=editor.view,markdown=editor.markdownEditor;
   const objects={view:[editor,'view'],dom:[view,'dom'],state:[view,'state'],doc:[view.state,'doc'],
    markdownEditor:[editor,'markdownEditor'],getText:[editor,'getText'],serialize:[markdown,'serialize'],
    plainTextMode:[editor,'plainTextMode'],pmViewDesc:[composer,'pmViewDesc'],node:[composer.pmViewDesc,'node']};
   const [owner,key]=objects[field],linked=owner[key];
   const hide=()=>{if(!armed){armed=true;configureScanProperty(owner,key,kind,linked,counts);}};
   if(phase==='after-body') doc.descendants=hide;
   else Object.defineProperty(editor.dictation,'document',{get(){if(++reads===2)hide();return doc;}});
  },phase==='before-capability').then(ownershipOutcome(phase==='before-capability'),ownershipError);
  observations.push({phase,field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,...outcome});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.status,'REJECTED',JSON.stringify(row));assert.match(row.error,/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(row.opaqueCalls,0);
  assert.equal(row.getterCalls,row.phase==='after-body'?1:0);
  assert.equal(row.serializerCalls,row.phase==='after-body'?1:0);
 }
});

test('NSV2-OWNERSHIP unknown FORMAT retains unreadable ownership diagnostics without native calls',async t=>{
 const observations=[];
 for(const field of ['dependency','view','dom']) for(const kind of ['accessor','prototype-8']) {
  let captured,native;const counts={opaqueCalls:0};
  await assert.rejects(inspectCharacterized(context=>{
   captured=context.env;native=context.native;configureOwnershipEdge(context,field,kind,counts);
   context.host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{};
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  observations.push({field,kind,...counts,getterCalls:native.getterCalls,serializerCalls:native.serializerCalls,
   truncated:captured.retained.backup.truncated,limit:captured.retained.backup.limit});
 }
 t.diagnostic(JSON.stringify(observations));
 for(const row of observations) {
  assert.equal(row.opaqueCalls,0);assert.equal(row.getterCalls,0);assert.equal(row.serializerCalls,0);
  assert.equal(row.truncated,true,JSON.stringify(row));assert.equal(row.limit,'EDITOR_OWNERSHIP_SCAN_INCOMPLETE',JSON.stringify(row));
 }
});

test('NSV2-OWNERSHIP complete missing optional fields and legacy composer absence retain their contract',async()=>{
 for(const capabilityOnly of [true,false]) {
  const witness=await inspectCharacterized(({host})=>{
   const deps=host.__reactFiber$fixture.memoizedState.memoizedState.deps;
   deps.push(null,undefined,{}, {view:null}, {view:{}});deps.length++;
  },capabilityOnly);
  assert.equal(capabilityOnly?witness.supported:witness.body===fixture.body,true);
  for(const field of ['pmViewDesc','node']) assert.equal(await inspect(({composer})=>{
   if(field==='pmViewDesc')delete composer.pmViewDesc;else delete composer.pmViewDesc.node;
  },capabilityOnly),null);
 }
});

test('admission refuses truncated editor dependencies, hooks and serializer source',async()=>{
 for(const mode of ['dependencies','hooks']) {
  let native;
  await assert.rejects(inspectCharacterized(context=>{
   native=context.native;
   const fiber=context.host.__reactFiber$fixture;
   if(mode==='dependencies') fiber.memoizedState.memoizedState.deps=[context.editor,...Array(63).fill(null),{...context.editor}];
   else {
    let hook=fiber.memoizedState;
    for(let i=1;i<64;i++) {hook.next={memoizedState:{deps:[]}};hook=hook.next;}
    hook.next={memoizedState:{deps:[{...context.editor}]}};
   }
  },true),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(native.getterCalls,0);assert.equal(native.serializerCalls,0);
 }
 await assert.rejects(inspect(({editor})=>{
  editor.markdownEditor.serialize=new Function('/*'+'x'.repeat(16*1024)+'*/');
 },true),/NATIVE_SUBMISSION_UNVERIFIED/);
});

test('current native submit/getter pair is admitted exactly and mixed aliases fail closed',async()=>{
 const configure=({host,editor})=>{
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+currentFormat.submit)();
  editor.getText=new Function('M','return {'+currentFormat.getter+'};')({g:()=>fixture.body}).getText;
 };
 const witness=await inspect(configure);
 assert.equal(witness.body,fixture.body);
 assert.equal(crypto.createHash('sha256').update(witness.getterSource).digest('hex'),currentFormat.getterSha256);
 await assert.rejects(inspect(({host})=>{
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+currentFormat.submit)();
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
 await assert.rejects(inspect(({editor})=>{
  editor.getText=new Function('M','return {'+currentFormat.getter+'};')({g:()=>fixture.body}).getText;
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
 await assert.rejects(inspect(({host,editor})=>{
  configure({host,editor});
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>up(X.getText(),e)')();
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
});

const persistedFormat=JSON.parse(await readFile(new URL('./native-submission-persisted-text-fixture.json',import.meta.url),'utf8'));
function inspectPersisted(change=()=>{}) {
 return inspect(context=>{
  const {doc,editor,host}=context;
  const native={formatted:true,persistedBody:fixture.body,plainBody:fixture.request};
  doc.descendants=()=>{};
  const x={f:value=>{
   assert.equal(value,doc);if(native.error)throw native.error;return {content:native.plainBody};
  },d:value=>{assert.equal(value,doc);return native.formatted;},b:()=>null};
  Object.assign(editor,new Function('x','E','return {'+[
   persistedFormat.getter,persistedFormat.hasMarkdownFormatting,persistedFormat.getPersistedText
  ].join(',')+'};')(x,{c:()=>false}));
  editor.markdownEditor.serialize=value=>{assert.equal(value,doc);return native.persistedBody;};
  host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+persistedFormat.submit)();
  change({...context,native});
 });
}

test('captured persisted-text native format produces a witness and deduplicates the same editor across hooks',async()=>{
 const witness=await inspectPersisted(({host,editor})=>{
  host.__reactFiber$fixture.memoizedState.next={memoizedState:{deps:[editor]}};
 });
 assert.equal(witness.body,fixture.body);
 assert.equal(witness.getterSource,persistedFormat.getter);
 assert.equal(witness.bodyHash,crypto.createHash('sha256').update(fixture.body).digest('hex'));
});

test('QuantCompany captured F editor alias preserves the exact persisted getter checks',async()=>{
 const alias=({host})=>{host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>{ev(F.getText(),e)}')();};
 const witness=await inspectPersisted(alias);
 assert.equal(witness.body,fixture.body);
 await assert.rejects(inspectPersisted(context=>{alias(context);context.editor.getText=()=>fixture.body;}),/NATIVE_SUBMISSION_UNVERIFIED/);
 await assert.rejects(inspectPersisted(({host})=>{host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>{ev(Z.getText(),e)}')();}),/NATIVE_SUBMISSION_UNVERIFIED/);
});

test('persisted native getter preserves its plain, entity-only and trailing-space branches',async()=>{
 const plain=await inspectPersisted(({native})=>native.formatted=false);
 assert.equal(plain.body,fixture.request);
 const empty=await inspectPersisted(({native})=>native.persistedBody='&#x20;');
 assert.equal(empty.body,fixture.request);
 const spaced=await inspectPersisted(({doc,native})=>{
  doc.lastChild={textContent:'native trailing '};
  native.persistedBody=fixture.body+'&#x20;';
 });
 assert.equal(spaced.body,fixture.body+' ');
});

test('persisted native format rejects uncharacterized pairs and broken identity, document or method binding',async()=>{
 for(const change of [
  ({env})=>env.email='other@example.test',
  ({env})=>env.identity=null,
  ({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>{eg(j.getText(),e)}')(),
  ({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>{ev(OTHER.getText(),e)}')(),
  ({editor})=>editor.getText=new Function('T','return {'+getter+'};')({g:()=>fixture.body}).getText,
  ({editor})=>editor.getText=new Function('x','return {'+persistedFormat.getter.replace('endsWith(" ")','endsWith("\\n")')+'};')({f:()=>({content:fixture.request})}).getText,
  ({editor})=>editor.view.dom={},
  ({editor})=>editor.view.state.doc={},
  ({editor})=>editor.dictation.document={},
  ({editor})=>editor.plainTextMode=true,
  ({editor})=>editor.markdownEditor.serialize=null,
  ({editor})=>editor.hasMarkdownFormatting=null,
  ({editor})=>editor.getPersistedText=null,
  ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor}),
 ]) await assert.rejects(inspectPersisted(change),/NATIVE_SUBMISSION_UNVERIFIED/);
});

test('persisted native format rejects unknown or mixed dependency implementations',async()=>{
 for(const method of ['hasMarkdownFormatting','getPersistedText'])
  await assert.rejects(inspectPersisted(({editor})=>{
   const native=editor[method];
   editor[method]=function(...args){return native.apply(this,args);};
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
 for(const change of [
  ({editor})=>editor.getPersistedText=()=>'UNCHARACTERIZED-BODY',
  ({editor})=>editor.hasMarkdownFormatting=editor.getPersistedText,
  ({editor})=>editor.getPersistedText=editor.hasMarkdownFormatting,
 ]) await assert.rejects(inspectPersisted(change),/NATIVE_SUBMISSION_UNVERIFIED/);
});

test('persisted getter rejects changed document and empty, non-string or throwing native output',async()=>{
 for(const switchDoc of [
  ({editor})=>editor.dictation.document={},
  ({editor})=>editor.view.state.doc={},
  ({composer})=>composer.pmViewDesc.node={},
 ]) await assert.rejects(inspectPersisted(context=>{
  context.editor.markdownEditor.serialize=()=>{switchDoc(context);return fixture.body;};
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
 for(const body of ['',42]) await assert.rejects(inspectPersisted(({native})=>{
  native.formatted=false;native.plainBody=body;
 }),/NATIVE_SUBMISSION_UNVERIFIED/);
 await assert.rejects(inspectPersisted(({native})=>{
  native.formatted=false;native.error=new Error('native getter failed');
 }),/native getter failed/);
});

const liveAliasFormat=JSON.parse(await readFile(new URL('./native-submission-submit-alias-fixture.json',import.meta.url),'utf8'));
const configureLiveAlias=({host,editor})=>{
 host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+liveAliasFormat.submit)();
 editor.getText=new Function('M','return {'+liveAliasFormat.getter+'};')({g:()=>fixture.body}).getText;
};
const configureWmAlias=context=>{
 configureLiveAlias(context);
 context.host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>up(rS.getText(),e)')();
};
test('captured WM rS submit retains the exact M getter for support inspection and full body verification',async()=>{
 const witness=await inspect(configureWmAlias);
 assert.equal(witness.body,fixture.body);
 assert.equal(witness.getterSource,currentFormat.getter);
 assert.deepEqual(await inspect(configureWmAlias,true),{supported:true,getterSource:witness.getterSource,serializerSource:witness.serializerSource});
 for(const submit of ['e=>up(OTHER.getText(),e)','e=>uh(rS.getText(),e)','e=>up(rS.getText().trim(),e)'])
  await assert.rejects(inspect(context=>{
   configureWmAlias(context);
   context.host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return '+submit)();
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
});
test('observed uh/rE submit alias retains the exact M getter and deduplicates one editor',async()=>{
 assert.equal(liveAliasFormat.getter,currentFormat.getter);
 assert.equal(crypto.createHash('sha256').update(liveAliasFormat.getter).digest('hex'),liveAliasFormat.getterSha256);
 const witness=await inspect(context=>{
  configureLiveAlias(context);
  context.host.__reactFiber$fixture.memoizedState.next={memoizedState:{deps:[context.editor]}};
 });
 assert.equal(witness.body,fixture.body);
 assert.equal(witness.getterSource,liveAliasFormat.getter);
 assert.equal(witness.bodyHash,crypto.createHash('sha256').update(fixture.body).digest('hex'));
});
test('observed submit alias rejects mixed methods, nonunique editors, wrong docs and changed full request',async()=>{
 for(const change of [
  ({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('return e=>uh(OTHER.getText(),e)')(),
  ({editor})=>editor.getText=new Function('T','return {'+getter+'};')({g:()=>fixture.body}).getText,
  ({editor})=>editor.getText=()=>fixture.body,
  ({editor})=>editor.view.dom={},
  ({editor})=>editor.view.state.doc={},
  ({editor})=>editor.dictation.document={},
  ({composer})=>composer.pmViewDesc.node={},
  ({editor})=>editor.plainTextMode=true,
  ({editor})=>editor.markdownEditor.serialize=null,
  ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor}),
  ({env})=>env.request+=' changed footer',
  ({env})=>env.email='other@example.test',
 ]) for(const configure of [configureLiveAlias,configureWmAlias])
  await assert.rejects(inspect(context=>{configure(context);change(context);}),/NATIVE_SUBMISSION_UNVERIFIED/);
});

test('legacy and persisted format validation also ignores coercion and rejects forged method source',async()=>{
 const inspections=[inspect,change=>inspect(context=>{configureLiveAlias(context);change(context);}),inspectPersisted];
 for(const run of inspections) {
  let calls=0;
  const witness=await run(({editor})=>{
   for(const key of ['getText','hasMarkdownFormatting','getPersistedText']) if(typeof editor[key]==='function')
    editor[key].toString=()=>{calls++;throw new Error('custom method coercion');};
   editor.markdownEditor.serialize.toString=()=>{calls++;throw new Error('custom serializer coercion');};
  });
  assert.equal(witness.body,fixture.body);assert.equal(calls,0);
  await assert.rejects(run(({editor})=>{
   const source=Function.prototype.toString.call(editor.getText);
   const spoof=()=>{calls++;return fixture.body;};
   spoof.toString=()=>source;spoof[Symbol.toPrimitive]=()=>source;
   editor.getText=spoof;
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(calls,0);
 }
 for(const key of ['hasMarkdownFormatting','getPersistedText']) {
  let calls=0;
  await assert.rejects(inspectPersisted(({editor})=>{
   const source=Function.prototype.toString.call(editor[key]);
   const spoof=()=>{calls++;return fixture.body;};spoof.toString=()=>source;
   editor[key]=spoof;
  }),/NATIVE_SUBMISSION_UNVERIFIED/);
  assert.equal(calls,0);
 }
});

test('unknown UI format reports an explicit bounded adapter diagnostic before Send',async()=>{
 await assert.rejects(inspect(({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{}),error=>{
  assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');
  assert.deepEqual(error.nativeAdapter,{formatVersion:'chatgpt-native-adapter-v1',phase:'FORMAT',status:'UNSUPPORTED'});
  return true;
 });
});

test('native support can be checked before input without reading a body and retains exact binding guards',async()=>{
 const empty=context=>{
  context.env.request=null;
  context.doc.content.size=0;
  context.doc.textBetween=()=>{throw new Error('body must not be read');};
  context.editor.getText=new Function('T','return {'+getter+'};')({g:()=>{throw new Error('getter must not be invoked');}}).getText;
 };
 const support=await inspect(empty,true);
 assert.equal(support.supported,true);assert.equal(support.getterSource,getter);assert.equal(typeof support.serializerSource,'string');
 for(const change of [
  ({host})=>host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{},
  ({editor})=>editor.getText=()=>'',
  ({editor})=>editor.view.dom={},
  ({editor})=>editor.dictation.document={},
  ({editor})=>editor.view.state.doc={},
  ({editor})=>editor.markdownEditor.serialize=null,
  ({env})=>env.email='other@example.test',
  ({env})=>env.composers.push({}),
  ({host,editor})=>host.__reactFiber$fixture.memoizedState.memoizedState.deps.push({...editor}),
 ]) await assert.rejects(inspect(context=>{empty(context);change(context);},true),/NATIVE_SUBMISSION_UNVERIFIED/);
});


test('unsupported FORMAT retains private native shape and stays rejected without body or handler calls',async()=>{
 let captured,calls=0;
 const submit=new Function('return e=>changed(rN.getText(),e)')();
 await assert.rejects(inspect(context=>{
  captured=context.env;
  context.host.__reactFiber$fixture.memoizedProps.onSubmit=submit;
  context.doc.textBetween=()=>{throw new Error('no body read');};
  context.editor.getText=()=>{calls++;throw new Error('no getter call');};
  context.editor.markdownEditor.serialize=()=>{calls++;throw new Error('no serializer call');};
 },true),error=>{
  assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');
  assert.deepEqual(error.nativeAdapter,{formatVersion:'chatgpt-native-adapter-v1',phase:'FORMAT',status:'UNSUPPORTED'});
  assert.equal(error.nativeFormatEvidence.path,'/private/native-format-evidence.json');
  assert.equal(JSON.stringify(error).includes('e=>changed'),false);
  return true;
 });
 assert.equal(calls,0);
 assert.equal(captured.retained.directory,'native-format-evidence');
 const evidence=captured.retained.backup;
 assert.equal(evidence.format,'chat-bridge-native-format-evidence-v1');
 assert.equal(evidence.composerAncestor,1);
 assert.equal(evidence.fibers[0].onSubmit.source,Function.prototype.toString.call(submit));
 assert.equal(evidence.fibers[0].editors[0].viewDoc,true);
 assert.equal(evidence.fibers[0].editors[0].dictationDoc,true);
 for(const secret of [fixture.request,fixture.body,captured.identity]) assert.equal(JSON.stringify(evidence).includes(secret),false);
});

test('FORMAT sampling does not invoke accessors or custom function/object toString',async()=>{
 for(const field of ['onSubmit','memoizedProps','view','return','objectToString','functionToString']) {
  let captured,calls=0;
  await assert.rejects(inspect(context=>{
   captured=context.env;
   const fiber=context.host.__reactFiber$fixture;
   fiber.memoizedProps.onSubmit=()=>{};
   const accessor=()=>{calls++;throw new Error('opaque accessor invoked');};
   if(field==='onSubmit') Object.defineProperty(fiber.memoizedProps,'onSubmit',{get:accessor});
   if(field==='memoizedProps') Object.defineProperty(fiber,'memoizedProps',{get:accessor});
   if(field==='view') Object.defineProperty(context.editor,'view',{get:accessor});
   if(field==='return') Object.defineProperty(fiber,'return',{get:accessor});
   if(field==='objectToString') fiber.memoizedProps.onSubmit={toString:accessor};
   if(field==='functionToString') fiber.memoizedProps.onSubmit.toString=accessor;
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  assert.equal(calls,0,field);
  assert.equal(captured.retained.directory,'native-format-evidence');
  if(field==='return') {
   assert.equal(captured.retained.backup.truncated,true);
   assert.equal(captured.retained.backup.limit,'FIBER_SCAN_INCOMPLETE');
  }
 }
});

test('wrong account produces no private native shape',async()=>{
 let captured;
 await assert.rejects(inspect(context=>{
  captured=context.env;context.env.email='other@example.test';
  context.host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{};
 },true),/NATIVE_SUBMISSION_UNVERIFIED/);
 assert.equal(captured.retained,undefined);
});

test('private evidence write failure keeps the original strict FORMAT error',async()=>{
 await assert.rejects(inspect(({host,env})=>{
  env.retentionFailure=true;host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{};
 },true),error=>{
  assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');
  assert.deepEqual(error.nativeAdapter,{formatVersion:'chatgpt-native-adapter-v1',phase:'FORMAT',status:'UNSUPPORTED'});
  assert.deepEqual(error.nativeFormatEvidence,{saved:false,code:'PRIVATE_RETENTION_FAILED'});
  return true;
 });
});


test('FORMAT diagnostics cap each function source in UTF-8 bytes without invoking it',async()=>{
 for(const text of ['x'.repeat(1024*1024),'界'.repeat(8000)]) {
  let captured;
  await assert.rejects(inspect(context=>{
   captured=context.env;context.host.__reactFiber$fixture.memoizedProps.onSubmit=new Function('/*'+text+'*/');
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  const evidence=captured.retained.backup;
  assert.equal(evidence.truncated,true);
  assert.equal(evidence.limit,'FUNCTION_SOURCE_LIMIT');
  assert.equal(evidence.fibers[0].onSubmit.source,null);
  assert.equal(evidence.fibers[0].onSubmit.sourceTruncated,true);
  assert(Buffer.byteLength(JSON.stringify(evidence))<256*1024);
 }
});

test('FORMAT diagnostics deduplicate editor candidates across fibers and stop at 128',async()=>{
 for(const count of [10,4096]) {
  let captured;
  await assert.rejects(inspect(context=>{
   captured=context.env;
   const editors=Array.from({length:count},()=>({...context.editor}));
   const hooks=Array.from({length:64},(_,i)=>({memoizedState:{deps:editors.slice(i*64,i*64+64)}}));
   for(let i=0;i<63;i++)hooks[i].next=hooks[i+1];
   const fibers=Array.from({length:16},()=>({memoizedProps:{onSubmit:()=>{}},memoizedState:hooks[0]}));
   for(let i=0;i<15;i++)fibers[i].return=fibers[i+1];
   context.host.__reactFiber$fixture=fibers[0];
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  const evidence=captured.retained.backup;
  assert.equal(evidence.fibers.reduce((n,row)=>n+row.editors.length,0),Math.min(count,128));
  assert.equal(evidence.truncated,count>128);
  assert.equal(evidence.limit,count>128?'EDITOR_CANDIDATE_LIMIT':null);
  assert(Buffer.byteLength(JSON.stringify(evidence))<256*1024);
 }
});

test('FORMAT diagnostic aggregate budget includes JSON escaping and opaque records',async()=>{
 for(const kind of ['function-sources','opaque']) {
  let captured,calls=0;
  await assert.rejects(inspect(context=>{
   captured=context.env;
   const methods=['getText','getHtml','getJson','hasMarkdownFormatting','getPersistedText'];
   const editor=()=>({...context.editor,markdownEditor:{serialize:new Function('/*'+'\0'.repeat(2500)+'*/')}});
   const editors=Array.from({length:128},()=>{
    const item=editor();
    for(const key of methods)item[key]=new Function('/*'+'\0'.repeat(2500)+'*/');
    if(kind==='opaque')Object.defineProperty(item,'view',{get(){calls++;throw new Error('must not invoke');}});
    return item;
   });
   const hooks=Array.from({length:64},(_,i)=>({memoizedState:{deps:editors.slice((i%2)*64,(i%2+1)*64)}}));
   for(let i=0;i<63;i++)hooks[i].next=hooks[i+1];
   context.host.__reactFiber$fixture={memoizedProps:{onSubmit:()=>{}},memoizedState:hooks[0]};
  },true),/NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED/);
  const evidence=captured.retained.backup;
  assert.equal(calls,0);
  assert(Buffer.byteLength(JSON.stringify(evidence))<256*1024);
  if(kind==='function-sources'){assert.equal(evidence.truncated,true);assert.equal(evidence.limit,'EVIDENCE_BYTES_LIMIT');}
  else assert.equal(evidence.fibers.reduce((n,row)=>n+row.opaque.length,0),128);
 }
});

test('FORMAT host refuses oversized final private envelope without changing rejection contract',async()=>{
 let captured;
 await assert.rejects(inspect(({host,env})=>{
  captured=env;env.page={label:'x'.repeat(256*1024)};host.__reactFiber$fixture.memoizedProps.onSubmit=()=>{};
 },true),error=>{
  assert.equal(error.code,'NATIVE_SUBMISSION_UNSUPPORTED');
  assert.deepEqual(error.nativeAdapter,{formatVersion:'chatgpt-native-adapter-v1',phase:'FORMAT',status:'UNSUPPORTED'});
  assert.deepEqual(error.nativeFormatEvidence,{saved:false,code:'NATIVE_FORMAT_EVIDENCE_SIZE_LIMIT'});
  return true;
 });
 assert.equal(captured.retained,undefined);
});
