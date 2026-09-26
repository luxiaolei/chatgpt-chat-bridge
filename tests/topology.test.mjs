import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/topology.js';

const { topologyPreview } = globalThis.__CHAT_BRIDGE_TOPOLOGY__;

test('topology preview merges login aliases but keeps distinct Project locations and all sessions', () => {
  const reg = { accounts: { default: { identity: 'same' }, reality: { identity: 'same' }, other: { identity: 'other' } },
    projects: { HZ: { businessProjectId: 'hz', bindings: {
      default: { projectId: 'g-p-one', spaceName: 'Old' }, reality: { projectId: 'g-p-one', spaceName: 'New' },
      other: { projectId: 'g-p-two', spaceName: 'Other' },
    }, workgroups: { commerce: { controllerSessionRef: 'root-a' } } } },
    spaces: { Old: { identity: 'same', accountName: 'Ru Wang' } },
    chats: { 'root-a': { id: 'root-a', project: 'HZ', account: 'default' },
      'worker-b': { id: 'worker-b', project: 'HZ', account: 'reality' } } };
  const preview = topologyPreview(reg, { tasks: { t: { sessionId: 'worker-b' } } });
  assert.equal(preview.accounts.length, 2);
  assert.deepEqual(preview.accounts.find(a => a.name === 'Ru Wang').aliases, ['default', 'reality']);
  assert.equal(preview.projects[0].locations.length, 2);
  assert.equal(preview.projects[0].sessions.length, 2);
  assert.equal(preview.projects[0].workgroups[0].controllerSessionRef, 'root-a');
  assert.equal(preview.taskCount, 1);
});
