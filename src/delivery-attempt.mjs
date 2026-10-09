// A private same-claim journal. Observations never become delivery/parent proof here.
import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const FORMAT='chat-bridge-delivery-attempt-v1';
const DIRECT_FORMAT='chat-bridge-direct-request-v1';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const phases=new Map([
  ['REQUEST_INTENT','00'],
  ['ALLOCATION_INTENT','01'],['ALLOCATION_REFUSED','02'],['PAGE_ALLOCATED','03'],['ALLOCATION_UNKNOWN','04'],
  ['PAGE_HANDED_OFF','05'],
  ['PAGE_RELEASE_INTENT','80'],['PAGE_RELEASED','81'],['PAGE_RELEASE_UNKNOWN','82'],
  ['DRAFT_BACKUP','15'],['DRAFT_DISCARD_INTENT','17'],['DRAFT_DISCARDED','18'],
  ['TARGET_OBSERVED','10'],['BEFORE_INPUT','20'],['INPUT_VERIFIED','30'],
  ['SEND_INTENT','40'],['SEND_RETURNED','50'],['OBSERVED','60'],
  ['DELIVERY_CONFIRMED','70'],['SCRIPT_FINISHED','75'],['ERROR','90']
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
  return journal(directory,manifest,descriptor);
}
function journal(directory,manifest,descriptor,assertCurrent=null){
  let observation=0;
  return {manifest,async record(phase,data={},message=null){
    if(!phases.has(phase))throw new Error('DELIVERY_PHASE_INVALID');
    if(['REQUEST_INTENT','ALLOCATION_INTENT','TARGET_OBSERVED','DRAFT_DISCARD_INTENT','BEFORE_INPUT','SEND_INTENT'].includes(phase))assertCurrent?.();
    const allocationPhase=phase.startsWith('ALLOCATION_')||phase.startsWith('PAGE_');
    if(allocationPhase&&(!Number.isSafeInteger(data.allocationOrdinal)||data.allocationOrdinal<1))
      throw new Error('DELIVERY_ALLOCATION_ORDINAL_INVALID');
    if(allocationPhase&&manifest.route&&(data.project!==manifest.project||data.account!==manifest.account||data.profileId!==manifest.route.profileId))
      throw new Error('DELIVERY_ALLOCATION_ROUTE_CHANGED');
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
      if(manifest.format===DIRECT_FORMAT && url.origin+'/g/'+target[1].toLowerCase()+'/c/'+
         (url.pathname.match(/\/c\/([0-9a-f-]{36})\/?$/i)?.[1]||'').toLowerCase()!==manifest.targetUrl)
        throw new Error('DELIVERY_ROUTE_CHANGED');
    }
    if(phase==='OBSERVED'&&++observation>128)throw new Error('DELIVERY_OBSERVATION_BUDGET_EXCEEDED');
    const name=phases.get(phase)+'-'+phase+(allocationPhase?'-'+String(data.allocationOrdinal).padStart(3,'0'):phase==='OBSERVED'?'-'+String(observation).padStart(3,'0'):'')+'.json';
    const identity=manifest.format===DIRECT_FORMAT?{format:DIRECT_FORMAT,requestId:manifest.requestId,operationId:manifest.operationId,claimToken:manifest.claimToken}:
      {format:FORMAT,operationId:manifest.operationId,claimOrdinal:manifest.claimOrdinal};
    const bytes=Buffer.from(JSON.stringify({...identity,
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
      if(allocationPhase)error.allocationState='UNKNOWN';
      else if(phase==='SEND_INTENT'||error.code==='EEXIST')error.deliveryStage='SEND_ATTEMPTED';
      if(error.code==='EEXIST')error.code='DELIVERY_ATTEMPT_ALREADY_RECORDED';
      throw error;
    }
    return {path:destination,sha256:sha(bytes),bytes:bytes.length};
  }};
}

function directError(code,uncertain=false){
  const error=new Error(code);error.code=code;
  if(uncertain)error.deliveryStage='SEND_ATTEMPTED';
  return error;
}
function readRequest(file){
  let fd;
  try{
    fd=syncFs.openSync(file,syncFs.constants.O_RDONLY|syncFs.constants.O_NOFOLLOW);
    const st=syncFs.fstatSync(fd);
    if(!st.isFile()||(st.mode&0o077)||st.size>65536||(process.getuid&&st.uid!==process.getuid()))
      throw directError('DIRECT_REQUEST_FILE_UNSAFE');
    const bytes=Buffer.alloc(st.size+1),length=syncFs.readSync(fd,bytes,0,bytes.length,0);
    if(length!==st.size)throw directError('DIRECT_REQUEST_CHANGED');
    return bytes.subarray(0,length);
  }catch(error){
    if(error.code?.startsWith('DIRECT_REQUEST_'))throw error;
    throw directError('DIRECT_REQUEST_FILE_UNAVAILABLE');
  }finally{if(fd!==undefined)syncFs.closeSync(fd);}
}
export async function openDirectRequest(stateDirectory,descriptor,expected){
  if(!descriptor||!path.isAbsolute(descriptor.requestFile||'')||!/^[0-9a-f]{64}$/.test(descriptor.requestId||'')||
     !/^[0-9a-f]{64}$/.test(descriptor.expectedHash||''))throw directError('DIRECT_REQUEST_DESCRIPTOR_INVALID');
  const root=path.join(await fs.realpath(stateDirectory),'direct-requests'),directory=path.join(root,descriptor.requestId);
  try{await fs.lstat(directory);throw directError('DIRECT_REQUEST_ALREADY_RECORDED',true);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const raw=readRequest(descriptor.requestFile);
  if(sha(raw)!==descriptor.expectedHash)throw directError('DIRECT_REQUEST_CHANGED');
  let manifest;try{manifest=JSON.parse(raw);}catch{throw directError('DIRECT_REQUEST_INVALID');}
  const text=value=>typeof value==='string'&&value.length>0&&value.length<=1024;
  if(manifest?.format!==DIRECT_FORMAT||!text(manifest.operationId)||!text(manifest.claimToken)||
     !text(manifest.owner?.agentId)||!text(manifest.owner?.principal)||!text(manifest.jobId)||
     !Number.isSafeInteger(manifest.generation)||manifest.generation<1||!Number.isSafeInteger(manifest.attempt)||manifest.attempt<1||
     !Number.isSafeInteger(manifest.deadlineAt)||manifest.deadlineAt<1||!/^[0-9a-f]{64}$/.test(manifest.contextSha256||'')||
     manifest.requestId!==descriptor.requestId||manifest.requestId!==sha(JSON.stringify([manifest.operationId,manifest.claimToken])))
    throw directError('DIRECT_REQUEST_INVALID');
  for(const key of ['project','account','accountId','sessionRef','targetUrl','callerRef','taskId','messageSha256','requestedModel','requestedEffort'])
    if(manifest[key]!==expected?.[key])throw directError('DIRECT_REQUEST_SCOPE_MISMATCH');
  for(const key of ['projectId','profileId','identityHash'])
    if(!text(expected?.route?.[key])||manifest.route?.[key]!==expected.route[key])throw directError('DIRECT_REQUEST_SCOPE_MISMATCH');
  if(!/^https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{32}\/c\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(manifest.targetUrl||'')||
     !/^[0-9a-f]{64}$/.test(manifest.messageSha256||'')||!/^[0-9a-f]{64}$/.test(manifest.accountId||'')||
     !/^[0-9a-f]{64}$/.test(manifest.route.identityHash||''))throw directError('DIRECT_REQUEST_SCOPE_MISMATCH');
  const assertCurrent=()=>{
    if(Date.now()>=manifest.deadlineAt)throw directError('DIRECT_REQUEST_EXPIRED');
    let current;try{current=readRequest(descriptor.requestFile);}catch{throw directError('DIRECT_REQUEST_CHANGED');}
    if(sha(current)!==descriptor.expectedHash)throw directError('DIRECT_REQUEST_CHANGED');
    try{syncFs.lstatSync(descriptor.requestFile+'.revoked');throw directError('DIRECT_REQUEST_REVOKED');}
    catch(error){if(error.code!=='ENOENT')throw error;}
    if(Date.now()>=manifest.deadlineAt)throw directError('DIRECT_REQUEST_EXPIRED');
  };
  assertCurrent();
  await fs.mkdir(root,{recursive:true,mode:0o700});await directorySafe(root);
  try{await fs.mkdir(directory,{mode:0o700});}
  catch(error){if(error.code==='EEXIST')throw directError('DIRECT_REQUEST_ALREADY_RECORDED',true);throw error;}
  const manifestPath=path.join(directory,'manifest.json'),file=await fs.open(manifestPath,'wx',0o600);
  try{await file.writeFile(raw);await file.sync();}finally{await file.close();}
  await syncDirectory(directory);await syncDirectory(root);
  const result=journal(directory,manifest,{manifestSha256:descriptor.expectedHash},assertCurrent);
  result.assertCurrent=assertCurrent;
  result.reference={format:DIRECT_FORMAT,requestId:manifest.requestId,operationId:manifest.operationId,claimToken:manifest.claimToken,
    requestFile:descriptor.requestFile,directory,manifestPath,manifestSha256:descriptor.expectedHash};
  await result.record('REQUEST_INTENT',{requestFile:descriptor.requestFile,expectedHash:descriptor.expectedHash});
  return result;
}
