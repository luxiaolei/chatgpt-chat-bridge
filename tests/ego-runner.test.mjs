import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("ego runner terminates only its timed-out client process group", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"ego-runner-"));
  const fake=path.join(root,"ego-browser");
  await writeFile(fake,`#!/bin/sh
if [ "$1" != "nodejs" ]; then exit 9; fi
cat >/dev/null
sleep 30
`,{mode:0o755});
  try{
    const result=spawnSync("python3",[path.resolve("src/ego-runner.py"),fake,"1"],{
      input:"console.log('x')",encoding:"utf8",timeout:5000
    });
    assert.equal(result.status,124,result.stderr);
    assert.match(result.stderr,/EGO_CLIENT_TIMEOUT/);
    const ps=spawnSync("/bin/ps",["-axo","command="],{encoding:"utf8"});
    assert.equal(ps.stdout.includes(fake),false);
  }finally{
    await rm(root,{recursive:true,force:true});
  }
});
