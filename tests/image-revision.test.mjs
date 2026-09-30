import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fixture} from './image-persistence-fixtures.mjs';
import {png,decode} from './image-artifacts-fixtures.mjs';
import {imageOutputRevision,normalizeImageRequest,validateImageShape} from '../src/capabilities/image/contract.js';
import {createHostImageArtifacts} from '../src/capabilities/image/chatgpt-ego.cli.js';
const withFixture=fn=>async()=>{const f=await fixture();try{await fn(f);}finally{await f.close();}};
const sourceOf=revision=>({artifactRef:revision.output.artifactRef,sha256:revision.output.sha256,
  revisionId:revision.revisionId,jobId:revision.output.jobId,outputId:revision.output.outputId});
function complete(f,entry,sha256='d'.repeat(64)) {
  let job=f.generated(entry.key,f.begin(entry.key,entry.job));
  job=f.exported(entry.key,job,[f.output(job,'output-1',{sha256})]);
  return {job,revision:f.api.result(entry.key).outputRevisions[0]};
}

test('technical revision binds operation, ordered inputs, parent, mask and immutable output; v1 digests stay stable',withFixture(f=>{
  const parent=complete(f,f.setup()),base=sourceOf(parent.revision);
  const references=['a','b'].map(c=>({...base,artifactRef:'artifact:ref:'+c,sha256:c.repeat(64),role:'reference'}));
  const mask={artifactRef:'artifact:mask',sha256:'c'.repeat(64),sourceSha256:base.sha256,
    sourceRevisionId:base.revisionId,width:16,height:16,coordinateSpace:'source-pixels',mode:'native-region'};
  const request=f.request({jobId:'contract-edit',operation:'edit',inputs:[{...base,role:'source'},...references],baseRevision:base,mask});
  const output=f.output({...parent.job,jobId:request.jobId,request},'edited',{sha256:'e'.repeat(64)});
  const revision=imageOutputRevision(request,output);validateImageShape(revision,'OutputRevision');
  assert.deepEqual(revision.inputs,request.inputs);assert.deepEqual(revision.parent,base);assert.deepEqual(revision.mask,mask);
  assert.deepEqual(imageOutputRevision(normalizeImageRequest(JSON.parse(JSON.stringify(request))),output),revision);
  assert.equal(imageOutputRevision(request,{...output,validation:{...output.validation,checkedAt:'2026-09-29T00:00:00Z'}}).revisionId,revision.revisionId);
  for(const changed of [
    {...request,operation:'refine',conversationPolicy:'same-source'},
    {...request,inputs:[request.inputs[0],...references.toReversed()]},
    {...request,mask:{...mask,sha256:'f'.repeat(64)}},
  ]) {
    const normalized=normalizeImageRequest({...changed,requestDigest:undefined});
    assert.notEqual(imageOutputRevision(normalized,{...output,sourceHashes:normalized.inputs.map(i=>i.sha256)}).revisionId,revision.revisionId);
  }
  assert.notEqual(imageOutputRevision(request,{...output,sha256:'f'.repeat(64)}).revisionId,revision.revisionId);
  assert.throws(()=>imageOutputRevision(request,{...output,validation:{...output.validation,status:'UNVERIFIED'}}),/SOURCE_NOT_VERIFIED/);
  assert.throws(()=>imageOutputRevision(request,{...output,parentOutputId:'wrong'}),/LINEAGE_MISMATCH/);
  assert.equal(normalizeImageRequest(request).requestDigest,request.requestDigest);
}));

test('new source admission rejects forged revisions and unsupported imports; historical v1 replay stays audit-only',withFixture(f=>{
  const first=f.setup(),parent=complete(f,first),base=sourceOf(parent.revision);
  const request=f.request({jobId:'edit-auth',operation:'edit',inputs:[{...base,role:'source'}],baseRevision:base});
  const entry=f.setup(request,f.grant(request,'grant-edit-auth'));
  assert.deepEqual(f.api.authorizeIO(entry.key).sources,[{source:request.inputs[0],revision:parent.revision}]);
  const forged={...base,revisionId:'owner-declared-r1'};
  for(const [id,source,error] of [['forged',forged,/SOURCE_REVISION_MISMATCH/],
    ['external',{...base,jobId:null,outputId:null},/EXTERNAL_SOURCE_REVISION_UNSUPPORTED/]]) {
    const r=f.request({jobId:id,operation:'edit',inputs:[{...source,role:'source'}],baseRevision:source}),g=f.grant(r,'grant-'+id);
    f.authorize(g);f.fail('image-submit',{grantId:g.grantId,request:r},error);
  }
  // Simulate an already-stored pre-fix v1 edit, without running old code or rewriting it on read.
  const legacy=normalizeImageRequest({...request,requestDigest:undefined,inputs:[{...forged,role:'source'}],baseRevision:forged});
  const historical={...entry.job,request:legacy,requestDigest:legacy.requestDigest},grant={...entry.g,request:legacy};
  const literal=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'";
  f.sql(`UPDATE image_jobs SET request_digest='${legacy.requestDigest}',document=${literal(historical)} WHERE job_id='edit-auth'`);
  f.sql(`UPDATE image_grants SET payload=${literal(grant)} WHERE grant_id='grant-edit-auth'`);
  const before=f.sql('SELECT job_id,request_digest,document FROM image_jobs ORDER BY job_id');
  assert.deepEqual(f.api.inspect(entry.key),historical);assert.deepEqual(f.api.submit(legacy,{grantId:grant.grantId}),historical);
  assert.equal(f.api.result(entry.key).requestDigest,legacy.requestDigest);
  assert.throws(()=>f.api.authorizeIO(entry.key),/SOURCE_REVISION_MISMATCH/);
  assert.throws(()=>f.begin(entry.key,historical),/SOURCE_REVISION_MISMATCH/);
  assert.deepEqual(f.sql('SELECT job_id,request_digest,document FROM image_jobs ORDER BY job_id'),before);
  assert.deepEqual(f.api.inspect(first.key),parent.job);
}));

test('same base forms independent immutable branches and two-round refine follows the exact technical parent',withFixture(f=>{
  const root=f.setup(),r1=complete(f,root),base=sourceOf(r1.revision);
  const branch=id=>{const r=f.request({jobId:id,operation:'edit',inputs:[{...base,role:'source'}],baseRevision:base});return f.setup(r,f.grant(r,'grant-'+id));};
  const a=branch('branch-a'),b=branch('branch-b'),r2=complete(f,a,'e'.repeat(64)),other=complete(f,b,'f'.repeat(64));
  assert.notEqual(r2.revision.revisionId,other.revision.revisionId);assert.deepEqual(r2.revision.parent,other.revision.parent);
  const nextBase=sourceOf(r2.revision),next=f.request({jobId:'round-2',operation:'refine',conversationPolicy:'same-source',
    inputs:[{...nextBase,role:'source'}],baseRevision:nextBase});
  const r3=complete(f,f.setup(next,f.grant(next,'grant-round-2')),'a'.repeat(64));
  assert.equal(r3.revision.parent.revisionId,r2.revision.revisionId);assert.equal(r2.revision.parent.revisionId,r1.revision.revisionId);
  assert.deepEqual(f.api.result(root.key).outputRevisions,[r1.revision]);assert.deepEqual(f.api.result(b.key).outputRevisions,[other.revision]);
  const wrong={...nextBase,revisionId:other.revision.revisionId},bad=f.request({jobId:'wrong-branch',operation:'edit',inputs:[{...wrong,role:'source'}],baseRevision:wrong});
  f.authorize(f.grant(bad,'grant-wrong-branch'));f.fail('image-submit',{grantId:'grant-wrong-branch',request:bad},/SOURCE_REVISION_MISMATCH/);
}));

test('host resolver binds parent request/attempt/turn/dimensions and rechecks source authority after decoded byte I/O',withFixture(async f=>{
  const r=f.request(),g=f.grant(r);g.capabilities.features.export.mode='ASSISTED';
  const first=f.setup(r,g),ready=f.generated(first.key,f.begin(first.key,first.job));
  const stateDir=await realpath(f.state),io=await createHostImageArtifacts({api:f.api,key:first.key,stateDir,decode,coordinated:f.call});
  const inbox=await io.prepareInbox(),bytes=png();await writeFile(inbox.originalPath,bytes,{mode:0o600});
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const exported=await io.importOfficialOriginal({...inbox,path:inbox.originalPath,operatorRef:f.owner,sha256,outputId:'output-1',
    officialSave:{confirmed:true,requestDigest:r.requestDigest,attemptId:ready.attempts[0].attemptId,turnId:'new-assistant',outputId:'output-1',originalRef:inbox.originalRef,route:r.route}});
  const base=sourceOf(exported.outputRevisions[0]),edit=f.request({jobId:'host-edit',operation:'edit',inputs:[{...base,role:'source'}],baseRevision:base});
  const entry=f.setup(edit,f.grant(edit,'host-edit-grant')),host=await createHostImageArtifacts({api:f.api,key:entry.key,stateDir,decode});
  const resolved=await host.resolveSource(edit.inputs[0]);assert.equal(resolved.revisionId,base.revisionId);
  const recordPath=resolved.path.replace(/original-([^/]+)\.bin$/,'record-$1.json'),original=await readFile(recordPath),record=JSON.parse(original);
  for(const [field,value] of [['requestDigest','b'.repeat(64)],['attemptId','wrong-attempt'],['turnId','wrong-turn']]) {
    await writeFile(recordPath,JSON.stringify({...record,binding:{...record.binding,[field]:value}}));
    await assert.rejects(host.resolveSource(edit.inputs[0]),/SOURCE_BINDING_MISMATCH/);
  }
  await writeFile(recordPath,JSON.stringify({...record,verified:{...record.verified,width:3}}));
  await assert.rejects(host.resolveSource(edit.inputs[0]),/SOURCE_BINDING_MISMATCH/);await writeFile(recordPath,original);
  const revokeDuringDecode=async(...args)=>{const value=await decode(...args);f.call('image-revoke',{issuerRef:f.owner,grantId:entry.g.grantId});return value;};
  const revoked=await createHostImageArtifacts({api:f.api,key:entry.key,stateDir,decode:revokeDuringDecode});
  await assert.rejects(revoked.resolveSource(edit.inputs[0]),/EXPIRED_OR_REVOKED/);
  assert.deepEqual(await readFile(recordPath),original);
}));
