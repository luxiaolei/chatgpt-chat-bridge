import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("ask wrapper performs separate status/send/status calls instead of one long UI command", async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"ask-wrapper-"));
  const fake=path.join(root,"bridge"), state=path.join(root,"state"), log=path.join(root,"log");
  await writeFile(state,"0");
  await writeFile(fake,`#!/bin/sh
echo "$1" >> "${log}"
n=$(cat "${state}")
if [ "$1" = "status" ]; then
  if [ "$n" = "0" ]; then
    echo '{"lastAssistantId":"a0","assistantCount":1,"lastAssistant":"old","generating":false}'
    echo 1 > "${state}"
  else
    echo '{"lastAssistantId":"a1","assistantCount":2,"lastAssistant":"new answer","generating":false,"modelSelection":{"model":"GPT-6","effort":"High"}}'
  fi
elif [ "$1" = "send" ]; then
  echo '{"ok":true,"delivered":true,"chat":"worker","dispatchModel":{"model":"Latest"}}'
fi
`,{mode:0o755});
  try{
    const r=spawnSync("python3",[path.resolve("src/ask-wrapper.py"),fake,"worker","question","--timeout","5000"],{encoding:"utf8"});
    assert.equal(r.status,0,r.stderr);
    const out=JSON.parse(r.stdout); assert.equal(out.response,"new answer");
    const calls=(await readFile(log,"utf8")).trim().split("\n");
    assert.deepEqual(calls,["status","send","status"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
