import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';

for(const file of ['control-routing','page-pool','liveness-policy','task-policy','lifecycle-policy','web-policy','model-policy','session-policy'])
  await import(`../src/${file}.js`);
const source=(await readFile(new URL('../src/main.js',import.meta.url),'utf8')).split('const cmd=args[0] || "help";')[0];
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const project='g-p-'+'1'.repeat(32),otherProject='g-p-'+'2'.repeat(32);
const conversation='11111111-1111-4111-8111-111111111111';
const url=`https://chatgpt.com/g/${project}/c/${conversation}`;
const message='This exact request\nwith its complete footer.';
const before={url,messageCount:4,lastUser:'old message',lastUserId:'old-user',userMessageIds:['earlier-user','old-user'],composerText:'',composerCount:1,composerAttachmentsEmpty:true,composerRawText:'',inputReady:true};
const after={...before,messageCount:5,lastUser:message,lastUserId:'new-user',composerText:''};

async function harness(f={}) {
  f.calls=[];f.snapshots ||= [before,after];
  return new AsyncFunction('f',source+`
    const identity=f.witness?.accountIdentity||"verified@example.test";
    const reg={accounts:{a:{identity}},chats:{C:{url:f.snapshots[0]?.url||"https://chatgpt.com/g/g-p-11111111111111111111111111111111/c/11111111-1111-4111-8111-111111111111",account:"a"}}};
    assertImagePageFree=async()=>{};
    detectWebRateLimit=async()=>{};
    state=async(_page,mode,controlAction)=>{if(controlAction==="approval"){f.calls.push(["approval-state"]);return {approvalRequired:false,url:f.current?.url||f.snapshots[0]?.url||reg.chats.C.url};}if(mode===false||mode==="ids"&&f.current&&f.calls.at(-1)?.[0]==="guard-state"){f.calls.push(['guard-state']);return f.current||f.snapshots[0];}f.calls.push(['state',mode]);if(f.stateErrorAt===f.calls.filter(([kind])=>kind==='state').length)throw f.stateError;return f.current=f.snapshots.shift()||f.latest||f.snapshots.at(-1);};
    expandEvidenceMessages=async()=>{};
    nativeSubmissionWitness=async(_page,_request,_identity,capabilityOnly=false)=>{if(capabilityOnly){f.calls.push(['native-support']);if(f.supportError)throw f.supportError;if(f.afterSupport)f.current=f.afterSupport;return {supported:true};}if(f.witnessError)throw f.witnessError;return f.witness||null;};
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

test('delivery preserves literal disclosure words at either end of the actual message',async()=>{
  const {deliveryObserved}=await harness();
  for(const suffix of ['Show more','Show less','显示更多','收起']) {
    const intended='bounded request '+suffix;
    assert.equal(deliveryObserved(before,{...after,lastUser:intended},intended),true,suffix);
    assert.equal(deliveryObserved(before,{...after,lastUser:'bounded request'},intended),false,suffix);
    assert.equal(deliveryObserved(before,{...after,lastUser:intended},'bounded request'),false,suffix);
  }
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
  const page={fill:async()=>{},waitForTimeout:async()=>{},evaluate:async fn=>String(fn).includes("/api/auth/session")?(f.witness?.accountIdentity||"verified@example.test"):true,
    click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])};
  await assert.rejects(api.sendMessage(page,message,url),error=>error.code==='DELIVERY_UNCONFIRMED'&&error.deliveryStage==='SEND_ATTEMPTED');
  assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);
  assert.equal(f.calls.some(([kind])=>kind==='enter'),false);
  assert.equal(api.attempted(),true);
});

test('send receipt binds the observed message ID and target, while target drift stops before fill',async()=>{
  const f={shortWait:true,latest:after},api=await harness(f);
  const page={fill:async()=>f.calls.push(['fill']),waitForTimeout:async()=>{},evaluate:async fn=>String(fn).includes("/api/auth/session")?(f.witness?.accountIdentity||"verified@example.test"):true,click:async()=>{}};
  const result=await api.sendMessage(page,message,url);
  assert.equal(result.lastUserId,'new-user');assert.equal(result.url,url);
  const drift={shortWait:true,snapshots:[{...before,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'}],latest:after};
  const other=await harness(drift);
  await assert.rejects(other.sendMessage({...page,fill:async()=>drift.calls.push(['fill'])},message,url),error=>error.code==='DELIVERY_TARGET_MISMATCH'&&error.deliveryStage==='PRE_SEND');
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
    assert.deepEqual(f.calls,[['approval-state'],[hasSend?'click':'enter']]);
    assert.equal(api.attempted(),true);
  }
});

test('native forward witness confirms actual S1 and rejects altered body, identity, scope and stale evidence',async()=>{
 const fixture=JSON.parse(await readFile(new URL('./native-submission-fixture.json',import.meta.url),'utf8'));
 const {deliveryObserved}=await harness();
 const nativeWitness={format:'chatgpt-native-getText-v1',body:fixture.body,url,accountIdentity:'verified@example.test',observedAt:new Date().toISOString(),
 requestHash:crypto.createHash('sha256').update(fixture.request.replace(/\s+/g,' ').trim()).digest('hex'),bodyHash:crypto.createHash('sha256').update(fixture.body).digest('hex')};
 const original={...before,expectedMessage:fixture.request,expectedIdentity:'verified@example.test',nativeWitness};
 const observed={...after,lastUser:'rendered body differs',lastUserSource:{text:fixture.body,messageId:after.lastUserId,conversationId:conversation}};
 assert.equal(deliveryObserved(before,observed,fixture.request),false);
 assert.equal(deliveryObserved(original,observed,fixture.request),true);
 for(const text of [fixture.body.slice(0,-1),fixture.body+' changed footer',fixture.body.replace(String.fromCharCode(92,96),String.fromCharCode(96)),fixture.body.replace('](https://','](https://wrong.example/'),fixture.body.replace('[https://','[changed label https://')])
 assert.equal(deliveryObserved(original,{...observed,lastUserSource:{...observed.lastUserSource,text}},fixture.request),false);
 for(const bad of [{...observed,lastUserSource:null},{...observed,lastUserId:'old-user'},{...observed,url:url.replace(project,otherProject)},
 {...observed,url:url.replace(conversation,'22222222-2222-4222-8222-222222222222')},
 {...observed,lastUserSource:{...observed.lastUserSource,messageId:'wrong'}},{...observed,lastUserSource:{...observed.lastUserSource,conversationId:'wrong'}}])
 assert.equal(deliveryObserved(original,bad,fixture.request),false);
 for(const change of [{requestHash:'0'.repeat(64)},{bodyHash:'0'.repeat(64)},{accountIdentity:null},{accountIdentity:'other@example.test'},{format:'unknown'},{observedAt:new Date(Date.now()-60000).toISOString()}])
 assert.equal(deliveryObserved({...original,nativeWitness:{...nativeWitness,...change}},observed,fixture.request),false);
 assert.equal(deliveryObserved(original,observed,fixture.request+' changed footer'),false);
});

test('native verification failure and getter exception stop before any Send action',async()=>{
 for(const failure of ['NATIVE_SUBMISSION_UNVERIFIED','native getter failed']) {
  const f={witnessError:new Error(failure)},api=await harness(f);
  const page={fill:async()=>f.calls.push(['fill']),waitForTimeout:async()=>{},
   evaluate:async fn=>String(fn).includes("/api/auth/session")?(f.witness?.accountIdentity||"verified@example.test"):true,click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])};
  await assert.rejects(api.sendMessage(page,message,url,'verified@example.test'),error=>
   error.message===failure&&error.deliveryStage==='PRE_SEND');
  assert.equal(f.calls.filter(([kind])=>kind==='fill').length,1);
  assert.equal(f.calls.some(([kind])=>kind==='click'||kind==='enter'),false);
  assert.equal(api.attempted(),false);
 }
});

test('unsupported native format stops before fill and does not leave a Bridge draft',async()=>{
 const supportError=Object.assign(new Error('NATIVE_SUBMISSION_UNVERIFIED_UNSUPPORTED:chatgpt-native-adapter-v1:FORMAT'),{code:'NATIVE_SUBMISSION_UNSUPPORTED'});
 const f={supportError},api=await harness(f);
 const page={fill:async()=>f.calls.push(['fill']),waitForTimeout:async()=>{},
  evaluate:async fn=>String(fn).includes('/api/auth/session')?'verified@example.test':true,
  click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])};
 await assert.rejects(api.sendMessage(page,message,url,'verified@example.test'),error=>
  error===supportError&&error.deliveryStage==='PRE_SEND');
 assert.equal(f.calls.some(([kind])=>kind==='fill'||kind==='click'||kind==='enter'),false);
 assert.equal(api.attempted(),false);
});

test('draft or target changes during support inspection stop before fill',async()=>{
 for(const changed of [
  {...before,composerRawText:'human draft',composerText:'human draft'},
  {...before,url:'https://chatgpt.com/c/22222222-2222-4222-8222-222222222222'},
 ]) {
  const f={afterSupport:changed},api=await harness(f);
  const page={fill:async()=>f.calls.push(['fill']),waitForTimeout:async()=>{},
   evaluate:async fn=>String(fn).includes('/api/auth/session')?'verified@example.test':true,
   click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])};
  await assert.rejects(api.sendMessage(page,message,url,'verified@example.test'),error=>
   ['USER_DRAFT_PRESENT','DELIVERY_TARGET_MISMATCH'].includes(error.code||error.message)&&error.deliveryStage==='PRE_SEND');
  assert.equal(f.calls.some(([kind])=>kind==='fill'||kind==='click'||kind==='enter'),false);
 }
});


const nativeFailureFixture=()=> {
 const body='SECRET-NATIVE-BODY complete footer',identity='SECRET-VERIFIED-IDENTITY';
 return {body,identity,witness:{format:'chatgpt-native-getText-v1',body,url,accountIdentity:identity,observedAt:new Date().toISOString(),
  requestHash:crypto.createHash('sha256').update(message.replace(/\s+/g,' ').trim()).digest('hex'),
  bodyHash:crypto.createHash('sha256').update(body).digest('hex'),getterSource:'SECRET-GETTER-SOURCE',serializerSource:'SECRET-SERIALIZER-SOURCE'}};
};
const failurePage=f=>({fill:async()=>{},waitForTimeout:async()=>{},evaluate:async fn=>String(fn).includes("/api/auth/session")?(f.witness?.accountIdentity||"verified@example.test"):true,
 click:async()=>f.calls.push(['click']),press:async()=>f.calls.push(['enter'])});

test('native unconfirmed delivery records the final exact-source mismatch without raw contents or URL tokens',async()=>{
 const n=nativeFailureFixture(),observedAt=new Date().toISOString(),sourceText='SECRET-OBSERVED-SOURCE changed footer';
 const latest={...after,url:url+'?token=SECRET-OBSERVED-TOKEN#SECRET-FRAGMENT',observedAt,
  lastUserId:'33333333-3333-4333-8333-333333333333',lastUserSource:{text:sourceText,messageId:'33333333-3333-4333-8333-333333333333',conversationId:conversation,token:'SECRET-SOURCE-EXTRA'},
  lastAssistant:'SECRET-ASSISTANT',userMessages:[{text:'SECRET-OTHER-HISTORY'}],token:'SECRET-SNAPSHOT-TOKEN'};
 const f={witness:n.witness,shortWait:true,latest},api=await harness(f);
 await assert.rejects(api.sendMessage(failurePage(f),message,url+'?token=SECRET-TARGET-TOKEN',n.identity),error=>{
  assert.equal(error.code,'DELIVERY_UNCONFIRMED');assert.equal(error.deliveryStage,'SEND_ATTEMPTED');
  const p=error.nativeWitness?.postSend;assert.ok(p,'final post-send observation must survive the exception');
  assert.equal(p.phase,'POST_SEND_CONFIRMATION');assert.equal(p.observedAt,observedAt);
  assert.equal(p.missingCondition,'NATIVE_SOURCE_BODY_MISMATCH');
  assert.equal(p.beforeUrl,url);assert.equal(p.targetUrl,url);assert.equal(p.afterUrl,url);
  assert.equal(p.lastUserId,latest.lastUserId);assert.equal(p.sourceMessageId,latest.lastUserId);assert.equal(p.sourceConversationId,conversation);
  assert.equal(p.sourceBodyHash,crypto.createHash('sha256').update(sourceText).digest('hex'));assert.equal(p.sourceBodyLength,sourceText.length);
  assert.equal(p.nativeBodyHash,n.witness.bodyHash);assert.equal(p.nativeBodyLength,n.body.length);
  assert.equal(p.snapshotAvailable,true);assert.equal(p.observationFailed,false);
  assert.doesNotMatch(JSON.stringify(error.nativeWitness),/SECRET-/);
  return true;
 });
 assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);assert.equal(f.calls.some(([kind])=>kind==='enter'),false);
});

test('assistant-only new-chat confirmation records the missing bound user ID without accepting delivery',async()=>{
 const n=nativeFailureFixture(),home='https://chatgpt.com/g/'+project+'/project';
 const latest={...after,lastUserId:null,lastUser:null,lastUserSource:null,userMessageIds:[],observedAt:new Date().toISOString()};
 const f={witness:{...n.witness,url:home},snapshots:[{...before,url:home,lastUserId:null,userMessageIds:[]}],shortWait:true,latest},api=await harness(f);
 await assert.rejects(api.sendMessage(failurePage(f),message,home,n.identity),error=>{
  const p=error.nativeWitness?.postSend;assert.ok(p);
  assert.equal(error.code,'DELIVERY_UNCONFIRMED');assert.equal(error.deliveryStage,'SEND_ATTEMPTED');
  assert.equal(p.missingCondition,'NATIVE_SOURCE_MESSAGE_ID_MISSING');assert.equal(p.lastUserId,null);
  assert.equal(p.sourceBodyHash,null);assert.equal(p.sourceBodyLength,null);assert.equal(p.snapshotAvailable,true);
  assert.equal(p.targetUrl,home);assert.equal(p.afterUrl,url);return true;
 });
 assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);
});

test('a later observation exception retains the last poll snapshot as hashes and keeps SEND_ATTEMPTED',async()=>{
 const n=nativeFailureFixture(),latest={...after,observedAt:new Date().toISOString(),
  lastUserSource:{text:'SECRET-POLL-SOURCE',messageId:after.lastUserId,conversationId:conversation}};
 const f={witness:n.witness,snapshots:[before,latest],stateErrorAt:3,stateError:new Error('read transport timed out')},api=await harness(f);
 await assert.rejects(api.sendMessage(failurePage(f),message,url,n.identity),error=>{
  assert.equal(error.message,'read transport timed out');assert.equal(error.deliveryStage,'SEND_ATTEMPTED');
  const p=error.nativeWitness?.postSend;assert.ok(p);
  assert.equal(p.observedAt,latest.observedAt);assert.equal(p.snapshotAvailable,true);assert.equal(p.observationFailed,true);
  assert.equal(p.missingCondition,'NATIVE_SOURCE_BODY_MISMATCH');
  assert.equal(p.sourceBodyHash,crypto.createHash('sha256').update('SECRET-POLL-SOURCE').digest('hex'));
  assert.doesNotMatch(JSON.stringify(error.nativeWitness),/SECRET-/);return true;
 });
 assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);
});

test('successful and pre-send receipts keep their existing shape; native observation absence is explicit',async()=>{
 const n=nativeFailureFixture();
 const latest={...after,lastUserSource:{text:n.body,messageId:after.lastUserId,conversationId:conversation}};
 const good={witness:n.witness,shortWait:true,latest},success=await harness(good);
 assert.equal((await success.sendMessage(failurePage(good),message,url,n.identity)).nativeWitness.postSend,undefined);
 const firstReadFailure={witness:n.witness,snapshots:[before],stateErrorAt:2,stateError:new Error('first observation failed')},missing=await harness(firstReadFailure);
 await assert.rejects(missing.sendMessage(failurePage(firstReadFailure),message,url,n.identity),error=>{
  const p=error.nativeWitness?.postSend;assert.ok(p);
  assert.equal(p.snapshotAvailable,false);assert.equal(p.observedAt,null);
  assert.equal(p.missingCondition,'POST_SEND_STATE_UNAVAILABLE');assert.equal(p.observationFailed,true);return true;
 });
 const pre={witnessError:new Error('NATIVE_SUBMISSION_UNVERIFIED')},preApi=await harness(pre);
 await assert.rejects(preApi.sendMessage(failurePage(pre),message,url,n.identity),error=>error.deliveryStage==='PRE_SEND'&&!error.nativeWitness);
 const plain={shortWait:true,latest:{...before}},plainApi=await harness(plain);
 await assert.rejects(plainApi.sendMessage(failurePage(plain),message,url),error=>error.deliveryStage==='SEND_ATTEMPTED'&&!error.nativeWitness);
});


const terminalLfFormat=JSON.parse(await readFile(new URL('./native-terminal-lf-format.json',import.meta.url),'utf8'));
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const currentNativeFormat=JSON.parse(await readFile(new URL('./native-submission-current-fixture.json',import.meta.url),'utf8'));
const currentTerminalLfFormat={getterSource:currentNativeFormat.getter,serializerSource:currentNativeFormat.serializerSource};
function terminalLfFixture(body='Synthetic management request\nExact footer.\n',format=terminalLfFormat) {
 const now=new Date().toISOString(),identity='verified@example.test';
 const witness={...format,format:'chatgpt-native-getText-v1',body,url,accountIdentity:identity,
  observedAt:now,requestHash:digest(body.replace(/\s+/g,' ').trim()),bodyHash:digest(body)};
 const original={...before,expectedMessage:body,expectedIdentity:identity,nativeWitness:witness};
 const observed={...after,observedAt:now,lastUserSourceCondition:'BOUND_SOURCE',
  lastUserSource:{text:body.slice(0,-1),messageId:after.lastUserId,conversationId:conversation}};
 return {original,observed,body,witness,identity};
}

test('characterized persistent send binds exactly one terminal LF and retains both raw body hashes',async()=>{
 const n=terminalLfFixture(),f={witness:n.witness,shortWait:true,latest:n.observed},api=await harness(f);
 assert.equal(api.deliveryObserved(n.original,n.observed,n.body),true);
 const result=await api.sendMessage(failurePage(f),n.body,url,n.identity);
 assert.equal(result.nativeWitness.bodyHash,digest(n.body));
 assert.equal(result.nativeWitness.bodyBinding.format,'persistent-single-terminal-lf-v1');
 assert.equal(result.nativeWitness.bodyBinding.nativeBodyHash,digest(n.body));
 assert.equal(result.nativeWitness.bodyBinding.sourceBodyHash,digest(n.body.slice(0,-1)));
 assert.equal(result.nativeWitness.bodyBinding.messageId,n.observed.lastUserId);
 assert.equal(result.nativeWitness.bodyBinding.conversationId,conversation);
 assert.equal(result.nativeWitness.bodyBinding.nativeBodyLength,n.body.length);
 assert.equal(result.nativeWitness.bodyBinding.sourceBodyLength,n.body.length-1);
 assert.equal(f.calls.filter(([kind])=>kind==='click').length,1);
 assert.equal(JSON.stringify(result.nativeWitness).includes('Synthetic management request'),false);
});

test('current captured native format binds one terminal LF and rejects mixed format pairs',async()=>{
 assert.equal(digest(currentTerminalLfFormat.getterSource),currentNativeFormat.getterSha256);
 assert.equal(digest(currentTerminalLfFormat.serializerSource),currentNativeFormat.serializerSha256);
 const n=terminalLfFixture(undefined,currentTerminalLfFormat),f={witness:n.witness,shortWait:true,latest:n.observed},api=await harness(f);
 assert.equal(api.deliveryObserved(n.original,n.observed,n.body),true);
 const result=await api.sendMessage(failurePage(f),n.body,url,n.identity);
 assert.equal(result.nativeWitness.getterHash,currentNativeFormat.getterSha256);
 assert.equal(result.nativeWitness.serializerHash,currentNativeFormat.serializerSha256);
 assert.equal(result.nativeWitness.bodyHash,digest(n.body));
 assert.equal(result.nativeWitness.bodyBinding.sourceBodyHash,digest(n.body.slice(0,-1)));
 for(const format of [
  {getterSource:terminalLfFormat.getterSource,serializerSource:currentTerminalLfFormat.serializerSource},
  {getterSource:currentTerminalLfFormat.getterSource,serializerSource:terminalLfFormat.serializerSource},
 ]) assert.equal(api.deliveryObserved({...n.original,nativeWitness:{...n.witness,...format}},n.observed,n.body),false);
});

test('terminal LF compatibility rejects other whitespace, uncharacterized formats and weakened evidence',async()=>{
 const {deliveryObserved}=await harness();
 for(const format of [terminalLfFormat,currentTerminalLfFormat]) {
 const n=terminalLfFixture(undefined,format);
 for(const body of ['body\r\n','body\n\n','body \n','body\t\n','body\n \n','body','body ']) {
  const f=terminalLfFixture(body,format);
  assert.equal(deliveryObserved(f.original,f.observed,body),false,JSON.stringify(body));
 }
 for(const text of [n.body.slice(0,-2),n.body.trim().replace('\n',' '),' '+n.body.slice(0,-1),n.body.slice(0,-1)+' ','changed\nExact footer.']) {
  assert.equal(deliveryObserved(n.original,{...n.observed,lastUserSource:{...n.observed.lastUserSource,text}},n.body),false);
 }
 for(const change of [{getterSource:'different'},{serializerSource:'different'},{bodyHash:'0'.repeat(64)},
  {requestHash:'0'.repeat(64)},{accountIdentity:'other@example.test'},{observedAt:new Date(Date.now()-60000).toISOString()}])
  assert.equal(deliveryObserved({...n.original,nativeWitness:{...n.witness,...change}},n.observed,n.body),false);
 for(const change of [
  {lastUserSourceCondition:null},{lastUserSourceCondition:'SOURCE_OWNER_AMBIGUOUS'},
  {observedAt:null},{observedAt:new Date(Date.parse(n.witness.observedAt)-1).toISOString()},
  {lastUserId:'old-user',lastUserSource:{...n.observed.lastUserSource,messageId:'old-user'}},
  {lastUserSource:{...n.observed.lastUserSource,messageId:'foreign'}},
  {lastUserSource:{...n.observed.lastUserSource,conversationId:'local-chatgpt:'+conversation}},
  {url:url.replace(project,otherProject)},{url:url.replace('chatgpt.com','untrusted.example')},
 ]) assert.equal(deliveryObserved(n.original,{...n.observed,...change},n.body),false,JSON.stringify(change));
 for(const change of [{nativeSourceContinuity:{conflicted:true}},{expectedIdentity:null},
  {userMessageIds:['new-user']},{userMessageIds:null},{targetUrl:url.replace(conversation,'22222222-2222-4222-8222-222222222222')},
  {url:'https://chatgpt.com/g/'+project+'/project',nativeWitness:{...n.witness,url:'https://chatgpt.com/g/'+project+'/project'}}])
  assert.equal(deliveryObserved({...n.original,...change},n.observed,n.body),false,JSON.stringify(change));
 assert.equal(deliveryObserved(n.original,{...n.observed,lastUserSource:{...n.observed.lastUserSource,text:n.body}},n.body),true);
 }
});
