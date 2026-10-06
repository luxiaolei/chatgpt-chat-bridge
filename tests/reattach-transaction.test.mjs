import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import '../src/task-policy.js';

test('reattach CAS rolls back both documents on owner/binding race and updates only exact task',()=>{
  const code=String.raw`
import copy,json,runpy,sqlite3
m=runpy.run_path('src/coordinator.py')
db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
db.execute('CREATE TABLE documents(kind TEXT PRIMARY KEY,payload TEXT)')
chat={'id':'s','project':'P','account':'a','page':'old','spaceName':'user-space'}
task={'taskId':'T','sessionId':'s','project':'P','account':'a','status':'RUNNING','watchdogPausedForUserControl':True}
binding={'spaceName':'chat-bridge-agent-a','profileId':'Profile 1'}
reg={'chats':{'s':chat},'accounts':{'a':{'identity':'login-a'}},'projects':{'P':{'bindings':{'a':binding}}}}
rt={'tasks':{'T':task,'other':{'watchdogPausedForUserControl':True}},'projects':{'P':{'watchdogPausedForUserControl':True}}}
for k,v in [('registry',reg),('runtime',rt)]:db.execute('INSERT INTO documents VALUES(?,?)',(k,json.dumps(v)))
db.commit()
payload={'taskId':'T','sessionId':'s','expectedChat':copy.deepcopy(chat),'expectedTask':copy.deepcopy(task),'expectedBinding':copy.deepcopy(binding),
'accountIdentity':'login-a','resumeWatch':True,'attachment':{'spaceName':'chat-bridge-agent-a','profileId':'Profile 1','spaceId':9,'pageSpaceId':9,'page':'p7','attachmentEpoch':2}}
before=db.execute('SELECT * FROM documents ORDER BY kind').fetchall()
for field in ['expectedTask','expectedBinding','expectedChat']:
 bad=copy.deepcopy(payload);bad[field]['changed']='race'
 try:m['reattach_commit'](db,bad);raise AssertionError('accepted stale state')
 except ValueError:pass
 assert [tuple(x) for x in before]==[tuple(x) for x in db.execute('SELECT * FROM documents ORDER BY kind')]
result=m['reattach_commit'](db,payload)
assert result['chat']['page']=='p7' and 'watchdogPausedForUserControl' not in result['task']
after=json.loads(db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()[0])
assert after['tasks']['other']['watchdogPausedForUserControl'] and after['projects']['P']['watchdogPausedForUserControl']
print('atomic reattach checks passed')
`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/passed/);
});

test('global cleanup rejects same-name Space with different identity or Profile',async()=>{
  const source=await readFile('src/main.js','utf8'),a=source.indexOf('async function pruneManagedOrphanTabs'),z=source.indexOf('\nasync function watchOnce',a);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  let opened=0;
  const fn=await new AsyncFunction('listTaskSpaces','loadRuntime','taskSpace',source.slice(a,z)+';return pruneManagedOrphanTabs;')(
    async()=>[{id:99,name:'chat-bridge-agent-a',ownership:'agent',createdBy:'agent',profileId:'Profile 1'},
              {id:9,name:'chat-bridge-agent-a',ownership:'agent',createdBy:'agent',profileId:'Profile 2'}],
    async()=>({tasks:{}}),async()=>{opened++;throw Error('unexpected foreign space');});
  const reg={accounts:{a:{identity:'login-a'}},projects:{P:{bindings:{a:{spaceName:'chat-bridge-agent-a',spaceId:9,profileId:'Profile 1',account:'a'}}}}};
  assert.deepEqual(await fn(reg),[]);assert.equal(opened,0);
});

test('formal current-controller placement CAS changes only attachment and preserves taskless worker gates',()=>{
  const code=String.raw`
import copy,json,runpy,sqlite3
m=runpy.run_path('src/coordinator.py')
sid='11111111-1111-1111-1111-111111111111';pid='g-p-'+'a'*32
db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
db.executescript("""CREATE TABLE documents(kind TEXT PRIMARY KEY,payload TEXT);
CREATE TABLE logical_sessions(logical_ref TEXT PRIMARY KEY,project TEXT,role TEXT,current_session_ref TEXT,workgroup_id TEXT,epoch INTEGER,state TEXT,pending_session_ref TEXT,handoff_hash TEXT,rotation_id TEXT,updated_at TEXT);
CREATE TABLE operations(status TEXT,session_ref TEXT,caller_ref TEXT);
CREATE TABLE control_state(scope TEXT,mode TEXT,epoch INTEGER);""")
chat={'id':sid,'project':'P','account':'a','role':'conductor','status':'active','page':None,'spaceName':'chat-bridge-agent-a','attachmentEpoch':6}
binding={'spaceName':'chat-bridge-agent-a','spaceId':2,'profileId':'P1','projectUrl':'https://chatgpt.com/g/'+pid+'/project'}
overflow={'spaceName':'chat-bridge-agent-a-overflow','spaceId':9,'profileId':'P1','identity':'login-a','account':'a','createdAt':'old'}
reg={'chats':{sid:chat},'accounts':{'a':{'identity':'login-a'}},'projects':{'P':{'rootController':'conductor','bindings':{'a':binding}}},'capacityOverflow':{'login-a|P1':overflow}}
rt={'tasks':{},'sessions':{sid:{'watchdogPausedForUserControl':True}},'projects':{'P':{'watchdogPausedForUserControl':True}}}
for k,v in [('registry',reg),('runtime',rt)]:db.execute('INSERT INTO documents VALUES(?,?)',(k,json.dumps(v)))
logical=('project:P:role:conductor','P','conductor',sid,None,3,'ACTIVE',None,None,None,'fixed')
db.execute('INSERT INTO logical_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)',logical)
db.execute("INSERT INTO control_state VALUES('project:P','PAUSED',7)");db.commit()
def snapshot():
 return [tuple(r) for r in db.execute('SELECT * FROM documents ORDER BY kind')],[tuple(r) for r in db.execute('SELECT * FROM logical_sessions')],[tuple(r) for r in db.execute('SELECT * FROM control_state')]
context=m['controller_placement_context'](db,sid)
payload={**copy.deepcopy(context),'overflowCandidate':copy.deepcopy(overflow),'attachment':{'spaceName':overflow['spaceName'],'spaceId':9,'pageSpaceId':9,'profileId':'P1','page':'p7','attachmentEpoch':7},
'observation':{'url':'https://chatgpt.com/g/'+pid+'/c/'+sid,'accountIdentity':'login-a','composerPresent':True,'composerCount':1,'composerRawText':'','generating':False,'approvalRequired':False}}
before=snapshot()
raced=copy.deepcopy(reg);raced['capacityOverflow']['login-a|P1']['spaceId']=16
db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(raced),));db.commit()
changed=snapshot()
try:m['controller_placement_commit'](db,payload);raise AssertionError('accepted changed overflow mapping')
except ValueError as e:assert 'OWNER_CHANGED' in str(e)
assert snapshot()==changed
db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(reg),));db.commit()
for field in ['expectedChat','expectedBinding','expectedController','expectedOverflow']:
 bad=copy.deepcopy(payload);bad[field]['changed']='race'
 try:m['controller_placement_commit'](db,bad);raise AssertionError('accepted stale '+field)
 except ValueError:pass
 assert snapshot()==before
for field,value in [('composerRawText',' '),('composerCount',2),('composerCount',True),('generating',True),('approvalRequired',True),('accountIdentity','foreign'),('url','https://chatgpt.com/g/'+pid+'/c/'+'2'*36)]:
 bad=copy.deepcopy(payload);bad['observation'][field]=value
 try:m['controller_placement_commit'](db,bad);raise AssertionError('accepted unhealthy page')
 except ValueError:pass
 assert snapshot()==before
for field,value in [('spaceName','chat-bridge-agent-foreign'),('identity','foreign'),('profileId','P3'),('account','foreign')]:
 bad=copy.deepcopy(payload);bad['overflowCandidate'][field]=value
 try:m['controller_placement_commit'](db,bad);raise AssertionError('accepted foreign mapping')
 except ValueError:pass
 assert snapshot()==before
for field,value in [('spaceName','chat-bridge-agent-foreign'),('spaceId',16),('profileId','P3'),('attachmentEpoch',8),('pageSpaceId',16)]:
 bad=copy.deepcopy(payload);bad['attachment'][field]=value
 try:m['controller_placement_commit'](db,bad);raise AssertionError('accepted foreign attachment')
 except ValueError:pass
 assert snapshot()==before
for change,restore in [("UPDATE logical_sessions SET epoch=4","UPDATE logical_sessions SET epoch=3"),("UPDATE logical_sessions SET pending_session_ref='successor'","UPDATE logical_sessions SET pending_session_ref=NULL"),("UPDATE logical_sessions SET current_session_ref='retired'","UPDATE logical_sessions SET current_session_ref='"+sid+"'"),("DELETE FROM logical_sessions",None)]:
 db.execute(change);db.commit();changed=snapshot()
 try:m['controller_placement_commit'](db,payload);raise AssertionError('accepted logical race')
 except ValueError:pass
 assert snapshot()==changed
 if restore:db.execute(restore)
 else:db.execute('INSERT INTO logical_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)',logical)
 db.commit()
db.execute("INSERT INTO operations VALUES('DISPATCHING',?,?)",(sid,sid));db.commit()
try:m['controller_placement_commit'](db,payload);raise AssertionError('accepted leased session')
except ValueError as e:assert 'BUSY' in str(e)
db.execute('DELETE FROM operations');db.commit()
badreg=copy.deepcopy(reg);badreg['chats'][sid]['role']='worker'
db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(badreg),));db.commit()
try:m['controller_placement_context'](db,sid);raise AssertionError('accepted taskless worker')
except ValueError:pass
db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(reg),));db.commit()
result=m['controller_placement_commit'](db,payload)
assert result['chat']['attachmentEpoch']==7 and result['chat']['page']=='p7'
after=snapshot()
assert after[0][1]==before[0][1] and after[1:]==before[1:]
saved=json.loads(after[0][0][1]);expected=copy.deepcopy(reg);expected['chats'][sid].update(payload['attachment']);assert saved==expected
print('current controller placement checks passed')
`;
  const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/passed/);
});

test('confirmed controller UI path never retries/sends/resumes and rejects draft, generation, approval or stale owner',async()=>{
  const source=await readFile('src/main.js','utf8'),a=source.indexOf('async function reattachTask'),z=source.indexOf('\nasync function observeOperation',a);
  const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
  const chat={id:'11111111-1111-1111-1111-111111111111',project:'P',account:'a',role:'conductor',url:'https://chatgpt.com/g/g-p-'+ 'a'.repeat(32)+'/c/11111111-1111-1111-1111-111111111111',attachmentEpoch:6};
  const binding={spaceName:'chat-bridge-agent-a',spaceId:9,profileId:'P1',projectUrl:chat.url};
  const context={sessionId:chat.id,expectedChat:chat,expectedBinding:binding,expectedController:{epoch:3,state:'ACTIVE'},accountIdentity:'login-a',expectedOverflow:null};
  const reg={chats:{[chat.id]:chat},projects:{P:{bindings:{a:binding}}},accounts:{a:{identity:'login-a'}}};
  let snapshot,commits,reads,actions,stale,tabs,info;
  const page={label:'p7',url:async()=>chat.url,waitForFunction:async()=>{},evaluate:async()=> 'login-a'};
  const api=await new AsyncFunction('stored','coordinated','loadRuntime','activeTaskStatus','bindingFor','assertWebAvailable','overflowManagedTask','listTaskSpaces','taskSpace','taskAccounts','accountScope','sameConversationUrl','waitForConversationReady','projectKey','state','observeSession','emitTaskEvent',
    'const {composerIsEmpty}=globalThis.__CHAT_BRIDGE_TASK_POLICY__;\n'+source.slice(a,z)+';return reattachTask;')(
    ()=>reg,(cmd,payload)=>{
      if(cmd==='controller-placement-context'){reads++;const c=structuredClone(context);if(stale&&reads>1)c.expectedController.epoch++;return c;}
      assert.equal(cmd,'controller-placement-commit');commits++;return {chat:{...chat,...payload.attachment},controller:context.expectedController};
    },async()=>({tasks:{}}),()=>true,()=>binding,async()=>{},async()=>{throw Error('unexpected overflow');},async()=>[info],
    async()=>({spaceId:9,tabs:async()=>tabs,page:()=>page,newPage:async()=>{actions++;throw Error('unexpected allocation');}}),
    new Map(),()=> 'login-a',(x,y)=>x===y,async()=>{actions++;throw Error('unexpected Retry-capable readiness');},
    ()=> 'g-p-'+ 'a'.repeat(32),async()=>snapshot,async()=>{actions++;throw Error('unexpected observe/resume');},async()=>{actions++;throw Error('unexpected event');});
  const reset=()=>{snapshot={composerPresent:true,composerText:'',composerCount:1,composerAttachmentsEmpty:true,composerRawText:'',errorTexts:[],approvalRequired:false,generating:false};commits=reads=actions=0;stale=false;
    tabs=[{url:chat.url,label:'p7',openedBy:'agent'}];info={id:9,name:binding.spaceName,profileId:'P1',ownership:'agent',createdBy:'agent'};};
  reset();const placed=await api(reg,chat,null,{confirm:true,currentController:true});
  assert.equal(placed.messageSent,false);assert.equal(placed.resumeWatch,false);assert.equal(commits,1);assert.equal(actions,0);
  for(const patch of [{composerRawText:'draft'},{composerRawText:' '},{composerCount:2},{composerRawText:undefined},{generating:true},{approvalRequired:true},{composerPresent:false}]){
    reset();Object.assign(snapshot,patch);await assert.rejects(()=>api(reg,chat,null,{confirm:true,currentController:true}));assert.equal(commits,0);assert.equal(actions,0);
  }
  reset();stale=true;await assert.rejects(()=>api(reg,chat,null,{confirm:true,currentController:true}),/OWNER_CHANGED/);assert.equal(commits,0);assert.equal(actions,0);
  reset();tabs[0].openedBy='user';await assert.rejects(()=>api(reg,chat,null,{confirm:true,currentController:true}),/USER_CONTROL/);assert.equal(actions,0);
  for(const options of [{currentController:true},{confirm:true,currentController:true,resumeWatch:true}]){
    reset();await assert.rejects(()=>api(reg,chat,null,options));assert.equal(reads,0);assert.equal(actions,0);
  }
  reset();await assert.rejects(()=>api(reg,chat,'fake-task',{confirm:true,currentController:true}),/TASK_OR_RESUME/);
  reset();await assert.rejects(()=>api(reg,chat,null,{confirm:true}),/TASK_IDENTITY_MISMATCH/);assert.equal(actions,0);
});
