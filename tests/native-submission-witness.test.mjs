
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
    if(field==='dictation') editor.dictation={document:context.doc};
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
