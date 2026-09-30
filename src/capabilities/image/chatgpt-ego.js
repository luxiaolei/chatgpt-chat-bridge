/**
 * Single-image execution adapter. Ports are host-owned dependencies, NOT request
 * fields or a second durable schema. No browser, scheduler or store is created.
 * The CLI/main entry supplies the existing route, admission and Ego UI gates.
 */
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open, realpath, mkdtemp, chmod, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalImageJSON, normalizeImageRequest, imageJobKey, imageCapabilityGate,
  validateImageShape, unknownImageCapabilities} from './contract.js';

export const IMAGE_ADAPTER_VERSION = 'chatgpt-ego/single-image-v1';
export const IMAGE_INPUT_MAX_BYTES = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REF = /^(artifact|store|urn):[^\s]+$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => a !== undefined && b !== undefined && canonicalImageJSON(a) === canonicalImageJSON(b);
const clone = value => JSON.parse(canonicalImageJSON(value));
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const requireId = value => { if (typeof value !== 'string' || !ID.test(value)) fail('IMAGE_INVALID_ID'); return value; };
const atISO = now => new Date(now()).toISOString();
const safeError = error => /^[A-Z][A-Z0-9_:.-]{0,180}$/.test(error?.code || '') ? error.code : 'IMAGE_ADAPTER_PORT_ERROR';
const blocked = reason => ({ok:false,status:'BLOCKED',reason,retryAllowed:false});

export function imageExecutionProbe(route = null) {
  return {ok:true,adapterVersion:IMAGE_ADAPTER_VERSION,implemented:['generate','edit','refine'],
    nativeReady:false,mode:'UNKNOWN',reason:'IMAGE_NATIVE_CHARACTERIZATION_REQUIRED',
    capabilities:route ? unknownImageCapabilities(validateImageShape(clone(route),'Route')) : null,
    originalExport:{status:'EXPORT_UNAVAILABLE',mode:'ASSISTED',action:'USE_OFFICIAL_SAVE_AND_VERIFY_ORIGINAL'},
    unsupported:['multiReference','mask','batch','temporaryConversation'],
    missing:['verified-native-image-provenance','official-original-download-characterization'],
    businessApproval:'NOT_EVALUATED'};
}

export function normalizeExecutionRequest(input) {
  const request = normalizeImageRequest(input);
  if (!['generate','edit','refine'].includes(request.operation)) fail('IMAGE_EXECUTION_OPERATION_UNSUPPORTED');
  if (request.count !== 1) fail('IMAGE_COUNT_UNSUPPORTED');
  if (request.mask) fail('IMAGE_MASK_UNSUPPORTED');
  if (request.inputs.length > 1) fail('IMAGE_MULTI_REFERENCE_UNSUPPORTED');
  if (request.operation === 'generate' && request.inputs.length) fail('IMAGE_REFERENCE_GENERATION_UNSUPPORTED');
  if (request.operation === 'refine' && (!request.baseRevision?.jobId || !request.baseRevision?.outputId)) fail('IMAGE_REFINE_PARENT_REQUIRED');
  return request;
}

export const imagePromptHash = text => sha(String(text).replace(/\s+/g,' ').trim());
export function imageExecutionPrompt(input, attemptId) {
  const request = normalizeExecutionRequest(input);
  requireId(attemptId);
  const marker = sha(`${IMAGE_ADAPTER_VERSION}\n${request.requestDigest}\n${attemptId}`);
  const instruction = request.operation === 'generate' ? 'Generate one image.' :
    request.operation === 'edit' ? 'Edit the single attached source image.' : 'Refine the single attached, source-version-bound image in this conversation.';
  return `${instruction} Requested aspect ratio: ${request.aspectRatio}.\n${request.prompt}\n[ChatBridge image attempt ${marker}]`;
}

/** A snapshot must be collected under the EXISTING verified route/ownership gate.
 * It is never accepted from an external JSON request. Missing observations fail
 * closed; Latest or a subscription label is not native image evidence.
 */
export function assertImageSnapshot(request, snapshot, {sending = false} = {}) {
  if (!snapshot || !same(snapshot.route,request.route)) fail('IMAGE_ROUTE_MISMATCH');
  if (snapshot.identityVerified !== true || snapshot.projectVerified !== true) fail('IMAGE_ROUTE_UNVERIFIED');
  if (snapshot.ownership !== 'agent') fail('IMAGE_USER_CONTROL_REQUIRED');
  if (snapshot.online !== true) fail('IMAGE_OFFLINE');
  if (snapshot.loginRequired) fail('IMAGE_LOGIN_REQUIRED');
  if (snapshot.challengeRequired) fail('IMAGE_CHALLENGE_REQUIRED');
  if (snapshot.quotaLimited) fail('WEB_COOLDOWN_ACTIVE');
  if (snapshot.conversationMode !== 'normal') fail('IMAGE_TEMPORARY_OR_UNKNOWN_CONVERSATION');
  if (snapshot.messagesComplete !== true || !Array.isArray(snapshot.messages) || snapshot.messages.length > 4096) fail('IMAGE_TURN_EVIDENCE_INCOMPLETE');
  const ids = snapshot.messages.map(message => requireId(message.id));
  if (new Set(ids).size !== ids.length || snapshot.messages.some(m => !['user','assistant'].includes(m.role))) fail('IMAGE_TURN_EVIDENCE_AMBIGUOUS');
  if (sending) {
    if (snapshot.generating || snapshot.inputReady !== true) fail('CHAT_BUSY');
    if (String(snapshot.composerText || '').trim()) fail('USER_DRAFT_PRESENT');
    if (!Array.isArray(snapshot.attachments) || snapshot.attachments.length) fail('IMAGE_EXISTING_ATTACHMENT');
  }
  return snapshot;
}

export function imageAttemptBaseline(request, snapshot, modelSelection) {
  assertImageSnapshot(request,snapshot,{sending:true});
  validateImageShape(modelSelection,'ModelSelection');
  if (!modelSelection.verified || modelSelection.model !== request.requestedModel || modelSelection.effort !== request.requestedEffort) fail('IMAGE_MODEL_SELECTION_MISMATCH');
  return {baselineTurnIds:snapshot.messages.map(m=>m.id),modelSelection:clone(modelSelection)};
}

/** Validate and privately stage the already-authorized source for #58's local
 * upload path. No remote URL or base64 fetch; decode/export belongs to #79.
 * The resolver must independently enforce tenant/object/revision rights.
 */
export async function stageImageSource(input, resolved, {sourceTurnId = null} = {}) {
  const request = normalizeExecutionRequest(input), expected = request.inputs[0];
  if (!expected || !resolved) fail('IMAGE_SOURCE_RESOLUTION_REQUIRED');
  for (const field of ['artifactRef','sha256','revisionId','jobId','outputId']) {
    if (resolved[field] !== expected[field]) fail('IMAGE_SOURCE_BINDING_MISMATCH');
  }
  if (request.operation === 'refine' && (!sourceTurnId || resolved.turnId !== sourceTurnId || !same(resolved.route,request.route))) fail('IMAGE_SOURCE_CONVERSATION_MISMATCH');
  if (typeof resolved.path !== 'string' || !path.isAbsolute(resolved.path)) fail('IMAGE_LOCAL_PATH_REQUIRED');
  // Reject leaf and ancestor symlinks. Same-OS-user adversarial filesystem races
  // are not an isolation boundary; private immutable staging limits upload TOCTOU.
  if (await realpath(resolved.path) !== path.resolve(resolved.path)) fail('IMAGE_SOURCE_SYMLINK');
  const file = await open(resolved.path,constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await file.stat();
    if (!before.isFile()) fail('IMAGE_FILE_UNSAFE');
    if (before.size < 1 || before.size > IMAGE_INPUT_MAX_BYTES) fail('IMAGE_FILE_TOO_LARGE');
    bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes,length,bytes.length-length,length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('IMAGE_SOURCE_CHANGED');
    bytes = bytes.subarray(0,length);
  } finally { await file.close(); }
  if (sha(bytes) !== expected.sha256) fail('IMAGE_SOURCE_HASH_MISMATCH');
  const mimeType = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' :
    bytes.subarray(0,3).equals(Buffer.from([255,216,255])) ? 'image/jpeg' :
    bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : null;
  if (!mimeType) fail('IMAGE_MIME_UNSUPPORTED');
  if (resolved.mimeType && mimeType !== resolved.mimeType) fail('IMAGE_MIME_MISMATCH');
  const directory = await mkdtemp(path.join(await realpath(tmpdir()),'chatbridge-image-input-'));
  try {
    await chmod(directory,0o700);
    const target = path.join(directory,`source.${mimeType.split('/')[1]}`);
    await writeFile(target,bytes,{flag:'wx',mode:0o600});
    return {path:target,mimeType,sha256:expected.sha256,byteLength:bytes.length,
      release:()=>rm(directory,{recursive:true,force:true})};
  } catch (error) { await rm(directory,{recursive:true,force:true}); throw error; }
}

/** Pure, deliberately conservative classifier of native observations.
 * kind/proof/createdByTurnId are supplied ONLY by a separately verified native
 * observer, never derived from alt text, prompt text or an arbitrary <img>.
 */
export function classifyImageObservation({request:input,attempt,snapshot}) {
  const request = normalizeExecutionRequest(input);
  assertImageSnapshot(request,snapshot);
  if (!attempt || !ID.test(attempt.attemptId || '') || !Array.isArray(attempt.baselineTurnIds)) fail('IMAGE_BASELINE_REQUIRED');
  const baseline = new Set(attempt.baselineTurnIds);
  const expectedHash = imagePromptHash(imageExecutionPrompt(request,attempt.attemptId));
  const users = snapshot.messages.filter(m=>m.role === 'user' && !baseline.has(m.id) && m.promptHash === expectedHash);
  if (users.length !== 1) return {status:null,reason:users.length?'IMAGE_USER_TURN_AMBIGUOUS':'IMAGE_DELIVERY_NOT_OBSERVED'};
  const user = users[0], index = snapshot.messages.indexOf(user);
  if (attempt.userMessageId && attempt.userMessageId !== user.id) fail('IMAGE_USER_TURN_CHANGED');
  const tail = snapshot.messages.slice(index+1);
  if (tail.some(m=>m.role === 'user')) fail('IMAGE_INTERVENING_USER_TURN');
  const assistants = tail.filter(m=>m.role === 'assistant' && !baseline.has(m.id));
  if (assistants.length > 1) return {status:null,reason:'IMAGE_ASSISTANT_TURN_AMBIGUOUS'};
  const assistant = assistants[0];
  const binding = {userMessageId:user.id,turnId:assistant?.id ?? null};
  if (!assistant) return {status:'GENERATING',...binding,reason:'IMAGE_USER_RECEIVED_WAITING_FOR_ASSISTANT'};
  if (!assistant.parentUserId) return {status:null,reason:'IMAGE_PARENT_USER_UNVERIFIED'};
  if (assistant.parentUserId !== user.id) fail('IMAGE_PARENT_USER_UNVERIFIED');
  if (attempt.turnId && attempt.turnId !== assistant.id) fail('IMAGE_TURN_CHANGED');
  if (snapshot.refusalTurnId === assistant.id) return {status:'FAILED',...binding,reason:'IMAGE_REQUEST_REFUSED'};
  const sourceHashes = new Set(request.inputs.map(s=>s.sha256));
  if (assistant.images != null && (!Array.isArray(assistant.images) || assistant.images.length > 32)) fail('IMAGE_NATIVE_EVIDENCE_LIMIT');
  const candidates = (assistant.images || []).filter(image=>
    image.kind === 'generated' && image.proof === 'native-generated-output' &&
    image.createdByTurnId === assistant.id && image.ownerTurnId === assistant.id &&
    image.renderState === 'complete' && image.thumbnail === false && image.placeholder === false &&
    Number.isSafeInteger(image.width) && image.width > 0 && image.width <= 65536 && Number.isSafeInteger(image.height) && image.height > 0 && image.height <= 65536 &&
    typeof image.nativeAssetId === 'string' && image.nativeAssetId.length > 0 && image.nativeAssetId.length <= 512 &&
    !sourceHashes.has(image.sha256) && image.sourceReference === false
  );
  const unique = new Map();
  for (const image of candidates) {
    const outputId = 'image-' + sha(`${request.requestDigest}\n${attempt.attemptId}\n${assistant.id}\n${image.nativeAssetId}`);
    if (unique.has(outputId)) fail('IMAGE_OUTPUT_EVIDENCE_AMBIGUOUS');
    // IDs and dimensions only. Do not publish signed URLs, arbitrary DOM text,
    // browser cookies, private prompts or a thumbnail path as an original.
    unique.set(outputId,{outputId,turnId:assistant.id,width:image.width,height:image.height,
      nativeAssetKey:sha(image.nativeAssetId),originalBytesVerified:false});
  }
  if (unique.size > request.count) fail('IMAGE_OUTPUT_COUNT_MISMATCH');
  if (unique.size && (assistant.settled !== true || snapshot.generating !== false)) return {status:'GENERATING',...binding,reason:'IMAGE_NATIVE_TOOL_NOT_SETTLED'};
  if (unique.size === request.count) return {status:'GENERATED',...binding,candidateOutputIds:[...unique.keys()],candidates:[...unique.values()],reason:null};
  if (assistant.nativeProvenanceVerified === false) return {status:null,reason:'IMAGE_NATIVE_PROVENANCE_UNVERIFIED'};
  if (assistant.settled === true && snapshot.generating === false) return {status:'FAILED',...binding,reason:'IMAGE_NO_GENERATED_OUTPUT'};
  return {status:'GENERATING',...binding,reason:'IMAGE_OUTPUT_NOT_YET_OBSERVED'};
}

export function imageCandidateHandoff(job, attempt, observation) {
  if (observation.status !== 'GENERATED') fail('IMAGE_NEW_OUTPUT_REQUIRED');
  return {adapterVersion:IMAGE_ADAPTER_VERSION,jobId:job.jobId,requestDigest:job.requestDigest,
    route:clone(job.route),attemptId:attempt.attemptId,turnId:observation.turnId,
    candidateOutputIds:clone(observation.candidateOutputIds),candidates:clone(observation.candidates),
    sourceHashes:job.request.inputs.map(s=>s.sha256),parentOutputId:job.request.baseRevision?.outputId ?? null,
    baseRevisionId:job.request.baseRevision?.revisionId ?? null,
    capabilityVersion:attempt.capabilities.version,capabilityObservedAt:attempt.capabilities.observedAt,
    authorizedOutput:clone(job.request.authorizedOutput),originalExportStatus:'EXPORT_UNAVAILABLE',
    businessApproval:'NOT_EVALUATED'};
}

/** Host-owned ports:
 * api: #77 createImageJobAPI; withUi: existing account pacing + live Ego gate;
 * assertSessionAdmission: existing durable cross-job session admission (required);
 * evidenceSink: authorized portable evidence store; resolveSource: scoped store.
 * No production port is guessed here. Each start/reconcile holds at most one
 * bounded UI round, never a generation wait. The caller decides when to poll.
 */
export function createImageExecutionAdapter({api,withUi,assertSessionAdmission,evidenceSink,resolveSource,now=Date.now} = {}) {
  if (!api || ['submit','inspect','beginAttempt','record','reconcile','cancel','result'].some(k=>typeof api[k] !== 'function')) fail('IMAGE_COORDINATOR_REQUIRED');
  const ready = () => {
    if (typeof withUi !== 'function' || typeof assertSessionAdmission !== 'function' || typeof evidenceSink !== 'function') fail('IMAGE_EXECUTION_INTEGRATION_REQUIRED');
  };
  async function saveEvidence(evidence) {
    const ref = await evidenceSink(clone(evidence));
    if (typeof ref !== 'string' || !REF.test(ref) || ref.length > 512) fail('IMAGE_EVIDENCE_STORAGE_REQUIRED');
    return ref;
  }
  async function recordObservation(key,job,attempt,snapshot,method) {
    const observed = classifyImageObservation({request:job.request,attempt,snapshot});
    if (!observed.status) return {ok:true,status:job.status,observationReason:observed.reason,retryAllowed:false};
    if (attempt.candidateOutputIds?.length && observed.status === 'GENERATING') return {ok:true,status:job.status,observationReason:'IMAGE_KNOWN_GENERATION_RETAINED',retryAllowed:false};
    const evidence = {adapterVersion:IMAGE_ADAPTER_VERSION,requestDigest:job.requestDigest,route:job.route,
      attemptId:attempt.attemptId,observedAt:atISO(now),...observed};
    const evidenceRef = await saveEvidence(evidence);
    const event = {eventId:'observation-'+sha(canonicalImageJSON({...evidence,revision:job.revision})),expectedRevision:job.revision,
      attemptId:attempt.attemptId,route:job.route,status:observed.status,evidenceRef,
      userMessageId:observed.userMessageId,turnId:observed.turnId};
    if (observed.reason !== null) event.reason=observed.reason;
    if (observed.candidateOutputIds) event.candidateOutputIds=observed.candidateOutputIds;
    const saved = await api[method](key,event);
    const adopted = saved.status === 'GENERATED' && !saved.warnings?.includes('LATE_RESULT_NOT_ADOPTED') && !saved.cancelRequestedAt;
    return {ok:true,status:saved.status,revision:saved.revision,retryAllowed:false,
      ...(adopted ? {handoff:imageCandidateHandoff(saved,saved.attempts.at(-1),observed)} : {}),
      originalExportStatus:'EXPORT_UNAVAILABLE',businessApproval:'NOT_EVALUATED'};
  }
  async function start(input,{grantId,attemptId=randomUUID(),eventId=randomUUID()}={}) {
    const request = normalizeExecutionRequest(input), key = imageJobKey(request,grantId);
    const job = await api.submit(request,{grantId}); // Authorization precedes all UI and source I/O.
    if (!['SUBMITTED','FAILED_PRE_SEND','BLOCKED'].includes(job.status) || job.attempts.some(a=>a.status !== 'FAILED_PRE_SEND')) {
      return {ok:true,status:job.status,action:'RECONCILE_ONLY',retryAllowed:false};
    }
    const gate = imageCapabilityGate(request,job.capabilities,atISO(now));
    if (!gate.allowed) return blocked(gate.reason);
    const assisted=gate.mode==='ASSISTED';
    ready();requireId(attemptId);requireId(eventId);
    if (request.inputs.length && typeof resolveSource !== 'function') return blocked('IMAGE_SOURCE_RESOLUTION_REQUIRED');
    return withUi(request.route,async ui => {
      await assertSessionAdmission({key,request,job,phase:'before-reservation'});
      const first = await ui.inspect();
      assertImageSnapshot(request,first,{sending:true});
      const selected = await ui.selectResources({model:request.requestedModel,effort:request.requestedEffort});
      const before = await ui.inspect(), baseline = imageAttemptBaseline(request,before,selected);
      const reserved = await api.beginAttempt(key,{eventId,expectedRevision:job.revision,attemptId,...baseline});
      if (reserved.effectAdmission !== 'NEWLY_RESERVED') return {ok:true,status:reserved.status,action:'RECONCILE_ONLY',retryAllowed:false};
      if(assisted) {
        // Reservation is UNKNOWN until exact manual delivery/official-original
        // attestation. This branch never fills, uploads, clicks, retries or stops.
        const manualInput=request.inputs.length?await resolveSource(request.inputs[0],{key,scope:request.scope}):null;
        await assertSessionAdmission({key,request,job:reserved,phase:'before-send'});
        return {ok:true,status:reserved.status,revision:reserved.revision,mode:'ASSISTED',action:'MANUAL_SEND_REQUIRED',
          attemptId,requestDigest:request.requestDigest,key,route:request.route,modelSelection:baseline.modelSelection,
          prompt:imageExecutionPrompt(request,attemptId),manualInput,retryAllowed:false,remoteGeneration:'UNKNOWN'};
      }
      let staged = null,sendAttempted = false;
      try {
        if (request.inputs.length) {
          await assertSessionAdmission({key,request,job:reserved,phase:'before-upload'});
          staged = await stageImageSource(request,await resolveSource(request.inputs[0],{key,scope:request.scope}),{sourceTurnId:reserved.sourceTurnId});
          const upload = await ui.upload(staged);
          if (upload?.accepted !== true) fail('IMAGE_ATTACHMENT_NOT_ACCEPTED');
        }
        const prompt = imageExecutionPrompt(request,attemptId);
        const preFill = await ui.inspect();
        assertImageSnapshot(request,preFill);
        if (preFill.generating || preFill.inputReady !== true) fail('CHAT_BUSY');
        if (String(preFill.composerText || '').trim()) fail('USER_DRAFT_PRESENT');
        if (!Array.isArray(preFill.attachments) || preFill.attachments.length !== request.inputs.length || preFill.attachments.some(a=>a.accepted !== true)) fail('IMAGE_ATTACHMENT_NOT_ACCEPTED');
        await ui.fill(prompt);
        const final = await ui.inspect();
        assertImageSnapshot(request,final);
        if (final.generating || final.inputReady !== true || imagePromptHash(final.composerText) !== imagePromptHash(prompt)) fail('IMAGE_COMPOSER_CHANGED');
        if (!Array.isArray(final.attachments) || final.attachments.length !== request.inputs.length || final.attachments.some(a=>a.accepted !== true)) fail('IMAGE_ATTACHMENT_NOT_ACCEPTED');
        if (!same(final.messages.map(m=>m.id),baseline.baselineTurnIds)) fail('IMAGE_BASELINE_CHANGED');
        await assertSessionAdmission({key,request,job:reserved,phase:'before-send'});
        const current = await api.inspect(key);
        if (current.revision !== reserved.revision || current.status !== 'SUBMISSION_UNKNOWN' || current.cancelRequestedAt) fail('IMAGE_RESERVATION_CHANGED');
        if (now() >= Date.parse(request.budget.deadlineAt) || now()-Date.parse(reserved.attempts.at(-1).startedAt) > request.budget.maxDurationMs) fail('IMAGE_ATTEMPT_DEADLINE');
        sendAttempted = true; // Even an action timeout can have late effects.
        await ui.sendOnce();  // Exactly ONE native action. No click/Enter fallback.
        return await recordObservation(key,reserved,reserved.attempts.at(-1),await ui.inspect(),'record');
      } catch (error) {
        if (sendAttempted) return {ok:false,status:'SUBMISSION_UNKNOWN',reason:safeError(error),retryAllowed:false,remoteGeneration:'UNKNOWN'};
        // A crash/lost begin response is not caught here and leaves persisted
        // UNKNOWN. Only this live, never-triggered branch can prove pre-send.
        const evidenceRef = await saveEvidence({adapterVersion:IMAGE_ADAPTER_VERSION,requestDigest:request.requestDigest,
          route:request.route,attemptId,beforeSend:true,reason:safeError(error),observedAt:atISO(now)});
        const current = await api.inspect(key);
        if (current.revision !== reserved.revision) return blocked('IMAGE_RESERVATION_CHANGED');
        const saved = await api.record(key,{eventId:'pre-send-'+randomUUID(),expectedRevision:reserved.revision,attemptId,
          route:request.route,status:'FAILED_PRE_SEND',beforeSend:true,evidenceRef,reason:safeError(error)});
        return {ok:false,status:saved.status,reason:safeError(error),retryAllowed:false};
      } finally {
        if (staged) try { await staged.release(); } catch {
          const error=new Error('IMAGE_SOURCE_CLEANUP_FAILED');error.code=error.message;
          error.sendAttempted=sendAttempted;error.deliveryStage=sendAttempted?'SEND_ATTEMPTED':'PRE_SEND';throw error;
        }
      }
    });
  }
  async function reconcile(key) {
    const job = await api.inspect(key), attempt = job.attempts.at(-1);
    if (!attempt) return {ok:true,status:job.status,action:'NO_ATTEMPT',retryAllowed:false};
    if (['EXPORTED','TECHNICALLY_VALIDATED'].includes(job.status)) return api.result(key);
    ready();
    return withUi(job.route,async ui => recordObservation(key,job,attempt,await ui.inspect(),'reconcile'));
  }
  return Object.freeze({start,reconcile,inspect:key=>api.inspect(key),result:key=>api.result(key),
    cancel:(key,event)=>api.cancel(key,event),probe:imageExecutionProbe});
}
