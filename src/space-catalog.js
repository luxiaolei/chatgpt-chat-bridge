import {createHash} from "node:crypto";

const projectRef=url=>{
  try {
    const parsed=new URL(url);
    if(parsed.origin!=="https://chatgpt.com") return null;
    const route=parsed.pathname.match(/^\/g\/(g-p-[^/]+)/)?.[1];
    const id=route?.match(/^g-p-[0-9a-f]{32}/i)?.[0];
    return id?{id,route}:null;
  } catch { return null; }
};
const projectId=url=>projectRef(url)?.id||null;
const projectUrl=id=>`https://chatgpt.com/g/${id}/project`;
const slug=text=>String(text||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"account";

const userControlled=space=>["user","agentDelegatedToUser"].includes(space?.ownership);
const userControlError=(name,ownership)=>{
  const error=new Error(`SPACE_IN_USER_CONTROL: ${name}`);
  error.code="SPACE_IN_USER_CONTROL";
  error.spaceName=name;
  error.ownership=ownership||null;
  return error;
};

export function selectManagedSpace(binding,accountName,available=[],options={}) {
  if(available.filter(space=>space.name===binding.spaceName).length>1) throw new Error(`AMBIGUOUS_SPACE: ${binding.spaceName}`);
  const current=available.find(space=>space.name===binding.spaceName);
  const protectedSpace=userControlled(current);
  if(protectedSpace&&options.pauseOnUserControl) throw userControlError(binding.spaceName,current.ownership);
  const name=protectedSpace?`chat-bridge-agent-${slug(accountName)}`:binding.spaceName;
  if(available.filter(space=>space.name===name).length>1) throw new Error(`AMBIGUOUS_SPACE: ${name}`);
  const target=available.find(space=>space.name===name);
  if(userControlled(target)) throw userControlError(name,target.ownership);
  const profileId=target?.profileId||current?.profileId||binding.profileId;
  if(!profileId) throw new Error(`PROFILE_REQUIRED: ${name}`);
  return {spaceName:name,profileId,changed:name!==binding.spaceName,existing:!!target};
}

export function agentSpaceGcCandidates(reg,runtime,available=[]) {
  const terminal=new Set(["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"]);
  const bound=new Set();
  for(const project of Object.values(reg.projects||{}))
    for(const binding of Object.values(project.bindings||{}))
      if(binding?.spaceName) bound.add(binding.spaceName);
  const live=new Set();
  for(const task of Object.values(runtime.tasks||{})) {
    if(terminal.has(String(task.status||"").toUpperCase())) continue;
    const chat=task.sessionId?reg.chats?.[task.sessionId]:null;
    const account=task.account||chat?.account||reg.projects?.[task.project]?.activeAccount||reg.defaultAccount;
    const binding=reg.projects?.[task.project]?.bindings?.[account];
    const name=task.spaceName||chat?.spaceName||binding?.spaceName;
    if(name) live.add(name);
  }
  return available.filter(space=>
    space?.ownership==="agent" &&
    String(space?.name||"").startsWith("chat-bridge-agent-") &&
    !bound.has(space.name) &&
    !live.has(space.name)
  );
}

export function recordSpace(reg,{name,spaceId,identity,accountName,profileId=null,ownership=null,urls=[]}) {
  if(!name || !identity || !accountName) throw new Error("Space, login ID, and account name required");
  reg.spaces ||= {}; reg.accounts ||= {};
  const old=reg.spaces[name];
  if(old?.identity && old.identity!==identity) throw new Error(`SPACE_ACCOUNT_CHANGED: ${name}`);
  let alias=Object.keys(reg.accounts).find(a=>reg.accounts[a].identity===identity);
  if(!alias){
    alias=slug(accountName);
    if(reg.accounts[alias])
      alias+=`-${createHash("sha256").update(identity).digest("hex").slice(0,6)}`;
    reg.accounts[alias]={...(reg.accounts[alias]||{}),name:alias,identity,label:accountName};
  }
  const seenAt=new Date().toISOString();
  const projects=new Map((old?.projects||[]).map(p=>[p.id,p]));
  for(const url of urls){
    const ref=projectRef(url);
    if(ref) projects.set(ref.id,{...(projects.get(ref.id)||{}),id:ref.id,url:projectUrl(ref.route),seenAt});
  }
  reg.spaces[name]={...old,name,spaceId,account:alias,accountName,identity,observedAt:seenAt,projects:[...projects.values()],
    profileId:profileId||old?.profileId||null,ownership:ownership||old?.ownership||null};
  return reg.spaces[name];
}

export function recordProjectName(reg,spaceName,id,name) {
  const project=reg.spaces?.[spaceName]?.projects?.find(p=>p.id===id);
  if(!project) throw new Error(`PROJECT_NOT_OBSERVED: ${spaceName} ${id}`);
  if(!String(name||"").trim()) throw new Error("Project name required");
  project.name=String(name).trim();
  project.nameSource="verified";
  return project;
}

export function spaceMap(reg) {
  const names=new Map();
  const configuredBindings=[];
  for(const [name,project] of Object.entries(reg.projects||{}))
    for(const [account,binding] of Object.entries(project.bindings||{})){
      if(binding.projectId) names.set(projectId(projectUrl(binding.projectId)),name);
      configuredBindings.push({project:name,account,space:binding.spaceName||null,
        projectId:binding.projectId?projectId(projectUrl(binding.projectId)):null,
        loginIdentityRecorded:!!reg.accounts?.[account]?.identity});
    }
  const grouped=new Map();
  const spaces=Object.values(reg.spaces||{}).map(space=>({
    name:space.name,spaceId:space.spaceId,account:space.account,accountName:space.accountName,
    observedAt:space.observedAt,
    projects:(space.projects||[]).map(p=>{
      const result={id:p.id,name:p.name||names.get(p.id)||null,url:p.url,seenAt:p.seenAt};
      const item=grouped.get(p.id)||{id:p.id,name:result.name,accounts:new Set(),spaces:[]};
      item.accounts.add(space.account);item.spaces.push(space.name);grouped.set(p.id,item);
      return result;
    }),
  }));
  return {spaces,projects:[...grouped.values()].map(p=>({...p,accounts:[...p.accounts]})),configuredBindings};
}

export function missingProjectUrls(space,existingUrls=[]) {
  const open=new Set(existingUrls.map(projectId).filter(Boolean));
  return (space.projects||[]).filter(p=>!open.has(projectId(p.url))).map(p=>p.url);
}
