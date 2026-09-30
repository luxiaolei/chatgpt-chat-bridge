/** Local queries stay local; prepare authenticates a live route before Ego starts. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {homedir,hostname} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as contractModule from './contract.js';
import {createImageJobAPI,imageJobKey,canonicalImageJSON} from './contract.js';
import {normalizeExecutionRequest,imageExecutionProbe} from './chatgpt-ego.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const need=(condition,code)=>{if(!condition) {const error=new Error(code);error.code=code;throw error;}};

/** Only prepare creates this envelope, from its actual authenticated client
 * environment. Ego does not inherit that environment. Forward it solely to the
 * exact invocation's coordinator calls, never into persistent process.env.
 */
export function imageCallerEnvironment(prepared,command,payload,environment=process.env) {
  if(!command.startsWith('image-') && command!=='local-owner-contract')return undefined;
  const context=prepared?.callerContext;
  need(context && context.version===1 && context.host===hostname() && canonicalImageJSON(context.key)===canonicalImageJSON(prepared.payload.key) && canonicalImageJSON(context.route)===canonicalImageJSON(prepared.route),'IMAGE_CALLER_CONTEXT_REQUIRED');
  const caller=context.environment;
  need(caller && Object.keys(caller).sort().join(',')==='CHAT_BRIDGE_FROM_ACCOUNT_ID,CHAT_BRIDGE_FROM_SPACE,CODEX_THREAD_ID' && Object.values(caller).every(value=>typeof value==='string'),'IMAGE_CALLER_CONTEXT_REQUIRED');
  if(context.kind==='local-owner')need(!caller.CHAT_BRIDGE_FROM_ACCOUNT_ID && !caller.CHAT_BRIDGE_FROM_SPACE && context.owner?.threadId===caller.CODEX_THREAD_ID && context.owner.host===context.host,'IMAGE_CALLER_CONTEXT_REQUIRED');
  else if(context.kind==='remote-origin')need(caller.CHAT_BRIDGE_FROM_ACCOUNT_ID===context.route.accountId,'IMAGE_CALLER_CONTEXT_REQUIRED');
  else need(context.kind==='host' && !caller.CHAT_BRIDGE_FROM_ACCOUNT_ID && !caller.CHAT_BRIDGE_FROM_SPACE,'IMAGE_CALLER_CONTEXT_REQUIRED');
  if(command==='image-submit')need(payload.grantId===context.key.grantId && payload.request.requestDigest===context.requestDigest && canonicalImageJSON(imageJobKey(payload.request,payload.grantId))===canonicalImageJSON(context.key),'IMAGE_CALLER_SCOPE_MISMATCH');
  else if(command==='image-session-occupancy')need(payload.session.accountId===context.route.accountId && (!payload.key || canonicalImageJSON(payload.key)===canonicalImageJSON(context.key) && payload.session.conversationId===context.route.conversationId),'IMAGE_CALLER_SCOPE_MISMATCH');
  else if(command==='local-owner-contract')need(context.kind==='local-owner' && payload.taskId===context.controllerTaskId && payload.project===context.route.project && payload.sessionRef===context.route.sessionRef && payload.callerRef===`codex:${context.owner.threadId}`,'IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
  else need(canonicalImageJSON({grantId:payload.grantId,callerRef:payload.callerRef,jobId:payload.jobId,scope:payload.scope})===canonicalImageJSON(context.key) && (!payload.event?.route || canonicalImageJSON(payload.event.route)===canonicalImageJSON(context.route)),'IMAGE_CALLER_SCOPE_MISMATCH');
  const runtime=prepared.runtimeConfig;
  need(runtime && Object.keys(runtime).sort().join(',')==='decoderExecutable,nodeExecutable' &&
    typeof runtime.nodeExecutable==='string' && path.isAbsolute(runtime.nodeExecutable) && !runtime.nodeExecutable.includes('\0') &&
    (runtime.decoderExecutable===null || typeof runtime.decoderExecutable==='string' && path.isAbsolute(runtime.decoderExecutable) && !runtime.decoderExecutable.includes('\0')),'IMAGE_RUNTIME_CONFIG_REQUIRED');
  // The coordinator's existing schema helper invokes node by name. Ego's PATH
  // lacks the actual CLI Node installation; add only its captured directory.
  return {...environment,...caller,PATH:[path.dirname(runtime.nodeExecutable),environment.PATH].filter(Boolean).join(path.delimiter)};
}

function captureImageCaller(job,key,action,coordinated,callerEnv) {
  const environment=Object.fromEntries(['CODEX_THREAD_ID','CHAT_BRIDGE_FROM_ACCOUNT_ID','CHAT_BRIDGE_FROM_SPACE'].map(name=>[name,String(callerEnv[name]||'')]));
  const context={version:1,host:hostname(),action,key,route:job.route,requestDigest:job.requestDigest,controllerTaskId:job.controllerTaskId,environment};
  if(environment.CHAT_BRIDGE_FROM_ACCOUNT_ID) {
    need(environment.CHAT_BRIDGE_FROM_ACCOUNT_ID===job.route.accountId,'IMAGE_ACCESS_DENIED');
    return {...context,kind:'remote-origin'};
  }
  need(!environment.CHAT_BRIDGE_FROM_SPACE,'IMAGE_ORIGIN_UNVERIFIED');
  if(environment.CODEX_THREAD_ID) {
    const owner=coordinated('local-owner-contract',{taskId:job.controllerTaskId,project:job.route.project,sessionRef:job.route.sessionRef,callerRef:`codex:${environment.CODEX_THREAD_ID}`});
    need(owner.kind==='codex' && owner.threadId===environment.CODEX_THREAD_ID && owner.host===context.host,'IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
    return {...context,kind:'local-owner',owner};
  }
  return {...context,kind:'host'};
}

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
export async function createHostImageArtifacts({api,key,stateDir,contract=contractModule,decode,coordinated,callerContext,decoderExecutable=process.env.CHAT_BRIDGE_IMAGE_DECODER}={}) {
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
    const origin=callerContext?.environment||process.env;
    need(!origin.CHAT_BRIDGE_FROM_ACCOUNT_ID && !origin.CHAT_BRIDGE_FROM_SPACE && typeof coordinated==='function','IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
    if(callerContext)need(callerContext.kind==='local-owner' && callerContext.host===hostname() && canonicalImageJSON(callerContext.key)===canonicalImageJSON(key) && operatorRef===`codex:${callerContext.owner?.threadId}` && callerContext.owner.host===callerContext.host,'IMAGE_OPERATOR_HOST_OWNER_REQUIRED');
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
    need(typeof decoderExecutable==='string' && path.isAbsolute(decoderExecutable),'IMAGE_DECODER_REQUIRED');
    return verifier.createImageMagickDecoder({executable:decoderExecutable});
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

export async function imageCli(action,payload={}, {coordinated,executor,liveAction,decode,callerEnv=process.env,stateDir=process.env.CHAT_BRIDGE_STATE_DIR||path.join(homedir(),'.local/state/chat-bridge')}={}) {
  if (['batch-create','batch-inspect','batch-decision'].includes(action)) return coordinated('image-'+action,payload);
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
    const callerContext=captureImageCaller(job,key,liveAction,coordinated,callerEnv);
    // Runtime configuration is captured after access/owner validation, outside
    // the request payload. No caller-provided path or whole environment is used.
    const decoderExecutable=callerEnv.CHAT_BRIDGE_IMAGE_DECODER||null;
    need(decoderExecutable===null || typeof decoderExecutable==='string' && path.isAbsolute(decoderExecutable) && !decoderExecutable.includes('\0'),'IMAGE_DECODER_REQUIRED');
    return {payload:{...payload,key,...(request?{request}:{} )},route:job.route,callerContext,
      runtimeConfig:{nodeExecutable:process.execPath,decoderExecutable}};
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
