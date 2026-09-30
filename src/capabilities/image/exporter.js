/** #79 original-file recovery. Factory dependencies are trusted; request names/digests are not grants. */
import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute, resolve, join, parse, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertArtifact, artifactError, safeArtifactCode, sha256, isHash, verifyImageBytes} from './verifier.js';
import {canonicalArtifactJSON, immutableArtifactValue, assertOpaqueRef, assertImageId,
  authorizeArtifactBinding, createImageManifest, publicImageManifest} from './manifest.js';

/**
 * Private immutable file store, not an ImageJob database. The trusted host owns the root
 * and its ancestors. Files use O_NOFOLLOW, exclusive temporary files and no-overwrite
 * hard-link publication; rename-overwrite is never used. Same-OS-user hostile directory
 * replacement is outside Node's path-based API guarantee (no openat/dirfd traversal).
 */
export async function createControlledImageStore({root, targetRef, io = fs, maxFileBytes = 100_000_000} = {}) {
  assertOpaqueRef(targetRef);
  assertArtifact(typeof root === 'string' && isAbsolute(root) && resolve(root) === root &&
    !root.includes('\0') && root !== parse(root).root, 'STORE_UNSAFE');
  assertArtifact(Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 && maxFileBytes <= 100_000_000, 'STORE_UNSAFE');
  assertArtifact(typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_DIRECTORY === 'number', 'STORE_UNSAFE');
  async function checkAncestors(path) {
    const base = parse(path).root; let current = base;
    for (const part of path.slice(base.length).split(sep).filter(Boolean)) {
      current = join(current,part);
      const s = await io.lstat(current);
      assertArtifact(s.isDirectory() && !s.isSymbolicLink(), 'STORE_UNSAFE');
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      assertArtifact((uid === null || s.uid === 0 || s.uid === uid) &&
        (!(s.mode & 0o022) || Boolean(s.mode & 0o1000)), 'STORE_UNSAFE');
    }
  }
  await checkAncestors(resolve(root,'..'));
  try { await io.mkdir(root,{mode:0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await checkAncestors(root);
  const pinned = await io.lstat(root);
  function privateRoot(s) {
    return s.isDirectory() && !s.isSymbolicLink() && !(s.mode & 0o077) &&
      (typeof process.getuid !== 'function' || s.uid === process.getuid());
  }
  assertArtifact(privateRoot(pinned), 'STORE_UNSAFE');
  async function guard() {
    await checkAncestors(root);
    const s = await io.lstat(root);
    assertArtifact(privateRoot(s) && s.ino === pinned.ino && s.dev === pinned.dev, 'STORE_CHANGED');
  }
  function filePath(name) {
    assertArtifact(typeof name === 'string' && /^[a-z][a-z0-9-]{0,150}\.(json|bin|png|jpg|webp)$/.test(name), 'STORE_UNSAFE');
    return join(root,name);
  }
  async function read(name) {
    const path = filePath(name); await guard(); let handle;
    try { handle = await io.open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
    catch (error) { if (error.code === 'ENOENT') return null; throw artifactError(error.code === 'ELOOP' ? 'STORE_UNSAFE' : safeArtifactCode(error)); }
    try {
      const before = await handle.stat();
      assertArtifact(before.isFile() && before.nlink === 1 && !(before.mode & 0o077) && before.size <= maxFileBytes, 'STORE_UNSAFE');
      const chunks = []; let length = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(65536,maxFileBytes-length+1));
        const {bytesRead} = await handle.read(chunk,0,chunk.length,null);
        if (!bytesRead) break;
        length += bytesRead; assertArtifact(length <= maxFileBytes, 'STORE_CORRUPT');
        chunks.push(chunk.subarray(0,bytesRead));
      }
      const after = await handle.stat(), named = await io.lstat(path);
      assertArtifact(after.size === length && before.size === after.size && before.mtimeMs === after.mtimeMs &&
        named.ino === before.ino && named.dev === before.dev && !named.isSymbolicLink(), 'STORE_CHANGED');
      await guard();
      return Buffer.concat(chunks,length);
    } finally { await handle.close(); }
  }
  async function putImmutable(name, bytes) {
    const finalPath = filePath(name);
    assertArtifact(Buffer.isBuffer(bytes) && bytes.length <= maxFileBytes, 'ENCODED_SIZE_LIMIT');
    bytes = Buffer.from(bytes);
    await guard();
    const existing = await read(name);
    if (existing) { assertArtifact(existing.equals(bytes), 'STORE_CONFLICT'); return {reused:true}; }
    const temporaryPath = join(root,`.image-tmp-${randomUUID()}`);
    let handle, created = false;
    try {
      handle = await io.open(temporaryPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      created = true;
      await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await guard();
      try { await io.link(temporaryPath,finalPath); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const winner = await read(name);
        assertArtifact(winner && winner.equals(bytes), 'STORE_CONFLICT');
      }
    } finally {
      if (handle) await handle.close();
      if (created) {
        try { await io.unlink(temporaryPath); }
        catch (error) { if (error.code !== 'ENOENT') throw artifactError('STORE_CLEANUP_FAILED'); }
      }
    }
    await guard();
    const directory = await io.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    const confirmed = await read(name);
    assertArtifact(confirmed && confirmed.equals(bytes), 'STORE_CORRUPT');
    return {reused:false};
  }
  return Object.freeze({targetRef, read, putImmutable});
}

function parseRecord(bytes) {
  try { const value = JSON.parse(bytes.toString('utf8')); return immutableArtifactValue(value); }
  catch { throw artifactError('STORE_CORRUPT'); }
}
function recordEquivalent(a,b) {
  // Concurrent same-original writers may have different verification timestamps.
  const compact = r=>({schemaVersion:r.schemaVersion,binding:r.binding,mode:r.mode,artifactRef:r.artifactRef,
    verified:{sha256:r.verified.sha256,mimeType:r.verified.mimeType,byteLength:r.verified.byteLength,
      width:r.verified.width,height:r.verified.height,pixelSha256:r.verified.pixelSha256}});
  return canonicalArtifactJSON(compact(a)) === canonicalArtifactJSON(compact(b));
}

/**
 * contract is A's fixed module; no copy, schema edits, or coordinator changes are required.
 * authorize bridges A's separately issued grant and authenticates the complete binding.
 * readOriginal is B/host's official original handoff, NOT a generic URL/file loader.
 * With no proven export capability/channel, return EXPORT_UNAVAILABLE rather than fake it.
 */
export function createImageExporter({contract, store, authorize, readOriginal, decode,
  clock = () => new Date().toISOString(), maxCapabilityAgeMs = null} = {}) {
  assertArtifact(typeof contract?.normalizeImageRequest === 'function' && typeof contract?.validateImageOutput === 'function' &&
    typeof contract?.validateImageShape === 'function', 'CONTRACT_REQUIRED');
  assertArtifact(store && typeof store.read === 'function' && typeof store.putImmutable === 'function', 'STORE_UNSAFE');
  assertArtifact(typeof authorize === 'function', 'AUTHORIZATION_DENIED');
  assertArtifact(maxCapabilityAgeMs === null || (Number.isSafeInteger(maxCapabilityAgeMs) && maxCapabilityAgeMs > 0), 'INVALID_CAPABILITY_AGE');
  return Object.freeze({async exportOriginals({request: supplied, attemptId, turnId, outputs: suppliedOutputs,
    capabilities: suppliedCapabilities, authorizationContext} = {}) {
    const request = immutableArtifactValue(contract.normalizeImageRequest(supplied));
    assertImageId(attemptId); assertImageId(turnId);
    assertOpaqueRef(request.authorizedOutput.targetRef);
    assertArtifact(request.authorizedOutput.targetRef === store.targetRef, 'AUTHORIZATION_DENIED');
    const capabilities = immutableArtifactValue(contract.validateImageShape(suppliedCapabilities,'Capabilities'));
    assertArtifact(canonicalArtifactJSON(request.route) === canonicalArtifactJSON(capabilities.route), 'CAPABILITY_ROUTE_MISMATCH');
    assertArtifact(Array.isArray(suppliedOutputs) && suppliedOutputs.length <= request.count, 'OUTPUT_COUNT_MISMATCH');
    const outputs = suppliedOutputs.map(o=>{
      assertImageId(o.outputId);
      assertArtifact(['AVAILABLE','MISSING','UNKNOWN','LATE'].includes(o.status), 'INVALID_ORIGINAL_STATUS');
      assertArtifact(o.attemptId === attemptId && o.turnId === turnId, 'SOURCE_BINDING_MISMATCH');
      if (o.originalRef !== null && o.originalRef !== undefined) assertOpaqueRef(o.originalRef);
      if (o.status === 'AVAILABLE') assertOpaqueRef(o.originalRef);
      if (o.expectedSha256 !== undefined && o.expectedSha256 !== null) assertArtifact(isHash(o.expectedSha256), 'HASH_MISMATCH');
      if (request.operation === 'export' && o.expectedSha256 != null) assertArtifact(o.expectedSha256 === request.baseRevision.sha256, 'HASH_MISMATCH');
      for (const dim of [o.expectedWidth,o.expectedHeight]) if (dim !== undefined && dim !== null) assertArtifact(Number.isSafeInteger(dim) && dim > 0 && dim <= 65536, 'INVALID_DIMENSIONS');
      return {outputId:o.outputId,status:o.status,attemptId,turnId,originalRef:o.originalRef ?? null,
        expectedSha256:o.expectedSha256 ?? (request.operation === 'export' ? request.baseRevision.sha256 : null),expectedWidth:o.expectedWidth ?? null,expectedHeight:o.expectedHeight ?? null};
    });
    assertArtifact(new Set(outputs.map(o=>o.outputId)).size === outputs.length, 'DUPLICATE_OUTPUT_ID');
    const binding = {action:'export',callerRef:request.caller.ref,scope:request.scope,jobId:request.jobId,
      requestDigest:request.requestDigest,targetRef:store.targetRef,route:request.route,attemptId,turnId,outputs,capabilities};
    await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
    const capability = capabilities.features.export;
    const observed = Date.parse(capabilities.observedAt), now = Date.parse(clock());
    const available = typeof readOriginal === 'function' && ['NATIVE','ASSISTED'].includes(capability.mode) &&
      capability.evidence.length > 0 && capabilities.version !== 'unobserved/v1' && Number.isFinite(observed) && observed <= now &&
      (maxCapabilityAgeMs === null || now-observed <= maxCapabilityAgeMs);
    if (!available) {
      const manifest = createImageManifest({request,attemptId,turnId,capabilities,items:[],unavailable:true,
        errors:[{outputId:null,code:'EXPORT_UNAVAILABLE'}],checkedAt:clock(),validateOutput:contract.validateImageOutput});
      return {status:manifest.status,manifest,publicManifest:publicImageManifest(manifest)};
    }
    const items = [], errors = [];
    for (const output of outputs) {
      if (output.status !== 'AVAILABLE') {
        errors.push({outputId:output.outputId,code:{MISSING:'ORIGINAL_MISSING',UNKNOWN:'ORIGINAL_UNKNOWN',LATE:'LATE_OUTPUT'}[output.status]});
        continue;
      }
      try {
        await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
        const originalBinding = {requestDigest:request.requestDigest,jobId:request.jobId,attemptId,turnId,
          outputId:output.outputId,originalRef:output.originalRef,expectedSha256:output.expectedSha256,
          expectedWidth:output.expectedWidth,expectedHeight:output.expectedHeight};
        const key = sha256(canonicalArtifactJSON({requestDigest:request.requestDigest,outputId:output.outputId}));
        const recordName = `record-${key}.json`, bytesName = `original-${key}.bin`;
        const artifactRef = `artifact:cbimg:${sha256(store.targetRef)}:${key}`;
        const priorBytes = await store.read(recordName);
        let record = priorBytes ? parseRecord(priorBytes) : null;
        if (record) assertArtifact(record.schemaVersion === 'chatbridge.image.original-record.v1' &&
          canonicalArtifactJSON(record.binding) === canonicalArtifactJSON(originalBinding) && record.artifactRef === artifactRef,
        'STORE_CONFLICT');
        let bytes = await store.read(bytesName), verified;
        if (bytes && !record) throw artifactError('STORE_CORRUPT');
        if (bytes) {
          verified = await verifyImageBytes(bytes,{mimeType:record.verified.mimeType,expectedSha256:record.verified.sha256,
            expectedWidth:output.expectedWidth ?? undefined,expectedHeight:output.expectedHeight ?? undefined,
            aspectRatio:request.aspectRatio,decode,checkedAt:clock()});
        } else {
          // Only an absent original invokes the original provider; no generate/refine API exists here.
          const source = await readOriginal(immutableArtifactValue(originalBinding),authorizationContext);
          const p = source?.provenance;
          assertArtifact(p && ['NATIVE_ORIGINAL','OFFICIAL_HANDOFF'].includes(p.kind), 'SOURCE_NOT_ORIGINAL');
          assertArtifact((capability.mode === 'NATIVE' && p.kind === 'NATIVE_ORIGINAL') ||
            (capability.mode === 'ASSISTED' && p.kind === 'OFFICIAL_HANDOFF'), 'SOURCE_NOT_ORIGINAL');
          for (const key of ['jobId','attemptId','turnId','outputId','originalRef']) assertArtifact(p[key] === originalBinding[key], 'SOURCE_BINDING_MISMATCH');
          assertArtifact(Buffer.isBuffer(source.bytes), 'INVALID_BYTES'); bytes = Buffer.from(source.bytes);
          verified = await verifyImageBytes(bytes,{mimeType:source.mimeType,
            expectedSha256:record?.verified.sha256 ?? output.expectedSha256 ?? undefined,
            expectedWidth:output.expectedWidth ?? undefined,expectedHeight:output.expectedHeight ?? undefined,
            aspectRatio:request.aspectRatio,decode,checkedAt:clock()});
          if (request.operation !== 'export') assertArtifact(!request.inputs.some(i=>i.sha256 === verified.sha256), 'SOURCE_IMAGE_REUSED');
          const next = {schemaVersion:'chatbridge.image.original-record.v1',binding:originalBinding,
            mode:capability.mode,artifactRef,verified};
          if (record) assertArtifact(recordEquivalent(record,next), 'ORIGINAL_CHANGED');
          else {
            // The durable intent precedes bytes. After a crash, existing bytes can be verified
            // without re-fetching; missing bytes must match this immutable hash on recovery.
            await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
            try { await store.putImmutable(recordName,Buffer.from(canonicalArtifactJSON(next))); record = next; }
            catch (error) {
              if (error.code !== 'STORE_CONFLICT') throw error;
              record = parseRecord(await store.read(recordName));
              assertArtifact(recordEquivalent(record,next), 'STORE_CONFLICT');
            }
          }
          await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
          await store.putImmutable(bytesName,bytes);
        }
        assertArtifact(verified.sha256 === record.verified.sha256 && verified.pixelSha256 === record.verified.pixelSha256, 'STORE_CORRUPT');
        await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
        // A's VERIFIED Output is immutable. Preserve original byte-check evidence;
        // the manifest timestamp records this run's fresh hash/decode/count checks.
        verified.validation.checkedAt = record.verified.validation.checkedAt;
        items.push({outputId:output.outputId,artifactRef,mode:record.mode,verified});
      } catch (error) { errors.push({outputId:output.outputId,code:safeArtifactCode(error)}); }
    }
    let manifest = createImageManifest({request,attemptId,turnId,capabilities,items,errors,checkedAt:clock(),validateOutput:contract.validateImageOutput});
    let shared = publicImageManifest(manifest);
    // Each snapshot is immutable; PARTIAL history is retained rather than overwritten by a retry.
    let manifestPersisted = false;
    try {
      await authorizeArtifactBinding(authorize,binding,clock(),authorizationContext);
      await store.putImmutable(`manifest-${shared.manifestDigest}.json`,Buffer.from(canonicalArtifactJSON(shared)));
      manifestPersisted = true;
    } catch (error) {
      manifest = createImageManifest({request,attemptId,turnId,capabilities,items,
        errors:[...errors,{outputId:null,code:safeArtifactCode(error)}],checkedAt:clock(),validateOutput:contract.validateImageOutput});
      shared = publicImageManifest(manifest);
    }
    return {status:manifest.status,manifest,publicManifest:shared,manifestPersisted,
      manifestRef:manifestPersisted ? `artifact:cbimg-manifest:${sha256(store.targetRef)}:${shared.manifestDigest}` : null};
  }});
}
