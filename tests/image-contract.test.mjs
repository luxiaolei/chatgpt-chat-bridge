import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeImageRequest,imageRequestDigest,unknownImageCapabilities,classifyImageCapabilities,imageCapabilityGate,createImageJobAPI,imageJobKey} from '../src/capabilities/image/contract.js';
const input = () => ({jobId:'image-1',operation:'generate',caller:{kind:'chat',ref:'worker'},scope:{tenantId:'t1',namespace:'design',purpose:'offline-test',workgroupId:null},controllerTaskId:'task-1',route:{project:'P',projectId:'g-p-test',accountAlias:'a',accountId:'a'.repeat(64),sessionRef:'worker',conversationId:'worker'},prompt:'synthetic square',budget:{maxAttempts:1,maxOutputs:1,maxDurationMs:60000,deadlineAt:'2026-10-01T00:00:00Z',allowPaidApi:false},authorizedOutput:{targetRef:'store:t1',retentionHours:24},requestedModel:'Latest',requestedEffort:'Pro'});
test('image v1 canonical digest is order-independent and covers all request fields',()=>{
 const r=normalizeImageRequest(input());assert.equal(r.requestDigest,imageRequestDigest(r));
 assert.deepEqual(normalizeImageRequest(JSON.parse(JSON.stringify(r))),r);
 assert.equal(normalizeImageRequest(Object.fromEntries(Object.entries(input()).reverse())).requestDigest,r.requestDigest);
 assert.throws(()=>normalizeImageRequest({...r,prompt:'different'}),/DIGEST_MISMATCH/);
 assert.notEqual(normalizeImageRequest({...input(),scope:{...input().scope,tenantId:'t2'}}).requestDigest,r.requestDigest);
});
test('image request cannot smuggle authority, local paths, paid API or controller identity',()=>{
 for(const patch of [{authorized:true},{token:'allow'},{jobId:'task-1'},{authorizedOutput:{targetRef:'/Users/me/out',retentionHours:1}},{budget:{...input().budget,allowPaidApi:true}}]) assert.throws(()=>normalizeImageRequest({...input(),...patch}));
});
test('edit/refine bind exact source revision and masks never detach from source',()=>{
 assert.throws(()=>normalizeImageRequest({...input(),operation:'edit'}),/SOURCE_REQUIRED/);
 const base={artifactRef:'artifact:t1:base',sha256:'b'.repeat(64),revisionId:'r1',outputId:'parent-output',jobId:'parent-job'};
 const r={...input(),operation:'refine',conversationPolicy:'same-source',inputs:[{...base,role:'source'}],baseRevision:base};
 assert.equal(normalizeImageRequest(r).baseRevision.revisionId,'r1');
 assert.throws(()=>normalizeImageRequest({...r,baseRevision:{...base,revisionId:'r2'}}),/BASE_REVISION/);
 assert.throws(()=>normalizeImageRequest({...r,mask:{artifactRef:'artifact:mask',sha256:'c'.repeat(64),sourceSha256:'d'.repeat(64),sourceRevisionId:'r1',width:1,height:1,coordinateSpace:'source-pixels',mode:'native-region'}}),/MASK_SOURCE/);
});
test('vision input and model labels never imply generation or verified capability',()=>{
 const r=normalizeImageRequest(input());
 const c=classifyImageCapabilities(r.route,{imageParts:true,model:'Latest',features:{generate:{mode:'NATIVE',evidence:[]}}});
 assert.equal(c.features.generate.mode,'UNKNOWN');assert.equal(imageCapabilityGate(r,c).allowed,false);
 assert.equal(unknownImageCapabilities(r.route).features.mask.mode,'UNKNOWN');
});
test('feature-specific assisted/native evidence is route-bound',()=>{
 const r=normalizeImageRequest(input());
 const c=classifyImageCapabilities(r.route,{version:'fixture/v1',observedAt:'2026-09-30T00:00:00Z',features:{generate:{mode:'ASSISTED',evidence:['artifact:fixture:probe']}}});
 assert.deepEqual(imageCapabilityGate(r,c,'2026-09-30T01:00:00Z'),{allowed:true,mode:'ASSISTED'});
 assert.equal(imageCapabilityGate({...r,route:{...r.route,accountId:'c'.repeat(64)}},c).reason,'CAPABILITY_ROUTE_MISMATCH');
});
test('client separates ImageJob and controller queue commands without creating a scheduler',()=>{
 const calls=[];const api=createImageJobAPI({coordinated:(...args)=>calls.push(args)});const r=normalizeImageRequest(input()),key=imageJobKey(r,'grant-1');
 api.submit(r,{grantId:'grant-1'});api.inspect(key);api.result(key);api.cancel(key,{eventId:'cancel-1',expectedRevision:1});
 assert.deepEqual(calls.map(x=>x[0]),['image-submit','image-inspect','image-result','image-apply']);
 assert.equal(calls[3][1].event.type,'cancel');assert.equal(calls[0][1].request.controllerTaskId,'task-1');
});
