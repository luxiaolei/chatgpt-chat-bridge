#!/usr/bin/env python3
"""Run one ego-browser nodejs client with bounded lifetime.

This wrapper owns only the child it starts. It never kills Ego Lite, TaskSpaces,
or renderer processes. On timeout it terminates the client process group it
created and reports a machine-readable timeout.
"""
import json
import os
import signal
import subprocess
import sys


def main():
    if len(sys.argv) < 2:
        raise ValueError("ego-runner.py EGO_BROWSER [TIMEOUT_SEC]")
    binary = sys.argv[1]
    timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 120.0
    if timeout < 1 or timeout > 600:
        raise ValueError("timeout must be between 1 and 600 seconds")
    payload = sys.stdin.buffer.read()
    process = subprocess.Popen(
        [binary, "nodejs"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            stdout, stderr = process.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            stdout, stderr = process.communicate()
        if stdout:
            sys.stdout.buffer.write(stdout)
        if stderr:
            sys.stderr.buffer.write(stderr)
        print(json.dumps({"ok":False,"status":"EGO_CLIENT_TIMEOUT","timeoutSec":timeout}), file=sys.stderr)
        return 124
    if stdout:
        sys.stdout.buffer.write(stdout)
    if stderr:
        sys.stderr.buffer.write(stderr)
    return process.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print(json.dumps({"ok":False,"status":"EGO_RUNNER_ERROR","error":str(error)}), file=sys.stderr)
        raise SystemExit(2)
