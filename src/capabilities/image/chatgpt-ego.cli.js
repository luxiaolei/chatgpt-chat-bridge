/** Local queries stay local; prepare authenticates a live route before Ego starts. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as contractModule from './contract.js';
import {createImageJobAPI,imageJobKey,canonicalImageJSON} from './contract.js';
import {normalizeExecutionRequest,imageExecutionProbe} from './chatgpt-ego.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const need=(condition,code)=>{if(!condition) {const error=new Error(code);error.code=code;throw error;}};

async function readOfficialFile(file) {
  need(typeof file==='string' && path.isAbsolute(file) && await fs.realpath(file)===path.resolve(file),'IMAGE_ORIGINAL_FILE_UNSAFE');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const before=await handle.stat();
    need(before.isFile() && before.nlink===1 && before.size>0 && before.size<=25_000_000,'IMAGE_ORIGINAL_FILE_UNSAFE');
    const bytes=Buffer.alloc(before.size+1);let length=0;
    while(length<bytes.length) {const result=await handle.read(bytes,length,bytes.length-length,length);if(!result.bytesRead) break;length+=result.bytesRead;}
    const after=await handle.stat(),named=await fs.lstat(file);
    need(length===before.size && after.size===before.size && after.mtimeMs===before.mtimeMs && named.ino===before.ino && named.dev===before.dev && !named.isSymbolicLink(),'IMAGE_ORIGINAL_FILE_CHANGED');
    return bytes.subarray(0,length);
  } finally {await handle.close();}
}

/** Existing durable grant is host authority. This store only persists authorized
 * evidence/original bytes; it is not another job database or a remote resolver.
 */
export async function createHostImageArtifacts({api,key,stateDir,contract=contractModule,decode,coordinated}={}) {
  const [exporter,verifier,manifest]=await Promise.all([import('./exporter.js'),import('./verifier.js'),import('./manifest.js')]);
  const job=await api.inspect(key),targetRef=job.request.authorizedOutput.targetRef;
  const base=path.join(stateDir,'image-artifacts'),root=path.join(base,hash(targetRef));
  async function storeFor(target) {
    await fs.mkdir(base,{recursive:true,mode:0o700});
    return exporter.createControlledImageStore({root:target,targetRef});
  }
  let outputStore;
  async function store() {return outputStore ||= await storeFor(root);}
  async function assertOperator(operatorRef) {
    need(!process.env.CHAT_BRIDGE_FROM_ACCOUNT_ID && !process.env.CHAT_BRIDGE_FROM_SPACE && typeof coordinated==='function','IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
    await api.authorizeIO(key);
    const current=await api.inspect(key);
    const owner=await coordinated('local-owner-contract',{taskId:current.controllerTaskId,project:current.route.project,
      sessionRef:current.route.sessionRef,callerRef:operatorRef});
    need(owner.kind==='codex' && operatorRef===`codex:${owner.threadId}`,'IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
  }
  async function prepareInbox() {
    await api.authorizeIO(key);
    const current=await api.inspect(key),attempt=current.attempts.at(-1);
    need(attempt,'IMAGE_BASELINE_REQUIRED');
    const inboxBase=path.join(stateDir,'image-original-inbox');
    await fs.mkdir(inboxBase,{recursive:true,mode:0o700});
    const binding=hash(canonicalImageJSON({key,requestDigest:current.requestDigest,attemptId:attempt.attemptId}));
    const inboxRoot=path.join(inboxBase,binding),originalRef=`urn:chatbridge:official-save:${binding}`;
    await exporter.createControlledImageStore({root:inboxRoot,targetRef:originalRef});
    await api.authorizeIO(key);
    return {originalPath:path.join(inboxRoot,'original.bin'),originalRef};
  }
  async function saveEvidence(evidence) {
    await api.authorizeIO(key);
    need(canonicalImageJSON(evidence.route)===canonicalImageJSON(job.route),'IMAGE_EVIDENCE_ROUTE_MISMATCH');
    const bytes=Buffer.from(canonicalImageJSON(evidence)),digest=hash(bytes);
    await (await store()).putImmutable(`evidence-${digest}.json`,bytes);
    await api.authorizeIO(key);
    return `artifact:cbimg-evidence:${hash(targetRef)}:${digest}`;
  }
  function decoder() {
    if(decode) return decode;
    const executable=process.env.CHAT_BRIDGE_IMAGE_DECODER;
    need(typeof executable==='string' && path.isAbsolute(executable),'IMAGE_DECODER_REQUIRED');
    return verifier.createImageMagickDecoder({executable});
  }
  async function authorize(binding) {
    const authority=await api.authorizeIO(key),current=await api.inspect(key),attempt=current.attempts.at(-1);
    need(binding.action==='export' && binding.callerRef===current.caller.ref && binding.jobId===current.jobId &&
      binding.requestDigest===current.requestDigest && binding.targetRef===targetRef &&
      canonicalImageJSON(binding.scope)===canonicalImageJSON(current.scope) && canonicalImageJSON(binding.route)===canonicalImageJSON(current.route) &&
      binding.attemptId===attempt?.attemptId && binding.turnId===attempt?.turnId &&
      canonicalImageJSON(binding.capabilities)===canonicalImageJSON(attempt.capabilities) &&
      binding.outputs.every(output=>attempt.candidateOutputIds.includes(output.outputId)), 'IMAGE_ARTIFACT_BINDING_MISMATCH');
    need(authority.allowed===true && typeof authority.expiresAt==='string','IMAGE_IO_AUTHORITY_EXPIRY_REQUIRED');
    return {allowed:true,bindingDigest:hash(manifest.canonicalArtifactJSON(binding)),expiresAt:authority.expiresAt};
  }
  async function resolveSource(source) {
    await api.authorizeIO(key);
    const current=await api.inspect(key);
    need(current.request.inputs.some(input=>canonicalImageJSON(input)===canonicalImageJSON(source)),'IMAGE_SOURCE_NOT_GRANTED');
    const locator=/^artifact:cbimg:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(source.artifactRef);
    need(locator,'IMAGE_SOURCE_RESOLUTION_UNAVAILABLE');
    const sourceRoot=path.join(base,locator[1]);
    await fs.lstat(sourceRoot); // A missing/remote artifact never creates a source directory.
    const sourceStore=await exporter.createControlledImageStore({root:sourceRoot,targetRef:`store:cbimg-source:${locator[1]}`});
    const recordBytes=await sourceStore.read(`record-${locator[2]}.json`);
    need(recordBytes,'IMAGE_SOURCE_RESOLUTION_UNAVAILABLE');
    const record=JSON.parse(recordBytes.toString('utf8'));
    need(record.artifactRef===source.artifactRef && record.binding.jobId===source.jobId && record.binding.outputId===source.outputId && record.verified.sha256===source.sha256,'IMAGE_SOURCE_BINDING_MISMATCH');
    const bytes=await sourceStore.read(`original-${locator[2]}.bin`);
    need(bytes,'IMAGE_SOURCE_RESOLUTION_UNAVAILABLE');
    const verified=await verifier.verifyImageBytes(bytes,{mimeType:record.verified.mimeType,expectedSha256:source.sha256,
      expectedWidth:record.verified.width,expectedHeight:record.verified.height,decode:decoder()});
    await api.authorizeIO(key);
    return {...source,path:path.join(sourceRoot,`original-${locator[2]}.bin`),mimeType:verified.mimeType,
      turnId:record.binding.turnId,route:current.route};
  }
  async function exportOriginal(input) {
    await api.authorizeIO(key);
    const current=await api.inspect(key),attempt=current.attempts.at(-1);
    need(attempt?.turnId && attempt.candidateOutputIds.includes(input.outputId),'IMAGE_NEW_OUTPUT_REQUIRED');
    const kind=input.kind,mode=kind==='NATIVE_ORIGINAL'?'NATIVE':'ASSISTED';
    need(attempt.capabilities.features.export.mode===mode,'IMAGE_ORIGINAL_MODE_MISMATCH');
    manifest.assertOpaqueRef(input.originalRef);
    const plan={request:current.request,attemptId:attempt.attemptId,turnId:attempt.turnId,capabilities:attempt.capabilities,
      outputs:[{outputId:input.outputId,status:'AVAILABLE',attemptId:attempt.attemptId,turnId:attempt.turnId,
        originalRef:input.originalRef,...(input.sha256?{expectedSha256:input.sha256}:{} )}]};
    const provider=async binding=>{
      await api.authorizeIO(key);
      const bytes=await readOfficialFile(input.path);
      await api.authorizeIO(key);
      return {bytes,mimeType:input.mimeType||verifier.sniffImageMime(bytes),provenance:{kind,jobId:current.jobId,
        attemptId:attempt.attemptId,turnId:attempt.turnId,outputId:binding.outputId,originalRef:binding.originalRef}};
    };
    const result=await exporter.createImageExporter({contract,store:await store(),authorize,readOriginal:provider,decode:decoder()}).exportOriginals(plan);
    await api.authorizeIO(key);
    if(!result.manifestPersisted || !result.manifest.outputs.length) return {ok:false,status:result.status,manifest:result.publicManifest,retryAllowed:false};
    const latest=await api.inspect(key);
    const saved=await api.export(key,manifest.imageExportEvent(result,{eventId:'export-'+hash(`${result.manifestRef}:${latest.revision}`),expectedRevision:latest.revision,route:current.route}));
    return {ok:true,status:saved.status,manifest:result.publicManifest,manifestRef:result.manifestRef,deliveryStatus:'NOT_RECEIVED',businessApproval:'NOT_EVALUATED'};
  }
  async function importOfficialOriginal(input) {
    await assertOperator(input.operatorRef);
    await api.authorizeIO(key);
    const current=await api.inspect(key),attempt=current.attempts.at(-1),proof=input.officialSave;
    const inbox=await prepareInbox();
    need(input.path===inbox.originalPath && input.originalRef===inbox.originalRef,'IMAGE_ORIGINAL_INBOX_REQUIRED');
    need(attempt && proof?.confirmed===true && proof.requestDigest===current.requestDigest && proof.attemptId===attempt.attemptId &&
      proof.turnId===attempt.turnId && proof.outputId===input.outputId && proof.originalRef===input.originalRef &&
      canonicalImageJSON(proof.route)===canonicalImageJSON(current.route) && /^[a-f0-9]{64}$/.test(input.sha256||''),'IMAGE_OFFICIAL_SAVE_ATTESTATION_REQUIRED');
    await saveEvidence({route:current.route,jobId:current.jobId,observedAt:new Date().toISOString(),mode:'ASSISTED',
      proof:'operator-confirmed-official-save',operatorRef:input.operatorRef,requestDigest:current.requestDigest,attemptId:attempt.attemptId,turnId:attempt.turnId,
      outputId:input.outputId,originalRef:input.originalRef,sha256:input.sha256});
    return exportOriginal({...input,kind:'OFFICIAL_HANDOFF'});
  }
  async function verifyAssistedOriginal(input) {
    await assertOperator(input.operatorRef);
    await api.authorizeIO(key);
    const inbox=await prepareInbox();
    need(input.path===inbox.originalPath && input.originalRef===inbox.originalRef,'IMAGE_ORIGINAL_INBOX_REQUIRED');
    need(/^[a-f0-9]{64}$/.test(input.sha256||''),'IMAGE_ORIGINAL_HASH_REQUIRED');
    const bytes=await readOfficialFile(inbox.originalPath);
    const verified=await verifier.verifyImageBytes(bytes,{mimeType:input.mimeType||verifier.sniffImageMime(bytes),expectedSha256:input.sha256,decode:decoder()});
    await api.authorizeIO(key);
    const current=await api.inspect(key);
    need(!current.request.inputs.some(source=>source.sha256===verified.sha256),'IMAGE_SOURCE_IMAGE_REUSED');
    return verified;
  }
  return Object.freeze({saveEvidence,resolveSource,assertOperator,prepareInbox,verifyAssistedOriginal,exportOriginal,importOfficialOriginal});
}

export async function imageCli(action,payload={}, {coordinated,executor,liveAction,decode,stateDir=process.env.CHAT_BRIDGE_STATE_DIR||path.join(homedir(),'.local/state/chat-bridge')}={}) {
  if (action==='probe') return imageExecutionProbe(payload.route ?? null);
  if (action==='validate') {
    const request=normalizeExecutionRequest(payload.request);
    return {ok:true,requestDigest:request.requestDigest,operation:request.operation,jobId:request.jobId};
  }
  if (['start','reconcile'].includes(action)) {
    if (!executor) throw new Error('IMAGE_NATIVE_ENTRY_REQUIRED');
    return action==='start'?executor.start(payload.request,payload):executor.reconcile(payload.key);
  }
  if (!['prepare','submit','inspect','result','cancel','import-original'].includes(action)) throw new Error('IMAGE_COMMAND_UNSUPPORTED');
  const api=createImageJobAPI({coordinated});
  if (action==='import-original') return (await createHostImageArtifacts({api,key:payload.key,stateDir,decode,coordinated})).importOfficialOriginal(payload);
  if (action==='prepare') {
    if (!['start','reconcile','characterize','download-original','assist-observe'].includes(liveAction)) throw new Error('IMAGE_COMMAND_UNSUPPORTED');
    const request=liveAction==='start'?normalizeExecutionRequest(payload.request):null;
    const key=request?imageJobKey(request,payload.grantId):payload.key;
    const job=request?await api.submit(request,{grantId:payload.grantId}):await api.inspect(key);
    return {payload:{...payload,key,...(request?{request}:{} )},route:job.route};
  }
  if (action==='submit') return api.submit(normalizeExecutionRequest(payload.request),{grantId:payload.grantId});
  if (action==='cancel') return api.cancel(payload.key,payload.event);
  return api[action](payload);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks=[];let length=0;
    for await (const chunk of process.stdin) {
      length+=chunk.length;
      if (length>2_000_000) throw new Error('IMAGE_PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8'),payload=raw.trim()?JSON.parse(raw):{};
    const config=process.env.CHAT_BRIDGE_CONFIG_DIR || path.join(homedir(),'.config/chat-bridge');
    const state=process.env.CHAT_BRIDGE_STATE_DIR || path.join(homedir(),'.local/state/chat-bridge');
    const coordinator=fileURLToPath(new URL('../../coordinator.py',import.meta.url));
    const coordinated=(command,input)=>{
      const result=spawnSync('python3',[coordinator,command,config,state],{encoding:'utf8',input:JSON.stringify(input),timeout:20000,maxBuffer:4*1024*1024});
      if (result.status!==0) {
        // Do not reflect a raw subprocess stderr, request prompt or local path.
        let reason='IMAGE_COORDINATOR_UNAVAILABLE';
        try {const detail=JSON.parse(result.stderr);if (/^[A-Z][A-Z0-9_:.-]{0,180}$/.test(detail.error || '')) reason=detail.error;} catch {}
        throw new Error(reason);
      }
      return JSON.parse(result.stdout);
    };
    const result=await imageCli(process.argv[2] || 'probe',payload,{coordinated,liveAction:process.argv[3]});
    process.stdout.write(JSON.stringify(result)+'\n');
    if (result.ok===false) process.exitCode=2;
  } catch (error) {
    const code=/^[A-Z][A-Z0-9_:.-]{0,180}$/.test(error.message || '')?error.message:'IMAGE_INVALID_INPUT';
    process.stderr.write(JSON.stringify({ok:false,code,deliveryStage:'PRE_SEND'})+'\n');
    process.exitCode=2;
  }
}
