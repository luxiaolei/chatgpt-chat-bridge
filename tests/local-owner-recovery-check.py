#!/usr/bin/env python3
"""Isolated native-owner recovery checks; never reads or changes installed state."""
import importlib.util
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("coordinator", ROOT / "src/coordinator.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
OLD = "11111111-1111-4111-8111-111111111111"
NEW = "22222222-2222-4222-8222-222222222222"
OTHER = "33333333-3333-4333-8333-333333333333"
CALLER = "codex:" + NEW
SCOPE = "BRIDGE_TECHNICAL_RESULT"


def denied(action, error):
    try:
        action()
    except ValueError as exc:
        assert str(exc) == error, (str(exc), error)
    else:
        raise AssertionError("expected denial: " + error)


@contextmanager
def fixture(result=True):
    with tempfile.TemporaryDirectory(prefix="bridge-local-recovery-") as directory:
        root = pathlib.Path(directory)
        config, state = root / "config", root / "state"
        config.mkdir(); state.mkdir(); (root / ".codex").mkdir()
        (config / "registry.json").write_text(json.dumps({
            "accounts": {"a": {"identity": "test"}},
            "projects": {"Chat Bridge": {"bindings": {"a": {"projectUrl": "https://chatgpt.com/g/p/test"}}}},
            "chats": {"w": {"id": "w", "project": "Chat Bridge", "account": "a", "role": "worker", "status": "active"}}
        }))
        (state / "runtime.json").write_text('{"tasks":{}}')
        native = sqlite3.connect(root / ".codex/state_5.sqlite")
        native.execute("""CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, source TEXT,
                       originator TEXT, archived INTEGER, archived_at INTEGER,
                       creator_user_id TEXT, creator_account_id TEXT)""")
        native.executemany("INSERT INTO threads VALUES (?,?, 'vscode','codex_work_desktop',?,?, 'user','account')",
                           [(OLD, str(ROOT), 1, 10), (NEW, str(ROOT), 0, None), (OTHER, str(ROOT), 0, None)])
        native.commit()
        env = {"CODEX_THREAD_ID": OLD, "CHAT_BRIDGE_FROM_ACCOUNT_ID": "", "CHAT_BRIDGE_FROM_SPACE": ""}
        with patch.dict(os.environ, env), patch.object(pathlib.Path, "home", return_value=root):
            db = c.connection(config, state)
            op = c.submit(db, {"callerRef": "codex:" + OLD, "requestId": "one", "taskId": "T",
                              "project": "Chat Bridge", "sessionRef": "w", "message": "technical check"})
            db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',attempts=1 WHERE id=?", (op["operationId"],))
            db.execute("INSERT INTO control_state VALUES ('global','PAUSED',7,'user pause','test')")
            db.commit()
            if result:
                c.result(db, {"taskId": "T", "resultVersion": "1", "status": "COMPLETE", "summary": "artifact"})
            live = c.runtime(db)
            live.setdefault("tasks", {}).setdefault("T", {"taskId": "T", "project": "Chat Bridge", "account": "a",
                "sessionId": "w", "replyToSessionRef": "codex:" + OLD, "controllerSessionRef": "codex:" + OLD,
                "status": "RESULT_RECORDED" if result else "AWAITING_DURABLE_UPDATE"}).update(
                    userControlPaused=True, recoveryAttempts=3, blockedReason="budget retained")
            db.execute("UPDATE documents SET payload=? WHERE kind='runtime'", (json.dumps(live),)); db.commit()
            digest = db.execute("SELECT payload_hash FROM task_results WHERE task_id='T'").fetchone()
            payload = {"taskId": "T", "project": "Chat Bridge", "operationId": op["operationId"],
                       "resultVersion": "1", "eventId": "result:T:1", "resultDigest": digest[0] if digest else None,
                       "callerRef": CALLER, "scope": SCOPE, "confirm": True}
            os.environ["CODEX_THREAD_ID"] = NEW
            try:
                yield db, native, root, config, state, payload
            finally:
                db.close(); native.close()


def api(db, action, payload):
    return c.local_recovery(db, action, payload)


def run():
    with fixture() as (db, native, home, config, state, p):
        denied(lambda: c.receive_local_result(db, p), "LOCAL_RESULT_OWNER_MISMATCH")
        denied(lambda: c.result_ack(db, {**p, "status": "ACCEPTED"}), "RESULT_ACK_TARGET_MISMATCH")
        before_op = dict(db.execute("SELECT * FROM operations").fetchone())
        before_result = dict(db.execute("SELECT * FROM task_results").fetchone())
        before_runtime = c.runtime(db)
        before_control = dict(db.execute("SELECT * FROM control_state").fetchone())
        assert api(db, "preview", p)["status"] == "ELIGIBLE"
        assert api(db, "preview", {**p, "resultDigest": None})["resultDigest"] == p["resultDigest"]
        assert db.execute("SELECT count(*) FROM local_result_recoveries").fetchone()[0] == 0
        for key, value in (("taskId", "foreign"), ("project", "foreign"), ("operationId", "wrong"),
                           ("resultVersion", "2"), ("eventId", "wrong"), ("resultDigest", "wrong"), ("scope", "BUSINESS_ACCEPTANCE")):
            denied(lambda: api(db, "prepare", {**p, key: value}), "LOCAL_RECOVERY_BINDING_MISMATCH")
        denied(lambda: api(db, "prepare", {**p, "confirm": False}), "LOCAL_RECOVERY_CONFIRM_REQUIRED")
        with patch.object(c, "authorize_control", side_effect=ValueError("CONTROL_ADMIN_REQUIRED")):
            denied(lambda: api(db, "prepare", p), "CONTROL_ADMIN_REQUIRED")
        for env in ({"CODEX_THREAD_ID": ""}, {"CODEX_THREAD_ID": OTHER},
                    {"CHAT_BRIDGE_FROM_ACCOUNT_ID": "web"}, {"CHAT_BRIDGE_FROM_SPACE": "web"}):
            with patch.dict(os.environ, env):
                denied(lambda: api(db, "prepare", p), "LOCAL_CALLER_CONTEXT_MISMATCH")
        missing = "44444444-4444-4444-8444-444444444444"
        with patch.dict(os.environ, {"CODEX_THREAD_ID": missing}):
            denied(lambda: api(db, "prepare", {**p, "callerRef": "codex:" + missing}), "LOCAL_RECOVERY_NATIVE_BINDING_MISMATCH")
        owner = json.loads(before_op["local_owner"])
        for field, value in (("host", "wrong-host"), ("cwd", "/foreign")):
            db.execute("UPDATE operations SET local_owner=?", (json.dumps({**owner, field: value}),)); db.commit()
            denied(lambda: api(db, "prepare", p), "LOCAL_RECOVERY_NATIVE_BINDING_MISMATCH")
        db.execute("UPDATE operations SET local_owner=?", (before_op["local_owner"],)); db.commit()
        for sql, error in (("UPDATE threads SET archived=0 WHERE id='" + OLD + "'", "LOCAL_RECOVERY_NATIVE_BINDING_MISMATCH"),
                           ("UPDATE threads SET creator_account_id='foreign' WHERE id='" + NEW + "'", "LOCAL_RECOVERY_NATIVE_BINDING_MISMATCH")):
            native.execute(sql); native.commit()
            denied(lambda: api(db, "prepare", {**p, "archived": True, "nativeProof": {"verified": True}}), error)
            native.execute("UPDATE threads SET archived=1 WHERE id=?", (OLD,))
            native.execute("UPDATE threads SET creator_account_id='account' WHERE id=?", (NEW,)); native.commit()
        proof_path = home / ".codex/state_5.sqlite"
        proof_path.rename(proof_path.with_suffix(".saved"))
        denied(lambda: api(db, "prepare", {**p, "proofPath": str(proof_path.with_suffix('.saved'))}), "LOCAL_RECOVERY_NATIVE_PROOF_UNAVAILABLE")
        proof_path.with_suffix(".saved").rename(proof_path)
        def parallel(action, payload):
            def one(_):
                separate = c.connection(config, state, initialize=False)
                try:
                    return api(separate, action, payload)
                finally:
                    separate.close()
            with ThreadPoolExecutor(max_workers=4) as pool:
                return list(pool.map(one, range(4)))
        prepared = parallel("prepare", p)
        assert len({r["recoveryId"] for r in prepared}) == 1
        assert sum(not r.get("idempotent", False) for r in prepared) == 1
        grant = {**p, "recoveryId": prepared[0]["recoveryId"]}
        denied(lambda: c.receive_local_result(db, grant), "LOCAL_RECOVERY_NOT_ACKNOWLEDGED")
        denied(lambda: api(db, "ack", {**grant, "confirm": False}), "LOCAL_RECOVERY_CONFIRM_REQUIRED")
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OTHER}):
            denied(lambda: api(db, "prepare", {**p, "callerRef": "codex:" + OTHER}), "LOCAL_RECOVERY_CONFLICT")
            denied(lambda: api(db, "ack", {**grant, "callerRef": "codex:" + OTHER}), "LOCAL_RECOVERY_BINDING_MISMATCH")
        acknowledged = parallel("ack", grant)
        assert sum(not r.get("idempotent", False) for r in acknowledged) == 1
        assert api(db, "status", grant)["status"] == "READY"
        denied(lambda: c.receive_local_result(db, {**grant, "waitSeconds": 1}), "LOCAL_RECOVERY_WAIT_FORBIDDEN")
        for field in ("taskId", "project", "operationId", "resultVersion", "eventId", "resultDigest"):
            for use in (lambda q: api(db, "ack", q), lambda q: c.receive_local_result(db, q),
                        lambda q: c.result_ack(db, {**q, "status": "ACCEPTED"})):
                # A bad task/version is rejected by the existing result lookup before overlay checks.
                try:
                    use({**grant, field: "wrong"})
                except ValueError as exc:
                    assert str(exc) in {"LOCAL_RECOVERY_BINDING_MISMATCH", "RESULT_NOT_REGISTERED"}
                else:
                    raise AssertionError("changed recovered binding accepted")
        for env in ({"CHAT_BRIDGE_FROM_ACCOUNT_ID": "web"}, {"CHAT_BRIDGE_FROM_SPACE": "web"}):
            with patch.dict(os.environ, env):
                for use in (lambda: api(db, "ack", grant), lambda: c.receive_local_result(db, grant),
                            lambda: c.result_ack(db, {**grant, "status": "ACCEPTED"})):
                    denied(use, "LOCAL_CALLER_CONTEXT_MISMATCH")
        with patch.object(c, "authorize_control", side_effect=ValueError("CONTROL_ADMIN_REQUIRED")):
            denied(lambda: c.receive_local_result(db, grant), "CONTROL_ADMIN_REQUIRED")
            denied(lambda: c.result_ack(db, {**grant, "status": "ACCEPTED"}), "CONTROL_ADMIN_REQUIRED")
        received = c.receive_local_result(db, grant)
        assert received["summary"] == "artifact" and received["acceptanceStatus"] is None
        assert received["owner"] == owner and received["recoveredCaller"]["threadId"] == NEW
        assert dict(db.execute("SELECT * FROM operations").fetchone()) == before_op
        assert dict(db.execute("SELECT * FROM task_results").fetchone()) == before_result
        assert c.runtime(db) == before_runtime
        assert dict(db.execute("SELECT * FROM control_state").fetchone()) == before_control
        assert c.runtime(db)["tasks"]["T"]["userControlPaused"] is True
        assert c.runtime(db)["tasks"]["T"]["recoveryAttempts"] == 3
        for command in ("local-recovery-status", "receive"):
            restarted = subprocess.run([sys.executable, __file__, "--call", command, str(config), str(state), str(home)],
                                       input=json.dumps(grant), text=True, capture_output=True,
                                       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10)
            assert restarted.returncode == 0, restarted.stderr
            assert json.loads(restarted.stdout)["recoveryId"] == grant["recoveryId"]
        ack = {**grant, "status": "ACCEPTED", "message": "technical artifact checked"}
        assert c.result_ack(db, ack)["recoveryId"] == grant["recoveryId"]
        assert c.result_ack(db, ack)["idempotent"]
        denied(lambda: c.result_ack(db, {**ack, "status": "REJECTED"}), "RESULT_ALREADY_ACKED")
        after_result = dict(db.execute("SELECT * FROM task_results").fetchone())
        for key in ("owner_ref", "owner_project", "owner_account", "payload_hash", "event_id", "recorded_at"):
            assert after_result[key] == before_result[key]
        assert dict(db.execute("SELECT * FROM operations").fetchone()) == before_op
        assert dict(db.execute("SELECT * FROM control_state").fetchone()) == before_control
        audit = [json.loads(row[0]) for row in db.execute("SELECT payload FROM management_events WHERE kind='LOCAL_RESULT_RECOVERY_RESULT_ACK'")]
        assert len(audit) == 1 and audit[0]["callerRef"] == CALLER and audit[0]["originalOwnerRef"] == "codex:" + OLD

    with fixture(False) as (db, native, home, config, state, p):
        for action in ("preview", "prepare"):
            assert api(db, action, {**p, "resultVersion": None, "eventId": None})["status"] == "PENDING"
        assert db.execute("SELECT count(*) FROM local_result_recoveries").fetchone()[0] == 0
        assert db.execute("SELECT status,attempts FROM operations").fetchone()[:] == ("DELIVERY_UNKNOWN", 1)

    with fixture() as (db, native, home, config, state, p):
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OLD}):
            c.result_ack(db, {"taskId": "T", "resultVersion": "1", "callerRef": "codex:" + OLD, "status": "BLOCKED", "message": "historical disposition"})
        assert api(db, "preview", p)["status"] == "ALREADY_ACKED"
        denied(lambda: api(db, "prepare", p), "RESULT_ALREADY_ACKED")
        assert db.execute("SELECT count(*) FROM local_result_recoveries").fetchone()[0] == 0

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        api(db, "ack", g)
        native.execute("UPDATE threads SET archived_at=11 WHERE id=?", (OLD,)); native.commit()
        denied(lambda: c.receive_local_result(db, g), "LOCAL_RECOVERY_STALE_NATIVE_PROOF")
        native.execute("UPDATE threads SET archived_at=10 WHERE id=?", (OLD,)); native.commit()
        db.execute("UPDATE local_result_recoveries SET expires_at='2000-01-01T00:00:00+00:00'"); db.commit()
        assert api(db, "status", g)["status"] == "EXPIRED"
        denied(lambda: c.receive_local_result(db, g), "LOCAL_RECOVERY_EXPIRED")
        denied(lambda: api(db, "prepare", p), "LOCAL_RECOVERY_EXPIRED")

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        api(db, "ack", g)
        c.result(db, {"taskId": "T", "resultVersion": "2", "status": "COMPLETE", "summary": "new artifact"})
        denied(lambda: c.receive_local_result(db, g), "LOCAL_RECOVERY_STALE_RESULT")
        denied(lambda: c.result_ack(db, {**g, "status": "ACCEPTED"}), "LOCAL_RECOVERY_STALE_RESULT")
        digest = db.execute("SELECT payload_hash FROM task_results WHERE result_version='2'").fetchone()[0]
        p2 = {**p, "resultVersion": "2", "eventId": "result:T:2", "resultDigest": digest}
        assert api(db, "prepare", p2)["recoveryId"] != g["recoveryId"]

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        api(db, "ack", g)
        # A lexically smaller new event at the same timestamp still invalidates the grant.
        c.result(db, {"taskId": "T", "resultVersion": "0", "status": "COMPLETE", "summary": "later insertion"})
        db.execute("UPDATE task_results SET recorded_at=(SELECT recorded_at FROM task_results WHERE result_version='1') WHERE result_version='0'")
        db.commit()
        denied(lambda: c.receive_local_result(db, g), "LOCAL_RECOVERY_STALE_RESULT")
        denied(lambda: api(db, "ack", g), "LOCAL_RECOVERY_STALE_RESULT")

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        db.execute("UPDATE task_results SET payload_hash='changed'"); db.commit()
        denied(lambda: api(db, "ack", g), "LOCAL_RECOVERY_BINDING_MISMATCH")
        db.execute("UPDATE task_results SET payload_hash=?", (p["resultDigest"],)); db.commit()
        native.execute("UPDATE threads SET archived=1 WHERE id=?", (NEW,)); native.commit()
        denied(lambda: api(db, "ack", g), "LOCAL_RECOVERY_NATIVE_BINDING_MISMATCH")
        native.execute("UPDATE threads SET archived=0 WHERE id=?", (NEW,)); native.commit()
        db.execute("UPDATE operations SET session_ref='changed'"); db.commit()
        denied(lambda: api(db, "ack", g), "LOCAL_RECOVERY_STALE_BINDING")

    with fixture() as (db, native, home, config, state, p):
        columns = [row[1] for row in db.execute("PRAGMA table_info(operations)")]
        clone = dict(db.execute("SELECT * FROM operations").fetchone())
        clone.update(id="another-dispatch", request_key="another-request")
        db.execute("INSERT INTO operations (" + ",".join(columns) + ") VALUES (" + ",".join("?" for _ in columns) + ")",
                   tuple(clone[key] for key in columns)); db.commit()
        for operation_id in (p["operationId"], "another-dispatch"):
            denied(lambda: api(db, "prepare", {**p, "operationId": operation_id}), "LOCAL_RECOVERY_BINDING_MISMATCH")

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        api(db, "ack", g)
        def process_ack(payload, thread):
            return subprocess.run([sys.executable, __file__, "--call", "ack", str(config), str(state), str(home)],
                                  input=json.dumps(payload), text=True, capture_output=True,
                                  env={**os.environ, "CODEX_THREAD_ID": thread, "PYTHONDONTWRITEBYTECODE": "1"}, timeout=10)
        original = {"taskId": "T", "resultVersion": "1", "callerRef": "codex:" + OLD, "status": "BLOCKED", "message": "original"}
        recovered = {**g, "status": "ACCEPTED", "message": "recovered"}
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda pair: process_ack(*pair), [(original, OLD), (recovered, NEW)]))
        assert sorted(r.returncode for r in results) == [0, 2], [r.stderr for r in results]
        loser = next(r for r in results if r.returncode)
        assert json.loads(loser.stderr)["error"] == "RESULT_ALREADY_ACKED"
        settled = db.execute("SELECT owner_ref,acceptance_status FROM task_results").fetchone()
        assert settled[0] == "codex:" + OLD and settled[1] in {"ACCEPTED", "BLOCKED"}
        assert db.execute("SELECT status,attempts FROM operations").fetchone()[:] == ("DELIVERY_UNKNOWN", 1)
        assert c.runtime(db)["tasks"]["T"]["userControlPaused"] is True

    with fixture() as (db, native, home, config, state, p):
        g = {**p, "recoveryId": api(db, "prepare", p)["recoveryId"]}
        api(db, "ack", g)
        with patch.dict(os.environ, {"CODEX_THREAD_ID": OLD}):
            c.result_ack(db, {"taskId": "T", "resultVersion": "1", "callerRef": "codex:" + OLD, "status": "BLOCKED"})
        denied(lambda: c.result_ack(db, {**g, "status": "BLOCKED"}), "RESULT_ALREADY_ACKED")
    print(json.dumps({"ok": True}))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--call":
        _, _, command, config, state, home = sys.argv
        sys.argv = [str(ROOT / "src/coordinator.py"), command, config, state]
        with patch.object(pathlib.Path, "home", return_value=pathlib.Path(home)):
            try:
                c.main()
            except (ValueError, KeyError, sqlite3.Error) as error:
                print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
                raise SystemExit(2)
    else:
        run()
