/** Original-byte verification. No browser, network, image generation, or header-only success. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isAbsolute} from 'node:path';

export const IMAGE_VERIFIER_VERSION = 'image-artifacts/v1';
export class ImageArtifactError extends Error {
  constructor(code) { super(code); this.name = 'ImageArtifactError'; this.code = code; }
}
export const artifactError = code => new ImageArtifactError(code);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function assertArtifact(condition, code) { if (!condition) throw artifactError(code); }
export function safeArtifactCode(error) {
  const allowed = new Set(['EXPORT_UNAVAILABLE','ORIGINAL_MISSING','ORIGINAL_UNKNOWN','ORIGINAL_EXPIRED',
    'LATE_OUTPUT','AUTHORIZATION_DENIED','AUTHORIZATION_EXPIRED','SOURCE_BINDING_MISMATCH',
    'SOURCE_NOT_ORIGINAL','SOURCE_IMAGE_REUSED','ORIGINAL_CHANGED','INVALID_BYTES','ENCODED_SIZE_LIMIT','MAGIC_UNSUPPORTED',
    'MIME_MISMATCH','HASH_MISMATCH','DECODE_UNAVAILABLE','DECODE_FAILED','DECODE_LIMIT','DECODE_TIMEOUT',
    'DECODE_PROTOCOL','ANIMATION_UNSUPPORTED','STORE_CONFLICT','STORE_CORRUPT','STORE_UNSAFE',
    'STORE_CHANGED','STORE_IO_ERROR','STORE_CLEANUP_FAILED','ENOSPC','EACCES','EIO','EROFS','EDQUOT']);
  return allowed.has(error?.code) ? error.code : 'ARTIFACT_ERROR';
}

/** Format sniffing is only the first gate. verifyImageBytes always invokes a full decoder. */
export function sniffImageMime(bytes) {
  assertArtifact(Buffer.isBuffer(bytes) && bytes.length > 0, 'INVALID_BYTES');
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp';
  throw artifactError('MAGIC_UNSUPPORTED');
}

/** Reject container truncation/trailing payloads and animation before the full decoder. */
function checkContainer(bytes, mime) {
  if (mime === 'image/jpeg') {
    assertArtifact(bytes.length >= 4 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, 'DECODE_FAILED');
  } else if (mime === 'image/webp') {
    assertArtifact(bytes.readUInt32LE(4)+8 === bytes.length, 'DECODE_FAILED');
    let offset = 12;
    while (offset+8 <= bytes.length) {
      const kind = bytes.toString('ascii',offset,offset+4), size = bytes.readUInt32LE(offset+4);
      assertArtifact(offset+8+size <= bytes.length, 'DECODE_FAILED');
      assertArtifact(kind !== 'ANIM' && kind !== 'ANMF' && !(kind === 'VP8X' && (bytes[offset+8]&2)), 'ANIMATION_UNSUPPORTED');
      offset += 8+size+(size%2);
    }
    assertArtifact(offset === bytes.length, 'DECODE_FAILED');
  } else {
    const table = new Uint32Array(256);
    for (let n=0;n<256;n++) { let c=n; for (let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; table[n]=c>>>0; }
    let offset=8, ended=false;
    while (offset+12 <= bytes.length) {
      const size=bytes.readUInt32BE(offset), end=offset+12+size;
      assertArtifact(end <= bytes.length, 'DECODE_FAILED');
      const kind=bytes.toString('ascii',offset+4,offset+8);
      assertArtifact(kind !== 'acTL' && kind !== 'fcTL' && kind !== 'fdAT', 'ANIMATION_UNSUPPORTED');
      let crc=0xffffffff;
      for (let i=offset+4;i<end-4;i++) crc=table[(crc^bytes[i])&255]^(crc>>>8);
      assertArtifact(((crc^0xffffffff)>>>0) === bytes.readUInt32BE(end-4), 'DECODE_FAILED');
      if (kind === 'IEND') { assertArtifact(size === 0 && end === bytes.length, 'DECODE_FAILED'); ended=true; break; }
      offset=end;
    }
    assertArtifact(ended, 'DECODE_FAILED');
  }
}

/**
 * Full raster decoder using an explicitly configured, trusted ImageMagick 7 executable.
 * Original input is piped to a forced PNG/JPEG/WebP coder, never interpreted as a path/URL.
 * PAM output forces pixel decode; exact raster length, exit status AND stderr are checked.
 * No identify/-ping/header dimensions count as decode evidence. No disk cache or delegates
 * are needed for these raster coders. The host still owns its patched decoder/policy.
 */
export function createImageMagickDecoder({executable, timeoutMs = 15000, maxPixels = 16_777_216,
  maxDimension = 16384, memoryMiB = 512} = {}) {
  assertArtifact(typeof executable === 'string' && isAbsolute(executable) && !executable.includes('\0'), 'DECODE_UNAVAILABLE');
  assertArtifact(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000, 'DECODE_LIMIT');
  assertArtifact(Number.isSafeInteger(maxPixels) && maxPixels > 0 && maxPixels <= 67_108_864, 'DECODE_LIMIT');
  assertArtifact(Number.isSafeInteger(maxDimension) && maxDimension > 0 && maxDimension <= 65536, 'DECODE_LIMIT');
  assertArtifact(Number.isSafeInteger(memoryMiB) && memoryMiB >= 16 && memoryMiB <= 2048, 'DECODE_LIMIT');
  return async function decode(bytes, mimeType) {
    const format = {'image/png':'png','image/jpeg':'jpeg','image/webp':'webp'}[mimeType];
    assertArtifact(format, 'MAGIC_UNSUPPORTED');
    return new Promise((resolve, reject) => {
      const args = ['-regard-warnings','-limit','memory',`${memoryMiB}MiB`,'-limit','map','0',
        '-limit','disk','0','-limit','thread','1','-limit','width',String(maxDimension),
        '-limit','height',String(maxDimension),'-limit','area',String(maxPixels),
        '-limit','list-length','4',`${format}:-`,'-alpha','on','-colorspace','sRGB','-depth','8','pam:-'];
      const child = spawn(executable, args, {stdio:['pipe','pipe','pipe'], windowsHide:true, shell:false});
      let failure = null, prefix = Buffer.alloc(0), geometry = null, rasterBytes = 0, stderrBytes = 0;
      const pixels = createHash('sha256');
      const stop = code => { if (!failure) failure = artifactError(code); child.kill('SIGKILL'); };
      const timer = setTimeout(() => stop('DECODE_TIMEOUT'), timeoutMs);
      child.on('error', error => { failure = artifactError(error.code === 'ENOENT' ? 'DECODE_UNAVAILABLE' : 'DECODE_FAILED'); });
      child.stdin.on('error', () => { /* EPIPE is resolved from the decoder's exit and output. */ });
      child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 8192) stop('DECODE_FAILED'); });
      child.stdout.on('data', data => {
        if (failure) return;
        try {
          if (!geometry) {
            prefix = Buffer.concat([prefix,data]);
            const end = prefix.indexOf(Buffer.from('ENDHDR\n'));
            if (end < 0) { if (prefix.length > 1024) stop('DECODE_PROTOCOL'); return; }
            assertArtifact(end < 1024, 'DECODE_PROTOCOL');
            const header = prefix.subarray(0,end+7).toString('ascii');
            const match = /^P7\nWIDTH ([1-9][0-9]*)\nHEIGHT ([1-9][0-9]*)\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n$/.exec(header);
            assertArtifact(match, 'DECODE_PROTOCOL');
            const width = Number(match[1]), height = Number(match[2]);
            assertArtifact(Number.isSafeInteger(width*height) && width <= maxDimension && height <= maxDimension && width*height <= maxPixels, 'DECODE_LIMIT');
            geometry = {width,height};
            data = prefix.subarray(end+7); prefix = Buffer.alloc(0);
          }
          rasterBytes += data.length;
          assertArtifact(rasterBytes <= geometry.width*geometry.height*4, 'ANIMATION_UNSUPPORTED');
          pixels.update(data);
        } catch (error) { stop(safeArtifactCode(error)); }
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (failure) return reject(failure);
        if (code !== 0 || signal || stderrBytes || !geometry || rasterBytes !== geometry.width*geometry.height*4) return reject(artifactError('DECODE_FAILED'));
        resolve({...geometry, frames:1, pixelSha256:pixels.digest('hex'), decodedBytes:rasterBytes,
          decoder:'imagemagick7-pam-rgba8', fullDecode:true});
      });
      child.stdin.end(bytes);
    });
  };
}

/** The decoder is a trusted factory dependency, never selected by request fields. */
export async function verifyImageBytes(bytes, {mimeType, expectedSha256, expectedWidth, expectedHeight,
  aspectRatio, maxBytes = 25_000_000, decode, checkedAt = new Date().toISOString()} = {}) {
  assertArtifact(Buffer.isBuffer(bytes) && bytes.length > 0, 'INVALID_BYTES');
  assertArtifact(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 100_000_000 && bytes.length <= maxBytes, 'ENCODED_SIZE_LIMIT');
  bytes = Buffer.from(bytes); // Snapshot caller-owned buffers before any asynchronous decoder work.
  const actualMime = sniffImageMime(bytes);
  assertArtifact(actualMime === mimeType, 'MIME_MISMATCH');
  checkContainer(bytes,actualMime);
  const hash = sha256(bytes);
  if (expectedSha256 !== undefined) assertArtifact(isHash(expectedSha256) && expectedSha256 === hash, 'HASH_MISMATCH');
  assertArtifact(typeof decode === 'function', 'DECODE_UNAVAILABLE');
  const raster = await decode(bytes, actualMime);
  assertArtifact(raster?.fullDecode === true && raster.frames === 1 && isHash(raster.pixelSha256) &&
    Number.isSafeInteger(raster.width) && raster.width > 0 && raster.width <= 65536 &&
    Number.isSafeInteger(raster.height) && raster.height > 0 && raster.height <= 65536 &&
    raster.decodedBytes === raster.width*raster.height*4, 'DECODE_PROTOCOL');
  const warnings = [];
  if (aspectRatio !== undefined) {
    assertArtifact(typeof aspectRatio === 'string' && /^[1-9][0-9]?:[1-9][0-9]?$/.test(aspectRatio), 'INVALID_ASPECT_RATIO');
    const [w,h] = aspectRatio.split(':').map(Number);
    if (raster.width*h !== raster.height*w) warnings.push('ASPECT_RATIO_MISMATCH');
  }
  if ((expectedWidth !== undefined && raster.width !== expectedWidth) || (expectedHeight !== undefined && raster.height !== expectedHeight)) warnings.push('DIMENSIONS_MISMATCH');
  assertArtifact(Number.isFinite(Date.parse(checkedAt)), 'INVALID_TIMESTAMP');
  return {mimeType:actualMime, byteLength:bytes.length, sha256:hash, width:raster.width, height:raster.height,
    pixelSha256:raster.pixelSha256, decoder:raster.decoder, warnings,
    validation:{status:'UNVERIFIED', verifierVersion:IMAGE_VERIFIER_VERSION, checkedAt,
      checks:{magic:true,mime:true,decode:true,hash:true,count:false}}};
}

/** Byte-identical AND normalized-raster duplicates are surfaced; neither is silently discarded. */
export function inspectImageCount(items, expectedCount) {
  assertArtifact(Number.isSafeInteger(expectedCount) && expectedCount >= 1 && expectedCount <= 16, 'INVALID_COUNT');
  const byteSeen = new Map(), pixelSeen = new Map(), duplicateOutputIds = [];
  for (const item of items) {
    const p = `${item.width}x${item.height}:${item.pixelSha256}`;
    if (byteSeen.has(item.sha256) || pixelSeen.has(p)) duplicateOutputIds.push(item.outputId);
    byteSeen.set(item.sha256,item.outputId); pixelSeen.set(p,item.outputId);
  }
  return {expectedCount, actualCount:items.length, uniqueCount:items.length-duplicateOutputIds.length,
    duplicateOutputIds, countMatches:items.length === expectedCount && duplicateOutputIds.length === 0};
}
