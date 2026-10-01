import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';

const cases = [
  'outer-closed-pipes', 'outer-exited-leader', 'outer-normal-residual', 'outer-timeout-zero-exit',
  'runner-closed-pipes', 'runner-timeout', 'nested-client-group',
  'spawn-assignment-signal', 'normal-and-unrelated', 'group-probe-denied', 'runner-shell-teardown',
  'coordinator-term', 'outer-spawn-assignment-int', 'serve-term', 'cancelled-claim-lock',
  'cancelled-claim-commit', 'cancelled-claim-after-commit',
  'timeout-budget-compatibility', 'private-diagnostic-bound', 'stale-claim-budget',
  'private-cleanup-failure', 'private-runner-cleanup-failure', 'private-native-cleanup-failure',
  'dispatch-unstructured-diagnostic', 'dispatch-timeout-unknown',
  'evidence-timeout-unknown', 'task-record-timeout', 'task-record-unstructured',
  'structured-receipt-preserved',
];
for (const name of cases) {
  test(`owned subprocess lifecycle: ${name}`, () => {
    const result = spawnSync('python3', [path.resolve('tests/dispatch-lifecycle-check.py'), name], {
      encoding: 'utf8', timeout: 20000,
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout).ok, true);
  });
}
