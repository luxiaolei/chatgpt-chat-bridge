import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import '../src/model-policy.js';

const source=await readFile(new URL('../src/main.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function setEffort(page, effort) {'),source.indexOf('async function modelSelectorAvailable(page) {'));
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function runtime(mode='High',{failModel=false}={}) {
  const calls={states:0,menu:0,keys:[],evaluate:0,model:0};
  const {observedModel,modelPreset}=globalThis.__CHAT_BRIDGE_MODEL_POLICY__;
  const api=await new AsyncFunction('state','openModelMenu','observedModel','modelPreset','setModel',body+'\nreturn {setEffort,applyModelSpec};')(
    async()=>{calls.states++;return {mode};},async()=>{calls.menu++;},observedModel,modelPreset,async()=>{
      calls.model++;if(failModel)throw Error('Model selection was not confirmed: Latest');return 'Latest';
    });
  const page={keyboard:{press:async key=>calls.keys.push(key)},evaluate:async()=>{calls.evaluate++;return null;},
    focus:async()=>assert.fail('A missing slider cannot receive focus')};
  return {api,page,calls};
}

test('exact current effort avoids Escape, menu reopen and slider mutation',async()=>{
  for(const mode of ['High','Latest High','5.6 High']){
    const {api,page,calls}=await runtime(mode);assert.equal(await api.setEffort(page,'hIgH'),true);
    assert.deepEqual(calls,{states:1,menu:0,keys:[],evaluate:0,model:0});
  }
});
test('Extra High is not treated as High',async()=>{
  const {api,page,calls}=await runtime('Extra High');await assert.rejects(api.setEffort(page,'High'),/Thinking effort slider not available/);
  assert.equal(calls.menu,1);assert.deepEqual(calls.keys,['Escape','Escape']);
});
test('different or unknown observed effort retains original strict slider validation',async()=>{
  for(const mode of ['Medium','Latest',null]){
    const {api,page,calls}=await runtime(mode);await assert.rejects(api.setEffort(page,'High'),/Thinking effort slider not available/);
    assert.equal(calls.menu,1);assert.equal(calls.evaluate,1);
  }
});
test('applyModelSpec still calls verified model selection before exact-effort shortcut',async()=>{
  const {api,page,calls}=await runtime();const result=await api.applyModelSpec(page,'Latest','High');
  assert.equal(calls.model,1);assert.equal(calls.menu,0);assert.deepEqual(calls.keys,[]);
  assert.equal(result.model,'Latest');assert.equal(result.effort,'High');
});
test('model confirmation failure cannot be hidden by matching effort',async()=>{
  const {api,page,calls}=await runtime('High',{failModel:true});
  await assert.rejects(api.applyModelSpec(page,'Latest','High'),/Model selection was not confirmed/);
  assert.equal(calls.model,1);assert.equal(calls.states,0);assert.equal(calls.menu,0);
});
test('invalid effort is rejected before reading or changing the page',async()=>{
  const {api,page,calls}=await runtime();await assert.rejects(api.setEffort(page,'Ultra'),/Effort must be/);
  assert.deepEqual(calls,{states:0,menu:0,keys:[],evaluate:0,model:0});
});
