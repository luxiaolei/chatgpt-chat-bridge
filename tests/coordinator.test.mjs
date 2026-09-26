import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const script = path.resolve('src/coordinator.py');

test('durable submit is idempotent, reserves one account and survives process restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-coordinator-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  const registry = { accounts: { a: { identity: 'one' }, b: { identity: 'two' } },
    projects: { P: { activeAccount: 'a', bindings: { a: { projectUrl: 'https://chatgpt.com/g/a/project', spaceName: 'A' }, b: { projectUrl: 'https://chatgpt.com/g/b/project', spaceName: 'B' } } } },
    chats: { controller: { id: 'controller', project: 'P', account: 'a', role: 'conductor', status: 'active' } } };
  await writeFile(path.join(config, 'registry.json'), JSON.stringify(registry));
  await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {} }));
  const fake = path.join(root, 'bridge-worker');
  await writeFile(fake, `#!/bin/sh
if [ "$1" = "send" ]; then printf '{"delivered":true}\\n'
elif [ "$1" = "new" ]; then printf '{"id":"new-chat","ok":true,"baselineAssistantCount":2,"baselineAssistantHash":"old-hash","baselineAssistantId":"old-assistant"}\\n'
elif [ "$1" = "task" ]; then
  case " $* " in *" --baseline-assistant-id old-assistant "*) :;; *) exit 8;; esac
  case " $* " in *" --baseline-assistant-count 2 "*) :;; *) exit 8;; esac
  printf '{"ok":true}\\n'
fi
`, { mode: 0o755 });
  const call = (command, payload, ...options) => {
    const result = spawnSync('python3', [script, command, config, state, ...options], { input: payload ? JSON.stringify(payload) : undefined, encoding: 'utf8', env: { ...process.env, CHAT_BRIDGE_BIN: fake } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const input = { requestId: 'request-1', callerRef: 'controller', role: 'worker-a', message: 'Do one thing' };
    const first = call('submit', input);
    const duplicate = call('submit', input);
    assert.equal(duplicate.operationId, first.operationId);
    assert.equal(first.status, 'QUEUED');
    assert.equal(first.project, 'P');
    const second = call('submit', { ...input, requestId: 'request-2', role: 'worker-b' });
    assert.notEqual(second.operationId, first.operationId);
    assert.notEqual(second.accountId, first.accountId);
    assert.equal(call('status', null, first.operationId).status, 'QUEUED');
    assert.equal(call('cancel', null, first.operationId).status, 'CANCELLED');
    assert.equal(call('status', null, second.operationId).status, 'QUEUED');
    const dispatched = call('work-one');
    assert.equal(dispatched.operationId, second.operationId);
    assert.equal(dispatched.status, 'SENT');
    assert.equal(dispatched.sessionRef, 'new-chat');
    const callbackInput = { taskId: second.taskId, targetRef: 'controller', message: 'Result ready' };
    const queuedCallback = call('callback', callbackInput);
    assert.equal(queuedCallback.status, 'QUEUED');
    assert.equal(call('callback', callbackInput).operationId, queuedCallback.operationId);
    const sentCallback = call('work-one');
    assert.equal(sentCallback.operationId, queuedCallback.operationId);
    assert.equal(sentCallback.status, 'SENT');
    assert.equal(call('submit', { requestId: 'reply-after-callback', callerRef: 'controller', sessionRef: 'controller', message: 'Another turn' }).status, 'QUEUED');
    assert.equal(first.accountId, createHash('sha256').update('identity:one').digest('hex'));
    const changed = call('configure', { type: 'project', project: 'P', name: 'Project P', allowedAccounts: ['b'] });
    assert.equal(changed.project.name, 'Project P');
    assert.deepEqual(changed.project.allowedAccounts, ['b']);
    call('configure', { type: 'account', accountId: createHash('sha256').update('identity:two').digest('hex'), shortName: 'B', acceptNewTasks: true, maxActiveTasks: 2 });
    const store = spawnSync('python3', [path.resolve('src/state-store.py'), 'put', config, state, 'runtime'], {
      input: JSON.stringify({ base: { tasks: {} }, next: { tasks: { [second.taskId]: { taskId: second.taskId, account: 'b', status: 'RUNNING' } } } }), encoding: 'utf8' });
    assert.equal(store.status, 0, store.stderr);
    assert.equal(call('status', null, second.operationId).taskStatus, 'RUNNING');
    assert.equal(call('list').operations.find(item => item.operationId === second.operationId).taskStatus, 'RUNNING');
    const future = call('submit', { requestId: 'request-3', callerRef: 'controller', role: 'worker-c', message: 'Next task' });
    assert.equal(future.account, 'b');
    const overCapacity = spawnSync('python3', [script, 'submit', config, state], {
      input: JSON.stringify({ requestId: 'request-4', callerRef: 'controller', role: 'worker-d', message: 'Too much' }), encoding: 'utf8' });
    assert.equal(overCapacity.status, 2);
    assert.match(overCapacity.stderr, /NO_ELIGIBLE_ACCOUNT_BINDING/);
    call('cancel', null, future.operationId);
    const beforeRegistry = JSON.parse(await readFile(path.join(config, 'registry.json'), 'utf8'));
    const afterRegistry = structuredClone(beforeRegistry);
    afterRegistry.spaces = { scanned: { identity: 'two', projects: [{ id: 'g-p-' + 'c'.repeat(32), name: 'Other Project' }] } };
    const catalog = spawnSync('python3', [path.resolve('src/state-store.py'), 'put', config, state, 'registry'], {
      input: JSON.stringify({ base: beforeRegistry, next: afterRegistry }), encoding: 'utf8' });
    assert.equal(catalog.status, 0, catalog.stderr);
    const wrongProject = spawnSync('python3', [script, 'submit', config, state], {
      input: JSON.stringify({ requestId: 'request-5', callerRef: 'controller', role: 'worker-e', message: 'Wrong project' }), encoding: 'utf8' });
    assert.equal(wrongProject.status, 2);
    assert.match(wrongProject.stderr, /NO_ELIGIBLE_ACCOUNT_BINDING/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale in-flight delivery becomes unknown and cannot hold an account forever', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-stale-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  const fake = path.join(root, 'bridge-worker');
  try {
    await writeFile(path.join(config, 'registry.json'), JSON.stringify({
      accounts: { a: { identity: 'one' } }, projects: { P: { bindings: { a: { projectUrl: 'https://chatgpt.com/g/g-p-' + 'a'.repeat(32) + '/project' } } } },
      chats: { controller: { id: 'controller', project: 'P', account: 'a', status: 'active' } },
    }));
    await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {} }));
    await writeFile(fake, '#!/bin/sh\nif [ "$1" = "new" ]; then printf \'{"id":"new-chat","ok":true}\\n\'; else printf \'{"ok":true}\\n\'; fi\n', { mode: 0o755 });
    const call = (command, payload, ...args) => {
      const result = spawnSync('python3', [script, command, config, state, ...args], { input: payload ? JSON.stringify(payload) : undefined,
        encoding: 'utf8', env: { ...process.env, CHAT_BRIDGE_BIN: fake } });
      assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
    };
    const stale = call('submit', { requestId: 'stale', callerRef: 'controller', role: 'old', message: 'old' });
    const update = spawnSync('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("UPDATE operations SET status=\'DISPATCHING\',claimed_at=0 WHERE id=?",(sys.argv[2],)); db.commit()',
      path.join(state, 'bridge.sqlite3'), stale.operationId], { encoding: 'utf8' });
    assert.equal(update.status, 0, update.stderr);
    const next = call('submit', { requestId: 'next', callerRef: 'controller', role: 'new', message: 'next' });
    assert.equal(call('work-one').operationId, next.operationId);
    assert.equal(call('status', null, stale.operationId).status, 'DELIVERY_UNKNOWN');
  } finally { await rm(root, { recursive: true, force: true }); }
});
