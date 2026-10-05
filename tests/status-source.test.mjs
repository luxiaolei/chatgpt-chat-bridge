import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {statusFixture} from './status-source-fixture.mjs';
const main=await readFile(new URL('../src/main.js',import.meta.url),'utf8');

test('ordinary status exposes the exact latest bound source without a QC-specific flag',async()=>{
  const body='  whitespace\n~~~json\n{"x":"🧪"}\n~~~\n';
  const {snapshot,evaluateArgs}=await statusFixture(main,{body});
  assert.equal(snapshot.lastUserSourceCondition,'BOUND_SOURCE');
  assert.equal(snapshot.lastUserSource?.text,body);
  assert.equal(snapshot.lastUserSource?.messageId,snapshot.lastUserId);
  assert.equal(snapshot.lastUserSource?.conversationId,snapshot.sessionId);
  assert.equal(snapshot.lastUser,'collapsed rendered preview');
  assert.equal(snapshot.userMessages,undefined,'does not return full user-message history');
  assert.equal(evaluateArgs.length,1,'no expansion, reload or second page action');
});

test('status does not invent parent proof or a permanent CID for a temporary source',async()=>{
  const temp='local-chatgpt:44444444-4444-4444-8444-444444444444';
  const {snapshot}=await statusFixture(main,{sourceCid:temp});
  assert.equal(snapshot.lastUserSource?.conversationId,temp);
  assert.equal(snapshot.assistantMessageBinding,null);
  assert.equal(snapshot.assistantMessageBindingCondition,'NATIVE_PARENT_ASSOCIATION_UNAVAILABLE');
});

test('status keeps source identity conflicts and ambiguous rendered IDs unbound',async()=>{
  for(const options of [
    {sourceProps:{messageId:'foreign'}},
    {sourceProps:{conversationId:'55555555-5555-4555-8555-555555555555'}},
    {sourceProps:{copyPlainTextFromSource:false}},
    {renderedIds:'22222222-2222-4222-8222-222222222222 foreign'},
    {missingSource:true}
  ]) {
    const {snapshot}=await statusFixture(main,options);
    assert.equal(snapshot.lastUserSource,null);
    assert.notEqual(snapshot.lastUserSourceCondition,'BOUND_SOURCE');
  }
});

test('heartbeat remains lightweight and status does not retain additional source bodies in runtime',async()=>{
  const heartbeat=await statusFixture(main,{heartbeat:true});
  assert.equal(heartbeat.snapshot.lastUserSource,null);
  assert.equal(heartbeat.snapshot.lastUserSourceCondition,null);
  const status=await statusFixture(main);
  assert.ok(status.snapshot.lastUserSource);
  assert.equal(status.cached.lastUserSource,null);
  assert.equal(status.cached.lastUserSourceCondition,null);
  assert.equal(status.cached.userMessageIds,undefined);
});
