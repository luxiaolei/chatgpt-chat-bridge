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
  const supplied = input?.requestDigest;
  const request = copy({schemaVersion:IMAGE_SCHEMA_VERSION, inputs:[],baseRevision:null,mask:null,count:1,
    aspectRatio:'1:1',conversationPolicy:'existing', ...input});
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
    if (request.operation === 'refine' && request.conversationPolicy !== 'same-source') fail('IMAGE_REFINE_REQUIRES_SAME_SOURCE');
  }
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
      if (['NATIVE','ASSISTED'].includes(o.mode) && (!o.evidence?.length || !observations.observedAt)) continue;
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
    if (!item.evidence.length || !capabilities.observedAt || Date.parse(capabilities.observedAt) > Date.parse(at)) return {allowed:false,reason:`CAPABILITY_UNVERIFIED:${feature}`};
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
    beginAttempt:(key,event)=>apply('beginAttempt',key,event),
    record:(key,event)=>apply('observation',key,event),
    export:(key,event)=>apply('export',key,event),
    reconcile:(key,event)=>apply('reconcile',key,event),
    cancel:(key,event)=>apply('cancel',key,event),
  });
}
