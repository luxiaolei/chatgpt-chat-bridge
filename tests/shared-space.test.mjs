import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("shared physical Space protection includes controls and active task pages", async()=>{
  const source=await readFile(path.resolve("src/main.js"),"utf8");
  const begin=source.indexOf("function samePhysicalSpace");
  const end=source.indexOf("async function reclaimIdlePageSlot",begin);
  assert.ok(begin>=0 && end>begin);
  const helper=source.slice(begin,end);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const {spaceProtection}=await new AsyncFunction("activeTaskStatus","imageSessionOccupancy",helper+";return {spaceProtection};")(
    status=>!["COMPLETE","FAILED","CANCELLED","BLOCKED","RESULT_RECORDED"].includes(String(status).toUpperCase()),
    ()=>({occupied:false,reservedByJob:false})
  );
  const reg={
    defaultAccount:"a",
    projects:{
      A:{activeAccount:"a",bindings:{a:{spaceName:"shared",spaceId:7,controlPage:"a-control"}}},
      B:{activeAccount:"a",bindings:{a:{spaceName:"shared",spaceId:7,controlPage:"b-control"}}},
    },
    chats:{
      a:{id:"a",project:"A",account:"a",status:"active",spaceName:"shared",spaceId:7,page:"a-page"},
      b:{id:"b",project:"B",account:"a",status:"active",spaceName:"shared",spaceId:7,page:"b-page"},
    }
  };
  const runtime={tasks:{tb:{taskId:"tb",project:"B",account:"a",sessionId:"b",role:"worker",status:"RUNNING"}}};
  const protectedSet=spaceProtection(reg,runtime,reg.projects.A.bindings.a,{spaceId:7});
  for(const label of ["a-control","b-control","b-page"]) assert.equal(protectedSet.labels.has(label),true,label);
  assert.equal(protectedSet.labels.has("a-page"),false);
  assert.equal(protectedSet.protectedChatIds.has("b"),true);
  assert.equal(protectedSet.protectedChatIds.has("a"),false);
});
