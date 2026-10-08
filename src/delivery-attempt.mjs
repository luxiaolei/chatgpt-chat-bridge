// A private same-claim journal. Observations never become delivery/parent proof here.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const FORMAT='chat-bridge-delivery-attempt-v1';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const phases=new Map([
  ['DRAFT_BACKUP','15'],['DRAFT_DISCARD_INTENT','17'],['DRAFT_DISCARDED','18'],
  ['TARGET_OBSERVED','10'],['BEFORE_INPUT','20'],['INPUT_VERIFIED','30'],
  ['SEND_INTENT','40'],['SEND_RETURNED','50'],['OBSERVED','60'],
  ['DELIVERY_CONFIRMED','70'],['ERROR','90']
]);
async function directorySafe(directory){
  const st=await fs.lstat(directory);
  if(!st.isDirectory()||(st.mode&0o077)||(process.getuid&&st.uid!==process.getuid()))
    throw new Error('DELIVERY_EVIDENCE_DIRECTORY_UNSAFE');
}
async function syncDirectory(directory){const f=await fs.open(directory,'r');try{await f.sync();}finally{await f.close();}}
export async function openAttempt(stateDirectory, descriptor){
  if(!descriptor||descriptor.format!==FORMAT||!Number.isSafeInteger(descriptor.claimOrdinal)||descriptor.claimOrdinal<1||
    !/^[0-9a-f-]{36}$/.test(descriptor.operationId||'')||!/^[0-9a-f]{64}$/.test(descriptor.manifestSha256||''))
    throw new Error('DELIVERY_ATTEMPT_DESCRIPTOR_INVALID');
  const root=path.join(await fs.realpath(stateDirectory),'delivery-attempts');
  const owner=path.join(root,descriptor.operationId),directory=path.join(owner,String(descriptor.claimOrdinal));
  if(descriptor.directory!==directory)throw new Error('DELIVERY_ATTEMPT_PATH_MISMATCH');
  for(const p of [root,owner,directory])await directorySafe(p);
  const manifestPath=path.join(directory,'manifest.json'),st=await fs.lstat(manifestPath);
  if(!st.isFile()||st.mode&0o077||st.size>65536)throw new Error('DELIVERY_MANIFEST_UNSAFE');
  const raw=await fs.readFile(manifestPath);
  if(sha(raw)!==descriptor.manifestSha256)throw new Error('DELIVERY_MANIFEST_CHANGED');
  const manifest=JSON.parse(raw);
  if(manifest.format!==FORMAT||manifest.operationId!==descriptor.operationId||manifest.claimOrdinal!==descriptor.claimOrdinal)
    throw new Error('DELIVERY_MANIFEST_IDENTITY_MISMATCH');
  let observation=0;
  return {manifest,async record(phase,data={},message=null){
    if(!phases.has(phase))throw new Error('DELIVERY_PHASE_INVALID');
    if(message!==null&&sha(message)!==manifest.messageSha256)throw new Error('DELIVERY_ATTEMPT_MESSAGE_MISMATCH');
    if(manifest.route && ['TARGET_OBSERVED','BEFORE_INPUT','INPUT_VERIFIED','SEND_INTENT'].includes(phase)) {
      const route=manifest.route;
      const value=data.url||data.targetUrl||data.nativeWitness?.url||data.snapshot?.url;
      let url;try{url=new URL(value);}catch{throw new Error('DELIVERY_ROUTE_CHANGED');}
      const target=url.pathname.match(/^\/g\/(g-p-[0-9a-f]{32})(?:-[^/]+)?\/(?:project|c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i);
      if(url.origin!=='https://chatgpt.com'||url.username||url.password||!target||target[1].toLowerCase()!==route.projectId||
         phase==='TARGET_OBSERVED'&&data.profileId!==route.profileId||
         phase==='INPUT_VERIFIED'&&data.nativeWitness?.accountIdentityHash!==route.identityHash)
        throw new Error('DELIVERY_ROUTE_CHANGED');
    }
    if(phase==='OBSERVED'&&++observation>128)throw new Error('DELIVERY_OBSERVATION_BUDGET_EXCEEDED');
    const name=phases.get(phase)+'-'+phase+(phase==='OBSERVED'?'-'+String(observation).padStart(3,'0'):'')+'.json';
    const bytes=Buffer.from(JSON.stringify({format:FORMAT,operationId:manifest.operationId,claimOrdinal:manifest.claimOrdinal,
      manifestSha256:descriptor.manifestSha256,phase,recordedAt:new Date().toISOString(),data})+'\n');
    if(bytes.length>2*1024*1024)throw new Error('DELIVERY_EVIDENCE_TOO_LARGE');
    const destination=path.join(directory,name);
    // O_EXCL makes a second trigger under the same persisted claim impossible.
    // A crash leaving a partial record is inconclusive, never permission to replay.
    let file;
    try{
      await directorySafe(directory);
      file=await fs.open(destination,'wx',0o600);
      await file.writeFile(bytes);await file.sync();await file.close();file=null;
      await syncDirectory(directory);
    }catch(error){
      if(file)await file.close().catch(()=>{});
      if(phase==='SEND_INTENT'||error.code==='EEXIST')error.deliveryStage='SEND_ATTEMPTED';
      if(error.code==='EEXIST')error.code='DELIVERY_ATTEMPT_ALREADY_RECORDED';
      throw error;
    }
    return {path:destination,sha256:sha(bytes),bytes:bytes.length};
  }};
}
