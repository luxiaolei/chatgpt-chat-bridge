/** ImageJob v1: pure contracts + existing coordinator transport, no browser or scheduler. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const IMAGE_SCHEMA_VERSION = 'chatbridge.image.v1';
export const IMAGE_FEATURES = Object.freeze(['generate','edit','refine','export','multiReference','mask','deterministicComposite','batch']);
export const IMAGE_SCHEMA = JSON.parse(readFileSync(new URL('./schema.v1.json', import.meta.url), 'utf8'));

function fail(code, field = '') { throw new Error(field ? `${code}:${field}` : code); }
export function canonicalImageJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalImageJSON).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalImageJSON(value[k])}`).join(',')}}`;
  }
  fail('IMAGE_NOT_JSON');
}
const copy = value => JSON.parse(canonicalImageJSON(value));
const same = (a,b) => canonicalImageJSON(a) === canonicalImageJSON(b);

/** Validator intentionally implements only the keywords used by schema.v1.json. */
export function validateImageShape(value, definition) {
  function check(v,s,p) {
    if (s.$ref) return check(v,IMAGE_SCHEMA.$defs[s.$ref.split('/').at(-1)],p);
    if (s.anyOf) {
      if (!s.anyOf.some(branch=>{try {check(v,branch,p); return true;} catch {return false;}})) fail('IMAGE_SCHEMA',p);
      return;
    }
    if (s.const !== undefined && !same(v,s.const)) fail('IMAGE_SCHEMA',p);
    if (s.enum && !s.enum.includes(v)) fail('IMAGE_SCHEMA',p);
    if (s.type) {
      const type = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      if (s.type === 'integer' ? !Number.isSafeInteger(v) : type !== s.type) fail('IMAGE_SCHEMA',p);
    }
    if (typeof v === 'string') {
      if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity) || (s.pattern && !new RegExp(s.pattern).test(v))) fail('IMAGE_SCHEMA',p);
      if (s.format === 'date-time' && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(v) || !Number.isFinite(Date.parse(v)))) fail('IMAGE_SCHEMA',p);
    }
    if (typeof v === 'number' && (!Number.isFinite(v) || v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) fail('IMAGE_SCHEMA',p);
    if (Array.isArray(v)) {
      if (v.length > (s.maxItems ?? Infinity)) fail('IMAGE_SCHEMA',p);
      v.forEach((x,i)=>check(x,s.items,`${p}[${i}]`));
    } else if (v && typeof v === 'object') {
      if (Object.getPrototypeOf(v) !== Object.prototype) fail('IMAGE_NOT_JSON',p);
      for (const key of s.required ?? []) if (!Object.hasOwn(v,key)) fail('IMAGE_SCHEMA',`${p}.${key}`);
      for (const key of Object.keys(v)) {
        if (['__proto__','prototype','constructor'].includes(key)) fail('IMAGE_SCHEMA',`${p}.${key}`);
        if (!Object.hasOwn(s.properties ?? {},key)) { if (s.additionalProperties === false) fail('IMAGE_SCHEMA',`${p}.${key}`); }
        else check(v[key],s.properties[key],`${p}.${key}`);
      }
    }
  }
  if (!IMAGE_SCHEMA.$defs[definition]) fail('IMAGE_SCHEMA_DEFINITION');
  check(value,IMAGE_SCHEMA.$defs[definition],definition);
  return value;
}

export function imageRequestDigest(request) {
  const {requestDigest, ...body} = request;
  return createHash('sha256').update(canonicalImageJSON(body)).digest('hex');
}
export function normalizeImageRequest(input) {
  const {requestDigest:supplied,...body} = input ?? {};
  const request = copy({schemaVersion:IMAGE_SCHEMA_VERSION, inputs:[],baseRevision:null,mask:null,count:1,
    aspectRatio:'1:1',conversationPolicy:'existing', ...body});
  request.requestDigest = imageRequestDigest(request);
  validateImageShape(request,'Request');
  if (supplied !== undefined && supplied !== request.requestDigest) fail('IMAGE_DIGEST_MISMATCH');
  if (request.jobId === request.controllerTaskId) fail('IMAGE_JOB_IS_NOT_CONTROLLER_TASK');
  if (request.count > request.budget.maxOutputs) fail('IMAGE_BUDGET_OUTPUTS');
  const source = request.inputs.filter(i=>i.role === 'source');
  if (request.operation === 'generate') {
    if (source.length || request.baseRevision || request.mask || request.conversationPolicy === 'same-source') fail('IMAGE_GENERATE_HAS_SOURCE');
  } else {
    if (source.length !== 1 || !request.baseRevision) fail('IMAGE_SOURCE_REQUIRED');
    const {role,...base} = source[0];
    if (!same(base,request.baseRevision)) fail('IMAGE_BASE_REVISION_MISMATCH');
    if (request.operation === 'refine' && (request.conversationPolicy !== 'same-source' || !request.baseRevision.jobId || !request.baseRevision.outputId)) fail('IMAGE_REFINE_REQUIRES_SAME_SOURCE');
    if (request.operation === 'export' && (request.count !== 1 || request.inputs.length !== 1 || request.mask)) fail('IMAGE_EXPORT_SOURCE_ONLY');
    if (request.operation === 'export' && (!request.baseRevision.jobId || !request.baseRevision.outputId)) fail('IMAGE_EXPORT_REQUIRES_BRIDGE_SOURCE');
  }
  if (request.inputs.some(i=>Boolean(i.jobId) !== Boolean(i.outputId))) fail('IMAGE_SOURCE_IDENTITY_PAIR');
  if (request.mask && (request.mask.sourceSha256 !== source[0]?.sha256 || request.mask.sourceRevisionId !== source[0]?.revisionId)) fail('IMAGE_MASK_SOURCE_MISMATCH');
  if (new Set(request.inputs.map(i=>i.artifactRef)).size !== request.inputs.length) fail('IMAGE_DUPLICATE_INPUT');
  return request;
}
export const imageJobKey = (request,grantId) => validateImageShape({grantId,callerRef:request.caller.ref,jobId:request.jobId,scope:copy(request.scope)},'Key');

export function unknownImageCapabilities(route) {
  return {version:'unobserved/v1',observedAt:null,route:copy(route),modelSelection:{model:null,effort:null,raw:null,verified:false},
    features:Object.fromEntries(IMAGE_FEATURES.map(feature=>[feature,{mode:'UNKNOWN',evidence:[]}]))};
}
/** Only feature-specific observations count. imageParts/vision input is deliberately ignored. */
export function classifyImageCapabilities(route, observations = {}) {
  const caps = unknownImageCapabilities(route);
  for (const feature of IMAGE_FEATURES) {
    const o = observations.features?.[feature];
    if (o && ['NATIVE','ASSISTED','UNSUPPORTED'].includes(o.mode)) {
      if (['NATIVE','ASSISTED'].includes(o.mode) && (!o.evidence?.length || !observations.observedAt || !observations.version)) continue;
      caps.features[feature] = copy(o);
    }
  }
  if (observations.version) caps.version = observations.version;
  if (observations.observedAt) caps.observedAt = observations.observedAt;
  if (observations.modelSelection) caps.modelSelection = copy(observations.modelSelection);
  return validateImageShape(caps,'Capabilities');
}
export function imageCapabilityGate(request, capabilities, at = new Date().toISOString()) {
  validateImageShape(capabilities,'Capabilities');
  if (!same(request.route,capabilities.route)) return {allowed:false,reason:'CAPABILITY_ROUTE_MISMATCH'};
  const required = [request.operation];
  if (request.inputs.length > 1) required.push('multiReference');
  if (request.mask) required.push(request.mask.mode === 'native-region' ? 'mask' : 'deterministicComposite');
  if (request.count > 1) required.push('batch');
  for (const feature of required) {
    const item = capabilities.features[feature];
    if (!['NATIVE','ASSISTED'].includes(item.mode)) return {allowed:false,reason:`CAPABILITY_${item.mode}:${feature}`};
    if (!item.evidence.length || capabilities.version === 'unobserved/v1' || !capabilities.observedAt || Date.parse(capabilities.observedAt) > Date.parse(at)) return {allowed:false,reason:`CAPABILITY_UNVERIFIED:${feature}`};
    // Assisted official-original handoff reads an existing asset independently of the model.
    if (feature !== 'export' || item.mode !== 'ASSISTED') {
      const selection = capabilities.modelSelection;
      if (!selection.verified || !selection.model || !selection.effort) return {allowed:false,reason:`CAPABILITY_MODEL_UNVERIFIED:${feature}`};
      if (selection.model !== request.requestedModel || selection.effort !== request.requestedEffort) return {allowed:false,reason:`CAPABILITY_MODEL_MISMATCH:${feature}`};
    }
  }
  return {allowed:true,mode:required.some(f=>capabilities.features[f].mode === 'ASSISTED')?'ASSISTED':'NATIVE'};
}
export function validateImageOutput(output) {
  validateImageShape(output,'Output');
  if (output.validation.status === 'VERIFIED' && Object.values(output.validation.checks).some(v=>v !== true)) fail('IMAGE_VERIFICATION_INCOMPLETE');
  return output;
}
export const validateImageReceipt = receipt => validateImageShape(receipt,'Receipt');

/** The adapter supplies the existing coordinated(command,payload) transport.
 * grantId is a lookup key, never a bearer token. The coordinator authenticates
 * against the immutable owner/route and a separately issued controller grant.
 */
export function createImageJobAPI({coordinated}) {
  if (typeof coordinated !== 'function') fail('IMAGE_COORDINATOR_REQUIRED');
  const read = (command,key) => coordinated(command,validateImageShape(copy(key),'Key'));
  const apply = (type,key,event) => coordinated('image-apply',{...validateImageShape(copy(key),'Key'),event:{...copy(event),type}});
  return Object.freeze({
    submit:(request,{grantId})=>coordinated('image-submit',{grantId,request:normalizeImageRequest(request)}),
    inspect:key=>read('image-inspect',key),
    result:key=>read('image-result',key),
    authorizeIO:key=>read('image-io-admission',key),
    sessionOccupancy:(session,key)=>coordinated('image-session-occupancy',validateImageShape(copy({session:{accountId:session.accountId,conversationId:session.conversationId},...(key === undefined ? {} : {key})}),'SessionOccupancyQuery')),
    beginAttempt:(key,event)=>apply('beginAttempt',key,event),
    record:(key,event)=>apply('observation',key,event),
    export:(key,event)=>apply('export',key,event),
    reconcile:(key,event)=>apply('reconcile',key,event),
    cancel:(key,event)=>apply('cancel',key,event),
  });
}

export function normalizeImageGrant(input, at = new Date().toISOString()) {
  const request = normalizeImageRequest(input.request);
  const grant = copy({...input,request,capabilities:input.capabilities ?? unknownImageCapabilities(request.route)});
  validateImageShape(grant,'Grant');
  if (grant.controllerTaskId !== request.controllerTaskId) fail('IMAGE_CONTROLLER_TASK_MISMATCH');
  if (!same(grant.capabilities.route,request.route)) fail('IMAGE_CAPABILITY_ROUTE_MISMATCH');
  if (Date.parse(grant.expiresAt) > Date.parse(request.budget.deadlineAt) || Date.parse(grant.expiresAt) <= Date.parse(at)) fail('IMAGE_GRANT_EXPIRY');
  if (request.inputs.length && request.operation !== 'export' && !grant.sourceExternalizationAuthorized) fail('IMAGE_SOURCE_EXTERNALIZATION_NOT_AUTHORIZED');
  return grant;
}

export function initialImageJob(grant, at = new Date().toISOString()) {
  const request = normalizeImageRequest(grant.request), gate = imageCapabilityGate(request,grant.capabilities,at);
  return {schemaVersion:IMAGE_SCHEMA_VERSION,jobId:request.jobId,requestDigest:request.requestDigest,
    controllerTaskId:grant.controllerTaskId,controllerOperationId:grant.controllerOperationId,grantId:grant.grantId,
    caller:copy(request.caller),scope:copy(request.scope),route:copy(request.route),request,
    revision:1,status:gate.allowed?'SUBMITTED':'BLOCKED',reason:gate.allowed?null:gate.reason,
    capabilities:copy(grant.capabilities),attempts:[],outputs:[],lateOutputs:[],lateObservations:[],
    cancelRequestedAt:null,sourceTurnId:null,warnings:[],createdAt:at,updatedAt:at};
}
const eventIdShape = IMAGE_SCHEMA.$defs.Request.properties.jobId;
function validateEvent(event) {
  if (!event || !Object.hasOwn(event,'eventId')) fail('IMAGE_EVENT_REQUIRED');
  if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision < 1) fail('IMAGE_EXPECTED_REVISION');
  validateImageShape(event,'Event');
}
function validId(value) {
  return typeof value === 'string' && new RegExp(eventIdShape.pattern).test(value);
}
function evidenceRef(value) {
  if (typeof value !== 'string' || !/^(artifact|store|urn):[^\s]+$/.test(value) || value.length > 512) fail('IMAGE_EVIDENCE_REQUIRED');
}
function idList(value) {
  if (!Array.isArray(value) || value.length > 4096 || value.some(v=>!validId(v)) || new Set(value).size !== value.length) fail('IMAGE_ID_LIST');
  return value;
}
function outputWithoutValidation(output) {const {validation,...rest}=output; return rest;}
function mergeOutput(list, output) {
  const old = list.find(o=>o.outputId === output.outputId);
  if (!old) return list.push(copy(output));
  if (!same(outputWithoutValidation(old),outputWithoutValidation(output))) fail('IMAGE_OUTPUT_CONFLICT');
  if (old.validation.status === 'VERIFIED' && !same(old,output)) fail('IMAGE_VERIFIED_OUTPUT_IMMUTABLE');
  Object.assign(old,copy(output));
}
function addWarning(job,warning) {if (!job.warnings.includes(warning)) job.warnings.push(warning);}

/** Pure state reducer. The persistence boundary supplies the real clock and grantActive.
 * No UI call is made here. beginAttempt writes UNKNOWN before the adapter may send.
 */
export function applyImageEvent(record, event, grant, {at = new Date().toISOString(),grantActive = true} = {}) {
  validateEvent(event);
  if (event.expectedRevision !== record.revision) fail('IMAGE_REVISION_CONFLICT');
  const job=copy(record), request=job.request;
  if (grant.request.requestDigest !== job.requestDigest || grant.controllerOperationId !== job.controllerOperationId) fail('IMAGE_GRANT_MISMATCH');
  if (!['beginAttempt','cancel'].includes(event.type) && job.grantId !== grant.grantId) fail('IMAGE_ATTEMPT_GRANT_MISMATCH');
  const expired = !grantActive || Date.parse(at) >= Math.min(Date.parse(grant.expiresAt),Date.parse(request.budget.deadlineAt));
  if (event.type === 'cancel') {
    if (!['TECHNICALLY_VALIDATED','CANCELLED','FAILED'].includes(job.status)) {
      job.cancelRequestedAt ??= at;
      job.status = job.attempts.every(a=>a.status === 'FAILED_PRE_SEND') ? 'CANCELLED' : 'CANCEL_REQUESTED';
      job.reason = event.reason || (job.status === 'CANCELLED' ? 'CANCELLED_BEFORE_SUBMISSION' : 'STOP_REQUEST_NOT_CONFIRMATION');
    }
  } else if (event.type === 'beginAttempt') {
    if (expired) fail('IMAGE_GRANT_EXPIRED_OR_REVOKED');
    if (job.cancelRequestedAt || !['SUBMITTED','FAILED_PRE_SEND','BLOCKED'].includes(job.status)
      || job.attempts.some(a=>a.status !== 'FAILED_PRE_SEND')) fail('IMAGE_RECONCILE_REQUIRED');
    if (job.attempts.length >= request.budget.maxAttempts) fail('IMAGE_ATTEMPT_BUDGET');
    if (!validId(event.attemptId) || job.attempts.some(a=>a.attemptId === event.attemptId)) fail('IMAGE_ATTEMPT_ID');
    idList(event.baselineTurnIds);
    validateImageShape(event.modelSelection,'ModelSelection');
    if (!event.modelSelection.verified || event.modelSelection.model !== request.requestedModel || event.modelSelection.effort !== request.requestedEffort) fail('IMAGE_MODEL_SELECTION_MISMATCH');
    const gate=imageCapabilityGate(request,grant.capabilities,at);
    if (!gate.allowed) fail(gate.reason);
    job.grantId=grant.grantId;job.capabilities=copy(grant.capabilities);
    job.attempts.push({attemptId:event.attemptId,ordinal:job.attempts.length+1,status:'SUBMISSION_UNKNOWN',
      baselineTurnIds:copy(event.baselineTurnIds),modelSelection:copy(event.modelSelection),capabilities:copy(grant.capabilities),
      startedAt:at,userMessageId:null,turnId:null,candidateOutputIds:[],evidenceRefs:[]});
    job.status='SUBMISSION_UNKNOWN';job.reason='PERSISTED_BEFORE_POSSIBLE_SEND';
  } else {
    if (!same(event.route,job.route)) fail('IMAGE_ROUTE_MISMATCH');
    const attempt=job.attempts.find(a=>a.attemptId === event.attemptId);
    if (!attempt) fail('IMAGE_ATTEMPT_NOT_FOUND');
    evidenceRef(event.evidenceRef);
    const timedOut=Date.parse(at)-Date.parse(attempt.startedAt) > request.budget.maxDurationMs;
    const late=expired || timedOut || Boolean(job.cancelRequestedAt) || attempt !== job.attempts.at(-1)
      || ['FAILED','CANCELLED','BLOCKED'].includes(job.status);
    const completionObserved=Boolean(attempt.turnId) && attempt.candidateOutputIds.length > 0;
    if (event.type === 'export') {
      if (!completionObserved) fail('IMAGE_NEW_TURN_REQUIRED');
      const gate=imageCapabilityGate({...request,operation:'export',inputs:[],mask:null,count:1},grant.capabilities,at);
      if (!gate.allowed) fail(gate.reason);
      if (!Array.isArray(event.outputs) || !event.outputs.length || event.outputs.length > request.count) fail('IMAGE_EXPORT_OUTPUTS');
      if (new Set(event.outputs.map(o=>o.outputId)).size !== event.outputs.length) fail('IMAGE_DUPLICATE_OUTPUT');
      for (const output of event.outputs) {
        validateImageOutput(output);
        if (output.jobId !== job.jobId || output.attemptId !== attempt.attemptId || output.turnId !== attempt.turnId
          || !attempt.candidateOutputIds.includes(output.outputId)) fail('IMAGE_OUTPUT_BINDING_MISMATCH');
        if (!same(output.sourceHashes,request.inputs.map(i=>i.sha256)) || output.parentOutputId !== (request.baseRevision?.outputId ?? null)
          || output.baseRevisionId !== (request.baseRevision?.revisionId ?? null)) fail('IMAGE_OUTPUT_LINEAGE_MISMATCH');
        if (output.capabilityVersion !== attempt.capabilities.version || output.capabilityObservedAt !== attempt.capabilities.observedAt) fail('IMAGE_OUTPUT_CAPABILITY_MISMATCH');
        if (request.operation === 'export' && output.sha256 !== request.baseRevision.sha256) fail('IMAGE_EXPORT_SOURCE_MISMATCH');
        mergeOutput(late?job.lateOutputs:job.outputs,output);
      }
      if (job.outputs.length > request.count || job.lateOutputs.length > request.count * request.budget.maxAttempts) fail('IMAGE_OUTPUT_COUNT');
      if (!late) {
        job.status=job.outputs.length < request.count ? 'PARTIAL' : job.outputs.every(o=>o.validation.status === 'VERIFIED')?'TECHNICALLY_VALIDATED':'EXPORTED';
        job.reason=null;
      }
    } else {
      if (!['SUBMISSION_UNKNOWN','GENERATING','GENERATED','PARTIAL','FAILED_PRE_SEND','FAILED','BLOCKED','EXPORT_UNAVAILABLE'].includes(event.status)) fail('IMAGE_OBSERVATION_STATUS');
      if (event.status === 'SUBMISSION_UNKNOWN' && attempt.status !== 'SUBMISSION_UNKNOWN') fail('IMAGE_KNOWN_DELIVERY_NOT_UNKNOWN');
      if (completionObserved && event.status === 'GENERATING') fail('IMAGE_GENERATION_ALREADY_OBSERVED');
      if (event.status === 'FAILED_PRE_SEND') {
        if (event.beforeSend !== true || attempt.userMessageId || attempt.turnId || !['SUBMISSION_UNKNOWN','FAILED_PRE_SEND'].includes(attempt.status)) fail('IMAGE_NOT_SUBMITTED_PROOF_REQUIRED');
      } else if (['GENERATING','GENERATED','PARTIAL'].includes(event.status)) {
        if (request.operation === 'export') {
          if (!job.sourceTurnId || event.turnId !== job.sourceTurnId) fail('IMAGE_EXPORT_SOURCE_TURN_MISMATCH');
          attempt.turnId=job.sourceTurnId;
        } else {
          if (!validId(event.userMessageId) || attempt.baselineTurnIds.includes(event.userMessageId)) fail('IMAGE_NEW_USER_TURN_REQUIRED');
          if (attempt.userMessageId && attempt.userMessageId !== event.userMessageId) fail('IMAGE_USER_TURN_CHANGED');
          if (event.turnId != null) {
            if (!validId(event.turnId) || event.turnId === event.userMessageId || (request.operation !== 'export' && attempt.baselineTurnIds.includes(event.turnId))) fail('IMAGE_NEW_TURN_REQUIRED');
            if (attempt.turnId && attempt.turnId !== event.turnId) fail('IMAGE_TURN_CHANGED');
            attempt.turnId=event.turnId;
          }
          attempt.userMessageId=event.userMessageId;
        }
        if (['GENERATED','PARTIAL'].includes(event.status)) {
          const ids=idList(event.candidateOutputIds);
          if (!attempt.turnId || !ids.length || ids.length > request.count) fail('IMAGE_CANDIDATE_COUNT');
          if (event.status === 'GENERATED' && ids.length !== request.count) fail('IMAGE_INCOMPLETE_GENERATION');
          if (event.status === 'PARTIAL' && ids.length >= request.count) fail('IMAGE_NOT_PARTIAL');
          if (attempt.candidateOutputIds.some(id=>!ids.includes(id))) fail('IMAGE_CANDIDATE_REMOVAL');
          attempt.candidateOutputIds=copy(ids);
        }
      }
      // Known byte validation is never downgraded by repeated UI observations.
      if (['EXPORTED','TECHNICALLY_VALIDATED'].includes(job.status) && !late) fail('IMAGE_ALREADY_EXPORTED');
      if (attempt.status === 'FAILED_PRE_SEND' && event.status !== 'FAILED_PRE_SEND') fail('IMAGE_ATTEMPT_SETTLED');
      attempt.status=event.status;
      if (late) job.lateObservations.push({attemptId:attempt.attemptId,eventId:event.eventId,status:event.status,evidenceRef:event.evidenceRef,observedAt:at});
      else {job.status=event.status;job.reason=event.reason ?? null;}
    }
    if (!attempt.evidenceRefs.includes(event.evidenceRef)) attempt.evidenceRefs.push(event.evidenceRef);
    if (late) {
      addWarning(job,'LATE_RESULT_NOT_ADOPTED');
      if (!job.cancelRequestedAt && (expired || timedOut)) {job.status='BLOCKED';job.reason=expired?'IMAGE_GRANT_EXPIRED_OR_REVOKED':'IMAGE_ATTEMPT_DEADLINE';}
    }
  }
  job.revision += 1;job.updatedAt=at;
  return job;
}
export function imageJobResult(job) {
  return {schemaVersion:IMAGE_SCHEMA_VERSION,jobId:job.jobId,requestDigest:job.requestDigest,
    controllerTaskId:job.controllerTaskId,controllerOperationId:job.controllerOperationId,caller:copy(job.caller),scope:copy(job.scope),route:copy(job.route),
    status:job.status,revision:job.revision,reason:job.reason,outputs:copy(job.outputs),lateOutputs:copy(job.lateOutputs),
    missingCount:Math.max(0,job.request.count-job.outputs.length),warnings:copy(job.warnings),capabilities:copy(job.capabilities),
    requestedModel:job.request.requestedModel,requestedEffort:job.request.requestedEffort,
    modelSelection:copy(job.attempts.at(-1)?.modelSelection ?? {model:null,effort:null,raw:null,verified:false}),
    businessApproval:'NOT_EVALUATED',updatedAt:job.updatedAt};
}

// A stateless Node validation/reducer child of the existing coordinator. No store,
// daemon, browser, credentials or third-party dependency lives in this module.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const raw=readFileSync(0,'utf8');
    if (Buffer.byteLength(raw)>2_000_000) fail('IMAGE_PAYLOAD_TOO_LARGE');
    const value=JSON.parse(raw), action=process.argv[2];
    const result=action === 'normalize'?normalizeImageRequest(value.request):
      action === 'grant'?normalizeImageGrant(value.grant,value.at):
      action === 'initial'?initialImageJob(value.grant,value.at):
      action === 'apply'?applyImageEvent(value.record,value.event,value.grant,{at:value.at,grantActive:value.grantActive}):
      action === 'result'?imageJobResult(value.record):
      action === 'gate'?imageCapabilityGate(value.request,value.capabilities,value.at):
      action === 'key'?validateImageShape(value,'Key'):
      action === 'occupancy-query'?validateImageShape(value,'SessionOccupancyQuery'):fail('IMAGE_CONTRACT_ACTION');
    process.stdout.write(JSON.stringify(result));
  } catch (error) {process.stderr.write(JSON.stringify({error:error.message}));process.exitCode=2;}
}
