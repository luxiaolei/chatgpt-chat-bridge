const fs = await import("node:fs/promises");
const os = await import("node:os");
const pathMod = await import("node:path");
const crypto = await import("node:crypto");
const childProcess = await import("node:child_process");
const args = globalThis.__CHAT_BRIDGE_ARGS__ || [];
const HOME = os.homedir();
const CONFIG_DIR = globalThis.__CHAT_BRIDGE_CONFIG_DIR__ || process.env.CHAT_BRIDGE_CONFIG_DIR || pathMod.join(HOME, ".config", "chat-bridge");
const STATE_DIR = globalThis.__CHAT_BRIDGE_STATE_DIR__ || process.env.CHAT_BRIDGE_STATE_DIR || pathMod.join(HOME, ".local", "state", "chat-bridge");
const REG_PATH = pathMod.join(CONFIG_DIR, "registry.json");
const RUNTIME_PATH = pathMod.join(STATE_DIR, "runtime.json");
const STORE_PATH = globalThis.__CHAT_BRIDGE_STORE_PATH__;
const COORDINATOR_PATH = globalThis.__CHAT_BRIDGE_COORDINATOR_PATH__;
const stateBaselines = new WeakMap();
function stored(command, kind, payload=null) {
  if(!STORE_PATH) throw new Error("state-store.py is required; reinstall ChatBridge");
  const result=childProcess.spawnSync("python3",[STORE_PATH,command,CONFIG_DIR,STATE_DIR,kind],{
    encoding:"utf8",input:payload?JSON.stringify(payload):undefined,maxBuffer:32*1024*1024,timeout:20000
  });
  if(result.status!==0) throw new Error(`STATE_STORE_${kind.toUpperCase()}: ${(result.stderr||result.error?.message||"unknown error").trim()}`);
  return JSON.parse(result.stdout);
}
function coordinated(command, payload) {
  if(!COORDINATOR_PATH) throw new Error("coordinator.py is required; reinstall ChatBridge");
  const result=childProcess.spawnSync("python3",[COORDINATOR_PATH,command,CONFIG_DIR,STATE_DIR],{
    encoding:"utf8",input:JSON.stringify(payload),maxBuffer:4*1024*1024
  });
  if(result.status!==0) throw new Error(`COORDINATOR_${command.toUpperCase()}: ${(result.stderr||result.error?.message||"unknown error").trim()}`);
  return JSON.parse(result.stdout);
}
const DEFAULT_ACCOUNT = "default";
const CONTROL = globalThis.__CHAT_BRIDGE_CONTROL__;
if(!CONTROL) throw new Error("chat-bridge control routing module was not loaded");
const { controlRoute, notificationTargets, resolveControllerTarget } = CONTROL;
const PAGE_POOL = globalThis.__CHAT_BRIDGE_PAGE_POOL__;
if(!PAGE_POOL) throw new Error("chat-bridge page pool module was not loaded");
const { pageDetachCandidates, orphanManagedPageCandidates } = PAGE_POOL;
const LIVENESS = globalThis.__CHAT_BRIDGE_LIVENESS__;
if(!LIVENESS) throw new Error("chat-bridge liveness policy module was not loaded");
const { stallThresholdSec } = LIVENESS;
const TASK_POLICY = globalThis.__CHAT_BRIDGE_TASK_POLICY__;
if(!TASK_POLICY) throw new Error("chat-bridge task policy module was not loaded");
const { activeTaskStatus, normalizeCompletionMode, assertTaskId, assertActiveTaskTarget, activeSessionConflict, assertComposerSafe, isPreSendDefer } = TASK_POLICY;
const LIFECYCLE_POLICY = globalThis.__CHAT_BRIDGE_LIFECYCLE_POLICY__ || {
  normalizeLifecycle(project={}) {
    return {autoReconcile:false,reconcileRole:project.rootController||"conductor",minGapSec:300,instruction:null};
  },
  reconcileCandidate() { return null; },
};
const { normalizeLifecycle, reconcileCandidate } = LIFECYCLE_POLICY;
const WEB_POLICY = globalThis.__CHAT_BRIDGE_WEB_POLICY__;
if(!WEB_POLICY) throw new Error("chat-bridge web policy module was not loaded");
const { findRateLimitText, nextCooldown } = WEB_POLICY;
const MODEL_POLICY=globalThis.__CHAT_BRIDGE_MODEL_POLICY__;
if(!MODEL_POLICY) throw new Error("chat-bridge model policy module was not loaded");
const {modelPreset,observedModel,selectModelLabel}=MODEL_POLICY;
const SESSION_POLICY=globalThis.__CHAT_BRIDGE_SESSION_POLICY__;
if(!SESSION_POLICY) throw new Error("chat-bridge session policy module was not loaded");
const {recoveryRequired,contextExhausted}=SESSION_POLICY;
const EVENT_JOURNAL=globalThis.__CHAT_BRIDGE_EVENTS__ || {appendEvent:async()=>null,listEvents:async()=>[]};
const {appendEvent,listEvents}=EVENT_JOURNAL;
const SPACE_CATALOG=globalThis.__CHAT_BRIDGE_SPACE_CATALOG__;
const TOPOLOGY=globalThis.__CHAT_BRIDGE_TOPOLOGY__;
const WEB_COOLDOWN_PATH = pathMod.join(STATE_DIR, "web-cooldown.json");
const taskAccounts=new Map();
const COMPOSER_SELECTOR = 'div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]';

function accountScope(reg, account) {
  const identity=reg.accounts?.[account]?.identity;
  return crypto.createHash("sha256").update(identity?`identity:${identity}`:`alias:${account}`).digest("hex");
}
function cooldownPath(reg, account) {
  return pathMod.join(STATE_DIR,"web-cooldowns",accountScope(reg,account)+".json");
}
function cooldownError(value, account) {
  const error=new Error(`WEB_RATE_LIMITED account=${account} until=${value.until}`);
  error.code="WEB_RATE_LIMITED"; error.account=account;
  return error;
}
async function assertWebAvailable(account) {
  const value=await loadWebCooldown(account);
  if(Date.parse(value.until)>Date.now()) throw cooldownError(value,account);
}

function slug(v="") {
  return String(v).trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") || "project";
}
function projectIdFromUrl(v="") {
  return String(v).match(/\/g\/(g-p-[^/]+)/)?.[1] || null;
}
function defaultSpaceName(project, account=DEFAULT_ACCOUNT) {
  return `chat-bridge-project-${slug(project)}-${slug(account)}`;
}
function emptyRegistry() {
  return { version: 2, defaultProject: null, defaultAccount: DEFAULT_ACCOUNT, accounts: {}, projects: {}, chats: {}, spaces: {} };
}
function normalizeRegistry(raw) {
  const reg={...emptyRegistry(),...(raw||{})};
  reg.accounts ||= {}; reg.projects ||= {}; reg.chats ||= {}; reg.spaces ||= {};
  reg.defaultAccount ||= DEFAULT_ACCOUNT;
  reg.accounts[reg.defaultAccount] ||= {name:reg.defaultAccount};
  for (const [name,p0] of Object.entries(reg.projects)) {
    const p=p0||{}; p.name ||= name; p.activeAccount ||= reg.defaultAccount; p.rootController ||= "conductor"; p.bindings ||= {}; p.lifecycle ||= {};
    p.businessProjectId ||= crypto.createHash("sha256").update(`business-project:${name}`).digest("hex").slice(0,20);
    p.workgroups ||= {};
    const oldUrl=p.url||null, oldBase=p.projectBase||null;
    if (!p.bindings[p.activeAccount] && (oldUrl||oldBase)) {
      p.bindings[p.activeAccount]={account:p.activeAccount,projectUrl:oldUrl,projectBase:oldBase,
        projectId:projectIdFromUrl(oldUrl||oldBase),spaceName:defaultSpaceName(name,p.activeAccount),spaceId:null,controlPage:null};
    }
    reg.projects[name]=p;
  }
  for (const c of Object.values(reg.chats)) {
    c.account ||= reg.projects[c.project]?.activeAccount || reg.defaultAccount;
    c.role ||= c.name || c.title || c.id; c.status ||= "active";
    const b=reg.projects[c.project]?.bindings?.[c.account];
    const targetSpace=b?.spaceName || defaultSpaceName(c.project||"default",c.account);
    const moved=!c.spaceName || c.spaceName!==targetSpace || (b?.spaceId!=null && c.spaceId!=null && Number(c.spaceId)!==Number(b.spaceId));
    if(moved){
      if(c.legacySpaceId==null && c.spaceId!=null) c.legacySpaceId=c.spaceId;
      c.spaceName=targetSpace; c.spaceId=b?.spaceId??null; c.page=null;
    }
  }
  reg.version=2; return reg;
}
function normalizeRuntime(raw) {
  const rt={version:2,projects:{},tasks:{},sessions:{},...(raw||{})};
  rt.projects ||= {}; rt.tasks ||= {}; rt.sessions ||= {}; rt.version=2;
  return rt;
}
async function loadRuntime() {
  const runtime=normalizeRuntime(stored("get","runtime"));
  stateBaselines.set(runtime,structuredClone(runtime));
  return runtime;
}
async function saveRuntime(runtime) {
  const next=normalizeRuntime(runtime),base=stateBaselines.get(runtime);
  if(!base) throw new Error("runtime state must be loaded before save");
  stored("put","runtime",{base,next});
  stateBaselines.set(runtime,structuredClone(next));
}
async function touchRuntime(project, patch={}) {
  const rt=await loadRuntime();
  if(project) rt.projects[project]={...(rt.projects[project]||{}),...patch,updatedAt:new Date().toISOString()};
  await saveRuntime(rt); return rt;
}

async function emitTaskEvent(task, type, data={}) {
  if(!task?.project) return null;
  const account=task.account||DEFAULT_ACCOUNT;
  return appendEvent(STATE_DIR,{
    project:task.project,account,type,taskId:task.taskId||null,role:task.role||null,
    sessionId:task.sessionId||null,controller:task.controller||null,replyTo:task.replyTo||null,
    escalationTo:task.escalationTo||null,rootController:task.rootController||null,data,
  });
}

async function loadWebCooldown(account) {
  const paths=[cooldownPath(reg,account)];
  if(accountScope(reg,account)===accountScope(reg,reg.defaultAccount||DEFAULT_ACCOUNT)) paths.push(WEB_COOLDOWN_PATH);
  const rows=[];
  for(const file of paths){
    try { rows.push(JSON.parse(await fs.readFile(file,"utf8"))); }
    catch(error){ if(error.code!=="ENOENT") throw error; }
  }
  return rows.sort((a,b)=>String(b.until||"").localeCompare(String(a.until||"")))[0]||{};
}
async function saveWebCooldown(value, account) {
  const file=cooldownPath(reg,account), tmp=file+`.${process.pid}.tmp`;
  await fs.mkdir(pathMod.dirname(file),{recursive:true});
  await fs.writeFile(tmp,JSON.stringify({...value,account,scope:accountScope(reg,account)},null,2)+"\n");
  await fs.rename(tmp,file);
  return value;
}
async function rateLimitSnapshot(page,{dismiss=false}={}) {
  return await page.evaluate(({dismiss}) => {
    const visible=node=>{
      if(!node) return false;
      const style=getComputedStyle(node);
      return style.display!=="none" && style.visibility!=="hidden" && style.opacity!=="0" && node.getClientRects().length>0;
    };
    const dialogs=[...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [data-state="open"]')]
      .filter(visible);
    const rateDialogs=dialogs.filter(node=>/Too many requests|temporarily limited access to your conversations|Please wait a few minutes/i.test(node.innerText||node.textContent||""));
    let dismissed=0;
    if(dismiss && rateDialogs.length){
      const seen=new Set();
      for(const dialog of rateDialogs){
        const button=[...dialog.querySelectorAll("button")].find(b=>{
          if(seen.has(b) || b.disabled || b.getAttribute("aria-disabled")==="true") return false;
          const label=(b.innerText||b.getAttribute("aria-label")||"").trim();
          return /^got it$/i.test(label);
        });
        if(button){
          seen.add(button);
          button.click();
          dismissed=1;
          break;
        }
      }
    }
    const texts=rateDialogs.map(n=>(n.innerText||n.textContent||"").trim()).filter(Boolean);
    const body=document.body ? document.body.cloneNode(true) : null;
    body?.querySelectorAll('[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key], [role="dialog"], [role="alertdialog"], [role="alert"], [data-state="open"], script, style, template').forEach(node=>node.remove());
    const bodyText=(body?.textContent||"").trim();
    return {candidates:bodyText ? [...texts,bodyText] : texts,dismissed};
  }).catch(()=>({candidates:[],dismissed:0}));
}
async function detectWebRateLimit(page, context="ui") {
  const account=taskAccounts.get(Number(page.spaceId));
  if(!account) throw new Error("Page has no bound ChatGPT account");
  await assertWebAvailable(account);
  let snapshot=await rateLimitSnapshot(page,{dismiss:true});
  let detail=findRateLimitText(snapshot.candidates);
  if(!detail) return null;
  if(snapshot.dismissed){
    if(typeof page.waitForTimeout==="function") await page.waitForTimeout(300);
    snapshot=await rateLimitSnapshot(page,{dismiss:false});
    detail=findRateLimitText(snapshot.candidates);
    if(!detail) return {recovered:true,dismissed:true};
  }
  const next=nextCooldown(await loadWebCooldown(account),Date.now(),context,detail.slice(0,500));
  await saveWebCooldown(next,account);
  throw cooldownError(next,account);
}

async function loadRegistry() {
  const registry=normalizeRegistry(stored("get","registry"));
  stateBaselines.set(registry,structuredClone(registry));
  return registry;
}
async function saveRegistry(reg) {
  const next=normalizeRegistry(reg),base=stateBaselines.get(reg);
  if(!base) throw new Error("registry state must be loaded before save");
  stored("put","registry",{base,next});
  stateBaselines.set(reg,structuredClone(next));
}
function opt(name, def=null) {
  const i=args.indexOf("--"+name); return i>=0 ? args[i+1] : def;
}
function boolValue(value, def=false) {
  if(value==null) return def;
  const text=String(value).trim().toLowerCase();
  if(["1","true","yes","on"].includes(text)) return true;
  if(["0","false","no","off"].includes(text)) return false;
  throw new Error(`invalid boolean: ${value}`);
}
function positionals(start=0) {
  const out=[];
  for (let i=start;i<args.length;i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}
function convId(v="") {
  const m=String(v).match(/\/c\/([0-9a-f-]{20,})/i); return m ? m[1] : v;
}
function urlFor(id){ return "https://chatgpt.com/c/" + id; }
function print(v){ console.log(typeof v==="string" ? v : JSON.stringify(v,null,2)); }

function projectRecord(reg, project) {
  if(!project) throw new Error("project required");
  reg.projects[project] ||= {name:project,activeAccount:reg.defaultAccount||DEFAULT_ACCOUNT,rootController:"conductor",bindings:{},lifecycle:{}};
  const p=reg.projects[project]; p.activeAccount ||= reg.defaultAccount||DEFAULT_ACCOUNT; p.rootController ||= "conductor"; p.bindings ||= {}; p.lifecycle ||= {}; return p;
}
function activeAccount(reg, project, explicit=null) {
  return explicit || projectRecord(reg,project).activeAccount || reg.defaultAccount || DEFAULT_ACCOUNT;
}
function bindingFor(reg, project, account=null, create=true) {
  const p=projectRecord(reg,project), a=account||p.activeAccount||reg.defaultAccount||DEFAULT_ACCOUNT;
  reg.accounts[a] ||= {name:a};
  if(create && !p.bindings[a]) p.bindings[a]={account:a,projectUrl:null,projectBase:null,projectId:null,
    spaceName:defaultSpaceName(project,a),spaceId:null,controlPage:null};
  const b=p.bindings[a]; if(b){ b.account=a; b.spaceName ||= defaultSpaceName(project,a); } return b;
}
function resolveChat(reg, key, project=null, account=null, includeInactive=false) {
  key=convId(key);
  if(reg.chats[key] && reg.chats[key].status!=="deleted" && (includeInactive || reg.chats[key].status==="active")) {
    const chat=reg.chats[key];
    if((project&&chat.project!==project)||(account&&chat.account!==account)) throw new Error("Session does not match requested project/account");
    return chat;
  }
  const a=project ? activeAccount(reg,project,account) : account;
  const matches=Object.values(reg.chats).filter(c =>
    (!project || c.project===project) && (!a || c.account===a) && c.status!=="deleted" &&
    (includeInactive || c.status==="active") &&
    (c.name===key || c.role===key || c.alias===key || c.title===key || c.url===key));
  if(matches.length===1) return matches[0];
  if(!matches.length) throw new Error("Unknown active chat: "+key);
  throw new Error("Ambiguous chat: "+key);
}
async function pagesOf(task) { try { return await task.pages(); } catch { return []; } }
function bindingObserved(reg, account, binding) {
  const identity=reg.accounts?.[account]?.identity;
  const observed=Object.values(reg.spaces||{}).filter(space=>space.identity===identity)
    .flatMap(space=>space.projects||[]).map(project=>project.id);
  if(!observed.length) return true;
  const projectId=binding?.projectId||projectIdFromUrl(binding?.projectUrl||"");
  const canonical=value=>String(value||"").match(/g-p-[0-9a-f]{32}/)?.[0]||null;
  return canonical(projectId) && observed.some(value=>canonical(value)===canonical(projectId));
}
function bindingExecutionReadiness(project, binding) {
  const requirements=project?.requirements||{};
  const contextVersion=String(requirements.contextVersion||"").trim();
  const requiredTools=new Set(requirements.tools||[]);
  if(!contextVersion && !requiredTools.size) return {ready:true,missing:[]};
  const readiness=binding?.readiness||{}, missing=[];
  if(contextVersion && String(readiness.contextVersion||"")!==contextVersion) missing.push("contextVersion");
  const tools=new Set(readiness.tools||[]);
  for(const tool of requiredTools) if(!tools.has(tool)) missing.push("tool:"+tool);
  if(!readiness.attestedAt) missing.push("attestation");
  return {ready:missing.length===0,missing,requirements,readiness};
}

async function openBoundTask(reg, project, account=null, options={}) {
  const b=bindingFor(reg,project,account,true);
  if(!bindingObserved(reg,b.account,b)) throw new Error(`PROJECT_NOT_OBSERVED_FOR_LOGIN: ${project} / ${b.account}; scan and bind the actual Project before UI work`);
  await assertWebAvailable(b.account);
  let profileId=b.profileId||null, existingSpace=false;
  if(typeof listTaskSpaces==="function") {
    const identity=reg.accounts?.[b.account]?.identity;
    const accountName=Object.values(reg.spaces||{}).find(space=>space.identity===identity&&space.accountName)?.accountName||reg.accounts?.[b.account]?.label||b.account;
    const selected=SPACE_CATALOG.selectManagedSpace(b,accountName,await listTaskSpaces(),{pauseOnUserControl:!!options.pauseOnUserControl});
    profileId=selected.profileId;
    existingSpace=selected.existing;
    if(selected.changed) { b.spaceName=selected.spaceName; b.spaceId=null; b.controlPage=null; }
    if(selected.changed || b.profileId!==profileId) { b.profileId=profileId; await saveRegistry(reg); }
  }
  const task=await taskSpace(b.spaceName,!existingSpace&&profileId?{profileId}:undefined);
  const prior=taskAccounts.get(Number(task.spaceId));
  if(prior&&accountScope(reg,prior)!==accountScope(reg,b.account)) throw new Error("Space is bound to conflicting ChatGPT accounts");
  taskAccounts.set(Number(task.spaceId),b.account);
  if(Number(b.spaceId)!==Number(task.spaceId)){ b.spaceId=task.spaceId; await saveRegistry(reg); }
  return {binding:b,task};
}
function samePhysicalSpace(record, binding, task) {
  if(!record) return false;
  if(record.spaceName && binding.spaceName && record.spaceName===binding.spaceName) return true;
  if(record.spaceId!=null && task?.spaceId!=null && Number(record.spaceId)===Number(task.spaceId)) return true;
  return false;
}

function projectBindingForTask(reg, taskRecord) {
  const project=reg.projects?.[taskRecord?.project];
  if(!project) return null;
  const chat=taskRecord?.sessionId?reg.chats?.[taskRecord.sessionId]:null;
  const account=taskRecord?.account||chat?.account||project.activeAccount||reg.defaultAccount;
  return project.bindings?.[account]||null;
}

function spaceProtection(reg, runtime, binding, task) {
  const labels=new Set();
  const protectedChatIds=new Set();
  for(const project of Object.values(reg.projects||{})) {
    for(const candidate of Object.values(project.bindings||{})) {
      if(samePhysicalSpace(candidate,binding,task) && candidate?.controlPage) labels.add(candidate.controlPage);
    }
  }
  for(const chat of Object.values(reg.chats||{})) {
    if(!samePhysicalSpace(chat,binding,task)) continue;
    if(chat.status==="active" && chat.page) {
      labels.add(chat.page);
      protectedChatIds.add(chat.id);
    }
  }
  for(const live of Object.values(runtime.tasks||{})) {
    if(!activeTaskStatus(live.status)) continue;
    const chat=live.sessionId?reg.chats?.[live.sessionId]:null;
    const liveBinding=projectBindingForTask(reg,live);
    if(chat && samePhysicalSpace(chat,binding,task)) {
      if(chat.page) labels.add(chat.page);
      protectedChatIds.add(chat.id);
    } else if(liveBinding && samePhysicalSpace(liveBinding,binding,task)) {
      for(const candidate of Object.values(reg.chats||{})) {
        if(candidate.project===live.project && candidate.role===live.role && samePhysicalSpace(candidate,binding,task) && candidate.page) {
          labels.add(candidate.page);
          protectedChatIds.add(candidate.id);
        }
      }
    }
  }
  return {labels,protectedChatIds};
}

async function reclaimIdlePageSlot(reg, project, account, task, binding, excludeChatId=null) {
  const rt=await loadRuntime();
  const tabs=await task.tabs().catch(()=>[]);
  const activeLabels=tabs.filter(t=>t.active&&t.label).map(t=>t.label);
  const protection=spaceProtection(reg,rt,binding,task);
  for(const label of activeLabels) protection.labels.add(label);
  const chats=Object.values(reg.chats||{}).filter(chat=>samePhysicalSpace(chat,binding,task));
  const candidates=pageDetachCandidates(
    chats,
    Object.values(rt.tasks||{}),
    {
      excludeChatIds:[...protection.protectedChatIds,...(excludeChatId?[excludeChatId]:[])],
      excludePageLabels:[...protection.labels],
    }
  );
  for(const candidate of candidates) {
    let page=null;
    try { page=task.page(candidate.page); }
    catch {
      candidate.page=null;
      candidate.detachedAt=new Date().toISOString();
      candidate.attachmentEpoch=Number(candidate.attachmentEpoch||0)+1;
      await saveRegistry(reg);
      continue;
    }
    const tab=tabs.find(item=>item.label===candidate.page);
    if(!tab || tab.active || tab.openedBy!=="agent") continue;
    const snapshot=await state(page).catch(()=>null);
    if(!snapshot || snapshot.generating || String(snapshot.composerText||"").trim()) continue;
    const oldPage=candidate.page;
    try { await page.close(); }
    catch { continue; }
    candidate.page=null;
    candidate.detachedAt=new Date().toISOString();
    candidate.attachmentEpoch=Number(candidate.attachmentEpoch||0)+1;
    await saveRegistry(reg);
    return {chatId:candidate.id,role:candidate.role,page:oldPage};
  }
  return null;
}

async function reclaimOrphanManagedPage(reg, task, binding) {
  const rt=await loadRuntime();
  const liveTasks=Object.values(rt.tasks||{}).filter(item=>activeTaskStatus(item.status));
  const hasLiveTasks=liveTasks.some(item=>{
    const chat=item.sessionId?reg.chats?.[item.sessionId]:null;
    if(chat?.spaceName===binding.spaceName || (chat?.spaceId!=null && Number(chat.spaceId)===Number(task.spaceId))) return true;
    const project=reg.projects?.[item.project];
    const account=item.account||chat?.account||project?.activeAccount||reg.defaultAccount;
    const taskBinding=project?.bindings?.[account];
    return taskBinding?.spaceName===binding.spaceName ||
      (taskBinding?.spaceId!=null && Number(taskBinding.spaceId)===Number(task.spaceId));
  });
  if(hasLiveTasks) return null;

  const protectedPages=new Set();
  for(const project of Object.values(reg.projects||{})) {
    for(const candidateBinding of Object.values(project.bindings||{})) {
      const sameSpace=candidateBinding?.spaceName===binding.spaceName ||
        (candidateBinding?.spaceId!=null && Number(candidateBinding.spaceId)===Number(task.spaceId));
      if(sameSpace && candidateBinding?.controlPage) protectedPages.add(candidateBinding.controlPage);
    }
  }
  for(const chat of Object.values(reg.chats||{})) {
    const sameSpace=chat?.spaceName===binding.spaceName ||
      (chat?.spaceId!=null && Number(chat.spaceId)===Number(task.spaceId));
    if(sameSpace && chat?.page) protectedPages.add(chat.page);
  }

  const pages=await task.pages().catch(()=>[]);
  const tabs=await task.tabs().catch(()=>[]);
  const candidates=orphanManagedPageCandidates(pages,tabs,{
    hasLiveTasks:false,
    protectedPageLabels:[...protectedPages],
  });
  for(const page of candidates) {
    try {
      await page.close();
      return {page:page.label,reason:"orphan-managed"};
    } catch {}
  }
  return null;
}

async function newManagedPage(reg, project, account, task, binding, excludeChatId=null) {
  try { return await task.newPage(); }
  catch(error) {
    if(!/page budget reached/i.test(String(error?.message||error))) throw error;
    const reclaimed=await reclaimIdlePageSlot(reg,project,account,task,binding,excludeChatId) ||
      await reclaimOrphanManagedPage(reg,task,binding);
    if(!reclaimed) throw new Error(`Page budget reached in space "${binding.spaceName}" and no idle session page is safely reclaimable`);
    return await task.newPage();
  }
}

async function controlPage(reg, project, account=null) {
  const {binding,task}=await openBoundTask(reg,project,account), pages=await pagesOf(task);
  let page=pages.find(p=>p.label===binding.controlPage) || null;
  if(!page){
    for(const p of pages){ const u=await p.url().catch(()=>""); if(u==="about:blank" || u==="chrome://newtab/"){ page=p; break; } }
  }
  if(!page) page=await newManagedPage(reg,project,account,task,binding,null);
  binding.controlPage=page.label; await saveRegistry(reg); return {binding,task,page};
}
async function accountPage(reg, account, project=null) {
  const names=(project?[project]:Object.keys(reg.projects)).filter(p=>reg.projects[p]?.bindings?.[account]);
  if(!names.length) throw new Error("Bind an existing Space for this account first");
  for(const name of names) {
    const {task}=await openBoundTask(reg,name,account);
    for(const page of await pagesOf(task)) {
      if((await page.url()).startsWith("https://chatgpt.com/")) return page;
    }
  }
  throw new Error("Open a managed ChatGPT page in the bound Space first");
}
async function waitForConversationReady(page, timeout=15000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    await detectWebRateLimit(page,"conversation-ready");
    const ok=await page.waitForSelector(COMPOSER_SELECTOR,{state:"visible",timeout:1000})
      .then(()=>true).catch(()=>false);
    if(ok) return true;
  }
  await detectWebRateLimit(page,"conversation-ready-timeout");
  throw new Error("Conversation UI did not become ready before timeout");
}

async function waitForProjectReady(page, projectName, timeout=15000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline) {
    await detectWebRateLimit(page,"project-ready");
    const ready=await page.evaluate((projectName)=>{
      const composer=!!document.querySelector('div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]');
      const loading=/Loading project/i.test(document.body?.innerText||"");
      const title=(document.title||"").toLowerCase();
      return composer && !loading && title.includes(String(projectName||"").toLowerCase());
    },projectName).catch(()=>false);
    if(ready) return true;
    await page.waitForTimeout(250);
  }
  await detectWebRateLimit(page,"project-ready-timeout");
  throw new Error("Project UI did not become ready before timeout: "+projectName);
}

async function openConversationFromProject(page, binding, projectName, chatId) {
  if(!binding?.projectUrl) return false;
  await page.goto(binding.projectUrl,{waitUntil:"load",timeout:20000});
  await waitForProjectReady(page,projectName,15000);
  const marked=await page.evaluate((chatId)=>{
    document.querySelectorAll("[data-chat-bridge-conversation-target]").forEach(e=>e.removeAttribute("data-chat-bridge-conversation-target"));
    const link=[...document.querySelectorAll('a[href*="/c/"]')].find(a=>String(a.href||"").includes("/c/"+chatId));
    if(!link) return false;
    link.setAttribute("data-chat-bridge-conversation-target","1");
    return true;
  },chatId);
  if(!marked) return false;
  try {
    await page.focus('a[data-chat-bridge-conversation-target="1"]');
    await page.keyboard.press("Enter");
  } catch {
    return false;
  }
  try {
    await page.waitForFunction((chatId)=>location.pathname.includes("/c/"+chatId),chatId,{timeout:12000});
    await waitForConversationReady(page,12000);
  } catch {
    return false;
  }
  return (await page.url()).includes("/c/"+chatId);
}

async function ensurePage(reg, chat, options={}) {
  const {binding,task}=await openBoundTask(reg,chat.project,chat.account,options), pages=await pagesOf(task);
  let page=pages.find(p=>p.label===chat.page) || null;
  if(!page) page=await newManagedPage(reg,chat.project,chat.account,task,binding,chat.id);
  chat.spaceName=binding.spaceName; chat.spaceId=task.spaceId; chat.lastUsedAt=new Date().toISOString();
  let attached=false;
  try {
    if((await page.url())!==chat.url) await page.goto(chat.url,{waitUntil:"load",timeout:20000});
    await waitForConversationReady(page,12000);
    attached=(await page.url()).includes("/c/"+chat.id);
  } catch {}
  if(!attached) attached=await openConversationFromProject(page,binding,chat.project,chat.id);
  if(!attached) {
    chat.page=null;
    chat.detachedAt=new Date().toISOString();
    await saveRegistry(reg);
    throw new Error("CONVERSATION_REATTACH_FAILED: "+chat.role+" ("+chat.id+")");
  }
  if(chat.page!==page.label || Number(chat.spaceId)!==Number(task.spaceId)) chat.attachmentEpoch=Number(chat.attachmentEpoch||0)+1;
  chat.page=page.label; chat.spaceId=task.spaceId; chat.pageSpaceId=task.spaceId;
  await saveRegistry(reg); return {task,page,binding};
}

function hashText(v="") {
  let h=2166136261;
  for(const ch of String(v)) { h^=ch.charCodeAt(0); h=Math.imul(h,16777619); }
  return (h>>>0).toString(16).padStart(8,"0");
}

async function state(page, includeUserMessages=false) {
  return await page.evaluate((includeUserMessages) => {
    const root=document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    const messageSelector='[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key]';
    if(!globalThis.__CHAT_BRIDGE_WATCH || globalThis.__CHAT_BRIDGE_WATCH.root!==root) {
      try { globalThis.__CHAT_BRIDGE_WATCH?.observer?.disconnect?.(); } catch {}
      const watch={root,seq:0,lastMutationAt:Date.now(),startedAt:Date.now(),observer:null};
      watch.observer=new MutationObserver((records)=>{
        let meaningful=false;
        for(const r of records) {
          const t=r.target?.nodeType===Node.ELEMENT_NODE?r.target:r.target?.parentElement;
          if(t?.closest?.(messageSelector) || t?.closest?.('[role="alert"], [data-testid*="error" i]') ||
             t?.matches?.('button[data-testid="send-button"], button[data-testid*="stop" i]')) { meaningful=true; break; }
        }
        if(meaningful){ watch.seq+=1; watch.lastMutationAt=Date.now(); }
      });
      try { watch.observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,
        attributeFilter:["aria-label","aria-disabled","disabled","data-testid","data-state","data-content-search-unit-key","data-chatgpt-search-message-ids"]}); } catch {}
      globalThis.__CHAT_BRIDGE_WATCH=watch;
    }
    const legacy=[...document.querySelectorAll('[data-message-author-role]')].map(e=>({
      role:e.getAttribute('data-message-author-role'), id:e.getAttribute('data-message-id')||null, text:(e.innerText||'').trim()
    }));
    let ms=legacy;
    if(!ms.length) {
      const richUnits=[...document.querySelectorAll(
        '[data-chatgpt-search-unit-key$=":user"], [data-chatgpt-search-unit-key$=":assistant"]'
      )];
      const units=richUnits.length?richUnits:[...document.querySelectorAll(
        '[data-content-search-unit-key$=":user"], [data-content-search-unit-key$=":assistant"]'
      )];
      const seen=new Set();
      ms=[];
      for(const unit of units) {
        const key=unit.getAttribute('data-chatgpt-search-unit-key')||unit.getAttribute('data-content-search-unit-key')||'';
        const role=/:assistant$/.test(key)?'assistant':/:user$/.test(key)?'user':null;
        if(!role) continue;
        const ids=(unit.getAttribute('data-chatgpt-search-message-ids')||'').trim().split(/\s+/).filter(Boolean);
        const selected=unit.querySelector('[data-chatgpt-selection-message-id]')?.getAttribute('data-chatgpt-selection-message-id')||null;
        const id=ids[0]||selected||null;
        const dedupe=id?(role+':'+id):(role+':'+key);
        if(seen.has(dedupe)) continue;
        seen.add(dedupe);
        const content=role==='user'
          ? (unit.querySelector('[data-user-message-bubble="true"]')||unit)
          : (unit.querySelector('[data-markdown-text-style="assistant-message"]')||unit.querySelector('[data-chatgpt-selection-message-id]')||unit);
        let text=(content.innerText||content.textContent||'').trim();
        text=text.replace(/^(?:You said:|ChatGPT said:)\s*/i,'').trim();
        ms.push({role,id,text});
      }
    }
    const buttons=[...document.querySelectorAll('button')];
    const norm=b=>((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('data-testid')||'')+' '+(b.innerText||'')).trim();
    const stop=buttons.find(b=>/\bstop\b/i.test(norm(b)) || /stop/i.test(b.getAttribute('data-testid')||''));
    const send=buttons.find(b=>b.getAttribute('data-testid')==='send-button' || /\bsend\b/i.test(norm(b)));
    const recoveryWords=["continue generating","try again","retry","regenerate"];
    const recoveryControls=buttons.map(b=>({label:norm(b),disabled:!!b.disabled||b.getAttribute('aria-disabled')==='true'}))
      .filter(x=>!x.disabled && recoveryWords.some(k=>x.label.toLowerCase().includes(k)));
    const alerts=[...document.querySelectorAll('[role="alert"], [data-testid*="error" i]')]
      .map(x=>(x.innerText||'').trim()).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(-8);
    const errorWords=["something went wrong","error generating","network error","unable to load conversation","try again later",
      "context too long","maximum context length","conversation is too long","maximum length for this conversation","reached the maximum"];
    const knownErrors=[...document.querySelectorAll('main div, main span, main p, [role="main"] div, [role="main"] span, [role="main"] p')]
      .filter(x=>!x.closest(messageSelector)).map(x=>(x.innerText||'').trim()).filter(v=>v && v.length<300)
      .filter(v=>errorWords.some(k=>v.toLowerCase().includes(k))).filter((v,i,a)=>a.indexOf(v)===i).slice(-5);
    const form=document.querySelector('form');
    const composerEl=document.querySelector('div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]');
    const composer=!!composerEl;
    const composerText=(composerEl?.innerText||composerEl?.textContent||"").trim();
    const visibleButton=b=>{
      const style=getComputedStyle(b);
      return b.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none" && !b.closest(messageSelector);
    };
    const allButtons=[...document.querySelectorAll('button')].filter(visibleButton);
    const modeButton=allButtons.find(b=>/select chatgpt model/i.test(b.getAttribute('aria-label')||'')) ||
      [...(form?.querySelectorAll('button')||[])].filter(visibleButton)
        .find(b=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test((b.innerText||"").trim()));
    const mode=modeButton?(modeButton.innerText||modeButton.getAttribute('aria-label')||"").trim():null;
    const lastAssistantMsg=[...ms].reverse().find(x=>x.role==='assistant')||null;
    const lastUserMsg=[...ms].reverse().find(x=>x.role==='user')||null;
    const lastAssistant=lastAssistantMsg?.text||null, lastUser=lastUserMsg?.text||null;
    return {
      url:location.href,title:document.title,mode,
      generating:!!stop,stopAvailable:!!stop,
      sendAvailable:!!send && !send.disabled && send.getAttribute('aria-disabled')!=='true',
      inputReady:composer && !stop,composerPresent:composer,composerText,recoveryControls,
      errorTexts:[...alerts,...knownErrors].filter((v,i,a)=>a.indexOf(v)===i),
      online:navigator.onLine,visibility:document.visibilityState,
      lastUser,lastUserId:lastUserMsg?.id||null,lastAssistant,lastAssistantId:lastAssistantMsg?.id||null,
      userMessages:includeUserMessages?ms.filter(x=>x.role==='user'):undefined,
      messageCount:ms.length,assistantCount:ms.filter(x=>x.role==='assistant').length,
      assistantChars:lastAssistant?.length||0,
      mutationSeq:globalThis.__CHAT_BRIDGE_WATCH.seq,
      mutationLastAt:new Date(globalThis.__CHAT_BRIDGE_WATCH.lastMutationAt).toISOString(),
      observerStartedAt:new Date(globalThis.__CHAT_BRIDGE_WATCH.startedAt).toISOString()
    };
  },includeUserMessages);
}

function classifySnapshot(raw, heartbeat, task=null, effort=null) {
  const quietForSec=heartbeat.quietForSec||0;
  const threshold=Number(task?.stallThresholdSec)||stallThresholdSec(effort||raw.mode);
  let sessionState="IDLE", recommendation="NONE";
  if(contextExhausted(raw)) { sessionState="CONTEXT_EXHAUSTED"; recommendation="ROTATE_SESSION"; }
  else if(!raw.online || !raw.composerPresent) { sessionState="BLOCKED"; recommendation="ESCALATE"; }
  else if(recoveryRequired(raw)) { sessionState="ERROR_RECOVERABLE"; recommendation="RECOVER_NATIVE"; }
  else if(raw.generating) {
    if(quietForSec>=threshold) { sessionState="SUSPECT_STALL"; recommendation="STOP_AND_CONTINUE"; }
    else if(quietForSec<=45) { sessionState="RUNNING_ACTIVE"; recommendation="WAIT"; }
    else { sessionState="RUNNING_QUIET"; recommendation="WAIT"; }
  } else if(task) {
    const baselineCount=Number(task.baselineAssistantCount??raw.assistantCount);
    const baselineHash=task.baselineAssistantHash||null, baselineId=task.baselineAssistantId||null;
    const currentHash=hashText(raw.lastAssistant||"");
    const hasNewAssistant=raw.assistantCount>baselineCount || (!!baselineId && !!raw.lastAssistantId && raw.lastAssistantId!==baselineId) || (!!baselineHash && currentHash!==baselineHash);
    if(hasNewAssistant) { sessionState="IDLE_COMPLETE"; recommendation="RECONCILE_DURABLE_STATE"; }
    else { sessionState="IDLE_INCOMPLETE"; recommendation="CONTINUE"; }
  }
  return {sessionState,recommendation,stallThresholdSec:threshold,quietForSec};
}

async function observeSession(chat,page,task=null) {
  await detectWebRateLimit(page,"observe-session");
  const raw=await state(page), rt=await loadRuntime(), now=new Date(), nowMs=now.getTime();
  const prev=rt.sessions[chat.id]||{};
  const assistantHash=hashText(raw.lastAssistant||"");
  const monitorChanged=prev.observerStartedAt && prev.observerStartedAt!==raw.observerStartedAt;
  const progressed=!prev.observedAt || monitorChanged || raw.assistantCount!==prev.assistantCount || raw.assistantChars!==prev.assistantChars ||
    raw.lastAssistantId!==prev.lastAssistantId || raw.lastUserId!==prev.lastUserId || assistantHash!==prev.assistantHash || (raw.mutationSeq??0)>(prev.mutationSeq??0);
  const lastProgressAt=progressed?now.toISOString():(prev.lastProgressAt||now.toISOString());
  const quietForSec=Math.max(0,Math.floor((nowMs-new Date(lastProgressAt).getTime())/1000));
  let runningSince=prev.runningSince||null;
  if(raw.generating && !runningSince) runningSince=now.toISOString();
  if(!raw.generating) runningSince=null;
  const runningForSec=runningSince?Math.max(0,Math.floor((nowMs-new Date(runningSince).getTime())/1000)):0;
  const hb={...raw,assistantHash,observedAt:now.toISOString(),lastProgressAt,quietForSec,runningSince,runningForSec,
    project:chat.project,account:chat.account,role:chat.role,sessionId:chat.id};
  let liveTask=task;
  if(task?.taskId && rt.tasks[task.taskId]) {
    liveTask=rt.tasks[task.taskId];
    if(liveTask.baselineAssistantCount==null) liveTask.baselineAssistantCount=raw.assistantCount;
    if(!liveTask.baselineAssistantHash) liveTask.baselineAssistantHash=assistantHash;
    if(!liveTask.baselineAssistantId) liveTask.baselineAssistantId=raw.lastAssistantId||null;
  }
  Object.assign(hb,classifySnapshot(raw,hb,liveTask,raw.mode||chat.effort));
  rt.sessions[chat.id]=hb;
  if(liveTask?.taskId && rt.tasks[liveTask.taskId]) {
    Object.assign(liveTask,{sessionState:hb.sessionState,recommendation:hb.recommendation,lastProgressAt:hb.lastProgressAt,
      quietForSec:hb.quietForSec,runningForSec:hb.runningForSec,stateUpdatedAt:hb.observedAt,updatedAt:hb.observedAt});
    rt.tasks[liveTask.taskId]=liveTask;
  }
  await saveRuntime(rt);
  return hb;
}

function deliveryObserved(before, after) {
  if(!after) return false;
  if(after.messageCount>before.messageCount && after.lastUser) return true;
  if(after.lastUserId && after.lastUserId!==before.lastUserId) return true;
  if(after.url && before?.url && after.url!==before.url && /\/c\/[0-9a-f-]+/i.test(after.url)) return true;
  return false;
}

async function waitForDelivery(page, before, timeout=3000) {
  const deadline=Date.now()+timeout;
  let latest=null;
  while(Date.now()<deadline) {
    await page.waitForTimeout(150);
    latest=await state(page);
    if(deliveryObserved(before,latest)) return latest;
    await detectWebRateLimit(page,"send-verify");
  }
  return latest||await state(page);
}

async function activateComposer(page) {
  const point=await page.evaluate(() => {
    const selector='div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [role="textbox"][contenteditable="true"], form .ProseMirror[contenteditable="true"]';
    const items=[...document.querySelectorAll(selector)].filter(e=>{
      const style=getComputedStyle(e);
      return e.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none";
    });
    const e=items[items.length-1];
    if(!e) return null;
    const r=e.getBoundingClientRect();
    return {x:r.left+r.width/2,y:r.top+r.height/2};
  }).catch(()=>null);
  if(point){
    try { await page.mouse.click(point.x,point.y,{label:"activate composer"}); return; } catch {}
  }
  await page.focus(COMPOSER_SELECTOR);
}

async function triggerSend(page) {
  const hasSend=await page.evaluate(()=>!!document.querySelector('button[data-testid="send-button"]'));
  if(hasSend) {
    try { await page.click('button[data-testid="send-button"]'); return "click"; }
    catch {}
  }
  try { await page.press(COMPOSER_SELECTOR,"Enter"); return "enter"; }
  catch {}
  await activateComposer(page);
  await page.keyboard.press("Enter");
  return "enter";
}

async function sendMessage(page, msg) {
  await detectWebRateLimit(page,"send-before");
  const before=await state(page);
  assertComposerSafe(before);
  try { await page.fill(COMPOSER_SELECTOR,msg); }
  catch {
    await activateComposer(page);
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(msg);
  }
  await page.waitForTimeout(80);
  const attempts=[];
  attempts.push(await triggerSend(page));
  let after=await waitForDelivery(page,before,8000);
  if(!deliveryObserved(before,after) && String(after.composerText||"").trim()) {
    attempts.push(await triggerSend(page));
    after=await waitForDelivery(page,before,8000);
  }
  await detectWebRateLimit(page,"send-after");
  if(!deliveryObserved(before,after)) {
    const err=new Error(`DELIVERY_UNCONFIRMED: composer=${after.composerPresent?"present":"missing"} text=${String(after.composerText||"").trim()?"nonempty":"empty"} attempts=${attempts.join(",")}`);
    err.code="DELIVERY_UNCONFIRMED";
    throw err;
  }
  return {delivered:true,attempts,lastUserId:after.lastUserId||null,messageCount:after.messageCount};
}

async function askMessage(page, msg, timeout=180000) {
  const before=await state(page);
  await sendMessage(page,msg);
  await page.waitForFunction((n) => {
    const a=[...document.querySelectorAll('[data-message-author-role="assistant"], [data-chatgpt-search-unit-key$=":assistant"], [data-content-search-unit-key$=":assistant"]')];
    const stop=[...document.querySelectorAll("button")].some(b =>
      /stop/i.test((b.getAttribute("aria-label")||"")+" "+(b.innerText||"")) ||
      /stop/i.test(b.getAttribute("data-testid")||""));
    return a.length>n && !stop && (a[a.length-1].innerText||"").trim().length>0;
  }, before.assistantCount, {timeout});
  return await state(page);
}

async function openModelMenu(page) {
  await detectWebRateLimit(page,"model-menu");
  const ready=await page.waitForFunction(() => {
    const visible=x=>{
      const style=getComputedStyle(x);
      return x.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none" &&
        !x.closest("[inert]") && !x.closest("[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key]");
    };
    const buttons=[...document.querySelectorAll("button")].filter(visible);
    return buttons.some(x=>/select chatgpt model/i.test(x.getAttribute("aria-label")||"")) ||
      buttons.some(x=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test((x.innerText||"").trim()));
  }, undefined, {timeout:15000}).then(()=>true).catch(()=>false);
  if(!ready) throw new Error("Model/effort button not found");
  const marked=await page.evaluate(() => {
    const visible=x=>{
      const style=getComputedStyle(x);
      return x.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none" &&
        !x.closest("[inert]") && !x.closest("[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key]");
    };
    document.querySelectorAll("[data-chat-bridge-model-button]").forEach(e=>e.removeAttribute("data-chat-bridge-model-button"));
    const buttons=[...document.querySelectorAll("button")].filter(visible);
    const preferred=buttons.filter(x=>/select chatgpt model/i.test(x.getAttribute("aria-label")||""));
    const fallback=buttons.filter(x=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test((x.innerText||"").trim()));
    const items=preferred.length?preferred:fallback;
    if(items.length!==1) return {count:items.length};
    items[0].setAttribute("data-chat-bridge-model-button","1");
    return {count:1};
  });
  if(marked.count!==1) throw new Error("Model/effort button "+(marked.count?"ambiguous":"not found"));
  try { await page.click('[data-chat-bridge-model-button="1"]'); }
  catch { throw new Error("Model/effort button disappeared before menu open"); }
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="menuitemradio"]')].some(e=>{
    const style=getComputedStyle(e);
    return e.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none";
  }),undefined,{timeout:5000});
  await page.waitForTimeout(100);
}
async function setModel(page, model) {
  await page.keyboard.press("Escape");
  await openModelMenu(page);
  const labels=await page.evaluate(()=>[...document.querySelectorAll('[role="menuitemradio"]')].filter(e=>{
    const style=getComputedStyle(e);
    return e.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none";
  }).map(e=>(e.innerText||"").trim()));
  try { model=selectModelLabel(labels,model); }
  catch(error){ await page.keyboard.press("Escape"); throw error; }
  const result=await page.evaluate((model)=>{
    document.querySelectorAll("[data-chat-bridge-model-option]").forEach(e=>e.removeAttribute("data-chat-bridge-model-option"));
    const items=[...document.querySelectorAll('[role="menuitemradio"]')].filter(e=>{
      const style=getComputedStyle(e);
      return e.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none";
    });
    const x=items.find(e=>(e.innerText||"").trim().toLowerCase()===model.toLowerCase());
    if(!x) return {ok:false,available:items.map(e=>(e.innerText||"").trim())};
    x.setAttribute("data-chat-bridge-model-option","1");
    const r=x.getBoundingClientRect();
    return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2};
  }, model);
  if(!result.ok){
    await page.keyboard.press("Escape");
    throw new Error("Model not found: "+model+"; available="+result.available.join(", "));
  }
  await page.mouse.click(result.x,result.y,{label:"select model"});
  await page.waitForTimeout(250);
  await page.keyboard.press("Escape");
  await openModelMenu(page);
  const checked=await page.evaluate((model)=>[...document.querySelectorAll('[role="menuitemradio"]')].filter(e=>{
    const style=getComputedStyle(e);
    return e.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none";
  }).some(e=>(e.innerText||"").trim().toLowerCase()===model.toLowerCase() && e.getAttribute("aria-checked")==="true"), model);
  await page.keyboard.press("Escape");
  if(!checked) throw new Error("Model selection was not confirmed: "+model);
  return model;
}
async function setEffort(page, effort) {
  const levels={"instant":0,"medium":1,"high":2,"extra high":3,"pro":4};
  const key=effort.toLowerCase();
  if(!(key in levels)) throw new Error("Effort must be Instant, Medium, High, Extra High, or Pro");
  await page.keyboard.press("Escape");
  await openModelMenu(page);
  const bounds=await page.evaluate(()=>{
    const s=document.querySelector('[role="slider"]');
    return s?{min:Number(s.getAttribute('aria-valuemin')??0),max:Number(s.getAttribute('aria-valuemax'))}:null;
  });
  if(!bounds || !Number.isFinite(bounds.max) || bounds.max<=bounds.min){
    await page.keyboard.press("Escape");
    throw new Error("Thinking effort slider not available");
  }
  const target=key==="pro"?bounds.max:bounds.min+levels[key];
  if(target>bounds.max){ await page.keyboard.press("Escape"); throw new Error("Requested thinking level is unavailable"); }
  await page.focus('[role="slider"]');
  await page.keyboard.press(key==="pro"?"End":"Home");
  if(key!=="pro") for(let i=0;i<levels[key];i++) await page.keyboard.press("ArrowRight");
  const now=await page.evaluate(()=>Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")));
  await page.keyboard.press("Escape");
  if(now!==target) throw new Error("Effort selection was not confirmed");
  if(observedModel((await state(page)).mode).effort?.toLowerCase()!==key) throw new Error("Requested thinking level was not confirmed by the UI: "+effort);
  return true;
}

async function applyModelSpec(page, spec, explicitEffort=null) {
  const preset=modelPreset(spec);
  const selected=await setModel(page,preset.radio);
  const effort=explicitEffort || preset.effort;
  if(effort) await setEffort(page,effort);
  const observed=observedModel((await state(page)).mode);
  return {model:selected,effort:observed.effort||effort,observed};
}

async function modelSelectorAvailable(page) {
  return await page.evaluate(() => {
    const buttons=[...document.querySelectorAll("button")];
    return buttons.some(button=>{
      const style=getComputedStyle(button);
      if(button.getClientRects().length===0 || style.visibility==="hidden" || style.display==="none") return false;
      if(button.closest('[data-message-author-role], [data-content-search-unit-key], [data-chatgpt-search-unit-key]')) return false;
      const label=((button.innerText||"")+" "+(button.getAttribute("aria-label")||"")).trim();
      return /select chatgpt model/i.test(button.getAttribute("aria-label")||"") ||
        /\b(?:Latest|GPT[- ]?\d+(?:\.\d+)*(?:\s+(?:Sol|Terra))?)\b/i.test(label);
    });
  }).catch(()=>false);
}

function deferrableModelUiError(error) {
  const text=String(error?.message||error||"");
  return /model\/effort button disappeared|hidden or inert|none can receive input|page\.focus timed out.*data-chat-bridge-model-option/i.test(text);
}

async function applyConfiguredSessionModel(page, chat) {
  const observed=observedModel((await state(page)).mode);
  const effortMatches=!!chat.effort && observed.effort?.toLowerCase()===String(chat.effort).toLowerCase();
  if(chat.model && effortMatches && !observed.model) {
    const selectorAvailable=await modelSelectorAvailable(page);
    if(!selectorAvailable) {
      return {
        model:chat.model,
        effort:observed.effort,
        observed,
        reapplied:false,
        uiModelUnverifiable:true,
      };
    }
  }
  if(chat.model) return await applyModelSpec(page,chat.model,chat.effort||null);
  if(chat.effort) {
    await setEffort(page,chat.effort);
    const refreshed=observedModel((await state(page)).mode);
    return {model:null,effort:refreshed.effort||chat.effort,observed:refreshed,reapplied:true};
  }
  return null;
}

async function applyDispatchModel(page, chat, requestedModel=null, requestedEffort=null) {
  const model=requestedModel || chat.model || null;
  const effort=requestedEffort || chat.effort || null;
  let selection=null;
  if(!requestedModel && !requestedEffort) selection=await applyConfiguredSessionModel(page,chat);
  else if(model) selection=await applyModelSpec(page,model,effort);
  else if(effort) {
    await setEffort(page,effort);
    const observed=observedModel((await state(page)).mode);
    selection={model:null,effort:observed.effort||effort,observed,reapplied:true};
  }
  if(requestedModel) chat.model=requestedModel;
  if(requestedEffort) chat.effort=requestedEffort;
  if(selection && !selection.uiModelUnverifiable) {
    chat.verifiedModel=selection.model||selection.observed?.model||chat.verifiedModel||null;
    chat.verifiedEffort=selection.effort||selection.observed?.effort||chat.verifiedEffort||null;
    chat.resourceVerifiedAt=new Date().toISOString();
  }
  if(requestedModel || requestedEffort || selection) await saveRegistry(reg);
  return selection;
}

async function openProjectPage(page, projectName, knownUrl=null) {
  const current=await page.url();
  if(current.includes("/g/g-p-") && current.endsWith("/project")) {
    const title=await page.title();
    if(title.toLowerCase().includes(projectName.toLowerCase())) {
      await waitForProjectReady(page,projectName,15000);
      return current;
    }
  }
  if(knownUrl) {
    await page.goto(knownUrl, {waitUntil:"load",timeout:20000});
    await detectWebRateLimit(page,"open-project-known");
    await waitForProjectReady(page,projectName,15000);
    return await page.url();
  }
  await page.goto("https://chatgpt.com/", {waitUntil:"load",timeout:20000});
  await page.waitForTimeout(500);
  await detectWebRateLimit(page,"open-project-home");
  await page.waitForSelector('button[aria-label="Open project options for ' + projectName.replace(/"/g,"") + '"]', {state:"visible",timeout:10000});
  const ok=await page.evaluate((projectName)=>{
    document.querySelectorAll("[data-chat-bridge-open-project]").forEach(e=>e.removeAttribute("data-chat-bridge-open-project"));
    const opt=document.querySelector('button[aria-label="Open project options for '+projectName.replace(/"/g,'')+'"]');
    const home=opt?.parentElement?.querySelector('button[aria-label="Open project home"]');
    if(!home) return false;
    home.setAttribute("data-chat-bridge-open-project","1");
    return true;
  }, projectName);
  if(!ok) throw new Error("ChatGPT project not found: "+projectName);
  try {
    await page.focus('button[data-chat-bridge-open-project="1"]');
    await page.keyboard.press("Enter");
  } catch {
    await page.click('button[data-chat-bridge-open-project="1"]');
  }
  await page.waitForURL(/\/g\/g-p-[^/]+\/project/, {timeout:15000});
  await waitForProjectReady(page,projectName,15000);
  return await page.url();
}

function managedSpacePlan(reg, account, preferredProfileId=null) {
  const identity=reg.accounts?.[account]?.identity;
  if(!identity) throw new Error("TARGET_IDENTITY_UNVERIFIED");
  const observedSpaces=Object.values(reg.spaces||{}).filter(space=>space.identity===identity&&space.profileId);
  if(!observedSpaces.length) throw new Error("NEEDS_LOGIN_OR_PROFILE_SCAN");
  const profileIds=[...new Set(observedSpaces.map(space=>space.profileId).filter(Boolean))];
  let profileId=preferredProfileId||null;
  if(profileId && !profileIds.includes(profileId)) throw new Error("PROFILE_NOT_OBSERVED_FOR_LOGIN");
  if(!profileId) {
    if(profileIds.length!==1) throw new Error("PROFILE_AMBIGUOUS_FOR_LOGIN");
    profileId=profileIds[0];
  }
  const source=observedSpaces.find(space=>space.profileId===profileId)||observedSpaces[0];
  const accountName=source.accountName||reg.accounts?.[account]?.label||account;
  const profileSuffix=profileIds.length>1?"-"+crypto.createHash("sha256").update(String(profileId)).digest("hex").slice(0,8):"";
  const canonical=observedSpaces.filter(space=>space.profileId===profileId&&space.ownership==="agent"&&
    String(space.name||"").startsWith("chat-bridge-agent-"));
  if(canonical.length>1) throw new Error("AMBIGUOUS_CANONICAL_SPACE");
  const spaceName=canonical[0]?.name||"chat-bridge-agent-"+slug(accountName)+profileSuffix;
  return {identity,profileId,profileIds,accountName,spaceName};
}

async function accountManagedTask(reg, account, preferredProfileId=null) {
  const plan=managedSpacePlan(reg,account,preferredProfileId);
  const {profileId,accountName,spaceName:name}=plan;
  const available=typeof listTaskSpaces==="function"?await listTaskSpaces():[];
  const duplicates=available.filter(space=>space.name===name);
  if(duplicates.length>1) throw new Error("AMBIGUOUS_SPACE: "+name);
  const existing=duplicates[0];
  if(existing && ["user","agentDelegatedToUser"].includes(existing.ownership)) {
    const error=new Error("SPACE_IN_USER_CONTROL: "+name);
    error.code="SPACE_IN_USER_CONTROL";
    error.spaceName=name;
    error.ownership=existing.ownership;
    throw error;
  }
  if(existing?.profileId && existing.profileId!==profileId) throw new Error("SPACE_PROFILE_MISMATCH: "+name);
  const task=await taskSpace(name,!existing?{profileId}:undefined);
  const prior=taskAccounts.get(Number(task.spaceId));
  if(prior&&accountScope(reg,prior)!==accountScope(reg,account)) throw new Error("Space is bound to conflicting ChatGPT accounts");
  taskAccounts.set(Number(task.spaceId),account);
  return {task,spaceName:name,profileId,accountName};
}

async function consolidateAccountSpace(reg, account, options={}) {
  const preferred=options.profileId||null, plan=managedSpacePlan(reg,account,preferred);
  const identity=plan.identity;
  const aliases=Object.entries(reg.accounts||{}).filter(([,record])=>record.identity===identity).map(([name])=>name);
  const affected=[];
  for(const [projectName,project] of Object.entries(reg.projects||{})) {
    for(const alias of aliases) {
      const binding=project.bindings?.[alias];
      if(binding) affected.push({project:projectName,account:alias,from:binding.spaceName||null,to:plan.spaceName});
    }
  }
  const migration=coordinated("migration-check",{account});
  const oldNames=[...new Set([
    ...affected.map(item=>item.from),
    ...Object.values(reg.chats||{}).filter(chat=>aliases.includes(chat.account)).map(chat=>chat.spaceName)
  ].filter(name=>name&&name!==plan.spaceName))];
  const available=typeof listTaskSpaces==="function"?await listTaskSpaces():[];
  const oldSpaces=[];
  for(const name of oldNames) {
    const matches=available.filter(space=>space.name===name);
    if(matches.length>1) throw new Error("AMBIGUOUS_SPACE: "+name);
    const info=matches[0];
    if(!info){ oldSpaces.push({name,missing:true}); continue; }
    const record={name,spaceId:info.id,ownership:info.ownership,profileId:info.profileId,tabs:0};
    if(info.ownership==="agent"&&info.profileId===plan.profileId) {
      const task=await taskSpace(info.id), tabs=await task.tabs();
      record.tabs=tabs.length;
    }
    oldSpaces.push(record);
  }
  const safe=migration.safe&&oldSpaces.every(space=>space.missing ||
    (space.ownership==="agent"&&space.profileId===plan.profileId&&space.tabs===0));
  const preview={ok:true,dryRun:!options.confirm,account,aliases,profileId:plan.profileId,spaceName:plan.spaceName,
    affected,migration,oldSpaces,safe};
  if(!options.confirm) return preview;
  if(!safe) return {...preview,ok:false,status:"NOT_DRAINED"};
  const {task}=await accountManagedTask(reg,account,plan.profileId);
  for(const item of affected) {
    const binding=reg.projects[item.project].bindings[item.account];
    binding.spaceName=plan.spaceName;binding.profileId=plan.profileId;binding.spaceId=task.spaceId;binding.controlPage=null;
  }
  for(const chat of Object.values(reg.chats||{})) {
    if(!aliases.includes(chat.account)) continue;
    const binding=reg.projects?.[chat.project]?.bindings?.[chat.account];
    if(!binding || binding.spaceName!==plan.spaceName) continue;
    chat.spaceName=plan.spaceName;chat.spaceId=task.spaceId;chat.pageSpaceId=task.spaceId;
    if(chat.page) {
      chat.page=null;chat.detachedAt=new Date().toISOString();chat.attachmentEpoch=Number(chat.attachmentEpoch||0)+1;
    }
  }
  await saveRegistry(reg);
  const closed=[];
  for(const space of oldSpaces.filter(item=>!item.missing)) {
    await (await taskSpace(space.spaceId)).finish({keep:[]});
    closed.push(space.name);
  }
  return {...preview,dryRun:false,spaceId:task.spaceId,oldSpacesClosed:closed,migrated:true};
}

async function createProjectViaUI(page, projectName) {
  await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
  await page.waitForTimeout(600);
  await detectWebRateLimit(page,"project-create-home");
  const hasCreateControl=await page.waitForFunction(()=>{
    return [...document.querySelectorAll("button,a")].some(el=>{
      const text=((el.innerText||"")+" "+(el.getAttribute("aria-label")||"")).trim();
      return /^(new project|create project|add project|add new project|新建项目|创建项目)$/i.test(text);
    });
  },undefined,{timeout:15000}).then(()=>true).catch(()=>false);
  if(!hasCreateControl) throw new Error("PROJECT_CREATE_CONTROL_NOT_FOUND");
  const markCreate=async()=>await page.evaluate(()=>{
    document.querySelectorAll("[data-chat-bridge-create-project]").forEach(e=>e.removeAttribute("data-chat-bridge-create-project"));
    const candidates=[...document.querySelectorAll("button,a")].filter(el=>{
      const text=((el.innerText||"")+" "+(el.getAttribute("aria-label")||"")).trim();
      const style=getComputedStyle(el);
      return el.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none" &&
        /^(new project|create project|add project|add new project|新建项目|创建项目)$/i.test(text);
    });
    if(candidates.length!==1) return {count:candidates.length,actionable:false};
    const control=candidates[0], rect=control.getBoundingClientRect();
    const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
    const actionable=!!hit && (hit===control || control.contains(hit));
    control.setAttribute("data-chat-bridge-create-project","1");
    return {count:1,actionable};
  });
  let marked=await markCreate();
  if(marked.count!==1) throw new Error("PROJECT_CREATE_CONTROL_"+(marked.count?"AMBIGUOUS":"NOT_FOUND"));
  if(!marked.actionable) {
    const toggle=await page.evaluate(()=>{
      document.querySelectorAll("[data-chat-bridge-projects-toggle]").forEach(e=>e.removeAttribute("data-chat-bridge-projects-toggle"));
      const controls=[...document.querySelectorAll("button")].filter(el=>{
        const style=getComputedStyle(el);
        return el.getClientRects().length>0 && style.visibility!=="hidden" && style.display!=="none" &&
          /^(projects|项目)$/i.test((el.innerText||"").trim());
      });
      if(controls.length!==1) return false;
      controls[0].setAttribute("data-chat-bridge-projects-toggle","1");
      return true;
    });
    if(!toggle) throw new Error("PROJECTS_TOGGLE_NOT_FOUND");
    await page.click('[data-chat-bridge-projects-toggle="1"]');
    await page.waitForTimeout(250);
    marked=await markCreate();
    if(marked.count!==1 || !marked.actionable) throw new Error("PROJECT_CREATE_CONTROL_NOT_ACTIONABLE");
  }
  await page.click('[data-chat-bridge-create-project="1"]');
  await page.waitForSelector('[role="dialog"]',{state:"visible",timeout:5000});
  await page.waitForSelector('[role="dialog"] input[type="text"], [role="dialog"] input:not([type]), [role="dialog"] textarea',{state:"visible",timeout:5000});
  const fieldReady=await page.evaluate(()=>{
    const dialogs=[...document.querySelectorAll('[role="dialog"]')];
    const dialog=dialogs[dialogs.length-1];
    if(!dialog) return false;
    document.querySelectorAll("[data-chat-bridge-project-name]").forEach(e=>e.removeAttribute("data-chat-bridge-project-name"));
    const fields=[...dialog.querySelectorAll('input[type="text"],input:not([type]),textarea')];
    const field=fields.find(el=>/project|项目/i.test((el.getAttribute("placeholder")||"")+" "+(el.getAttribute("aria-label")||"")))||fields[0];
    if(!field) return false;
    field.setAttribute("data-chat-bridge-project-name","1");
    return true;
  });
  if(!fieldReady) throw new Error("PROJECT_CREATE_NAME_FIELD_NOT_FOUND");
  try { await page.fill('[data-chat-bridge-project-name="1"]',projectName); }
  catch {
    await page.focus('[data-chat-bridge-project-name="1"]');
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(projectName);
  }
  const confirmReady=await page.waitForFunction(()=>{
    const visible=el=>{const style=getComputedStyle(el);return el.getClientRects().length>0&&style.visibility!=="hidden"&&style.display!=="none";};
    const dialogs=[...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const dialog=dialogs[dialogs.length-1];
    if(!dialog) return false;
    document.querySelectorAll("[data-chat-bridge-confirm-project]").forEach(e=>e.removeAttribute("data-chat-bridge-confirm-project"));
    const buttons=[...dialog.querySelectorAll("button")].filter(el=>{
      const text=((el.innerText||"")+" "+(el.getAttribute("aria-label")||"")).trim();
      return visible(el)&&!el.disabled&&el.getAttribute("aria-disabled")!=="true"&&/^(create|create project|创建|创建项目)$/i.test(text);
    });
    if(buttons.length!==1) return false;
    buttons[0].setAttribute("data-chat-bridge-confirm-project","1");
    return true;
  },undefined,{timeout:5000}).then(()=>true).catch(()=>false);
  if(!confirmReady) throw new Error("PROJECT_CREATE_DIALOG_NOT_READY");
  try { await page.focus('[data-chat-bridge-confirm-project="1"]'); await page.keyboard.press("Enter"); }
  catch { await page.click('[data-chat-bridge-confirm-project="1"]'); }
  await page.waitForURL(/\/g\/g-p-[^/]+\/project/,{timeout:20000});
  await waitForProjectReady(page,projectName,15000);
  return await page.url();
}

async function ensureProjectLocation(reg, projectName, account, options={}) {
  const pr=projectRecord(reg,projectName);
  const accountRecord=reg.accounts?.[account];
  if(!accountRecord?.identity) return {ok:false,status:"NEEDS_LOGIN",project:projectName,account};
  const current=pr.bindings?.[account]||null;
  if(current?.projectUrl && bindingObserved(reg,account,current)) {
    try {
      const {task,spaceName,profileId}=await accountManagedTask(reg,account,current?.profileId||null);
      const page=(await pagesOf(task))[0]||await task.newPage();
      const url=await openProjectPage(page,projectName,current.projectUrl);
      current.spaceName=spaceName;
      current.profileId=profileId;
      current.spaceId=task.spaceId;
      current.projectUrl=url;
      current.projectBase=url.replace(/\/project$/,'');
      current.projectId=projectIdFromUrl(url);
      current.verifiedAt=new Date().toISOString();
      await saveRegistry(reg);
      const readiness=bindingExecutionReadiness(pr,current);
      return {ok:readiness.ready,status:readiness.ready?"READY":"CONTENT_NOT_READY",accessReady:true,
        project:projectName,account,projectId:current.projectId,projectUrl:url,spaceName,created:false,
        missing:readiness.missing,requirements:readiness.requirements||null,readiness:readiness.readiness||null};
    } catch(error) {
      if(!options.create) return {ok:false,status:"PROJECT_NOT_ACCESSIBLE",project:projectName,account,error:String(error.message||error)};
    }
  }
  const {task,spaceName,profileId}=await accountManagedTask(reg,account,current?.profileId||null);
  const page=(await pagesOf(task))[0]||await task.newPage();
  let url=null;
  let created=false;
  try {
    url=await openProjectPage(page,projectName,null);
  } catch(error) {
    if(!options.create) return {ok:false,status:"NEEDS_PROJECT_SETUP",project:projectName,account,spaceName};
    if(!options.confirm) return {ok:false,status:"NEEDS_APPROVAL",project:projectName,account,spaceName};
    url=await createProjectViaUI(page,projectName);
    created=true;
  }
  const b=bindingFor(reg,projectName,account,true);
  b.account=account;
  b.projectUrl=url;
  b.projectBase=url.replace(/\/project$/,'');
  b.projectId=projectIdFromUrl(url);
  b.spaceName=spaceName;
  b.spaceId=task.spaceId;
  b.profileId=profileId;
  b.controlPage=page.label;
  b.verifiedAt=new Date().toISOString();
  await saveRegistry(reg);
  await touchRuntime(projectName,{activeAccount:account,spaceName,lastCommand:"project ensure"});
  const readiness=bindingExecutionReadiness(pr,b);
  return {ok:readiness.ready,status:readiness.ready?"READY":"CONTENT_NOT_READY",accessReady:true,
    project:projectName,account,projectId:b.projectId,projectUrl:url,spaceName,created,
    missing:readiness.missing,requirements:readiness.requirements||null,readiness:readiness.readiness||null};
}

async function syncProject(reg, page, projectName, account, binding) {
  const projectUrl=await openProjectPage(page,projectName,binding?.projectUrl||null);
  await page.reload({waitUntil:"load",timeout:20000}).catch(()=>{});
  await detectWebRateLimit(page,"sync");
  await page.waitForSelector('[role="tabpanel"]',{state:"visible",timeout:15000});
  await page.waitForTimeout(1200);
  const chats=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/g/g-p-"][href*="/c/"]')].map(a=>({
    title:(a.innerText||"").trim().split("\n")[0],url:a.href
  })).filter(x=>x.title));
  const uniq=[], seen=new Set();
  for(const x of chats){ const m=x.url.match(/\/c\/([0-9a-f-]+)/i); if(m&&!seen.has(m[1])){seen.add(m[1]);uniq.push({id:m[1],...x});} }
  const projectBase=projectUrl.replace(/\/project$/,'');
  binding.projectUrl=projectUrl; binding.projectBase=projectBase; binding.projectId=projectIdFromUrl(projectUrl);
  for(const x of uniq){
    const old=reg.chats[x.id]||{};
    const attached=old.spaceName===binding.spaceName && old.spaceId!=null && binding.spaceId!=null && Number(old.spaceId)===Number(binding.spaceId);
    reg.chats[x.id]={...old,id:x.id,url:x.url,name:old.name||x.title,role:old.role||old.name||x.title,title:x.title,
      project:projectName,account,status:old.status||"active",model:old.model||null,effort:old.effort||null,
      spaceName:binding.spaceName,spaceId:binding.spaceId??null,page:attached?(old.page||null):null};
  }
  await saveRegistry(reg);
  await touchRuntime(projectName,{activeAccount:account,spaceName:binding.spaceName,lastCommand:"sync",chatCount:uniq.length});
  return uniq;
}

async function stopGeneration(page) {
  return await page.evaluate(() => {
    const bs=[...document.querySelectorAll("button")];
    const b=bs.find(x=>{
      const s=((x.getAttribute("aria-label")||"")+" "+(x.innerText||"")+" "+(x.getAttribute("data-testid")||"")).toLowerCase();
      return s.includes("stop");
    });
    if(!b) return {stopped:false};
    const label=(b.getAttribute("aria-label")||b.innerText||b.getAttribute("data-testid")||"stop").trim();
    b.click();
    return {stopped:true,label};
  });
}

async function nativeRetry(page) {
  return await page.evaluate(() => {
    const buttons=[...document.querySelectorAll("button")];
    const priorities=["continue generating","try again","retry","regenerate"];
    const norm=b=>((b.getAttribute("aria-label")||"")+" "+(b.innerText||"")+" "+(b.getAttribute("data-testid")||"")).trim().toLowerCase();
    for(const key of priorities) {
      const b=[...buttons].reverse().find(x=>norm(x).includes(key) && !x.disabled && x.getAttribute('aria-disabled')!=='true');
      if(b){ const label=(b.getAttribute("aria-label")||b.innerText||b.getAttribute('data-testid')||key).trim(); b.click(); return {clicked:true,label,kind:key}; }
    }
    return {clicked:false};
  });
}

async function waitForGenerationStop(page, timeout=7000) {
  return await page.waitForFunction(()=>{
    const bs=[...document.querySelectorAll('button')];
    const stop=bs.some(b=>/\bstop\b/i.test(((b.getAttribute('aria-label')||'')+' '+(b.innerText||'')+' '+(b.getAttribute('data-testid')||''))));
    return !stop;
  },undefined,{timeout}).then(()=>true).catch(()=>false);
}

async function notifyController(reg, task, message) {
  const rootController=reg.projects?.[task.project]?.rootController || "conductor";
  const targets=notificationTargets(task,rootController);
  const failures=[];
  for(const target of targets) {
    try {
      const controller=resolveControllerTarget(reg.chats,target,task.project,(task.replyToSessionRef||task.controllerSessionRef)?null:(task.account||null));
      if(controller.id===task.sessionId) {
        failures.push({target,reason:"target is task session"});
        continue;
      }
      const operation=coordinated("callback",{taskId:task.taskId,targetRef:controller.id,message});
      if(operation.status==="SENT") delete task.watchdogPendingNotification;
      else task.watchdogPendingNotification=message;
      return {sent:operation.status==="SENT",queued:operation.status==="QUEUED",operationId:operation.operationId,
        status:operation.status,target,role:controller.role||controller.name,targets};
    } catch(error) {
      if(error?.code==="WEB_RATE_LIMITED") {
        task.watchdogPendingNotification=message;
        return {sent:false,reason:"WEB_COOLDOWN",account:error.account,targets};
      }
      failures.push({target,reason:error.message});
    }
  }
  return {sent:false,targets,failures};
}

function projectReconcileMessage(candidate) {
  const lines=[
    "[PROJECT EVENT]",
    "event: RECONCILE_REQUIRED",
    `project: ${candidate.project}`,
    `root_controller: ${candidate.rootRole}`,
    `reason: ${candidate.reason}`,
    `latest_task: ${candidate.latestTaskId||"unknown"}`,
    `latest_durable: ${candidate.latestGithub||"unknown"}`,
    `progress_at: ${candidate.progressAt}`,
    "",
    "All non-root project tasks are terminal and new durable progress exists since the previous reconcile event.",
    "Re-read the project's durable source of truth, reconcile current controller/task state, and dispatch only genuinely runnable next work according to this project's own governance. Do not replay completed work."
  ];
  if(candidate.instruction) lines.push("", "Project policy:", candidate.instruction);
  return lines.join("\n");
}

async function maybeNotifyProjectReconcile(reg, projectName, account=null) {
  const project=projectRecord(reg,projectName);
  const policy=normalizeLifecycle(project);
  if(!policy.autoReconcile) return null;
  const rt=await loadRuntime(), runtimeProject=rt.projects[projectName]||{};
  const candidate=reconcileCandidate(projectName,project,Object.values(rt.tasks||{}),runtimeProject,Date.now());
  if(!candidate) return null;
  if(!candidate.ready) return {project:projectName,event:candidate.event,state:"DEFERRED_MIN_GAP",waitSec:candidate.waitSec,eventKey:candidate.eventKey};
  const a=account||project.activeAccount||reg.defaultAccount||DEFAULT_ACCOUNT;
  try {
    const root=resolveChat(reg,candidate.rootRole,projectName,a);
    await assertWebAvailable(root.account||a);
    const {page}=await ensurePage(reg,root,{pauseOnUserControl:true});
    const observed=await observeSession(root,page,null);
    if(observed.generating || !observed.inputReady || String(observed.composerText||"").trim()) {
      return {project:projectName,event:candidate.event,state:"ROOT_BUSY",eventKey:candidate.eventKey,
        rootState:observed.sessionState,composerNonempty:!!String(observed.composerText||"").trim()};
    }
    const delivery=await sendMessage(page,projectReconcileMessage(candidate));
    const latest=await loadRuntime();
    latest.projects[projectName]={...(latest.projects[projectName]||{}),
      lastReconcileProgressAt:candidate.progressAt,lastReconcileEventKey:candidate.eventKey,
      lastReconcileNotifiedAt:new Date().toISOString(),
      lastReconcileNotification:{sent:true,rootRole:candidate.rootRole,delivery}};
    delete latest.projects[projectName].pendingReconcileEvent;
    delete latest.projects[projectName].lastReconcileError;
    delete latest.projects[projectName].lastReconcileErrorAt;
    await saveRuntime(latest);
    return {project:projectName,event:candidate.event,state:"SENT",eventKey:candidate.eventKey,
      latestTaskId:candidate.latestTaskId,rootRole:candidate.rootRole,delivery};
  } catch(error) {
    const latest=await loadRuntime();
    if(error?.code==="SPACE_IN_USER_CONTROL") {
      latest.projects[projectName]={...(latest.projects[projectName]||{}),
        pendingReconcileEvent:candidate,watchdogPausedForUserControl:true,
        watchdogPausedAt:new Date().toISOString(),
        watchdogPausedSpace:error.spaceName||null,
        watchdogPausedOwnership:error.ownership||null};
      delete latest.projects[projectName].lastReconcileError;
      delete latest.projects[projectName].lastReconcileErrorAt;
      await saveRuntime(latest);
      return {project:projectName,event:candidate.event,state:"USER_CONTROLLED",paused:true,
        spaceName:error.spaceName||null,ownership:error.ownership||null,eventKey:candidate.eventKey};
    }
    latest.projects[projectName]={...(latest.projects[projectName]||{}),
      pendingReconcileEvent:candidate,lastReconcileError:String(error?.message||error),
      lastReconcileErrorAt:new Date().toISOString()};
    await saveRuntime(latest);
    if(error?.code==="WEB_RATE_LIMITED") return {project:projectName,event:candidate.event,state:"WEB_COOLDOWN",account:error.account,eventKey:candidate.eventKey};
    return {project:projectName,event:candidate.event,state:"NOT_SENT",error:String(error?.message||error),eventKey:candidate.eventKey};
  }
}

async function gradedRecover(reg, chat, page, task, observed, options={}) {
  const rt=await loadRuntime();
  const live=rt.tasks[task.taskId]||task;
  const maxAttempts=Number(options.maxAttempts??3), maxTotalRecoveries=Number(options.maxTotalRecoveries??8), cooldownSec=Number(options.cooldownSec??45), aggressive=!!options.aggressive;
  const attempts=Number(live.recoveryAttempts||0), totalAttempts=Number(live.totalRecoveryAttempts||0), now=new Date(), last=live.lastRecoveryAt?new Date(live.lastRecoveryAt):null;
  if(last && (now-last)/1000<cooldownSec) return {action:"COOLDOWN",attempts};
  if(attempts>=maxAttempts || totalAttempts>=maxTotalRecoveries || observed.sessionState==="BLOCKED") {
    live.status="BLOCKED"; live.blockedReason=observed.sessionState==="BLOCKED"?"session blocked":totalAttempts>=maxTotalRecoveries?"total recovery budget exhausted":"consecutive recovery attempts exhausted";
    live.stateUpdatedAt=now.toISOString();
    let notification={sent:false,reason:"already notified"};
    if(!live.watchdogNotifiedAt) {
      notification=await notifyController(reg,live,`[WATCHDOG]\ntask_id: ${live.taskId}\nstatus: BLOCKED\nsession_state: ${observed.sessionState}\nrole: ${live.role||chat.role}\nsummary: ${live.blockedReason}; reconcile GitHub and replace/recover the session if needed.`);
      if(notification.sent) live.watchdogNotifiedAt=now.toISOString();
    }
    rt.tasks[live.taskId]=live; await saveRuntime(rt);
    return {action:"BLOCKED",attempts,notification};
  }
  let method=null, detail=null;
  if(observed.sessionState==="ERROR_RECOVERABLE") {
    detail=await nativeRetry(page);
    if(detail.clicked) method="native-"+(detail.kind||"retry");
    else { await sendMessage(page,"continue"); method="continue"; }
  } else if(observed.sessionState==="IDLE_INCOMPLETE") {
    if(aggressive && attempts>=2 && live.originalMessage) {
      await sendMessage(page,`[RECOVERY ${live.taskId}] Continue this existing task without duplicating completed work. Reconcile current GitHub/task state first. Original task:\n${live.originalMessage}`);
      method="guarded-resend-original";
    } else {
      const msg=attempts===0?"continue":"continue from where you left off. Do not restart or duplicate completed work; inspect the current task/GitHub state first.";
      await sendMessage(page,msg); method="continue";
    }
  } else if(observed.sessionState==="SUSPECT_STALL") {
    detail=await stopGeneration(page);
    await waitForGenerationStop(page,7000);
    await sendMessage(page,"continue from where you left off. Do not restart or duplicate completed work; inspect the current task/GitHub state first.");
    method="stop-and-continue";
  } else {
    return {action:"NONE",attempts};
  }
  live.recoveryAttempts=attempts+1; live.totalRecoveryAttempts=totalAttempts+1; live.lastRecoveryAt=now.toISOString(); live.lastRecoveryMethod=method; live.status="RECOVERING"; live.updatedAt=now.toISOString();
  live.watchdogNotifiedAt=null; rt.tasks[live.taskId]=live; await saveRuntime(rt);
  return {action:"RECOVERED",method,attempt:live.recoveryAttempts,detail};
}

async function clearUserControlPause(chat) {
  const rt=await loadRuntime();
  let changed=false;
  for(const live of Object.values(rt.tasks||{})) {
    const sameSession=live.sessionId===chat.id;
    const sameRole=!live.sessionId && live.project===chat.project && live.role===chat.role &&
      (live.account||chat.account)===chat.account;
    if((sameSession||sameRole) && live.watchdogPausedForUserControl) {
      delete live.watchdogPausedForUserControl;
      delete live.watchdogPausedAt;
      delete live.watchdogPausedSpace;
      delete live.watchdogPausedOwnership;
      live.updatedAt=new Date().toISOString();
      changed=true;
    }
  }
  const projectState=rt.projects?.[chat.project];
  if(projectState?.watchdogPausedForUserControl) {
    delete projectState.watchdogPausedForUserControl;
    delete projectState.watchdogPausedAt;
    delete projectState.watchdogPausedSpace;
    delete projectState.watchdogPausedOwnership;
    changed=true;
  }
  if(changed) await saveRuntime(rt);
  return changed;
}

async function detachTerminalTaskPages(reg, project=null, account=null) {
  const graceSec=Math.max(30,Number(process.env.CHAT_BRIDGE_TERMINAL_TAB_GRACE_SEC||180)||180);
  const rt=await loadRuntime(), now=Date.now(), closed=[];
  const terminal=new Set(["COMPLETE","FAILED","CANCELLED","RESULT_RECORDED"]);
  for(const taskRecord of Object.values(rt.tasks||{})) {
    if(project && taskRecord.project!==project) continue;
    if(account && (taskRecord.account||reg.chats?.[taskRecord.sessionId]?.account)!==account) continue;
    if(!terminal.has(String(taskRecord.status||"").toUpperCase())) continue;
    if(taskRecord.watchdogPendingNotification || taskRecord.externalResponsePending) continue;
    const updated=Date.parse(taskRecord.updatedAt||taskRecord.stateUpdatedAt||taskRecord.createdAt||0);
    if(!Number.isFinite(updated) || (now-updated)/1000<graceSec) continue;
    const chat=taskRecord.sessionId?reg.chats?.[taskRecord.sessionId]:null;
    if(!chat?.page || chat.status!=="active") continue;
    const otherActive=Object.values(rt.tasks||{}).some(other=>other.taskId!==taskRecord.taskId &&
      activeTaskStatus(other.status) && other.sessionId===chat.id);
    if(otherActive) continue;
    let opened;
    try { opened=await openBoundTask(reg,chat.project,chat.account,{pauseOnUserControl:true}); }
    catch { continue; }
    let page;
    try { page=opened.task.page(chat.page); } catch { continue; }
    const tabs=await opened.task.tabs().catch(()=>[]);
    const tab=tabs.find(item=>item.label===chat.page);
    if(!tab || tab.active || tab.openedBy!=="agent") continue;
    const snapshot=await state(page).catch(()=>null);
    if(!snapshot || snapshot.generating || String(snapshot.composerText||"").trim()) continue;
    const oldPage=chat.page;
    try { await page.close(); } catch { continue; }
    chat.page=null;
    chat.detachedAt=new Date().toISOString();
    chat.attachmentEpoch=Number(chat.attachmentEpoch||0)+1;
    closed.push({taskId:taskRecord.taskId,sessionId:chat.id,page:oldPage});
  }
  if(closed.length) await saveRegistry(reg);
  return closed;
}

async function watchOnce(reg, project=null, account=null, options={}) {
  const rt=await loadRuntime(), results=[];
  const taskGapMs=Math.max(10000,Number(process.env.CHAT_BRIDGE_WATCH_TASK_GAP_MS||10000)||10000);
  const tasks=options.skipTasks?[]:Object.values(rt.tasks||{}).filter(t=>!t.watchdogPausedForUserControl &&
    (!options.taskId||t.taskId===options.taskId) &&
    (activeTaskStatus(t.status)||(t.status==="BLOCKED"&&t.watchdogPendingNotification)) && (!project||t.project===project) &&
    (!account||(reg.chats[t.sessionId]?.account||t.account||reg.projects[t.project]?.activeAccount||reg.defaultAccount)===account));
  let lastVisitedAt=0;
  for(const task of tasks) {
    let chat=null;
    try {
      chat=task.sessionId?resolveChat(reg,task.sessionId,task.project,task.account):resolveChat(reg,task.role,task.project,task.account);
      await assertWebAvailable(chat.account);
      const waitMs=Math.max(0,taskGapMs-(Date.now()-lastVisitedAt));
      if(waitMs) await new Promise(resolve=>setTimeout(resolve,waitMs));
      lastVisitedAt=Date.now();
      if(task.status==="BLOCKED"&&task.watchdogPendingNotification) {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId];
        if(!live || live.status!=="BLOCKED" || !live.watchdogPendingNotification) continue;
        const notification=await notifyController(reg,live,live.watchdogPendingNotification);
        if(notification.sent) live.watchdogNotifiedAt=new Date().toISOString();
        latest.tasks[live.taskId]=live; await saveRuntime(latest);
        results.push({taskId:live.taskId,state:"BLOCKED",notification});
        continue;
      }
      if(!task.sessionId) task.sessionId=chat.id;
      const {page}=await ensurePage(reg,chat,{pauseOnUserControl:true});
      const observed=await observeSession(chat,page,task);
      let recovery={action:"NONE"}, notification=null;
      if(observed.sessionState==="CONTEXT_EXHAUSTED") {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
        live.status="BLOCKED";
        live.blockedReason="CONTEXT_EXHAUSTED";
        live.contextExhaustedAt=new Date().toISOString();
        live.recommendation="ROTATE_SESSION";
        if(options.autoRecover!==false && !live.watchdogNotifiedAt) {
          notification=await notifyController(reg,live,`[WATCHDOG]
task_id: ${live.taskId}
status: BLOCKED
session_state: CONTEXT_EXHAUSTED
role: ${live.role||chat.role}
summary: Conversation reached a hard context limit. Do not retry/continue this Chat; prepare a checkpointed replacement session.`);
          if(notification.sent) live.watchdogNotifiedAt=new Date().toISOString();
        }
        latest.tasks[live.taskId]=live; await saveRuntime(latest);
      } else if(options.autoRecover!==false && ["ERROR_RECOVERABLE","IDLE_INCOMPLETE","SUSPECT_STALL","BLOCKED"].includes(observed.sessionState)) {
        recovery=await gradedRecover(reg,chat,page,task,observed,options);
      } else if(observed.sessionState==="IDLE_COMPLETE") {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
        live.recoveryAttempts=0; live.watchErrorCount=0;
        if((live.completionMode||"durable")==="external") {
          live.status="RUNNING";
          live.externalResponsePending=true;
          live.externalResponseAt=new Date().toISOString();
          live.watchdogResultNotifiedAt=null;
          live.watchdogResultNotification=null;
          if(observed.lastAssistantId && live.externalEventAssistantId!==observed.lastAssistantId) {
            const event=await emitTaskEvent(live,"ASSISTANT_RESPONSE_READY",{
              assistantId:observed.lastAssistantId,
              assistantText:String(observed.lastAssistant||"").slice(0,131072),
              sessionState:observed.sessionState,
              recommendation:observed.recommendation||null,
              lastProgressAt:observed.lastProgressAt||null,
            });
            if(event) {
              live.externalEventAssistantId=observed.lastAssistantId;
              live.externalEventCursor=event.cursor;
            }
          }
        } else {
          if(!["COMPLETE","FAILED","CANCELLED"].includes(String(live.status).toUpperCase())) live.status="AWAITING_DURABLE_UPDATE";
          if(options.autoRecover!==false && !live.watchdogResultNotifiedAt) {
            notification=await notifyController(reg,live,`[WATCHDOG]\ntask_id: ${live.taskId}\nstatus: AWAITING_DURABLE_UPDATE\nsession_state: IDLE_COMPLETE\nrole: ${live.role||chat.role}\nsummary: Worker is idle with a new assistant result. Reconcile GitHub/callback evidence before marking COMPLETE.`);
            if(notification.sent) live.watchdogResultNotifiedAt=new Date().toISOString();
            live.watchdogResultNotification=notification;
          }
        }
        latest.tasks[live.taskId]=live; await saveRuntime(latest);
      } else if(observed.sessionState.startsWith("RUNNING")) {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
        if(["DISPATCHED","RECOVERING"].includes(String(live.status).toUpperCase())) live.status="RUNNING";
        live.watchErrorCount=0;
        if(live.lastRecoveryAt && new Date(observed.lastProgressAt)>new Date(live.lastRecoveryAt)) live.recoveryAttempts=0;
        latest.tasks[live.taskId]=live; await saveRuntime(latest);
      }
      results.push({taskId:task.taskId,role:task.role,sessionId:chat.id,state:observed.sessionState,recommendation:observed.recommendation,
        quietForSec:observed.quietForSec,runningForSec:observed.runningForSec,recovery,notification});
    } catch(error) {
      if(error?.code==="WEB_RATE_LIMITED"){ results.push({taskId:task.taskId,account:error.account,role:task.role,state:"WEB_COOLDOWN",reason:"CHATGPT_RATE_LIMIT"}); continue; }
      if(error?.code==="SPACE_IN_USER_CONTROL") {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
        live.watchdogPausedForUserControl=true;
        live.watchdogPausedAt=new Date().toISOString();
        live.watchdogPausedSpace=error.spaceName||chat?.spaceName||null;
        live.watchdogPausedOwnership=error.ownership||null;
        live.watchErrorCount=0;
        delete live.lastWatchError;
        delete live.lastWatchErrorAt;
        live.updatedAt=new Date().toISOString();
        latest.tasks[live.taskId]=live;
        await saveRuntime(latest);
        results.push({taskId:task.taskId,role:task.role,sessionId:chat?.id||task.sessionId||null,
          state:"USER_CONTROLLED",paused:true,spaceName:live.watchdogPausedSpace,ownership:live.watchdogPausedOwnership});
        continue;
      }
      const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
      live.watchErrorCount=Number(live.watchErrorCount||0)+1; live.lastWatchError=error.message; live.lastWatchErrorAt=new Date().toISOString();
      let notification=null;
      if(options.autoRecover!==false && live.watchErrorCount>=3 && live.status!=="BLOCKED") {
        live.status="BLOCKED"; live.blockedReason=`watch failed ${live.watchErrorCount} times: ${error.message}`;
        notification=await notifyController(reg,live,`[WATCHDOG]\ntask_id: ${live.taskId}\nstatus: BLOCKED\nrole: ${live.role||"unknown"}\nsummary: ${live.blockedReason}`);
        if(notification.sent) live.watchdogNotifiedAt=new Date().toISOString();
      }
      latest.tasks[live.taskId]=live; await saveRuntime(latest);
      results.push({taskId:task.taskId,role:task.role,sessionId:chat?.id||task.sessionId||null,state:"WATCH_ERROR",error:error.message,watchErrorCount:live.watchErrorCount,notification});
    }
  }
  const lifecycleProjects=options.skipLifecycle?[]:(project ? [project] : Object.keys(reg.projects||{}).filter(p=>normalizeLifecycle(reg.projects[p]).autoReconcile));
  for(const p of lifecycleProjects) {
    if(account && activeAccount(reg,p,null)!==account) continue;
    if(options.autoRecover===false) {
      const latest=await loadRuntime();
      const candidate=reconcileCandidate(p,projectRecord(reg,p),Object.values(latest.tasks||{}),latest.projects[p]||{},Date.now());
      if(candidate) results.push({project:p,projectLifecycle:{...candidate,state:candidate.ready?"DRY_RUN_READY":"DRY_RUN_DEFERRED"}});
      continue;
    }
    const waitMs=Math.max(0,taskGapMs-(Date.now()-lastVisitedAt));
    if(waitMs && lastVisitedAt) await new Promise(resolve=>setTimeout(resolve,waitMs));
    const lifecycle=await maybeNotifyProjectReconcile(reg,p,account);
    if(lifecycle) { lastVisitedAt=Date.now(); results.push({project:p,projectLifecycle:lifecycle}); }
  }
  if(options.autoRecover!==false) {
    const closed=await detachTerminalTaskPages(reg,project,account);
    if(closed.length) results.push({state:"TERMINAL_TABS_DETACHED",closed});
  }
  return results;
}

async function conversationLifecycle(reg, chat, action) {
  let {page}=await ensurePage(reg,chat);
  const selector=`button[data-conversation-options-trigger="${chat.id}"]`;
  let hasTrigger=await page.waitForFunction((id)=>!!document.querySelector(`button[data-conversation-options-trigger="${id}"]`),chat.id,{timeout:5000}).then(()=>true).catch(()=>false);
  if(!hasTrigger){
    const ctl=await controlPage(reg,chat.project,chat.account);
    page=ctl.page;
    await openProjectPage(page,chat.project,ctl.binding.projectUrl||null);
    await page.reload({waitUntil:"load",timeout:20000}).catch(()=>{});
    await page.waitForTimeout(800);
    hasTrigger=await page.evaluate((id)=>!!document.querySelector(`button[data-conversation-options-trigger="${id}"]`),chat.id);
  }
  if(!hasTrigger) {
    const closedSessionPage=page.label===chat.page;
    if(closedSessionPage) await page.close().catch(()=>{});
    return {ok:true,action,alreadyAbsent:true,closedSessionPage};
  }
  await page.keyboard.press("Escape").catch(()=>{});
  const opened=await page.evaluate((id)=>{const b=document.querySelector(`button[data-conversation-options-trigger="${id}"]`); if(!b)return false; b.click(); return true;},chat.id);
  if(!opened) throw new Error(`Conversation options trigger could not be opened for ${chat.id}`);
  await page.waitForFunction(()=>[...document.querySelectorAll('[role="menuitem"]')].some(x=>(x.innerText||'').trim()==="Archive"),undefined,{timeout:5000});
  const clicked=await page.evaluate((label)=>{
    const item=[...document.querySelectorAll('[role="menuitem"]')].find(x=>(x.innerText||'').trim()===label);
    if(!item) return false; item.click(); return true;
  },action==="delete"?"Delete":"Archive");
  if(!clicked) throw new Error(`Conversation ${action} menu item not found`);
  if(action==="delete"){
    const confirmedReady=await page.waitForFunction(()=>{
      const scope=document.querySelector('[role="dialog"]')||document.body;
      return [...scope.querySelectorAll('button')].some(x=>(x.innerText||'').trim()==="Delete"||['confirm-delete-conversation','delete-conversation-confirm-button'].includes(x.getAttribute('data-testid')));
    },undefined,{timeout:5000}).then(()=>true).catch(()=>false);
    if(!confirmedReady) throw new Error("Delete confirmation control not found");
    const ok=await page.evaluate(()=>{
      const scope=document.querySelector('[role="dialog"]')||document.body;
      const b=[...scope.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==="Delete"||['confirm-delete-conversation','delete-conversation-confirm-button'].includes(x.getAttribute('data-testid')));
      if(!b) return false; b.click(); return true;
    });
    if(!ok) throw new Error("Delete confirmation control could not be clicked");
  }
  await page.waitForTimeout(500);
  const ctl=await controlPage(reg,chat.project,chat.account);
  let stillVisible=true;
  for(let attempt=0; attempt<5 && stillVisible; attempt++) {
    await openProjectPage(ctl.page,chat.project,ctl.binding.projectUrl||null);
    await ctl.page.reload({waitUntil:"load",timeout:20000}).catch(()=>{});
    await ctl.page.waitForTimeout(1000);
    stillVisible=await ctl.page.evaluate((id)=>!!document.querySelector(`button[data-conversation-options-trigger="${id}"]`),chat.id);
    if(stillVisible) await ctl.page.waitForTimeout(1000);
  }
  if(stillVisible) throw new Error(`Conversation ${action} was not confirmed by project UI: ${chat.id}`);
  const closedSessionPage=page.label===chat.page;
  if(closedSessionPage && page.label!==ctl.page.label) await page.close().catch(()=>{});
  return {ok:true,action,closedSessionPage};
}

async function pruneProjectSpace(reg, project, account=null) {
  const a=activeAccount(reg,project,account), {binding,task}=await openBoundTask(reg,project,a);
  const rt=await loadRuntime();
  const detached=[];
  while(true) {
    const item=await reclaimIdlePageSlot(reg,project,a,task,binding,null);
    if(!item) break;
    detached.push(item);
  }
  const pages=await pagesOf(task), tabs=await task.tabs().catch(()=>[]);
  const protection=spaceProtection(reg,rt,binding,task);
  for(const tab of tabs) if(tab.active&&tab.label) protection.labels.add(tab.label);
  const closed=[];
  for(const page of pages) {
    if(protection.labels.has(page.label)) continue;
    const tab=tabs.find(item=>item.label===page.label);
    if(!tab || tab.active || tab.openedBy!=="agent") continue;
    const snapshot=await state(page).catch(()=>null);
    if(!snapshot || snapshot.generating || String(snapshot.composerText||"").trim()) continue;
    try { await page.close(); }
    catch { continue; }
    closed.push(page.label);
    for(const chat of Object.values(reg.chats||{})) {
      if(samePhysicalSpace(chat,binding,task) && chat.page===page.label) {
        chat.page=null;
        chat.detachedAt=new Date().toISOString();
        chat.attachmentEpoch=Number(chat.attachmentEpoch||0)+1;
      }
    }
  }
  if(closed.length) await saveRegistry(reg);
  return {ok:true,project,account:a,spaceName:binding.spaceName,spaceId:task.spaceId,
    protected:[...protection.labels],detached,closed};
}

async function gcAgentSpaces(reg, confirm=false) {
  if(typeof listTaskSpaces!=="function") throw new Error("Ego TaskSpace enumeration is unavailable");
  const runtime=await loadRuntime();
  const available=await listTaskSpaces();
  const candidates=SPACE_CATALOG.agentSpaceGcCandidates(reg,runtime,available);
  const summary=candidates.map(space=>({id:space.id,name:space.name,ownership:space.ownership,profileId:space.profileId||null}));
  if(!confirm) return {ok:true,dryRun:true,candidates:summary};
  const reclaimed=[], skipped=[];
  for(const candidate of candidates) {
    const fresh=(await listTaskSpaces()).find(space=>space.id===candidate.id&&space.name===candidate.name);
    if(!fresh || fresh.ownership!=="agent") {
      skipped.push({id:candidate.id,name:candidate.name,reason:"ownership_changed"});
      continue;
    }
    const stillSafe=SPACE_CATALOG.agentSpaceGcCandidates(reg,await loadRuntime(),[fresh]);
    if(!stillSafe.length) {
      skipped.push({id:candidate.id,name:candidate.name,reason:"became_bound_or_live"});
      continue;
    }
    const task=await taskSpace(fresh.id);
    await task.finish({keep:[]});
    reclaimed.push({id:fresh.id,name:fresh.name});
  }
  return {ok:true,dryRun:false,reclaimed,skipped};
}

const cmd=args[0] || "help";
const reg=await loadRegistry();
const project=opt("project",cmd==="watch"?null:reg.defaultProject);
const accountArg=opt("account",null);

if(cmd==="help"){
  print("chat-bridge commands: init [--root-controller ROLE], project ensure, policy show|set, bind, account, space, register, list, sync, discover, projects, runtime, event list, task set [--controller ROLE --reply-to ROLE --escalation-to ROLE], watch, read, status, send [--task ID --controller ROLE], ask, model, effort, stop, retry, recover, resend, new, archive, retire, delete, forget; space: show|bind|prune|gc|consolidate|scan|map|restore|label");
}
else if(cmd==="topology"){
  print(TOPOLOGY.topologyPreview(reg,await loadRuntime()));
}
else if(cmd==="init"){
  const p=project||args[1]; if(!p) throw new Error("project required");
  const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT;
  reg.defaultProject=p; reg.defaultAccount ||= a; reg.accounts[a] ||= {name:a};
  const pr=projectRecord(reg,p); pr.activeAccount=a;
  pr.rootController=opt("root-controller",pr.rootController||"conductor") || "conductor";
  const b=bindingFor(reg,p,a,true), u=opt("url",null), sp=opt("space",null);
  if(u){ b.projectUrl=u; b.projectBase=u.replace(/\/project$/,''); b.projectId=projectIdFromUrl(u); }
  if(sp){ b.spaceName=sp; b.spaceId=null; b.controlPage=null; }
  await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:b.spaceName,rootController:pr.rootController,lastCommand:"init"});
  print({ok:true,project:p,account:a,rootController:pr.rootController,spaceName:b.spaceName,projectUrl:b.projectUrl});
}
else if(cmd==="project"){
  const sub=args[1]||"ensure";
  if(sub!=="ensure") throw new Error("project subcommand must be ensure");
  const p=project||opt("project",null);
  if(!p) throw new Error("project ensure requires --project");
  const a=activeAccount(reg,p,accountArg);
  const create=args.includes("--create");
  const confirm=args.includes("--confirm");
  print(await ensureProjectLocation(reg,p,a,{create,confirm}));
}
else if(cmd==="policy"){
  const sub=args[1]||"show", p=project; if(!p) throw new Error("policy requires --project");
  const pr=projectRecord(reg,p);
  if(sub==="show") print({project:p,rootController:pr.rootController,lifecycle:normalizeLifecycle(pr),raw:pr.lifecycle});
  else if(sub==="set"){
    const auto=opt("auto-reconcile",null), role=opt("reconcile-role",null), gap=opt("min-gap-sec",null), instruction=opt("instruction",null);
    if(auto!=null) pr.lifecycle.autoReconcile=boolValue(auto,pr.lifecycle.autoReconcile===true);
    if(role!=null) pr.lifecycle.reconcileRole=String(role).trim()||null;
    if(gap!=null){ const n=Number(gap); if(!Number.isFinite(n)||n<0) throw new Error("min-gap-sec must be >= 0"); pr.lifecycle.minGapSec=n; }
    if(instruction!=null) pr.lifecycle.instruction=String(instruction).trim()||null;
    await saveRegistry(reg); await touchRuntime(p,{rootController:pr.rootController,lastCommand:"policy set"});
    print({ok:true,project:p,rootController:pr.rootController,lifecycle:normalizeLifecycle(pr),raw:pr.lifecycle});
  } else throw new Error("policy subcommand must be show or set");
}
else if(cmd==="bind"){
  const p=project||args[1]; if(!p) throw new Error("project required");
  const a=activeAccount(reg,p,accountArg), b=bindingFor(reg,p,a,true), u=opt("url",null), sp=opt("space",null);
  if(u){ b.projectUrl=u; b.projectBase=u.replace(/\/project$/,''); b.projectId=projectIdFromUrl(u); }
  if(sp){
    b.spaceName=sp; b.spaceId=null; b.controlPage=null;
    for(const c of Object.values(reg.chats)) if(c.project===p&&c.account===a&&c.status==="active"){
      c.spaceName=sp; c.spaceId=null; c.page=null;
    }
  }
  await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:b.spaceName,lastCommand:"bind"});
  print({ok:true,project:p,account:a,binding:b});
}
else if(cmd==="account"){
  const sub=args[1]||"list";
  if(sub==="list") print({defaultAccount:reg.defaultAccount,accounts:reg.accounts,projects:Object.fromEntries(Object.entries(reg.projects).map(([k,v])=>[k,v.activeAccount]))});
  else if(sub==="add"){
    const a=args[2]; if(!a) throw new Error("account name required");
    reg.accounts[a]={...(reg.accounts[a]||{}),name:a,label:opt("label",reg.accounts[a]?.label||a)};
    await saveRegistry(reg); print({ok:true,account:reg.accounts[a]});
  } else if(sub==="use"){
    const a=args[2], p=project; if(!a||!p) throw new Error("account name and --project required");
    reg.accounts[a] ||= {name:a}; projectRecord(reg,p).activeAccount=a; bindingFor(reg,p,a,true);
    await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,lastCommand:"account use"});
    print({ok:true,project:p,activeAccount:a,binding:bindingFor(reg,p,a,true)});
  } else if(sub==="identify"){
    if(!project) throw new Error("account identify requires --project");
    const a=activeAccount(reg,project,accountArg), {task,binding}=await openBoundTask(reg,project,a);
    let page=null;
    for(const candidate of await pagesOf(task)){
      if(new URL(await candidate.url()).origin==="https://chatgpt.com"){ page=candidate; break; }
    }
    if(!page) throw new Error("Open an existing ChatGPT page in the bound Space before identifying the account");
    await detectWebRateLimit(page,"account-identify");
    // Only the stable user ID leaves the page; never return or persist auth tokens.
    const identified=await page.evaluate(async()=>{
      if(location.origin!=="https://chatgpt.com") throw new Error("Account identity requires ChatGPT origin");
      const response=await fetch("/api/auth/session",{credentials:"same-origin",signal:AbortSignal.timeout(5000)});
      if(response.status===429) return {rateLimited:true};
      if(!response.ok) throw new Error("Unable to identify logged-in ChatGPT account");
      const session=await response.json();
      const id=session?.user?.id;
      if(typeof id!=="string"||!id.trim()) throw new Error("ChatGPT session has no stable user ID");
      return {id};
    });
    if(identified.rateLimited){
      const next=nextCooldown(await loadWebCooldown(a),Date.now(),"account-identify","HTTP 429");
      await saveWebCooldown(next,a); throw cooldownError(next,a);
    }
    const identity=identified.id;
    const oldIdentity=reg.accounts[a]?.identity;
    if(oldIdentity&&oldIdentity!==identity) throw new Error("ACCOUNT_IDENTITY_MISMATCH: bind this login to a different account alias");
    const previousCooldown=await loadWebCooldown(a);
    reg.accounts[a]={...reg.accounts[a],identity,identifiedAt:new Date().toISOString()};
    const shared=await loadWebCooldown(a);
    if(Date.parse(previousCooldown.until)>Date.parse(shared.until||"1970-01-01")) await saveWebCooldown(previousCooldown,a);
    binding.identityVerifiedAt=new Date().toISOString();
    await saveRegistry(reg);
    print({ok:true,account:a,scope:accountScope(reg,a),spaceName:binding.spaceName,identityVerified:true});
  } else throw new Error("account subcommand must be list, add, use, or identify");
}
else if(cmd==="space" && args[1]==="label"){
  if(!SPACE_CATALOG) throw new Error("Space catalog module not loaded");
  const name=opt("space",null), id=opt("project-id",null), label=opt("name",null);
  const item=SPACE_CATALOG.recordProjectName(reg,name,id,label);
  await saveRegistry(reg);
  print({ok:true,space:name,projectId:id,name:item.name});
}
else if(cmd==="space" && ["scan","map","restore"].includes(args[1])){
  if(!SPACE_CATALOG) throw new Error("Space catalog module not loaded");
  const sub=args[1];
  if(sub==="map") print(SPACE_CATALOG.spaceMap(reg));
  else {
    const requested=opt("space",null);
    if(sub==="scan"&&!requested) throw new Error("space scan requires --space NAME");
    const names=sub==="scan"?[requested]:requested?[requested]:Object.keys(reg.spaces);
    const available=await listTaskSpaces();
    const results=[];
    for(const name of names){
      const matches=available.filter(s=>s.name===name);
      if(matches.length>1) throw new Error(`AMBIGUOUS_SPACE: ${name}`);
      const info=matches[0];
      if(!info) throw new Error(`SPACE_NOT_FOUND: ${name}; reopen the saved Ego Space first`);
      if(info.ownership==="agentDelegatedToUser") throw new Error(`SPACE_IN_USER_CONTROL: ${name}`);
      const claimed=info.ownership==="user";
      const task=claimed?await claimTaskSpace(info.id):await taskSpace(info.id);
      let adopted=null, probe=null, verified=false;
      try {
        let tabs=await task.tabs();
        const tab=tabs.find(t=>t.url==="https://chatgpt.com/"||t.url==="https://chatgpt.com")||
          tabs.find(t=>t.active&&t.url?.startsWith("https://chatgpt.com/"))||
          tabs.find(t=>t.url?.startsWith("https://chatgpt.com/"));
        let page;
        if(tab){
          page=tab.label?task.page(tab.label):await task.adopt(tab.page);
          if(!tab.label) adopted=page.label;
        } else if(sub==="restore" && reg.spaces[name]?.projects?.length){
          page=probe=await task.newPage();
          await page.goto(reg.spaces[name].projects[0].url);
          tabs=[...tabs,{url:reg.spaces[name].projects[0].url}];
        } else throw new Error(`No open ChatGPT tab in ${name}; login cannot be verified`);
        const login=await page.evaluate(async()=>{
          if(location.origin!=="https://chatgpt.com") throw new Error("ChatGPT origin required");
          const response=await fetch("/api/auth/session",{credentials:"same-origin",signal:AbortSignal.timeout(5000)});
          if(!response.ok) throw new Error(`ChatGPT login unavailable: ${response.status}`);
          const user=(await response.json()).user;
          if(!user?.id) throw new Error("ChatGPT login ID unavailable");
          return {id:user.id,name:user.name||user.id};
        });
        if(sub==="scan"){
          const item=SPACE_CATALOG.recordSpace(reg,{name,spaceId:task.spaceId,identity:login.id,
            accountName:login.name,profileId:info.profileId,ownership:info.ownership,
            urls:tabs.map(t=>t.url)});
          await saveRegistry(reg);
          results.push({space:name,account:item.account,accountName:item.accountName,
            projectIds:item.projects.map(p=>p.id),observedAt:item.observedAt});
        } else {
          const item=reg.spaces[name];
          if(!item) throw new Error(`SPACE_NOT_RECORDED: ${name}`);
          if(item.identity!==login.id) throw new Error(`SPACE_ACCOUNT_CHANGED: ${name}`);
          verified=true;
          const opened=[];
          for(const url of SPACE_CATALOG.missingProjectUrls(item,tabs.map(t=>t.url))){
            const next=await task.newPage();
            await next.goto(url);
            opened.push(url);
          }
          results.push({space:name,account:item.account,verified:true,opened,alreadyOpen:item.projects.length-opened.length});
        }
      } finally {
        if(probe&&!verified) await probe.close();
        if(adopted) await task.release(adopted);
        if(claimed) await task.finish({keep:"all"});
      }
    }
    print({ok:true,results});
  }
}
else if(cmd==="space"){
  const sub=args[1]||"show";
  if(sub==="gc") {
    print(await gcAgentSpaces(reg,args.includes("--confirm")));
  } else if(sub==="consolidate") {
    const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT;
    print(await consolidateAccountSpace(reg,a,{confirm:args.includes("--confirm"),profileId:opt("profile",null)}));
  } else {
    const p=project; if(!p) throw new Error("--project required");
    const a=activeAccount(reg,p,accountArg), b=bindingFor(reg,p,a,true);
    if(sub==="show") print({project:p,account:a,spaceName:b.spaceName,spaceId:b.spaceId,controlPage:b.controlPage});
    else if(sub==="bind"){
      const name=args[2]; if(!name) throw new Error("space name required");
      b.spaceName=name; b.spaceId=null; b.controlPage=null;
      for(const c of Object.values(reg.chats)) if(c.project===p&&c.account===a&&c.status==="active"){
        c.spaceName=name; c.spaceId=null; c.page=null;
      }
      await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:name,lastCommand:"space bind"});
      print({ok:true,project:p,account:a,spaceName:name});
    } else if(sub==="prune"){
      const result=await pruneProjectSpace(reg,p,a);
      await touchRuntime(p,{activeAccount:a,spaceName:b.spaceName,lastCommand:"space prune"});
      print(result);
    } else throw new Error("space subcommand must be show, bind, prune, gc, or consolidate");
  }
}
else if(cmd==="register"){
  const raw=opt("url")||opt("id")||args[1]; if(!raw) throw new Error("url/id required");
  const id=convId(raw), p=project||"default", a=activeAccount(reg,p,accountArg), b=bindingFor(reg,p,a,true);
  const name=opt("name",id), role=opt("role",name), old=reg.chats[id]||{};
  reg.chats[id]={...old,id,url:String(raw).startsWith("http")?String(raw):urlFor(id),name,role,title:opt("title",old.title||name),
    project:p,account:a,status:opt("status",old.status||"active"),model:opt("model",old.model||null),effort:old.effort||null,
    spaceName:b.spaceName,spaceId:b.spaceId??null,page:opt("page",old.page||null)};
  await saveRegistry(reg); print(reg.chats[id]);
}
else if(cmd==="list"){
  const a=project?activeAccount(reg,project,accountArg):accountArg;
  print(Object.values(reg.chats).filter(c=>(!project||c.project===project)&&(!a||c.account===a)&&(args.includes("--all")||c.status==="active")));
}
else if(cmd==="projects"){
  const a=accountArg||(opt("project",null)?activeAccount(reg,project):reg.defaultAccount)||DEFAULT_ACCOUNT;
  const page=await accountPage(reg,a,opt("project",null));
  await detectWebRateLimit(page,"projects");
  const ps=await page.evaluate(()=>[...document.querySelectorAll('button[aria-label^="Open project options for "]')]
    .map(b=>(b.getAttribute("aria-label")||"").replace("Open project options for ","")));
  print([...new Set([...ps,...Object.keys(reg.projects).filter(p=>reg.projects[p].bindings?.[a])])]);
}
else if(cmd==="sync" || cmd==="discover"){
  if(project){
    const a=activeAccount(reg,project,accountArg), {binding,page}=await controlPage(reg,project,a);
    print(await syncProject(reg,page,project,a,binding));
  } else {
    const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT;
    const page=await accountPage(reg,a);
    await detectWebRateLimit(page,"discover");
    const chats=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/c/"]')].map(a=>({title:(a.innerText||a.getAttribute("aria-label")||"").trim(),url:a.href})).filter(x=>x.title&&!x.url.includes("#main")));
    const uniq=[], seen=new Set();
    for(const x of chats){const m=x.url.match(/\/c\/([0-9a-f-]+)/i);if(m&&!seen.has(m[1])){seen.add(m[1]);uniq.push({id:m[1],...x});}}
    print(uniq);
  }
}
else if(cmd==="runtime") print(await loadRuntime());
else if(cmd==="event"){
  const sub=args[1]||"list";
  if(sub!=="list") throw new Error("event subcommand must be list");
  const p=project||args[2]; if(!p) throw new Error("event list requires --project or project name");
  const a=activeAccount(reg,p,accountArg);
  const rows=await listEvents(STATE_DIR,{
    project:p,account:a,after:opt("after",null),type:opt("type",null),
    limit:Number(opt("limit","100"))||100,
  });
  print({project:p,account:a,events:rows,nextCursor:rows.length?rows[rows.length-1].cursor:opt("after",null)});
}
else if(cmd==="task"){
  const sub=args[1]||"list", rt=await loadRuntime();
  if(sub==="list"){
    const rows=Object.values(rt.tasks||{}).filter(t=>!project||t.project===project);
    print(rows);
  } else if(sub==="set"){
    const taskId=assertTaskId(args[2]);
    const old=rt.tasks[taskId]||{}, role=opt("role",old.role||null);
    const taskProject=project||old.project||null;
    const taskAccount=taskProject?activeAccount(reg,taskProject,accountArg):(accountArg||old.account||null);
    let sessionId=opt("session",old.sessionId||null);
    if(!sessionId && taskProject && role){ try { sessionId=resolveChat(reg,role,taskProject,taskAccount).id; } catch {} }
    const rootController=taskProject?projectRecord(reg,taskProject).rootController:"conductor";
    const route=controlRoute({
      ...old,
      controller:opt("controller",old.controller||null),
      replyTo:opt("reply-to",old.replyTo||null),
      escalationTo:opt("escalation-to",old.escalationTo||null),
    },rootController);
    const callerRef=opt("caller-ref",old.controllerSessionRef||null);
    const replyRef=opt("reply-to-session",old.replyToSessionRef||callerRef);
    const baselineCountText=opt("baseline-assistant-count",null);
    if(baselineCountText!==null && !/^\d+$/.test(baselineCountText)) throw new Error("baseline assistant count must be a nonnegative integer");
    if(callerRef) resolveControllerTarget(reg.chats,callerRef,taskProject);
    if(replyRef) resolveControllerTarget(reg.chats,replyRef,taskProject);
    const candidate={...old,...route,taskId,project:taskProject,role,
      controllerSessionRef:callerRef,replyToSessionRef:replyRef,
      account:opt("account",old.account||taskAccount||null),sessionId,
      issue:opt("issue",old.issue||null),github:opt("github",old.github||null),status:opt("status",old.status||"RUNNING"),
      affinityKey:opt("affinity-key",old.affinityKey||null),
      workgroupId:opt("workgroup",old.workgroupId||null),
      requestedModel:opt("model",old.requestedModel||null),
      requestedEffort:opt("effort",old.requestedEffort||null),
      resourcePolicyVersion:opt("resource-policy-version",old.resourcePolicyVersion||null),
      completionMode:normalizeCompletionMode(opt("completion-mode",old.completionMode||"durable")),
      originalMessage:opt("original-message",old.originalMessage||null),
      baselineAssistantCount:baselineCountText!==null?Number(baselineCountText):old.baselineAssistantCount,
      baselineAssistantHash:opt("baseline-assistant-hash",old.baselineAssistantHash||null),
      baselineAssistantId:opt("baseline-assistant-id",old.baselineAssistantId||null),
      dispatchedAt:opt("dispatched-at",old.dispatchedAt||null),
      stallThresholdSec:opt("stall-sec",old.stallThresholdSec||null)?Number(opt("stall-sec",old.stallThresholdSec||null)):null,
      updatedAt:new Date().toISOString()};
    candidate.createdAt ||= candidate.updatedAt;
    assertActiveTaskTarget(candidate);
    const conflict=activeSessionConflict(Object.values(rt.tasks||{}),candidate);
    if(conflict) throw new Error(`session already has active task ${conflict.taskId}; complete/clear it or use a different worker session`);
    rt.tasks[taskId]=candidate;
    await saveRuntime(rt); print(candidate);
  } else if(sub==="clear"){
    const taskId=args[2]; if(!taskId) throw new Error("task id required");
    const existed=!!rt.tasks[taskId]; delete rt.tasks[taskId]; await saveRuntime(rt); print({ok:true,taskId,existed});
  } else throw new Error("task subcommand must be list, set, or clear");
}
else if(cmd==="watch"){
  const maxAttempts=Math.max(1,Number(opt("max-recovery","3"))||3), maxTotalRecoveries=Math.max(1,Number(opt("max-total-recovery","8"))||8),
    cooldownSec=Math.max(10,Number(opt("cooldown","45"))||45), aggressive=args.includes("--aggressive"), autoRecover=!args.includes("--dry-run");
  const quiet=args.includes("--quiet");
  const results=await watchOnce(reg,project,accountArg,{autoRecover,maxAttempts,maxTotalRecoveries,cooldownSec,aggressive,
    taskId:opt("task-id",null),skipTasks:args.includes("--skip-tasks"),skipLifecycle:args.includes("--skip-lifecycle")});
  const noteworthy=results.some(r=>r.state==="WATCH_ERROR" || r.notification?.sent || r.projectLifecycle?.state==="SENT" || r.projectLifecycle?.state==="NOT_SENT" || (r.recovery?.action&&!["NONE","COOLDOWN"].includes(r.recovery.action)));
  if(!quiet || noteworthy) print({at:new Date().toISOString(),project:project||null,iteration:1,autoRecover,results});
}
else if(["archive","retire","delete","forget"].includes(cmd)){
  const key=args[1]; if(!key) throw new Error("chat key required");
  const chat=resolveChat(reg,key,project,accountArg,true);
  if(cmd==="forget"){
    delete reg.chats[chat.id]; await saveRegistry(reg); print({ok:true,forgotten:chat.id,remoteConversationUntouched:true});
  } else {
    if(cmd==="delete"&&!args.includes("--confirm")) throw new Error("delete is destructive; pass --confirm");
    await conversationLifecycle(reg,chat,cmd==="delete"?"delete":"archive");
    chat.status=cmd==="retire"?"retired":cmd==="delete"?"deleted":"archived"; chat.retiredAt=new Date().toISOString();
    chat.page=null;
    await saveRegistry(reg); await touchRuntime(chat.project,{lastCommand:cmd,lastSession:chat.id});
    print({ok:true,chat:chat.name,id:chat.id,status:chat.status});
  }
}
else if(["read","evidence","status","send","ask","model","effort","stop","retry","recover","resend"].includes(cmd)){
  const key=args[1]; if(!key) throw new Error("chat key required");
  const chat=resolveChat(reg,key,project,accountArg);
  const background=args.includes("--background")||cmd==="evidence";
  if(["send","ask","retry","recover","resend"].includes(cmd) && !background) await clearUserControlPause(chat);
  const {page,binding}=await ensurePage(reg,chat,{pauseOnUserControl:background});
  await touchRuntime(chat.project,{activeAccount:chat.account,spaceName:binding.spaceName,lastCommand:cmd,lastSession:chat.id});
  if(cmd==="read") print((await state(page)).lastAssistant);
  if(cmd==="evidence"){
    const expected=opt("expected-hash",null);
    if(!/^[0-9a-f]{64}$/.test(expected||"")) throw new Error("evidence requires --expected-hash SHA256");
    const observed=await state(page,true);
    const login=await page.evaluate(async()=>{
      const response=await fetch("/api/auth/session",{credentials:"same-origin",signal:AbortSignal.timeout(5000)});
      if(!response.ok) throw new Error("EVIDENCE_LOGIN_UNAVAILABLE");
      return (await response.json())?.user?.id||null;
    });
    if(login!==reg.accounts?.[chat.account]?.identity) throw new Error("EVIDENCE_ACCOUNT_MISMATCH");
    const normalized=text=>String(text||"").replace(/\s+/g," ").trim();
    const matches=(observed.userMessages||[]).filter(message=>
      crypto.createHash("sha256").update(normalized(message.text)).digest("hex")===expected);
    print({ok:true,project:chat.project,account:chat.account,accountId:accountScope(reg,chat.account),
      sessionRef:chat.id,url:observed.url,observedAt:new Date().toISOString(),
      messageCount:observed.messageCount,matches:matches.map(message=>({messageId:message.id,textHash:expected}))});
  }
  if(cmd==="status"){
    const rt=await loadRuntime();
    const taskId=opt("task",null);
    const linked=taskId?rt.tasks[taskId]:Object.values(rt.tasks||{}).filter(t=>activeTaskStatus(t.status) && t.project===chat.project && (t.sessionId===chat.id || (!t.sessionId&&t.role===chat.role))).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
    const observed=await observeSession(chat,page,linked||null);
    const foldedSelection=observedModel(observed.mode);
    print({...observed,modelSelection:foldedSelection,verifiedResourceSelection:{
      model:chat.verifiedModel||null,effort:chat.verifiedEffort||null,verifiedAt:chat.resourceVerifiedAt||null
    },configuredModel:chat.model||null,configuredEffort:chat.effort||null,project:chat.project||null,account:chat.account,status:chat.status,
      spaceName:chat.spaceName,spaceId:chat.spaceId,page:chat.page,task:linked?{taskId:linked.taskId,status:linked.status,completionMode:linked.completionMode||"durable",affinityKey:linked.affinityKey||null,controller:linked.controller||null,replyTo:linked.replyTo||null,escalationTo:linked.escalationTo||null,recoveryAttempts:linked.recoveryAttempts||0}:null});
  }
  if(cmd==="send"){
    const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");
    const requestedModel=opt("model",null), requestedEffort=opt("effort",null);
    const dispatchModel=await applyDispatchModel(page,chat,requestedModel,requestedEffort);
    const taskOpt=opt("task",null), taskId=taskOpt?assertTaskId(taskOpt):null; let tracked=null, priorTask=null;
    if(taskId){
      const before=await state(page), rt=await loadRuntime(), old=rt.tasks[taskId]||{};
      priorTask=rt.tasks[taskId]||null;
      const rootController=projectRecord(reg,chat.project).rootController;
      const route=controlRoute({
        ...old,
        controller:opt("controller",old.controller||null),
        replyTo:opt("reply-to",old.replyTo||null),
        escalationTo:opt("escalation-to",old.escalationTo||null),
      },rootController);
      const callerRef=opt("caller-ref",old.controllerSessionRef||null);
      const replyRef=opt("reply-to-session",old.replyToSessionRef||callerRef);
      if(callerRef) resolveControllerTarget(reg.chats,callerRef,chat.project);
      if(replyRef) resolveControllerTarget(reg.chats,replyRef,chat.project);
      tracked={...old,...route,taskId,project:chat.project,role:chat.role,account:chat.account,sessionId:chat.id,status:"DISPATCHED",
        controllerSessionRef:callerRef,replyToSessionRef:replyRef,
        affinityKey:opt("affinity-key",old.affinityKey||chat.affinityKey||null),
        workgroupId:opt("workgroup",old.workgroupId||chat.workgroupId||null),
        requestedModel:requestedModel||old.requestedModel||chat.model||null,
        requestedEffort:requestedEffort||old.requestedEffort||chat.effort||null,
        resourcePolicyVersion:opt("resource-policy-version",old.resourcePolicyVersion||null),
        completionMode:normalizeCompletionMode(opt("completion-mode",old.completionMode||"durable")),
        originalMessage:msg,baselineAssistantCount:before.assistantCount,baselineAssistantHash:hashText(before.lastAssistant||""),baselineAssistantId:before.lastAssistantId||null,
        dispatchedAt:new Date().toISOString(),recoveryAttempts:0,totalRecoveryAttempts:0,lastRecoveryAt:null,lastRecoveryMethod:null,watchErrorCount:0,watchdogNotifiedAt:null,watchdogResultNotifiedAt:null,watchdogResultNotification:null,
        updatedAt:new Date().toISOString()};
      tracked.createdAt ||= tracked.updatedAt;
      assertActiveTaskTarget(tracked);
      const conflict=activeSessionConflict(Object.values(rt.tasks||{}),tracked);
      if(conflict) throw new Error(`session already has active task ${conflict.taskId}; complete/clear it or use a different worker session`);
      rt.tasks[taskId]=tracked; await saveRuntime(rt);
    }
    let delivery=null;
    try { delivery=await sendMessage(page,msg); }
    catch(error) {
      if(tracked){
        const rt=await loadRuntime(), live=rt.tasks[taskId];
        if(isPreSendDefer(error)){
          if(live?.dispatchedAt===tracked.dispatchedAt){
            if(priorTask) rt.tasks[taskId]=priorTask; else delete rt.tasks[taskId];
            await saveRuntime(rt);
          }
        } else if(live){
          live.status="BLOCKED"; live.blockedReason=String(error?.message||error); live.updatedAt=new Date().toISOString();
          rt.tasks[taskId]=live;
          await saveRuntime(rt);
        }
      }
      throw error;
    }
    await page.waitForTimeout(250);
    const observed=await observeSession(chat,page,tracked);
    if(tracked){ const rt=await loadRuntime(), live=rt.tasks[taskId]; live.status=observed.generating?"RUNNING":"DISPATCHED"; live.blockedReason=null; live.updatedAt=new Date().toISOString(); rt.tasks[taskId]=live; await saveRuntime(rt); }
    print({ok:true,delivered:true,delivery,chat:chat.name,taskId:taskId||null,state:observed.sessionState,
      modelSelection:dispatchModel?{
        model:dispatchModel.model||dispatchModel.observed?.model||null,
        effort:dispatchModel.effort||dispatchModel.observed?.effort||null,
        raw:dispatchModel.observed?.raw||observed.mode||null,
        verified:!dispatchModel.uiModelUnverifiable,
      }:observedModel(observed.mode),dispatchModel});
  }
  if(cmd==="ask"){
    const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");
    const dispatchModel=await applyDispatchModel(page,chat,null,null);
    const st=await askMessage(page,msg,Number(opt("timeout","180000")));
    print({chat:chat.name,response:st.lastAssistant,modelSelection:dispatchModel?{
      model:dispatchModel.model||dispatchModel.observed?.model||null,
      effort:dispatchModel.effort||dispatchModel.observed?.effort||null,
      raw:dispatchModel.observed?.raw||st.mode||null,
      verified:!dispatchModel.uiModelUnverifiable,
    }:observedModel(st.mode),dispatchModel});
  }
  if(cmd==="model"){
    const m=positionals(2).join(" "); if(!m) throw new Error("model required"); const applied=await applyModelSpec(page,m,opt("effort",null));
    chat.model=applied.model;chat.effort=applied.effort;
    chat.verifiedModel=applied.model||applied.observed?.model||null;
    chat.verifiedEffort=applied.effort||applied.observed?.effort||null;
    chat.resourceVerifiedAt=new Date().toISOString();
    await saveRegistry(reg);
    print({ok:true,chat:chat.name,model:chat.model,effort:chat.effort||null,modelSelection:{
      model:chat.verifiedModel,effort:chat.verifiedEffort,raw:applied.observed?.raw||null,verified:true
    }});
  }
  if(cmd==="effort"){
    const e=positionals(2).join(" ");if(!e)throw new Error("effort required");
    await setEffort(page,e);chat.effort=e;chat.verifiedEffort=e;
    chat.resourceVerifiedAt=new Date().toISOString();
    await saveRegistry(reg);
    const folded=observedModel((await state(page)).mode);
    print({ok:true,chat:chat.name,effort:e,modelSelection:{
      model:chat.verifiedModel||folded.model||null,effort:e,raw:folded.raw||null,verified:true
    }});
  }
  if(cmd==="stop") print(await stopGeneration(page));
  if(cmd==="retry") print(await nativeRetry(page));
  if(cmd==="recover"){
    const rt=await loadRuntime(), taskId=opt("task",null);
    const linked=taskId?rt.tasks[taskId]:Object.values(rt.tasks||{}).filter(t=>activeTaskStatus(t.status) && t.project===chat.project && (t.sessionId===chat.id || (!t.sessionId&&t.role===chat.role))).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
    const observed=await observeSession(chat,page,linked||null);
    if(linked) print(await gradedRecover(reg,chat,page,linked,observed,{maxAttempts:Number(opt("max-recovery","3"))||3,cooldownSec:0,aggressive:args.includes("--aggressive")}));
    else if(observed.sessionState==="ERROR_RECOVERABLE") print(await nativeRetry(page));
    else if(observed.generating){const stopped=await stopGeneration(page);await waitForGenerationStop(page,7000);await sendMessage(page,"continue");print({ok:true,method:"stop-and-continue",stopped});}
    else {await sendMessage(page,args.includes("--aggressive")&&observed.lastUser?observed.lastUser:"continue");print({ok:true,method:args.includes("--aggressive")?"resend-last-user":"continue"});}
  }
  if(cmd==="resend"){const st=await state(page);if(!st.lastUser)throw new Error("no last user message");await sendMessage(page,st.lastUser);print({ok:true,resent:st.lastUser});}
}
else if(cmd==="new"){
  const p=project; if(!p) throw new Error("--project required");
  const a=activeAccount(reg,p,accountArg), name=opt("name","New chat"), role=opt("role",name), first=opt("message",null), affinityKey=opt("affinity-key",null), workgroupId=opt("workgroup",null);
  if(!first) throw new Error("--message required");
  const conflict=Object.values(reg.chats).find(c=>c.project===p&&c.account===a&&c.role===role&&c.status==="active");
  if(conflict&&!args.includes("--allow-duplicate-role")) throw new Error(`Active role already exists: ${role} (${conflict.id})`);
  const {task,binding}=await openBoundTask(reg,p,a), page=await newManagedPage(reg,p,a,task,binding,null);
  try {
    await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
    await openProjectPage(page,p,binding.projectUrl||null);
    await page.waitForSelector(COMPOSER_SELECTOR,{state:"visible",timeout:15000});
    const model=opt("model","Latest"), requestedEffort=opt("effort",null);
    let applied=null;
    try {
      applied=await applyModelSpec(page,model,requestedEffort);
    } catch(error) {
      if(args.includes("--strict-model") || !deferrableModelUiError(error)) throw error;
      const observed=observedModel((await state(page)).mode);
      applied={model,effort:requestedEffort||observed.effort||null,observed,deferredUntilDispatch:true};
    }
    const before=await state(page);
    await sendMessage(page,first); await page.waitForURL(/\/c\/[0-9a-f-]+/i,{timeout:30000});
    const url=await page.url(), id=convId(url), projectBase=url.includes("/g/g-p-")?url.replace(/\/c\/[^/]+.*$/,''):binding.projectBase;
    if(projectBase){binding.projectBase=projectBase;binding.projectUrl=projectBase+"/project";binding.projectId=projectIdFromUrl(projectBase);}
    reg.chats[id]={id,url,name,role,title:name,project:p,account:a,status:"active",model,effort:requestedEffort||applied.effort||null,affinityKey,workgroupId,
      verifiedModel:applied.model||applied.observed?.model||null,verifiedEffort:applied.effort||applied.observed?.effort||null,
      resourceVerifiedAt:new Date().toISOString(),
      spaceName:binding.spaceName,spaceId:task.spaceId,pageSpaceId:task.spaceId,page:page.label,attachmentEpoch:1,createdAt:new Date().toISOString()};
    await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:binding.spaceName,lastCommand:"new",lastSession:id});
    print({...reg.chats[id],modelSelection:{
      model:applied.model||applied.observed?.model||null,
      effort:applied.effort||applied.observed?.effort||null,
      raw:applied.observed?.raw||null,
      verified:true,
    },baselineAssistantCount:before.assistantCount,
      baselineAssistantHash:hashText(before.lastAssistant||""),baselineAssistantId:before.lastAssistantId||null,
      dispatchedAt:new Date().toISOString()});
  } catch (error) {
    await page.close().catch(()=>{}); throw error;
  }
}
else throw new Error("Unknown command: "+cmd);
