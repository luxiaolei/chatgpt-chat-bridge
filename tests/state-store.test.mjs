import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const script = path.resolve('src/state-store.py');

test('SQLite state merges independent worker changes and rejects stale overlapping writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-store-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config, 'registry.json'), JSON.stringify({ accounts: { a: { identity: 'one' } }, chats: {} }));
  await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {}, sessions: {} }));
  const call = (command, kind, payload) => spawnSync('python3', [script, command, config, state, kind],
    { input: payload === undefined ? undefined : JSON.stringify(payload), encoding: 'utf8' });
  try {
    const first = call('get', 'runtime');
    assert.equal(first.status, 0, first.stderr);
    const base = JSON.parse(first.stdout);
    const a = { ...base, tasks: { a: { status: 'QUEUED' } } };
    const b = { ...base, tasks: { b: { status: 'QUEUED' } } };
    assert.equal(call('put', 'runtime', { base, next: a }).status, 0);
    assert.equal(call('put', 'runtime', { base, next: b }).status, 0);
    const merged = JSON.parse(call('get', 'runtime').stdout);
    assert.deepEqual(Object.keys(merged.tasks).sort(), ['a', 'b']);
    const changed = { ...base, tasks: { a: { status: 'SENT' } } };
    const conflict = call('put', 'runtime', { base, next: changed });
    assert.equal(conflict.status, 3);
    assert.match(conflict.stderr, /STATE_CONFLICT/);
    assert.deepEqual(JSON.parse(await readFile(path.join(state, 'runtime.json'), 'utf8')), merged);
    assert.equal(JSON.parse(call('get', 'registry').stdout).accounts.a.identity, 'one');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('SQLite reads remain nonblocking while another process holds the WAL writer lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-store-read-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config, 'registry.json'), JSON.stringify({ accounts: {}, chats: {} }));
  await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {}, sessions: {} }));
  const call = (command, kind) => spawnSync('python3', [script, command, config, state, kind], { encoding: 'utf8' });
  try {
    assert.equal(call('get', 'runtime').status, 0);
    const dbPath=path.join(state,'bridge.sqlite3');
    const locker=spawn('python3',['-c',
      'import sqlite3,sys,time; db=sqlite3.connect(sys.argv[1]); db.execute("PRAGMA journal_mode=WAL"); db.execute("BEGIN IMMEDIATE"); print("LOCKED",flush=True); time.sleep(2.5); db.rollback(); db.close()',dbPath],
      {stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('locker did not acquire writer lock')),1000);
      locker.stdout.once('data',()=>{clearTimeout(timer);resolve();});
      locker.once('error',reject);
    });
    const started=Date.now();
    const read=call('get','runtime');
    const elapsed=Date.now()-started;
    assert.equal(read.status,0,read.stderr);
    assert.ok(elapsed<1500,'read waited '+elapsed+'ms behind writer lock');
    await new Promise(resolve=>locker.once('exit',resolve));
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('a stalled put waiting for stdin never holds the SQLite write lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-store-stdin-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  await writeFile(path.join(config, 'registry.json'), JSON.stringify({ accounts: {}, chats: {} }));
  await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {}, sessions: {} }));
  const call = (command, kind) => spawnSync('python3', [script, command, config, state, kind], { encoding: 'utf8' });
  let blocked;
  try {
    const initialized = call('get', 'runtime');
    assert.equal(initialized.status, 0, initialized.stderr);

    blocked = spawn('python3', [script, 'put', config, state, 'runtime'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise(resolve => setTimeout(resolve, 250));

    const probe = spawnSync('python3', ['-c', [
      'import sqlite3,sys',
      'db=sqlite3.connect(sys.argv[1], timeout=0.2)',
      'db.execute("PRAGMA busy_timeout=200")',
      'db.execute("BEGIN IMMEDIATE")',
      'db.rollback()',
      'db.close()',
      'print("write-lock-available")',
    ].join(';'), path.join(state, 'bridge.sqlite3')], { encoding: 'utf8', timeout: 2000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.match(probe.stdout, /write-lock-available/);
  } finally {
    if (blocked && blocked.exitCode === null) {
      blocked.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => blocked.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
});
