#!/usr/bin/env python3
"""Isolated lifecycle checks; invoked by Node tests or directly, fake children only."""
import argparse
import errno
import io
import importlib.util
import json
import os
import pathlib
import runpy
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def stopped(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return not result.stdout.strip() or result.stdout.strip().startswith('Z')


def wait_stopped(pid):
    deadline = time.monotonic() + 2
    while not stopped(pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert stopped(pid), 'self-created fake descendant survived cleanup'


def wait_file(path):
    deadline = time.monotonic() + 4
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert path.exists(), 'fake process readiness timed out'
    return int(path.read_text())


class Fakes:
    def __init__(self, directory):
        self.directory = pathlib.Path(directory)
        self.children = []
        self.counter = 0

    def script(self, name, content):
        path = self.directory / name
        path.write_text('#!' + sys.executable + '\n' + content)
        path.chmod(0o700)
        return path

    def tree(self, *, closed=True, early=False):
        """Leader can exit before cleanup; its leaf installs TERM ignore before ready."""
        self.counter += 1
        prefix = 'tree-' + str(self.counter)
        leaf_pid = self.directory / (prefix + '-leaf.pid')
        leader_pid = self.directory / (prefix + '-leader.pid')
        leaf = self.script(prefix + '-leaf', f'''import os,pathlib,signal,time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path({str(leaf_pid)!r}).write_text(str(os.getpid()))
time.sleep(40)
''')
        pipes = ', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL' if closed else ''
        leader = self.script(prefix + '-leader', f'''import os,pathlib,subprocess,sys,time
pathlib.Path({str(leader_pid)!r}).write_text(str(os.getpid()))
subprocess.Popen([sys.executable,{str(leaf)!r}]{pipes})
while not pathlib.Path({str(leaf_pid)!r}).exists(): time.sleep(.01)
print('synthetic receipt', flush=True)
{'raise SystemExit(0)' if early else 'time.sleep(40)'}
''')
        return leader, leaf_pid, leader_pid

    def popen(self, args, **kwargs):
        p = subprocess.Popen(args, start_new_session=True, **kwargs)
        self.children.append(p)
        return p

    def cleanup(self):
        # Only PIDs/groups created by this fixture; never enumerate or stop live Bridge.
        for p in self.children:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for path in self.directory.glob('*.pid'):
            try:
                os.kill(int(path.read_text()), signal.SIGKILL)
            except (ProcessLookupError, ValueError):
                pass
        for p in self.children:
            try:
                p.communicate(timeout=3)
            except (subprocess.TimeoutExpired, ValueError):
                pass


def process_case(case, coordinator, runner, runner_path, fakes):
    # Faster deterministic grace for direct helper checks only. Nested/CLI cases
    # exercise the actual 7s outer / 2s inner production defaults.
    coordinator.BRIDGE_TERM_GRACE_SEC = .2
    runner.CLIENT_TERM_GRACE_SEC = .2
    if case in {'outer-closed-pipes', 'outer-exited-leader', 'outer-normal-residual'}:
        early = case != 'outer-closed-pipes'
        closed = case != 'outer-exited-leader'
        leader, leaf_file, leader_file = fakes.tree(closed=closed, early=early)
        try:
            completed = coordinator.run_bridge([sys.executable, str(leader)], timeout=.8)
            assert case == 'outer-normal-residual', 'timed-out wrapper was reported successful'
            assert completed.returncode == 0 and completed.stdout.strip() == 'synthetic receipt'
        except subprocess.TimeoutExpired:
            assert case != 'outer-normal-residual', 'normal receipt lost'
        wait_stopped(wait_file(leaf_file))
        wait_stopped(wait_file(leader_file))
    elif case == 'outer-timeout-zero-exit':
        leader = fakes.script('zero-on-term', '''import signal,sys,time
def stop(*_):
 print('{"delivered":true}',flush=True)
 raise SystemExit(0)
signal.signal(signal.SIGTERM,stop)
time.sleep(40)
''')
        try:
            coordinator.run_bridge([sys.executable,str(leader)],timeout=.8)
            raise AssertionError('timeout was upgraded to success by cleanup exit zero')
        except subprocess.TimeoutExpired as error:
            assert 'delivered' in error.output
    elif case == 'runner-closed-pipes':
        leader, leaf_file, _ = fakes.tree(closed=True, early=True)
        process = fakes.popen([sys.executable, str(leader)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        before = process.communicate(timeout=4)
        assert process.returncode == 0  # EOF and reaped leader, but a live owned group remains.
        assert not stopped(wait_file(leaf_file))
        after = runner.stop_client(process)
        assert before == after
        wait_stopped(wait_file(leaf_file))
    elif case == 'runner-timeout':
        leader, leaf_file, leader_file = fakes.tree(closed=True)
        # Synthetic Python startup needs headroom on a busy host; still prove timeout teardown.
        process = fakes.popen([sys.executable, str(runner_path), str(leader), '3'],
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = process.communicate(b'synthetic payload', timeout=9)
        assert process.returncode == 124, stderr.decode(errors='replace')
        assert b'EGO_CLIENT_TIMEOUT' in stderr and b'synthetic receipt' in stdout
        wait_stopped(wait_file(leaf_file))
        wait_stopped(wait_file(leader_file))
    elif case == 'nested-client-group':
        coordinator.BRIDGE_TERM_GRACE_SEC = 7
        leader, leaf_file, leader_file = fakes.tree(closed=True)
        runner_pid = fakes.directory / 'nested-runner.pid'
        outer = fakes.script('outer', f'''import pathlib,subprocess,sys,time
p=subprocess.Popen([sys.executable,{str(runner_path)!r},{str(leader)!r},'30'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
pathlib.Path({str(runner_pid)!r}).write_text(str(p.pid))
time.sleep(40)
''')
        try:
            coordinator.run_bridge([sys.executable, str(outer)], timeout=3)
            raise AssertionError('outer timeout was not preserved')
        except subprocess.TimeoutExpired:
            pass
        for path in (runner_pid, leader_file, leaf_file):
            wait_stopped(wait_file(path))
    elif case == 'spawn-assignment-signal':
        leader, leaf_file, leader_file = fakes.tree(closed=True)
        injection = fakes.script('race', f'''import importlib.util,os,pathlib,signal,sys,time
s=importlib.util.spec_from_file_location('runner',{str(runner_path)!r})
r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
original=r.subprocess.Popen
def inject(*args,**kwargs):
 p=original(*args,**kwargs)
 # Signal after real spawn but before assignment to runner-owned process.
 deadline=time.monotonic()+3
 while not pathlib.Path({str(leaf_file)!r}).exists() and time.monotonic()<deadline: time.sleep(.01)
 os.kill(os.getpid(),signal.SIGTERM)
 return p
r.subprocess.Popen=inject
sys.argv=['runner',{str(leader)!r},'30']
raise SystemExit(r.main())
''')
        process = fakes.popen([sys.executable, str(injection)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        process.communicate(b'synthetic input', timeout=9)
        assert process.returncode == 128 + signal.SIGTERM
        for path in (leader_file, leaf_file):
            wait_stopped(wait_file(path))
    elif case in {'coordinator-term', 'outer-spawn-assignment-int', 'serve-term'}:
        leader, leaf_file, leader_file = fakes.tree(closed=True)
        body = f'''import importlib.util,os,pathlib,signal,sys,time
s=importlib.util.spec_from_file_location('coordinator',{str(ROOT/'src/coordinator.py')!r})
c=importlib.util.module_from_spec(s);s.loader.exec_module(c)
'''
        db = None
        if case == 'outer-spawn-assignment-int':
            body += f'''original=c.subprocess.Popen
def inject(*args,**kwargs):
 p=original(*args,**kwargs)
 deadline=time.monotonic()+3
 while not pathlib.Path({str(leaf_file)!r}).exists() and time.monotonic()<deadline: time.sleep(.01)
 os.kill(os.getpid(),signal.SIGINT)
 return p
c.subprocess.Popen=inject
'''
        if case == 'serve-term':
            db, op, config, state = temporary_queue(coordinator, fakes,
                worker_body=f'import os,sys\nos.execv(sys.executable,[sys.executable,{str(leader)!r}])\n')
            body += f'c.serve(pathlib.Path({str(config)!r}),pathlib.Path({str(state)!r}))\n'
        else:
            body += f'c.run_bridge([sys.executable,{str(leader)!r}],timeout=30)\n'
        supervisor = fakes.script(case + '-supervisor', body)
        process = fakes.popen([sys.executable, str(supervisor)],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            leaf_pid, leader_pid = wait_file(leaf_file), wait_file(leader_file)
            if case != 'outer-spawn-assignment-int':
                os.kill(process.pid, signal.SIGTERM)
                time.sleep(.1)
                os.kill(process.pid, signal.SIGINT)  # Must not interrupt bounded cleanup.
            stdout, stderr = process.communicate(timeout=12)
            expected = signal.SIGINT if case == 'outer-spawn-assignment-int' else signal.SIGTERM
            assert process.returncode == 128 + expected, stderr.decode(errors='replace')
            wait_stopped(leader_pid)
            wait_stopped(leaf_pid)
            if db is not None:
                row = db.execute('SELECT status,reason,attempts FROM operations WHERE id=?', (op['operationId'],)).fetchone()
                assert tuple(row) == ('DELIVERY_UNKNOWN', 'InterruptedError', 1), tuple(row)
        finally:
            if db is not None:
                db.close()
    elif case == 'group-probe-denied':
        original = os.killpg
        probes = 0
        kills = 0
        def inconclusive(pid, sig):
            nonlocal probes, kills
            if sig == 0:
                probes += 1
                if probes <= 2:
                    raise PermissionError('synthetic inconclusive group probe')
            if sig == signal.SIGKILL:
                kills += 1
            return original(pid, sig)
        try:
            os.killpg = inconclusive
            leader, leaf_file, _ = fakes.tree(closed=True)
            try:
                coordinator.run_bridge([sys.executable,str(leader)],timeout=.8)
                raise AssertionError('expected timeout')
            except subprocess.TimeoutExpired:
                pass
            wait_stopped(wait_file(leaf_file))
            assert probes > 2 and kills == 1
            probes = 0
            leader, leaf_file, _ = fakes.tree(closed=True,early=True)
            process=fakes.popen([sys.executable,str(leader)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            process.communicate(timeout=4)
            runner.stop_client(process)
            wait_stopped(wait_file(leaf_file))
            assert probes > 2 and kills == 2
        finally:
            os.killpg = original
    elif case == 'runner-shell-teardown':
        fake = fakes.directory/'shell-client'
        fake.write_text('#!/bin/sh\ncat >/dev/null\nsleep 30\n'); fake.chmod(0o700)
        # Invoke main without its formatting wrapper so a failure shows the exact
        # cleanup line. Both client and script are isolated test-owned processes.
        invocation = fakes.script('shell-probe', f'''import importlib.util,sys
s=importlib.util.spec_from_file_location('runner',{str(runner_path)!r})
r=importlib.util.module_from_spec(s);s.loader.exec_module(r)
sys.argv=['runner',{str(fake)!r},'1']
raise SystemExit(r.main())
''')
        for _ in range(4):
            p=fakes.popen([sys.executable,str(invocation)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            out,err=p.communicate(b'synthetic payload',timeout=9)
            assert p.returncode == 124, err.decode(errors='replace')
    elif case == 'normal-and-unrelated':
        sentinel = fakes.popen([sys.executable, '-c', 'import time;time.sleep(40)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        done = coordinator.run_bridge([sys.executable, '-c', "import sys;print('normal receipt');sys.stderr.write('synthetic stderr')"], timeout=2)
        assert (done.returncode, done.stdout.strip(), done.stderr) == (0, 'normal receipt', 'synthetic stderr')
        fake = fakes.script('normal-client', "import sys\nsys.stdin.buffer.read()\nprint('normal client receipt')\nsys.stderr.write('client diagnostic')\n")
        process = fakes.popen([sys.executable, str(runner_path), str(fake), '5'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        out, err = process.communicate(b'synthetic payload', timeout=9)
        assert (process.returncode, out.strip(), err) == (0, b'normal client receipt', b'client diagnostic')
        assert not stopped(sentinel.pid), 'unrelated self-created process was stopped'
    else:
        raise ValueError('unknown test case')



def temporary_queue(coordinator, fakes, *, existing=True, worker_body):
    config, state = fakes.directory/'config', fakes.directory/'state'
    config.mkdir(); state.mkdir()
    project_id = 'g-p-' + 'a' * 32
    reg = {'accounts': {'a': {'identity': 'one'}},
           'projects': {'P': {'bindings': {'a': {'projectId': project_id,
             'projectUrl': 'https://chatgpt.com/g/' + project_id + '/project'}}}},
           'chats': {'controller': {'id': 'controller', 'project': 'P', 'account': 'a', 'role': 'conductor'},
                     'worker': {'id': 'worker', 'project': 'P', 'account': 'a', 'role': 'worker'}}}
    (config/'registry.json').write_text(json.dumps(reg))
    (state/'runtime.json').write_text(json.dumps({'tasks': {}}))
    # All inherited routing hints are removed only in this isolated test process.
    for name in ('CHAT_BRIDGE_FROM_ACCOUNT_ID', 'CHAT_BRIDGE_FROM_SPACE', 'CODEX_THREAD_ID'):
        os.environ.pop(name, None)
    os.environ['CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC'] = '180'
    worker = fakes.script('fake-bridge', worker_body)
    os.environ['CHAT_BRIDGE_BIN'] = str(worker)
    os.environ['EGO_BROWSER_BIN'] = '/nonexistent/never-contact-ego-in-this-test'
    db = coordinator.connection(config, state)
    request = {'callerRef': 'controller', 'requestId': 'synthetic-task',
               'project': 'P', 'message': 'PRIVATE_SYNTHETIC_ARGV_NOT_FOR_PUBLIC_ERRORS', 'role': 'worker'}
    if existing:
        request['sessionRef'] = 'worker'
    else:
        request['role'] = 'new-worker'
    op = coordinator.submit(db, request)
    return db, op, config, state


def integration_case(case, coordinator, runner, runner_path, fakes):
    if case in ('private-cleanup-failure', 'private-runner-cleanup-failure'):
        coordinator.BRIDGE_TERM_GRACE_SEC = runner.CLIENT_TERM_GRACE_SEC = .2
        pre_send = json.dumps({'ok': False, 'code': 'MODEL_MENU_NOT_READY', 'deliveryStage': 'PRE_SEND'})
        for denied_signal in (signal.SIGTERM, signal.SIGKILL):
            for timed_out in (False, True):
                out, err = 'synthetic captured stdout', pre_send
                class Child:
                    pid = 424242
                    returncode = None
                    stdout = stderr = None
                    calls = 0
                    def communicate(self, *args, **kwargs):
                        self.calls += 1
                        a, b = (out.encode(), err.encode()) if case.endswith('runner-cleanup-failure') else (out, err)
                        if timed_out and self.calls == 1:
                            raise subprocess.TimeoutExpired('synthetic-child', .2, output=a, stderr=b)
                        self.returncode = 0
                        return a, b
                signals = []
                def deny(pid, sig):
                    assert pid == Child.pid
                    signals.append(sig)
                    if sig == denied_signal:
                        raise PermissionError(errno.EPERM, 'synthetic cleanup denied')
                clock = iter(([0, 0, 4, 4, 5] if timed_out else [0, 0, 0, 1]) + [10] * 20)
                child = Child()
                if case == 'private-runner-cleanup-failure':
                    sink_out = io.TextIOWrapper(io.BytesIO())
                    sink_err = io.TextIOWrapper(io.BytesIO())
                    with patch.object(runner.sys, 'argv', ['runner', 'fake-client', '3']), patch.object(runner.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'synthetic input'))), patch.object(runner.sys, 'stdout', sink_out), patch.object(runner.sys, 'stderr', sink_err), patch.object(runner.subprocess, 'Popen', return_value=child), patch.object(runner.os, 'killpg', deny), patch.object(runner.time, 'monotonic', side_effect=clock), patch.object(runner.time, 'sleep'):
                        try:
                            runner.main()
                            raise AssertionError('cleanup failure became success')
                        except PermissionError as error:
                            assert error.output == out.encode() and error.stderr == err.encode()
                            assert error.cleanup['phase'] == ('TERM' if denied_signal == signal.SIGTERM else 'KILL')
                            assert error.timed_out is timed_out
                    child = Child()
                    sink_out = io.TextIOWrapper(io.BytesIO())
                    sink_err = io.TextIOWrapper(io.BytesIO())
                    clock = iter([0, 0, 1] + [10] * 20)
                    with patch.object(runner.sys, 'argv', ['runner', 'fake-client', '3']), patch.object(runner.sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'synthetic input'))), patch.object(runner.sys, 'stdout', sink_out), patch.object(runner.sys, 'stderr', sink_err), patch.object(runner.subprocess, 'Popen', return_value=child), patch.object(runner.os, 'killpg', deny), patch.object(runner.time, 'monotonic', side_effect=clock), patch.object(runner.time, 'sleep'):
                        try:
                            runpy.run_path(str(runner_path), run_name='__main__')
                            raise AssertionError('runner cleanup failure became success')
                        except SystemExit as error:
                            assert error.code == 2
                        sink_out.flush(); sink_err.flush()
                        emitted_out, emitted_err = sink_out.buffer.getvalue().decode(), sink_err.buffer.getvalue().decode()
                    assert emitted_out == out and emitted_err.startswith(err)
                    completed = subprocess.CompletedProcess([], 2, emitted_out, emitted_err)
                    assert coordinator.parse_worker_receipt(completed) is None
                    detail = coordinator.worker_diagnostic(2, emitted_err, 'dispatch', stdout=emitted_out)['worker']
                    assert detail['cleanup']['errno'] == errno.EPERM and detail['timedOut'] is timed_out
                    assert detail['capturedReceipt']['deliveryStage'] == 'PRE_SEND'
                    continue
                with patch.object(coordinator.subprocess, 'Popen', return_value=child), patch.object(coordinator.os, 'killpg', deny), patch.object(coordinator.time, 'monotonic', side_effect=clock), patch.object(coordinator.time, 'sleep'):
                    try:
                        coordinator.run_bridge(['PRIVATE_TEST_ARGV'], timeout=3)
                        raise AssertionError('cleanup failure became success')
                    except (PermissionError, subprocess.TimeoutExpired) as error:
                        captured_error = error
                        assert isinstance(error, subprocess.TimeoutExpired) is timed_out
                        assert error.output == out and error.stderr == err
                        assert error.cleanup == {'errno': errno.EPERM, 'phase': 'TERM' if denied_signal == signal.SIGTERM else 'KILL', 'leaderPid': Child.pid, 'groupId': Child.pid, 'leaderReturnCode': child.returncode}
                        diagnostic = coordinator.worker_diagnostic(None, error.stderr, 'dispatch', error=error)
                        assert diagnostic['worker']['cleanup'] == error.cleanup
                        assert diagnostic['worker']['timedOut'] is timed_out
                        assert diagnostic['worker']['capturedReceipt']['deliveryStage'] == 'PRE_SEND'
                        assert 'PRIVATE_TEST_ARGV' not in json.dumps(diagnostic) and 'synthetic captured stdout' not in json.dumps(diagnostic)
                assert signal.SIGTERM in signals and denied_signal in signals
        db, op, config, state = temporary_queue(coordinator, fakes, worker_body="raise AssertionError('must not invoke real worker')\n")
        try:
            if case == 'private-cleanup-failure':
                with patch.object(coordinator, 'run_bridge', side_effect=captured_error):
                    result = coordinator.work_one(db)
            else:
                with patch.object(coordinator, 'run_bridge', return_value=completed):
                    result = coordinator.work_one(db)
            assert result['status'] == 'DELIVERY_UNKNOWN'
            saved = db.execute('SELECT attempts,pre_send_failures,result FROM operations WHERE id=?', (op['operationId'],)).fetchone()
            assert tuple(saved[:2]) == (1, 0)
            assert json.loads(saved['result'])['worker']['cleanup']['errno'] == errno.EPERM
        finally:
            db.close()
        return
    if case in ('cancelled-claim-commit', 'cancelled-claim-after-commit'):
        marker = fakes.directory/'must-not-spawn'
        db, op, config, state = temporary_queue(coordinator, fakes,
            worker_body=f"open({str(marker)!r},'w').write('started')\n")
        class CommitSignal:
            injected = False
            def __getattr__(self, name):
                return getattr(db, name)
            def commit(self):
                inject = not self.injected and sys._getframe(1).f_code.co_name == 'claim'
                if inject:
                    self.injected = True
                    if case == 'cancelled-claim-commit':
                        os.kill(os.getpid(), signal.SIGTERM)
                db.commit()
                if inject and case == 'cancelled-claim-after-commit':
                    os.kill(os.getpid(), signal.SIGTERM)
        handle = CommitSignal()
        try:
            try:
                with coordinator.bridge_cancellation():
                    coordinator.work_one(handle)
            except SystemExit as error:
                assert error.code == 128 + signal.SIGTERM
            else:
                raise AssertionError('cancellation was not delivered')
            assert handle.injected and not marker.exists()
            row = db.execute('SELECT status,reason,attempts,claimed_at FROM operations WHERE id=?', (op['operationId'],)).fetchone()
            assert tuple(row) == ('QUEUED', None, 0, None), tuple(row)
        finally:
            db.close()
        return
    if case == 'cancelled-claim-lock':
        marker = fakes.directory/'must-not-spawn'
        db, op, config, state = temporary_queue(coordinator, fakes,
            worker_body=f"open({str(marker)!r},'w').write('started')\n")
        original, injected, releaser = coordinator.begin_immediate, False, None
        def contend(handle):
            nonlocal injected, releaser
            if not injected and sys._getframe(1).f_code.co_name == 'claim':
                injected = True
                blocker = sqlite3.connect(state/'bridge.sqlite3', check_same_thread=False)
                blocker.execute('BEGIN IMMEDIATE')
                def interrupt_and_release():
                    time.sleep(.1)
                    os.kill(os.getpid(), signal.SIGTERM)
                    time.sleep(.1)
                    blocker.commit()
                    blocker.close()
                releaser = threading.Thread(target=interrupt_and_release)
                releaser.start()
            original(handle)
        try:
            coordinator.begin_immediate = contend
            try:
                with coordinator.bridge_cancellation():
                    coordinator.work_one(db)
            except SystemExit as error:
                assert error.code == 128 + signal.SIGTERM
            else:
                raise AssertionError('cancellation was not delivered')
            assert injected and not marker.exists()
            row = db.execute('SELECT status,reason,attempts FROM operations WHERE id=?', (op['operationId'],)).fetchone()
            assert tuple(row) == ('QUEUED', None, 0), tuple(row)
        finally:
            coordinator.begin_immediate = original
            if releaser:
                releaser.join(timeout=2)
            db.close()
        return
    if case == 'timeout-budget-compatibility':
        for value, expected in [(None, 240), ('', 240), ('30', 90), ('30.5', 90.5), ('600', 660)]:
            if value is None:
                os.environ.pop('CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC', None)
            else:
                os.environ['CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC'] = value
            assert coordinator.bridge_timeout() == expected
            assert coordinator.interrupted_claim_timeout() >= expected + coordinator.TASK_RECORD_TIMEOUT_SEC + 2 * (coordinator.BRIDGE_TERM_GRACE_SEC + 4) + 60
        for value in ('29', '601', 'nan', 'inf', '-inf', 'not-a-number'):
            os.environ['CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC'] = value
            try:
                coordinator.bridge_timeout()
                raise AssertionError('invalid outer timeout was accepted')
            except ValueError:
                pass
        fake = fakes.script('timeout-client', "import sys\nsys.stdin.buffer.read()\nprint('ok')\n")
        for value in ('1', '600'):
            result = subprocess.run([sys.executable, str(runner_path), str(fake), value],
                                    input='synthetic payload', capture_output=True, text=True, timeout=4)
            assert result.returncode == 0, result.stderr
        for value in ('0', '601', 'nan', 'inf'):
            result = subprocess.run([sys.executable, str(runner_path), str(fake), value],
                                    input='', capture_output=True, text=True, timeout=4)
            assert result.returncode == 2 and 'EGO_RUNNER_ERROR' in result.stderr
        return
    if case == 'private-diagnostic-bound':
        detail = coordinator.worker_diagnostic(1, ('x' * 5000 + 'synthetic tail').encode(), 'dispatch')
        assert len(detail['worker']['stderrTail']) == 2048
        assert detail['worker']['stderrTail'].endswith('synthetic tail')
        assert detail['worker']['phase'] == 'dispatch' and detail['worker']['exitCode'] == 1
        assert '\ufffd' in coordinator.worker_diagnostic(1, b'\xff', 'evidence')['worker']['stderrTail']
        coordinator.BRIDGE_TERM_GRACE_SEC = .2
        try:
            coordinator.run_bridge([sys.executable, '-c', 'import time;time.sleep(40)', 'PRIVATE_TEST_ARGV'], timeout=.2)
            raise AssertionError('timeout expected')
        except subprocess.TimeoutExpired as error:
            assert 'PRIVATE_TEST_ARGV' not in str(error)
            assert error.cmd == 'chat-bridge'
        return
    if case == 'stale-claim-budget':
        db, op, config, state = temporary_queue(coordinator, fakes, worker_body="print('{\"delivered\":true}')\n")
        try:
            os.environ['CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC'] = '600'
            budget = coordinator.interrupted_claim_timeout()
            assert budget > coordinator.bridge_timeout() + 30
            db.execute("UPDATE operations SET status='DISPATCHING',claimed_at=? WHERE id=?", (time.time() - budget + 60, op['operationId']))
            db.commit()
            assert coordinator.claim(db) is None
            assert db.execute('SELECT status FROM operations WHERE id=?', (op['operationId'],)).fetchone()[0] == 'DISPATCHING'
            cli = [sys.executable, str(ROOT/'src/coordinator.py'), 'recover', str(config), str(state)]
            result = subprocess.run(cli, capture_output=True, text=True, timeout=5)
            assert result.returncode == 0, result.stderr
            assert db.execute('SELECT status FROM operations WHERE id=?', (op['operationId'],)).fetchone()[0] == 'DISPATCHING'
            for action in ('claim', 'recover'):
                db.execute("UPDATE operations SET status='DISPATCHING',claimed_at=? WHERE id=?", (time.time() - budget - 1, op['operationId']))
                db.commit()
                if action == 'claim':
                    assert coordinator.claim(db) is None
                else:
                    result = subprocess.run(cli, capture_output=True, text=True, timeout=5)
                    assert result.returncode == 0, result.stderr
                row = db.execute('SELECT status,reason FROM operations WHERE id=?', (op['operationId'],)).fetchone()
                assert tuple(row) == ('DELIVERY_UNKNOWN', 'WORKER_INTERRUPTED')
        finally:
            db.close()
        return

    # Only timeout cases need a short budget; normal receipt cases must tolerate
    # process startup under a concurrently running full suite.
    fixture_timeout = .7 if 'timeout' in case else 5
    # task-record-timeout targets the later record call, not its normal new-chat
    # prerequisite. Keep that prerequisite's startup budget independent.
    coordinator.bridge_timeout = lambda: 5 if case == 'task-record-timeout' else fixture_timeout
    coordinator.BRIDGE_TERM_GRACE_SEC = .2
    coordinator.TASK_RECORD_TIMEOUT_SEC = fixture_timeout
    if case == 'dispatch-unstructured-diagnostic':
        body = "import sys\nsys.stderr.write('x'*5000+'synthetic-stderr-tail');sys.exit(1)\n"
    elif case == 'dispatch-timeout-unknown':
        body = "import sys,time\nprint('{\"ok\":false,\"deliveryStage\":\"PRE_SEND\",\"code\":\"MODEL_MENU_NOT_READY\"}',file=sys.stderr,flush=True)\ntime.sleep(40)\n"
    elif case == 'evidence-timeout-unknown':
        body = "import sys,time\nif sys.argv[1]=='evidence':\n sys.stderr.write('evidence synthetic tail');sys.stderr.flush();time.sleep(40)\nelse:\n sys.exit(1)\n"
    elif case in {'task-record-timeout', 'task-record-unstructured'}:
        action = "time.sleep(40)" if case == 'task-record-timeout' else "sys.exit(1)"
        body = "import sys,time\nif sys.argv[1]=='new':\n print('{\"id\":\"new-chat\",\"ok\":true}')\nelse:\n sys.stderr.write('record synthetic tail');sys.stderr.flush();" + action + '\n'
    elif case == 'structured-receipt-preserved':
        body = "import sys\nprint('{\"ok\":false,\"deliveryStage\":\"PRE_SEND\",\"code\":\"MODEL_MENU_NOT_READY\"}',file=sys.stderr)\nsys.exit(2)\n"
    else:
        raise ValueError('unknown integration case')
    db, op, config, state = temporary_queue(coordinator, fakes, existing=not case.startswith('task-record'), worker_body=body)
    try:
        response = coordinator.work_one(db)
        row = db.execute('SELECT * FROM operations WHERE id=?', (op['operationId'],)).fetchone()
        if case == 'structured-receipt-preserved':
            assert response['status'] == 'QUEUED'
            assert response['reason'].startswith('PRE_SEND_RETRY_1_')
            assert row['pre_send_failures'] == 1
            return
        assert response['status'] == 'DELIVERY_UNKNOWN'
        assert row['pre_send_failures'] == 0
        assert row['attempts'] == 1
        private = json.loads(row['result'])
        detail = private['worker']
        assert len(detail['stderrTail']) <= 2048
        assert 'worker' not in response and 'stderrTail' not in json.dumps(response)
        assert 'PRIVATE_SYNTHETIC_ARGV' not in json.dumps(response)
        if case.startswith('task-record'):
            assert response['reason'] == 'TASK_RECORD_NOT_CONFIRMED', response
            assert response['sessionRef'] == 'new-chat'
            assert detail['phase'] == 'task-record'
            assert detail['stderrTail'].endswith('record synthetic tail')
        elif case == 'dispatch-timeout-unknown':
            assert response['reason'] == 'TimeoutExpired'
            assert detail['phase'] == 'dispatch'
        elif case == 'dispatch-unstructured-diagnostic':
            assert response['reason'] == 'WORKER_EXIT_1', response
            assert len(detail['stderrTail']) == 2048
        else:
            outcome = coordinator.reconcile_delivery(db, op['operationId'])
            assert outcome['outcome'] == 'STILL_UNKNOWN' and outcome['evidence'] is None
            latest = db.execute('SELECT * FROM operations WHERE id=?', (op['operationId'],)).fetchone()
            assert latest['status'] == row['status'] and latest['reason'] == row['reason']
            assert latest['attempts'] == row['attempts']
            diagnostic = json.loads(latest['result'])
            assert diagnostic['worker'] == detail
            assert diagnostic['reconcileWorker']['phase'] == 'evidence'
            assert diagnostic['reconcileWorker']['stderrTail'] == 'evidence synthetic tail'
            assert 'synthetic tail' not in json.dumps(outcome)
            assert db.execute('SELECT outcome,evidence FROM reconciliation_attempts').fetchone()[0] == 'STILL_UNKNOWN'
        assert coordinator.work_one(db)['status'] == 'IDLE', 'UNKNOWN was replayed'
        retry = subprocess.run([sys.executable, str(ROOT/'src/coordinator.py'), 'retry', str(config), str(state), '--operation', op['operationId']], capture_output=True, text=True, timeout=5)
        assert retry.returncode == 2 and 'RETRY_REQUIRES_PROVEN_PRE_SEND_FAILURE' in retry.stderr
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('case')
    parser.add_argument('--coordinator', type=pathlib.Path, default=ROOT/'src/coordinator.py')
    parser.add_argument('--runner', type=pathlib.Path, default=ROOT/'src/ego-runner.py')
    args = parser.parse_args()
    coordinator = load('coordinator_under_test', args.coordinator)
    runner = load('runner_under_test', args.runner)
    with tempfile.TemporaryDirectory(prefix='bridge-owned-process-test-') as directory:
        fakes = Fakes(directory)
        try:
            if args.case.startswith(('dispatch-', 'evidence-', 'task-record-', 'structured-', 'private-', 'timeout-budget-', 'stale-claim-', 'cancelled-')):
                integration_case(args.case, coordinator, runner, args.runner, fakes)
            else:
                process_case(args.case, coordinator, runner, args.runner, fakes)
            print(json.dumps({'ok': True, 'case': args.case, 'scope': 'self-created fake processes only'}))
        finally:
            fakes.cleanup()


if __name__ == '__main__':
    main()
