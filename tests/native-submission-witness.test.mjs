
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
