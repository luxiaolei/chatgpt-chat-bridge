// All native observations here are SYNTHETIC. No browser or image API is used.
import {createHash} from 'node:crypto';
import {normalizeImageRequest,classifyImageCapabilities,initialImageJob,applyImageEvent,imageJobKey,imageJobResult} from '../src/capabilities/image/contract.js';
import {createImageExecutionAdapter,imageExecutionPrompt,imagePromptHash} from '../src/capabilities/image/chatgpt-ego.js';
export const time = Date.parse('2026-09-30T10:00:00Z');
export const selection = {model:'Latest',effort:'Pro',raw:'Pro',verified:true};
export const clone = value => structuredClone(value);
export const digest = data => createHash('sha256').update(data).digest('hex');
export function request(patch={}) {
  return normalizeImageRequest({jobId:'offline-image',operation:'generate',caller:{kind:'chat',ref:'worker'},
    scope:{tenantId:'fixture',namespace:'images',purpose:'offline-tests-only',workgroupId:null},controllerTaskId:'offline-controller',
    route:{project:'Offline fixture',projectId:'g-p-fixture',accountAlias:'fixture',accountId:'1'.repeat(64),sessionRef:'worker',conversationId:'worker'},
    prompt:'Synthetic fixture only.',requestedModel:'Latest',requestedEffort:'Pro',
    authorizedOutput:{targetRef:'store:fixture:outputs',retentionHours:1},
    budget:{maxAttempts:2,maxOutputs:2,maxDurationMs:60000,deadlineAt:new Date(time+3600000).toISOString(),allowPaidApi:false},...patch});
}
export function grant(r=request()) {
  return {grantId:'grant-fixture',controllerTaskId:r.controllerTaskId,controllerOperationId:'op-fixture',request:r,
    expiresAt:r.budget.deadlineAt,sourceExternalizationAuthorized:true,
    capabilities:classifyImageCapabilities(r.route,{version:'SYNTHETIC-OBSERVER/v1',observedAt:new Date(time-1000).toISOString(),
      modelSelection:selection,features:Object.fromEntries(['generate','edit','refine','export'].map(k=>[k,{mode:'NATIVE',evidence:['artifact:fixture:synthetic-capability']}]))})};
}
export function snapshot(r=request(),patch={}) {
  return {route:r.route,identityVerified:true,projectVerified:true,ownership:'agent',online:true,
    conversationMode:'normal',messagesComplete:true,inputReady:true,sendAvailable:true,generating:false,composerText:'',attachments:[],
    messages:[{id:'old-user',role:'user',promptHash:'0'.repeat(64)},{id:'old-assistant',role:'assistant',parentUserId:'old-user',images:[],settled:true}],...patch};
}
export function image(patch={}) {
  return {kind:'generated',proof:'native-generated-output',createdByTurnId:'new-assistant',ownerTurnId:'new-assistant',
    renderState:'complete',thumbnail:false,placeholder:false,sourceReference:false,width:16,height:16,nativeAssetId:'fixture-asset',...patch};
}
export function generated(r=request(),attemptId='attempt-fixture',patch={}) {
  const base=snapshot(r);
  base.messages.push({id:'new-user',role:'user',promptHash:imagePromptHash(imageExecutionPrompt(r,attemptId))},
    {id:'new-assistant',role:'assistant',parentUserId:'new-user',images:[image()],settled:true});
  return {...base,...patch};
}
export function scenario({r=request(),g=grant(r),snapshotPatch={}}={}) {
  let job=initialImageJob(g,new Date(time).toISOString());
  const events=new Map(),evidence=new Map();
  const state={sends:0,fills:0,uploads:0,selects:0,lanes:0,maxLanes:0,guards:[],sent:false,text:'',attached:[],now:time,snapshotPatch};
  const api={
    submit:()=>clone(job),inspect:()=>clone(job),result:()=>imageJobResult(job),
  };
  for(const [method,type] of Object.entries({beginAttempt:'beginAttempt',record:'observation',reconcile:'reconcile',cancel:'cancel'})) {
    api[method]=(key,event)=>{
      if(events.has(event.eventId)) return {...clone(events.get(event.eventId)),...(type==='beginAttempt'?{effectAdmission:'RECONCILE_ONLY'}:{})};
      job=applyImageEvent(job,{...event,type},g,{at:new Date(state.now).toISOString()});
      events.set(event.eventId,clone(job));
      return {...clone(job),...(type==='beginAttempt'?{effectAdmission:'NEWLY_RESERVED'}:{})};
    };
  }
  const ui={
    inspect:async()=>state.sent?generated(r,job.attempts.at(-1).attemptId,state.snapshotPatch):snapshot(r,{composerText:state.text,attachments:state.attached,...state.snapshotPatch}),
    selectResources:async()=>{state.selects++;return selection;},
    upload:async()=>{state.uploads++;state.attached=[{accepted:true}];return {accepted:true};},
    fill:async text=>{state.fills++;state.text=text;},
    sendOnce:async()=>{state.sends++;state.sent=true;},
  };
  const ports={api,now:()=>state.now,
    withUi:async(route,callback)=>{state.lanes++;state.maxLanes=Math.max(state.maxLanes,state.lanes);try{return await callback(ui);}finally{state.lanes--;}},
    assertSessionAdmission:async({phase})=>{state.guards.push(phase);},
    evidenceSink:async value=>{const ref='artifact:fixture:evidence-'+digest(JSON.stringify(value));evidence.set(ref,clone(value));return ref;},
  };
  return {r,g,key:imageJobKey(r,g.grantId),ui,api,state,ports,evidence,job:()=>clone(job),setJob:value=>{job=value;},
    adapter:()=>createImageExecutionAdapter(ports),options:{grantId:g.grantId,attemptId:'attempt-fixture',eventId:'begin-fixture'}};
}
