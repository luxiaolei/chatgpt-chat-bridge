import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {statusFixture} from './status-source-fixture.mjs';
const main=await readFile(process.env.CB_TEST_MAIN_FILE||new URL('../src/main.js',import.meta.url),'utf8');

test('captured Recents history Retry cannot block a completed new native reply',async()=>{
  const {snapshot}=await statusFixture(main,{sidebarRetry:true,currentControls:['Regenerate response'],linkedTask:true,assistantText:'{"op":"context","section":"index"}'});
  assert.equal(snapshot.sessionState,'IDLE_COMPLETE');
  assert.equal(snapshot.lastAssistantTextSource,'message-bound-markdown-source');
  assert.equal(snapshot.recoveryControls.some(c=>c.label==='Retry'),false);
  assert.deepEqual(snapshot.errorTexts,[]);
});

test('Retry does not click history retry, Regenerate, or a native Continue instead',async()=>{
  for(const currentControls of [['Regenerate response'],['Continue generating'],['Retry upload'],[]]){
    const {snapshot,clicks}=await statusFixture(main,{sidebarRetry:true,currentControls,controlAction:'retry'});
    assert.equal(snapshot.clicked,false);
    assert.ok(clicks.every(c=>c.count===0));
  }
});

test('one exact current native Retry is clicked once even with unrelated history and regenerate controls',async()=>{
  const {snapshot,clicks}=await statusFixture(main,{sidebarRetry:true,currentControls:['Retry','Regenerate response'],controlAction:'retry'});
  assert.equal(snapshot.clicked,true);assert.equal(snapshot.kind,'retry');
  assert.equal(clicks.filter(c=>c.count===1).length,1);assert.equal(clicks.reduce((s,c)=>s+c.count,0),1);
});

test('ambiguous Retry controls fail closed instead of choosing last or regenerating',async()=>{
  const {snapshot,clicks}=await statusFixture(main,{currentControls:['Retry','Try again','Regenerate response'],controlAction:'retry'});
  assert.equal(snapshot.clicked,false);assert.equal(snapshot.condition,'RECOVERY_CONTROL_AMBIGUOUS');
  assert.ok(clicks.every(c=>c.count===0));
});

test('native Continue remains available only to explicit recovery and never falls back to Regenerate',async()=>{
  const {snapshot}=await statusFixture(main,{currentControls:['Continue generating'],controlAction:'recover'});
  assert.equal(snapshot.clicked,true);assert.equal(snapshot.kind,'continue generating');
  const other=await statusFixture(main,{currentControls:['Regenerate response'],controlAction:'recover'});
  assert.equal(other.snapshot.clicked,false);
});

test('current-turn errors still block new replies; scoping is not an error override',async()=>{
  const {snapshot}=await statusFixture(main,{linkedTask:true,currentControls:['Retry'],mainError:'Something went wrong'});
  assert.equal(snapshot.sessionState,'ERROR_RECOVERABLE');
  assert.ok(snapshot.errorTexts.includes('Something went wrong'));
});

test('global approval portal still blocks Retry and reply completion after turn UI is narrowed',async()=>{
  const status=await statusFixture(main,{linkedTask:true,globalApproval:true,currentControls:['Retry']});
  assert.equal(status.snapshot.sessionState,'WAITING_USER_APPROVAL');
  await assert.rejects(()=>statusFixture(main,{globalApproval:true,currentControls:['Retry'],controlAction:'retry'}),/APPROVAL_REQUIRED/);
});
