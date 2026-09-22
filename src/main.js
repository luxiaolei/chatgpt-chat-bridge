const fs = await import("node:fs/promises");
const os = await import("node:os");
const pathMod = await import("node:path");
const args = globalThis.__CHAT_BRIDGE_ARGS__ || [];
const HOME = os.homedir();
const REG_PATH = pathMod.join(HOME, ".config", "chat-bridge", "registry.json");

async function loadRegistry() {
  try { return JSON.parse(await fs.readFile(REG_PATH, "utf8")); }
  catch { return { version: 1, defaultProject: null, chats: {}, projects: {} }; }
}
async function saveRegistry(reg) {
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

function resolveChat(reg, key, project=null) {
  key = convId(key);
  if (reg.chats[key]) return reg.chats[key];
  const matches = Object.values(reg.chats).filter(c =>
    (!project || c.project===project) &&
    (c.name===key || c.alias===key || c.title===key || c.url===key)
  );
  if (matches.length===1) return matches[0];
  if (!matches.length) throw new Error("Unknown chat: "+key);
  throw new Error("Ambiguous chat: "+key);
}

async function ensurePage(reg, chat) {
  let task, page;
  if (chat.spaceId != null) {
    try { task = await taskSpace(Number(chat.spaceId)); page = task.page(chat.page || "p1"); } catch {}
  }
  if (!task) {
    task = await taskSpace("chat-bridge-" + chat.id.slice(0,8));
    page = task.page("p1");
    chat.spaceId = task.spaceId; chat.page = page.label;
    await saveRegistry(reg);
  }
  if ((await page.url()) !== chat.url) await page.goto(chat.url, { waitUntil:"load", timeout:20000 });
  return {task,page};
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
  await page.keyboard.press("Enter");
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

async function syncProject(reg, page, projectName) {
  const projectUrl=await openProjectPage(page, projectName, reg.projects[projectName]?.url || null);
  await page.waitForSelector('[role="tabpanel"]',{state:"visible",timeout:15000});
  await page.waitForTimeout(500);
  const chats=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/g/g-p-"][href*="/c/"]')].map(a=>({
    title:(a.innerText||"").trim().split("\n")[0],
    url:a.href
  })).filter(x=>x.title));
  const uniq=[]; const seen=new Set();
  for(const x of chats) {
    const m=x.url.match(/\/c\/([0-9a-f-]+)/i);
    if(m && !seen.has(m[1])) { seen.add(m[1]); uniq.push({id:m[1],...x}); }
  }
  const projectBase=projectUrl.replace(/\/project$/,"");
  reg.projects[projectName]={...(reg.projects[projectName]||{}),name:projectName,url:projectUrl,projectBase};
  for(const x of uniq) {
    const old=reg.chats[x.id]||{};
    reg.chats[x.id]={...old,id:x.id,url:x.url,name:old.name||x.title,title:x.title,project:projectName,
      model:old.model||null,effort:old.effort||null,spaceId:old.spaceId??null,page:old.page||"p1"};
  }
  await saveRegistry(reg);
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

const cmd=args[0] || "help";
const reg=await loadRegistry();
const project=opt("project", reg.defaultProject);

if(cmd==="help"){
  print("chat-bridge commands: init, register, list, sync, discover, projects, read, status, send, ask, model, effort, stop, retry, recover, resend, new");
}
else if(cmd==="init"){
  const p=project || args[1]; if(!p) throw new Error("project required");
  reg.defaultProject=p; reg.projects[p] ||= {name:p}; await saveRegistry(reg); print({ok:true,defaultProject:p});
}
else if(cmd==="register"){
  const raw=opt("url")||opt("id")||args[1]; if(!raw) throw new Error("url/id required");
  const id=convId(raw), name=opt("name",id), p=project||"default";
  reg.projects[p] ||= {name:p};
  reg.chats[id]={...(reg.chats[id]||{}),id,url:urlFor(id),name,title:opt("title",name),project:p,
    model:opt("model",reg.chats[id]?.model||null),spaceId:opt("space",reg.chats[id]?.spaceId??null),page:opt("page",reg.chats[id]?.page||"p1")};
  await saveRegistry(reg); print(reg.chats[id]);
}
else if(cmd==="list"){
  print(Object.values(reg.chats).filter(c=>!project||c.project===project));
}
else if(cmd==="projects"){
  const task=await taskSpace("chat-bridge-projects-"+Date.now());
  const page=task.page("p1");
  await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
  await page.waitForTimeout(500);
  const ps=await page.evaluate(()=>[...document.querySelectorAll('button[aria-label^="Open project options for "]')]
    .map(b=>(b.getAttribute("aria-label")||"").replace("Open project options for ","")));
  print([...new Set([...ps,...Object.keys(reg.projects)])]);
  await task.finish({keep:[]});
}
else if(cmd==="sync" || cmd==="discover"){
  const task=await taskSpace("chat-bridge-discovery-"+Date.now());
  const page=task.page("p1");
  await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
  await page.waitForTimeout(500);
  if(project) {
    print(await syncProject(reg,page,project));
  } else {
    const chats=await page.evaluate(()=>[...document.querySelectorAll('a[href*="/c/"]')].map(a=>({
      title:(a.innerText||a.getAttribute("aria-label")||"").trim(),url:a.href
    })).filter(x=>x.title && !x.url.includes("#main")));
    const uniq=[]; const seen=new Set();
    for(const x of chats){ const m=x.url.match(/\/c\/([0-9a-f-]+)/i); if(m&&!seen.has(m[1])){seen.add(m[1]);uniq.push({id:m[1],...x});}}
    print(uniq);
  }
  await task.finish({keep:[]});
}
else if(["read","status","send","ask","model","effort","stop","retry","recover","resend"].includes(cmd)){
  const key=args[1]; if(!key) throw new Error("chat key required");
  const chat=resolveChat(reg,key,project); const {page}=await ensurePage(reg,chat);
  if(cmd==="read"){ print((await state(page)).lastAssistant); }
  if(cmd==="status"){ print({...await state(page),configuredModel:chat.model||null,configuredEffort:chat.effort||null,project:chat.project||null}); }
  if(cmd==="send"){ const msg=positionals(2).join(" "); if(!msg) throw new Error("message required"); await sendMessage(page,msg); print({ok:true,chat:chat.name}); }
  if(cmd==="ask"){ const msg=positionals(2).join(" "); if(!msg) throw new Error("message required"); const s=await askMessage(page,msg,Number(opt("timeout","180000"))); print({chat:chat.name,response:s.lastAssistant}); }
  if(cmd==="model"){
    const m=positionals(2).join(" ");
    if(!m) throw new Error("model required");
    const applied=await applyModelSpec(page,m,null);
    chat.model=applied.model;
    if(applied.effort) chat.effort=applied.effort;
    await saveRegistry(reg);
    print({ok:true,chat:chat.name,model:chat.model,effort:chat.effort||null});
  }
  if(cmd==="effort"){ const e=positionals(2).join(" "); if(!e) throw new Error("effort required"); await setEffort(page,e); chat.effort=e; await saveRegistry(reg); print({ok:true,chat:chat.name,effort:e}); }
  if(cmd==="stop"){ print(await stopGeneration(page)); }
  if(cmd==="retry"){ print(await nativeRetry(page)); }
  if(cmd==="recover"){
    const before=await state(page);
    let stopped={stopped:false};
    if(before.generating){ stopped=await stopGeneration(page); await page.waitForTimeout(300); }
    const retried=await nativeRetry(page);
    if(retried.clicked) print({ok:true,method:"retry",stopped,retried});
    else if(before.lastUser){ await sendMessage(page,before.lastUser); print({ok:true,method:"resend-last-user",stopped}); }
    else print({ok:false,reason:"no retry control or last user message",stopped});
  }
  if(cmd==="resend"){ const s=await state(page); if(!s.lastUser) throw new Error("no last user message"); await sendMessage(page,s.lastUser); print({ok:true,resent:s.lastUser}); }
}
else if(cmd==="new"){
  const p=project||null; const name=opt("name","New chat"); const first=opt("message",null);
  const task=await taskSpace("chat-bridge-new-"+Date.now()); const page=task.page("p1");
  await page.goto("https://chatgpt.com/",{waitUntil:"load",timeout:20000});
  if(p) await openProjectPage(page,p,reg.projects[p]?.url || null);
  await page.waitForSelector('div#prompt-textarea[contenteditable="true"]',{state:"visible",timeout:15000});
  const model=opt("model",null);
  const requestedEffort=opt("effort",null);
  let applied={model:null,effort:requestedEffort};
  if(model) applied=await applyModelSpec(page,model,requestedEffort);
  else if(requestedEffort) await setEffort(page,requestedEffort);
  if(!first) throw new Error("--message required");
  await sendMessage(page,first);
  await page.waitForURL(/\/c\/[0-9a-f-]+/i,{timeout:30000});
  const url=await page.url(), id=convId(url);
  if(p) {
    reg.projects[p] ||= {name:p};
    if(url.includes("/g/g-p-")) reg.projects[p].projectBase=url.replace(/\/c\/[^/]+.*$/,"");
  }
  reg.chats[id]={id,url,name,title:name,project:p,model:applied.model||model,effort:applied.effort||requestedEffort,spaceId:task.spaceId,page:page.label};
  await saveRegistry(reg);
  print(reg.chats[id]);
}
else throw new Error("Unknown command: "+cmd);
