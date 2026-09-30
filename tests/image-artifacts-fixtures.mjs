// Synthetic, non-sensitive offline fixtures. This small contract double is NOT a production schema.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {deflateSync, inflateSync} from 'node:zlib';
import {createImageMagickDecoder, sha256} from '../src/capabilities/image/verifier.js';
import {canonicalArtifactJSON} from '../src/capabilities/image/manifest.js';

export const AT = '2026-09-30T07:00:00.000Z';
export const FUTURE = '2099-01-01T00:00:00.000Z';
export const MAGICK = ['/opt/homebrew/bin/magick','/usr/bin/magick','/usr/local/bin/magick'].find(existsSync);
export function crc32(bytes) { let c=0xffffffff; for (const byte of bytes) { c^=byte; for(let i=0;i<8;i++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; } return (c^0xffffffff)>>>0; }
export function pngChunk(kind, payload) {
  const t=Buffer.from(kind), out=Buffer.alloc(payload.length+12);
  out.writeUInt32BE(payload.length); t.copy(out,4); payload.copy(out,8); out.writeUInt32BE(crc32(Buffer.concat([t,payload])),out.length-4); return out;
}
export function png({width=2,height=2,rgba=[33,66,99,255],comment='',compressed,animated=false} = {}) {
  const header=Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=6;
  const pixels=Buffer.alloc(height*(1+width*4));
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) Buffer.from(rgba).copy(pixels,y*(1+width*4)+1+x*4);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),
    ...(comment?[pngChunk('tEXt',Buffer.from(`note\0${comment}`))]:[]),
    ...(animated?[pngChunk('acTL',Buffer.from('0000000100000000','hex'))]:[]),
    pngChunk('IDAT',compressed ?? deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}
// A full (filter-0 RGBA8 only) decoder for these synthetic unit fixtures, not production fallback.
export async function fixtureDecode(bytes) {
  assert.equal(bytes.toString('hex',0,8),'89504e470d0a1a0a');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20); const compressed=[];
  let offset=8;
  while(offset+12<=bytes.length) { const len=bytes.readUInt32BE(offset); if(bytes.toString('ascii',offset+4,offset+8)==='IDAT') compressed.push(bytes.subarray(offset+8,offset+8+len)); offset+=12+len; }
  const decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:1_000_000}); assert.equal(decoded.length,(width*4+1)*height);
  const pixels=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++) { assert.equal(decoded[y*(width*4+1)],0); decoded.copy(pixels,y*width*4,y*(width*4+1)+1,(y+1)*(width*4+1)); }
  return {width,height,frames:1,fullDecode:true,decodedBytes:pixels.length,pixelSha256:sha256(pixels),decoder:'test-filter0-rgba8'};
}
export const decode = MAGICK ? createImageMagickDecoder({executable:MAGICK}) : fixtureDecode;
export const authorize = async binding => ({allowed:true,bindingDigest:sha256(canonicalArtifactJSON(binding)),expiresAt:FUTURE});
export async function scratch(t) {
  const base=await fs.realpath(tmpdir()); const path=await fs.mkdtemp(join(base,'image-artifacts-test-'));
  t.after(()=>fs.rm(path,{recursive:true,force:true})); return path;
}
export function request(overrides={}) {
  return {schemaVersion:'chatbridge.image.v1',jobId:'synthetic-image',operation:'generate',
    caller:{kind:'chat',ref:'worker'},scope:{tenantId:'synthetic',namespace:'offline',purpose:'test',workgroupId:null},
    controllerTaskId:'synthetic-controller',route:{project:'Chat Bridge',projectId:'g-p-fixture',accountAlias:'default',accountId:'a'.repeat(64),sessionRef:'session-fixture',conversationId:'conversation-private'},
    prompt:'PRIVATE_SYNTHETIC_PROMPT',inputs:[],baseRevision:null,mask:null,count:1,aspectRatio:'1:1',conversationPolicy:'existing',
    budget:{maxAttempts:2,maxOutputs:16,maxDurationMs:60000,deadlineAt:FUTURE,allowPaidApi:false},
    authorizedOutput:{targetRef:'store:synthetic',retentionHours:24},requestedModel:'Latest',requestedEffort:'Pro',...overrides};
}
export function capabilities(req,mode='ASSISTED') {
  return {version:'synthetic-capability/v1',observedAt:AT,route:req.route,
    modelSelection:{model:'Latest',effort:'Pro',raw:'Pro',verified:true},
    features:Object.fromEntries(['generate','edit','refine','export','multiReference','mask','deterministicComposite','batch']
      .map(k=>[k,{mode:k==='export'?mode:'UNKNOWN',evidence:k==='export'&&mode!=='UNKNOWN'?['urn:synthetic:official-handoff']:[]}]))};
}
export function slot(id='out-1', overrides={}) {
  return {outputId:id,status:'AVAILABLE',attemptId:'attempt-1',turnId:'turn-1',originalRef:`artifact:official:${id}`,...overrides};
}
export function provider(images=new Map([['out-1',png()]]), counts=new Map(), kind='OFFICIAL_HANDOFF') {
  return async binding => {
    counts.set(binding.outputId,(counts.get(binding.outputId)||0)+1);
    const value=images.get(binding.outputId);
    if(value instanceof Error) throw value;
    if(!value) throw Object.assign(new Error('missing'),{code:'ORIGINAL_MISSING'});
    return {bytes:value,mimeType:'image/png',provenance:{kind,...binding}};
  };
}
export const testContract = {
  normalizeImageRequest(input) { const {requestDigest,...body}=input; const normalized={...body,requestDigest:sha256(canonicalArtifactJSON(body))}; if(requestDigest) assert.equal(requestDigest,normalized.requestDigest); return normalized; },
  validateImageShape(value,definition) { assert.equal(definition,'Capabilities'); assert.ok(value.features.export); return value; },
  validateImageOutput(output) {
    assert.match(output.sha256,/^[a-f0-9]{64}$/); assert.ok(output.width>0&&output.height>0); assert.match(output.artifactRef,/^artifact:/);
    if(output.validation.status==='VERIFIED') assert.ok(Object.values(output.validation.checks).every(v=>v===true)); return output;
  },
  validateImageReceipt(receipt) { assert.equal(receipt.schemaVersion,'chatbridge.image.receipt.v1'); assert.ok(['RECEIVED','REJECTED'].includes(receipt.status)); assert.match(receipt.sha256,/^[a-f0-9]{64}$/); return receipt; },
};
