#!/usr/bin/env python3
"""Local durable dispatch queue. A claim is never silently retried after a crash."""
import hashlib
import json
import os
import re
import pathlib
import sqlite3
import subprocess
import sys
import time
import uuid
import fcntl
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone


def stamp():
    return datetime.now(timezone.utc).isoformat()


def account_id(identity):
    return hashlib.sha256(("identity:" + identity).encode()).hexdigest()


def connection(config, state, initialize=True):
    if initialize:
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("state-store.py")), "get", str(config), str(state), "registry"],
                       check=True, stdout=subprocess.DEVNULL, timeout=20)
    db = sqlite3.connect(state / "bridge.sqlite3", timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    if not initialize:
        return db
    db.execute("""CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload_hash TEXT NOT NULL,
        status TEXT NOT NULL, project TEXT NOT NULL, account_alias TEXT NOT NULL,
        account_id TEXT NOT NULL, caller_ref TEXT NOT NULL, session_ref TEXT,
        role TEXT NOT NULL, message TEXT NOT NULL, task_id TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, not_before REAL NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, reason TEXT, result TEXT, claimed_at REAL
    )""")
    if "kind" not in {row[1] for row in db.execute("PRAGMA table_info(operations)")}:
        db.execute("ALTER TABLE operations ADD COLUMN kind TEXT NOT NULL DEFAULT 'dispatch'")
    db.commit()
    return db


def registry(db):
    row = db.execute("SELECT payload FROM documents WHERE kind='registry'").fetchone()
    return json.loads(row[0])


def binding_observed(reg, alias, binding):
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    observed = [project.get("id") for space in (reg.get("spaces") or {}).values()
                if space.get("identity") == identity for project in space.get("projects") or []]
    if not observed:
        return True  # Legacy bindings remain usable until their first Project catalog scan.
    project_id = binding.get("projectId") or (re.search(r"/g/(g-p-[^/]+)", binding.get("projectUrl") or "") or [None, None])[1]
    canonical = lambda value: (re.search(r"g-p-[0-9a-f]{32}", value or "") or [None])[0]
    return bool(canonical(project_id)) and canonical(project_id) in {canonical(item) for item in observed}


def runtime(db):
    row = db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
    return json.loads(row[0])


def public(row):
    if row is None:
        raise ValueError("UNKNOWN_OPERATION")
    return {key: row[key] for key in ("id", "kind", "status", "project", "account_alias", "account_id", "caller_ref", "session_ref", "role", "task_id", "created_at", "updated_at", "not_before", "attempts", "reason")}


def response(row):
    item = public(row)
    return {"operationId": item.pop("id"), "accountId": item.pop("account_id"),
            "account": item.pop("account_alias"), "callerRef": item.pop("caller_ref"),
            "sessionRef": item.pop("session_ref"), "taskId": item.pop("task_id"),
            "createdAt": item.pop("created_at"), "updatedAt": item.pop("updated_at"),
            "notBefore": item.pop("not_before"), **item}


def observed_response(row, tasks):
    value = response(row)
    task = tasks.get(row["task_id"]) if row["kind"] == "dispatch" else None
    if task:
        value["taskStatus"] = task.get("status")
    return value


def submit(db, payload):
    caller = str(payload.get("callerRef") or "").strip()
    request_id = str(payload.get("requestId") or "").strip()
    message = str(payload.get("message") or "")
    if not caller or not request_id or not message or len(request_id) > 128 or len(message) > 100000:
        raise ValueError("callerRef, requestId and nonempty message are required")
    key = "dispatch:" + caller + ":" + request_id
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
        if prior:
            if prior["payload_hash"] != digest:
                raise ValueError("IDEMPOTENCY_CONFLICT")
            db.commit()
            return response(prior)
        reg, rt = registry(db), runtime(db)
        source = (reg.get("chats") or {}).get(caller)
        if not source or source.get("status", "active") != "active":
            raise ValueError("CALLER_REF_NOT_REGISTERED")
        source_identity = ((reg.get("accounts") or {}).get(source.get("account")) or {}).get("identity")
        origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
        if origin and (not source_identity or account_id(source_identity) != origin):
            raise ValueError("CALLER_REF_ORIGIN_MISMATCH")
        project = str(payload.get("project") or source.get("project") or "")
        project_record = (reg.get("projects") or {}).get(project)
        if not project_record:
            raise ValueError("PROJECT_NOT_REGISTERED")
        if project_record.get("archived"):
            raise ValueError("PROJECT_ARCHIVED")
        target = str(payload.get("sessionRef") or "").strip() or None
        role = str(payload.get("role") or "").strip()
        target_chat = (reg.get("chats") or {}).get(target) if target else None
        if target and (not target_chat or target_chat.get("project") != project or target_chat.get("status", "active") != "active"):
            raise ValueError("TARGET_SESSION_NOT_REGISTERED")
        if target_chat:
            role = target_chat.get("role") or role or target
        if not role:
            raise ValueError("role or sessionRef required")
        if not target:
            matches = [chat for chat in (reg.get("chats") or {}).values()
                       if chat.get("project") == project and chat.get("status", "active") == "active" and chat.get("role") == role]
            if len(matches) > 1:
                raise ValueError("AMBIGUOUS_TARGET_ROLE")
            if matches:
                target_chat = matches[0]
                target = target_chat["id"]
        if target:
            busy = any(task.get("sessionId") == target and str(task.get("status", "")).upper() not in {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED"}
                       for task in (rt.get("tasks") or {}).values())
            busy |= db.execute("SELECT 1 FROM operations WHERE session_ref=? AND status IN ('QUEUED','DISPATCHING') LIMIT 1", (target,)).fetchone() is not None
            if busy:
                raise ValueError("TARGET_SESSION_BUSY")
        bindings = project_record.get("bindings") or {}
        accounts = reg.get("accounts") or {}
        requested = str(payload.get("account") or "").strip() or None
        if target_chat:
            alias = target_chat.get("account")
            if requested and requested != alias:
                raise ValueError("TARGET_ACCOUNT_FIXED")
        else:
            candidates = []
            seen = set()
            for candidate, binding in bindings.items():
                allowed = project_record.get("allowedAccounts")
                if isinstance(allowed, list) and candidate not in allowed:
                    continue
                identity = (accounts.get(candidate) or {}).get("identity")
                if not identity or not binding.get("projectUrl") or not binding_observed(reg, candidate, binding):
                    continue
                stable = account_id(identity)
                if stable in seen:
                    continue
                seen.add(stable)
                if requested and candidate != requested:
                    continue
                if (accounts.get(candidate) or {}).get("acceptNewTasks") is False:
                    continue
                max_tasks = (accounts.get(candidate) or {}).get("maxActiveTasks")
                reserved = db.execute("SELECT count(*) FROM operations WHERE account_id=? AND kind='dispatch' AND status IN ('QUEUED','DISPATCHING')", (stable,)).fetchone()[0]
                active = sum(1 for task in (rt.get("tasks") or {}).values()
                             if str(task.get("status", "")).upper() not in {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED"}
                             and (accounts.get(task.get("account")) or {}).get("identity") == identity)
                load = reserved + active
                if isinstance(max_tasks, int) and max_tasks > 0 and load >= max_tasks:
                    continue
                candidates.append((load, candidate, stable))
            if not candidates:
                raise ValueError("NO_ELIGIBLE_ACCOUNT_BINDING")
            _, alias, _ = min(candidates)
        identity = (accounts.get(alias) or {}).get("identity")
        if not identity:
            raise ValueError("TARGET_IDENTITY_UNVERIFIED")
        stable = account_id(identity)
        if not bindings.get(alias, {}).get("projectUrl") or (not target_chat and not binding_observed(reg, alias, bindings[alias])):
            raise ValueError("TARGET_PROJECT_NOT_BOUND")
        operation_id = str(uuid.uuid4())
        task_id = str(payload.get("taskId") or "Q-" + operation_id)
        if not task_id or len(task_id) > 128 or not all(ch.isalnum() or ch in "._:-" for ch in task_id):
            raise ValueError("INVALID_TASK_ID")
        now = stamp()
        db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (operation_id, key, digest, "QUEUED", project, alias, stable, caller, target, role, message, task_id, now, now, time.time()))
        row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        db.commit()
        return response(row)
    except Exception:
        db.rollback()
        raise


def callback(db, payload):
    task_id = str(payload.get("taskId") or "").strip()
    target_ref = str(payload.get("targetRef") or "").strip()
    message = str(payload.get("message") or "")
    if not task_id or not target_ref or not message or len(message) > 100000:
        raise ValueError("taskId, targetRef and message are required")
    digest = hashlib.sha256(message.encode()).hexdigest()
    key = "callback:" + task_id + ":" + target_ref + ":" + digest
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
        if prior:
            db.commit()
            return response(prior)
        reg = registry(db)
        target = (reg.get("chats") or {}).get(target_ref)
        if not target or target.get("status", "active") != "active":
            raise ValueError("CALLBACK_TARGET_NOT_REGISTERED")
        alias = target.get("account")
        identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
        if not identity:
            raise ValueError("CALLBACK_ACCOUNT_UNVERIFIED")
        operation_id, now = str(uuid.uuid4()), stamp()
        db.execute("""INSERT INTO operations(id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,role,message,task_id,created_at,updated_at,not_before,kind)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (operation_id, key, digest, "QUEUED", target["project"], alias, account_id(identity), target_ref,
                    target_ref, target.get("role") or target_ref, message, task_id, now, now, time.time(), "callback"))
        row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        db.commit()
        return response(row)
    except Exception:
        db.rollback()
        raise


def configure(config, state, payload):
    store = str(pathlib.Path(__file__).with_name("state-store.py"))
    base = json.loads(subprocess.run([sys.executable, store, "get", str(config), str(state), "registry"],
                                     check=True, capture_output=True, text=True, timeout=20).stdout)
    next_value = json.loads(json.dumps(base))
    accounts = next_value.setdefault("accounts", {})
    projects = next_value.setdefault("projects", {})
    kind = payload.get("type")
    project_key = str(payload.get("project") or "").strip()
    if kind == "account":
        stable = payload.get("accountId")
        aliases = [alias for alias, record in accounts.items() if record.get("identity") and account_id(record["identity"]) == stable]
        if not aliases:
            raise ValueError("ACCOUNT_NOT_VERIFIED")
        short_name = str(payload.get("shortName") or "").strip()
        limit = payload.get("maxActiveTasks")
        if (not short_name or len(short_name) > 64 or not isinstance(payload.get("acceptNewTasks"), bool)
                or not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 20):
            raise ValueError("INVALID_ACCOUNT_SETTINGS")
        for alias in aliases:
            accounts[alias].update(shortName=short_name, acceptNewTasks=payload["acceptNewTasks"], maxActiveTasks=limit)
        result = {"accountId": stable, "aliases": aliases, "shortName": short_name,
                  "acceptNewTasks": payload["acceptNewTasks"], "maxActiveTasks": limit}
    elif kind == "project":
        if not project_key or len(project_key) > 100:
            raise ValueError("INVALID_PROJECT")
        current = projects.setdefault(project_key, {"name": project_key, "activeAccount": next_value.get("defaultAccount") or "default",
                                                   "rootController": "conductor", "bindings": {}, "workgroups": {}})
        name = str(payload.get("name") or "").strip()
        allowed = payload.get("allowedAccounts")
        if not name or len(name) > 100 or not isinstance(allowed, list) or len(set(allowed)) != len(allowed):
            raise ValueError("INVALID_PROJECT_SETTINGS")
        if any(alias not in (current.get("bindings") or {}) or not (accounts.get(alias) or {}).get("identity") for alias in allowed):
            raise ValueError("ACCOUNT_BINDING_REQUIRED")
        if not isinstance(payload.get("archived", False), bool):
            raise ValueError("INVALID_ARCHIVE_FLAG")
        current.update(name=name, allowedAccounts=allowed, archived=payload.get("archived", False))
        result = {"project": {"key": project_key, "name": name, "allowedAccounts": allowed, "archived": current["archived"]}}
    elif kind == "binding":
        current = projects.get(project_key)
        alias = payload.get("account")
        actual_id = str(payload.get("projectId") or "")
        if not current or alias not in accounts or not (accounts[alias] or {}).get("identity"):
            raise ValueError("PROJECT_OR_ACCOUNT_NOT_REGISTERED")
        if not re.fullmatch(r"g-p-[0-9a-f]{32}(?:-[a-z0-9-]+)?", actual_id):
            raise ValueError("INVALID_CHATGPT_PROJECT_ID")
        identity = accounts[alias]["identity"]
        observed = [(space, project) for space in (next_value.get("spaces") or {}).values() if space.get("identity") == identity
                    for project in space.get("projects") or [] if project.get("id") == actual_id and space.get("profileId")]
        if not observed:
            raise ValueError("PROJECT_PROFILE_NOT_VERIFIED_IN_ACCOUNT")
        space, project = observed[0]
        account_name = space.get("accountName") or alias
        slug = re.sub(r"[^a-z0-9]+", "-", account_name.lower()).strip("-") or alias
        binding = {"account": alias, "projectId": actual_id, "projectUrl": project["url"],
                   "spaceName": "chat-bridge-agent-" + slug, "profileId": space["profileId"],
                   "spaceId": None, "controlPage": None}
        current.setdefault("bindings", {})[alias] = binding
        result = {"binding": {"project": project_key, "account": alias, "projectId": actual_id, "spaceName": binding["spaceName"]}}
    elif kind == "workgroup":
        current = projects.get(project_key)
        group_id = str(payload.get("workgroupId") or "").strip()
        name = str(payload.get("name") or "").strip()
        controller = str(payload.get("controllerSessionRef") or "").strip() or None
        if not current or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", group_id) or not name or len(name) > 100:
            raise ValueError("INVALID_WORKGROUP")
        if controller and ((next_value.get("chats") or {}).get(controller) or {}).get("project") != project_key:
            raise ValueError("WORKGROUP_CONTROLLER_NOT_REGISTERED")
        current.setdefault("workgroups", {})[group_id] = {"name": name, "controllerSessionRef": controller}
        result = {"workgroup": {"id": group_id, "name": name, "controllerSessionRef": controller}}
    else:
        raise ValueError("UNKNOWN_CONFIG_TYPE")
    written = subprocess.run([sys.executable, store, "put", str(config), str(state), "registry"],
                             input=json.dumps({"base": base, "next": next_value}), capture_output=True, text=True, timeout=20)
    if written.returncode:
        raise ValueError(written.stderr.strip() or "CONFIG_WRITE_FAILED")
    return result


def claim(db):
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_INTERRUPTED',updated_at=? WHERE status='DISPATCHING' AND claimed_at<?",
                   (stamp(), time.time() - 300))
        row = db.execute("""SELECT * FROM operations AS candidate WHERE status='QUEUED' AND not_before<=?
            AND NOT EXISTS (SELECT 1 FROM operations AS active WHERE active.status='DISPATCHING' AND active.account_id=candidate.account_id)
            ORDER BY created_at,id LIMIT 1""", (time.time(),)).fetchone()
        if row:
            db.execute("UPDATE operations SET status='DISPATCHING',attempts=attempts+1,claimed_at=?,updated_at=?,reason=NULL WHERE id=?",
                       (time.time(), stamp(), row["id"]))
            row = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
        db.commit()
        return row
    except Exception:
        db.rollback()
        raise


def finish(db, row, status, reason=None, retry_after=0, result=None, session_ref=None):
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("""UPDATE operations SET status=?,reason=?,not_before=?,updated_at=?,result=?,session_ref=coalesce(?,session_ref),claimed_at=NULL
                      WHERE id=? AND status='DISPATCHING'""",
                   (status, reason, time.time() + retry_after, stamp(), json.dumps(result) if result is not None else None, session_ref, row["id"]))
        updated = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
        db.commit()
        return response(updated)
    except Exception:
        db.rollback()
        raise


def work_one(db):
    row = claim(db)
    if row is None:
        return {"status": "IDLE"}
    bridge = os.environ.get("CHAT_BRIDGE_BIN") or str(pathlib.Path.home() / ".local/bin/chat-bridge")
    args = [bridge]
    if row["kind"] == "callback":
        args += ["send", row["session_ref"], row["message"], "--project", row["project"], "--account", row["account_alias"]]
    elif row["session_ref"]:
        args += ["send", row["session_ref"], row["message"], "--project", row["project"], "--account", row["account_alias"],
                 "--task", row["task_id"], "--caller-ref", row["caller_ref"]]
    else:
        args += ["new", "--project", row["project"], "--account", row["account_alias"], "--name", row["role"],
                 "--role", row["role"], "--message", row["message"]]
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        return finish(db, row, "DELIVERY_UNKNOWN", type(error).__name__)
    if result.returncode == 75:
        try:
            detail = json.loads(result.stderr)
            if detail.get("code") in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"}:
                return finish(db, row, "QUEUED", detail.get("reason"), max(1, float(detail.get("retryAfterSec", 10))))
        except (ValueError, TypeError):
            pass
    if result.returncode and any(token in result.stderr for token in ("CHAT_BUSY", "USER_DRAFT_PRESENT")):
        return finish(db, row, "QUEUED", "TARGET_BUSY_OR_DRAFT", 30)
    if result.returncode:
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_EXIT_" + str(result.returncode))
    try:
        output = json.loads(result.stdout)
    except ValueError:
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_RECEIPT_UNREADABLE")
    if output.get("ok") is False or (row["session_ref"] and not output.get("delivered")):
        return finish(db, row, "DELIVERY_UNKNOWN", "SEND_NOT_CONFIRMED")
    target = row["session_ref"] or output.get("id")
    if not target:
        return finish(db, row, "DELIVERY_UNKNOWN", "SESSION_ID_NOT_CONFIRMED")
    if not row["session_ref"]:
        record_args = [bridge, "task", "set", row["task_id"], "--project", row["project"],
                       "--account", row["account_alias"], "--session", target, "--role", row["role"],
                       "--status", "DISPATCHED", "--caller-ref", row["caller_ref"],
                       "--original-message", row["message"]]
        for source, option in (("baselineAssistantCount", "--baseline-assistant-count"),
                               ("baselineAssistantHash", "--baseline-assistant-hash"),
                               ("baselineAssistantId", "--baseline-assistant-id"),
                               ("dispatchedAt", "--dispatched-at")):
            if output.get(source) is not None:
                record_args += [option, str(output[source])]
        recorded = subprocess.run(record_args,
                                  capture_output=True, text=True, timeout=30)
        if recorded.returncode:
            return finish(db, row, "DELIVERY_UNKNOWN", "TASK_RECORD_NOT_CONFIRMED", session_ref=target)
    return finish(db, row, "SENT", result={"delivered": True}, session_ref=target)


def serve(config, state):
    lock_path = state / "coordinator.lock"
    with open(lock_path, "a+") as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("COORDINATOR_ALREADY_RUNNING")
        print(json.dumps({"status": "RUNNING"}), flush=True)
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending = set()
            def one():
                worker_db = connection(config, state, initialize=False)
                try:
                    return work_one(worker_db)
                finally:
                    worker_db.close()
            while True:
                for future in tuple(pending):
                    if future.done():
                        try:
                            future.result()
                        except Exception as error:
                            print(json.dumps({"status": "WORKER_ERROR", "errorType": type(error).__name__}), file=sys.stderr, flush=True)
                        pending.remove(future)
                if len(pending) < 3:
                    pending.add(pool.submit(one))
                time.sleep(1)


def main():
    command, config_name, state_name, *args = sys.argv[1:]
    config, state = pathlib.Path(config_name), pathlib.Path(state_name)
    db = connection(config, state)
    try:
        if command == "submit":
            if args:
                names = {"--request-id": "requestId", "--caller-ref": "callerRef", "--project": "project",
                         "--role": "role", "--session-ref": "sessionRef", "--message": "message", "--account": "account", "--task": "taskId"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("submit options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = submit(db, payload)
        elif command == "callback":
            value = callback(db, json.load(sys.stdin))
        elif command == "configure":
            value = configure(config, state, json.loads(args[0]) if args else json.load(sys.stdin))
        elif command == "status":
            value = observed_response(db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone(), runtime(db).get("tasks") or {})
        elif command == "cancel":
            db.execute("UPDATE operations SET status='CANCELLED',updated_at=? WHERE id=? AND status='QUEUED'", (stamp(), args[0]))
            db.commit()
            value = response(db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone())
        elif command == "work-one":
            value = work_one(db)
        elif command == "recover":
            db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_INTERRUPTED',updated_at=? WHERE status='DISPATCHING' AND claimed_at<?",
                       (stamp(), time.time() - 300))
            db.commit()
            value = {"recoveredUnknown": db.total_changes}
        elif command == "list":
            tasks = runtime(db).get("tasks") or {}
            value = {"operations": [observed_response(row, tasks) for row in db.execute("SELECT * FROM operations ORDER BY created_at DESC LIMIT 100")]}
        elif command == "serve":
            db.close()
            serve(config, state)
            return
        else:
            raise ValueError("UNKNOWN_COORDINATOR_COMMAND")
        print(json.dumps(value, ensure_ascii=False))
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
