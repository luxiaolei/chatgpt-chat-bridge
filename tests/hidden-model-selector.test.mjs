import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";

const root=path.resolve(import.meta.dirname,"..");

async function runtimeApi(mode="Extra High", selectorAvailable=false){
  for(const file of ["control-routing","page-pool","liveness-policy","task-policy","web-policy","model-policy","session-policy"]) {
    await import("../src/"+file+".js");
  }
  const source=(await readFile(path.join(root,"src/main.js"),"utf8")).split('const cmd=args[0] || "help";')[0];
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  return await new AsyncFunction("setTimeout","taskSpace","testMode","selectorVisible",source+
    '\nlet reapplyCalls=0;'+
    '\nstate=async()=>({mode:testMode});'+
    '\napplyModelSpec=async(_page,model,effort)=>{ reapplyCalls+=1; return {model,effort,observed:{model,effort,raw:model+" "+effort}}; };'+
    '\nconst reg={};saveRegistry=async()=>{};'+
    '\nreturn {applyConfiguredSessionModel,applyDispatchModel,modelSelectorAvailable,calls:()=>reapplyCalls,page:{evaluate:async()=>selectorVisible}};'
  )(callback=>callback(),async()=>({}),mode,selectorAvailable);
}

test("hidden model selector with matching effort skips forced model reapply",async()=>{
  const api=await runtimeApi("Extra High",false);
  const chat={model:"GPT-5.6 Sol",effort:"Extra High"};
  const result=await api.applyDispatchModel(api.page,chat);
  assert.equal(api.calls(),0);
  assert.equal(result.model,"GPT-5.6 Sol");
  assert.equal(result.effort,"Extra High");
  assert.equal(result.reapplied,false);
  assert.equal(result.uiModelUnverifiable,true);
  assert.equal(result.observed.model,null);
  assert.equal(chat.resourceVerifiedAt,undefined);
});

test("visible model selector retains strict model reapply",async()=>{
  const api=await runtimeApi("Extra High",true);
  const result=await api.applyConfiguredSessionModel(api.page,{model:"GPT-5.6 Sol",effort:"Extra High"});
  assert.equal(api.calls(),1);
  assert.equal(result.model,"GPT-5.6 Sol");
  assert.equal(result.effort,"Extra High");
});

test("effort mismatch still requires configured model reapply",async()=>{
  const api=await runtimeApi("High",false);
  await api.applyConfiguredSessionModel(api.page,{model:"GPT-5.6 Sol",effort:"Extra High"});
  assert.equal(api.calls(),1);
});
