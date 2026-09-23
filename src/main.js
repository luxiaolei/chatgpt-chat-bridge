const fs = await import("node:fs/promises");
const os = await import("node:os");
const pathMod = await import("node:path");
const args = globalThis.__CHAT_BRIDGE_ARGS__ || [];
const HOME = os.homedir();
const CONFIG_DIR = globalThis.__CHAT_BRIDGE_CONFIG_DIR__ || process.env.CHAT_BRIDGE_CONFIG_DIR || pathMod.join(HOME, ".config", "chat-bridge");
const STATE_DIR = globalThis.__CHAT_BRIDGE_STATE_DIR__ || process.env.CHAT_BRIDGE_STATE_DIR || pathMod.join(HOME, ".local", "state", "chat-bridge");
const REG_PATH = pathMod.join(CONFIG_DIR, "registry.json");
const RUNTIME_PATH = pathMod.join(STATE_DIR, "runtime.json");
const DEFAULT_ACCOUNT = "default";
const CONTROL = globalThis.__CHAT_BRIDGE_CONTROL__;
if(!CONTROL) throw new Error("chat-bridge control routing module was not loaded");
const { controlRoute, notificationTargets } = CONTROL;
const PAGE_POOL = globalThis.__CHAT_BRIDGE_PAGE_POOL__;
if(!PAGE_POOL) throw new Error("chat-bridge page pool module was not loaded");
const { pageDetachCandidates } = PAGE_POOL;

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
  return { version: 2, defaultProject: null, defaultAccount: DEFAULT_ACCOUNT, accounts: {}, projects: {}, chats: {} };
}
function normalizeRegistry(raw) {
  const reg={...emptyRegistry(),...(raw||{})};
  reg.accounts ||= {}; reg.projects ||= {}; reg.chats ||= {};
  reg.defaultAccount ||= DEFAULT_ACCOUNT;
  reg.accounts[reg.defaultAccount] ||= {name:reg.defaultAccount};
  for (const [name,p0] of Object.entries(reg.projects)) {
    const p=p0||{}; p.name ||= name; p.activeAccount ||= reg.defaultAccount; p.rootController ||= "conductor"; p.bindings ||= {};
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
  try { return normalizeRuntime(JSON.parse(await fs.readFile(RUNTIME_PATH,"utf8"))); }
  catch { return normalizeRuntime({}); }
}
async function saveRuntime(runtime) {
  runtime=normalizeRuntime(runtime);
  await fs.mkdir(pathMod.dirname(RUNTIME_PATH),{recursive:true});
  await fs.writeFile(RUNTIME_PATH,JSON.stringify(runtime,null,2)+"\n");
}
async function touchRuntime(project, patch={}) {
  const rt=await loadRuntime();
  if(project) rt.projects[project]={...(rt.projects[project]||{}),...patch,updatedAt:new Date().toISOString()};
  await saveRuntime(rt); return rt;
}

async function loadRegistry() {
  try { return normalizeRegistry(JSON.parse(await fs.readFile(REG_PATH, "utf8"))); }
  catch { return emptyRegistry(); }
}
async function saveRegistry(reg) {
  reg=normalizeRegistry(reg);
  await fs.mkdir(pathMod.dirname(REG_PATH), { recursive: true });
  await fs.writeFile(REG_PATH, JSON.stringify(reg, null, 2) + "\n");
}
function opt(name, def=null) {
  const i=args.indexOf("--"+name); return i>=0 ? args[i+1] : def;
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
  reg.projects[project] ||= {name:project,activeAccount:reg.defaultAccount||DEFAULT_ACCOUNT,rootController:"conductor",bindings:{}};
  const p=reg.projects[project]; p.activeAccount ||= reg.defaultAccount||DEFAULT_ACCOUNT; p.rootController ||= "conductor"; p.bindings ||= {}; return p;
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
  if(reg.chats[key] && reg.chats[key].status!=="deleted" && (includeInactive || reg.chats[key].status==="active")) return reg.chats[key];
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
async function openBoundTask(reg, project, account=null) {
  const b=bindingFor(reg,project,account,true), task=await taskSpace(b.spaceName);
  if(Number(b.spaceId)!==Number(task.spaceId)){ b.spaceId=task.spaceId; await saveRegistry(reg); }
  return {binding:b,task};
}
async function reclaimIdlePageSlot(reg, project, account, task, binding, excludeChatId=null) {
  const rt=await loadRuntime();
  const tabs=await task.tabs().catch(()=>[]);
  const activeLabels=tabs.filter(t=>t.active&&t.label).map(t=>t.label);
  const candidates=pageDetachCandidates(
    Object.values(reg.chats||{}),
    Object.values(rt.tasks||{}),
    {
      project,
      account,
      controlPage:binding.controlPage||null,
      excludeChatIds:excludeChatId?[excludeChatId]:[],
      excludePageLabels:activeLabels,
    }
  );
  for(const candidate of candidates) {
    let page=null;
    try { page=task.page(candidate.page); }
    catch {
      candidate.page=null;
      candidate.detachedAt=new Date().toISOString();
      await saveRegistry(reg);
      continue;
    }
    const snapshot=await state(page).catch(()=>null);
    if(!snapshot || snapshot.generating || String(snapshot.composerText||"").trim()) continue;
    await page.close().catch(()=>{});
    const oldPage=candidate.page;
    candidate.page=null;
    candidate.detachedAt=new Date().toISOString();
    await saveRegistry(reg);
    return {chatId:candidate.id,role:candidate.role,page:oldPage};
  }
  return null;
}

async function newManagedPage(reg, project, account, task, binding, excludeChatId=null) {
  try { return await task.newPage(); }
  catch(error) {
    if(!/page budget reached/i.test(String(error?.message||error))) throw error;
    const reclaimed=await reclaimIdlePageSlot(reg,project,account,task,binding,excludeChatId);
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
async function ensurePage(reg, chat) {
  const {binding,task}=await openBoundTask(reg,chat.project,chat.account), pages=await pagesOf(task);
  let page=pages.find(p=>p.label===chat.page) || null;
  if(!page) page=await newManagedPage(reg,chat.project,chat.account,task,binding,chat.id);
  chat.spaceName=binding.spaceName; chat.spaceId=task.spaceId; chat.page=page.label; chat.lastUsedAt=new Date().toISOString();
  if((await page.url())!==chat.url) await page.goto(chat.url,{waitUntil:"load",timeout:20000});
  await saveRegistry(reg); return {task,page,binding};
}

function hashText(v="") {
  let h=2166136261;
  for(const ch of String(v)) { h^=ch.charCodeAt(0); h=Math.imul(h,16777619); }
  return (h>>>0).toString(16).padStart(8,"0");
}
function stallThresholdSec(effort=null) {
  const key=String(effort||"").toLowerCase();
  if(key==="pro") return 900;
  if(key==="extra high") return 720;
  if(key==="high") return 480;
  if(key==="medium") return 300;
  return 240;
}
function activeTaskStatus(v="") {
  return !["COMPLETE","FAILED","CANCELLED","BLOCKED"].includes(String(v).toUpperCase());
}

async function state(page) {
  return await page.evaluate(() => {
    const root=document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    if(!globalThis.__CHAT_BRIDGE_WATCH || globalThis.__CHAT_BRIDGE_WATCH.root!==root) {
      try { globalThis.__CHAT_BRIDGE_WATCH?.observer?.disconnect?.(); } catch {}
      const watch={root,seq:0,lastMutationAt:Date.now(),startedAt:Date.now(),observer:null};
      watch.observer=new MutationObserver((records)=>{
        let meaningful=false;
        for(const r of records) {
          const t=r.target?.nodeType===Node.ELEMENT_NODE?r.target:r.target?.parentElement;
          if(t?.closest?.('[data-message-author-role]') || t?.closest?.('[role="alert"], [data-testid*="error" i]') ||
             t?.matches?.('button[data-testid="send-button"], button[data-testid*="stop" i]')) { meaningful=true; break; }
        }
        if(meaningful){ watch.seq+=1; watch.lastMutationAt=Date.now(); }
      });
      try { watch.observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["aria-label","aria-disabled","disabled","data-testid","data-state"]}); } catch {}
      globalThis.__CHAT_BRIDGE_WATCH=watch;
    }
    const ms=[...document.querySelectorAll('[data-message-author-role]')].map(e=>({
      role:e.getAttribute('data-message-author-role'), id:e.getAttribute('data-message-id')||null, text:(e.innerText||'').trim()
    }));
    const buttons=[...document.querySelectorAll('button')];
    const norm=b=>((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('data-testid')||'')+' '+(b.innerText||'')).trim();
    const stop=buttons.find(b=>/\bstop\b/i.test(norm(b)) || /stop/i.test(b.getAttribute('data-testid')||''));
    const send=buttons.find(b=>b.getAttribute('data-testid')==='send-button' || /\bsend\b/i.test(norm(b)));
    const recoveryWords=["continue generating","try again","retry","regenerate"];
    const recoveryControls=buttons.map(b=>({label:norm(b),disabled:!!b.disabled||b.getAttribute('aria-disabled')==='true'}))
      .filter(x=>!x.disabled && recoveryWords.some(k=>x.label.toLowerCase().includes(k)));
    const alerts=[...document.querySelectorAll('[role="alert"], [data-testid*="error" i]')]
      .map(x=>(x.innerText||'').trim()).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(-8);
    const errorWords=["something went wrong","error generating","network error","unable to load conversation","try again later"];
    const knownErrors=[...document.querySelectorAll('main div, main span, main p, [role="main"] div, [role="main"] span, [role="main"] p')]
      .filter(x=>!x.closest('[data-message-author-role]')).map(x=>(x.innerText||'').trim()).filter(v=>v && v.length<300)
      .filter(v=>errorWords.some(k=>v.toLowerCase().includes(k))).filter((v,i,a)=>a.indexOf(v)===i).slice(-5);
    const form=document.querySelector('form');
    const composerEl=document.querySelector('div#prompt-textarea[contenteditable="true"], [data-testid="prompt-textarea"][contenteditable="true"], form [contenteditable="true"]');
    const composer=!!composerEl;
    const composerText=(composerEl?.innerText||composerEl?.textContent||"").trim();
    const mode=[...(form?.querySelectorAll('button')||[])].map(b=>(b.innerText||'').trim())
      .find(t=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test(t)) || null;
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
      messageCount:ms.length,assistantCount:ms.filter(x=>x.role==='assistant').length,
      assistantChars:lastAssistant?.length||0,
      mutationSeq:globalThis.__CHAT_BRIDGE_WATCH.seq,
      mutationLastAt:new Date(globalThis.__CHAT_BRIDGE_WATCH.lastMutationAt).toISOString(),
      observerStartedAt:new Date(globalThis.__CHAT_BRIDGE_WATCH.startedAt).toISOString()
    };
  });
}

function classifySnapshot(raw, heartbeat, task=null, effort=null) {
  const quietForSec=heartbeat.quietForSec||0;
  const threshold=Number(task?.stallThresholdSec)||stallThresholdSec(effort||raw.mode);
  let sessionState="IDLE", recommendation="NONE";
  if(!raw.online || !raw.composerPresent) { sessionState="BLOCKED"; recommendation="ESCALATE"; }
  else if(raw.recoveryControls?.length || raw.errorTexts?.length) { sessionState="ERROR_RECOVERABLE"; recommendation="RECOVER_NATIVE"; }
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

async function sendMessage(page, msg) {
  await page.focus('div#prompt-textarea[contenteditable="true"]');
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(msg);
  await page.waitForTimeout(80);
  const hasSend=await page.evaluate(()=>!!document.querySelector('button[data-testid="send-button"]'));
  if(hasSend) await page.click('button[data-testid="send-button"]');
  else await page.keyboard.press("Enter");
}

async function askMessage(page, msg, timeout=180000) {
  const before=await state(page);
  await sendMessage(page,msg);
  await page.waitForFunction((n) => {
    const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const stop=[...document.querySelectorAll("button")].some(b =>
      /stop/i.test((b.getAttribute("aria-label")||"")+" "+(b.innerText||"")) ||
      /stop/i.test(b.getAttribute("data-testid")||""));
    return a.length>n && !stop && (a[a.length-1].innerText||"").trim().length>0;
  }, before.assistantCount, {timeout});
  return await state(page);
}

async function openModelMenu(page) {
  await page.waitForFunction(() => [...document.querySelectorAll("form button")]
    .some(x=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test((x.innerText||"").trim())), undefined, {timeout:15000});
  const ok=await page.evaluate(() => {
    document.querySelectorAll("[data-chat-bridge-model-button]").forEach(e=>e.removeAttribute("data-chat-bridge-model-button"));
    const form=document.querySelector("form");
    const b=[...(form?.querySelectorAll("button")||[])].find(x=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test((x.innerText||"").trim()));
    if(!b) return false;
    b.setAttribute("data-chat-bridge-model-button","1");
    return true;
  });
  if(!ok) throw new Error("Model/effort button not found");
  await page.click('button[data-chat-bridge-model-button="1"]');
  await page.waitForTimeout(200);
}
async function setModel(page, model) {
  await page.keyboard.press("Escape");
  await openModelMenu(page);
  const result=await page.evaluate((model)=>{
    const items=[...document.querySelectorAll('[role="menuitemradio"]')];
    const x=items.find(e=>(e.innerText||"").trim().toLowerCase()===model.toLowerCase());
    if(!x) return {ok:false,available:items.map(e=>(e.innerText||"").trim())};
    x.click();
    return {ok:true};
  }, model);
  if(!result.ok){
    await page.keyboard.press("Escape");
    throw new Error("Model not found: "+model+"; available="+result.available.join(", "));
  }
  await page.waitForTimeout(250);
  const checked=await page.evaluate((model)=>[...document.querySelectorAll('[role="menuitemradio"]')]
    .some(e=>(e.innerText||"").trim().toLowerCase()===model.toLowerCase() && e.getAttribute("aria-checked")==="true"), model);
  await page.keyboard.press("Escape");
  if(!checked) throw new Error("Model selection was not confirmed: "+model);
  return true;
}
async function setEffort(page, effort) {
  const levels={"instant":0,"medium":1,"high":2,"extra high":3,"pro":4};
  const key=effort.toLowerCase();
  if(!(key in levels)) throw new Error("Effort must be Instant, Medium, High, Extra High, or Pro");
  await page.keyboard.press("Escape");
  await openModelMenu(page);
  const has=await page.evaluate(()=>!!document.querySelector('[role="slider"]'));
  if(!has){
    await page.keyboard.press("Escape");
    throw new Error("Thinking effort slider not available");
  }
  await page.focus('[role="slider"]');
  await page.keyboard.press("Home");
  for(let i=0;i<levels[key];i++) await page.keyboard.press("ArrowRight");
  const now=await page.evaluate(()=>Number(document.querySelector('[role="slider"]')?.getAttribute("aria-valuenow")));
  await page.keyboard.press("Escape");
  if(now!==levels[key]) throw new Error("Effort selection was not confirmed");
  return true;
}

function modelPreset(spec) {
  const raw=(spec||"").trim();
  const key=raw.toLowerCase().replace(/[-_]/g," ").replace(/\s+/g," ");
  if(["gpt 6 pro","gpt6 pro","latest pro","gpt 6"].includes(key)) {
    return {radio:"Latest",effort:"Pro",label:"GPT-6 Pro"};
  }
  return {radio:raw,effort:null,label:raw};
}

async function applyModelSpec(page, spec, explicitEffort=null) {
  const preset=modelPreset(spec);
  await setModel(page,preset.radio);
  const effort=explicitEffort || preset.effort;
  if(effort) await setEffort(page,effort);
  return {model:preset.label,effort};
}

async function openProjectPage(page, projectName, knownUrl=null) {
  const current=await page.url();
  if(current.includes("/g/g-p-") && current.endsWith("/project")) {
    const title=await page.title();
    if(title.toLowerCase().includes(projectName.toLowerCase())) return current;
  }
  if(knownUrl) {
    await page.goto(knownUrl, {waitUntil:"load",timeout:20000});
    await page.waitForSelector('div#prompt-textarea[contenteditable="true"]',{state:"visible",timeout:15000});
    return await page.url();
  }
  await page.goto("https://chatgpt.com/", {waitUntil:"load",timeout:20000});
  await page.waitForTimeout(500);
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
  await page.click('button[data-chat-bridge-open-project="1"]');
  await page.waitForURL(/\/g\/g-p-[^/]+\/project/, {timeout:15000});
  return await page.url();
}

async function syncProject(reg, page, projectName, account, binding) {
  const projectUrl=await openProjectPage(page,projectName,binding?.projectUrl||null);
  await page.reload({waitUntil:"load",timeout:20000}).catch(()=>{});
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
      const controller=resolveChat(reg,target,task.project,task.account||null);
      if(controller.id===task.sessionId) {
        failures.push({target,reason:"target is task session"});
        continue;
      }
      const {page}=await ensurePage(reg,controller);
      await sendMessage(page,message);
      return {sent:true,target,role:controller.role||controller.name,targets};
    } catch(error) {
      failures.push({target,reason:error.message});
    }
  }
  return {sent:false,targets,failures};
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
      live.watchdogNotifiedAt=now.toISOString();
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

async function watchOnce(reg, project=null, account=null, options={}) {
  const rt=await loadRuntime(), results=[];
  const taskGapMs=Math.max(5000,Number(process.env.CHAT_BRIDGE_WATCH_TASK_GAP_MS||5000)||5000);
  const tasks=Object.values(rt.tasks||{}).filter(t=>activeTaskStatus(t.status) && (!project||t.project===project) && (!account||t.account===account));
  for(const task of tasks) {
    if(results.length) await new Promise(resolve=>setTimeout(resolve,taskGapMs));
    let chat=null;
    try {
      chat=task.sessionId?resolveChat(reg,task.sessionId,task.project,task.account):resolveChat(reg,task.role,task.project,task.account);
      if(!task.sessionId) task.sessionId=chat.id;
      const {page}=await ensurePage(reg,chat);
      const observed=await observeSession(chat,page,task);
      let recovery={action:"NONE"}, notification=null;
      if(options.autoRecover!==false && ["ERROR_RECOVERABLE","IDLE_INCOMPLETE","SUSPECT_STALL","BLOCKED"].includes(observed.sessionState)) {
        recovery=await gradedRecover(reg,chat,page,task,observed,options);
      } else if(observed.sessionState==="IDLE_COMPLETE") {
        const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
        if(!["COMPLETE","FAILED","CANCELLED"].includes(String(live.status).toUpperCase())) live.status="AWAITING_DURABLE_UPDATE";
        live.recoveryAttempts=0; live.watchErrorCount=0;
        if(options.autoRecover!==false && !live.watchdogResultNotifiedAt) {
          notification=await notifyController(reg,live,`[WATCHDOG]\ntask_id: ${live.taskId}\nstatus: AWAITING_DURABLE_UPDATE\nsession_state: IDLE_COMPLETE\nrole: ${live.role||chat.role}\nsummary: Worker is idle with a new assistant result. Reconcile GitHub/callback evidence before marking COMPLETE.`);
          live.watchdogResultNotifiedAt=new Date().toISOString(); live.watchdogResultNotification=notification;
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
      const latest=await loadRuntime(), live=latest.tasks[task.taskId]||task;
      live.watchErrorCount=Number(live.watchErrorCount||0)+1; live.lastWatchError=error.message; live.lastWatchErrorAt=new Date().toISOString();
      let notification=null;
      if(options.autoRecover!==false && live.watchErrorCount>=3 && live.status!=="BLOCKED") {
        live.status="BLOCKED"; live.blockedReason=`watch failed ${live.watchErrorCount} times: ${error.message}`;
        notification=await notifyController(reg,live,`[WATCHDOG]\ntask_id: ${live.taskId}\nstatus: BLOCKED\nrole: ${live.role||"unknown"}\nsummary: ${live.blockedReason}`);
        live.watchdogNotifiedAt=new Date().toISOString();
      }
      latest.tasks[live.taskId]=live; await saveRuntime(latest);
      results.push({taskId:task.taskId,role:task.role,sessionId:chat?.id||task.sessionId||null,state:"WATCH_ERROR",error:error.message,watchErrorCount:live.watchErrorCount,notification});
    }
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
  const pages=await pagesOf(task), keep=new Set([binding.controlPage].filter(Boolean));
  for(const c of Object.values(reg.chats)) {
    if(c.project===project && c.account===a && c.status==="active" && c.page) keep.add(c.page);
  }
  const closed=[];
  for(const page of pages) {
    if(keep.has(page.label)) continue;
    await page.close().catch(()=>{}); closed.push(page.label);
  }
  return {ok:true,project,account:a,spaceName:binding.spaceName,spaceId:task.spaceId,kept:[...keep],closed};
}

const cmd=args[0] || "help";
const reg=await loadRegistry();
const project=opt("project",reg.defaultProject);
const accountArg=opt("account",null);

if(cmd==="help"){
  print("chat-bridge commands: init [--root-controller ROLE], bind, account, space, register, list, sync, discover, projects, runtime, task set [--controller ROLE --reply-to ROLE --escalation-to ROLE], watch, read, status, send [--task ID --controller ROLE], ask, model, effort, stop, retry, recover, resend, new, archive, retire, delete, forget; space: show|bind|prune");
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
  } else throw new Error("account subcommand must be list, add, or use");
}
else if(cmd==="space"){
  const sub=args[1]||"show", p=project; if(!p) throw new Error("--project required");
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
  } else throw new Error("space subcommand must be show, bind, or prune");
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
  const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT, task=await taskSpace(`chat-bridge-account-${slug(a)}-global`);
  const pages=await pagesOf(task), page=pages.find(p=>p.label==="p1")||pages[0]||await task.newPage();
  await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000}); await page.waitForTimeout(500);
  const ps=await page.evaluate(()=>[...document.querySelectorAll('button[aria-label^="Open project options for "]')]
    .map(b=>(b.getAttribute("aria-label")||"").replace("Open project options for ","")));
  print([...new Set([...ps,...Object.keys(reg.projects)])]);
}
else if(cmd==="sync" || cmd==="discover"){
  if(project){
    const a=activeAccount(reg,project,accountArg), {binding,page}=await controlPage(reg,project,a);
    print(await syncProject(reg,page,project,a,binding));
  } else {
    const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT, task=await taskSpace(`chat-bridge-account-${slug(a)}-global`);
    const pages=await pagesOf(task), page=pages.find(p=>p.label==="p1")||pages[0]||await task.newPage();
    await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000}); await page.waitForTimeout(500);
    const chats=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/c/"]')].map(a=>({title:(a.innerText||a.getAttribute("aria-label")||"").trim(),url:a.href})).filter(x=>x.title&&!x.url.includes("#main")));
    const uniq=[], seen=new Set();
    for(const x of chats){const m=x.url.match(/\/c\/([0-9a-f-]+)/i);if(m&&!seen.has(m[1])){seen.add(m[1]);uniq.push({id:m[1],...x});}}
    print(uniq);
  }
}
else if(cmd==="runtime") print(await loadRuntime());
else if(cmd==="task"){
  const sub=args[1]||"list", rt=await loadRuntime();
  if(sub==="list"){
    const rows=Object.values(rt.tasks||{}).filter(t=>!project||t.project===project);
    print(rows);
  } else if(sub==="set"){
    const taskId=args[2]; if(!taskId) throw new Error("task id required");
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
    rt.tasks[taskId]={...old,...route,taskId,project:taskProject,role,
      account:opt("account",old.account||taskAccount||null),sessionId,
      issue:opt("issue",old.issue||null),github:opt("github",old.github||null),status:opt("status",old.status||"RUNNING"),
      stallThresholdSec:opt("stall-sec",old.stallThresholdSec||null)?Number(opt("stall-sec",old.stallThresholdSec||null)):null,
      updatedAt:new Date().toISOString()};
    rt.tasks[taskId].createdAt ||= rt.tasks[taskId].updatedAt;
    await saveRuntime(rt); print(rt.tasks[taskId]);
  } else if(sub==="clear"){
    const taskId=args[2]; if(!taskId) throw new Error("task id required");
    const existed=!!rt.tasks[taskId]; delete rt.tasks[taskId]; await saveRuntime(rt); print({ok:true,taskId,existed});
  } else throw new Error("task subcommand must be list, set, or clear");
}
else if(cmd==="watch"){
  const loop=args.includes("--loop"), intervalSec=Math.max(10,Number(opt("interval","15"))||15),
    maxAttempts=Math.max(1,Number(opt("max-recovery","3"))||3), maxTotalRecoveries=Math.max(1,Number(opt("max-total-recovery","8"))||8),
    cooldownSec=Math.max(10,Number(opt("cooldown","45"))||45), aggressive=args.includes("--aggressive"), autoRecover=!args.includes("--dry-run"), maxIterations=Number(opt("iterations","0"))||0;
  const quiet=args.includes("--quiet");
  let iteration=0;
  do {
    const watchReg=iteration===0?reg:await loadRegistry();
    const results=await watchOnce(watchReg,project,accountArg,{autoRecover,maxAttempts,maxTotalRecoveries,cooldownSec,aggressive});
    const noteworthy=results.some(r=>r.state==="WATCH_ERROR" || r.notification?.sent || (r.recovery?.action&&!["NONE","COOLDOWN"].includes(r.recovery.action)));
    if(!quiet || noteworthy) print({at:new Date().toISOString(),project:project||null,iteration:iteration+1,autoRecover,results});
    iteration+=1;
    if(!loop || (maxIterations>0 && iteration>=maxIterations)) break;
    await new Promise(resolve=>setTimeout(resolve,intervalSec*1000));
  } while(true);
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
else if(["read","status","send","ask","model","effort","stop","retry","recover","resend"].includes(cmd)){
  const key=args[1]; if(!key) throw new Error("chat key required");
  const chat=resolveChat(reg,key,project,accountArg), {page,binding}=await ensurePage(reg,chat);
  await touchRuntime(chat.project,{activeAccount:chat.account,spaceName:binding.spaceName,lastCommand:cmd,lastSession:chat.id});
  if(cmd==="read") print((await state(page)).lastAssistant);
  if(cmd==="status"){
    const rt=await loadRuntime();
    const taskId=opt("task",null);
    const linked=taskId?rt.tasks[taskId]:Object.values(rt.tasks||{}).filter(t=>activeTaskStatus(t.status) && t.project===chat.project && (t.sessionId===chat.id || (!t.sessionId&&t.role===chat.role))).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")))[0];
    const observed=await observeSession(chat,page,linked||null);
    print({...observed,configuredModel:chat.model||null,configuredEffort:chat.effort||null,project:chat.project||null,account:chat.account,status:chat.status,
      spaceName:chat.spaceName,spaceId:chat.spaceId,page:chat.page,task:linked?{taskId:linked.taskId,status:linked.status,controller:linked.controller||null,replyTo:linked.replyTo||null,escalationTo:linked.escalationTo||null,recoveryAttempts:linked.recoveryAttempts||0}:null});
  }
  if(cmd==="send"){
    const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");
    const taskId=opt("task",null); let tracked=null;
    if(taskId){
      const before=await state(page), rt=await loadRuntime(), old=rt.tasks[taskId]||{};
      const rootController=projectRecord(reg,chat.project).rootController;
      const route=controlRoute({
        ...old,
        controller:opt("controller",old.controller||null),
        replyTo:opt("reply-to",old.replyTo||null),
        escalationTo:opt("escalation-to",old.escalationTo||null),
      },rootController);
      tracked={...old,...route,taskId,project:chat.project,role:chat.role,account:chat.account,sessionId:chat.id,status:"DISPATCHED",
        originalMessage:msg,baselineAssistantCount:before.assistantCount,baselineAssistantHash:hashText(before.lastAssistant||""),baselineAssistantId:before.lastAssistantId||null,
        dispatchedAt:new Date().toISOString(),recoveryAttempts:0,totalRecoveryAttempts:0,lastRecoveryAt:null,lastRecoveryMethod:null,watchErrorCount:0,watchdogNotifiedAt:null,watchdogResultNotifiedAt:null,
        updatedAt:new Date().toISOString()};
      tracked.createdAt ||= tracked.updatedAt; rt.tasks[taskId]=tracked; await saveRuntime(rt);
    }
    await sendMessage(page,msg); await page.waitForTimeout(400);
    const observed=await observeSession(chat,page,tracked);
    if(tracked){ const rt=await loadRuntime(), live=rt.tasks[taskId]; live.status=observed.generating?"RUNNING":"DISPATCHED"; live.updatedAt=new Date().toISOString(); rt.tasks[taskId]=live; await saveRuntime(rt); }
    print({ok:true,chat:chat.name,taskId:taskId||null,state:observed.sessionState});
  }
  if(cmd==="ask"){const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");const st=await askMessage(page,msg,Number(opt("timeout","180000")));print({chat:chat.name,response:st.lastAssistant});}
  if(cmd==="model"){
    const m=positionals(2).join(" "); if(!m) throw new Error("model required"); const applied=await applyModelSpec(page,m,null);
    chat.model=applied.model;if(applied.effort)chat.effort=applied.effort;await saveRegistry(reg);print({ok:true,chat:chat.name,model:chat.model,effort:chat.effort||null});
  }
  if(cmd==="effort"){const e=positionals(2).join(" ");if(!e)throw new Error("effort required");await setEffort(page,e);chat.effort=e;await saveRegistry(reg);print({ok:true,chat:chat.name,effort:e});}
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
  const a=activeAccount(reg,p,accountArg), name=opt("name","New chat"), role=opt("role",name), first=opt("message",null);
  if(!first) throw new Error("--message required");
  const conflict=Object.values(reg.chats).find(c=>c.project===p&&c.account===a&&c.role===role&&c.status==="active");
  if(conflict&&!args.includes("--allow-duplicate-role")) throw new Error(`Active role already exists: ${role} (${conflict.id})`);
  const {task,binding}=await openBoundTask(reg,p,a), page=await newManagedPage(reg,p,a,task,binding,null);
  try {
    await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
    await openProjectPage(page,p,binding.projectUrl||null);
    await page.waitForSelector('div#prompt-textarea[contenteditable="true"]',{state:"visible",timeout:15000});
    const model=opt("model",null), requestedEffort=opt("effort",null); let applied={model:null,effort:requestedEffort};
    if(model) applied=await applyModelSpec(page,model,requestedEffort); else if(requestedEffort) await setEffort(page,requestedEffort);
    await sendMessage(page,first); await page.waitForURL(/\/c\/[0-9a-f-]+/i,{timeout:30000});
    const url=await page.url(), id=convId(url), projectBase=url.includes("/g/g-p-")?url.replace(/\/c\/[^/]+.*$/,''):binding.projectBase;
    if(projectBase){binding.projectBase=projectBase;binding.projectUrl=projectBase+"/project";binding.projectId=projectIdFromUrl(projectBase);}
    reg.chats[id]={id,url,name,role,title:name,project:p,account:a,status:"active",model:applied.model||model,effort:applied.effort||requestedEffort,
      spaceName:binding.spaceName,spaceId:task.spaceId,page:page.label,createdAt:new Date().toISOString()};
    await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:binding.spaceName,lastCommand:"new",lastSession:id});
    print(reg.chats[id]);
  } catch (error) {
    await page.close().catch(()=>{}); throw error;
  }
}
else throw new Error("Unknown command: "+cmd);
