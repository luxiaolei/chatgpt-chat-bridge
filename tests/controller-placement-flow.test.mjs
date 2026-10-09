import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,chmodSync,rmSync} from 'node:fs';
import test from 'node:test';
import '../src/task-policy.js';
// ponytail: Node 22 SQLite fixture; Node 20 runtime support remains unchanged.
let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'));}catch(error){if(error.code!=='ERR_UNKNOWN_BUILTIN_MODULE')throw error;}

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import path from 'node:path';

test('actual composer and overflow placement commit preserve SQLite state on rejection',{skip:!DatabaseSync&&'Node 22 built-in SQLite fixture required'},async()=>{
const repo=process.cwd();
const out=mkdtempSync(path.join(process.env.TMPDIR||'/tmp','bridge-controller-placement-'));
mkdirSync(out,{recursive:true,mode:0o700});chmodSync(out,0o700);
const source=readFileSync(path.join(repo,'src/main.js'),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),z=source.indexOf(end,a);assert(a>=0&&z>a);return source.slice(a,z);};
const code='const allocateManagedPage=(t)=>t.newPage(); const {composerIsEmpty}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n'+section('function managedSpacePlan','\nasync function accountManagedTask')+
 section('async function overflowManagedTask','\nasync function newManagedPage')+
 section('async function reattachTask','\nasync function observeOperation');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const stateFn=await new AsyncFunction(section('async function state(','\nfunction classifySnapshot')+';return state;')();
const normalize=await new AsyncFunction('crypto','emptyRegistry','DEFAULT_ACCOUNT','projectIdFromUrl','defaultSpaceName',section('function normalizeRegistry','\nfunction normalizeRuntime')+';return normalizeRegistry;')(
 crypto,()=>({}),'a',v=>v.match(/g-p-[^/]+/)?.[0],()=> 'chat-bridge-agent-a');
const require=createRequire(import.meta.url);require(path.join(repo,'src/session-policy.js'));
const {sameConversationUrl}=globalThis.__CHAT_BRIDGE_SESSION_POLICY__;
const sid='11111111-1111-1111-1111-111111111111',pid='g-p-'+'a'.repeat(32),url=`https://chatgpt.com/g/${pid}/c/${sid}`;
const binding={spaceName:'chat-bridge-agent-a',spaceId:2,profileId:'Profile 1',projectUrl:`https://chatgpt.com/g/${pid}/project`,controlPage:'p121'};
const chat={id:sid,project:'P',account:'a',role:'conductor',status:'active',url,page:null,spaceName:binding.spaceName,spaceId:2,attachmentEpoch:6};
const legacy={id:16,name:binding.spaceName+'-overflow',profileId:'Profile 3',ownership:'agent',createdBy:'agent'};
const overflowName=legacy.name+'-'+crypto.createHash('sha256').update(binding.profileId).digest('hex').slice(0,8);
const key='login-a|'+binding.profileId;
function fixture(name,{mapped=false}={}) {
 const dir=mkdtempSync(path.join(out,name+'-'));chmodSync(dir,0o700);
 const config=path.join(dir,'config'),stateDir=path.join(dir,'state');for(const d of [config,stateDir])mkdirSync(d,{mode:0o700});
 const dbPath=path.join(stateDir,'bridge.sqlite3'),db=new DatabaseSync(dbPath);chmodSync(dbPath,0o600);
 db.exec(`CREATE TABLE documents(kind TEXT PRIMARY KEY,payload TEXT); CREATE TABLE logical_sessions(logical_ref TEXT PRIMARY KEY,project TEXT,role TEXT,current_session_ref TEXT,workgroup_id TEXT,epoch INTEGER,state TEXT,pending_session_ref TEXT,handoff_hash TEXT,rotation_id TEXT,updated_at TEXT);CREATE TABLE operations(status TEXT,session_ref TEXT,caller_ref TEXT); CREATE TABLE control_state(scope TEXT,mode TEXT,epoch INTEGER); CREATE TABLE image_jobs(caller_ref TEXT,job_id TEXT,document TEXT); CREATE TABLE events(id TEXT,payload TEXT);`);
 const mapping={spaceName:mapped?overflowName:legacy.name,spaceId:mapped?17:16,profileId:binding.profileId,identity:'login-a',account:'a',createdAt:'old'};
 const reg={accounts:{a:{identity:'login-a'}},chats:{[sid]:structuredClone(chat),qa:{id:'qa',project:'P',account:'a',role:'qa',page:'p186',spaceId:66,spaceName:'legacy-qa',unknownDraftChars:122}},projects:{P:{rootController:'conductor',bindings:{a:structuredClone(binding)}}},spaces:{2:{identity:'login-a',profileId:binding.profileId,name:binding.spaceName,ownership:'agent'}},capacityOverflow:{[key]:mapping,'foreign|Profile 7':{sentinel:true}}};
 const rt={tasks:{old:{taskId:'old',sessionId:'retired',status:'BLOCKED',immutable:'UNKNOWN'}},sessions:{[sid]:{watchdogPausedForUserControl:true}},projects:{P:{watchdogPausedForUserControl:true}}};
 const put=(kind,payload)=>db.prepare('INSERT OR REPLACE INTO documents VALUES (?,?)').run(kind,JSON.stringify(payload));put('registry',reg);put('runtime',rt);
 db.prepare('INSERT INTO logical_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('project:P:role:conductor','P','conductor',sid,null,3,'ACTIVE',null,null,null,'fixed');
 db.prepare('INSERT INTO operations VALUES(?,?,?)').run('UNKNOWN','old','old');db.exec("INSERT INTO control_state VALUES('project:P','PAUSED',7);INSERT INTO events VALUES('old','untouched')");
 const raw=kind=>JSON.parse(db.prepare('SELECT payload FROM documents WHERE kind=?').get(kind).payload);
 const snapshot=()=>Object.fromEntries(['documents','logical_sessions','operations','control_state','image_jobs','events'].map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
 let cliEnv={...process.env};delete cliEnv.CHAT_BRIDGE_FROM_ACCOUNT_ID;delete cliEnv.CHAT_BRIDGE_FROM_SPACE;
 function cli(file,args,payload){const r=spawnSync('python3',[path.join(repo,'src',file),...args,config,stateDir,...(file==='state-store.py'?[payload.kind]:[])],{input:JSON.stringify(payload.kind?payload.value:payload),encoding:'utf8',timeout:20000,env:cliEnv});if(r.status!==0)throw Error(r.stderr.trim()||r.error?.message);return JSON.parse(r.stdout);}
 const coordinated=(command,payload)=>cli('coordinator.py',[command],payload);
 const stored=(command,kind,value)=>cli('state-store.py',[command],{kind,value});
 return {db,put,raw,snapshot,reg,rt,coordinated,stored,dir,setHost:()=>cliEnv.CHAT_BRIDGE_FROM_ACCOUNT_ID='remote'};
}

function domPage(composerText,identity='login-a',opts={}) {
 const root={matches:()=>true,contains:()=>true},form={querySelectorAll:()=>[]};const composer={innerText:opts.visualText??composerText,textContent:composerText,closest:s=>s==='form'?form:null,querySelectorAll:()=>[]};
 const message={innerText:'prior assistant reply',matches:()=>false,closest:()=>null,querySelector:()=>null,querySelectorAll:()=>[],getBoundingClientRect:()=>({width:50,height:20}),getAttribute:a=>a==='data-message-author-role'?'assistant':a==='data-message-id'?'22222222-2222-2222-2222-222222222222':null};
 const doc={body:root,title:'synthetic',visibilityState:'visible',wasDiscarded:false,querySelector:s=>s==='main'?root:s.includes('prompt-textarea')&&!opts.missingComposer?composer:s.includes('data-message-author-role')?message:null,querySelectorAll:s=>s.includes('data-message-author-role')?[message]:s.includes('prompt-textarea')?(opts.missingComposer?[]:opts.multipleComposer?[composer,composer]:[composer]):[]};
 const context=vm.createContext({document:doc,location:{origin:'https://chatgpt.com',href:url,pathname:new URL(url).pathname},navigator:{onLine:true},fetch:async()=>({ok:true,json:async()=>({user:{id:identity}})}),AbortSignal,MutationObserver:class{observe(){}disconnect(){}},getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),Node:{ELEMENT_NODE:1}});
 const evaluate=async(fn,arg)=>{context.arg=arg;const observed=await vm.runInContext('('+fn.toString()+')(arg)',context);assert.equal(composer.innerText,opts.visualText??composerText);assert.equal(composer.textContent,composerText);return observed;};
 return {label:'p7',url:async()=>url,goto:async()=>{},evaluate,waitForFunction:async fn=>assert.equal(await evaluate(fn),true)};
}
const domState=composerText=>stateFn(domPage(composerText),false,null,true);
async function runFlow(name,opts={}) {
 const f=fixture(name,opts);const reg=normalize(structuredClone(f.reg)),baselines=new WeakMap([[reg,structuredClone(f.reg)]]);
 const original=f.snapshot(),spaces=[{id:2,name:binding.spaceName,profileId:binding.profileId,ownership:'agent',createdBy:'agent'},structuredClone(legacy)];
 if(opts.mapped)spaces.push({id:17,name:overflowName,profileId:binding.profileId,ownership:'agent',createdBy:'agent'});
 if(opts.foreignProfile&&opts.mapped)spaces[2].profileId='Profile 3';
 if(opts.userOwnership&&opts.mapped)spaces[2].ownership='user';
 const calls=[];const page=domPage(opts.actualComposer??'',opts.foreignLogin?'foreign-login':'login-a',opts);page.goto=async()=>calls.push('goto');
 const taskSpace=async(target,options)=>{calls.push(['taskSpace',target,options]);let s=spaces.find(s=>s.id===target||s.name===target);if(!s){s={id:17,name:target,profileId:options.profileId,ownership:'agent',createdBy:'agent'};spaces.push(s);}return {spaceId:s.id,tabs:async()=>opts.userTab?[{url,label:'p7',openedBy:'user'}]:[],page:()=>page,newPage:async()=>{calls.push('newPage');return page;}};};
 let readCount=0;const coordinated=(cmd,payload)=>{calls.push(cmd);if(cmd==='controller-placement-context'&&++readCount===2&&opts.ownerRace){f.db.exec('UPDATE logical_sessions SET epoch=4');}return f.coordinated(cmd,payload);};
 const defaultState={composerPresent:true,composerText:'',composerCount:1,composerAttachmentsEmpty:true,composerRawText:'',generating:false,approvalRequired:false,errorTexts:[]};
 const api=await new AsyncFunction('crypto','managedSpacePlan_unused','stored','coordinated','loadRuntime','activeTaskStatus','bindingFor','assertWebAvailable','listTaskSpaces','taskSpace','taskAccounts','accountScope','stateBaselines','saveRegistry','sameConversationUrl','waitForConversationReady','projectKey','state','observeSession','emitTaskEvent','slug',code+';return reattachTask;')(
 crypto,null,f.stored,coordinated,()=>{throw Error('runtime writer forbidden')},()=>false,()=>binding,async()=>{},async()=>structuredClone(spaces),taskSpace,new Map(),(r,a)=>r.accounts[a].identity,baselines,()=>{throw Error('saveRegistry forbidden')},sameConversationUrl,()=>{throw Error('Retry readiness forbidden')},v=>v.match(/g-p-[0-9a-f]{32}/)?.[0],async()=>opts.actualComposer!==undefined?stateFn(page,false,null,true):({...defaultState,...opts.snapshot}),()=>{throw Error('observe forbidden')},()=>{throw Error('event forbidden')},v=>v);
 let response,error;try{response=await api(reg,reg.chats[sid],null,{confirm:true,currentController:true,overflow:true});}catch(e){error=e.message;}
 assert.deepEqual(spaces[1],legacy,'old Profile3 Space16 changed');
 const after=f.raw('registry'),changedMapping=JSON.stringify(after.capacityOverflow)!==JSON.stringify(f.reg.capacityOverflow);
 const attached=after.chats[sid].page!==null;const preserved=f.snapshot();
 for(const table of ['operations','control_state','image_jobs','events'])assert.deepEqual(preserved[table],original[table],table);
 assert.deepEqual(f.raw('runtime'),f.rt);assert.deepEqual(after.chats.qa,f.reg.chats.qa);assert.deepEqual(after.projects,f.reg.projects);
 const expected=structuredClone(f.reg);expected.capacityOverflow[key]=after.capacityOverflow[key];
 if(attached)Object.assign(expected.chats[sid],{spaceName:overflowName,spaceId:17,pageSpaceId:17,profileId:binding.profileId,page:'p7',attachmentEpoch:7});
 assert.deepEqual(after,expected,'registry changed outside the mapping/attachment scopes');
 if(!opts.ownerRace)assert.deepEqual(preserved.logical_sessions,original.logical_sessions);
 if(opts.expectError){assert(error?.includes(opts.expectError),name+': '+error);assert(!attached);assert(!changedMapping,'failure persisted overflow mapping');}
 else{assert(!error,name+': '+error);assert(attached);assert.equal(after.chats[sid].attachmentEpoch,7);assert.equal(response.messageSent,false);assert.equal(after.chats[sid].spaceId,17);}
 f.db.close();
}
try {
 await runFlow('empty',{actualComposer:''});
 await runFlow('empty-document-visual-newline',{actualComposer:'',visualText:'\n'});
 await runFlow('whitespace-draft',{actualComposer:' \n\t',expectError:'UNHEALTHY_OR_DRAFT'});
 await runFlow('foreign-login',{actualComposer:'',foreignLogin:true,expectError:'LOGIN_MISMATCH'});
 await runFlow('nonempty-draft',{actualComposer:'unknown draft',expectError:'UNHEALTHY_OR_DRAFT'});
 await runFlow('missing-composer',{actualComposer:'',missingComposer:true,expectError:'UNHEALTHY_OR_DRAFT'});
 await runFlow('multiple-composers',{actualComposer:'',multipleComposer:true,expectError:'UNHEALTHY_OR_DRAFT'});
} finally {rmSync(out,{recursive:true,force:true});}
});
