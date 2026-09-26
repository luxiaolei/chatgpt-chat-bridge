import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('new --auto-account passes affinity as a separate selector argument', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-affinity-wrapper-'));
  const config = path.join(root, 'config'), state = path.join(root, 'state');
  await mkdir(config); await mkdir(state);
  const fakeEgo = path.join(root, 'ego-browser');
  try {
    await writeFile(path.join(config, 'registry.json'), JSON.stringify({
      accounts: { a: { identity: 'id-a' } }, projects: { P: { activeAccount: 'a', bindings: {
        a: { projectUrl: 'https://chatgpt.com/g/g-p-' + 'a'.repeat(32) + '/project', spaceName: 'agent-a' },
      } } }, chats: {},
    }));
    await writeFile(path.join(state, 'runtime.json'), JSON.stringify({ tasks: {} }));
    await writeFile(fakeEgo, '#!/bin/sh\ncat >/dev/null\nprintf \'{"ok":true}\\n\'\n', { mode: 0o755 });
    const result = spawnSync(path.resolve('bin/chat-bridge'), ['new', '--project', 'P', '--auto-account', '--affinity-key', 'qc:test', '--message', 'hello'], {
      encoding: 'utf8', env: { ...process.env, CHAT_BRIDGE_CONFIG_DIR: config, CHAT_BRIDGE_STATE_DIR: state, EGO_BROWSER_BIN: fakeEgo },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"ok":true/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
