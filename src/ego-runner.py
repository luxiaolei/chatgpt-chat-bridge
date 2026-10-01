#!/usr/bin/env python3
"""Run one ego-browser nodejs client with bounded lifetime.

This wrapper owns only the child group it starts, never Ego Lite, TaskSpaces or
renderers. It forwards termination to that group, including after pipe EOF or
leader exit, and reports a machine-readable timeout without replaying a send.
"""
import json
import os
import signal
import subprocess
import sys
import time


CLIENT_TERM_GRACE_SEC = 2


def stop_client(process):
    deadline = time.monotonic() + CLIENT_TERM_GRACE_SEC
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        error.cleanup = {"errno": error.errno, "phase": "TERM", "leaderPid": process.pid, "groupId": process.pid, "leaderReturnCode": process.returncode}
        raise
    try:
        stdout, stderr = process.communicate(timeout=CLIENT_TERM_GRACE_SEC)
    except subprocess.TimeoutExpired as pending:
        stdout, stderr = pending.output, pending.stderr
    # A reaped leader / closed pipes is not proof that its owned group is empty.
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            break
        except PermissionError:
            # A probe can be inconclusive during teardown. It is NOT proof of
            # an empty group: retain the grace and the final KILL attempt.
            pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError as error:
                error.output, error.stderr = stdout, stderr
                error.cleanup = {"errno": error.errno, "phase": "KILL", "leaderPid": process.pid, "groupId": process.pid, "leaderReturnCode": process.returncode}
                raise
            break
        time.sleep(min(.05, remaining))
    try:
        return process.communicate(timeout=2)
    except subprocess.TimeoutExpired as pending:
        for stream in (process.stdout, process.stderr):
            if stream:
                stream.close()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
        return pending.output or stdout or b"", pending.stderr or stderr or b""


def write_output(stdout, stderr):
    if stdout:
        sys.stdout.buffer.write(stdout)
    if stderr:
        sys.stderr.buffer.write(stderr)


def main():
    if len(sys.argv) < 2:
        raise ValueError("ego-runner.py EGO_BROWSER [TIMEOUT_SEC]")
    binary = sys.argv[1]
    timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
    if not 1 <= timeout <= 600:  # Direct-runner compatibility, rejecting NaN/inf.
        raise ValueError("timeout must be between 1 and 600 seconds")
    payload = sys.stdin.buffer.read()
    process, interrupted, timed_out, original_error = None, None, False, None
    stdout, stderr = b"", b""
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}

    def interrupt(signum, _frame):
        nonlocal interrupted
        interrupted = signum
        # If Popen created the client but has not assigned it yet, save the signal
        # and unwind only after ownership has been captured.
        if process is not None:
            raise SystemExit(128 + signum)

    for sig in previous:
        signal.signal(sig, interrupt)
    try:
        process = subprocess.Popen(
            [binary, "nodejs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True,
        )
        if interrupted is not None:
            raise SystemExit(128 + interrupted)
        try:
            stdout, stderr = process.communicate(payload, timeout=timeout)
        except subprocess.TimeoutExpired as pending:
            stdout, stderr = pending.output, pending.stderr
            timed_out = True
    except OSError as error:
        original_error = error
        raise
    finally:
        # Repeated TERM/INT cannot interrupt cleanup of the separately owned group.
        for sig in previous:
            signal.signal(sig, signal.SIG_IGN)
        try:
            if process is not None:
                try:
                    write_output(*stop_client(process))
                except PermissionError as cleanup_error:
                    error = original_error or cleanup_error
                    error.output = getattr(cleanup_error, "output", None) or stdout
                    error.stderr = getattr(cleanup_error, "stderr", None) or stderr
                    error.cleanup = cleanup_error.cleanup
                    error.timed_out = timed_out
                    write_output(error.output, error.stderr)
                    raise error from None
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    if timed_out:
        print(json.dumps({"ok": False, "status": "EGO_CLIENT_TIMEOUT", "timeoutSec": timeout}), file=sys.stderr)
        return 124
    return process.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        payload = {"ok": False, "status": "EGO_RUNNER_ERROR", "error": str(error)}
        if hasattr(error, "cleanup"):
            payload.update(cleanup=error.cleanup, timedOut=error.timed_out)
            print(file=sys.stderr)  # Keep the failure marker separate from captured diagnostics.
        print(json.dumps(payload), file=sys.stderr)
        raise SystemExit(2)
