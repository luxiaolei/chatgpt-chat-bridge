import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const source=await readFile(path.resolve("src/main.js"),"utf8");
const start=source.indexOf("async function consolidateAccountSpace");
const end=source.indexOf("\nasync function createProjectViaUI",start);
const code=source.slice(start,end);

test("Space consolidation is dry-run by default and migrates only after drained check", async()=>{
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  let safe=true,saves=0;
  const managedSpacePlan=()=>({identity:"same",profileId:"P1",spaceName:"chat-bridge-agent-a"});
  const coordinated=()=>({safe,liveTasks:[],pendingOperations:0,controls:{}});
  const accountManagedTask=async()=>({task:{spaceId:99},spaceName:"chat-bridge-agent-a",profileId:"P1"});
  const saveRegistry=async()=>{saves++};
  const consolidate=await new AsyncFunction("managedSpacePlan","coordinated","accountManagedTask","saveRegistry",
    code+";return consolidateAccountSpace;")(managedSpacePlan,coordinated,accountManagedTask,saveRegistry);

  const base=()=>({
    defaultAccount:"a",
    accounts:{a:{identity:"same"},alias:{identity:"same"}},
    projects:{
      A:{bindings:{a:{spaceName:"old-a",profileId:"P1"}}},
      B:{bindings:{alias:{spaceName:"old-b",profileId:"P1"}}},
    },
    chats:{
      ca:{id:"ca",project:"A",account:"a",status:"active",spaceName:"old-a",spaceId:1,page:"p1"},
      cb:{id:"cb",project:"B",account:"alias",status:"active",spaceName:"old-b",spaceId:2,page:"p2"},
    }
  });
  let reg=base();
  const dry=await consolidate(reg,"a",{});
  assert.equal(dry.dryRun,true); assert.equal(dry.affected.length,2); assert.equal(saves,0);
  assert.equal(reg.projects.A.bindings.a.spaceName,"old-a");

  safe=false;
  const blocked=await consolidate(reg,"a",{confirm:true});
  assert.equal(blocked.status,"NOT_DRAINED"); assert.equal(saves,0);

  safe=true; reg=base();
  const done=await consolidate(reg,"a",{confirm:true});
  assert.equal(done.migrated,true); assert.equal(saves,1);
  assert.equal(reg.projects.A.bindings.a.spaceName,"chat-bridge-agent-a");
  assert.equal(reg.projects.B.bindings.alias.spaceName,"chat-bridge-agent-a");
  assert.equal(reg.chats.ca.page,null); assert.equal(reg.chats.cb.page,null);
  assert.deepEqual(new Set(done.oldSpaces),new Set(["old-a","old-b"]));
});
