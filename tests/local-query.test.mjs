import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("topology/runtime/task/event local queries never start ego-browser", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"bridge-local-query-"));
  const config=path.join(root,"config"), state=path.join(root,"state"), marker=path.join(root,"ego-called");
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config,"registry.json"),JSON.stringify({
    defaultProject:"P",defaultAccount:"a",accounts:{a:{identity:"one",label:"A"}},
    projects:{P:{name:"P",activeAccount:"a",bindings:{a:{projectUrl:"https://chatgpt.com/g/g-p-"+ "a".repeat(32)+"/project"}}}},
    chats:{c:{id:"c",project:"P",account:"a",role:"conductor",status:"active"}},spaces:{}
  }));
  await writeFile(path.join(state,"runtime.json"),JSON.stringify({
    version:2,projects:{},tasks:{t:{taskId:"t",project:"P",account:"a",role:"worker",status:"RUNNING"}},sessions:{}
  }));
  const fake=path.join(root,"ego-browser");
  await writeFile(fake,`#!/bin/sh
echo called > "${marker}"
exit 99
`,{mode:0o755});
  const env={...process.env,CHAT_BRIDGE_CONFIG_DIR:config,CHAT_BRIDGE_STATE_DIR:state,EGO_BROWSER_BIN:fake};
  try{
    for(const args of [["topology"],["runtime"],["task","list","--project","P"]]){
      const r=spawnSync(path.resolve("bin/chat-bridge"),args,{cwd:path.resolve("."),env,encoding:"utf8"});
      assert.equal(r.status,0,r.stderr);
      assert.doesNotThrow(()=>JSON.parse(r.stdout));
    }
    await assert.rejects(access(marker));
  } finally { await rm(root,{recursive:true,force:true}); }
});
