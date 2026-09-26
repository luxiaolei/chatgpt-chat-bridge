import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";

const script=path.resolve("src/capacity-preflight.py");
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),"bridge-cap-")); const config=path.join(root,"config"),state=path.join(root,"state");
 await mkdir(config); await mkdir(state); await mkdir(path.join(state,"web-cooldowns"));
 const reg={accounts:{a:{name:"a",identity:"id-a"},b:{name:"b",identity:"id-b"}},projects:{P:{activeAccount:"a",bindings:{a:{spaceName:"sa"},b:{spaceName:"sb"}}}},chats:{ca:{id:"ca",project:"P",account:"a",status:"active",affinityKey:"sticky",page:"p1"},cb:{id:"cb",project:"P",account:"b",status:"active",page:null}}};
 const rt={tasks:{ta:{taskId:"ta",project:"P",account:"a",status:"RUNNING",sessionId:"ca",affinityKey:"sticky"}},sessions:{ca:{sessionState:"RUNNING_ACTIVE"}}};
 await writeFile(path.join(config,"registry.json"),JSON.stringify(reg)); await writeFile(path.join(state,"runtime.json"),JSON.stringify(rt));
 return {root,config,state};
}
function run(mode,f,...args){return JSON.parse(execFileSync("python3",[script,mode,f.config,f.state,"--project","P",...args],{encoding:"utf8"}));}

test("capacity and least-load selection are local and deterministic",async()=>{const f=await fixture(); const cap=run("capacity",f); assert.equal(cap.accounts.length,2); const sel=run("select",f); assert.equal(sel.selectedAccount,"b"); assert.equal(sel.reason,"LEAST_LOAD");});
test("affinity remains sticky to its existing account",async()=>{const f=await fixture(); const sel=run("select",f,"--affinity-key","sticky"); assert.equal(sel.selectedAccount,"a"); assert.equal(sel.reason,"AFFINITY");});
test("explicit account overrides least-load placement",async()=>{const f=await fixture(); const sel=run("select",f,"--account","a"); assert.equal(sel.selectedAccount,"a"); assert.equal(sel.reason,"EXPLICIT");});


test("unverified aliases are excluded from automatic placement",async()=>{
 const f=await fixture();
 const fs=await import("node:fs/promises");
 const reg=JSON.parse(await fs.readFile(path.join(f.config,"registry.json"),"utf8"));
 delete reg.accounts.b.identity;
 await fs.writeFile(path.join(f.config,"registry.json"),JSON.stringify(reg));
 const cap=run("capacity",f); const b=cap.accounts.find(x=>x.account==="b");
 assert.equal(b.eligible,false); assert.ok(b.exclusionReasons.includes("IDENTITY_UNVERIFIED"));
 const sel=run("select",f); assert.equal(sel.selectedAccount,"a");
});


test("duplicate aliases do not create fake capacity",async()=>{
 const f=await fixture(); const fs=await import("node:fs/promises");
 const reg=JSON.parse(await fs.readFile(path.join(f.config,"registry.json"),"utf8"));
 reg.accounts.alias={name:"alias",identity:"id-a"};
 reg.projects.P.bindings.alias={spaceName:"sa"};
 await fs.writeFile(path.join(f.config,"registry.json"),JSON.stringify(reg));
 const cap=run("capacity",f); const alias=cap.accounts.find(x=>x.account==="alias");
 assert.equal(alias.eligible,false); assert.equal(alias.capacityAliasOf,"a");
 const sel=run("select",f); assert.equal(sel.selectedAccount,"b");
});

test('new placement counts one login across all business projects',async()=>{
 const f=await fixture(); const fs=await import('node:fs/promises');
 const reg=JSON.parse(await fs.readFile(path.join(f.config,'registry.json'),'utf8'));
 const rt=JSON.parse(await fs.readFile(path.join(f.state,'runtime.json'),'utf8'));
 reg.projects.Q={activeAccount:'b',bindings:{b:{spaceName:'other'}}};
 for(let i=0;i<3;i++){
  reg.chats[`qb${i}`]={id:`qb${i}`,project:'Q',account:'b',status:'active'};
  rt.tasks[`qb${i}`]={project:'Q',account:'b',sessionId:`qb${i}`,status:'RUNNING'};
 }
 await fs.writeFile(path.join(f.config,'registry.json'),JSON.stringify(reg));
 await fs.writeFile(path.join(f.state,'runtime.json'),JSON.stringify(rt));
 const selected=run('select',f);
 assert.equal(selected.selectedAccount,'a');
 assert.equal(selected.candidate.activeTasks,1);
 assert.equal(selected.capacity.find(row=>row.account==='b').activeTasks,3);
});

test('allowed account pool restricts only new placements', async()=>{
 const f=await fixture(); const fs=await import('node:fs/promises');
 const file=path.join(f.config,'registry.json'); const reg=JSON.parse(await fs.readFile(file,'utf8'));
 reg.projects.P.allowedAccounts=['a']; await fs.writeFile(file,JSON.stringify(reg));
 const snap=run('capacity',f);
 assert.equal(snap.accounts.find(row=>row.account==='b').eligible,false);
 assert.equal(run('select',f).selectedAccount,'a');
});

test('a binding absent from the login observed Project catalog is ineligible', async()=>{
 const f=await fixture(); const fs=await import('node:fs/promises');
 const file=path.join(f.config,'registry.json'); const reg=JSON.parse(await fs.readFile(file,'utf8'));
 reg.projects.P.bindings.b.projectId='g-p-'+'a'.repeat(32);
 reg.spaces={observed:{identity:'id-b',projects:[{id:'g-p-'+'b'.repeat(32)}]}};
 await fs.writeFile(file,JSON.stringify(reg));
 const snap=run('capacity',f);
 assert.ok(snap.accounts.find(row=>row.account==='b').exclusionReasons.includes('PROJECT_NOT_OBSERVED_FOR_LOGIN'));
 assert.equal(run('select',f).selectedAccount,'a');
 reg.projects.P.bindings.b.projectId='g-p-'+'b'.repeat(32)+'-project-name';
 await fs.writeFile(file,JSON.stringify(reg));
 assert.equal(run('capacity',f).accounts.find(row=>row.account==='b').eligible,true);
});

test('historical synced chats do not outweigh actual running load', async()=>{
 const f=await fixture(); const fs=await import('node:fs/promises');
 const regFile=path.join(f.config,'registry.json'), rtFile=path.join(f.state,'runtime.json');
 const reg=JSON.parse(await fs.readFile(regFile,'utf8'));
 reg.chats.ca.page=null;
 for(let i=0;i<20;i++) reg.chats[`history${i}`]={id:`history${i}`,project:'P',account:'b',status:'active'};
 const rt={tasks:{},sessions:{ca:{sessionState:'RUNNING_ACTIVE'}}};
 await fs.writeFile(regFile,JSON.stringify(reg)); await fs.writeFile(rtFile,JSON.stringify(rt));
 assert.equal(run('select',f).selectedAccount,'b');
});
