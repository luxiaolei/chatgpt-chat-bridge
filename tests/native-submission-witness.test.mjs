
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const fixture=JSON.parse(await readFile(new URL('./native-submission-fixture.json',import.meta.url),'utf8'));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const helper=source.slice(source.indexOf('async function nativeSubmissionWitness('),source.indexOf('\nasync function sendMessage('));
const getter='getText(){let e=arguments.length>0&&void 0!==arguments[0]?arguments[0]:this.dictation.document;return(0,T.g)(e,this.plainTextMode?void 0:this.markdownEditor?.serialize)}';
const prepare=new AsyncFunction('crypto','COMPOSER_SELECTOR','normalizedEvidenceText',helper+';return nativeSubmissionWitness;')(crypto,'composer',v=>v.replace(/\s+/g,' ').trim());
async function inspect(change=()=>{}) {
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
 return await (await prepare)({evaluate:async(fn,args)=>fn(args)},env.request,env.identity);
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
