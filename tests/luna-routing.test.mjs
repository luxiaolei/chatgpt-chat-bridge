import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {judge,validateRequest,validateDecision,submitWithLuna} from '../src/luna-routing.mjs';

const choices=[
  {id:'small',runtime:'codex',model:'gpt-6-luna',effort:'xhigh',nativeHost:'xlmini',nativeThread:'dedicated',nativeCwd:'/tmp/work',nativeSocket:'/tmp/native.sock'},
  {id:'deep',runtime:'codex',model:'gpt-6-astra',effort:'xhigh',nativeHost:'xlmini',nativeThread:'dedicated',nativeCwd:'/tmp/work',nativeSocket:'/tmp/native.sock'},
];
const request={version:1,task:'Review the concurrency guard.',choices};

test('semantic output cannot invent a model, target, authority or candidate',()=>{
  assert.equal(validateRequest(request),request);
  assert.throws(()=>validateRequest({...request,choices:[choices[0],choices[0]]}),/CHOICE_INVALID/);
  assert.throws(()=>validateRequest({...request,choices:[{...choices[0],accept:true}]}),/CHOICE_INVALID/);
  assert.throws(()=>validateRequest({...request,choices:[{...choices[0],nativeCwd:'relative'}]}),/NATIVE_CHOICE_INVALID/);
  assert.throws(()=>validateDecision({choiceId:'invented',reason:'do it'},choices),/UNAUTHORIZED/);
  assert.throws(()=>validateDecision({choiceId:'small',reason:'do it',accept:true},choices),/OUTPUT_INVALID/);
});

test('explicit selection wins and repeated submission uses the same judgment receipt',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'cb-luna-test-'));
  try {
    const file=path.join(dir,'input.json'); writeFileSync(file,JSON.stringify(request));
    const args=['--luna-select',file,'--message',request.task,'--caller-ref','codex:owner','--request-id','stable',
      '--model','gpt-6-astra','--project','Project','--role','worker'];
    let calls=0;
    const runJudge=async filtered=>{
      calls++; assert.deepEqual(filtered.choices,[choices[1]]);
      const {createHash}=await import('node:crypto');
      return {version:1,messageSha256:createHash('sha256').update(filtered.task).digest('hex'),
        selectedChoice:filtered.choices[0],choiceId:'deep',reason:'Concurrency review',choices:filtered.choices};
    };
    const execute=values=>values;
    const first=await submitWithLuna('unused','config',dir,args,{runJudge,execute});
    const second=await submitWithLuna('unused','config',dir,args,{runJudge,execute});
    assert.deepEqual(first,second); assert.equal(calls,1);
    assert.equal(first.filter(value=>value==='--model').length,1);
    assert.ok(first.includes('--native-thread')); assert.ok(!first.includes('--luna-select'));
    const receipt=JSON.parse(readFileSync(first.at(-1),'utf8'));
    assert.equal(receipt.selectedChoice.model,'gpt-6-astra');
    await assert.rejects(submitWithLuna('unused','config',dir,[...args,'--account','changed'],{runJudge,execute}),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(submitWithLuna('unused','config',dir,args.map(value=>value==='gpt-6-astra'?'unsupported':value),{runJudge,execute}),/EXPLICIT_SELECTION_CONFLICT/);
    assert.equal(calls,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('CLI judgment uses Luna and structured output; unavailable or tool-using turns never dispatch',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'cb-luna-process-'));
  try {
    const binary=path.join(dir,'codex');
    const events=[{type:'thread.started',thread_id:'judge'},{type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:JSON.stringify({choiceId:'deep',reason:'并发审查需要深入推理'})}},
      {type:'turn.completed'}];
    const script=values=>'#!/usr/bin/env node\n'+
      'const a=process.argv.slice(2); if(!a.includes("gpt-6-luna") || !a.includes("--ignore-user-config") || !a.includes("shell_tool")) process.exit(2);\n'+
      'process.stdin.resume(); process.stdin.on("end",()=>{process.stdout.write('+JSON.stringify(values.map(e=>JSON.stringify(e)).join('\n')+'\n')+');});\n';
    writeFileSync(binary,script(events),{mode:0o700});
    const receipt=await judge(request,{binary}); assert.equal(receipt.selectedChoice.id,'deep');
    assert.equal(receipt.judge.model,'gpt-6-luna');
    writeFileSync(binary,script([...events,{type:'item.completed',item:{type:'command_execution'}}]),{mode:0o700});
    await assert.rejects(judge(request,{binary}),/TOOL_USE_REJECTED/);
    writeFileSync(binary,script([...events,{type:'item.started',item:{type:'command_execution'}}]),{mode:0o700});
    await assert.rejects(judge(request,{binary}),/TOOL_USE_REJECTED/);
    writeFileSync(binary,script([...events,{type:'item.completed',item:{type:'error',message:'fatal model error'}}]),{mode:0o700});
    await assert.rejects(judge(request,{binary}),/TOOL_USE_REJECTED/);
    writeFileSync(binary,script([...events,{type:'turn.failed'}]),{mode:0o700});
    await assert.rejects(judge(request,{binary}),/TURN_FAILED/);
    const marker=path.join(dir,'continued');
    writeFileSync(binary,'#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1024*1024));setTimeout(()=>{require("node:fs").writeFileSync('+JSON.stringify(marker)+',"bad");},400);\n',{mode:0o700});
    await assert.rejects(judge(request,{binary}),/OUTPUT_TOO_LARGE/);
    const {existsSync}=await import('node:fs'); assert.equal(existsSync(marker),false);
    writeFileSync(binary,'#!/usr/bin/env node\nprocess.stdin.resume(); setTimeout(()=>{},10000);\n',{mode:0o700});
    await assert.rejects(judge(request,{binary,timeoutMs:40}),/TIMEOUT/);
    await assert.rejects(judge(request,{binary:'/nonexistent/codex'}),/UNAVAILABLE/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
