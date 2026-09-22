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
    const p=p0||{}; p.name ||= name; p.activeAccount ||= reg.defaultAccount; p.bindings ||= {};
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
async function loadRuntime() {
  try { return JSON.parse(await fs.readFile(RUNTIME_PATH,"utf8")); }
  catch { return {version:1,projects:{},tasks:{}}; }
}
async function saveRuntime(runtime) {
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
  reg.projects[project] ||= {name:project,activeAccount:reg.defaultAccount||DEFAULT_ACCOUNT,bindings:{}};
  const p=reg.projects[project]; p.activeAccount ||= reg.defaultAccount||DEFAULT_ACCOUNT; p.bindings ||= {}; return p;
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
async function controlPage(reg, project, account=null) {
  const {binding,task}=await openBoundTask(reg,project,account), pages=await pagesOf(task);
  let page=pages.find(p=>p.label===binding.controlPage) || null;
  if(!page){
    for(const p of pages){ const u=await p.url().catch(()=>""); if(u==="about:blank" || u==="chrome://newtab/"){ page=p; break; } }
  }
  if(!page) page=await task.newPage();
  binding.controlPage=page.label; await saveRegistry(reg); return {binding,task,page};
}
async function ensurePage(reg, chat) {
  const {binding,task}=await openBoundTask(reg,chat.project,chat.account), pages=await pagesOf(task);
  let page=pages.find(p=>p.label===chat.page) || null; if(!page) page=await task.newPage();
  chat.spaceName=binding.spaceName; chat.spaceId=task.spaceId; chat.page=page.label;
  if((await page.url())!==chat.url) await page.goto(chat.url,{waitUntil:"load",timeout:20000});
  await saveRegistry(reg); return {task,page,binding};
}

async function state(page) {
  return await page.evaluate(() => {
    const ms=[...document.querySelectorAll("[data-message-author-role]")].map(e=>({
      role:e.getAttribute("data-message-author-role"), text:(e.innerText||"").trim()
    }));
    const bs=[...document.querySelectorAll("button")];
    const stop=bs.find(b=>/stop/i.test((b.getAttribute("aria-label")||"")+" "+(b.innerText||"")) ||
      /stop/i.test(b.getAttribute("data-testid")||""));
    const form=document.querySelector("form");
    const mode=[...(form?.querySelectorAll("button")||[])].map(b=>(b.innerText||"").trim())
      .find(t=>/\b(Instant|Medium|High|Extra High|Pro)\b/i.test(t)) || null;
    return {
      url:location.href, title:document.title, generating:!!stop, mode,
      lastUser:[...ms].reverse().find(x=>x.role==="user")?.text || null,
      lastAssistant:[...ms].reverse().find(x=>x.role==="assistant")?.text || null,
      messageCount:ms.length, assistantCount:ms.filter(x=>x.role==="assistant").length
    };
  });
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
  await page.waitForSelector('[role="tabpanel"]',{state:"visible",timeout:15000});
  await page.waitForTimeout(500);
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
    const bs=[...document.querySelectorAll("button")];
    const labels=["retry","regenerate","continue generating","try again"];
    const b=[...bs].reverse().find(x=>{
      const s=((x.getAttribute("aria-label")||"")+" "+(x.innerText||"")).toLowerCase();
      return labels.some(k=>s.includes(k));
    });
    if(b){ const label=(b.getAttribute("aria-label")||b.innerText||"").trim(); b.click(); return {clicked:true,label}; }
    return {clicked:false};
  });
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
  print("chat-bridge commands: init, bind, account, space, register, list, sync, discover, projects, runtime, task, read, status, send, ask, model, effort, stop, retry, recover, resend, new, archive, retire, delete, forget; space: show|bind|prune");
}
else if(cmd==="init"){
  const p=project||args[1]; if(!p) throw new Error("project required");
  const a=accountArg||reg.defaultAccount||DEFAULT_ACCOUNT;
  reg.defaultProject=p; reg.defaultAccount ||= a; reg.accounts[a] ||= {name:a};
  const pr=projectRecord(reg,p); pr.activeAccount=a;
  const b=bindingFor(reg,p,a,true), u=opt("url",null), sp=opt("space",null);
  if(u){ b.projectUrl=u; b.projectBase=u.replace(/\/project$/,''); b.projectId=projectIdFromUrl(u); }
  if(sp){ b.spaceName=sp; b.spaceId=null; b.controlPage=null; }
  await saveRegistry(reg); await touchRuntime(p,{activeAccount:a,spaceName:b.spaceName,lastCommand:"init"});
  print({ok:true,project:p,account:a,spaceName:b.spaceName,projectUrl:b.projectUrl});
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
    const taskAccount=project?activeAccount(reg,project,accountArg):(accountArg||old.account||null);
    let sessionId=opt("session",old.sessionId||null);
    if(!sessionId && project && role){ try { sessionId=resolveChat(reg,role,project,taskAccount).id; } catch {} }
    rt.tasks[taskId]={...old,taskId,project:project||old.project||null,role,
      account:opt("account",old.account||taskAccount||null),sessionId,
      issue:opt("issue",old.issue||null),github:opt("github",old.github||null),status:opt("status",old.status||"RUNNING"),
      updatedAt:new Date().toISOString()};
    rt.tasks[taskId].createdAt ||= rt.tasks[taskId].updatedAt;
    await saveRuntime(rt); print(rt.tasks[taskId]);
  } else if(sub==="clear"){
    const taskId=args[2]; if(!taskId) throw new Error("task id required");
    const existed=!!rt.tasks[taskId]; delete rt.tasks[taskId]; await saveRuntime(rt); print({ok:true,taskId,existed});
  } else throw new Error("task subcommand must be list, set, or clear");
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
  if(cmd==="status") print({...await state(page),configuredModel:chat.model||null,configuredEffort:chat.effort||null,project:chat.project||null,account:chat.account,status:chat.status,spaceName:chat.spaceName,spaceId:chat.spaceId,page:chat.page});
  if(cmd==="send"){const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");await sendMessage(page,msg);print({ok:true,chat:chat.name});}
  if(cmd==="ask"){const msg=positionals(2).join(" ");if(!msg)throw new Error("message required");const st=await askMessage(page,msg,Number(opt("timeout","180000")));print({chat:chat.name,response:st.lastAssistant});}
  if(cmd==="model"){
    const m=positionals(2).join(" "); if(!m) throw new Error("model required"); const applied=await applyModelSpec(page,m,null);
    chat.model=applied.model;if(applied.effort)chat.effort=applied.effort;await saveRegistry(reg);print({ok:true,chat:chat.name,model:chat.model,effort:chat.effort||null});
  }
  if(cmd==="effort"){const e=positionals(2).join(" ");if(!e)throw new Error("effort required");await setEffort(page,e);chat.effort=e;await saveRegistry(reg);print({ok:true,chat:chat.name,effort:e});}
  if(cmd==="stop") print(await stopGeneration(page));
  if(cmd==="retry") print(await nativeRetry(page));
  if(cmd==="recover"){
    const before=await state(page);let stopped={stopped:false};if(before.generating){stopped=await stopGeneration(page);await page.waitForTimeout(300);}
    const retried=await nativeRetry(page);if(retried.clicked)print({ok:true,method:"retry",stopped,retried});
    else if(before.lastUser){await sendMessage(page,before.lastUser);print({ok:true,method:"resend-last-user",stopped});}
    else print({ok:false,reason:"no retry control or last user message",stopped});
  }
  if(cmd==="resend"){const st=await state(page);if(!st.lastUser)throw new Error("no last user message");await sendMessage(page,st.lastUser);print({ok:true,resent:st.lastUser});}
}
else if(cmd==="new"){
  const p=project; if(!p) throw new Error("--project required");
  const a=activeAccount(reg,p,accountArg), name=opt("name","New chat"), role=opt("role",name), first=opt("message",null);
  if(!first) throw new Error("--message required");
  const conflict=Object.values(reg.chats).find(c=>c.project===p&&c.account===a&&c.role===role&&c.status==="active");
  if(conflict&&!args.includes("--allow-duplicate-role")) throw new Error(`Active role already exists: ${role} (${conflict.id})`);
  const {task,binding}=await openBoundTask(reg,p,a), page=await task.newPage();
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
