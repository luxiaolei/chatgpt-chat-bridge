import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createImageMagickDecoder, verifyImageBytes, sniffImageMime, inspectImageCount, sha256, artifactError} from '../src/capabilities/image/verifier.js';
import {createControlledImageStore, createImageExporter} from '../src/capabilities/image/exporter.js';
import {createImageConsumerReceiver, publicImageManifest, canonicalArtifactJSON, authorizeArtifactBinding, imageExportEvent} from '../src/capabilities/image/manifest.js';
import {AT,FUTURE,MAGICK,png,decode,fixtureDecode,authorize,scratch,request,capabilities,slot,provider,testContract} from './image-artifacts-fixtures.mjs';

const clock=()=>AT;
async function setup(t,{req=request(),images,contract=testContract,authorize:auth=authorize,readOriginal,io}={}) {
  const directory=await scratch(t), root=join(directory,'producer');
  const store=await createControlledImageStore({root,targetRef:req.authorizedOutput.targetRef,...(io?{io}:{})});
  const calls=new Map(); images??=new Map([['out-1',png()]]);
  const source=readOriginal??provider(images,calls);
  const config={contract,store,authorize:auth,readOriginal:source,decode,clock};
  const exporter=createImageExporter(config);
  const options={request:req,attemptId:'attempt-1',turnId:'turn-1',outputs:[slot()],capabilities:capabilities(req)};
  return {directory,root,store,calls,images,config,exporter,options,req};
}
function faultIO(shouldFail, code='ENOSPC') {
  return {...fs,async open(...args) {
    const handle=await fs.open(...args), original=handle.writeFile.bind(handle);
    handle.writeFile=async bytes=>{if(shouldFail(bytes,args[0])) throw Object.assign(new Error('synthetic disk fault'),{code}); return original(bytes);};
    return handle;
  }};
}
async function receiveSetup(t, producer, {authorize:auth=authorize,resolveArtifact,store:givenStore}={}) {
  const result=await producer.exporter.exportOriginals(producer.options); assert.equal(result.status,'TECHNICALLY_VALIDATED');
  const output=result.manifest.outputs[0];
  const store=givenStore??await createControlledImageStore({root:join(producer.directory,'consumer'),targetRef:'store:receiver'});
  let fetches=0;
  const config={contract:producer.config.contract,store,authorize:auth,decode,clock,
    resolveArtifact:resolveArtifact??(async()=>{fetches++;return {bytes:producer.images.get('out-1'),mimeType:output.mimeType};})};
  return {result,output,store,config,receiver:createImageConsumerReceiver(config),fetches:()=>fetches,
    args:{jobId:producer.req.jobId,requestDigest:result.manifest.requestDigest,output,consumerRef:'consumer:fixture'}};
}

test('magic is necessary but never sufficient',async()=>{
  assert.equal(sniffImageMime(png()),'image/png'); assert.throws(()=>sniffImageMime(Buffer.from('not-image')),/MAGIC_UNSUPPORTED/);
  await assert.rejects(verifyImageBytes(png().subarray(0,33),{mimeType:'image/png',decode}),/DECODE_FAILED/);
});
test('full decode yields real pixels/hash; count awaits whole-output verification',async()=>{
  const bytes=png({width:3,height:2}); const v=await verifyImageBytes(bytes,{mimeType:'image/png',decode,checkedAt:AT});
  assert.equal(v.width,3);assert.equal(v.height,2);assert.equal(v.sha256,sha256(bytes));
  assert.equal(v.validation.checks.decode,true);assert.equal(v.validation.checks.count,false);assert.equal(v.validation.status,'UNVERIFIED');
});
test('MIME mismatch fails before decode',async()=>{
  let called=false; await assert.rejects(verifyImageBytes(png(),{mimeType:'image/jpeg',decode:async()=>{called=true;}}),/MIME_MISMATCH/); assert.equal(called,false);
});
test('expected hash mismatch cannot be relabelled verified',async()=>{
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png',expectedSha256:'f'.repeat(64),decode}),/HASH_MISMATCH/);
});
test('empty and over-budget bytes fail closed',async()=>{
  await assert.rejects(verifyImageBytes(Buffer.alloc(0),{mimeType:'image/png',decode}),/INVALID_BYTES/);
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png',maxBytes:4,decode}),/ENCODED_SIZE_LIMIT/);
});
test('CRC errors, truncated payload and trailing payload rejected',async()=>{
  const broken=Buffer.from(png()); broken[45]^=1;
  for(const bytes of [broken,png().subarray(0,-5),Buffer.concat([png(),Buffer.from('PRIVATE_TRAILING_PAYLOAD')])]) {
    await assert.rejects(verifyImageBytes(bytes,{mimeType:'image/png',decode}),/DECODE_FAILED/);
  }
});
test('valid headers/CRC with broken compressed pixels fail actual decoding',async()=>{
  await assert.rejects(verifyImageBytes(png({compressed:Buffer.from([1,2,3])}),{mimeType:'image/png',decode}));
});
test('header-only decoder attestations are not accepted',async()=>{
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png',decode:async()=>({width:2,height:2})}),/DECODE_PROTOCOL/);
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png'}),/DECODE_UNAVAILABLE/);
});
test('ratio and requested-size differences are warnings, never fictitious native 4K',async()=>{
  const v=await verifyImageBytes(png({width:3,height:2}),{mimeType:'image/png',decode,aspectRatio:'1:1',expectedWidth:4096,expectedHeight:4096});
  assert.deepEqual(v.warnings,['ASPECT_RATIO_MISMATCH','DIMENSIONS_MISMATCH']);assert.equal(v.width,3);assert.equal(v.height,2);
});
test('duplicate bytes and differently encoded identical pixels do not satisfy count',async()=>{
  const a=await verifyImageBytes(png(),{mimeType:'image/png',decode});
  const b=await verifyImageBytes(png({comment:'different metadata'}),{mimeType:'image/png',decode});
  assert.notEqual(a.sha256,b.sha256);assert.equal(a.pixelSha256,b.pixelSha256);
  const count=inspectImageCount([{outputId:'a',...a},{outputId:'b',...b}],2);
  assert.equal(count.countMatches,false);assert.equal(count.uniqueCount,1);assert.deepEqual(count.duplicateOutputIds,['b']);
});
test('APNG is explicitly unsupported rather than accepted as a still thumbnail',async()=>{
  await assert.rejects(verifyImageBytes(png({animated:true}),{mimeType:'image/png',decode}),/ANIMATION_UNSUPPORTED/);
});
test('installed ImageMagick fully decodes PNG/JPEG/WebP originals',{skip:!MAGICK},async()=>{
  for(const [format,mimeType] of [['png','image/png'],['jpeg','image/jpeg'],['webp','image/webp']]) {
    const bytes=format==='png'?png({width:4,height:3}):execFileSync(MAGICK,['png:-',`${format}:-`],{input:png({width:4,height:3})});
    const v=await verifyImageBytes(bytes,{mimeType,decode:createImageMagickDecoder({executable:MAGICK})});
    assert.equal(v.width,4);assert.equal(v.height,3);assert.equal(v.decoder,'imagemagick7-pam-rgba8');
  }
});
test('missing decoder, deadline and pixel budget yield errors not success',async t=>{
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png',decode:createImageMagickDecoder({executable:'/nonexistent/image-decoder'})}),/DECODE_UNAVAILABLE/);
  const temp=await scratch(t), slow=join(temp,'slow-decoder');
  await fs.writeFile(slow,'#!/bin/sh\nexec /bin/sleep 2\n',{mode:0o700});
  await assert.rejects(verifyImageBytes(png(),{mimeType:'image/png',decode:createImageMagickDecoder({executable:slow,timeoutMs:20})}),/DECODE_TIMEOUT/);
  if(MAGICK) await assert.rejects(verifyImageBytes(png({width:3,height:3}),{mimeType:'image/png',decode:createImageMagickDecoder({executable:MAGICK,maxPixels:4})}));
});

test('store writes mode-0600 files and atomically reuses identical bytes',async t=>{
  const s=await setup(t); await s.store.putImmutable('fixture.bin',Buffer.from('first'));
  assert.equal((await fs.stat(join(s.root,'fixture.bin'))).mode&0o777,0o600);
  assert.equal((await s.store.putImmutable('fixture.bin',Buffer.from('first'))).reused,true);
  await assert.rejects(s.store.putImmutable('fixture.bin',Buffer.from('second')),/STORE_CONFLICT/);
  assert.equal((await s.store.read('fixture.bin')).toString(),'first');
});
test('path traversal and absolute paths never enter the store',async t=>{
  const s=await setup(t);
  for(const name of ['../outside.bin','/tmp/outside.bin','x/y.bin','..\\x.bin','file.bin\0x','file?.bin']) {
    await assert.rejects(s.store.putImmutable(name,Buffer.from('x')),/STORE_UNSAFE/);
  }
  assert.deepEqual(await fs.readdir(s.root),[]);
});
test('symlink targets and hard-linked existing files are rejected',async t=>{
  const s=await setup(t), outside=join(s.directory,'outside');await fs.writeFile(outside,'private',{mode:0o600});
  await fs.symlink(outside,join(s.root,'linked.bin'));
  await assert.rejects(s.store.read('linked.bin'),/STORE_UNSAFE/);
  await assert.rejects(s.store.putImmutable('linked.bin',Buffer.from('overwrite')),/STORE_UNSAFE/);
  await fs.link(outside,join(s.root,'hard.bin'));await assert.rejects(s.store.read('hard.bin'),/STORE_UNSAFE/);
  assert.equal(await fs.readFile(outside,'utf8'),'private');
});
test('symlinked roots/ancestors and permissive roots are rejected',async t=>{
  const d=await scratch(t); await fs.mkdir(join(d,'actual'),{mode:0o700});await fs.symlink(join(d,'actual'),join(d,'alias'));
  await assert.rejects(createControlledImageStore({root:join(d,'alias'),targetRef:'store:test'}),/STORE_UNSAFE/);
  await assert.rejects(createControlledImageStore({root:join(d,'alias','new'),targetRef:'store:test'}),/STORE_UNSAFE/);
  await fs.mkdir(join(d,'open'),{mode:0o755});await assert.rejects(createControlledImageStore({root:join(d,'open'),targetRef:'store:test'}),/STORE_UNSAFE/);
});
test('replaced store directory is detected before write',async t=>{
  const s=await setup(t);await fs.rename(s.root,`${s.root}-moved`);await fs.mkdir(s.root,{mode:0o700});
  await assert.rejects(s.store.putImmutable('fixture.bin',Buffer.from('x')),/STORE_CHANGED/);assert.deepEqual(await fs.readdir(s.root),[]);
});
test('disk-full during temp write cleans only its own temp and never publishes partial bytes',async t=>{
  const d=await scratch(t),root=join(d,'store');
  const store=await createControlledImageStore({root,targetRef:'store:test',io:faultIO(()=>true)});
  await assert.rejects(store.putImmutable('fixture.bin',Buffer.from('x')),e=>e.code==='ENOSPC');
  assert.deepEqual(await fs.readdir(root),[]);
});
test('concurrent conflicting publication never overwrites the winning bytes',async t=>{
  const s=await setup(t);const results=await Promise.allSettled([s.store.putImmutable('race.bin',Buffer.from('a')),s.store.putImmutable('race.bin',Buffer.from('b'))]);
  assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(['a','b'].includes((await s.store.read('race.bin')).toString()));
  assert.equal((await fs.readdir(s.root)).filter(n=>n.startsWith('.image-tmp-')).length,0);
});
test('complete publication is readable and reusable while its own temporary link is live',async t=>{
  const d=await scratch(t),root=join(d,'store');let linked,release;
  const published=new Promise(r=>{linked=r;}),gate=new Promise(r=>{release=r;});
  const writer=await createControlledImageStore({root,targetRef:'store:race',io:{...fs,async link(...args){await fs.link(...args);linked();await gate;}}});
  const peer=await createControlledImageStore({root,targetRef:'store:race'}),bytes=Buffer.from('complete');
  const pending=writer.putImmutable('race.bin',bytes);await published;
  try {
    assert.equal((await fs.stat(join(root,'race.bin'))).nlink,2);
    const entries=await fs.readdir(root);
    assert.deepEqual(await peer.read('race.bin'),bytes);
    assert.equal((await peer.putImmutable('race.bin',bytes)).reused,true);
    await assert.rejects(peer.putImmutable('race.bin',Buffer.from('conflict')),/STORE_CONFLICT/);
    assert.deepEqual(await fs.readdir(root),entries);
  } finally {release();await pending;}
  assert.equal((await fs.stat(join(root,'race.bin'))).nlink,1);
});
test('owned writer SIGKILL after publication leaves complete final bytes readable on restart',async t=>{
  const d=await scratch(t),root=join(d,'store'),moduleURL=new URL('../src/capabilities/image/exporter.js',import.meta.url).href;
  const code=`import * as fs from 'node:fs/promises';import {createControlledImageStore} from ${JSON.stringify(moduleURL)};
    const store=await createControlledImageStore({root:${JSON.stringify(root)},targetRef:'store:crash',io:{...fs,async link(...args){await fs.link(...args);process.kill(process.pid,'SIGKILL');}}});
    await store.putImmutable('crash.bin',Buffer.from('complete'));`;
  assert.throws(()=>execFileSync(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']}),e=>e.signal==='SIGKILL');
  const store=await createControlledImageStore({root,targetRef:'store:crash'}),entries=await fs.readdir(root);
  assert.equal((await fs.stat(join(root,'crash.bin'))).nlink,2);
  assert.equal((await store.read('crash.bin')).toString(),'complete');
  assert.equal((await store.putImmutable('crash.bin',Buffer.from('complete'))).reused,true);
  assert.deepEqual(await fs.readdir(root),entries);
});
test('unbound, misbound and additional hard links are rejected and retained',async t=>{
  const uuid='11111111-1111-4111-8111-111111111111';
  for(const alias of [`.image-tmp-${uuid}`,`.image-tmp-other.bin-${uuid}`,`.image-tmp-file.bin-${uuid}`]) {
    const d=await scratch(t),root=join(d,'store'),store=await createControlledImageStore({root,targetRef:'store:unsafe'});
    await store.putImmutable('file.bin',Buffer.from('private'));await fs.link(join(root,'file.bin'),join(root,alias));
    if(alias.startsWith('.image-tmp-file.bin-'))await fs.link(join(root,'file.bin'),join(d,'external-link'));
    const entries=await fs.readdir(root);
    await assert.rejects(store.read('file.bin'),/STORE_UNSAFE/);
    await assert.rejects(store.putImmutable('file.bin',Buffer.from('private')),/STORE_UNSAFE/);
    assert.deepEqual(await fs.readdir(root),entries);
  }
});

test('official assisted original exports produce exact contract fields but no remote receipt',async t=>{
  const s=await setup(t);const r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'TECHNICALLY_VALIDATED');assert.equal(r.manifestPersisted,true);assert.equal(r.manifest.deliveryStatus,'NOT_RECEIVED');
  assert.deepEqual(r.manifest.exportModes,['ASSISTED']);assert.equal(r.manifest.outputs[0].validation.status,'VERIFIED');
  assert.deepEqual(r.manifest.outputs[0].validation.checks,{magic:true,mime:true,decode:true,hash:true,count:true});
  assert.equal(s.calls.get('out-1'),1);assert.ok(!JSON.stringify(r).includes(s.root));
});
test('versioned revision descriptors preserve existing v1 original records and manifest bytes',async t=>{
  const contract=await import('../src/capabilities/image/contract.js');
  const s=await setup(t,{contract:{...contract,imageOutputRevision:undefined}});
  const before=await s.exporter.exportOriginals(s.options);assert.deepEqual(before.outputRevisions,[]);
  const names=await fs.readdir(s.root),snapshots=await Promise.all(names.map(n=>fs.readFile(join(s.root,n))));
  const after=await createImageExporter({...s.config,contract}).exportOriginals(s.options);
  assert.deepEqual(after.manifest,before.manifest);assert.deepEqual(after.publicManifest,before.publicManifest);
  assert.deepEqual(after.outputRevisions,[contract.imageOutputRevision(s.req,after.manifest.outputs[0])]);
  assert.deepEqual(await fs.readdir(s.root),names);assert.equal(s.calls.get('out-1'),1);
  for(const [i,name] of names.entries())assert.deepEqual(await fs.readFile(join(s.root,name)),snapshots[i]);
});
test('new exporter instance resumes successful original without re-fetch',async t=>{
  const s=await setup(t);const first=await s.exporter.exportOriginals(s.options);
  const second=await createImageExporter(s.config).exportOriginals(s.options);
  assert.equal(s.calls.get('out-1'),1);assert.deepEqual(second.manifest.outputs,first.manifest.outputs);
});
test('partial/expired second original preserves first; retry fetches only missing second',async t=>{
  const req=request({count:2});const images=new Map([['out-1',png()],['out-2',artifactError('ORIGINAL_EXPIRED')]]);
  const s=await setup(t,{req,images});s.options.outputs=[slot(),slot('out-2')];
  const first=await s.exporter.exportOriginals(s.options);assert.equal(first.status,'PARTIAL');
  assert.equal(first.manifest.actualCount,1);assert.equal(first.manifest.missingCount,1);assert.equal(first.manifest.outputs[0].validation.checks.count,false);
  images.set('out-2',png({rgba:[44,77,111,255]}));
  const next=await createImageExporter(s.config).exportOriginals(s.options);assert.equal(next.status,'TECHNICALLY_VALIDATED');
  assert.equal(s.calls.get('out-1'),1);assert.equal(s.calls.get('out-2'),2);
  assert.equal((await fs.readdir(s.root)).filter(n=>n.startsWith('manifest-')).length,2);
});
test('unknown, missing and late output slots never call provider',async t=>{
  const s=await setup(t,{req:request({count:3})});s.options.outputs=[slot('a',{status:'UNKNOWN'}),slot('b',{status:'MISSING'}),slot('c',{status:'LATE'})];
  const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'BLOCKED');assert.equal(s.calls.size,0);
  assert.deepEqual(r.manifest.errors.map(e=>e.code),['ORIGINAL_UNKNOWN','ORIGINAL_MISSING','LATE_OUTPUT']);
});
test('no original channel or unknown/stale capability is EXPORT_UNAVAILABLE',async t=>{
  const s=await setup(t);
  const noProvider=createImageExporter({...s.config,readOriginal:undefined});assert.equal((await noProvider.exportOriginals(s.options)).status,'EXPORT_UNAVAILABLE');
  s.options.capabilities=capabilities(s.req,'UNKNOWN');assert.equal((await s.exporter.exportOriginals(s.options)).status,'EXPORT_UNAVAILABLE');
  s.options.capabilities=capabilities(s.req);s.options.capabilities.observedAt='2026-09-29T00:00:00Z';
  assert.equal((await createImageExporter({...s.config,maxCapabilityAgeMs:300000}).exportOriginals(s.options)).status,'EXPORT_UNAVAILABLE');assert.equal(s.calls.size,0);
});
test('wrong route or target cannot borrow export capability',async t=>{
  const s=await setup(t);s.options.capabilities.route={...s.req.route,conversationId:'other'};
  await assert.rejects(s.exporter.exportOriginals(s.options),/CAPABILITY_ROUTE_MISMATCH/);
  s.options.capabilities=capabilities(s.req);s.options.request={...s.req,authorizedOutput:{targetRef:'store:other',retentionHours:24}};
  await assert.rejects(s.exporter.exportOriginals(s.options),/AUTHORIZATION_DENIED/);assert.equal(s.calls.size,0);
});
test('external authorized flag/digest cannot replace independent current grant',async t=>{
  const s=await setup(t,{authorize:async()=>({allowed:true,bindingDigest:'0'.repeat(64),expiresAt:FUTURE})});
  s.options.request={...s.req,authorized:true};await assert.rejects(s.exporter.exportOriginals(s.options),/AUTHORIZATION_DENIED/);
  assert.equal(s.calls.size,0);assert.deepEqual(await fs.readdir(s.root),[]);
  await assert.rejects(authorizeArtifactBinding(async b=>({...await authorize(b),expiresAt:AT}),{x:1},clock),/AUTHORIZATION_EXPIRED/);
});
test('authorization proof expires at the trusted clock after the awaited hook returns',async()=>{
  let now=Date.parse(AT),calls=0;const expiry=new Date(now+500).toISOString();
  const auth=async b=>{calls++;const proof={...await authorize(b),expiresAt:expiry};await Promise.resolve();now+=1000;return proof;};
  await assert.rejects(authorizeArtifactBinding(auth,{x:1},()=>new Date(now).toISOString(),{at:AT}),/AUTHORIZATION_EXPIRED/);
  assert.equal(calls,1);
  await assert.rejects(authorizeArtifactBinding(authorize,{x:1},AT),/AUTHORIZATION_DENIED/);
});
test('exporter expired async authorization cannot reach source I/O or publication',async t=>{
  const s=await setup(t);let now=Date.parse(AT);
  const exporter=createImageExporter({...s.config,clock:()=>new Date(now).toISOString(),authorize:async b=>{
    const proof={...await authorize(b),expiresAt:new Date(now+500).toISOString()};await Promise.resolve();now+=1000;return proof;
  }});
  await assert.rejects(exporter.exportOriginals(s.options),/AUTHORIZATION_EXPIRED/);
  assert.equal(s.calls.size,0);assert.deepEqual(await fs.readdir(s.root),[]);
});
test('output over-count, duplicate ids and wrong bound turn are rejected before any I/O',async t=>{
  const s=await setup(t);s.options.outputs=[slot(),slot('out-2')];await assert.rejects(s.exporter.exportOriginals(s.options),/OUTPUT_COUNT_MISMATCH/);
  s.options.request=request({count:2});s.options.capabilities=capabilities(s.options.request);s.options.outputs=[slot(),slot()];
  await assert.rejects(s.exporter.exportOriginals(s.options),/DUPLICATE_OUTPUT_ID/);
  s.options.outputs=[slot('out-1',{turnId:'old-turn'})];await assert.rejects(s.exporter.exportOriginals(s.options),/SOURCE_BINDING_MISMATCH/);assert.equal(s.calls.size,0);
});
test('only one observed of two expected outputs remains PARTIAL',async t=>{
  const s=await setup(t,{req:request({count:2})});const r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'PARTIAL');assert.equal(r.manifest.actualCount,1);assert.equal(r.manifest.expectedCount,2);assert.equal(r.manifest.outputs[0].validation.status,'UNVERIFIED');
});
test('same decoded image with changed metadata cannot fill two output slots',async t=>{
  const s=await setup(t,{req:request({count:2}),images:new Map([['out-1',png()],['out-2',png({comment:'metadata only'})]])});
  s.options.outputs=[slot(),slot('out-2')];const r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'PARTIAL');assert.equal(r.manifest.uniqueCount,1);assert.deepEqual(r.manifest.duplicateOutputIds,['out-2']);
});
test('thumbnail or wrongly bound provider original is not accepted',async t=>{
  for(const override of [{kind:'THUMBNAIL'},{turnId:'old-turn'},{kind:'NATIVE_ORIGINAL'}]) {
    const s=await setup(t,{readOriginal:async b=>({bytes:png(),mimeType:'image/png',provenance:{kind:'OFFICIAL_HANDOFF',...b,...override}})});
    const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'BLOCKED');assert.equal(r.manifest.actualCount,0);
  }
});
test('edit source hash and parent revision preserved; source bytes themselves rejected',async t=>{
  const base={artifactRef:'artifact:source:1',sha256:sha256(png()),revisionId:'revision-1',outputId:'parent-1',jobId:'parent-job'};
  const req=request({operation:'edit',inputs:[{...base,role:'source'}],baseRevision:base});
  const s=await setup(t,{req});let r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'BLOCKED');assert.equal(r.manifest.errors[0].code,'SOURCE_IMAGE_REUSED');
  s.images.set('out-1',png({rgba:[1,2,3,255]}));r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'TECHNICALLY_VALIDATED');assert.equal(r.manifest.outputs[0].parentOutputId,'parent-1');assert.equal(r.manifest.outputs[0].baseRevisionId,'revision-1');
  assert.deepEqual(r.manifest.outputs[0].sourceHashes,[base.sha256]);
});
test('same-output changed turn conflicts instead of adopting a late replacement',async t=>{
  const s=await setup(t);await s.exporter.exportOriginals(s.options);
  s.options.turnId='later-turn';s.options.outputs=[slot('out-1',{turnId:'later-turn'})];
  const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'BLOCKED');assert.equal(r.manifest.errors[0].code,'STORE_CONFLICT');assert.equal(s.calls.get('out-1'),1);
});
test('missing original is re-fetched only by same immutable original/hash',async t=>{
  const s=await setup(t);await s.exporter.exportOriginals(s.options);
  const name=(await fs.readdir(s.root)).find(n=>n.startsWith('original-'));await fs.unlink(join(s.root,name));
  let r=await createImageExporter(s.config).exportOriginals(s.options);assert.equal(r.status,'TECHNICALLY_VALIDATED');assert.equal(s.calls.get('out-1'),2);
  await fs.unlink(join(s.root,name));s.images.set('out-1',png({rgba:[99,88,77,255]}));
  r=await createImageExporter(s.config).exportOriginals(s.options);assert.equal(r.status,'BLOCKED');assert.equal(r.manifest.errors[0].code,'HASH_MISMATCH');
  assert.equal(await s.store.read(name),null);
});
test('corrupted existing original is preserved and never automatically refetched or overwritten',async t=>{
  const s=await setup(t);await s.exporter.exportOriginals(s.options);const name=(await fs.readdir(s.root)).find(n=>n.startsWith('original-'));
  await fs.writeFile(join(s.root,name),png({rgba:[5,6,7,255]}));const r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'BLOCKED');assert.equal(s.calls.get('out-1'),1);assert.equal(r.manifest.errors[0].code,'HASH_MISMATCH');
});
test('disk-full after immutable record is recoverable without losing other successful files',async t=>{
  const a=png(),b=png({rgba:[1,4,9,255]});let fail=true;
  const io=faultIO(bytes=>{if(fail&&Buffer.isBuffer(bytes)&&bytes.equals(a)){fail=false;return true;}return false;});
  const s=await setup(t,{req:request({count:2}),images:new Map([['out-1',a],['out-2',b]]),io});s.options.outputs=[slot(),slot('out-2')];
  const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'PARTIAL');assert.equal(r.manifest.errors[0].code,'ENOSPC');
  const next=await createImageExporter(s.config).exportOriginals(s.options);assert.equal(next.status,'TECHNICALLY_VALIDATED');
  assert.equal(s.calls.get('out-1'),2);assert.equal(s.calls.get('out-2'),1);assert.equal((await fs.readdir(s.root)).filter(n=>n.startsWith('.image-tmp-')).length,0);
});
test('manifest disk failure returns partial evidence and keeps completed originals',async t=>{
  const s=await setup(t);const badStore={...s.store,putImmutable:async(name,b)=>{if(name.startsWith('manifest-'))throw Object.assign(new Error('full'),{code:'ENOSPC'});return s.store.putImmutable(name,b);}};
  const r=await createImageExporter({...s.config,store:badStore}).exportOriginals(s.options);assert.equal(r.status,'PARTIAL');assert.equal(r.manifestPersisted,false);assert.equal(r.manifest.actualCount,1);
  assert.equal((await s.exporter.exportOriginals(s.options)).status,'TECHNICALLY_VALIDATED');assert.equal(s.calls.get('out-1'),1);
});
test('public manifest whitelists fields and removes prompt, private conversation, paths and temporary URLs',async t=>{
  const s=await setup(t);const r=await s.exporter.exportOriginals(s.options);const m=structuredClone(r.manifest),secret='https://private.invalid/file?token=SECRET';
  m.prompt=s.req.prompt;m.route=s.req.route;m.localPath=s.root;m.url=secret;m.outputs[0].url=secret;m.outputs[0].validation.extra=secret;
  m.outputs[0].capabilityVersion=secret;m.outputs[0].warnings.push(secret);
  const shared=publicImageManifest(m), text=JSON.stringify(shared);
  for(const value of [secret,s.req.prompt,s.root,s.req.route.conversationId,'turn-1'])assert.ok(!text.includes(value));
  assert.equal(shared.outputs[0].turnRef,shared.turnRef);assert.match(shared.manifestDigest,/^[a-f0-9]{64}$/);
});
test('provider error details do not leak into manifest',async t=>{
  const s=await setup(t,{readOriginal:async()=>{throw new Error('https://secret.invalid/?token=PRIVATE_TOKEN');}});
  const r=await s.exporter.exportOriginals(s.options);assert.equal(r.manifest.errors[0].code,'ARTIFACT_ERROR');assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'));
});

test('consumer independently fetches, decodes and durably stores before RECEIVED; replay is idempotent',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s);const first=await c.receiver.receive(c.args);
  assert.equal(first.receipt.status,'RECEIVED');assert.equal(c.fetches(),1);
  const second=await createImageConsumerReceiver({...c.config,clock:()=> '2026-09-30T07:01:00.000Z'}).receive(c.args);
  assert.equal(second.reused,true);assert.deepEqual(second.receipt,first.receipt);assert.equal(c.fetches(),1);
  assert.equal(first.receipt.artifactRef,c.output.artifactRef);assert.equal(s.calls.get('out-1'),1);
});
test('consumer current authorization is checked even for duplicate receipt replay',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s);await c.receiver.receive(c.args);
  const denied=createImageConsumerReceiver({...c.config,authorize:async()=>({allowed:false})});await assert.rejects(denied.receive(c.args),/AUTHORIZATION_DENIED/);assert.equal(c.fetches(),1);
});
test('consumer refuses proofs expiring during each async authorization boundary',async t=>{
  for(const expiryCall of [1,2,3]) {
    const s=await setup(t),c=await receiveSetup(t,s);let now=Date.parse(AT),calls=0;
    const expiresAt=new Date(now+500).toISOString();
    const receiver=createImageConsumerReceiver({...c.config,decode:fixtureDecode,clock:()=>new Date(now).toISOString(),authorize:async b=>{
      const proof={...await authorize(b),expiresAt};calls++;if(calls===expiryCall){await Promise.resolve();now+=1000;}return proof;
    }});
    await assert.rejects(receiver.receive(c.args),/AUTHORIZATION_EXPIRED/);
    assert.equal(calls,expiryCall);
    const entries=await fs.readdir(join(s.directory,'consumer'));
    assert.equal(entries.some(n=>n.startsWith('receipt-')),false);
    assert.equal(entries.some(n=>n.startsWith('received-')),expiryCall===3);
  }
});
test('consumer revocation during durable bytes blocks both new receipt and prior receipt replay',async t=>{
  for(const prior of [false,true]) {
    const s=await setup(t),c=await receiveSetup(t,s);const first=prior?await c.receiver.receive(c.args):null;
    let active=true,calls=0;
    const receiver=createImageConsumerReceiver({...c.config,decode:fixtureDecode,
      authorize:async b=>{calls++;return active?authorize(b):{allowed:false};},
      store:{...c.store,async putImmutable(name,bytes){const result=await c.store.putImmutable(name,bytes);if(name.startsWith('received-'))active=false;return result;}}});
    await assert.rejects(receiver.receive(c.args),/AUTHORIZATION_DENIED/);assert.equal(calls,3);
    const entries=await fs.readdir(join(s.directory,'consumer'));
    assert.equal(entries.some(n=>n.startsWith('received-')),true);
    assert.equal(entries.filter(n=>n.startsWith('receipt-')).length,prior?1:0);
    const resumed=await c.receiver.receive(c.args);
    if(prior){assert.equal(resumed.reused,true);assert.deepEqual(resumed.receipt,first.receipt);}
    else assert.equal(resumed.receipt.status,'RECEIVED');
  }
});
test('consumer wrong bytes or dimensions never creates receipt',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s,{resolveArtifact:async()=>({bytes:png({rgba:[0,0,0,255]}),mimeType:'image/png'})});
  await assert.rejects(c.receiver.receive(c.args),/HASH_MISMATCH/);assert.deepEqual(await fs.readdir(join(s.directory,'consumer')),[]);
  const good=createImageConsumerReceiver({...c.config,resolveArtifact:async()=>({bytes:png(),mimeType:'image/png'})});
  await assert.rejects(good.receive({...c.args,output:{...c.output,width:999}}),/HASH_MISMATCH/);
});
test('consumer changed hash for same output conflicts rather than duplicate ingest',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s);await c.receiver.receive(c.args);
  await assert.rejects(c.receiver.receive({...c.args,output:{...c.output,sha256:'f'.repeat(64)}}),/STORE_CONFLICT/);assert.equal(c.fetches(),1);
});
test('consumer partial/unverified output cannot be promoted to received',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s);const output=structuredClone(c.output);output.validation.status='UNVERIFIED';output.validation.checks.count=false;
  await assert.rejects(c.receiver.receive({...c.args,output}),/UNVERIFIED_OUTPUT/);assert.equal(c.fetches(),0);
});
test('consumer storage failure never fabricates received receipt',async t=>{
  const s=await setup(t),root=join(s.directory,'broken-consumer');const store=await createControlledImageStore({root,targetRef:'store:receiver',io:faultIO(()=>true)});
  const c=await receiveSetup(t,s,{store});await assert.rejects(c.receiver.receive(c.args),e=>e.code==='ENOSPC');assert.deepEqual(await fs.readdir(root),[]);
});
test('deleted receiver copy is restored by same artifact hash while receipt identity remains stable',async t=>{
  const s=await setup(t),c=await receiveSetup(t,s);const first=await c.receiver.receive(c.args);
  const root=join(s.directory,'consumer'),name=(await fs.readdir(root)).find(n=>n.startsWith('received-'));await fs.unlink(join(root,name));
  const next=await c.receiver.receive(c.args);assert.deepEqual(next.receipt,first.receipt);assert.equal(c.fetches(),2);
});
test('fixed PR84 contract compatibility is checked from immutable committed blobs, never A worktree',async t=>{
  const fixed='b73d5bf1d5a19436ca9a329e11a9a72f2a361b8b',repo=dirname(dirname(fileURLToPath(import.meta.url)));
  let source,schema;
  try {source=execFileSync('git',['show',`${fixed}:src/capabilities/image/contract.js`],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});schema=execFileSync('git',['show',`${fixed}:src/capabilities/image/schema.v1.json`],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch {t.skip('Pinned PR84 Git object unavailable; integration requires the fixed committed contract, not a substitute.');return;}
  const directory=await scratch(t);await fs.writeFile(join(directory,'contract.mjs'),source);await fs.writeFile(join(directory,'schema.v1.json'),schema);
  const contract=await import(pathToFileURL(join(directory,'contract.mjs')).href);
  const s=await setup(t,{contract});const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'TECHNICALLY_VALIDATED');
  const normalized=contract.normalizeImageRequest(s.req);assert.equal(r.manifest.requestDigest,normalized.requestDigest);
  for(const output of r.manifest.outputs)contract.validateImageOutput(output);
  const c=await receiveSetup(t,s);const received=await c.receiver.receive(c.args);contract.validateImageReceipt(received.receipt);
  assert.equal(received.receipt.requestDigest,normalized.requestDigest);
});


test('caller buffer mutation cannot change bytes mid-verification or immutable store write',async t=>{
  const bytes=png(),original=Buffer.from(bytes);let release;const gate=new Promise(r=>{release=r;});
  const running=verifyImageBytes(bytes,{mimeType:'image/png',decode:async b=>{await gate;return fixtureDecode(b);}});
  bytes.fill(0);release();assert.equal((await running).sha256,sha256(original));
  const s=await setup(t),content=Buffer.from('snapshot');const put=s.store.putImmutable('snapshot.bin',content);content.fill(0);await put;
  assert.equal((await s.store.read('snapshot.bin')).toString(),'snapshot');
});
test('unsafe writable non-sticky ancestors are rejected before root creation',async t=>{
  const d=await scratch(t),ancestor=join(d,'untrusted');await fs.mkdir(ancestor);await fs.chmod(ancestor,0o777);
  await assert.rejects(createControlledImageStore({root:join(ancestor,'store'),targetRef:'store:fixture'}),/STORE_UNSAFE/);
  assert.deepEqual(await fs.readdir(ancestor),[]);
});
test('authorization proof binds the pinned capability snapshot, not just request and target',async t=>{
  const seen=[];const s=await setup(t,{authorize:async b=>{seen.push(b);return b.capabilities?.version==='synthetic-capability/v1'?authorize(b):{allowed:false};}});
  assert.equal((await s.exporter.exportOriginals(s.options)).status,'TECHNICALLY_VALIDATED');assert.equal(seen[0].capabilities.observedAt,AT);
  s.options.capabilities.version='forged-capability';await assert.rejects(s.exporter.exportOriginals(s.options),/AUTHORIZATION_DENIED/);
});
test('an active grant may pin an older snapshot; no implicit capability replacement or arbitrary TTL',async t=>{
  const s=await setup(t);s.options.capabilities.observedAt='2026-09-30T06:00:00.000Z';
  const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'TECHNICALLY_VALIDATED');
  assert.equal(r.manifest.outputs[0].capabilityObservedAt,'2026-09-30T06:00:00.000Z');
});
test('native original channel requires matching native evidence (synthetic fixture only)',async t=>{
  const images=new Map([['out-1',png()]]);const s=await setup(t,{images,readOriginal:provider(images,new Map(),'NATIVE_ORIGINAL')});
  s.options.capabilities=capabilities(s.req,'NATIVE');const r=await s.exporter.exportOriginals(s.options);
  assert.equal(r.status,'TECHNICALLY_VALIDATED');assert.deepEqual(r.manifest.exportModes,['NATIVE']);
});
test('export-only operation enforces exact authorized parent hash without generation',async t=>{
  const base={artifactRef:'artifact:parent:original',sha256:sha256(png()),revisionId:'r1',outputId:'parent-output',jobId:'parent-job'};
  const req=request({operation:'export',inputs:[{...base,role:'source'}],baseRevision:base});
  const s=await setup(t,{req});const r=await s.exporter.exportOriginals(s.options);assert.equal(r.status,'TECHNICALLY_VALIDATED');assert.equal(r.manifest.outputs[0].sha256,base.sha256);
  const wrong=await setup(t,{req,images:new Map([['out-1',png({rgba:[2,3,4,255]})]])});
  const rejected=await wrong.exporter.exportOriginals(wrong.options);assert.equal(rejected.status,'BLOCKED');assert.equal(rejected.manifest.errors[0].code,'HASH_MISMATCH');
});
test('latest fixed contract reducer accepts PARTIAL to VERIFIED and later replay without mutable output conflicts',async t=>{
  const fixed='7c764f2f2d53e939d162665aca9211da5c076778',repo=dirname(dirname(fileURLToPath(import.meta.url)));
  let source,schema;
  try {source=execFileSync('git',['show',`${fixed}:src/capabilities/image/contract.js`],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});schema=execFileSync('git',['show',`${fixed}:src/capabilities/image/schema.v1.json`],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
  catch {t.skip('Latest fixed PR84 Git object unavailable; no uncommitted contract substitution.');return;}
  const temp=await scratch(t);await fs.writeFile(join(temp,'contract.mjs'),source);await fs.writeFile(join(temp,'schema.v1.json'),schema);
  const contract=await import(pathToFileURL(join(temp,'contract.mjs')).href);
  const req=request({count:2}),images=new Map([['out-1',png()],['out-2',artifactError('ORIGINAL_EXPIRED')]]);
  const s=await setup(t,{req,images,contract});s.options.outputs=[slot(),slot('out-2')];
  for(const feature of ['generate','batch'])s.options.capabilities.features[feature]={mode:'ASSISTED',evidence:['urn:synthetic:feature-observation']};
  const grant=contract.normalizeImageGrant({grantId:'synthetic-grant',controllerOperationId:'11111111-1111-4111-8111-111111111111',controllerTaskId:req.controllerTaskId,
    request:req,sourceExternalizationAuthorized:false,expiresAt:FUTURE,capabilities:s.options.capabilities},AT);
  let job=contract.initialImageJob(grant,AT);
  const apply=(event,at=AT)=>{job=contract.applyImageEvent(job,{...event,expectedRevision:job.revision},grant,{at});};
  apply({type:'beginAttempt',eventId:'begin',attemptId:'attempt-1',baselineTurnIds:['old-turn'],modelSelection:s.options.capabilities.modelSelection});
  apply({type:'observation',eventId:'observe',attemptId:'attempt-1',route:req.route,status:'GENERATED',userMessageId:'new-user',turnId:'turn-1',candidateOutputIds:['out-1','out-2'],evidenceRef:'artifact:synthetic:observation'});
  const first=await s.exporter.exportOriginals(s.options);assert.equal(first.status,'PARTIAL');
  apply({type:'export',...imageExportEvent(first,{eventId:'export-partial',expectedRevision:job.revision,route:req.route})});assert.equal(job.status,'PARTIAL');
  images.set('out-2',png({rgba:[19,29,39,255]}));let time='2026-09-30T07:00:01.000Z';
  const resumed=createImageExporter({...s.config,clock:()=>time});const second=await resumed.exportOriginals(s.options);
  apply({type:'export',...imageExportEvent(second,{eventId:'export-complete',expectedRevision:job.revision,route:req.route})},time);
  assert.equal(job.status,'TECHNICALLY_VALIDATED');assert.equal(s.calls.get('out-1'),1);assert.equal(s.calls.get('out-2'),2);
  time='2026-09-30T07:00:02.000Z';const third=await resumed.exportOriginals(s.options);
  apply({type:'export',...imageExportEvent(third,{eventId:'export-replay',expectedRevision:job.revision,route:req.route})},time);
  assert.equal(job.status,'TECHNICALLY_VALIDATED');assert.deepEqual(third.manifest.outputs,second.manifest.outputs);
  assert.throws(()=>imageExportEvent({...third,manifestPersisted:false},{eventId:'bad',expectedRevision:job.revision,route:req.route}),/EXPORT_EVIDENCE_NOT_PERSISTED/);
});
