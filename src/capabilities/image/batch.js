/** Offline recommendations over authoritative ImageJob/receipt snapshots. No I/O or reservations. */
import {createHash} from 'node:crypto';
import {canonicalImageJSON, normalizeImageRequest, imageJobKey, validateImageShape,
  validateImageOutput, validateImageReceipt} from './contract.js';
import {assertImageId, immutableArtifactValue} from './manifest.js';

const VERSION = 'chatbridge.image.batch.v1';
const same = (a,b) => canonicalImageJSON(a) === canonicalImageJSON(b);
const digest = value => createHash('sha256').update(canonicalImageJSON(value)).digest('hex');
function requireValue(ok, code) { if (!ok) throw new Error(`IMAGE_BATCH_${code}`); }
function fields(value, names) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === names.length && names.every(k=>Object.hasOwn(value,k)), 'SHAPE');
}
function time(value) {
  requireValue(typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'TIME');
  return Date.parse(value);
}

/** Linkage only: the existing job keeps the request, route, attempt and output identities. */
export function normalizeImageBatch(input) {
  const {schemaVersion = VERSION,batchDigest,...body} = input ?? {};
  requireValue(schemaVersion === VERSION, 'VERSION');
  fields(body,['batchId','createdAt','budget','items']);
  assertImageId(body.batchId);
  const created = time(body.createdAt), b = body.budget;
  fields(b,['maxAttempts','maxItemAttempts','maxGenerationCalls','maxDurationMs','deadlineAt','allowPaidApi']);
  for (const key of ['maxAttempts','maxItemAttempts','maxGenerationCalls','maxDurationMs'])
    requireValue(Number.isSafeInteger(b[key]) && b[key] > 0, 'BUDGET');
  requireValue(b.allowPaidApi === false && time(b.deadlineAt) > created, 'BUDGET');
  requireValue(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 16, 'ITEM_COUNT');
  for (const item of body.items) {
    fields(item,['itemId','jobId','requestDigest','consumerRef']);
    for (const key of ['itemId','jobId','consumerRef']) assertImageId(item[key]);
    requireValue(typeof item.requestDigest === 'string' && /^[a-f0-9]{64}$/.test(item.requestDigest), 'DIGEST');
  }
  for (const key of ['itemId','jobId'])
    requireValue(new Set(body.items.map(i=>i[key])).size === body.items.length, 'DUPLICATE_LINK');
  const batch = {schemaVersion,...body}, hash = digest(batch);
  requireValue(batchDigest === undefined || batchDigest === hash, 'DIGEST_MISMATCH');
  return immutableArtifactValue({...batch,batchDigest:hash});
}

function reasonCategory(reason) {
  if (/QUOTA/.test(reason)) return 'QUOTA';
  if (/RATE|COOLDOWN|PACING/.test(reason)) return 'RATE_LIMIT';
  if (/AUTH|LOGIN|ACCESS_DENIED|GRANT_EXPIRED|REVOKED/.test(reason)) return 'AUTH';
  if (/CAPABILITY/.test(reason)) return 'CAPABILITY';
  if (/USER_CONTROL|USER_DRAFT|MANUAL|TARGET_BUSY/.test(reason)) return 'MANUAL_PAUSE';
  if (/ADMISSION_PAUSED|ADMISSION_DRAINING|PROJECT_PAUSE/.test(reason)) return 'PROJECT_CONTROL';
  if (/CAPACITY|SESSION_BUSY/.test(reason)) return 'CAPACITY';
  if (/BUDGET|DEADLINE/.test(reason)) return 'BUDGET';
  return 'UNKNOWN';
}
function hold(item,reason) {
  item.resumeAction = item.action;
  item.action = ['AUTH','CAPABILITY'].includes(reasonCategory(reason)) ? 'BLOCKED' : 'WAIT';
  item.reason = reason; item.reasonCategory = reasonCategory(reason);
}

function checkJob(job,link,at) {
  const request = normalizeImageRequest(job.request);
  requireValue(request.count === 1, 'COUNT_ONE_REQUIRED');
  requireValue(job.jobId === link.jobId && job.requestDigest === link.requestDigest &&
    request.jobId === job.jobId && request.requestDigest === job.requestDigest &&
    same(job.route,request.route) && same(job.scope,request.scope) && same(job.caller,request.caller), 'JOB_BINDING');
  validateImageShape(job.status,'Status'); assertImageId(job.grantId);
  requireValue(Number.isSafeInteger(job.revision) && job.revision > 0 &&
    Array.isArray(job.attempts) && Array.isArray(job.outputs) && Array.isArray(job.lateOutputs), 'SNAPSHOT');
  requireValue(job.attempts.length <= request.budget.maxAttempts && job.outputs.length <= 1, 'JOB_BUDGET');
  const ids = new Set();
  for (const [index,a] of job.attempts.entries()) {
    assertImageId(a.attemptId); validateImageShape(a.status,'Status');
    requireValue(!ids.has(a.attemptId) && a.ordinal === index+1 && time(a.startedAt) <= at &&
      Array.isArray(a.candidateOutputIds) && a.candidateOutputIds.length <= 1 && Array.isArray(a.evidenceRefs), 'ATTEMPT');
    ids.add(a.attemptId); a.candidateOutputIds.forEach(assertImageId);
    requireValue(index === job.attempts.length-1 || a.status === 'FAILED_PRE_SEND', 'ATTEMPT_SEQUENCE');
    if (a.userMessageId !== null) assertImageId(a.userMessageId);
    if (a.turnId !== null) assertImageId(a.turnId);
    if (a.status === 'FAILED_PRE_SEND') requireValue(!a.userMessageId && !a.turnId &&
      !a.candidateOutputIds.length && a.evidenceRefs.length > 0, 'PRE_SEND_PROOF');
  }
  for (const output of [...job.outputs,...job.lateOutputs]) {
    validateImageOutput(output);
    const a = job.attempts.find(a=>a.attemptId === output.attemptId);
    requireValue(output.jobId === job.jobId && a && output.turnId === a.turnId &&
      a.candidateOutputIds.includes(output.outputId), 'OUTPUT_BINDING');
  }
  requireValue(new Set(job.outputs.map(o=>o.outputId)).size === job.outputs.length, 'DUPLICATE_OUTPUT');
  return request;
}

/**
 * All arrays must be freshly loaded by the authorized coordinator/receiver.
 * Admission entries wrap authorizeIO's proof with its exact lookup key + digest;
 * they are inputs, not bearer grants. This function never authenticates or sends.
 */
export function imageBatchDecision(input,{jobs,receipts,admissions,at} = {}) {
  const batch = normalizeImageBatch(input), now = time(at);
  requireValue(now >= time(batch.createdAt), 'TIME');
  requireValue(Array.isArray(jobs) && Array.isArray(receipts) && Array.isArray(admissions), 'AUTHORITATIVE_INPUTS_REQUIRED');
  const byId = new Map(), proofById = new Map(), receiptById = new Map();
  for (const job of jobs) {
    const link = batch.items.find(i=>i.jobId === job.jobId);
    requireValue(link && !byId.has(job.jobId), 'JOB_LINK');
    checkJob(job,link,now); byId.set(job.jobId,job);
  }
  for (const proof of admissions) {
    fields(proof,['key','requestDigest','allowed','expiresAt','reason','quotaRemaining']);
    validateImageShape(proof.key,'Key');
    const job = byId.get(proof.key.jobId);
    requireValue(job && !proofById.has(job.jobId) && same(proof.key,imageJobKey(job.request,job.grantId)) &&
      proof.requestDigest === job.requestDigest && typeof proof.allowed === 'boolean', 'ADMISSION_BINDING');
    requireValue(proof.quotaRemaining === null || (Number.isSafeInteger(proof.quotaRemaining) && proof.quotaRemaining >= 0), 'QUOTA');
    requireValue(proof.allowed ? proof.reason === null : typeof proof.reason === 'string' && proof.reason.length > 0, 'ADMISSION_REASON');
    if (proof.expiresAt !== null) time(proof.expiresAt);
    requireValue(!proof.allowed || proof.expiresAt !== null, 'ADMISSION_EXPIRY');
    proofById.set(job.jobId,proof);
  }
  for (const receipt of receipts) {
    validateImageReceipt(receipt);
    const job = byId.get(receipt.jobId), link = batch.items.find(i=>i.jobId === receipt.jobId);
    const output = job?.outputs.find(o=>o.outputId === receipt.outputId);
    requireValue(output?.validation.status === 'VERIFIED' && receipt.requestDigest === job.requestDigest &&
      receipt.consumerRef === link.consumerRef && receipt.artifactRef === output.artifactRef &&
      receipt.sha256 === output.sha256 && time(receipt.receivedAt) <= now, 'RECEIPT_BINDING');
    const previous = receiptById.get(receipt.receiptId);
    requireValue(!previous || same(previous,receipt), 'RECEIPT_CONFLICT');
    receiptById.set(receipt.receiptId,receipt);
  }
  const attempts = jobs.reduce((n,j)=>n+j.attempts.length,0);
  // UNKNOWN and even proven pre-send failures keep their conservative call reservation.
  const calls = jobs.reduce((n,j)=>n+(j.request.operation === 'export' ? 0 : j.attempts.length),0);
  let attemptSlots = batch.budget.maxAttempts-attempts, callSlots = batch.budget.maxGenerationCalls-calls;
  const verified = new Map(), duplicateItemIds = [];
  const items = batch.items.map(link=>{
    const job = byId.get(link.jobId), proof = proofById.get(link.jobId), a = job?.attempts.at(-1);
    const item = {...link,jobRevision:job?.revision ?? null,attemptId:a?.attemptId ?? null,turnId:a?.turnId ?? null,
      action:'WAIT',reason:null,reasonCategory:null,outputIds:job?.outputs.map(o=>o.outputId) ?? [],
      missingOutputIds:a?.candidateOutputIds.filter(id=>!job.outputs.some(o=>o.outputId === id)) ?? [],
      lateOutputIds:job?.lateOutputs.map(o=>o.outputId) ?? [],receiptIds:[],quotaRemaining:proof?.quotaRemaining ?? null};
    if (!job) {item.reason='JOB_SNAPSHOT_MISSING';item.reasonCategory='UNKNOWN';return item;}
    const output = job.outputs.find(o=>o.validation.status === 'VERIFIED');
    const matches = [...receiptById.values()].filter(r=>r.jobId === job.jobId);
    item.receiptIds = matches.map(r=>r.receiptId);
    if (output) {
      if (verified.has(output.sha256)) duplicateItemIds.push(link.itemId);
      else verified.set(output.sha256,link.itemId);
    }
    if (matches.some(r=>r.status === 'RECEIVED')) item.action='AWAIT_CONTROLLER_ACK';
    else if (matches.length) {item.action='BLOCKED';item.reason='RECEIPT_REJECTED';}
    else if (output) item.action='RECEIVE_EXISTING';
    else if (a?.status === 'SUBMISSION_UNKNOWN') item.action='RECONCILE_EXISTING';
    else if (a?.turnId && a.candidateOutputIds.length) item.action=item.missingOutputIds.length ? 'EXPORT_EXISTING' : 'VALIDATE_EXISTING';
    else if (a?.status === 'GENERATING') item.action='OBSERVE_EXISTING';
    else if (job.attempts.every(a=>a.status === 'FAILED_PRE_SEND') && ['SUBMITTED','FAILED_PRE_SEND','BLOCKED'].includes(job.status))
      item.action=a ? 'RETRY_PRE_SEND' : 'CONTINUE_EXISTING';
    else item.reason='REMOTE_SETTLEMENT_UNPROVEN';
    // Receipt evidence remains recorded; only the controller can accept it.
    if (['AWAIT_CONTROLLER_ACK','BLOCKED'].includes(item.action)) return item;
    if (job.cancelRequestedAt || ['CANCELLED','CANCEL_REQUESTED'].includes(job.status)) hold(item,'IMAGE_CANCEL_REQUESTED');
    else if (!proof) hold(item,'CURRENT_ADMISSION_REQUIRED');
    else if (!proof.allowed) hold(item,proof.reason);
    else if (time(proof.expiresAt) <= now) hold(item,'IMAGE_GRANT_EXPIRED_OR_REVOKED');
    else if (time(batch.budget.deadlineAt) <= now || now-time(batch.createdAt) >= batch.budget.maxDurationMs)
      hold(item,'BATCH_DEADLINE');
    else if (duplicateItemIds.includes(link.itemId)) hold(item,'DUPLICATE_BATCH_OUTPUT');
    else if (['CONTINUE_EXISTING','RETRY_PRE_SEND'].includes(item.action)) {
      const generation = job.request.operation !== 'export';
      if (byId.size !== batch.items.length) hold(item,'BATCH_SNAPSHOT_INCOMPLETE');
      else if (generation && proof.quotaRemaining === 0) hold(item,'IMAGE_QUOTA_EXHAUSTED');
      else if (job.attempts.length >= Math.min(batch.budget.maxItemAttempts,job.request.budget.maxAttempts)) hold(item,'ITEM_ATTEMPT_BUDGET');
      else if (attemptSlots <= 0) hold(item,'BATCH_ATTEMPT_BUDGET');
      else if (generation && callSlots <= 0) hold(item,'BATCH_GENERATION_CALL_BUDGET');
      else {
        // Stable proposal only. The coordinator must CAS + reserve before possible Send.
        item.attemptId='batch-attempt-'+digest({batchDigest:batch.batchDigest,itemId:link.itemId,jobId:job.jobId,ordinal:job.attempts.length+1});
        attemptSlots--; if (generation) callSlots--;
      }
    }
    return item;
  });
  const validatedCount = jobs.filter(j=>j.outputs.some(o=>o.validation.status === 'VERIFIED')).length;
  return immutableArtifactValue({batchId:batch.batchId,batchDigest:batch.batchDigest,recommendationsOnly:true,reservationsPersisted:false,
    status:verified.size === batch.items.length ? 'TECHNICALLY_VALIDATED' : validatedCount ? 'PARTIAL' : 'PENDING',
    expectedCount:batch.items.length,validatedCount,uniqueCount:verified.size,missingCount:batch.items.length-validatedCount,
    receivedCount:items.filter(i=>i.action === 'AWAIT_CONTROLLER_ACK').length,duplicateItemIds,
    businessApproval:'NOT_EVALUATED',budgetUsage:{attempts,generationCallReservations:calls},items});
}
