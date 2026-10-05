import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('idle coordinator poll stays read-only under a competing SQLite writer and retains eligible work',()=>{
 const code=String.raw`
import json,pathlib,runpy,sqlite3,tempfile,time
m=runpy.run_path('src/coordinator.py')
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);config=root/'config';state=root/'state';config.mkdir();state.mkdir()
 (config/'registry.json').write_text(json.dumps({'accounts':{},'projects':{},'chats':{}}))
 (state/'runtime.json').write_text(json.dumps({'version':2,'projects':{},'tasks':{},'sessions':{}}))
 db=m['connection'](config,state);db.execute('PRAGMA busy_timeout=0')
 db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,
 caller_ref,role,message,task_id,created_at,updated_at,not_before,kind)
 VALUES('old','old','hash','DELIVERY_UNKNOWN','P','a','identity','s','worker','unchanged','T','fixed','fixed',0,'dispatch')""");db.commit()
 snapshot=lambda:[tuple(row) for row in db.execute('SELECT * FROM documents ORDER BY kind')]+[tuple(row) for row in db.execute('SELECT * FROM operations')]
 before=snapshot();writer=sqlite3.connect(state/'bridge.sqlite3');writer.execute('BEGIN IMMEDIATE')
 try:assert m['work_one'](db)=={'status':'IDLE'}
 finally:writer.rollback();writer.close()
 assert snapshot()==before and not db.in_transaction
 db.execute('PRAGMA query_only=ON')
 assert m['work_one'](db)=={'status':'IDLE'} and snapshot()==before
 db.execute('PRAGMA query_only=OFF')
 calls=[];g=m['work_one'].__globals__;original={name:g[name] for name in ['materialize_pending_callbacks','refresh_waiting_routes','claim']}
 g['materialize_pending_callbacks']=lambda db:calls.append('callbacks')
 g['refresh_waiting_routes']=lambda db:calls.append('routes')
 g['claim']=lambda db:(calls.append('claim') or None)
 for status,not_before,claimed_at,kind,eligible in [
 ('QUEUED',time.time()+3600,None,'dispatch',False),
 ('QUEUED',0,None,'dispatch',True),
 ('DISPATCHING',0,time.time(),'dispatch',False),
 ('DISPATCHING',0,0,'dispatch',True),
 ('WAITING_ROUTE',0,None,'callback',True),
 ('WAITING_ROUTE',0,None,'management',True),
 ('DELIVERY_UNKNOWN',0,None,'dispatch',False)]:
  db.execute('UPDATE operations SET status=?,not_before=?,claimed_at=?,kind=?',(status,not_before,claimed_at,kind));db.commit()
  calls.clear();assert m['work_one'](db)=={'status':'IDLE'}
  assert calls==(['callbacks','routes','claim'] if eligible else []),(status,calls)
 db.execute("""INSERT INTO task_results(task_id,result_version,event_id,status,summary,payload_hash,recorded_at)
 VALUES('T','v1','event','COMPLETE','result','hash','fixed')""");db.commit()
 calls.clear();assert m['work_one'](db)=={'status':'IDLE'} and calls==['callbacks','routes','claim']
 g.update(original)
 db.execute('DELETE FROM task_results');db.commit()
 arrival=sqlite3.connect(state/'bridge.sqlite3');injected=[]
 def arrive_after_preflight(sql):
  if not injected and sql.startswith('SELECT 1 FROM task_results'):
   arrival.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,
    caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before,kind)
    VALUES('arrival','arrival','hash','QUEUED','P','a','identity','missing','missing','controller','unchanged','NEW','fixed','fixed',0,'management')""")
   arrival.commit();injected.append(True)
 db.set_trace_callback(arrive_after_preflight)
 assert m['work_one'](db)=={'status':'IDLE'} and injected
 db.set_trace_callback(None)
 assert db.execute("SELECT status FROM operations WHERE id='arrival'").fetchone()[0]=='QUEUED'
 assert m['work_one'](db)['status']=='WAITING_ROUTE'
 assert db.execute("SELECT status FROM operations WHERE id='arrival'").fetchone()[0]=='WAITING_ROUTE'
 arrival.close();db.close()
print('idle writer contention and eligible-work checks passed')
`;
 const result=spawnSync('python3',['-c',code],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/passed/);
});
