import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import(`../src/${file}.js`);
const source=(await readFile(new URL('../src/main.js',import.meta.url),'utf8')).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const project='g-p-'+'1'.repeat(32),otherProject='g-p-'+'2'.repeat(32);
const conversation='11111111-1111-4111-8111-111111111111';
const url=`https://chatgpt.com/g/${project}/c/${conversation}`;
const message='This exact request\nwith its complete footer.';
const before={url,messageCount:4,lastUser:'old message',lastUserId:'old-user',userMessageIds:['earlier-user','old-user'],composerText:'',inputReady:true};
const after={...before,messageCount:5,lastUser:message,lastUserId:'new-user',composerText:''};

async function harness(f={}) {
  f.calls=[];f.snapshots ||= [before,after];
  return new AsyncFunction('f',source+`
    const reg={chats:{}};
    assertImagePageFree=async()=>{};
    detectWebRateLimit=async()=>{};
    state=async(_page,mode)=>{f.calls.push(['state',mode]);return f.snapshots.shift()||f.latest||f.snapshots.at(-1);};
    expandEvidenceMessages=async()=>{};
    if(f.shortWait) waitForDelivery=async()=>f.latest;
    return {deliveryObserved,waitForDelivery,triggerSend,sendMessage,attempted:()=>sendAttempted};
  `)(f);
}

test('delivery requires this complete message, a fresh ID and the exact conversation/Project',async()=>{
  const {deliveryObserved}=await harness();
  assert.equal(deliveryObserved(before,after,message),true);
  assert.equal(deliveryObserved(before,{...after,lastUser:message.replace('\n','  ')},message),true);
  for(const bad of [
    {...after,lastUser:'unrelated text; intended request absent'},
    {...before,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'},
    {...after,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'},
    {...after,url:`https://chatgpt.com/g/${otherProject}/c/${conversation}`},
    {...after,url:url.replace('chatgpt.com','untrusted.example')},
    {...after,lastUserId:'earlier-user'},
    {...after,lastUserId:'old-user'},
    {...after,lastUserId:null},
    {...after,lastUser:'This exact request'},
  ]) assert.equal(deliveryObserved(before,bad,message),false,JSON.stringify(bad));
  assert.equal(deliveryObserved(before,after),false);
});

test('first conversation navigation still needs exact message and fresh ID, and rejects another Project',async()=>{
  const {deliveryObserved}=await harness();
  const start={url:`https://chatgpt.com/g/${project}-slug/project`,lastUserId:null,userMessageIds:[],messageCount:0};
  assert.equal(deliveryObserved(start,after,message),true);
  assert.equal(deliveryObserved(start,{...after,url:`https://chatgpt.com/c/${conversation}`},message),true);
  assert.equal(deliveryObserved(start,{...after,lastUser:null,lastUserId:null},message),false);
  assert.equal(deliveryObserved(start,{...after,url:`https://chatgpt.com/g/${otherProject}/c/${conversation}`},message),false);
  assert.equal(deliveryObserved({...start,url:'https://untrusted.example/'},after,message),false);
});

test('delivery polling ignores unrelated traffic until the bound message appears',async()=>{
  const f={snapshots:[{...after,lastUser:'unrelated'},after]};
  const api=await harness(f),page={waitForTimeout:async()=>{}};
  const result=await api.waitForDelivery(page,{...before,expectedMessage:message},1000);
  assert.equal(result.lastUser,message);
  assert.equal(f.calls.filter(([kind])=>kind==='state').length,2);
});

test('ambiguous send remains unconfirmed after one trigger even with nonempty composer',async()=>{
  const f={shortWait:true,latest:{...before,composerText:message}},api=await harness(f);
  const page={fill:async()=>{},waitForTimeout:async()=>{},evaluate:async()=>true,
    click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])};
  await assert.rejects(api.sendMessage(page,message,url),error=>error.code==='DELIVERY_UNCONFIRMED'&&error.deliveryStage==='SEND_ATTEMPTED');
  assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);
  assert.equal(f.calls.some(([kind])=>kind==='enter'),false);
  assert.equal(api.attempted(),true);
});

test('send receipt binds the observed message ID and target, while target drift stops before fill',async()=>{
  const f={shortWait:true,latest:after},api=await harness(f);
  const page={fill:async()=>f.calls.push(['fill']),waitForTimeout:async()=>{},evaluate:async()=>true,click:async()=>{}};
  const result=await api.sendMessage(page,message,url);
  assert.equal(result.lastUserId,'new-user');assert.equal(result.url,url);
  const drift={shortWait:true,snapshots:[{...before,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'}],latest:after};
  const other=await harness(drift);
  await assert.rejects(other.sendMessage({...page,fill:async()=>drift.calls.push(['fill'])},message,url),/DELIVERY_TARGET_MISMATCH/);
  assert.equal(drift.calls.some(([kind])=>kind==='fill'),false);
  assert.equal(other.attempted(),false);
});

test('an unacknowledged click or Enter never falls back to another send action',async()=>{
  for(const hasSend of [true,false]) {
    const f={},api=await harness(f);
    const action=async kind=>{f.calls.push([kind]);throw new Error('lost action acknowledgement');};
    const page={evaluate:async()=>hasSend,click:()=>action('click'),press:()=>action('enter'),
      keyboard:{press:async()=>f.calls.push(['keyboard-enter'])},focus:async()=>{}};
    await assert.rejects(api.triggerSend(page),/lost action acknowledgement/);
    assert.deepEqual(f.calls,[[hasSend?'click':'enter']]);
    assert.equal(api.attempted(),true);
  }
});
