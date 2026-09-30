/** Local ImageJob CLI. No live image port is installed by this offline delivery. */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import path from 'node:path';
import {createImageJobAPI} from './contract.js';
import {normalizeExecutionRequest,imageExecutionProbe} from './chatgpt-ego.js';

export async function imageCli(action,payload={}, {coordinated}={}) {
  if (action==='probe') return imageExecutionProbe(payload.route ?? null);
  if (action==='validate') {
    const request=normalizeExecutionRequest(payload.request);
    return {ok:true,requestDigest:request.requestDigest,operation:request.operation,jobId:request.jobId};
  }
  if (['start','reconcile'].includes(action)) {
    return {ok:false,status:'BLOCKED',code:'IMAGE_EXECUTION_INTEGRATION_REQUIRED',retryAllowed:false,
      reason:'Live image submission and observation are not wired; no UI action was attempted.',
      deliveryStage:'PRE_SEND',originalExportStatus:'EXPORT_UNAVAILABLE'};
  }
  if (!['submit','inspect','result','cancel'].includes(action)) throw new Error('IMAGE_COMMAND_UNSUPPORTED');
  const api=createImageJobAPI({coordinated});
  if (action==='submit') return api.submit(normalizeExecutionRequest(payload.request),{grantId:payload.grantId});
  if (action==='cancel') return api.cancel(payload.key,payload.event);
  return api[action](payload);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks=[];let length=0;
    for await (const chunk of process.stdin) {
      length+=chunk.length;
      if (length>2_000_000) throw new Error('IMAGE_PAYLOAD_TOO_LARGE');
      chunks.push(chunk);
    }
    const raw=Buffer.concat(chunks).toString('utf8'),payload=raw.trim()?JSON.parse(raw):{};
    const config=process.env.CHAT_BRIDGE_CONFIG_DIR || path.join(homedir(),'.config/chat-bridge');
    const state=process.env.CHAT_BRIDGE_STATE_DIR || path.join(homedir(),'.local/state/chat-bridge');
    const coordinator=fileURLToPath(new URL('../../coordinator.py',import.meta.url));
    const coordinated=(command,input)=>{
      const result=spawnSync('python3',[coordinator,command,config,state],{encoding:'utf8',input:JSON.stringify(input),timeout:20000,maxBuffer:4*1024*1024});
      if (result.status!==0) {
        // Do not reflect a raw subprocess stderr, request prompt or local path.
        let reason='IMAGE_COORDINATOR_UNAVAILABLE';
        try {const detail=JSON.parse(result.stderr);if (/^[A-Z][A-Z0-9_:.-]{0,180}$/.test(detail.error || '')) reason=detail.error;} catch {}
        throw new Error(reason);
      }
      return JSON.parse(result.stdout);
    };
    const result=await imageCli(process.argv[2] || 'probe',payload,{coordinated});
    process.stdout.write(JSON.stringify(result)+'\n');
    if (result.ok===false) process.exitCode=2;
  } catch (error) {
    const code=/^[A-Z][A-Z0-9_:.-]{0,180}$/.test(error.message || '')?error.message:'IMAGE_INVALID_INPUT';
    process.stderr.write(JSON.stringify({ok:false,code,deliveryStage:'PRE_SEND'})+'\n');
    process.exitCode=2;
  }
}
