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
