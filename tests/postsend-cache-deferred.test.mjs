import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {statusFixture} from "./status-source-fixture.mjs";

const main=await readFile(new URL("../src/main.js",import.meta.url),"utf8");
const locked=()=>new Error("STATE_STORE_RUNTIME: Traceback: sqlite3.OperationalError: database is locked");

test("confirmed-send observation may defer only a runtime cache lock",async()=>{
  const {snapshot}=await statusFixture(main,{heartbeat:true,saveRuntimeError:locked(),
    observeOptions:{deferRuntimeCacheLock:true}});
  assert.equal(snapshot.runtimeCacheDeferred,true);
  assert.equal(snapshot.lastUserId,"22222222-2222-4222-8222-222222222222");
});

test("ordinary observation still surfaces the same runtime lock",async()=>{
  await assert.rejects(statusFixture(main,{heartbeat:true,saveRuntimeError:locked()}),
    /STATE_STORE_RUNTIME:.*database is locked/s);
});

test("post-send cache deferral never swallows non-lock state-store faults",async()=>{
  await assert.rejects(statusFixture(main,{heartbeat:true,
    saveRuntimeError:new Error("STATE_STORE_RUNTIME: STATE_CONFLICT"),
    observeOptions:{deferRuntimeCacheLock:true}}),/STATE_CONFLICT/);
});

test("send dispatcher opts into lock-only deferral after delivery has already succeeded",()=>{
  assert.match(main,/const observed=await observeSession\(chat,page,tracked,\{deferRuntimeCacheLock:true\}\)/);
  assert.match(main,/if\(!runtimeCacheLock\(error\)\) throw error;\s*runtimeCacheDeferred=true;/);
  assert.match(main,/delivered:true,delivery,upload,chat:chat\.name,taskId:taskId\|\|null,state:observed\.sessionState/);
});
