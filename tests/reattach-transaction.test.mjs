import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

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
