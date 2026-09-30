/** Portable manifests and consumer-side receipt logic. No job DB, transport, or business approval. */
import {assertArtifact, artifactError, sha256, isHash, inspectImageCount, verifyImageBytes, safeArtifactCode} from './verifier.js';

export function canonicalArtifactJSON(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalArtifactJSON).join(',')}]`;
  assertArtifact(value && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_ARTIFACT_JSON');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalArtifactJSON(value[k])}`).join(',')}}`;
}
export function immutableArtifactValue(value) {
  const copied = JSON.parse(canonicalArtifactJSON(value));
  function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
  return freeze(copied);
}
export function assertOpaqueRef(ref) {
  // Intentionally narrower than v1 refs: shareable locators are not URLs, paths, or bearer tokens.
  assertArtifact(typeof ref === 'string' && /^(artifact|store|urn):[A-Za-z0-9][A-Za-z0-9._:-]{0,490}$/.test(ref), 'NONPORTABLE_ARTIFACT_REF');
  return ref;
}
export function assertImageId(id) {
  assertArtifact(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id), 'INVALID_IMAGE_ID');
  return id;
}
export async function authorizeArtifactBinding(authorize, binding, at, context) {
  assertArtifact(typeof authorize === 'function', 'AUTHORIZATION_DENIED');
  const bound = immutableArtifactValue(binding);
  const proof = await authorize(bound, context);
  assertArtifact(proof?.allowed === true && proof.bindingDigest === sha256(canonicalArtifactJSON(bound)), 'AUTHORIZATION_DENIED');
  assertArtifact(typeof proof.expiresAt === 'string' && Number.isFinite(Date.parse(at)) &&
    Number.isFinite(Date.parse(proof.expiresAt)) && Date.parse(proof.expiresAt) > Date.parse(at), 'AUTHORIZATION_EXPIRED');
  return proof;
}

export function createImageManifest({request, attemptId, turnId, capabilities, items, errors = [],
  unavailable = false, checkedAt = new Date().toISOString(), validateOutput}) {
  const counts = inspectImageCount(items.map(i=>({outputId:i.outputId,...i.verified})), request.count);
  const outputs = items.map(item => {
    const warnings = [...item.verified.warnings];
    // Batch count/duplicates belong to the snapshot, never mutable per-output warnings.
    const output = {
      outputId:item.outputId, jobId:request.jobId, attemptId, turnId, artifactRef:assertOpaqueRef(item.artifactRef),
      sha256:item.verified.sha256, mimeType:item.verified.mimeType, byteLength:item.verified.byteLength,
      width:item.verified.width, height:item.verified.height, sourceHashes:request.inputs.map(i=>i.sha256),
      parentOutputId:request.baseRevision?.outputId ?? null, baseRevisionId:request.baseRevision?.revisionId ?? null,
      capabilityVersion:capabilities.version, capabilityObservedAt:capabilities.observedAt,
      warnings, validation:{...item.verified.validation, status:counts.countMatches ? 'VERIFIED' : 'UNVERIFIED',
        checks:{...item.verified.validation.checks, count:counts.countMatches}},
    };
    return typeof validateOutput === 'function' ? validateOutput(output) : output;
  });
  const status = counts.countMatches && errors.length === 0 ? 'TECHNICALLY_VALIDATED' :
    outputs.length ? 'PARTIAL' : unavailable ? 'EXPORT_UNAVAILABLE' : 'BLOCKED';
  return {
    schemaVersion:'chatbridge.image.manifest.v1', jobId:request.jobId, requestDigest:request.requestDigest,
    attemptId, turnId, promptSha256:sha256(request.prompt), inputHashes:request.inputs.map(i=>i.sha256),
    parentOutputId:request.baseRevision?.outputId ?? null, baseRevisionId:request.baseRevision?.revisionId ?? null,
    targetRef:assertOpaqueRef(request.authorizedOutput.targetRef), status, deliveryStatus:'NOT_RECEIVED',
    expectedCount:counts.expectedCount, actualCount:counts.actualCount, uniqueCount:counts.uniqueCount,
    missingCount:Math.max(0,request.count-outputs.length), duplicateOutputIds:counts.duplicateOutputIds,
    checkedAt, outputs, warnings:[...(!counts.countMatches?['OUTPUT_COUNT_UNVERIFIED']:[]),
      ...(counts.duplicateOutputIds.length?['DUPLICATE_IMAGE']:[])], errors:errors.map(e=>({outputId:e.outputId ?? null, code:e.code})),
    exportModes:[...new Set(items.map(i=>i.mode))],
    recovery:'RETRIEVE_ONLY_EXPLICITLY_MISSING_ORIGINALS_NEVER_REGENERATE',
  };
}

/** A separate public schema, NOT an A-coordinator Output/event payload. Whitelist, never clone. */
export function publicImageManifest(manifest) {
  const id = value => value === null ? null : `id:${sha256(String(value))}`;
  const warningCodes = new Set(['ASPECT_RATIO_MISMATCH','DIMENSIONS_MISMATCH','OUTPUT_COUNT_UNVERIFIED','DUPLICATE_IMAGE']);
  const safeCode = code => warningCodes.has(code) ? code : safeArtifactCode({code});
  const outputs = manifest.outputs.map(o=>({
    outputId:o.outputId, jobId:manifest.jobId, attemptId:o.attemptId,
    turnRef:id(o.turnId), artifactRef:assertOpaqueRef(o.artifactRef), sha256:o.sha256,
    mimeType:o.mimeType, byteLength:o.byteLength, width:o.width, height:o.height,
    sourceHashes:[...o.sourceHashes], parentOutputId:o.parentOutputId, baseRevisionId:o.baseRevisionId,
    capabilityVersionDigest:sha256(o.capabilityVersion), capabilityObservedAt:o.capabilityObservedAt,
    warnings:o.warnings.map(safeCode), validation:{status:o.validation.status,
      verifierVersionDigest:sha256(o.validation.verifierVersion), checkedAt:o.validation.checkedAt,
      checks:Object.fromEntries(['magic','mime','decode','hash','count'].map(k=>[k,o.validation.checks[k] === true]))},
  }));
  const result = {schemaVersion:'chatbridge.image.public-manifest.v1', jobId:manifest.jobId,
    requestDigest:manifest.requestDigest, attemptId:manifest.attemptId, turnRef:id(manifest.turnId),
    promptSha256:manifest.promptSha256, inputHashes:[...manifest.inputHashes],
    parentOutputId:manifest.parentOutputId, baseRevisionId:manifest.baseRevisionId,
    targetRef:assertOpaqueRef(manifest.targetRef), status:manifest.status, deliveryStatus:'NOT_RECEIVED',
    expectedCount:manifest.expectedCount, actualCount:manifest.actualCount, uniqueCount:manifest.uniqueCount,
    missingCount:manifest.missingCount, duplicateOutputIds:[...manifest.duplicateOutputIds], checkedAt:manifest.checkedAt,
    outputs, warnings:(manifest.warnings??[]).map(safeCode), errors:manifest.errors.map(e=>({outputId:e.outputId,code:safeCode(e.code)})), exportModes:[...manifest.exportModes]};
  return {...result, manifestDigest:sha256(canonicalArtifactJSON(result))};
}

/**
 * Construct at the receiving host/service. resolveArtifact is its authorized transport,
 * store is its controlled durable storage, authorize checks that consumer's current grant.
 * Producer export alone cannot call this logic without those receiver-owned dependencies.
 */
export function createImageConsumerReceiver({contract, store, authorize, resolveArtifact, decode,
  clock = () => new Date().toISOString()} = {}) {
  assertArtifact(typeof contract?.validateImageOutput === 'function' && typeof contract?.validateImageReceipt === 'function', 'CONTRACT_REQUIRED');
  assertArtifact(store && typeof store.read === 'function' && typeof store.putImmutable === 'function', 'STORE_UNSAFE');
  assertArtifact(typeof authorize === 'function' && typeof resolveArtifact === 'function', 'AUTHORIZATION_DENIED');
  return Object.freeze({async receive({jobId, requestDigest, output: supplied, consumerRef, authorizationContext} = {}) {
    assertImageId(jobId); assertImageId(consumerRef); assertArtifact(isHash(requestDigest), 'INVALID_REQUEST_DIGEST');
    const output = immutableArtifactValue(contract.validateImageOutput(supplied));
    assertArtifact(output.jobId === jobId && output.validation.status === 'VERIFIED', 'UNVERIFIED_OUTPUT');
    assertOpaqueRef(output.artifactRef);
    const binding = {action:'receive', jobId, requestDigest, outputId:output.outputId, consumerRef,
      artifactRef:output.artifactRef, sha256:output.sha256, destinationRef:store.targetRef};
    await authorizeArtifactBinding(authorize, binding, clock(), authorizationContext);
    // Exclude hash/ref from this key: a changed same-output delivery conflicts instead of re-importing.
    const key = sha256(canonicalArtifactJSON({jobId,requestDigest,outputId:output.outputId,consumerRef}));
    const receiptName = `receipt-${key}.json`, bytesName = `received-${key}.bin`;
    const previous = await store.read(receiptName);
    let receipt;
    if (previous) {
      try { receipt = contract.validateImageReceipt(JSON.parse(previous.toString('utf8'))); }
      catch { throw artifactError('STORE_CORRUPT'); }
      assertArtifact(receipt.jobId === jobId && receipt.requestDigest === requestDigest &&
        receipt.outputId === output.outputId && receipt.consumerRef === consumerRef &&
        receipt.artifactRef === output.artifactRef && receipt.sha256 === output.sha256 &&
        receipt.status === 'RECEIVED', 'STORE_CONFLICT');
    }
    let bytes = await store.read(bytesName);
    if (!bytes) {
      // A missing local consumer copy is explicit; this fetch never asks a producer to generate.
      const resolved = await resolveArtifact(immutableArtifactValue(binding), authorizationContext);
      assertArtifact(Buffer.isBuffer(resolved?.bytes) && resolved.mimeType === output.mimeType, 'MIME_MISMATCH');
      bytes = Buffer.from(resolved.bytes);
    }
    const verified = await verifyImageBytes(bytes, {mimeType:output.mimeType, expectedSha256:output.sha256,
      expectedWidth:output.width, expectedHeight:output.height, decode, checkedAt:clock()});
    assertArtifact(verified.byteLength === output.byteLength && verified.width === output.width && verified.height === output.height, 'HASH_MISMATCH');
    // Recheck current permission after I/O and before durable receiving effects or replay return.
    await authorizeArtifactBinding(authorize, binding, clock(), authorizationContext);
    await store.putImmutable(bytesName,bytes);
    if (receipt) return {receipt, reused:true};
    receipt = contract.validateImageReceipt({schemaVersion:'chatbridge.image.receipt.v1', receiptId:`receipt-${key}`,
      consumerRef, jobId, requestDigest, outputId:output.outputId, artifactRef:output.artifactRef,
      sha256:output.sha256, receivedAt:clock(), status:'RECEIVED', reason:null});
    try { await store.putImmutable(receiptName,Buffer.from(canonicalArtifactJSON(receipt))); }
    catch (error) {
      if (error.code !== 'STORE_CONFLICT') throw error;
      const winner = JSON.parse((await store.read(receiptName)).toString('utf8'));
      const {receivedAt:ignoredA,...a} = winner, {receivedAt:ignoredB,...b} = receipt;
      assertArtifact(canonicalArtifactJSON(a) === canonicalArtifactJSON(b), 'STORE_CONFLICT');
      receipt = contract.validateImageReceipt(winner);
    }
    return {receipt, reused:false};
  }});
}

/** Build A's export event from a persisted snapshot. It performs no coordinator call. */
export function imageExportEvent(result, {eventId,expectedRevision,route} = {}) {
  assertImageId(eventId);
  assertArtifact(Number.isSafeInteger(expectedRevision) && expectedRevision >= 1, 'INVALID_REVISION');
  assertArtifact(result?.manifestPersisted === true && result.manifest.outputs.length > 0, 'EXPORT_EVIDENCE_NOT_PERSISTED');
  assertOpaqueRef(result.manifestRef);
  return immutableArtifactValue({eventId,expectedRevision,attemptId:result.manifest.attemptId,route,
    outputs:result.manifest.outputs,evidenceRef:result.manifestRef});
}
