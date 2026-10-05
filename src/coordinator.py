#!/usr/bin/env python3
"""Local durable dispatch queue. A claim is never silently retried after a crash."""
import hashlib
import json
import os
import re
import pathlib
import sqlite3
import subprocess
import signal
import sys
import time
import threading
import uuid
import fcntl
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta


def stamp():
    return datetime.now(timezone.utc).isoformat()


def account_id(identity):
    return hashlib.sha256(("identity:" + identity).encode()).hexdigest()


EFFORTS = {"Instant", "Medium", "High", "Extra High", "Pro"}
TERMINAL = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "RESULT_RECORDED"}
CAPACITY_WAITING = "WAITING_CAPACITY"
PRE_SEND_RETRY_LIMIT = 3
PRE_SEND_RETRY_INITIAL_SEC = 5
PRE_SEND_RETRY_MAX_SEC = 60


def ensure_column(db, table, name, declaration):
    columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
    if name not in columns:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")


def state_dir_for(db):
    row = db.execute("PRAGMA database_list").fetchone()
    return pathlib.Path(row[2]).parent


def read_json_file(path):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def account_cooldown_active(db, reg, alias):
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    if not identity:
        return False
    state = state_dir_for(db)
    paths = [state / "web-cooldowns" / (account_id(identity) + ".json")]
    if alias == (reg.get("defaultAccount") or "default"):
        paths.append(state / "web-cooldown.json")
    now = datetime.now(timezone.utc)
    for path in paths:
        value = read_json_file(path)
        until = value.get("until")
        if not until:
            continue
        try:
            if datetime.fromisoformat(str(until).replace("Z", "+00:00")) > now:
                return True
        except ValueError:
            continue
    return False


def management_mode(db, project, workgroup=None):
    return _management_mode(db, project, workgroup)


def _management_mode(db, project, workgroup=None):
    scopes = [("global", None), ("project:" + project, None)]
    reg = registry(db) if workgroup else None
    if workgroup:
        groups = (reg.get("projects") or {}).get(project, {}).get("workgroups") or {}
        current = str(workgroup)
        seen = set()
        while current and current not in seen and current in groups:
            seen.add(current)
            scopes.append((f"workgroup:{project}:{current}", current))
            current = str((groups.get(current) or {}).get("parentWorkgroupId") or "").strip() or None
    rows = db.execute(
        "SELECT scope,mode,epoch,reason,updated_at FROM control_state WHERE scope IN (%s)" % ",".join("?" for _ in scopes),
        tuple(scope for scope, _ in scopes),
    ).fetchall()
    priority = {"RUNNING": 0, "DRAINING": 1, "PAUSED": 2}
    selected = {"mode": "RUNNING", "epoch": 0, "reason": None, "scope": None, "workgroupId": None, "updatedAt": None}
    by_scope = {row["scope"]: row for row in rows}
    for scope, group_id in scopes:
        row = by_scope.get(scope)
        if row and (priority.get(row["mode"], 0) > priority.get(selected["mode"], 0)
                    or (row["mode"] == selected["mode"] == "RUNNING"
                        and (selected["scope"] is None or scope == "project:" + project
                             or (workgroup and group_id == workgroup)))):
            selected = {"mode": row["mode"], "epoch": row["epoch"], "reason": row["reason"],
                        "scope": row["scope"], "workgroupId": group_id, "updatedAt": row["updated_at"]}
    return selected


def normalize_effort(value):
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip()
    match = next((item for item in EFFORTS if item.lower() == text.lower()), None)
    if not match:
        raise ValueError("INVALID_EFFORT")
    return match


def logical_placement_key(project, workgroup, role, affinity):
    raw = "|".join([project or "", workgroup or "", role or "", affinity or ""])
    return hashlib.sha256(("placement:" + raw).encode()).hexdigest()


def resolve_successor(db, session_ref):
    seen = set()
    current = session_ref
    while current and current not in seen:
        seen.add(current)
        row = db.execute("SELECT successor_ref FROM session_successors WHERE old_session_ref=?", (current,)).fetchone()
        if not row or not row["successor_ref"]:
            break
        current = row["successor_ref"]
    return current


def connection(config, state, initialize=True):
    if initialize:
        subprocess.run([sys.executable, str(pathlib.Path(__file__).with_name("state-store.py")), "get", str(config), str(state), "registry"],
                       check=True, stdout=subprocess.DEVNULL, timeout=20)
    path = state / "bridge.sqlite3"
    db = sqlite3.connect(path if initialize else path.resolve().as_uri() + "?mode=rw", uri=not initialize, timeout=30)
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
    for name, declaration in (
        ("requested_model", "TEXT"),
        ("requested_effort", "TEXT"),
        ("resource_policy_version", "TEXT"),
        ("workgroup_id", "TEXT"),
        ("affinity_key", "TEXT"),
        ("placement_key", "TEXT"),
        ("event_id", "TEXT"),
        ("original_message", "TEXT"),
        ("force_new", "INTEGER NOT NULL DEFAULT 0"),
        ("rotation_id", "TEXT"),
        ("control_scope", "TEXT"),
        ("control_epoch", "INTEGER"),
        ("pre_send_failures", "INTEGER NOT NULL DEFAULT 0"),
        ("local_owner", "TEXT"),
        ("native_target", "TEXT"),
        ("routing_advice", "TEXT"),
    ):
        ensure_column(db, "operations", name, declaration)
    db.execute("""CREATE UNIQUE INDEX IF NOT EXISTS operations_active_placement
                  ON operations(placement_key)
                  WHERE kind='dispatch' AND placement_key IS NOT NULL AND session_ref IS NULL
                    AND status IN ('QUEUED','DISPATCHING')""")
    db.execute("""CREATE TABLE IF NOT EXISTS control_state (
        scope TEXT PRIMARY KEY, mode TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
        reason TEXT, updated_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS management_events (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL,
        created_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS management_deliveries (
        event_id TEXT NOT NULL, target_ref TEXT NOT NULL, operation_id TEXT,
        status TEXT NOT NULL, ack_payload TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(event_id,target_ref)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS reconciliation_attempts (
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, outcome TEXT NOT NULL,
        reason TEXT NOT NULL, evidence TEXT, created_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS logical_sessions (
        logical_ref TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT NOT NULL,
        current_session_ref TEXT, workgroup_id TEXT, epoch INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'ACTIVE',
        pending_session_ref TEXT, handoff_hash TEXT, rotation_id TEXT, updated_at TEXT NOT NULL
    )""")
    ensure_column(db, "logical_sessions", "workgroup_id", "TEXT")
    ensure_column(db, "logical_sessions", "rotation_id", "TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS session_successors (
        old_session_ref TEXT PRIMARY KEY, logical_ref TEXT NOT NULL, successor_ref TEXT NOT NULL,
        epoch INTEGER NOT NULL, committed_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT NOT NULL, result_version TEXT NOT NULL, event_id TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL, github TEXT, next_text TEXT,
        payload_hash TEXT NOT NULL, callback_operation_id TEXT, callback_status TEXT, workgroup_id TEXT,
        owner_ref TEXT, owner_project TEXT, owner_account TEXT,
        callback_delivered_at TEXT, acceptance_status TEXT, acceptance_message TEXT,
        recorded_at TEXT NOT NULL, accepted_at TEXT,
        PRIMARY KEY(task_id,result_version)
    )""")
    ensure_column(db, "task_results", "callback_status", "TEXT")
    ensure_column(db, "task_results", "callback_delivered_at", "TEXT")
    ensure_column(db, "task_results", "owner_ref", "TEXT")
    ensure_column(db, "task_results", "owner_project", "TEXT")
    ensure_column(db, "task_results", "owner_account", "TEXT")
    ensure_column(db, "task_results", "workgroup_id", "TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS session_checkpoints (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT NOT NULL, workgroup_id TEXT, session_ref TEXT,
        task_id TEXT, version TEXT NOT NULL, summary TEXT NOT NULL, github TEXT,
        decisions TEXT, next_text TEXT, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project,role,workgroup_id,version)
    )""")
    ensure_column(db, "session_checkpoints", "workgroup_id", "TEXT")
    checkpoint_indexes = list(db.execute("PRAGMA index_list(session_checkpoints)"))
    for checkpoint_index in checkpoint_indexes:
        if not checkpoint_index[2]:
            continue
        index_name = str(checkpoint_index[1]).replace("'", "''")
        index_columns = [row[2] for row in db.execute(f"PRAGMA index_info('{index_name}')")]
        if index_columns != ["project", "role", "version"]:
            continue
        try:
            db.execute("BEGIN")
            db.execute("DROP TABLE IF EXISTS session_checkpoints_v2")
            db.execute("""CREATE TABLE session_checkpoints_v2 (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT NOT NULL, workgroup_id TEXT, session_ref TEXT,
                task_id TEXT, version TEXT NOT NULL, summary TEXT NOT NULL, github TEXT,
                decisions TEXT, next_text TEXT, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
                UNIQUE(project,role,workgroup_id,version)
            )""")
            db.execute("""INSERT INTO session_checkpoints_v2(
                id,project,role,workgroup_id,session_ref,task_id,version,summary,github,decisions,next_text,payload_hash,created_at)
                SELECT id,project,role,workgroup_id,session_ref,task_id,version,summary,github,decisions,next_text,payload_hash,created_at
                FROM session_checkpoints""")
            db.execute("DROP TABLE session_checkpoints")
            db.execute("ALTER TABLE session_checkpoints_v2 RENAME TO session_checkpoints")
            db.commit()
        except Exception:
            db.rollback()
            raise
        break
    db.commit()
    return db


def begin_immediate(db):
    for attempt in range(6):
        try:
            db.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or attempt == 5:
                raise
            # A failed upgrade can leave a stale read snapshot on this handle.
            db.rollback()
            time.sleep(0.05 * (2 ** attempt))


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


def binding_execution_ready(project_record, binding):
    requirements=(project_record or {}).get("requirements") or {}
    context_version=str(requirements.get("contextVersion") or "").strip()
    required_tools=set(requirements.get("tools") or [])
    if not context_version and not required_tools:
        return True
    readiness=(binding or {}).get("readiness") or {}
    if context_version and str(readiness.get("contextVersion") or "")!=context_version:
        return False
    observed_tools=set(readiness.get("tools") or [])
    if not required_tools.issubset(observed_tools):
        return False
    return bool(readiness.get("attestedAt"))


def runtime(db):
    row = db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
    return json.loads(row[0])


def local_caller(caller, saved=None):
    """Bind to this local Codex process; environment hints are not an auth boundary."""
    thread = os.environ.get("CODEX_THREAD_ID", "")
    if (not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", thread)
            or caller != "codex:" + thread
            or os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
            or os.environ.get("CHAT_BRIDGE_FROM_SPACE")):
        raise ValueError("LOCAL_CALLER_CONTEXT_MISMATCH")
    host = os.uname().nodename
    if saved and (saved.get("threadId") != thread or saved.get("host") != host):
        raise ValueError("LOCAL_CALLER_CONTEXT_MISMATCH")
    return saved or {"kind": "codex", "threadId": thread, "host": host,
                     "cwd": str(pathlib.Path.cwd().resolve()), "transport": "local-pull"}


def local_owner_contract(db, payload):
    """Validate browser-side task tracking against the immutable queue owner."""
    row = db.execute("""SELECT * FROM operations WHERE kind='dispatch' AND task_id=?
                        ORDER BY created_at DESC LIMIT 1""", (payload.get("taskId"),)).fetchone()
    if (not row or not row["local_owner"] or row["caller_ref"] != payload.get("callerRef")
            or row["project"] != payload.get("project")
            or row["session_ref"] != payload.get("sessionRef")
            or row["status"] not in {"QUEUED", "DISPATCHING", "SENT"}):
        raise ValueError("LOCAL_OWNER_CONTRACT_MISMATCH")
    return json.loads(row["local_owner"])


def public(row):
    if row is None:
        raise ValueError("UNKNOWN_OPERATION")
    item = {key: row[key] for key in ("id", "kind", "status", "project", "account_alias", "account_id",
                                      "caller_ref", "session_ref", "role", "task_id", "created_at", "updated_at",
                                      "not_before", "attempts", "reason")}
    keys = set(row.keys())
    for key in ("requested_model", "requested_effort", "resource_policy_version", "workgroup_id",
                "affinity_key", "placement_key", "event_id", "control_scope", "control_epoch"):
        if key in keys:
            item[key] = row[key]
    return item


def response(row):
    item = public(row)
    result = {"operationId": item.pop("id"), "accountId": item.pop("account_id"),
              "account": item.pop("account_alias"), "callerRef": item.pop("caller_ref"),
              "sessionRef": item.pop("session_ref"), "taskId": item.pop("task_id"),
              "createdAt": item.pop("created_at"), "updatedAt": item.pop("updated_at"),
              "notBefore": item.pop("not_before"), **item}
    aliases = {
        "requested_model": "requestedModel", "requested_effort": "requestedEffort",
        "resource_policy_version": "resourcePolicyVersion", "workgroup_id": "workgroupId",
        "affinity_key": "affinityKey", "placement_key": "placementKey", "event_id": "eventId",
        "control_scope": "controlScope", "control_epoch": "controlEpoch",
    }
    for source, target in aliases.items():
        if source in result:
            result[target] = result.pop(source)
    if "local_owner" in row.keys() and row["local_owner"]:
        result["localOwner"] = json.loads(row["local_owner"])
    if "native_target" in row.keys() and row["native_target"]:
        result["runtime"] = "codex"
        result["nativeTarget"] = json.loads(row["native_target"])
        receipt = json.loads(row["result"]) if row["result"] else {}
        for key in ("turnId", "clientUserMessageId", "modelSelection"):
            if key in receipt:
                result[key] = receipt[key]
    if "routing_advice" in row.keys() and row["routing_advice"]:
        result["routingAdvice"] = json.loads(row["routing_advice"])
    if row["result"]:
        candidate = (json.loads(row["result"]) or {}).get("newSession")
        if isinstance(candidate, dict) and candidate.get("format") == "uncertain-new-session-v1":
            result["uncertainNewSession"] = candidate
    return result


def observed_response(row, tasks):
    value = response(row)
    task = tasks.get(row["task_id"]) if row["kind"] == "dispatch" else None
    if task:
        value["taskStatus"] = task.get("status")
    return value


def mark_capacity_wait(db, row, detail):
    """Keep queue capacity pressure visible without turning it into BLOCKED."""
    rt = runtime(db)
    tasks = rt.setdefault("tasks", {})
    task = tasks.get(row["task_id"]) or {
        "taskId": row["task_id"], "project": row["project"], "account": row["account_alias"],
        "role": row["role"], "sessionId": row["session_ref"], "controllerSessionRef": row["caller_ref"],
    }
    if str(task.get("status") or "").upper() in TERMINAL:
        return
    now = stamp()
    task.update({
        "taskId": row["task_id"], "project": row["project"], "account": row["account_alias"],
        "role": row["role"], "sessionId": row["session_ref"], "status": CAPACITY_WAITING,
        "capacityState": CAPACITY_WAITING, "capacityReason": detail.get("reason") or "PAGE_BUDGET",
        "capacityRetryAfterSec": detail.get("retryAfterSec"), "capacityNextRetryAt": detail.get("nextRetryAt"),
        "updatedAt": now,
    })
    tasks[row["task_id"]] = task
    db.execute("UPDATE documents SET payload=? WHERE kind=?", (json.dumps(rt, ensure_ascii=False), "runtime"))
    db.commit()


def clear_capacity_wait(db, task_id):
    rt = runtime(db)
    task = (rt.get("tasks") or {}).get(task_id)
    if not task:
        return
    for key in ("capacityState", "capacityReason", "capacityRetryAfterSec", "capacityNextRetryAt"):
        task.pop(key, None)
    if str(task.get("status") or "").upper() == CAPACITY_WAITING:
        task["status"] = "DISPATCHED"
    task["updatedAt"] = stamp()
    db.execute("UPDATE documents SET payload=? WHERE kind=?", (json.dumps(rt, ensure_ascii=False), "runtime"))
    db.commit()


def control_footer(task_id, caller_ref, role, model, effort, policy_version, workgroup=None):
    lines = [
        "",
        "[CHATBRIDGE CONTROL v1]",
        f"task_id: {task_id}",
        f"caller_ref: {caller_ref}",
        f"role: {role}",
        f"resource_policy_version: {policy_version}",
        f"requested_model: {model or 'Latest'}",
        f"requested_effort: {effort or 'page-default'}",
        "completion_contract:",
        "- Update durable GitHub/authorized project state first when the task changes durable work.",
        "- Then report the result through: chat-bridge queue result --task TASK_ID --status COMPLETE --summary <text> [--github <url>] [--next <text>].",
        "- Do not choose a callback target yourself; ChatBridge resolves the owning controller from the persisted task.",
        "- If blocked or unsafe, report BLOCKED instead of inventing success.",
        "[/CHATBRIDGE CONTROL]",
    ]
    if workgroup:
        lines.insert(3, f"workgroup_id: {workgroup}")
    return "\n".join(lines)


def native_target(payload, creating=False):
    target = payload.get("nativeTarget") or {
        "host": payload.get("nativeHost"), "threadId": payload.get("nativeThread"),
        "cwd": payload.get("nativeCwd"), "socket": payload.get("nativeSocket"),
    }
    if not isinstance(target, dict) or target.get("host") != os.uname().nodename:
        raise ValueError("NATIVE_HOST_MISMATCH")
    if not creating and not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", str(target.get("threadId") or "")):
        raise ValueError("NATIVE_THREAD_REQUIRED")
    if not all(isinstance(target.get(key), str) and pathlib.Path(target[key]).is_absolute() for key in ("cwd", "socket")):
        raise ValueError("NATIVE_ABSOLUTE_PATH_REQUIRED")
    return {key: target.get(key) for key in ("host", "threadId", "cwd", "socket")}


def native_call(payload, diagnostic=None):
    adapter = pathlib.Path(__file__).with_name("native-codex.mjs")
    if not adapter.is_file():
        return {"ok": False, "code": "NATIVE_ADAPTER_UNAVAILABLE", "deliveryStage": "PRE_SEND"}
    command = [os.environ.get("CHAT_BRIDGE_NODE_BIN") or "node", str(adapter), json.dumps(payload)]
    try:
        completed = run_bridge(command)
        receipt = parse_worker_receipt(completed)
        if receipt is None and diagnostic is not None:
            diagnostic.update(worker_diagnostic(completed.returncode, completed.stderr, "native", stdout=completed.stdout))
        return receipt or {"ok": False, "code": "NATIVE_RECEIPT_UNREADABLE", "deliveryStage": "SEND_ATTEMPTED"}
    except (OSError, subprocess.TimeoutExpired) as error:
        pre_send = getattr(error, "bridge_phase", None) == "SPAWN" and not hasattr(error, "cleanup")
        code = "NATIVE_ADAPTER_UNAVAILABLE" if pre_send else "NATIVE_ADAPTER_TIMEOUT" if isinstance(error, subprocess.TimeoutExpired) else "NATIVE_ADAPTER_ERROR"
        if diagnostic is not None:
            diagnostic.update(worker_diagnostic(None, getattr(error, "stderr", None) or type(error).__name__, "native", error=error))
        return {"ok": False, "code": code, "deliveryStage": "PRE_SEND" if pre_send else "SEND_ATTEMPTED"}


def native_operation_payload(row, action="send"):
    prior = json.loads(row["result"]) if row["result"] else {}
    return {"action": action, "nativeTarget": json.loads(row["native_target"]), "operationId": row["id"],
            "turnId": prior.get("turnId"), "message": row["message"], "model": row["requested_model"], "effort": row["requested_effort"]}


def native_tasks(db):
    """Derive native business status without putting native workers in Web pools."""
    tasks = {}
    for row in db.execute("SELECT * FROM operations WHERE native_target IS NOT NULL AND kind='dispatch'"):
        reported = db.execute("SELECT * FROM task_results WHERE task_id=? ORDER BY recorded_at DESC,event_id DESC LIMIT 1", (row["task_id"],)).fetchone()
        status = {"SENT": "DISPATCHED", "FAILED_PRE_SEND": "FAILED"}.get(row["status"], row["status"])
        if reported:
            status = {"ACCEPTED": "COMPLETE", "REJECTED": "BLOCKED", "BLOCKED": "BLOCKED"}.get(reported["acceptance_status"], "RESULT_RECORDED")
        tasks[row["task_id"]] = {"taskId": row["task_id"], "runtime": "codex", "project": row["project"],
                                 "workgroupId": row["workgroup_id"], "sessionId": row["session_ref"], "status": status}
    return tasks


def native_reservation(db, session_ref, operation_id=None):
    return db.execute("""SELECT id FROM operations o WHERE native_target IS NOT NULL AND session_ref=? AND id!=?
        AND status NOT IN ('CANCELLED','FAILED_PRE_SEND')
        AND NOT EXISTS (SELECT 1 FROM task_results r WHERE r.task_id=o.task_id) LIMIT 1""",
        (session_ref, operation_id or "")).fetchone()


def work_native(db, row):
    if native_reservation(db, row["session_ref"], row["id"]):
        return finish(db, row, "FAILED_PRE_SEND", "NATIVE_TARGET_RESERVED", pre_send_failure=True)
    payload = native_operation_payload(row)
    payload["admission"] = {"state": str(state_dir_for(db)), "operationId": row["id"]}
    diagnostic = {}
    receipt = native_call(payload, diagnostic)
    result = {**receipt, **diagnostic}
    if receipt.get("ok") and receipt.get("delivered") and receipt.get("turnId"):
        return finish(db, row, "SENT", result=result)
    if receipt.get("deliveryStage") == "PRE_SEND":
        if receipt.get("code") in {"NATIVE_TARGET_BUSY", "NATIVE_ADMISSION_BLOCKED"}:
            return finish(db, row, "QUEUED", receipt["code"], 30, result=result)
        return finish(db, row, "FAILED_PRE_SEND", receipt.get("code"), result=result, pre_send_failure=True)
    return finish(db, row, "DELIVERY_UNKNOWN", receipt.get("code"), result=result)


def reconcile_native(db, row):
    diagnostic = {}
    receipt = native_call(native_operation_payload(row, "read"), diagnostic)
    proven = receipt.get("ok") and receipt.get("delivered") and receipt.get("turnId")
    now = stamp()
    begin_immediate(db)
    try:
        current = db.execute("SELECT status FROM operations WHERE id=?", (row["id"],)).fetchone()
        if current["status"] != "DELIVERY_UNKNOWN":
            raise ValueError("OPERATION_CHANGED_DURING_RECONCILIATION")
        outcome = "RECONCILED_DELIVERED" if proven else "STILL_UNKNOWN"
        db.execute("INSERT INTO reconciliation_attempts VALUES (?,?,?,?,?,?)",
                   (str(uuid.uuid4()), row["id"], outcome, "NATIVE_TURN_EVIDENCE" if proven else receipt.get("code"), json.dumps({**receipt, **diagnostic}), now))
        if proven:
            db.execute("UPDATE operations SET status='SENT',reason='RECONCILED_FROM_NATIVE_EVIDENCE',result=?,updated_at=? WHERE id=?",
                       (json.dumps(receipt), now, row["id"]))
        db.commit()
        return {"operationId": row["id"], "outcome": outcome, "evidence": receipt}
    except Exception:
        db.rollback()
        raise


def submit(db, payload):
    if payload.get("routingAdvicePath"):
        advice_bytes = pathlib.Path(payload["routingAdvicePath"]).read_bytes()
        if len(advice_bytes) > 32000:
            raise ValueError("INVALID_ROUTING_ADVICE")
        payload["routingAdvice"] = {"advice": json.loads(advice_bytes), "receiptSha256": hashlib.sha256(advice_bytes).hexdigest()}
    advice = payload.get("routingAdvice")
    if advice is not None and (not isinstance(advice, dict) or len(json.dumps(advice)) > 33000):
        raise ValueError("INVALID_ROUTING_ADVICE")
    if advice is not None:
        receipt = advice.get("advice") if payload.get("routingAdvicePath") else advice
        allowed = {"version", "messageSha256", "selectedChoice", "choiceId", "reason", "requestSha256", "inputSha256", "judge", "choices", "generatedAt"}
        if (not isinstance(receipt, dict) or set(receipt) - allowed
                or not isinstance(receipt.get("selectedChoice"), dict)
                or not isinstance(receipt.get("choices"), list)
                or receipt["selectedChoice"] not in receipt["choices"]
                or not isinstance(receipt.get("reason"), str)
                or any(key in receipt and not re.fullmatch(r"[a-f0-9]{64}", str(receipt[key])) for key in ("messageSha256", "requestSha256", "inputSha256"))):
            raise ValueError("INVALID_ROUTING_ADVICE")
        choice_fields = {"id", "description", "runtime", "model", "effort", "sessionRef", "nativeHost", "nativeThread", "nativeCwd", "nativeSocket"}
        if (not 1 <= len(receipt["choices"]) <= 32
                or any(not isinstance(item, dict) or set(item) - choice_fields
                       or item.get("runtime") not in {"web", "codex"}
                       or any(not isinstance(item.get(key), str) or not 0 < len(item[key]) <= 128 for key in ("id", "model", "effort"))
                       for item in receipt["choices"])
                or ("judge" in receipt and receipt["judge"] != {"model": "gpt-6-luna", "effort": "low"})):
            raise ValueError("INVALID_ROUTING_ADVICE")
        choice = receipt.get("selectedChoice") or {}
        if (receipt.get("version") != 1 or receipt.get("choiceId") != choice.get("id")
                or not choice.get("id") or receipt.get("messageSha256") != hashlib.sha256(str(payload.get("message") or "").encode()).hexdigest()
                or choice.get("runtime") != (payload.get("runtime") or "web")
                or any(choice.get(key) != payload.get(key) for key in ("model", "effort", "sessionRef", "nativeHost", "nativeThread", "nativeCwd", "nativeSocket"))):
            raise ValueError("ROUTING_ADVICE_MISMATCH")
    caller = str(payload.get("callerRef") or "").strip()
    request_id = str(payload.get("requestId") or "").strip()
    original_message = str(payload.get("message") or "")
    if not caller or not request_id or not original_message or len(request_id) > 128 or len(original_message) > 100000:
        raise ValueError("callerRef, requestId and nonempty message are required")
    native = payload.get("runtime") == "codex"
    if payload.get("runtime") not in {None, "web", "codex"}:
        raise ValueError("UNSUPPORTED_RUNTIME")
    local_owner = local_caller(caller) if caller.startswith("codex:") else None
    if local_owner and (not payload.get("project") or (not payload.get("sessionRef") and not native)):
        raise ValueError("LOCAL_CALLER_REQUIRES_PROJECT_AND_SESSION")
    requested_model = str(payload.get("model") or "").strip() or None
    if requested_model and len(requested_model) > 80:
        raise ValueError("INVALID_MODEL")
    requested_effort = (str(payload.get("effort") or "xhigh").strip() if native else normalize_effort(payload.get("effort")))
    policy_version = str(payload.get("resourcePolicyVersion") or "v1").strip() or "v1"
    workgroup = str(payload.get("workgroup") or "").strip() or None
    affinity = str(payload.get("affinityKey") or "").strip() or None
    key = "dispatch:" + caller + ":" + request_id
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    begin_immediate(db)
    try:
        prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
        if prior:
            if prior["local_owner"]:
                local_caller(caller, json.loads(prior["local_owner"]))
            if prior["payload_hash"] != digest:
                raise ValueError("IDEMPOTENCY_CONFLICT")
            db.commit()
            return response(prior)
        reg, rt = registry(db), runtime(db)
        source = (reg.get("chats") or {}).get(caller)
        if not local_owner and (not source or source.get("status", "active") != "active"):
            raise ValueError("CALLER_REF_NOT_REGISTERED")
        source = source or {}
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
        mode = management_mode(db, project, workgroup)
        if mode["mode"] in {"PAUSED", "DRAINING"}:
            raise ValueError("ADMISSION_" + mode["mode"])

        operation_id = str(uuid.uuid4())
        task_id = str(payload.get("taskId") or "Q-" + operation_id)
        if not task_id or len(task_id) > 128 or not all(ch.isalnum() or ch in "._:-" for ch in task_id):
            raise ValueError("INVALID_TASK_ID")
        prior_task = db.execute("""SELECT id,status FROM operations WHERE kind='dispatch' AND task_id=?
                                   AND (status!='CANCELLED' OR native_target IS NOT NULL OR ?)
                                   ORDER BY CASE WHEN status IN ('DELIVERY_UNKNOWN','SUPERSEDED') THEN 0 ELSE 1 END,
                                            created_at DESC LIMIT 1""", (task_id, native)).fetchone()
        if prior_task:
            if prior_task["status"] in {"DELIVERY_UNKNOWN", "SUPERSEDED"}:
                raise ValueError("TASK_DELIVERY_UNKNOWN_RECONCILE_REQUIRED:" + prior_task["id"])
            raise ValueError("TASK_ID_ALREADY_DISPATCHED:" + prior_task["id"])
        if native and db.execute("SELECT 1 FROM task_results WHERE task_id=? LIMIT 1", (task_id,)).fetchone():
            raise ValueError("TASK_ID_ALREADY_RECORDED")

        if native:
            target = native_target(payload)
            session_ref = "codex:" + target["threadId"]
            if payload.get("sessionRef") and payload["sessionRef"] != session_ref:
                raise ValueError("NATIVE_SESSION_MISMATCH")
            if workgroup and workgroup not in (project_record.get("workgroups") or {}):
                raise ValueError("WORKGROUP_NOT_REGISTERED")
            busy = native_reservation(db, session_ref)
            if busy:
                raise ValueError("TARGET_SESSION_BUSY:" + busy["id"])
            model = requested_model or "gpt-6-astra"
            role = str(payload.get("role") or "native-worker")
            message = original_message + control_footer(task_id, caller, role, model, requested_effort, policy_version, workgroup)
            now = stamp()
            advice = payload.get("routingAdvice")
            db.execute("""INSERT INTO operations(
                id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
                role,message,task_id,created_at,updated_at,not_before,requested_model,requested_effort,
                resource_policy_version,workgroup_id,original_message,control_scope,control_epoch,local_owner,native_target,routing_advice)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (operation_id,key,digest,"QUEUED",project,"native:"+target["host"],"codex:"+target["host"],caller,session_ref,
                 role,message,task_id,now,now,time.time(),model,requested_effort,policy_version,workgroup,original_message,
                 mode.get("scope"),mode.get("epoch"),json.dumps(local_owner) if local_owner else None,json.dumps(target),
                 json.dumps(advice) if advice is not None else None))
            row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
            db.commit()
            return response(row)

        target = str(payload.get("sessionRef") or "").strip() or None
        role = str(payload.get("role") or "").strip()
        target_chat = (reg.get("chats") or {}).get(target) if target else None
        if target and (not target_chat or target_chat.get("project") != project or target_chat.get("status", "active") != "active"):
            raise ValueError("TARGET_SESSION_NOT_REGISTERED")
        if target_chat and target_chat.get("workgroupId") != workgroup:
            raise ValueError("TARGET_WORKGROUP_MISMATCH")
        if target_chat:
            role = target_chat.get("role") or role or target
        if not role:
            raise ValueError("role or sessionRef required")
        if workgroup:
            group = (project_record.get("workgroups") or {}).get(workgroup)
            if not group:
                raise ValueError("WORKGROUP_NOT_REGISTERED")

        if not target:
            matches = [chat for chat in (reg.get("chats") or {}).values()
                       if chat.get("project") == project and chat.get("status", "active") == "active"
                       and chat.get("role") == role
                       and (chat.get("workgroupId") == workgroup if workgroup else not chat.get("workgroupId"))]
            if len(matches) > 1:
                raise ValueError("AMBIGUOUS_TARGET_ROLE")
            if matches:
                target_chat = matches[0]
                target = target_chat["id"]
        if requested_model is None:
            requested_model = (target_chat or {}).get("model") or "Latest"
        if requested_effort is None and target_chat:
            requested_effort = normalize_effort(target_chat.get("effort"))

        if target:
            busy = any(task.get("sessionId") == target and str(task.get("status", "")).upper() not in TERMINAL
                       for task in (rt.get("tasks") or {}).values())
            busy |= db.execute("SELECT 1 FROM operations WHERE session_ref=? AND status IN ('QUEUED','DISPATCHING') LIMIT 1", (target,)).fetchone() is not None
            if busy:
                raise ValueError("TARGET_SESSION_BUSY")

        placement_key = None if target else logical_placement_key(project, workgroup, role, affinity)
        if placement_key:
            reservation = db.execute("""SELECT id FROM operations WHERE placement_key=? AND kind='dispatch'
                                        AND session_ref IS NULL AND status IN ('QUEUED','DISPATCHING') LIMIT 1""",
                                     (placement_key,)).fetchone()
            if reservation:
                raise ValueError("ROLE_PLACEMENT_RESERVED:" + reservation["id"])
            uncertain = db.execute("""SELECT id,task_id,result FROM operations WHERE placement_key=? AND kind='dispatch'
                                      AND session_ref IS NULL AND status='DELIVERY_UNKNOWN'""", (placement_key,)).fetchall()
            for prior in uncertain:
                candidate = (json.loads(prior["result"] or "{}") or {}).get("newSession") or {}
                if candidate.get("format") != "uncertain-new-session-v1":
                    continue  # Historical UNKNOWN receipts are never backfilled or reclassified.
                accepted = db.execute("""SELECT acceptance_status FROM task_results WHERE task_id=?
                                         ORDER BY recorded_at DESC,event_id DESC LIMIT 1""", (prior["task_id"],)).fetchone()
                if not accepted or accepted["acceptance_status"] != "ACCEPTED":
                    raise ValueError("ROLE_CREATION_UNCONFIRMED:" + prior["id"])

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
                if not binding_execution_ready(project_record,binding):
                    continue
                stable = account_id(identity)
                if stable in seen:
                    continue
                seen.add(stable)
                if requested and candidate != requested:
                    continue
                if (accounts.get(candidate) or {}).get("acceptNewTasks") is False:
                    continue
                if account_cooldown_active(db, reg, candidate):
                    continue
                max_tasks = (accounts.get(candidate) or {}).get("maxActiveTasks")
                reserved = db.execute("""SELECT count(*) FROM operations WHERE account_id=? AND kind='dispatch'
                                         AND status IN ('QUEUED','DISPATCHING')""", (stable,)).fetchone()[0]
                active = sum(1 for task in (rt.get("tasks") or {}).values()
                             if str(task.get("status", "")).upper() not in TERMINAL
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
        if not binding_execution_ready(project_record,bindings[alias]):
            raise ValueError("TARGET_PROJECT_CONTENT_NOT_READY")

        message = original_message + control_footer(task_id, caller, role, requested_model, requested_effort, policy_version, workgroup)
        now = stamp()
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,requested_model,requested_effort,
            resource_policy_version,workgroup_id,affinity_key,placement_key,original_message,control_scope,control_epoch,local_owner)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,digest,"QUEUED",project,alias,stable,caller,target,role,message,task_id,now,now,time.time(),
             requested_model,requested_effort,policy_version,workgroup,affinity,placement_key,original_message,
             mode.get("scope"),mode.get("epoch"),json.dumps(local_owner) if local_owner else None))
        if advice is not None:
            db.execute("UPDATE operations SET routing_advice=? WHERE id=?", (json.dumps(advice), operation_id))
        row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        db.commit()
        return response(row)
    except sqlite3.IntegrityError as error:
        db.rollback()
        if "operations_active_placement" in str(error) or "placement_key" in str(error):
            raise ValueError("ROLE_PLACEMENT_RESERVED") from error
        raise
    except Exception:
        db.rollback()
        raise


def task_contract(db, task_id):
    rt = runtime(db)
    task = (rt.get("tasks") or {}).get(task_id)
    row = db.execute("""SELECT project,account_alias,caller_ref,session_ref,role,workgroup_id,local_owner,native_target
                        FROM operations WHERE kind='dispatch' AND task_id=?
                        ORDER BY created_at DESC LIMIT 1""", (task_id,)).fetchone()
    if task and (not row or (not row["local_owner"] and not row["native_target"])):
        return task
    if not row:
        return None
    return {
        **(task or {}),
        "taskId": task_id,
        "project": row["project"],
        "account": row["account_alias"],
        "controllerSessionRef": row["caller_ref"],
        "replyToSessionRef": row["caller_ref"],
        "sessionId": row["session_ref"],
        "role": row["role"],
        "workgroupId": row["workgroup_id"],
        **({"localOwner": json.loads(row["local_owner"])} if row["local_owner"] else {}),
        **({"nativeTarget": json.loads(row["native_target"]), "runtime": "codex"} if row["native_target"] else {}),
    }


def task_workgroup(task):
    return str(task.get("workgroupId") or task.get("workgroup") or "").strip() or None


def target_matches_task_scope(task, target, reg=None):
    """Keep legacy tasks scoped, while allowing an explicitly owning root outside a group."""
    expected = task_workgroup(task)
    actual = str((target or {}).get("workgroupId") or "").strip() or None
    if expected == actual:
        return True
    if not expected or actual:
        return False
    explicit = str(task.get("replyToSessionRef") or task.get("controllerSessionRef") or "").strip()
    if explicit and explicit == (target or {}).get("id"):
        return True
    root_role = (((reg or {}).get("projects") or {}).get(task.get("project")) or {}).get("rootController") or "conductor"
    return (target or {}).get("role") == root_role


def resolve_callback_target(db, reg, task, requested=None):
    explicit = task.get("replyToSessionRef") or task.get("controllerSessionRef")
    target_ref = requested or explicit
    if explicit and requested and requested != explicit:
        raise ValueError("CALLBACK_TARGET_MISMATCH")
    if not target_ref:
        root_role = ((reg.get("projects") or {}).get(task.get("project")) or {}).get("rootController") or "conductor"
        matches = [chat for chat in (reg.get("chats") or {}).values()
                   if chat.get("project") == task.get("project") and chat.get("status", "active") == "active"
                   and chat.get("role") == root_role]
        if len(matches) != 1:
            raise ValueError("CALLBACK_TARGET_AMBIGUOUS")
        target_ref = matches[0]["id"]
    return resolve_successor(db, target_ref)


def callback(db, payload):
    task_id = str(payload.get("taskId") or "").strip()
    requested_target = str(payload.get("targetRef") or "").strip() or None
    message = str(payload.get("message") or "")
    event_id = str(payload.get("eventId") or "").strip() or None
    if not task_id or not message or len(message) > 100000:
        raise ValueError("taskId and nonempty message are required")
    task = task_contract(db, task_id)
    if not task:
        raise ValueError("CALLBACK_TASK_NOT_REGISTERED")
    reg = registry(db)
    explicit = str(task.get("replyToSessionRef") or task.get("controllerSessionRef") or "").strip() or None
    if explicit and requested_target and requested_target != explicit:
        raise ValueError("CALLBACK_TARGET_MISMATCH")
    contract_ref = explicit or requested_target
    if contract_ref:
        target_ref = resolve_successor(db, contract_ref)
    else:
        try:
            target_ref = resolve_callback_target(db, reg, task, None)
        except ValueError as error:
            if str(error) != "CALLBACK_TARGET_AMBIGUOUS":
                raise
            target_ref = None
    target = (reg.get("chats") or {}).get(target_ref)
    if target and target.get("project") != task.get("project"):
        raise ValueError("CALLBACK_PROJECT_MISMATCH")
    if target and not target_matches_task_scope(task, target, reg):
        raise ValueError("CALLBACK_WORKGROUP_MISMATCH")
    alias = target.get("account") if target else task.get("account")
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    if not identity:
        raise ValueError("CALLBACK_ACCOUNT_UNVERIFIED")
    digest = hashlib.sha256(message.encode()).hexdigest()
    stable_event = event_id or digest
    key = "callback:" + task_id + ":" + (target_ref or "UNRESOLVED") + ":" + stable_event
    begin_immediate(db)
    try:
        prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
        if prior:
            db.commit()
            return response(prior)
        operation_id, now = str(uuid.uuid4()), stamp()
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,event_id,workgroup_id,original_message)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,digest,"QUEUED" if target and target.get("status", "active") == "active" else "WAITING_ROUTE",
             task.get("project"),alias,account_id(identity),contract_ref or target_ref or "",contract_ref or target_ref or "",
             target.get("role") if target else (task.get("role") or contract_ref or "callback"),message,task_id,now,now,time.time(),"callback",event_id,task_workgroup(task),message))
        row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
        db.commit()
        return response(row)
    except Exception:
        db.rollback()
        raise


def checkpoint(db, payload):
    task_id=str(payload.get("taskId") or payload.get("task") or "").strip() or None
    project=str(payload.get("project") or "").strip() or None
    role=str(payload.get("role") or "").strip() or None
    session_ref=str(payload.get("sessionRef") or "").strip() or None
    workgroup=str(payload.get("workgroupId") or "").strip() or None
    if task_id:
        task=task_contract(db,task_id)
        if not task: raise ValueError("CHECKPOINT_TASK_NOT_REGISTERED")
        project=project or task.get("project")
        role=role or task.get("role")
        session_ref=session_ref or task.get("sessionId")
        workgroup=workgroup or task_workgroup(task)
    summary=str(payload.get("summary") or "").strip()
    github=str(payload.get("github") or "").strip()
    decisions=str(payload.get("decisions") or "").strip()
    next_text=str(payload.get("next") or "").strip()
    if not project or not role or not summary:
        raise ValueError("checkpoint requires project, role and summary")
    raw={"project":project,"role":role,"workgroupId":workgroup,"sessionRef":session_ref,"taskId":task_id,"summary":summary,
         "github":github,"decisions":decisions,"next":next_text}
    digest=hashlib.sha256(json.dumps(raw,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    version=str(payload.get("version") or ("cp-"+digest[:16])).strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,80}",version):
        raise ValueError("INVALID_CHECKPOINT_VERSION")
    origin=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin and session_ref:
        reg=registry(db); chat=(reg.get("chats") or {}).get(session_ref)
        identity=((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity") if chat else None
        if not identity or account_id(identity)!=origin:
            raise ValueError("CHECKPOINT_ORIGIN_ACCOUNT_MISMATCH")
    prior=db.execute("SELECT * FROM session_checkpoints WHERE project=? AND role=? AND version=? AND coalesce(workgroup_id,'')=coalesce(?,'')",
                     (project,role,version,workgroup)).fetchone()
    if prior:
        if prior["payload_hash"]!=digest: raise ValueError("CHECKPOINT_VERSION_CONFLICT")
        return dict(prior)
    checkpoint_id=str(uuid.uuid4()); now=stamp()
    db.execute("""INSERT INTO session_checkpoints(
        id,project,role,workgroup_id,session_ref,task_id,version,summary,github,decisions,next_text,payload_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (checkpoint_id,project,role,workgroup,session_ref,task_id,version,summary,github or None,decisions or None,next_text or None,digest,now))
    db.commit()
    return {"checkpointId":checkpoint_id,"project":project,"role":role,"workgroupId":workgroup,"sessionRef":session_ref,
            "taskId":task_id,"version":version,"summary":summary,"github":github or None,
            "decisions":decisions or None,"next":next_text or None,"createdAt":now}


def latest_checkpoint(db, project, role, workgroup=None):
    row=db.execute("""SELECT * FROM session_checkpoints WHERE project=? AND role=?
                      AND coalesce(workgroup_id,'')=coalesce(?,'')
                      ORDER BY created_at DESC,id DESC LIMIT 1""",(project,role,workgroup)).fetchone()
    return dict(row) if row else None


def checkpoint_handoff(row):
    if not row: return None
    lines=[f"Checkpoint version: {row['version']}",f"Summary: {row['summary']}"]
    if row.get("workgroup_id"): lines.insert(1, "Workgroup: " + row["workgroup_id"])
    if row.get("github"): lines.append("GitHub/durable evidence: "+row["github"])
    if row.get("decisions"): lines.append("Decisions/constraints: "+row["decisions"])
    if row.get("next_text"): lines.append("Next: "+row["next_text"])
    if row.get("task_id"): lines.append("Task: "+row["task_id"])
    return "\n".join(lines)


def result_owner(db, reg, task):
    """Resolve the persisted owner without treating a missing Chat as root."""
    explicit = str(task.get("replyToSessionRef") or task.get("controllerSessionRef") or "").strip() or None
    if task.get("localOwner"):
        return explicit, explicit, None
    if explicit:
        target_ref = resolve_successor(db, explicit)
        target = (reg.get("chats") or {}).get(target_ref)
        if target and target.get("project") != task.get("project"):
            raise ValueError("CALLBACK_PROJECT_MISMATCH")
        return explicit, target_ref, target
    root_role = ((reg.get("projects") or {}).get(task.get("project")) or {}).get("rootController") or "conductor"
    matches = [chat for chat in (reg.get("chats") or {}).values()
               if chat.get("project") == task.get("project") and chat.get("status", "active") == "active"
               and chat.get("role") == root_role]
    if len(matches) == 1:
        target = matches[0]
        return target["id"], target["id"], target
    return None, None, None


def result_message(task_id, status, version, summary, github, next_text):
    lines = ["[RESULT]", f"task_id: {task_id}", f"status: {status}", f"result_version: {version}"]
    if github:
        lines.append("github: " + github)
    lines.append("summary: " + summary)
    if next_text:
        lines.append("next: " + next_text)
    lines += ["", f"Controller acknowledgement: chat-bridge queue ack --task {task_id} --result-version {version} --caller-ref YOUR_SESSION_REF --status ACCEPTED --message <review>"]
    return "\n".join(lines)


def materialize_pending_callbacks(db):
    """Attach saved results to their original owner once routing is available."""
    begin_immediate(db)
    try:
        reg = registry(db)
        rows = db.execute("""SELECT * FROM task_results
                           WHERE callback_operation_id IS NULL
                             AND (callback_status IS NULL OR callback_status='WAITING_ROUTE')
                           ORDER BY recorded_at,event_id""").fetchall()
        for row in rows:
            task = task_contract(db, row["task_id"])
            if not task:
                continue
            owner_ref = row["owner_ref"]
            target_ref = resolve_successor(db, owner_ref) if owner_ref else None
            target = (reg.get("chats") or {}).get(target_ref) if target_ref else None
            if not target_ref:
                owner_ref, target_ref, target = result_owner(db, reg, task)
            if not target or target.get("status", "active") != "active":
                continue
            if target.get("project") != (row["owner_project"] or task.get("project")):
                continue
            if not target_matches_task_scope(task, target, reg):
                continue
            alias = target.get("account")
            identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
            if not identity:
                continue
            message = result_message(row["task_id"], row["status"], row["result_version"], row["summary"], row["github"] or "", row["next_text"] or "")
            request_key = "callback:" + row["task_id"] + ":" + target_ref + ":" + row["event_id"]
            operation_id, now = str(uuid.uuid4()), stamp()
            db.execute("""INSERT INTO operations(
                id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
                role,message,task_id,created_at,updated_at,not_before,kind,event_id,workgroup_id,original_message)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (operation_id, request_key, hashlib.sha256(message.encode()).hexdigest(), "QUEUED",
                 target["project"], alias, account_id(identity), target_ref, target_ref,
                 target.get("role") or target_ref, message, row["task_id"], now, now, time.time(),
                 "callback", row["event_id"], task_workgroup(task), message))
            db.execute("""UPDATE task_results SET callback_operation_id=?,callback_status=?,owner_ref=coalesce(owner_ref,?),
                          owner_project=coalesce(owner_project,?),owner_account=coalesce(owner_account,?)
                          WHERE task_id=? AND result_version=? AND callback_operation_id IS NULL""",
                       (operation_id, "QUEUED", owner_ref or target_ref, target["project"], alias,
                        row["task_id"], row["result_version"]))
        pending = db.execute("SELECT * FROM operations WHERE kind='callback' AND status='WAITING_ROUTE'").fetchall()
        for row in pending:
            task = task_contract(db, row["task_id"])
            if not task:
                continue
            owner_ref = str(task.get("replyToSessionRef") or task.get("controllerSessionRef") or row["caller_ref"] or "").strip() or None
            if not owner_ref:
                owner_ref, target_ref, target = result_owner(db, reg, task)
            else:
                target_ref = resolve_successor(db, owner_ref)
                target = (reg.get("chats") or {}).get(target_ref) if target_ref else None
            if not target or target.get("status", "active") != "active" or target.get("project") != row["project"]:
                continue
            if not target_matches_task_scope(task, target, reg):
                continue
            alias = target.get("account")
            identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
            if not identity:
                continue
            db.execute("""UPDATE operations SET status='QUEUED',account_alias=?,account_id=?,caller_ref=?,session_ref=?,
                          role=?,not_before=?,reason=NULL,updated_at=? WHERE id=? AND status='WAITING_ROUTE'""",
                       (alias, account_id(identity), target_ref, target_ref, target.get("role") or target_ref,
                        time.time(), stamp(), row["id"]))
        db.commit()
    except Exception:
        db.rollback()
        raise


def refresh_waiting_routes(db):
    """Move notifications whose retired owner now has a committed successor."""
    begin_immediate(db)
    try:
        reg = registry(db)
        rows = db.execute("""SELECT * FROM operations
                           WHERE kind IN ('callback','management') AND status='WAITING_ROUTE'
                           ORDER BY created_at,id""").fetchall()
        for row in rows:
            owner_ref = row["session_ref"] or row["caller_ref"]
            target_ref = resolve_successor(db, owner_ref) if owner_ref else None
            target = (reg.get("chats") or {}).get(target_ref) if target_ref else None
            if not target or target.get("status", "active") != "active" or target.get("project") != row["project"]:
                continue
            alias = target.get("account")
            identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
            if not identity:
                continue
            if row["kind"] == "management" and row["event_id"]:
                old_delivery = db.execute("""SELECT 1 FROM management_deliveries
                                             WHERE event_id=? AND target_ref=?""",
                                          (row["event_id"], row["session_ref"])).fetchone()
                if old_delivery:
                    db.execute("""UPDATE management_deliveries SET target_ref=?,status='QUEUED',updated_at=?
                                  WHERE event_id=? AND target_ref=?""",
                               (target_ref, stamp(), row["event_id"], row["session_ref"]))
            db.execute("""UPDATE operations SET status='QUEUED',account_alias=?,account_id=?,caller_ref=?,session_ref=?,
                          role=?,not_before=?,reason=NULL,updated_at=? WHERE id=? AND status='WAITING_ROUTE'""",
                       (alias, account_id(identity), target_ref, target_ref, target.get("role") or target_ref,
                        time.time(), stamp(), row["id"]))
            if row["kind"] == "callback" and row["event_id"]:
                db.execute("UPDATE task_results SET callback_status='QUEUED' WHERE callback_operation_id=?",
                           (row["id"],))
        db.commit()
    except Exception:
        db.rollback()
        raise


def retarget_notification(db, row):
    """Require an active exact owner; follow only a committed successor."""
    if row["kind"] not in {"callback", "management"} or not row["session_ref"]:
        return row
    reg = registry(db)
    target = (reg.get("chats") or {}).get(row["session_ref"])
    if target and target.get("status", "active") == "active":
        return row
    successor_ref = resolve_successor(db, row["session_ref"])
    successor = (reg.get("chats") or {}).get(successor_ref) if successor_ref else None
    if not successor or successor.get("status", "active") != "active" or successor.get("project") != row["project"]:
        return None
    alias = successor.get("account")
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    if not identity:
        return None
    begin_immediate(db)
    try:
        if row["kind"] == "management" and row["event_id"]:
            db.execute("""UPDATE management_deliveries SET target_ref=?,status='QUEUED',updated_at=?
                          WHERE event_id=? AND target_ref=?""",
                       (successor_ref, stamp(), row["event_id"], row["session_ref"]))
        db.execute("""UPDATE operations SET account_alias=?,account_id=?,caller_ref=?,session_ref=?,role=?,reason=NULL,updated_at=?
                      WHERE id=? AND status='DISPATCHING'""",
                   (alias, account_id(identity), successor_ref, successor_ref, successor.get("role") or successor_ref,
                    stamp(), row["id"]))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()


def result(db, payload):
    task_id = str(payload.get("taskId") or payload.get("task") or "").strip()
    status = str(payload.get("status") or "COMPLETE").strip().upper()
    if status not in {"COMPLETE", "BLOCKED", "FAILED", "ERROR"}:
        raise ValueError("INVALID_RESULT_STATUS")
    summary = str(payload.get("summary") or "").strip()
    if not task_id or not summary:
        raise ValueError("taskId and summary are required")
    task = task_contract(db, task_id)
    if not task:
        raise ValueError("RESULT_TASK_NOT_REGISTERED")
    if task.get("nativeTarget"):
        target = task["nativeTarget"]
        if os.environ.get("CODEX_THREAD_ID") != target["threadId"] or os.uname().nodename != target["host"] or os.environ.get("CHAT_BRIDGE_FROM_SPACE") or os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID"):
            raise ValueError("NATIVE_RESULT_WORKER_MISMATCH")
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin:
        reg = registry(db)
        alias = task.get("account")
        identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
        if not identity or account_id(identity) != origin:
            raise ValueError("RESULT_ORIGIN_ACCOUNT_MISMATCH")
    version = str(payload.get("resultVersion") or "1").strip()
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", version):
        raise ValueError("INVALID_RESULT_VERSION")
    github = str(payload.get("github") or "").strip()
    next_text = str(payload.get("next") or "").strip()
    event_id = "result:" + task_id + ":" + version
    result_payload = {"taskId":task_id,"status":status,"summary":summary,"github":github,"next":next_text,"resultVersion":version}
    digest = hashlib.sha256(json.dumps(result_payload,sort_keys=True,ensure_ascii=False).encode()).hexdigest()

    prior = db.execute("SELECT * FROM task_results WHERE task_id=? AND result_version=?", (task_id,version)).fetchone()
    if prior:
        if prior["payload_hash"] != digest:
            raise ValueError("RESULT_VERSION_CONFLICT")
        callback_row = db.execute("SELECT * FROM operations WHERE id=?", (prior["callback_operation_id"],)).fetchone() if prior["callback_operation_id"] else None
        return {"resultRecorded":True,"taskId":task_id,"workgroupId":prior["workgroup_id"],"resultVersion":version,"eventId":prior["event_id"],
                "callback":response(callback_row) if callback_row else None,
                "acceptanceStatus":prior["acceptance_status"],"callbackStatus":prior["callback_status"]}

    reg = registry(db)
    workgroup = task_workgroup(task)
    owner_ref, target_ref, target = result_owner(db, reg, task)
    if target and target.get("status", "active") == "active" and target.get("project") != task.get("project"):
        raise ValueError("CALLBACK_PROJECT_MISMATCH")
    alias = target.get("account") if target else None
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity") if alias else None
    message = result_message(task_id, status, version, summary, github, next_text)
    operation_id = None
    now = stamp()
    begin_immediate(db)
    try:
        prior = db.execute("SELECT * FROM task_results WHERE task_id=? AND result_version=?", (task_id,version)).fetchone()
        if prior:
            if prior["payload_hash"] != digest:
                raise ValueError("RESULT_VERSION_CONFLICT")
            db.commit()
            callback_row = db.execute("SELECT * FROM operations WHERE id=?", (prior["callback_operation_id"],)).fetchone() if prior["callback_operation_id"] else None
            return {"resultRecorded":True,"taskId":task_id,"workgroupId":prior["workgroup_id"],"resultVersion":version,"eventId":prior["event_id"],
                    "callback":response(callback_row) if callback_row else None,
                    "acceptanceStatus":prior["acceptance_status"],"callbackStatus":prior["callback_status"]}

        if target and target.get("status", "active") == "active" and target.get("project") == task.get("project") and target_matches_task_scope(task, target, reg) and identity:
            operation_id = str(uuid.uuid4())
            request_key = "callback:" + task_id + ":" + target_ref + ":" + event_id
            db.execute("""INSERT INTO operations(
                id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
                role,message,task_id,created_at,updated_at,not_before,kind,event_id,workgroup_id,original_message)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (operation_id,request_key,hashlib.sha256(message.encode()).hexdigest(),"QUEUED",target["project"],alias,
                 account_id(identity),target_ref,target_ref,target.get("role") or target_ref,message,task_id,
                 now,now,time.time(),"callback",event_id,workgroup,message))
        callback_status = "WAITING_LOCAL" if task.get("localOwner") else ("QUEUED" if operation_id else "WAITING_ROUTE")
        db.execute("""INSERT INTO task_results(
            task_id,result_version,event_id,status,summary,github,next_text,payload_hash,
            callback_operation_id,callback_status,workgroup_id,owner_ref,owner_project,owner_account,recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (task_id,version,event_id,status,summary,github or None,next_text or None,digest,operation_id,
             callback_status,workgroup,owner_ref,task.get("project"),alias,now))
        row = db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
        rt = json.loads(row[0])
        live = (rt.get("tasks") or {}).get(task_id)
        if live:
            live["status"]="RESULT_RECORDED"
            live["reportedStatus"]=status
            live["resultVersion"]=version
            live["resultEventId"]=event_id
            live["resultRecordedAt"]=now
            live["resultSummary"]=summary
            live["controllerAckStatus"]=None
            live["controllerAckAt"]=None
            live["controllerAckMessage"]=None
            if github: live["github"]=github
            live["externalResponsePending"]=False
            live["updatedAt"]=now
            db.execute("UPDATE documents SET payload=? WHERE kind=?",(json.dumps(rt,ensure_ascii=False),"runtime"))
        db.commit()
    except Exception:
        db.rollback()
        raise
    callback_row=db.execute("SELECT * FROM operations WHERE id=?",(operation_id,)).fetchone()
    return {"resultRecorded":True,"taskId":task_id,"workgroupId":workgroup,"resultVersion":version,"eventId":event_id,
            "reportedStatus":status,"callback":response(callback_row) if callback_row else None,
            "callbackStatus":callback_status,"acceptanceStatus":None}


def result_ack(db, payload):
    task_id=str(payload.get("taskId") or "").strip()
    version=str(payload.get("resultVersion") or "1").strip()
    caller=str(payload.get("callerRef") or "").strip()
    status=str(payload.get("status") or "ACCEPTED").strip().upper()
    message=str(payload.get("message") or "").strip()
    if status not in {"ACCEPTED","REJECTED","BLOCKED"}:
        raise ValueError("INVALID_RESULT_ACK_STATUS")
    result_row=db.execute("SELECT * FROM task_results WHERE task_id=? AND result_version=?",(task_id,version)).fetchone()
    if not result_row:
        raise ValueError("RESULT_NOT_REGISTERED")
    task=task_contract(db,task_id)
    if not task:
        raise ValueError("RESULT_TASK_NOT_REGISTERED")
    reg=registry(db)
    owner_ref=result_row["owner_ref"]
    local_owner = task.get("localOwner")
    expected = owner_ref if local_owner else (resolve_successor(db, owner_ref) if owner_ref else result_owner(db,reg,task)[1])
    if not expected:
        raise ValueError("RESULT_ACK_OWNER_UNAVAILABLE")
    if caller!=expected:
        raise ValueError("RESULT_ACK_TARGET_MISMATCH")
    if local_owner:
        local_caller(caller, local_owner)
    else:
        chat=(reg.get("chats") or {}).get(expected)
        if not chat or chat.get("status", "active") != "active" or chat.get("project") != task.get("project"):
            raise ValueError("RESULT_ACK_OWNER_UNAVAILABLE")
        if not target_matches_task_scope(task, chat, reg) or (result_row["workgroup_id"] or None) != task_workgroup(task):
            raise ValueError("RESULT_ACK_WORKGROUP_MISMATCH")
        identity=((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity") if chat else None
        origin=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
        if origin and (not identity or account_id(identity)!=origin):
            raise ValueError("RESULT_ACK_ORIGIN_ACCOUNT_MISMATCH")
    now=stamp()
    begin_immediate(db)
    try:
        current=db.execute("SELECT acceptance_status,acceptance_message,accepted_at FROM task_results WHERE task_id=? AND result_version=?",
                           (task_id,version)).fetchone()
        if current and current["acceptance_status"]:
            if current["acceptance_status"]!=status or (current["acceptance_message"] or "")!=message:
                raise ValueError("RESULT_ALREADY_ACKED")
            db.commit()
            return {"taskId":task_id,"resultVersion":version,"status":status,"callerRef":expected,"message":message,
                    "acceptedAt":current["accepted_at"],"idempotent":True}
        latest=db.execute("""SELECT result_version,recorded_at FROM task_results
                            WHERE task_id=? ORDER BY recorded_at DESC,event_id DESC LIMIT 1""",(task_id,)).fetchone()
        if latest and latest["result_version"]!=version and latest["recorded_at"]>result_row["recorded_at"]:
            raise ValueError("STALE_RESULT_ACK")
        changed=db.execute("""UPDATE task_results SET acceptance_status=?,acceptance_message=?,accepted_at=?
                      WHERE task_id=? AND result_version=? AND acceptance_status IS NULL""",(status,message,now,task_id,version))
        if changed.rowcount != 1:
            raise ValueError("RESULT_ACK_CONFLICT")
        if local_owner:
            db.execute("""UPDATE task_results SET callback_status='RECEIVED_LOCAL',callback_delivered_at=?
                          WHERE task_id=? AND result_version=?""", (now, task_id, version))
        row=db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
        rt=json.loads(row[0])
        live=(rt.get("tasks") or {}).get(task_id)
        if live:
            live["controllerAckStatus"]=status
            live["controllerAckAt"]=now
            live["controllerAckMessage"]=message
            if status=="ACCEPTED":
                live["status"]="COMPLETE"
            elif status=="REJECTED":
                live["status"]="BLOCKED"
                live["blockedReason"]="RESULT_REJECTED"
            else:
                live["status"]="BLOCKED"
                live["blockedReason"]="CONTROLLER_BLOCKED"
            live["updatedAt"]=now
            db.execute("UPDATE documents SET payload=? WHERE kind=?",(json.dumps(rt,ensure_ascii=False),"runtime"))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"taskId":task_id,"resultVersion":version,"status":status,"callerRef":expected,"message":message}


def receive_local_result(db, payload):
    """Bounded local wait. Reading is replayable; only the owner's ACK settles it."""
    task_id = str(payload.get("taskId") or "")
    caller = str(payload.get("callerRef") or "")
    wait = float(payload.get("waitSeconds") or 0)
    if not 0 <= wait <= 55:
        raise ValueError("WAIT_SECONDS_MUST_BE_0_TO_55")
    task = task_contract(db, task_id)
    if not task or not task.get("localOwner") or caller != task.get("replyToSessionRef"):
        raise ValueError("LOCAL_RESULT_OWNER_MISMATCH")
    local_caller(caller, task["localOwner"])
    deadline = time.monotonic() + wait
    while True:
        row = db.execute("""SELECT * FROM task_results WHERE task_id=?
                            ORDER BY recorded_at DESC,event_id DESC LIMIT 1""", (task_id,)).fetchone()
        if row:
            if row["owner_ref"] != caller or row["owner_project"] != task["project"]:
                raise ValueError("LOCAL_RESULT_OWNER_MISMATCH")
            return {"status": "RESULT_AVAILABLE", "transport": "local-pull", "taskId": task_id,
                    "owner": task["localOwner"], "callerRef": caller, "eventId": row["event_id"],
                    "resultVersion": row["result_version"], "reportedStatus": row["status"],
                    "summary": row["summary"], "github": row["github"], "next": row["next_text"],
                    "callbackStatus": row["callback_status"], "acceptanceStatus": row["acceptance_status"]}
        operation = db.execute("""SELECT * FROM operations WHERE task_id=? AND kind='dispatch'
                                  ORDER BY created_at DESC LIMIT 1""", (task_id,)).fetchone()
        if time.monotonic() >= deadline or operation["status"] in {"CANCELLED", "FAILED_PRE_SEND", "DELIVERY_UNKNOWN"}:
            live = (runtime(db).get("tasks") or {}).get(task_id) or {}
            return {"status": "PENDING", "transport": "local-pull", "taskId": task_id,
                    "operation": response(operation), "taskStatus": live.get("status"),
                    "blockedReason": live.get("blockedReason")}
        # ponytail: local polling avoids a daemon; add push only after receiver integration is verified.
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))


def configure(config, state, payload):
    store = str(pathlib.Path(__file__).with_name("state-store.py"))
    base = json.loads(subprocess.run([sys.executable, store, "get", str(config), str(state), "registry"],
                                     check=True, capture_output=True, text=True, timeout=20).stdout)
    next_value = json.loads(json.dumps(base))
    accounts = next_value.setdefault("accounts", {})
    projects = next_value.setdefault("projects", {})
    kind = payload.get("type")
    dry_run = bool(payload.get("dryRun"))
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
        parent = str(payload.get("parentWorkgroupId") or "").strip() or None
        charter = str(payload.get("charterIssue") or "").strip() or None
        existing = (current.get("workgroups") or {}).get(group_id) if current else None
        expected = payload.get("expectedRevision", 0)
        if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
            raise ValueError("INVALID_WORKGROUP_REVISION")
        if not current or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,63}", group_id) or not name or len(name) > 100:
            raise ValueError("INVALID_WORKGROUP")
        if controller and ((next_value.get("chats") or {}).get(controller) or {}).get("project") != project_key:
            raise ValueError("WORKGROUP_CONTROLLER_NOT_REGISTERED")
        if parent and (parent == group_id or parent not in (current.get("workgroups") or {})):
            raise ValueError("WORKGROUP_PARENT_NOT_REGISTERED")
        seen_parents = set()
        cursor = parent
        while cursor and cursor not in seen_parents:
            if cursor == group_id:
                raise ValueError("WORKGROUP_PARENT_CYCLE")
            seen_parents.add(cursor)
            cursor = str(((current.get("workgroups") or {}).get(cursor) or {}).get("parentWorkgroupId") or "").strip() or None
        actual_revision = int((existing or {}).get("revision") or 0)
        desired = {"name": name, "controllerSessionRef": controller, "parentWorkgroupId": parent, "charterIssue": charter}
        diff = {key: {"before": (existing or {}).get(key), "after": value}
                for key, value in desired.items() if (existing or {}).get(key) != value}
        if existing and not diff:
            result = {"workgroup": {"id": group_id, **existing}, "changed": False,
                      "preview": {"changed": False, "diff": {}}}
        else:
            if existing and expected != actual_revision:
                raise ValueError("WORKGROUP_REVISION_CONFLICT")
            candidate = {**desired, "revision": actual_revision + 1, "epoch": int((existing or {}).get("epoch") or 0) + 1}
            result = {"workgroup": {"id": group_id, **candidate}, "changed": True,
                      "preview": {"changed": True, "diff": diff}}
            if not dry_run:
                current.setdefault("workgroups", {})[group_id] = candidate
    else:
        raise ValueError("UNKNOWN_CONFIG_TYPE")
    if dry_run:
        result["dryRun"] = True
        return result
    written = subprocess.run([sys.executable, store, "put", str(config), str(state), "registry"],
                             input=json.dumps({"base": base, "next": next_value}), capture_output=True, text=True, timeout=20)
    if written.returncode:
        raise ValueError(written.stderr.strip() or "CONFIG_WRITE_FAILED")
    if kind == "workgroup":
        readback = json.loads(subprocess.run([sys.executable, store, "get", str(config), str(state), "registry"],
                                             check=True, capture_output=True, text=True, timeout=20).stdout)
        actual = ((readback.get("projects") or {}).get(project_key) or {}).get("workgroups", {}).get(group_id)
        result["readback"] = {"workgroup": {"id": group_id, **actual}} if actual else None
    return result


def put_registry_projection(config, state, base, next_value):
    store = str(pathlib.Path(__file__).with_name("state-store.py"))
    completed = subprocess.run(
        [sys.executable, store, "put", str(config), str(state), "registry"],
        input=json.dumps({"base": base, "next": next_value}),
        capture_output=True, text=True, timeout=20,
    )
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or "REGISTRY_WRITE_FAILED")


def authorize_control(db, caller_ref=None, project=None, global_scope=False, workgroup=None):
    origin=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if not origin:
        return {"authorized":True,"mode":"HOST_LOCAL"}
    caller=str(caller_ref or "").strip()
    if not caller:
        raise ValueError("CONTROL_CALLER_REF_REQUIRED")
    reg=registry(db)
    chat=(reg.get("chats") or {}).get(caller)
    if not chat or chat.get("status","active")!="active":
        raise ValueError("CONTROL_CALLER_NOT_REGISTERED")
    identity=((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity")
    if not identity or account_id(identity)!=origin:
        raise ValueError("CONTROL_ORIGIN_MISMATCH")
    if caller in set(reg.get("managementAdmins") or []):
        return {"authorized":True,"mode":"MANAGEMENT_ADMIN","callerRef":caller}
    if workgroup:
        if global_scope or not project:
            raise ValueError("WORKGROUP_SCOPE_REQUIRES_PROJECT")
        group = ((reg.get("projects") or {}).get(project) or {}).get("workgroups", {}).get(workgroup)
        if not group:
            raise ValueError("WORKGROUP_NOT_REGISTERED")
        root_role = ((reg.get("projects") or {}).get(project) or {}).get("rootController") or "conductor"
        current_root = current_controller_ref(db, reg, project, root_role)
        if caller == current_root:
            return {"authorized":True,"mode":"PROJECT_ROOT","callerRef":caller,"project":project,"workgroupId":workgroup}
        if caller == group.get("controllerSessionRef"):
            return {"authorized":True,"mode":"WORKGROUP_CONTROLLER","callerRef":caller,"project":project,"workgroupId":workgroup}
        raise ValueError("WORKGROUP_CONTROLLER_REQUIRED")
    if not global_scope and project:
        cfg=(reg.get("projects") or {}).get(project) or {}
        root_role=cfg.get("rootController") or "conductor"
        current=current_controller_ref(db,reg,project,root_role)
        if current==caller:
            return {"authorized":True,"mode":"PROJECT_ROOT","callerRef":caller,"project":project}
    raise ValueError("CONTROL_ADMIN_REQUIRED")


def configure_admin(config,state,db,sub,target,confirm=False):
    if not confirm and sub in {"add","remove"}:
        raise ValueError("admin mutation requires --confirm")
    origin=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    reg=registry(db)
    admins=list(reg.get("managementAdmins") or [])
    if sub=="list":
        return {"managementAdmins":admins}
    if origin:
        # Web callers may not bootstrap or alter the host-wide admin set.
        raise ValueError("HOST_LOCAL_REQUIRED_FOR_ADMIN_MUTATION")
    if not target or target not in (reg.get("chats") or {}):
        raise ValueError("ADMIN_SESSION_NOT_REGISTERED")
    base=reg
    next_reg=json.loads(json.dumps(reg))
    values=list(next_reg.get("managementAdmins") or [])
    if sub=="add" and target not in values: values.append(target)
    if sub=="remove": values=[value for value in values if value!=target]
    next_reg["managementAdmins"]=values
    put_registry_projection(config,state,base,next_reg)
    return {"managementAdmins":values,"changed":True,"targetRef":target,"action":sub}


def configure_project_requirements(config,state,db,project,context_version,tools):
    reg=registry(db)
    if project not in (reg.get("projects") or {}): raise ValueError("PROJECT_NOT_REGISTERED")
    base=reg; next_reg=json.loads(json.dumps(reg))
    req={}
    if context_version: req["contextVersion"]=str(context_version).strip()
    req["tools"]=sorted({item.strip() for item in (tools or []) if item.strip()})
    next_reg["projects"][project]["requirements"]=req
    put_registry_projection(config,state,base,next_reg)
    return {"project":project,"requirements":req}


def attest_project_binding(config,state,db,project,account,context_version,tools,caller_ref=None):
    reg=registry(db)
    cfg=(reg.get("projects") or {}).get(project)
    binding=(cfg.get("bindings") or {}).get(account) if cfg else None
    if not binding or not binding.get("projectUrl"): raise ValueError("PROJECT_BINDING_REQUIRED")
    if not ((reg.get("accounts") or {}).get(account) or {}).get("identity"): raise ValueError("ACCOUNT_NOT_VERIFIED")
    base=reg; next_reg=json.loads(json.dumps(reg))
    readiness={"contextVersion":str(context_version or "").strip() or None,
               "tools":sorted({item.strip() for item in (tools or []) if item.strip()}),
               "attestedAt":stamp(),"attestedBy":caller_ref or "HOST_LOCAL"}
    next_reg["projects"][project]["bindings"][account]["readiness"]=readiness
    put_registry_projection(config,state,base,next_reg)
    ready=binding_execution_ready(next_reg["projects"][project],next_reg["projects"][project]["bindings"][account])
    return {"project":project,"account":account,"readiness":readiness,"executionReady":ready}


def set_control_mode(db, project, mode, reason=None, workgroup=None):
    mode = str(mode or "").upper()
    if mode not in {"RUNNING", "PAUSED", "DRAINING"}:
        raise ValueError("INVALID_CONTROL_MODE")
    if workgroup and not project:
        raise ValueError("WORKGROUP_SCOPE_REQUIRES_PROJECT")
    scope = (f"workgroup:{project}:{workgroup}" if workgroup else ("global" if not project else "project:" + project))
    current = db.execute("SELECT epoch FROM control_state WHERE scope=?", (scope,)).fetchone()
    epoch = (current["epoch"] if current else 0) + 1
    db.execute("""INSERT INTO control_state(scope,mode,epoch,reason,updated_at) VALUES (?,?,?,?,?)
                  ON CONFLICT(scope) DO UPDATE SET mode=excluded.mode,epoch=excluded.epoch,
                    reason=excluded.reason,updated_at=excluded.updated_at""",
               (scope, mode, epoch, reason, stamp()))
    db.commit()
    return {"scope": scope, "mode": mode, "epoch": epoch, "reason": reason}


def enqueue_stop_requests(db, project, task_id=None):
    reg,rt=registry(db),runtime(db)
    targets=[]
    for task in (rt.get("tasks") or {}).values():
        if project and task.get("project")!=project: continue
        if task_id and task.get("taskId")!=task_id: continue
        if str(task.get("status") or "").upper() in TERMINAL: continue
        session=task.get("sessionId")
        chat=(reg.get("chats") or {}).get(session) if session else None
        if not chat: continue
        alias=chat.get("account") or task.get("account")
        identity=((reg.get("accounts") or {}).get(alias) or {}).get("identity")
        if not identity: continue
        key="stop:"+str(task.get("taskId"))+":"+str(session)
        prior=db.execute("SELECT * FROM operations WHERE request_key=?",(key,)).fetchone()
        if prior:
            targets.append(response(prior)); continue
        op_id,now=str(uuid.uuid4()),stamp()
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,original_message)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (op_id,key,hashlib.sha256(key.encode()).hexdigest(),"QUEUED",chat["project"],alias,account_id(identity),
             session,session,chat.get("role") or session,"stop generation",task.get("taskId"),now,now,time.time(),"stop","stop generation"))
        task["stopRequestedAt"]=now
        task["updatedAt"]=now
        targets.append(response(db.execute("SELECT * FROM operations WHERE id=?",(op_id,)).fetchone()))
    db.execute("UPDATE documents SET payload=? WHERE kind=?",(json.dumps(rt,ensure_ascii=False),"runtime"))
    db.commit()
    return {"project":project,"taskId":task_id,"stopRequests":targets}


def current_controller_ref(db, reg, project, role, workgroup=None):
    row = db.execute("""SELECT current_session_ref FROM logical_sessions
                        WHERE project=? AND role=? AND state='ACTIVE'
                          AND ((workgroup_id IS NULL AND ? IS NULL) OR workgroup_id=?)
                        ORDER BY epoch DESC LIMIT 1""", (project, role, workgroup, workgroup)).fetchone()
    if row and row["current_session_ref"]:
        chat = (reg.get("chats") or {}).get(row["current_session_ref"])
        if chat and chat.get("status", "active") == "active":
            return row["current_session_ref"]
    matches = [chat["id"] for chat in (reg.get("chats") or {}).values()
               if chat.get("project") == project and chat.get("role") == role
               and (chat.get("workgroupId") == workgroup if workgroup else not chat.get("workgroupId"))
               and chat.get("status", "active") == "active"]
    if len(matches) == 1:
        return matches[0]
    return None


def execution_summary(rt, tasks, control_mode, pending_business, pending_callbacks, pending_management,
                      pre_send_retrying, failed_pre_send, unknown_ops, awaiting_ack, capacity_waiting,
                      blocked, failed, historical_failed_pre_send=0):
    """Expose one honest run state while keeping historical counters separate."""
    now = datetime.now(timezone.utc)
    generating = 0
    stale_running = 0
    for task in tasks:
        status = str(task.get("status") or "").upper()
        if status in TERMINAL:
            continue
        snapshot = (rt.get("sessions") or {}).get(task.get("sessionId")) or {}
        observed = snapshot.get("observedAt") or task.get("stateUpdatedAt")
        age = None
        if observed:
            try:
                timestamp = datetime.fromisoformat(str(observed).replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                age = max(0, (now - timestamp).total_seconds())
            except (TypeError, ValueError):
                pass
        fresh = age is not None and age <= 180
        if fresh and snapshot.get("generating") and not task.get("watchdogPausedForUserControl"):
            generating += 1
        elif status in {"RUNNING", "DISPATCHED", "RECOVERING", "AWAITING_DURABLE_UPDATE"}:
            stale_running += 1
    if control_mode in {"PAUSED", "DRAINING"}:
        state, label, color = ("PAUSED", "已暂停" if control_mode == "PAUSED" else "排空中", "amber")
    elif generating:
        state, label, color = "GENERATING", "最近观察到生成", "green"
    elif pre_send_retrying or failed_pre_send:
        state, label, color = "PRE_SEND_REVIEW", "发送前故障待处理", "red"
    elif unknown_ops:
        state, label, color = "DELIVERY_UNKNOWN", "投递结果待核对", "red"
    elif pending_business or pending_callbacks or pending_management:
        state, label, color = "QUEUED", "队列中等待执行", "blue"
    elif capacity_waiting:
        state, label, color = "WAITING_CAPACITY", "等待容量", "amber"
    elif awaiting_ack:
        state, label, color = "AWAITING_ACK", "等待总控确认", "blue"
    elif stale_running:
        state, label, color = "RUNNING_STALE", "运行记录待刷新", "amber"
    elif blocked or failed:
        state, label, color = "NEEDS_REVIEW", "有任务需要复核", "red"
    else:
        state, label, color = "IDLE", "当前没有已派发任务", "gray"
    return {
        "state": state, "label": label, "color": color,
        "recentlyObservedGenerating": generating,
        "runningAwaitingObservation": stale_running,
        "queued": pending_business + pending_callbacks + pending_management,
        "preSendRetrying": pre_send_retrying,
        "failedPreSend": failed_pre_send,
        "historicalFailedPreSend": historical_failed_pre_send,
        "deliveryUnknown": unknown_ops,
        "awaitingControllerAck": awaiting_ack,
        "capacityWaiting": capacity_waiting,
        "source": "local-authoritative-state-with-cached-browser-observations",
        "observationFreshnessSec": 180,
    }


def control_status(db, project=None, workgroup=None):
    reg, rt = registry(db), runtime(db)
    task_view = {**(rt.get("tasks") or {}), **native_tasks(db)}
    projects = []
    for name, cfg in (reg.get("projects") or {}).items():
        if project and name != project:
            continue
        if workgroup and workgroup not in (cfg.get("workgroups") or {}):
            continue
        tasks = [task for task in task_view.values() if task.get("project") == name]
        task_counts = {}
        for task in tasks:
            key = str(task.get("status") or "UNKNOWN").upper()
            task_counts[key] = task_counts.get(key, 0) + 1
        operation_rows = db.execute(
            "SELECT status,kind,count(*) AS n FROM operations WHERE project=? GROUP BY status,kind", (name,)
        ).fetchall()
        operation_counts = {(row["kind"], row["status"]): row["n"] for row in operation_rows}
        result_rows = db.execute("""SELECT tr.* FROM task_results tr
            LEFT JOIN operations op ON op.task_id=tr.task_id AND op.kind='dispatch'
            WHERE coalesce(op.project,tr.owner_project)=? GROUP BY tr.task_id,tr.result_version""", (name,)).fetchall()
        results = {
            "recorded": len(result_rows),
            "callbackPending": sum(1 for row in result_rows if not row["callback_status"]
                                   or row["callback_status"] in {"QUEUED","DISPATCHING","WAITING_ROUTE","WAITING_LOCAL"}),
            "callbackWaitingLocal": sum(1 for row in result_rows if row["callback_status"] == "WAITING_LOCAL"),
            "callbackWaitingRoute": sum(1 for row in result_rows if row["callback_status"] == "WAITING_ROUTE"),
            "callbackUnknown": sum(1 for row in result_rows if row["callback_status"]=="DELIVERY_UNKNOWN"),
            "awaitingControllerAck": sum(1 for row in result_rows
                                         if not row["acceptance_status"]),
            "accepted": sum(1 for row in result_rows if row["acceptance_status"]=="ACCEPTED"),
            "rejectedOrBlocked": sum(1 for row in result_rows if row["acceptance_status"] in {"REJECTED","BLOCKED"}),
        }
        mgmt = db.execute("""SELECT
              sum(CASE WHEN d.status='ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged,
              sum(CASE WHEN d.status IN ('QUEUED','DISPATCHING','SENT')
                         AND o.status IN ('QUEUED','DISPATCHING','SENT') THEN 1 ELSE 0 END) AS pending
            FROM management_deliveries d JOIN management_events e ON e.id=d.event_id
            LEFT JOIN operations o ON o.id=d.operation_id
            WHERE e.scope IN ('global',?)""", ("project:"+name,)).fetchone()
        pending_business_ops = sum(n for (kind,status),n in operation_counts.items()
                                   if kind in {"dispatch","rotation","stop"} and status in {"QUEUED","DISPATCHING"})
        pending_callback_ops = sum(n for (kind,status),n in operation_counts.items()
                                   if kind=="callback" and status in {"QUEUED","DISPATCHING"})
        unknown_ops = sum(n for (kind,status),n in operation_counts.items()
                          if status in {"DELIVERY_UNKNOWN", "SUPERSEDED"})
        total_failed_pre_send = sum(n for (kind,status),n in operation_counts.items() if status == "FAILED_PRE_SEND")
        # An owner ACK settles notification delivery; retain its transport failure in the raw ledger.
        failed_pre_send = db.execute("""SELECT count(*) FROM operations o
            WHERE o.project=? AND o.status='FAILED_PRE_SEND'
              AND NOT EXISTS (SELECT 1 FROM task_results tr
                  WHERE tr.task_id=o.task_id AND tr.acceptance_status IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM management_deliveries d
                  WHERE d.operation_id=o.id AND d.status='ACKNOWLEDGED')""", (name,)).fetchone()[0]
        pre_send_retrying = db.execute(
            "SELECT count(*) FROM operations WHERE project=? AND status='QUEUED' AND reason LIKE 'PRE_SEND_RETRY_%'", (name,)
        ).fetchone()[0]
        reconciled_superseded_ops = sum(n for (kind,status),n in operation_counts.items()
                                        if status == "RECONCILED_SUPERSEDED")
        active_tasks = sum(count for status,count in task_counts.items() if status not in TERMINAL)
        blocked = task_counts.get("BLOCKED",0)
        failed = task_counts.get("FAILED",0)
        cancelled = task_counts.get("CANCELLED",0)
        awaiting_durable = task_counts.get("AWAITING_DURABLE_UPDATE",0)
        awaiting_ack = task_counts.get("RESULT_RECORDED",0)
        capacity_waiting = task_counts.get(CAPACITY_WAITING,0)
        pending_management = int((mgmt["pending"] if mgmt and mgmt["pending"] is not None else 0) or 0)
        control = management_mode(db, name)
        workgroup_rows = []
        for group_id, group in (cfg.get("workgroups") or {}).items():
            if workgroup and group_id != workgroup:
                continue
            scoped = [task for task in tasks if task.get("workgroupId") == group_id]
            statuses = {}
            for task in scoped:
                status = str(task.get("status") or "UNKNOWN").upper()
                statuses[status] = statuses.get(status, 0) + 1
            scoped_results = [row for row in result_rows if (row["workgroup_id"] or None) == group_id]
            scoped_ops = db.execute("""SELECT kind,status,count(*) AS n FROM operations
                                      WHERE project=? AND workgroup_id=? GROUP BY kind,status""", (name, group_id)).fetchall()
            scoped_op_reasons = db.execute("""SELECT DISTINCT reason FROM operations
                                              WHERE project=? AND workgroup_id=? AND reason IS NOT NULL""", (name, group_id)).fetchall()
            scoped_waiting = sorted({str(task.get("blockedReason") or task.get("capacityReason") or "")
                                     for task in scoped if task.get("blockedReason") or task.get("capacityReason")})
            scoped_waiting.extend(sorted({"CALLBACK_" + str(row["callback_status"])
                                          for row in scoped_results if row["callback_status"] in {"WAITING_ROUTE", "DELIVERY_UNKNOWN"}}))
            scoped_waiting.extend(sorted({str(row["reason"]) for row in scoped_op_reasons if row["reason"]}))
            owner_contract = group.get("controllerSessionRef")
            owner_current = resolve_successor(db, owner_contract) if owner_contract else None
            owner_chat = (reg.get("chats") or {}).get(owner_current) if owner_current else None
            workgroup_rows.append({
                "workgroupId": group_id,
                "name": group.get("name") or group_id,
                "charterIssue": group.get("charterIssue"),
                "parentWorkgroupId": group.get("parentWorkgroupId"),
                "revision": group.get("revision", 0),
                "epoch": group.get("epoch", 0),
                "ownerSessionRef": owner_current if owner_chat and owner_chat.get("status", "active") == "active" else owner_contract,
                "ownerContractSessionRef": owner_contract,
                "control": management_mode(db, name, group_id),
                "tasks": {"total": len(scoped), "byStatus": statuses},
                "results": {
                    "recorded": len(scoped_results),
                    "awaitingControllerAck": sum(1 for row in scoped_results if not row["acceptance_status"]),
                    "callbackPending": sum(1 for row in scoped_results if row["callback_status"] in {None, "QUEUED", "DISPATCHING", "WAITING_ROUTE"}),
                    "callbackUnknown": sum(1 for row in scoped_results if row["callback_status"] == "DELIVERY_UNKNOWN"),
                    "accepted": sum(1 for row in scoped_results if row["acceptance_status"] == "ACCEPTED"),
                },
                "operations": [{"kind": row["kind"], "status": row["status"], "count": row["n"]} for row in scoped_ops],
                "waitingReasons": scoped_waiting,
                "updatedAt": max([str(task.get("updatedAt") or "") for task in scoped] +
                                  [str(row["recorded_at"] or "") for row in scoped_results], default=None),
            })

        if blocked or failed or unknown_ops or results["callbackUnknown"] or results["rejectedOrBlocked"]:
            completion_state = "NEEDS_REVIEW"
        elif active_tasks or pending_business_ops or awaiting_durable:
            completion_state = "IN_PROGRESS"
        elif awaiting_ack or pending_callback_ops or results["callbackPending"] or results["awaitingControllerAck"] or pending_management:
            completion_state = "AWAITING_ACK"
        elif tasks and all(str(task.get("status") or "").upper()=="COMPLETE" for task in tasks):
            completion_state = "COMPLETE"
        elif tasks and cancelled:
            completion_state = "NEEDS_REVIEW"
        else:
            completion_state = "NO_KNOWN_WORK"

        root_role = cfg.get("rootController") or "conductor"
        controller = current_controller_ref(db, reg, name, root_role)
        execution = execution_summary(rt, tasks, control["mode"], pending_business_ops, pending_callback_ops,
                                      pending_management, pre_send_retrying, failed_pre_send, unknown_ops,
                                      results["awaitingControllerAck"], capacity_waiting, blocked, failed,
                                      total_failed_pre_send - failed_pre_send)
        projects.append({
            "project": name,
            "businessState": cfg.get("businessState") or ("ARCHIVED" if cfg.get("archived") else "UNSPECIFIED"),
            "businessStateReason": cfg.get("businessStateReason"),
            "durableStateRef": cfg.get("durableStateRef"),
            "archived": bool(cfg.get("archived")),
            "control": control,
            "admission": {
                "mode": control["mode"],
                "acceptingNewWork": control["mode"] == "RUNNING" and not bool(cfg.get("archived")),
                "reason": control.get("reason"),
            },
            "rootRole": root_role,
            "rootControllerSessionRef": controller,
            "tasks": {
                "total": len(tasks),
                "active": active_tasks,
                "blocked": blocked,
                "failed": failed,
                "cancelled": cancelled,
                "capacityWaiting": capacity_waiting,
                "awaitingDurable": awaiting_durable,
                "resultRecorded": awaiting_ack,
                "complete": task_counts.get("COMPLETE",0),
                "byStatus": task_counts,
            },
            "results": results,
            "operations": [{"status": row["status"], "kind": row["kind"], "count": row["n"]} for row in operation_rows],
            "operationSummary": {"pendingBusiness": pending_business_ops, "pendingCallbacks": pending_callback_ops,
                                  "unknown": unknown_ops,
                                  **({"preSendRetrying": pre_send_retrying} if pre_send_retrying else {}),
                                  **({"failedPreSend": failed_pre_send} if failed_pre_send else {}),
                                  **({"reconciledSuperseded": reconciled_superseded_ops}
                                     if reconciled_superseded_ops else {})},
            "execution": execution,
            "management": {
                "acknowledged": int((mgmt["acknowledged"] if mgmt and mgmt["acknowledged"] is not None else 0) or 0),
                "pending": pending_management,
            },
            "workgroups": workgroup_rows,
            "attention": {
                "blockedTasks": blocked,
                "failedTasks": failed,
                "unknownOperations": unknown_ops,
                **({"preSendRetrying": pre_send_retrying} if pre_send_retrying else {}),
                **({"failedPreSend": failed_pre_send} if failed_pre_send else {}),
                "pendingBusiness": pending_business_ops,
                "pendingCallbacks": pending_callback_ops,
                "pendingManagement": pending_management,
                "awaitingControllerAck": results["awaitingControllerAck"],
                "awaitingDurable": awaiting_durable,
                **({"capacityWaiting": capacity_waiting} if capacity_waiting else {}),
                **({"reconciledSupersededOperations": reconciled_superseded_ops}
                   if reconciled_superseded_ops else {}),
            },
            "completion": {
                "state": completion_state,
                "knownComplete": completion_state=="COMPLETE",
                "note": "NO_KNOWN_WORK does not prove business completion" if completion_state=="NO_KNOWN_WORK" else None,
            },
            "updatedAt": (rt.get("projects", {}).get(name) or {}).get("updatedAt"),
        })
    events = [dict(row) for row in db.execute(
        """SELECT e.id,e.kind,e.scope,e.created_at,
                  sum(CASE WHEN d.status='ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged,
                  count(d.target_ref) AS targets
           FROM management_events e LEFT JOIN management_deliveries d ON d.event_id=e.id
           GROUP BY e.id ORDER BY e.created_at DESC LIMIT 50"""
    )]
    return {"at": stamp(), "globalControl": management_mode(db, "__none__"), "projects": projects, "managementEvents": events}


def management_targets(db, reg, project=None):
    by_ref = {}
    unresolved = []
    names = [project] if project else sorted((reg.get("projects") or {}).keys())
    for name in names:
        cfg = (reg.get("projects") or {}).get(name)
        if not cfg or cfg.get("archived"):
            continue
        role = cfg.get("rootController") or "conductor"
        ref = current_controller_ref(db, reg, name, role)
        if not ref:
            unresolved.append({"project": name, "role": role, "reason": "CONTROLLER_NOT_UNIQUE_OR_MISSING"})
            continue
        chat = (reg.get("chats") or {}).get(ref)
        identity = ((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity") if chat else None
        if not chat or not identity:
            unresolved.append({"project": name, "role": role, "reason": "CONTROLLER_ACCOUNT_UNVERIFIED"})
            continue
        item=by_ref.setdefault(ref,{"project":name,"projects":[],"role":role,"sessionRef":ref,
                                    "account":chat["account"],"accountId":account_id(identity)})
        item["projects"].append(name)
    return list(by_ref.values()), unresolved


def enqueue_management(db, event_id, target, message):
    key = "management:" + event_id + ":" + target["sessionRef"]
    prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
    if prior:
        return response(prior)
    operation_id, now = str(uuid.uuid4()), stamp()
    digest = hashlib.sha256(message.encode()).hexdigest()
    db.execute("""INSERT INTO operations(
        id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
        role,message,task_id,created_at,updated_at,not_before,kind,event_id,original_message)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (operation_id,key,digest,"QUEUED",target["project"],target["account"],target["accountId"],
         target["sessionRef"],target["sessionRef"],target["role"],message,"MGT-"+event_id,
         now,now,time.time(),"management",event_id,message))
    db.execute("""INSERT OR REPLACE INTO management_deliveries(
        event_id,target_ref,operation_id,status,ack_payload,updated_at) VALUES (?,?,?,?,?,?)""",
        (event_id,target["sessionRef"],operation_id,"QUEUED",None,now))
    return response(db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone())


def broadcast_management(db, payload):
    project = str(payload.get("project") or "").strip() or None
    if not payload.get("confirm"):
        targets, unresolved = management_targets(db, registry(db), project)
        return {"dryRun": True, "targets": targets, "unresolved": unresolved}
    kind = str(payload.get("kind") or "NOTICE").strip().upper()
    message = str(payload.get("message") or "").strip()
    if not message:
        raise ValueError("management broadcast message required")
    targets, unresolved = management_targets(db, registry(db), project)
    event_id = str(payload.get("eventId") or uuid.uuid4())
    scope = "project:" + project if project else "global"
    body = "\n".join([
        "[CHATBRIDGE MANAGEMENT v1]",
        f"event_id: {event_id}",
        f"kind: {kind}",
        f"scope: {scope}",
        message,
        "",
        "Required acknowledgement:",
        f"chat-bridge control ack --event {event_id} --caller-ref YOUR_SESSION_REF --status ACKNOWLEDGED --message <check-result>",
        "[/CHATBRIDGE MANAGEMENT]",
    ])
    begin_immediate(db)
    try:
        prior = db.execute("SELECT id FROM management_events WHERE id=?", (event_id,)).fetchone()
        if not prior:
            db.execute("INSERT INTO management_events(id,kind,scope,payload,created_at) VALUES (?,?,?,?,?)",
                       (event_id,kind,scope,json.dumps(payload,ensure_ascii=False),stamp()))
        deliveries = [enqueue_management(db,event_id,target,body) for target in targets]
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"dryRun": False, "eventId": event_id, "kind": kind, "scope": scope,
            "deliveries": deliveries, "unresolved": unresolved}


def acknowledge_management(db, payload):
    event_id = str(payload.get("eventId") or "").strip()
    caller = str(payload.get("callerRef") or "").strip()
    status = str(payload.get("status") or "ACKNOWLEDGED").strip().upper()
    message = str(payload.get("message") or "").strip()
    if status not in {"ACKNOWLEDGED", "BLOCKED", "FAILED"}:
        raise ValueError("INVALID_ACK_STATUS")
    row = db.execute("SELECT * FROM management_deliveries WHERE event_id=? AND target_ref=?",
                     (event_id, caller)).fetchone()
    if not row:
        raise ValueError("ACK_TARGET_NOT_REGISTERED")
    reg = registry(db)
    chat = (reg.get("chats") or {}).get(caller)
    identity = ((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity") if chat else None
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin and (not identity or account_id(identity) != origin):
        raise ValueError("ACK_ORIGIN_ACCOUNT_MISMATCH")
    db.execute("UPDATE management_deliveries SET status=?,ack_payload=?,updated_at=? WHERE event_id=? AND target_ref=?",
               (status,json.dumps({"message":message},ensure_ascii=False),stamp(),event_id,caller))
    db.commit()
    return {"eventId": event_id, "callerRef": caller, "status": status, "message": message}



def rotation_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def rotation_quarantine_event(db, project, role, workgroup=None):
    for row in db.execute("SELECT * FROM management_events WHERE kind='ROTATION_QUARANTINE' AND scope=? ORDER BY created_at DESC,id DESC", ("project:" + project,)):
        body = json.loads(row["payload"])
        if body.get("project") == project and body.get("role") == role and (body.get("workgroupId") or None) == workgroup:
            original = db.execute("SELECT * FROM operations WHERE id=?", (body.get("operationId"),)).fetchone()
            if (not original or body.get("operationSha256") != rotation_digest(dict(original))
                    or body.get("rotationId") != original["rotation_id"] or not body.get("logicalRef")):
                raise ValueError("ROTATION_QUARANTINE_AUDIT_INVALID")
            return {"id": row["id"], "createdAt": row["created_at"], "body": body}
    return None


def rotation_quarantine_context(db, payload):
    row = db.execute("SELECT * FROM operations WHERE id=?", (payload.get("operationId"),)).fetchone()
    if not row or row["kind"] != "rotation" or not row["force_new"]:
        raise ValueError("ROTATION_QUARANTINE_ORIGINAL_REQUIRED")
    authority = authorize_control(db, payload.get("callerRef"), row["project"], False, row["workgroup_id"])
    if os.environ.get("CHAT_BRIDGE_FROM_SPACE") and not os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID"):
        raise ValueError("CONTROL_ORIGIN_REQUIRED")
    logical = db.execute("SELECT * FROM logical_sessions WHERE rotation_id=?", (row["rotation_id"],)).fetchall()
    if len(logical) != 1:
        raise ValueError("ROTATION_QUARANTINE_ORIGINAL_REQUIRED")
    logical = logical[0]
    result = json.loads(row["result"]) if row["result"] else {}
    creation = result.get("newSession") or {}
    if row["status"] != "DELIVERY_UNKNOWN":
        raise ValueError("ROTATION_QUARANTINE_UNKNOWN_REQUIRED")
    if (row["session_ref"] or logical["pending_session_ref"] or logical["state"] != "ROTATING"
            or result.get("nativeWitness") or any(creation.get(k) for k in ("observedConversationId", "observedUrl", "sourceMessageId"))):
        raise ValueError("ROTATION_QUARANTINE_BOUND_OR_WITNESSED")
    reg, rt = registry(db), runtime(db)
    owner = logical["current_session_ref"]
    chat = reg.get("chats", {}).get(owner)
    identity = reg.get("accounts", {}).get(row["account_alias"], {}).get("identity")
    matches = [c["id"] for c in reg.get("chats", {}).values() if c.get("project") == row["project"]
               and c.get("role") == row["role"] and (c.get("workgroupId") or None) == row["workgroup_id"]
               and c.get("status", "active") == "active"]
    links = [dict(r) for r in db.execute("SELECT * FROM session_successors WHERE old_session_ref=? OR successor_ref=? ORDER BY old_session_ref", (owner, owner))]
    if (not chat or matches != [owner] or owner != row["caller_ref"] or not identity
            or account_id(identity) != row["account_id"] or chat.get("account") != row["account_alias"]
            or any(logical[k] != row[k] for k in ("project", "role", "workgroup_id"))
            or any(r["old_session_ref"] == owner for r in links)):
        raise ValueError("ROTATION_QUARANTINE_OWNER_CHANGED")
    binding = reg.get("projects", {}).get(row["project"], {}).get("bindings", {}).get(row["account_alias"])
    if not binding or not binding.get("profileId") or not re.search(r"g-p-[0-9a-f]{32}", binding.get("projectUrl") or ""):
        raise ValueError("ROTATION_QUARANTINE_OWNER_CHANGED")
    handoff = row["original_message"] or ""
    header = "\n".join(["[CHATBRIDGE ROLE HANDOFF v1]", "rotation_id: " + row["rotation_id"],
                        "logical_ref: " + logical["logical_ref"], "role: " + row["role"],
                        "next_epoch: " + str(logical["epoch"] + 1), ""])
    if (row["request_key"] != "rotation:" + row["rotation_id"] or row["task_id"] != "ROT-" + row["rotation_id"]
            or not row["message"].startswith(header) or hashlib.sha256(handoff.encode()).hexdigest() != row["payload_hash"]
            or logical["handoff_hash"] != row["payload_hash"]
            or db.execute("SELECT count(*) FROM operations WHERE rotation_id=?", (row["rotation_id"],)).fetchone()[0] != 1):
        raise ValueError("ROTATION_QUARANTINE_ORIGINAL_REQUIRED")
    busy = [dict(r) for r in db.execute("""SELECT * FROM operations WHERE
        (kind='rotation' AND project=? AND role=? AND coalesce(workgroup_id,'')=coalesce(?,'') AND status IN ('QUEUED','DISPATCHING'))
        OR (status='DISPATCHING' AND (session_ref=? OR (session_ref IS NULL AND caller_ref=?))) ORDER BY id""",
        (row["project"], row["role"], row["workgroup_id"], owner, owner))]
    if busy or image_session_reservations(db, {"accountId": row["account_id"], "conversationId": owner}):
        raise ValueError("ROTATION_QUARANTINE_BUSY")
    cp = latest_checkpoint(db, row["project"], row["role"], row["workgroup_id"])
    if not cp or cp["session_ref"] != owner:
        raise ValueError("ROTATION_QUARANTINE_CHECKPOINT_REQUIRED")
    reason = str(payload.get("reason") or "").strip()
    if not reason:
        raise ValueError("ROTATION_QUARANTINE_REASON_REQUIRED")
    return {"operation": dict(row), "logical": dict(logical), "registry": reg, "runtime": rt,
            "checkpoint": cp, "successors": links, "authority": authority, "reason": reason}


def rotation_quarantine(db, payload):
    if not payload.get("confirm"):
        snapshot = rotation_quarantine_context(db, payload)
        logical = snapshot["logical"]
        return {"state": "QUARANTINE_PREVIEW", "operationId": payload["operationId"],
                "rotationId": logical["rotation_id"], "logicalRef": logical["logical_ref"],
                "currentSessionRef": logical["current_session_ref"], "epoch": logical["epoch"],
                "deliveryStatus": "DELIVERY_UNKNOWN", "remoteExecutionStopped": None,
                "expected": rotation_digest(snapshot), "authority": snapshot["authority"],
                "checkpoint": snapshot["checkpoint"], "proposedState": "QUARANTINED"}
    if not payload.get("expected"):
        raise ValueError("ROTATION_QUARANTINE_EXPECTED_REQUIRED")
    begin_immediate(db)
    try:
        row = db.execute("SELECT * FROM operations WHERE id=?", (payload.get("operationId"),)).fetchone()
        if not row:
            raise ValueError("ROTATION_QUARANTINE_ORIGINAL_REQUIRED")
        authorize_control(db, payload.get("callerRef"), row["project"], False, row["workgroup_id"])
        if os.environ.get("CHAT_BRIDGE_FROM_SPACE") and not os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID"):
            raise ValueError("CONTROL_ORIGIN_REQUIRED")
        event_id = "rotation-quarantine:" + str(row["rotation_id"])
        prior = db.execute("SELECT * FROM management_events WHERE id=?", (event_id,)).fetchone()
        if prior:
            body = json.loads(prior["payload"])
            if (prior["kind"] != "ROTATION_QUARANTINE" or body.get("expected") != payload["expected"]
                    or body.get("operationId") != row["id"] or body.get("reason") != str(payload.get("reason") or "").strip()):
                raise ValueError("ROTATION_QUARANTINE_EVENT_CONFLICT")
            logical = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (body["logicalRef"],)).fetchone()
            db.commit()
            return {"eventId": event_id, "alreadyRecorded": True, "state": logical["state"],
                    "currentSessionRef": logical["current_session_ref"], "epoch": logical["epoch"], "deliveryStatus": row["status"]}
        snapshot = rotation_quarantine_context(db, payload)
        if rotation_digest(snapshot) != payload["expected"]:
            raise ValueError("ROTATION_QUARANTINE_PREVIEW_CHANGED")
        logical, now = snapshot["logical"], stamp()
        body = {"operationId": row["id"], "rotationId": row["rotation_id"], "logicalRef": logical["logical_ref"],
                "project": row["project"], "role": row["role"], "workgroupId": row["workgroup_id"],
                "currentSessionRef": logical["current_session_ref"], "epoch": logical["epoch"],
                "operationSha256": rotation_digest(dict(row)), "logicalBefore": logical,
                "checkpoint": snapshot["checkpoint"], "authority": snapshot["authority"],
                "expected": payload["expected"], "reason": snapshot["reason"],
                "deliveryUnknown": True, "remoteExecutionStopped": None}
        db.execute("INSERT INTO management_events(id,kind,scope,payload,created_at) VALUES (?,?,?,?,?)",
                   (event_id, "ROTATION_QUARANTINE", "project:" + row["project"], json.dumps(body, ensure_ascii=False), now))
        db.execute("UPDATE logical_sessions SET state='QUARANTINED',updated_at=? WHERE logical_ref=?", (now, logical["logical_ref"]))
        db.commit()
        return {"eventId": event_id, "state": "QUARANTINED", "currentSessionRef": logical["current_session_ref"],
                "epoch": logical["epoch"], "deliveryStatus": "DELIVERY_UNKNOWN", "remoteExecutionStopped": None}
    except Exception:
        db.rollback()
        raise

def rotation_prepare(db, payload):
    project = str(payload.get("project") or "").strip()
    role = str(payload.get("role") or "").strip()
    workgroup = str(payload.get("workgroupId") or "").strip() or None
    handoff = str(payload.get("handoff") or "").strip()
    if not project or not role:
        raise ValueError("project and role are required")
    if not handoff:
        handoff=checkpoint_handoff(latest_checkpoint(db,project,role,workgroup)) or ""
    if not handoff:
        raise ValueError("handoff required when no checkpoint exists")
    reg = registry(db)
    cfg = (reg.get("projects") or {}).get(project)
    if not cfg:
        raise ValueError("PROJECT_NOT_REGISTERED")
    logical_ref = str(payload.get("logicalRef") or (f"project:{project}:workgroup:{workgroup}:role:{role}" if workgroup else f"project:{project}:role:{role}"))
    current = current_controller_ref(db, reg, project, role, workgroup)
    if not current:
        raise ValueError("CURRENT_ROLE_SESSION_NOT_UNIQUE")
    old_chat = (reg.get("chats") or {}).get(current)
    if not old_chat:
        raise ValueError("CURRENT_ROLE_SESSION_NOT_REGISTERED")
    if not target_matches_task_scope({"project": project, "workgroupId": workgroup, "controllerSessionRef": current}, old_chat, reg):
        raise ValueError("ROTATION_WORKGROUP_MISMATCH")
    scopes = [dict(r) for r in db.execute("SELECT * FROM logical_sessions WHERE project=? AND role=? AND coalesce(workgroup_id,'')=coalesce(?,'') ORDER BY logical_ref", (project, role, workgroup))]
    existing = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (logical_ref,)).fetchone()
    if len(scopes) > 1 or scopes and scopes[0]["logical_ref"] != logical_ref or existing and (existing["project"], existing["role"], existing["workgroup_id"]) != (project, role, workgroup):
        raise ValueError("ROTATION_LOGICAL_SCOPE_MISMATCH")
    if existing and existing["state"] == "ROTATING":
        raise ValueError("ROTATION_ALREADY_PENDING")
    if existing and (existing["current_session_ref"] != current or existing["pending_session_ref"] or existing["state"] not in {"ACTIVE", "QUARANTINED"}):
        raise ValueError("ROTATION_CURRENT_OWNER_CHANGED")
    owners = [cid for cid, chat in reg.get("chats", {}).items() if
              (chat.get("project"), chat.get("role"), chat.get("workgroupId") or None) == (project, role, workgroup)
              and chat.get("status", "active") == "active"]
    if owners != [current]:
        raise ValueError("CURRENT_ROLE_SESSION_NOT_UNIQUE")
    event = rotation_quarantine_event(db, project, role, workgroup)
    cp = latest_checkpoint(db, project, role, workgroup)
    if event and (not existing or event["body"]["logicalRef"] != logical_ref):
        raise ValueError("ROTATION_QUARANTINE_LOGICAL_MISMATCH")
    if existing and existing["state"] == "QUARANTINED":
        if not event or payload.get("quarantineEvent") != event["id"]:
            raise ValueError("ROTATION_QUARANTINE_EVENT_REQUIRED")
        if (not cp or cp["session_ref"] != current
                or datetime.fromisoformat(cp["created_at"]) <= datetime.fromisoformat(event["createdAt"])
                or handoff != checkpoint_handoff(cp)):
            raise ValueError("ROTATION_QUARANTINE_FRESH_CHECKPOINT_REQUIRED")
    elif payload.get("quarantineEvent") and (not event or payload["quarantineEvent"] != event["id"]):
        raise ValueError("ROTATION_QUARANTINE_EVENT_MISMATCH")
    competing = [dict(r) for r in db.execute("SELECT * FROM operations WHERE kind='rotation' AND project=? AND role=? AND coalesce(workgroup_id,'')=coalesce(?,'') AND status IN ('QUEUED','DISPATCHING') ORDER BY id", (project, role, workgroup))]
    if competing:
        raise ValueError("ROTATION_ALREADY_PENDING")
    epoch = (existing["epoch"] if existing else 1)
    rotation_id = str(uuid.uuid4())
    handoff_hash = hashlib.sha256(handoff.encode()).hexdigest()
    requested_model = str(payload.get("model") or old_chat.get("model") or "Latest")
    requested_effort = normalize_effort(payload.get("effort") or old_chat.get("effort"))
    message = "\n".join([
        "[CHATBRIDGE ROLE HANDOFF v1]",
        f"rotation_id: {rotation_id}",
        f"logical_ref: {logical_ref}",
        f"role: {role}",
        f"next_epoch: {epoch+1}",
        "",
        handoff,
        "",
        "Before doing business work: read the installed ChatBridge/controller Skills, verify role/tools/host/model, then acknowledge:",
        f"chat-bridge control rotation-ack --rotation {rotation_id} --caller-ref <successor-session-ref> --message <verification-summary>",
        "Use this successor conversation's actual sessionRef or persistent CID in its own URL; never use the predecessor or a local Codex thread ID.",
        "Do not replay completed work before acknowledgement.",
        "[/CHATBRIDGE ROLE HANDOFF]",
    ])
    identity = ((reg.get("accounts") or {}).get(old_chat.get("account")) or {}).get("identity")
    if not identity:
        raise ValueError("ROTATION_ACCOUNT_UNVERIFIED")
    operation_id, now = str(uuid.uuid4()), stamp()
    task_id = "ROT-" + rotation_id
    key = "rotation:" + rotation_id
    begin_immediate(db)
    try:
        locked = [dict(r) for r in db.execute("SELECT * FROM logical_sessions WHERE project=? AND role=? AND coalesce(workgroup_id,'')=coalesce(?,'') ORDER BY logical_ref", (project, role, workgroup))]
        busy = [dict(r) for r in db.execute("SELECT * FROM operations WHERE kind='rotation' AND project=? AND role=? AND coalesce(workgroup_id,'')=coalesce(?,'') AND status IN ('QUEUED','DISPATCHING') ORDER BY id", (project, role, workgroup))]
        if (registry(db) != reg or locked != scopes or busy != competing
                or latest_checkpoint(db, project, role, workgroup) != cp
                or rotation_quarantine_event(db, project, role, workgroup) != event):
            raise ValueError("ROTATION_PREPARE_CAS_CHANGED")
        authorize_control(db, payload.get("callerRef"), project, False, workgroup)
        if os.environ.get("CHAT_BRIDGE_FROM_SPACE") and not os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID"):
            raise ValueError("CONTROL_ORIGIN_REQUIRED")
        db.execute("""INSERT INTO logical_sessions(
            logical_ref,project,role,current_session_ref,workgroup_id,epoch,state,pending_session_ref,handoff_hash,rotation_id,updated_at)
            VALUES (?,?,?,?,?,?,'ROTATING',NULL,?,?,?)
            ON CONFLICT(logical_ref) DO UPDATE SET project=excluded.project,role=excluded.role,
              current_session_ref=excluded.current_session_ref,state='ROTATING',pending_session_ref=NULL,
              handoff_hash=excluded.handoff_hash,rotation_id=excluded.rotation_id,updated_at=excluded.updated_at""",
            (logical_ref,project,role,current,workgroup,epoch,handoff_hash,rotation_id,now))
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,requested_model,requested_effort,
            resource_policy_version,workgroup_id,placement_key,original_message,force_new,rotation_id,event_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,handoff_hash,"QUEUED",project,old_chat["account"],account_id(identity),
             current,None,role,message,task_id,now,now,time.time(),"rotation",requested_model,requested_effort,
             "rotation-v1",workgroup,logical_placement_key(project,workgroup,role,rotation_id),handoff,1,rotation_id,event["id"] if event else None))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"rotationId": rotation_id, "logicalRef": logical_ref, "project": project, "role": role, "workgroupId": workgroup,
            "currentSessionRef": current, "operationId": operation_id, "state": "ROTATING", "nextEpoch": epoch+1}


def rotation_ack(db, payload, config, state):
    rotation_id = str(payload.get("rotationId") or "").strip()
    message = str(payload.get("message") or "").strip()
    row = db.execute("SELECT * FROM logical_sessions WHERE rotation_id=?", (rotation_id,)).fetchone()
    if not row or row["state"] != "ROTATING":
        raise ValueError("ROTATION_NOT_PENDING")
    successor = row["pending_session_ref"]
    if not successor:
        raise ValueError("ROTATION_SUCCESSOR_NOT_CREATED")
    reg = registry(db)
    successor_chat = (reg.get("chats") or {}).get(successor)
    if not successor_chat or successor_chat.get("project") != row["project"]:
        raise ValueError("ROTATION_SUCCESSOR_NOT_REGISTERED")
    if not target_matches_task_scope({"project": row["project"], "workgroupId": row["workgroup_id"], "controllerSessionRef": row["current_session_ref"]}, successor_chat, reg):
        raise ValueError("ROTATION_SUCCESSOR_WORKGROUP_MISMATCH")
    identity = ((reg.get("accounts") or {}).get(successor_chat.get("account")) or {}).get("identity")
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin and (not identity or account_id(identity) != origin):
        raise ValueError("ROTATION_ACK_ORIGIN_MISMATCH")
    recovery = successor_chat.get("rotationRecovery")
    if recovery:
        if not origin or payload.get("callerRef") != successor or not message:
            raise ValueError("ROTATION_RECOVERY_ACK_SUCCESSOR_REQUIRED")
        if (recovery.get("rotationId") != rotation_id or recovery.get("candidate") != successor
                or recovery.get("predecessor") != row["current_session_ref"] or recovery.get("epoch") != row["epoch"]
                or recovery.get("logicalRef") != row["logical_ref"] or recovery.get("accountId") != account_id(identity)
                or successor_chat.get("status") != "pending-rotation"):
            raise ValueError("ROTATION_RECOVERY_ACK_PROOF_CHANGED")
    event = rotation_quarantine_event(db, row["project"], row["role"], row["workgroup_id"])
    operations = [dict(r) for r in db.execute("SELECT * FROM operations WHERE rotation_id=? ORDER BY id", (rotation_id,))]
    if event:
        if not origin or payload.get("callerRef") != successor or not message:
            raise ValueError("ROTATION_QUARANTINE_ACK_SUCCESSOR_REQUIRED")
        op = operations[0] if len(operations) == 1 else None
        header = "\n".join(["[CHATBRIDGE ROLE HANDOFF v1]", "rotation_id: " + rotation_id,
                            "logical_ref: " + row["logical_ref"], "role: " + row["role"],
                            "next_epoch: " + str(row["epoch"] + 1), ""])
        if (not op or op["event_id"] != event["id"] or event["body"]["logicalRef"] != row["logical_ref"]
                or op["kind"] != "rotation" or not op["force_new"] or op["status"] != "SENT"
                or op["session_ref"] != successor or op["caller_ref"] != row["current_session_ref"]
                or (op["project"], op["role"], op["workgroup_id"]) != (row["project"], row["role"], row["workgroup_id"])
                or op["account_alias"] != successor_chat.get("account") or op["account_id"] != account_id(identity)
                or successor_chat.get("role") != row["role"] or successor_chat.get("status") != "pending-rotation"
                or not op["message"].startswith(header) or op["payload_hash"] != row["handoff_hash"]):
            raise ValueError("ROTATION_QUARANTINE_ACK_PROOF_CHANGED")
        active = [cid for cid, chat in reg.get("chats", {}).items() if
                  (chat.get("project"), chat.get("role"), chat.get("workgroupId") or None) == (row["project"], row["role"], row["workgroup_id"])
                  and chat.get("status", "active") == "active"]
        pending = [cid for cid, chat in reg.get("chats", {}).items() if
                   (chat.get("project"), chat.get("role"), chat.get("workgroupId") or None) == (row["project"], row["role"], row["workgroup_id"])
                   and chat.get("status") == "pending-rotation"]
        if active != [row["current_session_ref"]] or pending != [successor]:
            raise ValueError("ROTATION_ACK_ROLE_NOT_UNIQUE")
    old_ref = row["current_session_ref"]
    base = reg
    next_reg = json.loads(json.dumps(reg))
    old = (next_reg.get("chats") or {}).get(old_ref)
    new = (next_reg.get("chats") or {}).get(successor)
    if old:
        old["status"] = "retired"
        old["retiredAt"] = stamp()
        old["successorSessionRef"] = successor
    if new:
        new["status"] = "active"
        new["role"] = row["role"]
        new["logicalRef"] = row["logical_ref"]
        new["generation"] = row["epoch"] + 1
        new["predecessorSessionRef"] = old_ref
    now = stamp()
    runtime_row=db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
    next_rt=json.loads(runtime_row[0]) if runtime_row else {"version":2,"projects":{},"tasks":{},"sessions":{}}
    runtime_before = runtime_row[0] if runtime_row else None
    resume_ops=[]
    for task_id,live in (next_rt.get("tasks") or {}).items():
        if live.get("sessionId")!=old_ref or str(live.get("blockedReason") or "")!="CONTEXT_EXHAUSTED":
            continue
        if str(live.get("status") or "").upper()!="BLOCKED":
            continue
        caller=live.get("controllerSessionRef") or live.get("replyToSessionRef")
        if not caller or caller==old_ref:
            # A root/controller Chat may own its own orchestration turn; do not replay it automatically.
            continue
        live["sessionId"]=successor
        live["account"]=successor_chat.get("account")
        live["status"]="DISPATCHED"
        live["blockedReason"]=None
        live["rotationId"]=rotation_id
        live["rotatedFromSessionRef"]=old_ref
        live["rotatedAt"]=now
        live["rotationResumePending"]=True
        live["updatedAt"]=now
        op_id=str(uuid.uuid4())
        op_key="rotation-resume:"+rotation_id+":"+str(task_id)
        resume_message="\n".join([
            "[ROTATION RESUME]",
            "task_id: "+str(task_id),
            "Continue only the unfinished work from the predecessor conversation.",
            "Reconcile the checkpoint and durable GitHub/task state before any side effect.",
            "Do not replay work that is already complete.",
            "[/ROTATION RESUME]",
        ])
        requested_model=live.get("requestedModel") or successor_chat.get("model") or "Latest"
        requested_effort=normalize_effort(live.get("requestedEffort") or successor_chat.get("effort"))
        resume_ops.append((op_id,op_key,hashlib.sha256(resume_message.encode()).hexdigest(),
                           "QUEUED",row["project"],successor_chat["account"],account_id(identity),caller,successor,
                           row["role"],resume_message,str(task_id),now,now,time.time(),"dispatch",
                           requested_model,requested_effort,live.get("resourcePolicyVersion") or "rotation-v1",
                           live.get("workgroupId"),live.get("affinityKey"),None,resume_message))
    begin_immediate(db)
    try:
        current_row = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (row["logical_ref"],)).fetchone()
        current_rt = db.execute("SELECT payload FROM documents WHERE kind='runtime'").fetchone()
        if (not current_row or dict(current_row) != dict(row) or registry(db) != base
                or (current_rt[0] if current_rt else None) != runtime_before
                or [dict(r) for r in db.execute("SELECT * FROM operations WHERE rotation_id=? ORDER BY id", (rotation_id,))] != operations
                or rotation_quarantine_event(db, row["project"], row["role"], row["workgroup_id"]) != event):
            raise ValueError("ROTATION_ACK_CAS_CHANGED")
        db.execute("UPDATE documents SET payload=? WHERE kind='registry'",(json.dumps(next_reg,ensure_ascii=False),))
        db.execute("UPDATE documents SET payload=? WHERE kind='runtime'",(json.dumps(next_rt,ensure_ascii=False),))
        db.execute("""INSERT OR REPLACE INTO session_successors(
            old_session_ref,logical_ref,successor_ref,epoch,committed_at) VALUES (?,?,?,?,?)""",
            (old_ref,row["logical_ref"],successor,row["epoch"]+1,now))
        db.execute("""UPDATE logical_sessions SET current_session_ref=?,epoch=epoch+1,state='ACTIVE',
                      pending_session_ref=NULL,rotation_id=NULL,updated_at=? WHERE logical_ref=?""",
                   (successor,now,row["logical_ref"]))
        for values in resume_ops:
            db.execute("""INSERT INTO operations(
                id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
                role,message,task_id,created_at,updated_at,not_before,kind,requested_model,requested_effort,
                resource_policy_version,workgroup_id,affinity_key,placement_key,original_message)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",values)
        db.commit()
    except Exception:
        db.rollback()
        raise
    # Compatibility JSON is repaired from committed SQLite state; failure here must not undo ownership.
    projection_ok=True
    try:
        subprocess.run([sys.executable,str(pathlib.Path(__file__).with_name("state-store.py")),"get",
                        str(config),str(state),"registry"],check=True,stdout=subprocess.DEVNULL,timeout=20)
    except Exception:
        projection_ok=False
    return {"rotationId": rotation_id, "logicalRef": row["logical_ref"], "oldSessionRef": old_ref,
            "currentSessionRef": successor, "epoch": row["epoch"]+1, "state": "ACTIVE", "ack": message,
            "projectionRepaired":projection_ok,
            "resumedTasks":[values[11] for values in resume_ops],
            "resumeOperationIds":[values[0] for values in resume_ops]}


BRIDGE_TERM_GRACE_SEC = 7  # Covers ego-runner's 2s TERM + 2s drain + 2s reap.
TASK_RECORD_TIMEOUT_SEC = 30
_bridge_interrupted = None
_bridge_cancellation_active = False


@contextmanager
def bridge_cancellation():
    """Latch main-thread signals until every worker has captured/reaped its child."""
    global _bridge_interrupted, _bridge_cancellation_active
    if threading.current_thread() is not threading.main_thread() or _bridge_cancellation_active:
        yield
        return
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    _bridge_interrupted = None
    _bridge_cancellation_active = True

    def interrupt(signum, _frame):
        global _bridge_interrupted
        _bridge_interrupted = _bridge_interrupted or signum

    try:
        for sig in previous:
            signal.signal(sig, interrupt)
        yield
    finally:
        interrupted = _bridge_interrupted
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        _bridge_interrupted = None
        _bridge_cancellation_active = False
        if interrupted is not None:
            raise SystemExit(128 + interrupted)


def bridge_timeout():
    # Match bin/chat-bridge's default, empty-value fallback and legal range.
    try:
        seconds = float(os.environ.get("CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC") or "180")
    except ValueError:
        raise ValueError("CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC must be between 30 and 600") from None
    if not 30 <= seconds <= 600:  # Also rejects NaN and infinity.
        raise ValueError("CHAT_BRIDGE_EGO_CLIENT_TIMEOUT_SEC must be between 30 and 600")
    return seconds + 60  # Wrapper startup/pacing allowance, not a generation retry.


def interrupted_claim_timeout():
    # A new-session dispatch can also perform task registration before finish().
    # Both child teardowns and a DB/finish allowance must fit inside the lease.
    return max(300, bridge_timeout() + TASK_RECORD_TIMEOUT_SEC
               + 2 * (BRIDGE_TERM_GRACE_SEC + 4) + 60)


def stop_bridge(process):
    """Reap only the process group created by run_bridge, not arbitrary children."""
    deadline = time.monotonic() + BRIDGE_TERM_GRACE_SEC
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except PermissionError as error:
        error.cleanup = {"errno": error.errno, "phase": "TERM", "leaderPid": process.pid, "groupId": process.pid, "leaderReturnCode": process.returncode}
        raise
    try:
        stdout, stderr = process.communicate(timeout=BRIDGE_TERM_GRACE_SEC)
    except subprocess.TimeoutExpired as pending:
        stdout, stderr = pending.output, pending.stderr
    # EOF or an exited/reaped leader says nothing about DEVNULL descendants.
    # Do not KILL early either: an owned runner may be cleaning its separate group.
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
        return pending.output or stdout, pending.stderr or stderr


def delivery_attempt_module():
    # Load from this exact installed release, not the caller's Python search path.
    import importlib.util
    spec = importlib.util.spec_from_file_location("chat_bridge_delivery_attempt", pathlib.Path(__file__).with_name("delivery_attempt.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_bridge(args, timeout=None, capture=True, attempt=None):
    timeout = bridge_timeout() if timeout is None else timeout
    evidence = delivery_attempt_module() if attempt else None
    with bridge_cancellation():
        if _bridge_interrupted is not None:
            raise InterruptedError("BRIDGE_CANCELLED")
        process, timed_out, original_error, cleanup_error = None, False, None, None
        stdout, stderr, files, references = None, None, {}, {}
        child_env = None
        try:
            if evidence:
                if not capture:
                    raise ValueError("DELIVERY_EVIDENCE_REQUIRES_CAPTURE")
                for name in ("stdout", "stderr"):
                    files[name] = evidence.create_private_file(pathlib.Path(attempt["directory"]) / (name + ".bin"))
                evidence.record(attempt, "worker-starting", {"timeoutSec": timeout,
                    "command": pathlib.Path(args[0]).name,
                    "argvSha256": hashlib.sha256(json.dumps(args, ensure_ascii=False).encode()).hexdigest()})
                child_env = dict(os.environ, CHAT_BRIDGE_DELIVERY_ATTEMPT=json.dumps(attempt))
            # The production evidence path uses files: parent loss does not discard
            # pipe buffers. The legacy no-context path retains its prior contract.
            process = subprocess.Popen(args, stdout=files.get("stdout") or (subprocess.PIPE if capture else None),
                                       stderr=files.get("stderr") or (subprocess.PIPE if capture else None),
                                       text=True, errors="replace", start_new_session=True, env=child_env)
            if evidence:
                evidence.record(attempt, "worker-started", {"leaderPid": process.pid, "groupId": process.pid,
                                                          "timeoutSec": timeout})
            deadline = time.monotonic() + timeout
            while _bridge_interrupted is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    stdout, stderr = process.communicate(timeout=min(.2, remaining))
                    break
                except subprocess.TimeoutExpired as pending:
                    stdout, stderr = pending.output, pending.stderr
                    for stream in files.values():
                        os.fsync(stream.fileno())
        except OSError as error:
            original_error = error
            error.bridge_phase = "SPAWN" if process is None else "CAPTURE"
        finally:
            if process is not None:
                try:
                    stdout, stderr = stop_bridge(process)
                except PermissionError as error:
                    cleanup_error = error
                    stdout = getattr(error, "output", None) or stdout
                    stderr = getattr(error, "stderr", None) or stderr
            if evidence:
                try:
                    for name, stream in files.items():
                        try:
                            os.fsync(stream.fileno())
                        finally:
                            stream.close()
                        text, references[name] = evidence.read_capture(pathlib.Path(attempt["directory"]) / (name + ".bin"))
                        if name == "stdout":
                            stdout = text
                        else:
                            stderr = text
                    evidence.record(attempt, "worker-ended", {
                        "leaderPid": process.pid if process else None,
                        "leaderReturnCode": process.returncode if process else None,
                        "timedOut": timed_out, "interrupted": _bridge_interrupted,
                        "localCleanupAttempted": process is not None, "remoteExecutionStopped": False,
                        "cleanup": getattr(cleanup_error, "cleanup", None), "streams": references,
                        "errorType": type(original_error).__name__ if original_error else None})
                except (OSError, ValueError) as error:
                    if original_error is None:
                        original_error = error
                finally:
                    for stream in files.values():
                        if not stream.closed:
                            stream.close()
        if cleanup_error is not None:
            error = original_error or (subprocess.TimeoutExpired("chat-bridge", timeout) if timed_out else cleanup_error)
            error.output, error.stderr = stdout, stderr
            error.cleanup, error.timed_out = cleanup_error.cleanup, timed_out
            raise error from None
        if original_error is not None:
            original_error.output, original_error.stderr = stdout, stderr
            raise original_error
        if _bridge_interrupted is not None:
            raise InterruptedError("BRIDGE_CANCELLED")
        if timed_out:
            # Captured success is retained but cannot upgrade an expired send.
            raise subprocess.TimeoutExpired("chat-bridge", timeout, output=stdout, stderr=stderr) from None
        return subprocess.CompletedProcess(args, process.returncode, stdout, stderr)


def worker_diagnostic(returncode, stderr, phase, error=None, stdout=None):
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    # Private SQLite diagnostics only; public operation/queue responses omit result.
    worker = {"phase": phase, "exitCode": returncode, "stderrTail": (stderr or "")[-2048:]}
    cleanup = getattr(error, "cleanup", None)
    timed_out = isinstance(error, subprocess.TimeoutExpired) or getattr(error, "timed_out", False)
    receipt_stderr = stderr or ""
    if cleanup is None:
        for line in reversed(worker["stderrTail"].splitlines()):
            try:
                detail = json.loads(line)
            except ValueError:
                continue
            if isinstance(detail, dict) and detail.get("status") == "EGO_RUNNER_ERROR" and "cleanup" in detail:
                cleanup, timed_out = detail["cleanup"], detail.get("timedOut") is True
                receipt_stderr = receipt_stderr[:receipt_stderr.rfind(line)]
                break
    if type(getattr(error, "errno", None)) is int:
        worker["errno"] = error.errno
    if getattr(error, "bridge_phase", None) in ("SPAWN", "CAPTURE"):
        worker["errorPhase"] = error.bridge_phase
    if isinstance(cleanup, dict):
        worker["cleanup"] = {key: cleanup[key] for key in ("errno", "leaderPid", "groupId", "leaderReturnCode")
                             if key in cleanup and (type(cleanup[key]) is int or cleanup[key] is None)}
        if cleanup.get("phase") in ("TERM", "KILL"):
            worker["cleanup"]["phase"] = cleanup["phase"]
        worker["timedOut"] = timed_out is True
    stdout = getattr(error, "output", None) if stdout is None else stdout
    if isinstance(stdout, bytes):
        stdout = stdout.decode("utf-8", errors="replace")
    receipt = parse_worker_receipt(subprocess.CompletedProcess([], 1, stdout or "", receipt_stderr))
    if receipt and receipt.get("deliveryStage") in ("PRE_SEND", "SEND_ATTEMPTED"):
        worker["capturedReceipt"] = {"deliveryStage": receipt["deliveryStage"]}
        if re.fullmatch(r"[A-Z0-9_]{1,100}", str(receipt.get("code") or "")):
            worker["capturedReceipt"]["code"] = receipt["code"]
    result = {"worker": worker}
    # Full parsed witness is private diagnostic evidence, not a delivery upgrade.
    # In particular, timeout used to throw this away before uncertain_new_session.
    if receipt and receipt.get("deliveryStage") == "SEND_ATTEMPTED" and isinstance(receipt.get("nativeWitness"), dict):
        result["nativeWitness"] = receipt["nativeWitness"]
    return result


def claim(db):
    if _bridge_interrupted is not None:
        return None
    begin_immediate(db)
    try:
        db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_INTERRUPTED',updated_at=? WHERE status='DISPATCHING' AND claimed_at<?",
                   (stamp(), time.time() - interrupted_claim_timeout()))
        row = db.execute("""SELECT * FROM operations AS candidate WHERE status='QUEUED' AND not_before<=?
            AND NOT EXISTS (SELECT 1 FROM operations AS active WHERE active.status='DISPATCHING' AND active.account_id=candidate.account_id)
            ORDER BY CASE candidate.kind WHEN 'management' THEN 0 WHEN 'callback' THEN 1 WHEN 'rotation' THEN 2 ELSE 3 END,
                     created_at,id LIMIT 1""", (time.time(),)).fetchone()
        queued = row
        if row:
            db.execute("UPDATE operations SET status='DISPATCHING',attempts=attempts+1,claimed_at=?,updated_at=?,reason=NULL WHERE id=?",
                       (time.time(), stamp(), row["id"]))
            row = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
        # Cancellation may arrive while BEGIN waits for another SQLite writer.
        # Nothing was spawned yet: leave this uncommitted claim queued, not UNKNOWN.
        if _bridge_interrupted is not None:
            db.rollback()
            return None
        db.commit()
        if row and _bridge_interrupted is not None:
            # COMMIT can also latch cancellation; this claim has spawned nothing.
            begin_immediate(db)
            db.execute("""UPDATE operations SET status='QUEUED',attempts=?,claimed_at=?,reason=?,updated_at=?
                          WHERE id=? AND status='DISPATCHING' AND attempts=? AND claimed_at=?""",
                       (queued["attempts"], queued["claimed_at"], queued["reason"], stamp(),
                        row["id"], row["attempts"], row["claimed_at"]))
            db.commit()
            return None
        return row
    except Exception:
        db.rollback()
        raise


def uncertain_new_session(db, row, result):
    """Keep creation evidence on its operation; it is never a routing session."""
    witness = (result or {}).get("nativeWitness") or {}
    post = witness.get("postSend") or {}
    reg = registry(db)
    identity = ((reg.get("accounts") or {}).get(row["account_alias"]) or {}).get("identity")
    binding = ((reg.get("projects") or {}).get(row["project"]) or {}).get("bindings", {}).get(row["account_alias"]) or {}
    project_key = lambda value: (re.search(r"g-p-[0-9a-f]{32}", str(value or ""), re.I) or [None])[0]
    project = project_key(binding.get("projectId") or binding.get("projectUrl"))
    observed = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/c/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/?", str(post.get("afterUrl") or ""), re.I)
    scoped = bool(identity and account_id(identity) == row["account_id"] and project and observed
                  and observed[1].lower() == project.lower()
                  and project_key(post.get("targetUrl")) == project_key(binding.get("projectUrl")))
    safe_id = lambda value: value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", value, re.I) else None
    safe_hash = lambda value: value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value, re.I) else None
    context = post.get("newSessionContext") or {}
    return {"format": "uncertain-new-session-v1", "operationId": row["id"], "taskId": row["task_id"],
            "requestKey": row["request_key"], "payloadHash": row["payload_hash"],
            "messageSha256": hashlib.sha256(row["message"].encode()).hexdigest(),
            "project": row["project"], "account": row["account_alias"], "accountId": row["account_id"],
            "callerRef": row["caller_ref"], "role": row["role"], "workgroupId": row["workgroup_id"],
            "affinityKey": row["affinity_key"], "requestedModel": row["requested_model"], "requestedEffort": row["requested_effort"],
            "observedConversationId": observed[2] if scoped else None, "observedUrl": post.get("afterUrl") if scoped else None,
            "lastUserId": safe_id(post.get("lastUserId")), "sourceMessageId": safe_id(post.get("sourceMessageId")),
            "nativeBodyHash": safe_hash(witness.get("bodyHash")), "sourceBodyHash": safe_hash(post.get("sourceBodyHash")),
            "observedAt": post.get("observedAt") if isinstance(post.get("observedAt"), str) and len(post["observedAt"]) <= 40 else None,
            "page": context.get("page") if isinstance(context.get("page"), str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", context["page"]) else None,
            "spaceId": context.get("spaceId") if type(context.get("spaceId")) is int else None,
            "preSendIdentityVerified": bool(identity and account_id(identity) == row["account_id"] and witness.get("accountIdentityHash") == hashlib.sha256(identity.encode()).hexdigest()),
            "postSendIdentityVerified": False, "deliveryConfirmed": False, "routable": False,
            "capturedAt": stamp()}


def finish(db, row, status, reason=None, retry_after=0, result=None, session_ref=None, pre_send_failure=False):
    begin_immediate(db)
    try:
        if isinstance(row, dict) and row.get("_attemptEvidence"):
            result = {**(result or {}), "attemptEvidence": row["_attemptEvidence"]}
        if status == 'DELIVERY_UNKNOWN' and row['kind'] in {'dispatch', 'rotation'} and not row['session_ref'] and not session_ref:
            result = dict(result or {})
            result['newSession'] = uncertain_new_session(db, row, result)
        changed = db.execute("""UPDATE operations SET status=?,reason=?,not_before=?,updated_at=?,result=?,session_ref=coalesce(?,session_ref),claimed_at=NULL,
                      pre_send_failures=pre_send_failures+?
                      WHERE id=? AND status='DISPATCHING' AND attempts=? AND claimed_at IS ?""",
                   (status, reason, time.time() + retry_after, stamp(), json.dumps(result) if result is not None else None, session_ref, int(pre_send_failure), row["id"], row["attempts"], row["claimed_at"]))
        updated = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
        if changed.rowcount != 1:
            db.commit()
            return response(updated)
        if row["kind"] == "management" and row["event_id"]:
            delivery_status = "DELIVERED" if status == "SENT" else status
            db.execute("""UPDATE management_deliveries SET status=?,operation_id=?,updated_at=?
                          WHERE event_id=? AND target_ref=?""",
                       (delivery_status,row["id"],stamp(),row["event_id"],row["session_ref"]))
        if row["kind"] == "callback" and row["event_id"] and str(row["event_id"]).startswith("result:"):
            callback_status = "DELIVERED" if status == "SENT" else status
            db.execute("""UPDATE task_results SET callback_status=?,callback_delivered_at=CASE WHEN ?='DELIVERED' THEN ? ELSE callback_delivered_at END
                          WHERE event_id=?""",(callback_status,callback_status,stamp(),row["event_id"]))
        if row["kind"] == "rotation" and status == "SENT":
            target = session_ref or (updated["session_ref"] if updated else None)
            if target:
                db.execute("""UPDATE logical_sessions SET pending_session_ref=?,updated_at=?
                              WHERE rotation_id=? AND state='ROTATING'""",
                           (target,stamp(),row["rotation_id"]))
        db.commit()
        return response(updated)
    except Exception:
        db.rollback()
        raise


def parse_worker_receipt(completed):
    streams = (completed.stderr or "", completed.stdout or "") if completed.returncode else (completed.stdout or "", completed.stderr or "")
    def unique_object(pairs):
        value = dict(pairs)
        if len(value) != len(pairs):
            raise ValueError("DUPLICATE_RECEIPT_FIELD")
        return value
    decoder, selected = json.JSONDecoder(object_pairs_hook=unique_object), None
    for stream in streams:
        text = stream.strip()
        consumed = 0
        # Decode only line-start JSON, skipping its nested values and diagnostic prose.
        for start in re.finditer(r'(?m)^[ \t]*(?:\[error\] )?(?=\{|\[\s*(?:[\{\["0-9-]|\]|true\b|false\b|null\b))', text):
            if start.start() < consumed:
                continue
            try:
                value, consumed = decoder.raw_decode(text, start.end())
            except ValueError:
                return None
            if not isinstance(value, dict):
                continue
            if value.get("status") == "EGO_RUNNER_ERROR" and "cleanup" in value:
                return None  # A captured pre-send/success receipt cannot override failed cleanup.
            if any(key in value and not isinstance(value[key], bool) for key in ("ok", "delivered", "stopped", "interruptRequested", "cancelled")):
                continue
            if "deliveryStage" in value and value["deliveryStage"] not in ("PRE_SEND", "SEND_ATTEMPTED"):
                continue
            ok, code = value.get("ok"), value.get("code")
            if ok is False:
                if any(value.get(key) is True for key in ("delivered", "stopped", "interruptRequested", "cancelled")):
                    continue
                if isinstance(code, str) and code in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"}:
                    delay = value.get("retryAfterSec")
                    valid = value.get("status") in ("DEFERRED", "COOLDOWN") and type(delay) in (int, float) and 0 < delay < float("inf")
                else:
                    valid = isinstance(code, str) and bool(code) and value.get("deliveryStage") in ("PRE_SEND", "SEND_ATTEMPTED")
            elif "delivered" in value:
                valid = (ok is None or ok is True) and isinstance(value["delivered"], bool)
            elif "matches" in value:
                valid = ok is True and isinstance(value["matches"], list)
            elif value.get("format") == "operation-native-observation-v1":
                valid = ok is True and value.get("messageSent") is False and isinstance(value.get("userMessages"), list)
            elif "nativeTarget" in value:
                target = value["nativeTarget"]
                valid = ok is True and isinstance(target, dict) and all(isinstance(target.get(key), str) and target[key]
                        for key in ("host", "threadId", "cwd", "socket"))
            elif "interruptRequested" in value or "cancelled" in value:
                valid = ok is True and isinstance(value.get("turnId"), str) and bool(value["turnId"]) and any(
                        isinstance(value.get(key), bool) for key in ("interruptRequested", "cancelled"))
            elif "id" in value:
                valid = isinstance(value["id"], str) and bool(value["id"]) and (ok is True or (ok is None and all(
                        isinstance(value.get(key), str) and value[key] for key in ("project", "account", "url"))))
            else:
                valid = (ok is None or ok is True) and isinstance(value.get("stopped"), bool)
            if not valid:
                continue
            if selected is not None and selected != value:
                return None  # Conflicting receipts cannot prove a send or a safe retry.
            if selected is None:
                selected = value  # Keep the existing stdout/stderr preference for matching receipts.
    return selected


def pre_send_retry_after(row, receipt):
    """Retry only UI readiness failures proven to precede the send control."""
    if not receipt or receipt.get("deliveryStage") != "PRE_SEND":
        return None
    attempt = int(row["pre_send_failures"] or 0) + 1
    if attempt >= PRE_SEND_RETRY_LIMIT:
        return None
    code = str(receipt.get("code") or "").strip().upper()
    retryable = (
        code in {"MODEL_MENU_NOT_READY", "MODEL_SELECTOR_NOT_READY", "EFFORT_SELECTOR_NOT_READY",
                 "CONVERSATION_UI_NOT_READY", "PROJECT_UI_NOT_READY"}
        or code.startswith("CONVERSATION_REATTACH_FAILED")
        or code.startswith("CONVERSATION UI DID NOT BECOME READY")
        or code.startswith("PROJECT UI DID NOT BECOME READY")
        or code.startswith("MODEL/EFFORT BUTTON ")
        or code.startswith("THINKING EFFORT SLIDER ")
        or code.startswith("REQUESTED THINKING LEVEL ")
        or code.startswith("MODEL_MENU_")
        or code.startswith("EFFORT_")
    )
    if not retryable:
        return None
    return min(PRE_SEND_RETRY_MAX_SEC, PRE_SEND_RETRY_INITIAL_SEC * (2 ** max(0, attempt - 1)))


def retired_management_successor(db, row):
    """Return lifecycle evidence for an obsolete management target.

    A retired controller cannot provide a useful read-back target.  Only a
    committed successor for the same project may supersede a management
    delivery; ordinary dispatch/callback UNKNOWN records still require Chat
    evidence.
    """
    if row["kind"] != "management" or not row["session_ref"]:
        return None
    reg = registry(db)
    old = (reg.get("chats") or {}).get(row["session_ref"])
    if not old or old.get("status") != "retired":
        return None
    successor_ref = resolve_successor(db, row["session_ref"])
    successor = (reg.get("chats") or {}).get(successor_ref) if successor_ref else None
    if not successor or successor.get("status", "active") != "active" or successor.get("project") != row["project"]:
        return None
    link = db.execute("SELECT logical_ref,epoch,committed_at FROM session_successors WHERE old_session_ref=?",
                      (row["session_ref"],)).fetchone()
    if not link:
        return None
    return {
        "oldSessionRef": row["session_ref"],
        "successorSessionRef": successor_ref,
        "logicalRef": link["logical_ref"],
        "epoch": link["epoch"],
        "committedAt": link["committed_at"],
        "oldStatus": old.get("status"),
        "successorStatus": successor.get("status"),
        "project": row["project"],
        "eventId": row["event_id"],
    }



def recovery_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def observation_context(db, operation_id, candidate=None):
    """Local identity anchor only. No runtime fabrication or delivery decision."""
    if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("OBSERVATION_HOST_LOCAL_REQUIRED")
    row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
    if not row or row["status"] != "DELIVERY_UNKNOWN" or row["native_target"]:
        raise ValueError("OBSERVATION_REQUIRES_UNKNOWN_BROWSER_OPERATION")
    reg = registry(db)
    identity = ((reg.get("accounts") or {}).get(row["account_alias"]) or {}).get("identity")
    binding = ((reg.get("projects") or {}).get(row["project"]) or {}).get("bindings", {}).get(row["account_alias"])
    if not identity or account_id(identity) != row["account_id"] or not binding:
        raise ValueError("OBSERVATION_ACCOUNT_PROJECT_MISMATCH")
    project_id = (re.search(r"g-p-[0-9a-f]{32}", binding.get("projectUrl") or "") or [None])[0]
    session = row["session_ref"]
    if candidate:
        if row["kind"] != "rotation" or session:
            raise ValueError("OBSERVATION_CANDIDATE_REQUIRES_UNBOUND_ROTATION")
        session = candidate
    if not session or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", session) or not project_id:
        raise ValueError("OBSERVATION_PERSISTENT_SESSION_REQUIRED")
    chat = (reg.get("chats") or {}).get(session)
    if row["session_ref"] and not chat:
        raise ValueError("OBSERVATION_SESSION_NOT_REGISTERED")
    if chat and (chat.get("project") != row["project"] or chat.get("account") != row["account_alias"]
                 or chat.get("id") != session):
        raise ValueError("OBSERVATION_REGISTRY_IDENTITY_MISMATCH")
    anchor = recovery_digest({"operation":dict(row), "registry":reg})
    return {"operationId":row["id"], "kind":row["kind"], "taskId":row["task_id"],
            "project":row["project"], "account":row["account_alias"], "accountId":row["account_id"],
            "sessionRef":session, "projectId":project_id, "binding":binding, "accountIdentity":identity,
            "url":"https://chatgpt.com/g/" + project_id + "/c/" + session, "anchor":anchor}



class OperationObservationError(ValueError):
    """Read-only failure receipt; never changes the original delivery outcome."""
    def __init__(self, operation_id, completed=None, error=None):
        returncode = completed.returncode if completed is not None else None
        stdout = completed.stdout if completed is not None else getattr(error, "output", None)
        stderr = completed.stderr if completed is not None else getattr(error, "stderr", None)
        receipt = parse_worker_receipt(completed) if completed is not None else None
        receipt = receipt if receipt and receipt.get("ok") is False else None
        code = (receipt or {}).get("code") or "OPERATION_OBSERVATION_UNAVAILABLE"
        deferred = (error is None and returncode == 75 and receipt
                    and receipt.get("deliveryStage") == "PRE_SEND"
                    and code in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"})
        identity = code in {"OPERATION_OBSERVATION_LOGIN_MISMATCH", "OPERATION_OBSERVATION_ORIGIN_MISMATCH",
                            "OPERATION_OBSERVATION_ROUTE_MISMATCH", "OPERATION_OBSERVATION_ACCOUNT_CONFLICT",
                            "OPERATION_OBSERVATION_CONVERSATION_MISMATCH", "OPERATION_OBSERVATION_CONVERSATION_CHANGED"}
        diagnostic = worker_diagnostic(returncode, stderr, "operation-evidence", error=error, stdout=stdout)["worker"]
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        diagnostic["stdoutTail"] = (stdout or "")[-2048:]
        if error is not None:
            diagnostic["errorType"] = type(error).__name__
        self.detail = {"ok":False, "code":code, "operationId":operation_id, "deliveryStatus":"DELIVERY_UNKNOWN",
                       "retryOriginalOperation":False,
                       "observation":{"outcome":"DEFERRED" if deferred else "IDENTITY_REJECTED" if identity else "UNKNOWN",
                                      "receipt":receipt, "worker":diagnostic}}
        if deferred:
            self.detail["readDeferred"] = {key:receipt[key] for key in ("code","status","reason","retryAfterSec","until") if key in receipt}
        self.exit_code = 75 if deferred else 2
        super().__init__(code)


def observe_operation(db, operation_id, candidate=None):
    context = observation_context(db, operation_id, candidate)
    bridge = os.environ.get("CHAT_BRIDGE_BIN") or str(pathlib.Path.home() / ".local/bin/chat-bridge")
    command = [bridge, "operation-evidence", "--operation", operation_id,
               "--project", context["project"], "--account", context["account"], "--background"]
    if candidate:
        command += ["--candidate", candidate]
    try:
        completed = run_bridge(command)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise OperationObservationError(operation_id, error=error) from error
    evidence = parse_worker_receipt(completed) if completed.returncode == 0 else None
    if not evidence or evidence.get("ok") is not True:
        raise OperationObservationError(operation_id, completed=completed)
    latest = observation_context(db, operation_id, candidate)
    if latest["anchor"] != context["anchor"] or evidence.get("anchor") != context["anchor"]:
        raise ValueError("OPERATION_CHANGED_DURING_OBSERVATION")
    url = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/c/([0-9a-f-]{36})/?", str(evidence.get("url") or ""))
    if (not url or url[1] != context["projectId"] or url[2] != context["sessionRef"]
            or any(evidence.get(k) != context[k] for k in ("operationId","taskId","project","account","accountId","sessionRef"))
            or evidence.get("format") != "operation-native-observation-v1"
            or evidence.get("messageSent") is not False):
        raise ValueError("OPERATION_OBSERVATION_IDENTITY_MISMATCH")
    return evidence


def assert_rotation_candidate_free(db, row, candidate, reg):
    operation_id = row["id"]
    competing = [chat for chat in (reg.get("chats") or {}).values()
                 if chat.get("project") == row["project"] and chat.get("role") == row["role"]
                 and (chat.get("workgroupId") or None) == row["workgroup_id"]
                 and chat.get("status","active") == "active" and chat.get("id") != row["caller_ref"]]
    if competing or db.execute("SELECT count(*) FROM operations WHERE rotation_id=?", (row["rotation_id"],)).fetchone()[0] != 1:
        raise ValueError("ROTATION_RECOVERY_COMPETING_ROLE_OR_OPERATION")
    if db.execute("SELECT 1 FROM operations WHERE session_ref=? AND id<>?", (candidate,operation_id)).fetchone():
        raise ValueError("ROTATION_RECOVERY_CANDIDATE_OCCUPIED")
    if candidate == row["caller_ref"] or candidate in (reg.get("chats") or {}):
        raise ValueError("ROTATION_RECOVERY_CANDIDATE_OCCUPIED")
    if db.execute("SELECT 1 FROM logical_sessions WHERE current_session_ref=? OR pending_session_ref=?", (candidate,candidate)).fetchone():
        raise ValueError("ROTATION_RECOVERY_CANDIDATE_OCCUPIED")


def rotation_recover(db, payload):
    operation_id, candidate = payload.get("operationId"), payload.get("candidate")
    context = observation_context(db, operation_id, candidate)
    row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
    logical = db.execute("SELECT * FROM logical_sessions WHERE rotation_id=?", (row["rotation_id"],)).fetchall()
    if (row["kind"] != "rotation" or not row["force_new"] or row["session_ref"] or len(logical) != 1):
        raise ValueError("ROTATION_RECOVERY_ORIGINAL_REQUIRED")
    logical = logical[0]
    reg = registry(db)
    predecessor = (reg.get("chats") or {}).get(row["caller_ref"])
    if (logical["state"] != "ROTATING" or logical["pending_session_ref"]
            or logical["current_session_ref"] != row["caller_ref"]
            or any(logical[k] != row[k] for k in ("project","role","workgroup_id"))
            or not predecessor or predecessor.get("status","active") != "active"
            or predecessor.get("account") != row["account_alias"] or predecessor.get("project") != row["project"]
            or (predecessor.get("workgroupId") or None) != row["workgroup_id"]
            or current_controller_ref(db, reg, row["project"], row["role"], row["workgroup_id"]) != row["caller_ref"]):
        raise ValueError("ROTATION_RECOVERY_LOGICAL_MISMATCH")
    assert_rotation_candidate_free(db, row, candidate, reg)
    handoff = row["original_message"] or ""
    body_hash = hashlib.sha256(handoff.encode()).hexdigest()
    envelope = "\n".join(["[CHATBRIDGE ROLE HANDOFF v1]", "rotation_id: "+row["rotation_id"],
                          "logical_ref: "+logical["logical_ref"], "role: "+row["role"],
                          "next_epoch: "+str(logical["epoch"]+1), "", handoff, ""])
    if (not handoff or body_hash != row["payload_hash"] or body_hash != logical["handoff_hash"]
            or row["request_key"] != "rotation:"+row["rotation_id"]
            or row["task_id"] != "ROT-"+row["rotation_id"] or not row["message"].startswith(envelope)
            or not row["message"].endswith("[/CHATBRIDGE ROLE HANDOFF]")):
        raise ValueError("ROTATION_RECOVERY_HANDOFF_MISMATCH")
    previous = json.loads(row["result"] or "{}")
    witness = previous.get("nativeWitness") or {}
    expected_request = hashlib.sha256(" ".join(row["message"].split()).encode()).hexdigest()
    witness_url = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/project/?", str(witness.get("url") or ""))
    if (witness.get("format") != "chatgpt-native-getText-v1"
            or witness.get("requestHash") != expected_request
            or witness.get("accountIdentityHash") != hashlib.sha256(context["accountIdentity"].encode()).hexdigest()
            or not witness_url or witness_url[1] != context["projectId"]
            or any(not re.fullmatch(r"[0-9a-f]{64}", str(witness.get(k) or "")) for k in ("bodyHash","normalizedBodyHash","getterHash","serializerHash"))):
        raise ValueError("ROTATION_RECOVERY_NATIVE_WITNESS_MISMATCH")
    try:
        witness_at = datetime.fromisoformat(witness["observedAt"].replace("Z","+00:00"))
        if witness_at < datetime.fromisoformat(row["created_at"].replace("Z","+00:00")):
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError("ROTATION_RECOVERY_WITNESS_TIME_INVALID")
    evidence = observe_operation(db, operation_id, candidate)
    if (evidence.get("online") is not True or evidence.get("pageWasDiscarded") is not False
            or evidence.get("recoveryRequired") is not False or evidence.get("errorTexts") != []):
        raise ValueError("ROTATION_RECOVERY_OBSERVATION_UNHEALTHY")
    matches = []
    for item in evidence.get("userMessages") or []:
        source = item.get("userSource") or {}
        text = source.get("text")
        if isinstance(text,str) and hashlib.sha256(text.encode()).hexdigest() == witness["bodyHash"]:
            if (source.get("conversationId") != candidate or not source.get("messageId")
                    or source.get("messageId") != item.get("id")
                    or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", source["messageId"])
                    or hashlib.sha256(" ".join(text.split()).encode()).hexdigest() != witness["normalizedBodyHash"]):
                raise ValueError("ROTATION_RECOVERY_SOURCE_IDENTITY_MISMATCH")
            matches.append(source)
    if len(matches) != 1:
        raise ValueError("ROTATION_RECOVERY_EXACT_MESSAGE_NOT_UNIQUE")
    nonce_header = "\n".join(row["message"].split("\n")[:5]) + "\n\n"
    if not matches[0]["text"].startswith(nonce_header):
        raise ValueError("ROTATION_RECOVERY_SOURCE_NONCE_MISMATCH")
    prior_cid = (previous.get("newSession") or {}).get("observedConversationId")
    post = witness.get("postSend") or {}
    post_url = post.get("afterUrl") or ""
    post_cid = (re.search(r"/c/([^/?#]+)", post_url) or [None,None])[1]
    prior_message_ids = [witness.get("messageId"),post.get("lastUserId"),post.get("sourceMessageId")]
    if (any(value and value != matches[0]["messageId"] for value in prior_message_ids)
            or (prior_cid and prior_cid != candidate) or (post_cid and post_cid != candidate)
            or (post.get("sourceBodyHash") and post["sourceBodyHash"] != witness["bodyHash"])
            or (post.get("sourceConversationId") and post["sourceConversationId"] != candidate)
            or post.get("temporarySourceFirstConflict") is not None
            or post.get("missingCondition") == "NATIVE_TEMPORARY_SOURCE_PROOF_CONFLICT"):
        raise ValueError("ROTATION_RECOVERY_PRIOR_IDENTITY_CONFLICT")
    try:
        observed_at = datetime.fromisoformat(evidence["observedAt"].replace("Z","+00:00"))
        if observed_at < witness_at or abs((datetime.now(timezone.utc)-observed_at).total_seconds()) > 120:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise ValueError("ROTATION_RECOVERY_OBSERVATION_TIME_INVALID")
    proof = {"format":"existing-rotation-native-source-v1", "operationId":operation_id,
             "rotationId":row["rotation_id"], "logicalRef":logical["logical_ref"], "epoch":logical["epoch"],
             "predecessor":row["caller_ref"], "candidate":candidate, "messageId":matches[0]["messageId"],
             "bodyHash":witness["bodyHash"], "requestHash":expected_request, "handoffHash":body_hash,
             "accountId":row["account_id"], "projectId":context["projectId"], "url":evidence["url"],
             "historicalBeforeUserId":None, "serverMessageTimestamp":None,
             "uniquenessScope":"observed-candidate-message-and-local-registry"}
    token = recovery_digest({"anchor":context["anchor"], "logical":dict(logical), "proof":proof})
    preview = {"operationId":operation_id, "rotationId":row["rotation_id"], "state":"RECOVERY_PREVIEW",
               "expected":token, "proof":proof, "observedAt":evidence["observedAt"],
               "readiness":{"generating":evidence.get("generating"),"draftChars":evidence.get("draftChars")},
               "pendingSessionRef":candidate, "currentSessionRef":row["caller_ref"], "epoch":logical["epoch"]}
    if not payload.get("confirm"):
        return preview
    if payload.get("expected") != token:
        raise ValueError("ROTATION_RECOVERY_PREVIEW_CHANGED")
    begin_immediate(db)
    try:
        current_logical = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (logical["logical_ref"],)).fetchone()
        if (not current_logical or dict(current_logical) != dict(logical)
                or observation_context(db, operation_id, candidate)["anchor"] != context["anchor"]):
            raise ValueError("ROTATION_RECOVERY_CAS_CHANGED")
        # Recheck cross-row ownership under the same write lock as the binding.
        assert_rotation_candidate_free(db, row, candidate, registry(db))
        now = stamp()
        next_reg = json.loads(json.dumps(reg))
        next_reg.setdefault("chats",{})[candidate] = {
            "id":candidate,"name":row["role"]+" pending rotation","role":row["role"]+"-pending",
            "project":row["project"],"account":row["account_alias"],"status":"pending-rotation",
            "url":evidence["url"],"workgroupId":row["workgroup_id"],"logicalRef":logical["logical_ref"],
            "rotationId":row["rotation_id"],"predecessorSessionRef":row["caller_ref"],
            "requestedModel":row["requested_model"],"requestedEffort":row["requested_effort"],
            "rotationRecovery":proof,"createdAt":now}
        previous["rotationRecovery"] = {**proof,"observedAt":evidence["observedAt"],"committedAt":now}
        db.execute("UPDATE documents SET payload=? WHERE kind='registry'", (json.dumps(next_reg,ensure_ascii=False),))
        db.execute("UPDATE logical_sessions SET pending_session_ref=?,updated_at=? WHERE logical_ref=?",
                   (candidate,now,logical["logical_ref"]))
        db.execute("UPDATE operations SET status='SENT',session_ref=?,reason='RECOVERED_EXISTING_ROTATION',result=?,updated_at=? WHERE id=?",
                   (candidate,json.dumps(previous,ensure_ascii=False),now,operation_id))
        db.execute("INSERT INTO reconciliation_attempts VALUES (?,?,?,?,?,?)",
                   (str(uuid.uuid4()),operation_id,"RECOVERED_PENDING_ACK","EXACT_NATIVE_ROTATION_SOURCE",json.dumps(proof),now))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {**preview,"state":"RECOVERED_PENDING_ACK","ownerChanged":False}


def reconcile_delivery(db, operation_id):
    if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("RECONCILE_HOST_LOCAL_REQUIRED")
    row = db.execute("SELECT * FROM operations WHERE id=?", (operation_id,)).fetchone()
    if not row:
        raise ValueError("UNKNOWN_OPERATION")
    if row["status"] != "DELIVERY_UNKNOWN" or row["kind"] not in {"dispatch", "callback", "management"}:
        raise ValueError("RECONCILE_REQUIRES_UNKNOWN_DELIVERY")
    if row["native_target"]:
        return reconcile_native(db, row)
    superseded = retired_management_successor(db, row)
    if superseded:
        now = stamp()
        begin_immediate(db)
        try:
            current = db.execute("SELECT status FROM operations WHERE id=?", (operation_id,)).fetchone()
            if not current or current["status"] != "DELIVERY_UNKNOWN":
                raise ValueError("OPERATION_CHANGED_DURING_RECONCILIATION")
            reason = "TARGET_SESSION_RETIRED_SUCCESSOR_ACTIVE"
            db.execute("INSERT INTO reconciliation_attempts VALUES (?,?,?,?,?,?)",
                       (str(uuid.uuid4()), operation_id, "RECONCILED_SUPERSEDED", reason,
                        json.dumps(superseded, ensure_ascii=False), now))
            db.execute("UPDATE operations SET status='RECONCILED_SUPERSEDED',reason=?,result=?,updated_at=? WHERE id=?",
                       (reason, json.dumps({"reconciliation": superseded}, ensure_ascii=False), now, operation_id))
            db.execute("UPDATE management_deliveries SET status='SUPERSEDED',updated_at=? WHERE operation_id=?",
                       (now, operation_id))
            db.commit()
        except Exception:
            db.rollback()
            raise
        return {"operationId": operation_id, "kind": row["kind"], "outcome": "RECONCILED_SUPERSEDED",
                "reason": reason, "evidence": superseded}
    expected = hashlib.sha256(" ".join(row["message"].split()).encode()).hexdigest()
    evidence, reason = None, "NO_SESSION_REFERENCE"
    diagnostic, read_deferred = None, None
    if row["session_ref"]:
        bridge = os.environ.get("CHAT_BRIDGE_BIN") or str(pathlib.Path.home() / ".local/bin/chat-bridge")
        command = [bridge, "evidence", row["session_ref"], "--project", row["project"],
                   "--account", row["account_alias"], "--expected-hash", expected]
        try:
            completed = run_bridge(command)
            receipt = parse_worker_receipt(completed)
            evidence = receipt if completed.returncode == 0 else None
            reason = "MESSAGE_NOT_PROVEN" if evidence else "CHAT_READ_UNAVAILABLE"
            if not evidence:
                diagnostic = worker_diagnostic(completed.returncode, completed.stderr, "evidence", stdout=completed.stdout)
                if (completed.returncode == 75 and receipt and receipt.get("ok") is False
                        and receipt.get("deliveryStage") == "PRE_SEND" and receipt.get("code") in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"}):
                    reason = "CHAT_READ_DEFERRED"
                    read_deferred = {key: receipt[key] for key in ("code", "status", "reason", "retryAfterSec") if key in receipt}
                    diagnostic["worker"]["readDeferred"] = read_deferred
        except (OSError, subprocess.TimeoutExpired) as error:
            reason = "CHAT_READ_UNAVAILABLE"
            diagnostic = worker_diagnostic(None, getattr(error, "stderr", None) or type(error).__name__, "evidence", error=error)
    reg = registry(db)
    binding = ((reg.get("projects") or {}).get(row["project"]) or {}).get("bindings", {}).get(row["account_alias"]) or {}
    expected_project = (re.search(r"g-p-[0-9a-f]{32}", binding.get("projectId") or binding.get("projectUrl") or "") or [None])[0]
    observed_project = (re.search(r"/g/(g-p-[0-9a-f]{32})(?:[-/]|$)", (evidence or {}).get("url") or "") or [None, None])[1]
    observed_session = (re.search(r"/c/([^/?#]+)", (evidence or {}).get("url") or "") or [None, None])[1]
    matches = (evidence or {}).get("matches") or []
    proven = (bool(expected_project) and expected_project == observed_project
              and observed_session == row["session_ref"]
              and evidence.get("accountId") == row["account_id"]
              and evidence.get("account") == row["account_alias"]
              and evidence.get("project") == row["project"]
              and evidence.get("sessionRef") == row["session_ref"]
              and len(matches) == 1 and bool(matches[0].get("messageId"))
              and matches[0].get("textHash") == expected and bool(evidence.get("observedAt")))
    if evidence and not proven:
        reason = "EVIDENCE_INCOMPLETE_OR_MISMATCHED"
    if proven:
        reason = "EXACT_USER_MESSAGE_IN_BOUND_CHAT"
        evidence = {"accountId":evidence["accountId"],"projectId":observed_project,
                    "sessionRef":row["session_ref"],"taskId":row["task_id"],"eventId":row["event_id"],
                    "messageId":matches[0]["messageId"],"textHash":expected,
                    "url":evidence["url"],"observedAt":evidence["observedAt"],
                    "previousReason":row["reason"]}
    else:
        evidence = None  # Do not persist unrelated chat contents or an unverified receipt.
    now = stamp()
    begin_immediate(db)
    try:
        current = db.execute("SELECT status FROM operations WHERE id=?", (operation_id,)).fetchone()
        if not current or current["status"] != "DELIVERY_UNKNOWN":
            raise ValueError("OPERATION_CHANGED_DURING_RECONCILIATION")
        outcome = "RECONCILED_DELIVERED" if proven else "STILL_UNKNOWN"
        db.execute("INSERT INTO reconciliation_attempts VALUES (?,?,?,?,?,?)",
                   (str(uuid.uuid4()),operation_id,outcome,reason,
                    json.dumps(evidence,ensure_ascii=False) if evidence else None,now))
        if diagnostic:
            private = json.loads(row["result"]) if row["result"] else {}
            private = private if isinstance(private, dict) else {}
            private["reconcileWorker"] = diagnostic["worker"]
            db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(private), operation_id))
        if proven:
            db.execute("UPDATE operations SET status='SENT',reason='RECONCILED_FROM_CHAT_EVIDENCE',result=?,updated_at=? WHERE id=?",
                       (json.dumps({"reconciliation":evidence},ensure_ascii=False),now,operation_id))
            if row["kind"] == "management":
                db.execute("UPDATE management_deliveries SET status='DELIVERED',updated_at=? WHERE operation_id=?",
                           (now,operation_id))
            if row["kind"] == "callback" and row["event_id"]:
                db.execute("UPDATE task_results SET callback_status='DELIVERED',callback_delivered_at=? WHERE callback_operation_id=?",
                           (now,operation_id))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"operationId":operation_id,"kind":row["kind"],"outcome":outcome,"reason":reason,"evidence":evidence,
            **({"readDeferred":read_deferred} if read_deferred else {})}


def work_one(db):
    # Idle polls must not compete for the writer lock; the existing transactions recheck eligible work.
    now = time.time()
    if (not db.execute("""SELECT 1 FROM operations WHERE
            (status='QUEUED' AND not_before<=?)
            OR (status='DISPATCHING' AND claimed_at<?)
            OR (status='WAITING_ROUTE' AND kind IN ('callback','management')) LIMIT 1""",
            (now, now - interrupted_claim_timeout())).fetchone()
            and not db.execute("""SELECT 1 FROM task_results WHERE callback_operation_id IS NULL
                AND (callback_status IS NULL OR callback_status='WAITING_ROUTE') LIMIT 1""").fetchone()):
        return {"status": "IDLE"}
    materialize_pending_callbacks(db)
    refresh_waiting_routes(db)
    row = claim(db)
    if row is None:
        return {"status": "IDLE"}
    if row["kind"] in {"callback", "management"} and row["session_ref"]:
        routed = retarget_notification(db, row)
        if routed is None:
            return finish(db, row, "WAITING_ROUTE", "CONTROLLER_SUCCESSOR_NOT_COMMITTED")
        row = routed
    if row["kind"] in {"dispatch", "rotation"}:
        mode = management_mode(db, row["project"], row["workgroup_id"])
        if mode["mode"] in {"PAUSED", "DRAINING"}:
            return finish(db, row, "QUEUED", "ADMISSION_" + mode["mode"], 5)
        if row["control_scope"] != mode.get("scope") or int(row["control_epoch"] or 0) != int(mode.get("epoch") or 0):
            db.execute("UPDATE operations SET control_scope=?,control_epoch=?,updated_at=? WHERE id=?",
                       (mode.get("scope"), mode.get("epoch"), stamp(), row["id"]))
            db.commit()
            row = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
    if row["native_target"]:
        return work_native(db, row)
    bridge = os.environ.get("CHAT_BRIDGE_BIN") or str(pathlib.Path.home() / ".local/bin/chat-bridge")
    args = [bridge]
    if row["kind"] in {"callback", "management"}:
        args += ["send", row["session_ref"], row["message"], "--project", row["project"],
                 "--account", row["account_alias"], "--background"]
    elif row["kind"] == "stop":
        args += ["stop", row["session_ref"], "--project", row["project"], "--account", row["account_alias"], "--background"]
    elif row["session_ref"]:
        args += ["send", row["session_ref"], row["message"], "--project", row["project"], "--account", row["account_alias"],
                 "--task", row["task_id"], "--caller-ref", row["caller_ref"]]
        if row["requested_model"]:
            args += ["--model", row["requested_model"]]
        if row["requested_effort"]:
            args += ["--effort", row["requested_effort"]]
        args += ["--strict-model"]
    else:
        args += ["new", "--project", row["project"], "--account", row["account_alias"], "--name", row["role"],
                 "--role", row["role"], "--message", row["message"]]
        if row["requested_model"]:
            args += ["--model", row["requested_model"]]
        if row["requested_effort"]:
            args += ["--effort", row["requested_effort"]]
        if row["affinity_key"]:
            args += ["--affinity-key", row["affinity_key"]]
        if row["workgroup_id"]:
            args += ["--workgroup", row["workgroup_id"]]
        args += ["--strict-model"]
        if row["force_new"]:
            args += ["--allow-duplicate-role"]
        if row["kind"] == "rotation":
            args += ["--background"]
    try:
        attempt = None
        if args[1] in {"send", "new"}:
            # claim() is already committed. Publish the exact claim before any
            # external child starts; no UNKNOWN or expired claim can reuse it.
            current = db.execute("SELECT * FROM operations WHERE id=?", (row["id"],)).fetchone()
            if not current or any(current[k] != row[k] for k in ("status", "attempts", "claimed_at", "message", "payload_hash", "account_id", "session_ref")):
                raise ValueError("DELIVERY_CLAIM_CHANGED_BEFORE_SPAWN")
            attempt = delivery_attempt_module().prepare(state_dir_for(db), row)
            row = {**dict(row), "_attemptEvidence": attempt}
        completed = run_bridge(args, **({"attempt": attempt} if attempt else {}))
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return finish(db, row, "DELIVERY_UNKNOWN", type(error).__name__,
                      result=worker_diagnostic(None, getattr(error, "stderr", None) or type(error).__name__, "dispatch", error=error))
    receipt = parse_worker_receipt(completed)
    if completed.returncode == 75:
        detail = receipt or {}
        if detail.get("ok") is False and detail.get("deliveryStage") == "PRE_SEND" and detail.get("code") in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"}:
            return finish(db, row, "QUEUED", detail.get("reason"), max(1, float(detail.get("retryAfterSec", 10))))
    if completed.returncode and receipt and receipt.get("deliveryStage") == "PRE_SEND" and receipt.get("code") == "CAPACITY_WAIT":
        if row["kind"] == "dispatch":
            mark_capacity_wait(db, row, receipt)
        return finish(db, row, "QUEUED", "CAPACITY_WAITING", max(1, float(receipt.get("retryAfterSec", 15))))
    if completed.returncode and receipt and receipt.get("deliveryStage") == "PRE_SEND" and receipt.get("code") in {"CHAT_BUSY", "USER_DRAFT_PRESENT", "SPACE_IN_USER_CONTROL"}:
        reason = "TARGET_USER_CONTROLLED" if receipt["code"] == "SPACE_IN_USER_CONTROL" else "TARGET_BUSY_OR_DRAFT"
        return finish(db, row, "QUEUED", reason, 30)
    if completed.returncode:
        if receipt and receipt.get("deliveryStage") == "PRE_SEND" and receipt.get("ok") is False:
            diagnostic = worker_diagnostic(completed.returncode, completed.stderr, "dispatch", stdout=completed.stdout)
            retry_after = pre_send_retry_after(row, receipt)
            if retry_after is not None:
                code = str(receipt.get("code") or "ERROR")[:200]
                return finish(db, row, "QUEUED", f"PRE_SEND_RETRY_{row['pre_send_failures'] + 1}_{code}", retry_after,
                              result=diagnostic, pre_send_failure=True)
            return finish(db, row, "FAILED_PRE_SEND", "PRE_SEND_" + str(receipt.get("code") or "ERROR")[:200],
                          result=diagnostic, pre_send_failure=True)
        if receipt and receipt.get("deliveryStage") == "SEND_ATTEMPTED":
            return finish(db, row, "DELIVERY_UNKNOWN", "SEND_ATTEMPTED_" + str(receipt.get("code") or "ERROR")[:200],
                          result={"nativeWitness": receipt.get("nativeWitness")} if receipt.get("nativeWitness") else None)
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_EXIT_" + str(completed.returncode),
                      result=worker_diagnostic(completed.returncode, completed.stderr, "dispatch", stdout=completed.stdout))
    if receipt is None:
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_RECEIPT_UNREADABLE",
                      result=worker_diagnostic(completed.returncode, completed.stderr, "dispatch", stdout=completed.stdout))
    if row["kind"] == "stop":
        if receipt.get("ok") is False:
            return finish(db,row,"DELIVERY_UNKNOWN","STOP_NOT_CONFIRMED")
        return finish(db,row,"SENT",result={"stop":receipt},session_ref=row["session_ref"])
    if receipt.get("ok") is False or (row["session_ref"] and not receipt.get("delivered")):
        return finish(db, row, "DELIVERY_UNKNOWN", "SEND_NOT_CONFIRMED")
    target = row["session_ref"] or receipt.get("id")
    if not target:
        return finish(db, row, "DELIVERY_UNKNOWN", "SESSION_ID_NOT_CONFIRMED")
    if not row["session_ref"] and row["kind"] == "dispatch":
        record_args = [bridge, "task", "set", row["task_id"], "--project", row["project"],
                       "--account", row["account_alias"], "--session", target, "--role", row["role"],
                       "--status", "DISPATCHED", "--caller-ref", row["caller_ref"],
                       "--original-message", row["original_message"] or row["message"]]
        if row["requested_model"]:
            record_args += ["--model", row["requested_model"]]
        if row["requested_effort"]:
            record_args += ["--effort", row["requested_effort"]]
        if row["resource_policy_version"]:
            record_args += ["--resource-policy-version", row["resource_policy_version"]]
        if row["workgroup_id"]:
            record_args += ["--workgroup", row["workgroup_id"]]
        for source, option in (("baselineAssistantCount", "--baseline-assistant-count"),
                               ("baselineAssistantHash", "--baseline-assistant-hash"),
                               ("baselineAssistantId", "--baseline-assistant-id"),
                               ("dispatchedAt", "--dispatched-at")):
            if receipt.get(source) is not None:
                record_args += [option, str(receipt[source])]
        try:
            recorded = run_bridge(record_args, timeout=TASK_RECORD_TIMEOUT_SEC)
        except (OSError, subprocess.TimeoutExpired) as error:
            return finish(db, row, "DELIVERY_UNKNOWN", "TASK_RECORD_NOT_CONFIRMED", session_ref=target,
                          result=worker_diagnostic(None, getattr(error, "stderr", None) or type(error).__name__, "task-record", error=error))
        if recorded.returncode:
            return finish(db, row, "DELIVERY_UNKNOWN", "TASK_RECORD_NOT_CONFIRMED", session_ref=target,
                          result=worker_diagnostic(recorded.returncode, recorded.stderr, "task-record", stdout=recorded.stdout))
    if row["kind"] == "dispatch":
        clear_capacity_wait(db, row["task_id"])
    result_payload = {"delivered": True, "modelSelection": receipt.get("modelSelection")}
    delivery = receipt.get("delivery")
    if isinstance(delivery, dict) and delivery.get("nativeWitness"):
        result_payload["nativeWitness"] = delivery["nativeWitness"]
    return finish(db, row, "SENT", result=result_payload, session_ref=target)


def serve(config, state):
    lock_path = state / "coordinator.lock"
    with bridge_cancellation(), open(lock_path, "a+") as lock:
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
            while _bridge_interrupted is None:
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


def controller_placement_context(db, session_id):
    """Formal current-controller anchor only; no registry-name fallback."""
    if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("CONTROLLER_PLACEMENT_HOST_LOCAL_REQUIRED")
    reg, rt = registry(db), runtime(db)
    chat = reg.get("chats", {}).get(session_id)
    if (not chat or chat.get("id") != session_id or chat.get("status", "active") != "active"
            or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", session_id)):
        raise ValueError("CONTROLLER_PLACEMENT_NOT_REGISTERED")
    cfg = reg.get("projects", {}).get(chat.get("project"), {})
    group_id = chat.get("workgroupId") or None
    group = cfg.get("workgroups", {}).get(group_id, {}) if group_id else None
    if (group_id and (group.get("controllerSessionRef") != session_id or group.get("controllerRole") != chat.get("role"))
            or not group_id and chat.get("role") != (cfg.get("rootController") or "conductor")):
        raise ValueError("CONTROLLER_PLACEMENT_NOT_CONTROLLER")
    rows = db.execute("SELECT * FROM logical_sessions WHERE current_session_ref=? AND project=? AND role=?",
                      (session_id, chat["project"], chat["role"])).fetchall()
    if (len(rows) != 1 or rows[0]["state"] != "ACTIVE" or rows[0]["pending_session_ref"] or rows[0]["rotation_id"]
            or rows[0]["workgroup_id"] != group_id or chat.get("logicalRef", rows[0]["logical_ref"]) != rows[0]["logical_ref"]):
        raise ValueError("CONTROLLER_PLACEMENT_NOT_CURRENT")
    binding = cfg.get("bindings", {}).get(chat.get("account"))
    identity = reg.get("accounts", {}).get(chat.get("account"), {}).get("identity")
    if (not identity or not binding or not binding.get("profileId")
            or not re.search(r"g-p-[0-9a-f]{32}", binding.get("projectUrl") or "")
            or not str(binding.get("spaceName", "")).startswith("chat-bridge-agent-")):
        raise ValueError("CONTROLLER_PLACEMENT_BINDING_UNVERIFIED")
    if (any(t.get("sessionId") == session_id and str(t.get("status", "")).upper() not in TERMINAL
            for t in rt.get("tasks", {}).values())
            or db.execute("""SELECT 1 FROM operations WHERE status='DISPATCHING'
                AND (session_ref=? OR (session_ref IS NULL AND caller_ref=?)) LIMIT 1""", (session_id, session_id)).fetchone()
            or image_session_reservations(db, {"accountId":account_id(identity), "conversationId":session_id})):
        raise ValueError("CONTROLLER_PLACEMENT_SESSION_BUSY")
    return {"sessionId":session_id, "expectedChat":chat, "expectedBinding":binding,
            "expectedController":dict(rows[0]), "accountIdentity":identity,
            "expectedOverflow":reg.get("capacityOverflow", {}).get(identity + "|" + binding["profileId"])}


def controller_placement_commit(db, payload):
    required = {"sessionId", "expectedChat", "expectedBinding", "expectedController", "accountIdentity",
                "expectedOverflow", "overflowCandidate", "attachment", "observation"}
    if not isinstance(payload, dict) or set(payload) != required:
        raise ValueError("CONTROLLER_PLACEMENT_COMMIT_INVALID")
    attachment, observed = payload["attachment"], payload["observation"]
    if (not isinstance(attachment, dict) or set(attachment) != {
            "spaceName", "spaceId", "pageSpaceId", "page", "profileId", "attachmentEpoch"}
            or not isinstance(observed, dict) or set(observed) != {
            "url", "accountIdentity", "composerPresent", "composerCount", "composerRawText", "generating", "approvalRequired"}):
        raise ValueError("CONTROLLER_PLACEMENT_EVIDENCE_INVALID")
    begin_immediate(db)
    try:
        current = controller_placement_context(db, payload["sessionId"])
        if any(payload[k] != v for k, v in current.items()):
            raise ValueError("CONTROLLER_PLACEMENT_OWNER_CHANGED")
        chat, binding = current["expectedChat"], current["expectedBinding"]
        overflow = payload["overflowCandidate"]
        if overflow is not None:
            legacy = binding["spaceName"] + "-overflow"
            scoped = legacy + "-" + hashlib.sha256(binding["profileId"].encode()).hexdigest()[:8]
            if (not isinstance(overflow, dict) or set(overflow) != {
                    "spaceName", "spaceId", "profileId", "identity", "account", "createdAt"}
                    or overflow["spaceName"] not in {legacy, scoped}
                    or overflow["identity"] != current["accountIdentity"]
                    or overflow["profileId"] != binding["profileId"] or overflow["account"] != chat["account"]
                    or not isinstance(overflow["createdAt"], str) or not overflow["createdAt"]):
                raise ValueError("CONTROLLER_PLACEMENT_OVERFLOW_INVALID")
        main = overflow is None and attachment["spaceName"] == binding.get("spaceName") and attachment["spaceId"] == binding.get("spaceId")
        extra = (overflow and attachment["spaceName"] == overflow["spaceName"] and attachment["spaceId"] == overflow["spaceId"])
        if (not (main or extra) or not str(attachment["spaceName"]).startswith("chat-bridge-agent-")
                or attachment["profileId"] != binding["profileId"]
                or type(attachment["spaceId"]) is not int or attachment["spaceId"] <= 0
                or attachment["pageSpaceId"] != attachment["spaceId"]
                or not isinstance(attachment["page"], str) or not attachment["page"]
                or type(attachment["attachmentEpoch"]) is not int
                or attachment["attachmentEpoch"] != int(chat.get("attachmentEpoch", 0)) + 1):
            raise ValueError("CONTROLLER_PLACEMENT_TARGET_CHANGED")
        project_id = (re.search(r"g-p-[0-9a-f]{32}", binding.get("projectUrl") or "") or [None])[0]
        url = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/c/([0-9a-f-]{36})/?", str(observed["url"]))
        if (not project_id or not url or url[1] != project_id or url[2] != current["sessionId"]
                or observed["accountIdentity"] != current["accountIdentity"]
                or observed["composerPresent"] is not True or type(observed["composerCount"]) is not int
                or observed["composerCount"] != 1 or observed["composerRawText"] != ""
                or observed["generating"] is not False or observed["approvalRequired"] is not False):
            raise ValueError("CONTROLLER_PLACEMENT_OBSERVATION_REJECTED")
        chat.update(attachment)
        reg = registry(db)
        reg["chats"][current["sessionId"]] = chat
        if overflow is not None:
            reg.setdefault("capacityOverflow", {})[current["accountIdentity"] + "|" + binding["profileId"]] = overflow
        db.execute("UPDATE documents SET payload=? WHERE kind='registry'", (json.dumps(reg, ensure_ascii=False),))
        db.commit()
        return {"chat":chat, "controller":current["expectedController"], "messageSent":False}
    except Exception:
        db.rollback()
        raise


def reattach_commit(db, payload):
    """CAS both attachment and exact-task pause in one local transaction.

    Called only by the confirmed live-verifying reattach command. Does not send,
    infer delivery or alter business control; stale observations have no writes.
    """
    required = {"taskId", "sessionId", "expectedChat", "expectedTask", "attachment",
                "accountIdentity", "expectedBinding", "resumeWatch"}
    if not isinstance(payload, dict) or set(payload) != required:
        raise ValueError("REATTACH_COMMIT_INVALID")
    attachment = payload["attachment"]
    if not isinstance(attachment, dict) or set(attachment) != {
            "spaceName", "spaceId", "pageSpaceId", "page", "profileId", "attachmentEpoch"}:
        raise ValueError("REATTACH_ATTACHMENT_INVALID")
    begin_immediate(db)
    try:
        reg, rt = registry(db), runtime(db)
        sid, tid = payload["sessionId"], payload["taskId"]
        chat, task = reg.get("chats", {}).get(sid), rt.get("tasks", {}).get(tid)
        if not chat or not task or chat != payload["expectedChat"] or task != payload["expectedTask"]:
            raise ValueError("REATTACH_OWNER_CHANGED")
        if (task.get("sessionId") != sid or task.get("project") != chat.get("project") or
                task.get("account") != chat.get("account") or str(task.get("status", "")).upper() in TERMINAL):
            raise ValueError("REATTACH_OWNER_CHANGED")
        binding = reg.get("projects", {}).get(chat["project"], {}).get("bindings", {}).get(chat["account"])
        identity = reg.get("accounts", {}).get(chat["account"], {}).get("identity")
        if (not binding or binding != payload["expectedBinding"] or not identity or identity != payload["accountIdentity"] or
                not str(attachment["spaceName"]).startswith("chat-bridge-agent-") or
                attachment["spaceName"] != binding.get("spaceName") or attachment["profileId"] != binding.get("profileId")):
            raise ValueError("REATTACH_BINDING_CHANGED")
        chat.update(attachment)
        if payload["resumeWatch"] is True:
            for name in ("watchdogPausedForUserControl", "watchdogPausedAt", "watchdogPausedSpace", "watchdogPausedOwnership"):
                task.pop(name, None)
            task["observationResumedAt"] = stamp()
            task["observationResumeReason"] = "operator-confirmed same-task managed attachment; no message sent"
        db.execute("UPDATE documents SET payload=? WHERE kind='registry'", (json.dumps(reg, ensure_ascii=False),))
        db.execute("UPDATE documents SET payload=? WHERE kind='runtime'", (json.dumps(rt, ensure_ascii=False),))
        db.commit()
        return {"chat": chat, "task": task, "messageSent": False}
    except Exception:
        db.rollback()
        raise



def image_contract(action, payload, module_name="contract.js"):
    """Stateless Node schema/reducer; SQLite ownership stays in this coordinator."""
    module = pathlib.Path(__file__).parent / "capabilities" / "image" / module_name
    try:
        completed = subprocess.run(["node", str(module), action], input=json.dumps(payload),
                                   text=True, capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError("IMAGE_CONTRACT_UNAVAILABLE") from error
    if completed.returncode:
        try:
            detail = json.loads(completed.stderr).get("error", "IMAGE_CONTRACT_FAILED")
        except ValueError:
            detail = "IMAGE_CONTRACT_FAILED"
        raise ValueError(detail)
    return json.loads(completed.stdout)


def image_tables(db):
    # Same durable database/transaction machinery, no runtime-cache projection.
    db.execute("""CREATE TABLE IF NOT EXISTS image_grants (
        grant_id TEXT PRIMARY KEY, controller_operation_id TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS image_jobs (
        caller_ref TEXT NOT NULL, job_id TEXT NOT NULL, controller_operation_id TEXT NOT NULL,
        request_digest TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
        document TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(caller_ref,job_id)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS image_events (
        caller_ref TEXT NOT NULL, job_id TEXT NOT NULL, event_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY(caller_ref,job_id,event_id)
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS image_batches (
        batch_id TEXT PRIMARY KEY, owner_ref TEXT NOT NULL, scope TEXT NOT NULL,
        batch_digest TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS image_batch_items (
        batch_id TEXT NOT NULL, item_id TEXT NOT NULL, caller_ref TEXT NOT NULL,
        job_id TEXT NOT NULL, request_digest TEXT NOT NULL,
        PRIMARY KEY(batch_id,item_id), UNIQUE(caller_ref,job_id)
    )""")
    db.commit()


def image_operation(db, grant):
    row = db.execute("SELECT * FROM operations WHERE id=? AND kind='dispatch'",
                     (grant["controllerOperationId"],)).fetchone()
    if not row or row["task_id"] != grant["controllerTaskId"]:
        raise ValueError("IMAGE_ACCESS_DENIED")
    return row


def image_owner(db, row, issuer):
    # Account-origin hints do not authenticate an exact Web controller. Grants
    # are host-owner management actions, never inferred from caller names.
    if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("IMAGE_GRANT_HOST_OWNER_REQUIRED")
    if issuer != row["caller_ref"]:
        raise ValueError("IMAGE_GRANT_OWNER_REQUIRED")
    if row["local_owner"]:
        local_caller(issuer, json.loads(row["local_owner"]))
    else:
        authorize_control(db, issuer, row["project"], False, row["workgroup_id"])


def image_route(db, row, request):
    route = request["route"]
    if (route["project"] != row["project"] or route["accountAlias"] != row["account_alias"]
            or route["accountId"] != row["account_id"] or route["sessionRef"] != row["session_ref"]
            or request["scope"]["workgroupId"] != row["workgroup_id"]):
        raise ValueError("IMAGE_ROUTE_NOT_GRANTED")
    reg = registry(db)
    chat = (reg.get("chats") or {}).get(row["session_ref"]) or {}
    project = (reg.get("projects") or {}).get(row["project"]) or {}
    binding = (project.get("bindings") or {}).get(row["account_alias"]) or {}
    identity = ((reg.get("accounts") or {}).get(row["account_alias"]) or {}).get("identity")
    project_id = binding.get("projectId")
    if not project_id:
        match = re.search(r"/g/(g-p-[^/]+)/", str(binding.get("projectUrl") or ""))
        project_id = match.group(1) if match else None
    if (not identity or account_id(identity) != row["account_id"]
            or chat.get("status", "active") != "active" or chat.get("project") != row["project"]
            or chat.get("account") != row["account_alias"] or project_id != route["projectId"]
            or (chat.get("conversationId") or chat.get("id")) != route["conversationId"]
            or request["requestedModel"] != row["requested_model"]
            or request["requestedEffort"] != row["requested_effort"]):
        raise ValueError("IMAGE_ROUTE_NOT_GRANTED")
    if project.get("archived") or not binding_execution_ready(project, binding):
        raise ValueError("IMAGE_PROJECT_NOT_READY")


def image_reject_output_grant(grant):
    if grant.get("kind") in {"OUTPUT_RECOVERY", "OUTPUT_DELIVERY"}:
        raise ValueError("IMAGE_RECOVERY_EFFECT_FORBIDDEN" if grant["kind"] == "OUTPUT_RECOVERY" else "IMAGE_DELIVERY_EFFECT_FORBIDDEN")


def image_access(db, grant, payload):
    """Lookup names confer no authority; use persisted grant, origin, owner and scope."""
    image_reject_output_grant(grant)
    row = image_operation(db, grant)
    request = grant["request"]
    if (payload.get("callerRef") != request["caller"]["ref"] or payload.get("jobId") != request["jobId"]
            or payload.get("scope") != request["scope"]):
        raise ValueError("IMAGE_ACCESS_DENIED")
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin:
        if origin != row["account_id"]:
            raise ValueError("IMAGE_ACCESS_DENIED")
    elif os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("IMAGE_ORIGIN_UNVERIFIED")
    elif row["local_owner"]:
        local_caller(row["caller_ref"], json.loads(row["local_owner"]))
    # Host-local administrators retain the existing same-OS-user trust boundary.
    return row


def image_sources(db, request, grant=None):
    source_turn_id = None
    sources = []
    for source in request["inputs"]:
        if not source["jobId"]:
            raise ValueError("IMAGE_EXTERNAL_SOURCE_REVISION_UNSUPPORTED")
        parent = db.execute("SELECT document FROM image_jobs WHERE caller_ref=? AND job_id=?",
                            (request["caller"]["ref"],source["jobId"])).fetchone()
        if not parent:
            raise ValueError("IMAGE_PARENT_NOT_FOUND")
        parent = json.loads(parent["document"])
        if parent["scope"] != request["scope"]:
            raise ValueError("IMAGE_SOURCE_SCOPE_MISMATCH")
        output = next((o for o in parent["outputs"] if o["outputId"] == source["outputId"]), None)
        if not output and request["operation"] == "refine" and grant and grant.get("sourceExternalizationAuthorized"):
            # The fresh normal grant explicitly names this immutable late source.
            # Source access does not move it out of quarantine or adopt its job.
            output = next((o for o in parent["lateOutputs"] if o["outputId"] == source["outputId"]), None)
        if (not output or output["artifactRef"] != source["artifactRef"] or output["sha256"] != source["sha256"]
                or output["validation"]["status"] != "VERIFIED"):
            raise ValueError("IMAGE_SOURCE_NOT_VERIFIED")
        revision = image_contract("output-revision", {"request": parent["request"], "output": output})
        if source["revisionId"] != revision["revisionId"]:
            raise ValueError("IMAGE_SOURCE_REVISION_MISMATCH")
        sources.append({"source": source, "revision": revision})
        if (request["conversationPolicy"] == "same-source" or request["operation"] == "export") and parent["route"] != request["route"]:
            raise ValueError("IMAGE_SOURCE_CONVERSATION_MISMATCH")
        if source["role"] == "source":
            source_turn_id = output["turnId"]
    return {"sourceTurnId": source_turn_id, "sources": sources}


def image_admission(db, row, request, grant=None, *, existing_output_delivery=False):
    image_route(db, row, request)
    sources = image_sources(db, request, grant)
    if row["status"] != "SENT":
        raise ValueError("IMAGE_CONTROLLER_DELIVERY_NOT_CONFIRMED")
    # A worker result stops generation; a separately bound receive-only grant can deliver existing bytes.
    if not existing_output_delivery and db.execute("SELECT 1 FROM task_results WHERE task_id=? LIMIT 1", (row["task_id"],)).fetchone():
        raise ValueError("IMAGE_CONTROLLER_RESULT_RECORDED")
    mode = management_mode(db, row["project"], row["workgroup_id"])
    if mode["mode"] != "RUNNING":
        raise ValueError("ADMISSION_" + mode["mode"])
    if account_cooldown_active(db, registry(db), row["account_alias"]):
        raise ValueError("WEB_COOLDOWN_ACTIVE")
    task = (runtime(db).get("tasks") or {}).get(row["task_id"]) or {}
    if task.get("watchdogPausedForUserControl"):
        raise ValueError("IMAGE_USER_CONTROL_PAUSED")
    return sources


def image_session_reservations(db, session):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_jobs'").fetchone():
        return []
    # ponytail: scan saved jobs; index real session identity if job volume makes this hot.
    # Failure/cancel/deadline is not remote settlement. Only GENERATED/PARTIAL can
    # populate turn-bound candidate IDs; those survive later export/read failures.
    # An export-only job never sends a generation.
    return db.execute("""SELECT caller_ref,job_id,document FROM image_jobs
        WHERE json_extract(document,'$.route.accountId')=?
          AND json_extract(document,'$.route.conversationId')=?
          AND json_extract(document,'$.request.operation')!='export'
          AND EXISTS (SELECT 1 FROM json_each(image_jobs.document,'$.attempts')
            WHERE json_extract(value,'$.status')!='FAILED_PRE_SEND'
              AND (json_extract(value,'$.turnId') IS NULL
                   OR coalesce(json_array_length(value,'$.candidateOutputIds'),0)=0))""",
        (session["accountId"],session["conversationId"])).fetchall()


def image_batch_for_job(db, record):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_batch_items'").fetchone():
        return None
    return db.execute("""SELECT b.* FROM image_batches b JOIN image_batch_items i USING(batch_id)
                         WHERE i.caller_ref=? AND i.job_id=?""",
                      (record["caller"]["ref"], record["jobId"])).fetchone()


def image_batch_jobs(db, row):
    links = list(db.execute("SELECT * FROM image_batch_items WHERE batch_id=?", (row["batch_id"],)))
    expected = {i["itemId"]:(i["jobId"],i["requestDigest"]) for i in json.loads(row["document"])["items"]}
    if len(links) != len(expected) or any(expected.get(i["item_id"]) != (i["job_id"],i["request_digest"]) for i in links):
        raise ValueError("IMAGE_BATCH_LINKAGE_CORRUPT")
    jobs = []
    for link in links:
        saved = db.execute("SELECT document FROM image_jobs WHERE caller_ref=? AND job_id=?",
                           (link["caller_ref"], link["job_id"])).fetchone()
        if not saved:
            raise ValueError("IMAGE_BATCH_JOB_MISSING")
        job = json.loads(saved[0])
        if job["requestDigest"] != link["request_digest"] or json.dumps(job["scope"], sort_keys=True) != row["scope"]:
            raise ValueError("IMAGE_BATCH_JOB_BINDING")
        jobs.append(job)
    return jobs


def image_batch_usage(jobs):
    # Existing immutable attempt history is the conservative reservation ledger;
    # UNKNOWN and FAILED_PRE_SEND never refund a possible generation call.
    return {"attempts": sum(len(j["attempts"]) for j in jobs),
            "generationCallReservations": sum(len(j["attempts"]) for j in jobs if j["request"]["operation"] != "export")}


def image_batch_deadline(batch, now):
    created = datetime.fromisoformat(batch["createdAt"].replace("Z", "+00:00"))
    deadline = datetime.fromisoformat(batch["budget"]["deadlineAt"].replace("Z", "+00:00"))
    if batch["budget"]["maxDurationMs"] < (deadline-created).total_seconds()*1000:
        deadline = created + timedelta(milliseconds=batch["budget"]["maxDurationMs"])
    if now >= deadline:
        raise ValueError("IMAGE_BATCH_DEADLINE")
    return deadline


def image_batch_reserve(db, record, payload, now):
    row = image_batch_for_job(db, record)
    expected = payload.get("expectedBatchRevision")
    if not row:
        if expected is not None:
            raise ValueError("IMAGE_BATCH_NOT_LINKED")
        return
    if expected is not None and (type(expected) is not int or expected != row["revision"]):
        raise ValueError("IMAGE_BATCH_REVISION_CONFLICT")
    batch = json.loads(row["document"])
    image_batch_deadline(batch, datetime.fromisoformat(now))
    jobs = image_batch_jobs(db, row)
    usage, budget = image_batch_usage(jobs), batch["budget"]
    if len(record["attempts"]) >= budget["maxItemAttempts"]:
        raise ValueError("IMAGE_BATCH_ITEM_ATTEMPT_BUDGET")
    if usage["attempts"] >= budget["maxAttempts"]:
        raise ValueError("IMAGE_BATCH_ATTEMPT_BUDGET")
    if record["request"]["operation"] != "export" and usage["generationCallReservations"] >= budget["maxGenerationCalls"]:
        raise ValueError("IMAGE_BATCH_GENERATION_CALL_BUDGET")
    # The ImageJob append and this CAS share image_api's BEGIN IMMEDIATE + commit.
    if db.execute("UPDATE image_batches SET revision=revision+1 WHERE batch_id=? AND revision=?",
                  (row["batch_id"], row["revision"])).rowcount != 1:
        raise ValueError("IMAGE_BATCH_REVISION_CONFLICT")


def image_io_admission(db, saved, record, at=None):
    grant = json.loads(saved["payload"])
    image_reject_output_grant(grant)
    key = {"grantId":record["grantId"], "callerRef":record["caller"]["ref"], "jobId":record["jobId"], "scope":record["scope"]}
    operation = image_access(db, grant, key)
    if (grant["grantId"] != record["grantId"] or grant["request"]["requestDigest"] != record["requestDigest"]
            or grant["controllerOperationId"] != record["controllerOperationId"]):
        raise ValueError("IMAGE_ACCESS_DENIED")
    instant = datetime.fromisoformat(at) if at else datetime.now(timezone.utc)
    expires = min(datetime.fromisoformat(t.replace("Z", "+00:00"))
                  for t in (grant["expiresAt"], grant["request"]["budget"]["deadlineAt"]))
    if saved["revoked_at"] or expires <= instant:
        raise ValueError("IMAGE_GRANT_EXPIRED_OR_REVOKED")
    if record["cancelRequestedAt"]:
        raise ValueError("IMAGE_CANCEL_REQUESTED")
    if record["attempts"]:
        attempt_expires = datetime.fromisoformat(record["attempts"][-1]["startedAt"].replace("Z", "+00:00")) + timedelta(milliseconds=grant["request"]["budget"]["maxDurationMs"])
        if attempt_expires <= instant:
            raise ValueError("IMAGE_ATTEMPT_DEADLINE")
        expires = min(expires, attempt_expires)
    batch = image_batch_for_job(db, record)
    if batch:
        expires = min(expires, image_batch_deadline(json.loads(batch["document"]), instant))
    sources = image_admission(db, operation, grant["request"], grant)
    gate = image_contract("gate", {"request":grant["request"], "capabilities":grant["capabilities"], "at":instant.isoformat()})
    if not gate["allowed"]:
        raise ValueError(gate["reason"])
    return {"allowed":True, "expiresAt":expires.isoformat(), "sources":sources["sources"]}


def image_output_job(db, key, error):
    saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (key["grantId"],)).fetchone()
    row = db.execute("SELECT * FROM image_jobs WHERE caller_ref=? AND job_id=?",
                     (key["callerRef"], key["jobId"])).fetchone()
    if not saved or not row:
        raise ValueError(error)
    original, record = json.loads(saved["payload"]), json.loads(row["document"])
    operation = image_access(db, original, key)
    image_owner(db, operation, operation["caller_ref"])
    if (record["grantId"] != key["grantId"] or record["scope"] != key["scope"]
            or record["requestDigest"] != original["request"]["requestDigest"]
            or record["controllerOperationId"] != original["controllerOperationId"]
            or record["controllerTaskId"] != original["controllerTaskId"]):
        raise ValueError(error)
    return saved, row, original, record, operation


def image_recovery_binding(db, grant, current=True):
    saved, row, original, record, operation = image_output_job(db, grant["key"], "IMAGE_RECOVERY_BINDING")
    if (record["requestDigest"] != grant["requestDigest"]
            or record["controllerOperationId"] != grant["controllerOperationId"]
            or record["controllerTaskId"] != grant["controllerTaskId"] or record["route"] != grant["route"]
            or record["request"]["authorizedOutput"]["targetRef"] != grant["targetRef"]):
        raise ValueError("IMAGE_RECOVERY_BINDING")
    attempts = record["attempts"]
    if (record["request"]["operation"] != "generate" or record["request"]["count"] != 1
            or record["request"]["inputs"] or len(attempts) != 1
            or attempts[0]["capabilities"]["features"]["generate"]["mode"] != "ASSISTED"
            or attempts[0]["capabilities"]["features"]["export"]["mode"] != "ASSISTED"):
        raise ValueError("IMAGE_RECOVERY_MODE_UNSUPPORTED")
    attempt = attempts[0]
    now = datetime.now(timezone.utc)
    expired = min(datetime.fromisoformat(t.replace("Z", "+00:00"))
                  for t in (original["expiresAt"], original["request"]["budget"]["deadlineAt"])) <= now
    timed_out = datetime.fromisoformat(attempt["startedAt"].replace("Z", "+00:00")) + timedelta(milliseconds=record["request"]["budget"]["maxDurationMs"]) <= now
    if not (expired or saved["revoked_at"] or timed_out):
        raise ValueError("IMAGE_RECOVERY_NOT_LATE")
    if (attempt["attemptId"] != grant["attemptId"] or attempt["status"] == "FAILED_PRE_SEND"
            or grant["userMessageId"] in attempt["baselineTurnIds"] or grant["turnId"] in attempt["baselineTurnIds"]
            or attempt["userMessageId"] not in (None, grant["userMessageId"])
            or attempt["turnId"] not in (None, grant["turnId"])):
        raise ValueError("IMAGE_RECOVERY_TURN_BINDING")
    if current:
        if record["cancelRequestedAt"]:
            raise ValueError("IMAGE_CANCEL_REQUESTED")
        image_admission(db, operation, original["request"], original)
        gate = image_contract("gate", {"request":{**original["request"], "operation":"export"},
                              "capabilities":attempt["capabilities"], "at":stamp()})
        if not gate["allowed"]:
            raise ValueError(gate["reason"])
    return record


def image_recovery_admission(db, payload):
    query = image_contract("recovery-query", payload)
    saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (query["recoveryGrantId"],)).fetchone()
    if not saved:
        raise ValueError("IMAGE_RECOVERY_ACCESS_DENIED")
    grant = json.loads(saved["payload"])
    if grant.get("kind") != "OUTPUT_RECOVERY":
        raise ValueError("IMAGE_RECOVERY_ACCESS_DENIED")
    expires = datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00"))
    if saved["revoked_at"] or expires <= datetime.now(timezone.utc):
        raise ValueError("IMAGE_RECOVERY_EXPIRED_OR_REVOKED")
    if ({k:query[k] for k in grant["key"]} != grant["key"]
            or any(query[k] != grant[k] for k in ("requestDigest", "attemptId", "route", "userMessageId", "turnId"))):
        raise ValueError("IMAGE_RECOVERY_BINDING")
    record = image_recovery_binding(db, grant)
    value = {"allowed":True, "expiresAt":expires.isoformat(), "targetRef":grant["targetRef"],
             "maxByteLength":grant["maxByteLength"], "evidenceRef":grant["evidenceRef"]}
    receive_fields = {"outputId", "artifactRef", "sha256", "consumerRef", "destinationRef"}
    if query["action"] == "receive":
        if not receive_fields.issubset(query) or any(query[k] != grant[k] for k in ("consumerRef", "destinationRef")):
            raise ValueError("IMAGE_RECOVERY_RECEIVER_BINDING")
        output = next((o for o in record["lateOutputs"] if o["outputId"] == query["outputId"]), None)
        if (not output or output["validation"]["status"] != "VERIFIED" or output["attemptId"] != grant["attemptId"]
                or output["turnId"] != grant["turnId"] or any(output[k] != query[k] for k in ("artifactRef", "sha256"))
                or output["byteLength"] > grant["maxByteLength"]):
            raise ValueError("IMAGE_RECOVERY_OUTPUT_NOT_VERIFIED")
        value["outputRevision"] = image_contract("output-revision", {"request":record["request"], "output":output})
        value["output"] = output
    elif receive_fields.intersection(query):
        raise ValueError("IMAGE_RECOVERY_RECEIVER_BINDING")
    return value


def image_delivery_binding(db, grant, current=False):
    saved, row, original, record, operation = image_output_job(db, grant["key"], "IMAGE_DELIVERY_BINDING")
    if (record["requestDigest"] != grant["requestDigest"] or record["route"] != grant["route"]
            or record["controllerOperationId"] != grant["controllerOperationId"]
            or record["controllerTaskId"] != grant["controllerTaskId"] or record["request"]["count"] != 1):
        raise ValueError("IMAGE_DELIVERY_BINDING")
    output = next((o for o in record["outputs"] if o["outputId"] == grant["output"]["outputId"]), None)
    if not output or output["validation"]["status"] != "VERIFIED" or output["byteLength"] > grant["maxByteLength"]:
        raise ValueError("IMAGE_DELIVERY_OUTPUT_NOT_VERIFIED")
    attempt = next((a for a in record["attempts"] if a["attemptId"] == output["attemptId"]), None)
    if not attempt or attempt["turnId"] != output["turnId"] or output["outputId"] not in attempt["candidateOutputIds"]:
        raise ValueError("IMAGE_DELIVERY_OUTPUT_BINDING")
    revision = image_contract("output-revision", {"request":record["request"], "output":output})
    exact = {k:output[k] for k in ("jobId", "outputId", "artifactRef", "sha256")}
    exact["revisionId"] = revision["revisionId"]
    if exact != grant["output"]:
        raise ValueError("IMAGE_DELIVERY_OUTPUT_BINDING")
    try:
        created = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        if not created.tzinfo or created > datetime.now(timezone.utc):
            raise ValueError()
        retention = created + timedelta(hours=original["request"]["authorizedOutput"]["retentionHours"])
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError):
        raise ValueError("IMAGE_DELIVERY_RETENTION_TIMESTAMP")
    if datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00")) > retention:
        raise ValueError("IMAGE_DELIVERY_RETENTION_DEADLINE")
    if current:
        if record["cancelRequestedAt"]:
            raise ValueError("IMAGE_CANCEL_REQUESTED")
        if retention <= datetime.now(timezone.utc):
            raise ValueError("IMAGE_DELIVERY_RETENTION_DEADLINE")
        image_admission(db, operation, original["request"], original, existing_output_delivery=True)
    return {"record":record, "output":output, "outputRevision":revision,
            "retentionDeadline":retention.isoformat(), "retentionHours":original["request"]["authorizedOutput"]["retentionHours"],
            "retentionOrigin":row["created_at"]}


def image_delivery_destination(db, grant):
    # Receipt v1 omits destination: one immutable destination per job/consumer.
    for row in db.execute("SELECT payload FROM image_grants WHERE controller_operation_id=?", (grant["controllerOperationId"],)):
        prior = json.loads(row[0])
        if (prior.get("kind") in {"OUTPUT_DELIVERY", "OUTPUT_RECOVERY"} and prior["key"] == grant["key"]
                and prior["requestDigest"] == grant["requestDigest"] and prior["consumerRef"] == grant["consumerRef"]
                and prior["destinationRef"] != grant["destinationRef"]):
            raise ValueError("IMAGE_DELIVERY_DESTINATION_CONFLICT")


def image_delivery_query(db, payload, current=False):
    query = image_contract("delivery-query", payload)
    saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (query["deliveryGrantId"],)).fetchone()
    if not saved:
        raise ValueError("IMAGE_DELIVERY_ACCESS_DENIED")
    grant = json.loads(saved["payload"])
    if grant.get("kind") != "OUTPUT_DELIVERY" or {k:query[k] for k in grant["key"]} != grant["key"]:
        raise ValueError("IMAGE_DELIVERY_BINDING")
    bound = image_delivery_binding(db, grant, current=current)
    image_delivery_destination(db, grant)
    if current and (saved["revoked_at"] or datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)):
        raise ValueError("IMAGE_DELIVERY_EXPIRED_OR_REVOKED")
    return {"allowed":True, "kind":"OUTPUT_DELIVERY", "action":"receive", "expiresAt":grant["expiresAt"], "consumerRef":grant["consumerRef"],
            "destinationRef":grant["destinationRef"], "maxByteLength":grant["maxByteLength"],
            **{k:bound[k] for k in ("output", "outputRevision", "retentionOrigin", "retentionHours", "retentionDeadline")}}


def image_receiver_bindings(db, record, consumer=None, delivery_id=None):
    key = {"grantId":record["grantId"],"callerRef":record["caller"]["ref"],"jobId":record["jobId"],"scope":record["scope"]}
    grouped, destinations = {}, {}
    for saved in db.execute("SELECT * FROM image_grants WHERE controller_operation_id=?", (record["controllerOperationId"],)):
        grant = json.loads(saved["payload"])
        if (grant.get("kind") not in {"OUTPUT_DELIVERY", "OUTPUT_RECOVERY"} or grant["key"] != key
                or (consumer is not None and grant["consumerRef"] != consumer)):
            continue
        destination_key = grant["consumerRef"]
        destinations.setdefault(destination_key, set()).add(grant["destinationRef"])
        if grant["kind"] == "OUTPUT_DELIVERY":
            bound = image_delivery_binding(db, grant)
            outputs, classification = [bound["output"]], "ordinary"
        else:
            recovered = image_recovery_binding(db, grant, current=False)
            outputs = [o for o in recovered["lateOutputs"] if o["validation"]["status"] == "VERIFIED"
                       and o["attemptId"] == grant["attemptId"] and o["turnId"] == grant["turnId"] and o["byteLength"] <= grant["maxByteLength"]]
            classification = "late"
        for output in outputs:
            identity = (grant["consumerRef"], grant["destinationRef"], output["outputId"], classification)
            entry = grouped.setdefault(identity, {"jobId":record["jobId"], "requestDigest":record["requestDigest"],
                "output":output,"consumerRef":grant["consumerRef"],"destinationRef":grant["destinationRef"],
                "classification":classification,"grantIds":[],"windows":[]})
            entry["grantIds"].append(grant["grantId"])
            entry["windows"].append({"from":saved["created_at"],"to":min(datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00")),datetime.fromisoformat(saved["revoked_at"].replace("Z", "+00:00"))).isoformat() if saved["revoked_at"] else grant["expiresAt"]})
    if any(len(values) > 1 for values in destinations.values()):
        return [], "RECEIVER_DESTINATION_AMBIGUOUS"
    entries = [e for e in grouped.values() if delivery_id is None or delivery_id in e["grantIds"]]
    return entries, "RECEIVER_EVIDENCE_AVAILABLE" if entries else "RECEIVER_EVIDENCE_UNAVAILABLE"


def image_receiver_read(db, state, record, consumer=None, delivery_id=None):
    bindings, status = image_receiver_bindings(db, record, consumer, delivery_id)
    evidence = image_contract("read", {"stateDir":str(state.resolve()), "bindings":bindings,"at":stamp()}, "receiver-evidence.js") if bindings else []
    return {"receiverEvidence":status, "deliveries":evidence}


def image_batch_create(db, payload):
    if not isinstance(payload, dict) or set(payload) != {"issuerRef", "batch", "keys"}:
        raise ValueError("IMAGE_BATCH_PAYLOAD")
    batch = image_contract("normalize", {"batch":payload["batch"]}, "batch.js")
    if not isinstance(payload["keys"], list) or len(payload["keys"]) != len(batch["items"]):
        raise ValueError("IMAGE_BATCH_KEYS")
    image_tables(db)
    begin_immediate(db)
    try:
        jobs, keys = [], {}
        for supplied in payload["keys"]:
            key = image_contract("key", supplied)
            if key["jobId"] in keys:
                raise ValueError("IMAGE_BATCH_KEYS")
            keys[key["jobId"]] = key
            saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (key["grantId"],)).fetchone()
            if not saved:
                raise ValueError("IMAGE_ACCESS_DENIED")
            grant = json.loads(saved["payload"])
            image_owner(db, image_access(db, grant, key), payload["issuerRef"])
            stored = db.execute("SELECT document FROM image_jobs WHERE caller_ref=? AND job_id=?", (key["callerRef"], key["jobId"])).fetchone()
            if not stored:
                raise ValueError("IMAGE_JOB_NOT_FOUND")
            job = json.loads(stored[0])
            link = next((i for i in batch["items"] if i["jobId"] == key["jobId"]), None)
            if (not link or job["grantId"] != key["grantId"] or job["requestDigest"] != link["requestDigest"]
                    or grant["request"]["requestDigest"] != job["requestDigest"] or job["scope"] != key["scope"]
                    or job["controllerOperationId"] != grant["controllerOperationId"] or job["request"]["count"] != 1):
                raise ValueError("IMAGE_BATCH_JOB_BINDING")
            if jobs and job["scope"] != jobs[0]["scope"]:
                raise ValueError("IMAGE_BATCH_SCOPE_MISMATCH")
            jobs.append(job)
        prior = db.execute("SELECT * FROM image_batches WHERE batch_id=?", (batch["batchId"],)).fetchone()
        if prior:
            if prior["owner_ref"] != payload["issuerRef"] or prior["batch_digest"] != batch["batchDigest"]:
                raise ValueError("IMAGE_BATCH_CONFLICT")
            db.commit()
            return {"batch":batch, "revision":prior["revision"], "idempotent":True}
        now = stamp()
        # Validate full authoritative job binding before recording any linkage.
        image_contract("decision", {"batch":batch,"snapshots":{"jobs":jobs,"receipts":[],"admissions":[],"at":now}}, "batch.js")
        usage = image_batch_usage(jobs)
        if (usage["attempts"] > batch["budget"]["maxAttempts"] or usage["generationCallReservations"] > batch["budget"]["maxGenerationCalls"]
                or any(len(j["attempts"]) > batch["budget"]["maxItemAttempts"] for j in jobs)):
            raise ValueError("IMAGE_BATCH_EXISTING_USAGE_EXCEEDS_BUDGET")
        for job in jobs:
            if image_batch_for_job(db, job):
                raise ValueError("IMAGE_BATCH_JOB_ALREADY_LINKED")
        db.execute("INSERT INTO image_batches VALUES (?,?,?,?,?,?)", (batch["batchId"], payload["issuerRef"],
                   json.dumps(jobs[0]["scope"], sort_keys=True), batch["batchDigest"], 1, json.dumps(batch)))
        for link in batch["items"]:
            db.execute("INSERT INTO image_batch_items VALUES (?,?,?,?,?)", (batch["batchId"], link["itemId"],
                       keys[link["jobId"]]["callerRef"], link["jobId"], link["requestDigest"]))
        db.commit()
        return {"batch":batch, "revision":1, "idempotent":False}
    except Exception:
        db.rollback()
        raise


def image_batch_read(config, state, command, payload):
    if not isinstance(payload, dict) or set(payload) != {"batchId", "issuerRef"}:
        raise ValueError("IMAGE_BATCH_PAYLOAD")
    db = sqlite3.connect((state / "bridge.sqlite3").resolve().as_uri() + "?mode=rw", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_batches'").fetchone():
            raise ValueError("IMAGE_BATCH_NOT_FOUND")
        row = db.execute("SELECT * FROM image_batches WHERE batch_id=?", (payload["batchId"],)).fetchone()
        if not row or row["owner_ref"] != payload["issuerRef"]:
            raise ValueError("IMAGE_BATCH_ACCESS_DENIED")
        jobs = image_batch_jobs(db, row)
        admissions, now = [], stamp()
        for job in jobs:
            saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (job["grantId"],)).fetchone()
            if not saved:
                raise ValueError("IMAGE_ACCESS_DENIED")
            grant = json.loads(saved["payload"])
            key = {"grantId":job["grantId"],"callerRef":job["caller"]["ref"],"jobId":job["jobId"],"scope":job["scope"]}
            # History authorization is separate from current I/O admission. A
            # revoked grant must not hide an owner's UNKNOWN or late evidence.
            image_owner(db, image_access(db, grant, key), payload["issuerRef"])
            if command == "image-batch-decision":
                proof = {"key":key,"requestDigest":job["requestDigest"],"quotaRemaining":None,"reason":None}
                try:
                    admission = image_io_admission(db, saved, job, now)
                    proof.update(allowed=admission["allowed"], expiresAt=admission["expiresAt"])
                    if any((r["caller_ref"],r["job_id"]) != (job["caller"]["ref"],job["jobId"])
                           for r in image_session_reservations(db, job["route"])):
                        raise ValueError("IMAGE_SESSION_BUSY")
                except ValueError as error:
                    proof.update(allowed=False,expiresAt=None,reason=str(error))
                admissions.append(proof)
        evidence, statuses, delivery_admissions = [], [], []
        links = json.loads(row["document"])["items"]
        for job in jobs:
            consumer = next(i["consumerRef"] for i in links if i["jobId"] == job["jobId"])
            received = image_receiver_read(db, state, job, consumer)
            evidence.extend(received["deliveries"])
            statuses.append(received["receiverEvidence"])
            if command != "image-batch-decision":
                continue
            for entry in received["deliveries"]:
                if entry["classification"] != "ordinary":
                    continue
                key = {"grantId":job["grantId"],"callerRef":job["caller"]["ref"],"jobId":job["jobId"],"scope":job["scope"]}
                proof = {"key":key,"requestDigest":job["requestDigest"],"outputId":entry["output"]["outputId"],
                         "consumerRef":consumer,"destinationRef":entry["destinationRef"],"allowed":False,
                         "expiresAt":None,"reason":"IMAGE_DELIVERY_AUTHORIZATION_REQUIRED"}
                for grant_id in sorted(entry["grantIds"]):
                    try:
                        authority = image_delivery_query(db, {**key,"deliveryGrantId":grant_id}, current=True)
                        if not proof["allowed"] or datetime.fromisoformat(authority["expiresAt"].replace("Z", "+00:00")) > datetime.fromisoformat(proof["expiresAt"].replace("Z", "+00:00")):
                            proof.update(allowed=True,expiresAt=authority["expiresAt"],reason=None)
                    except ValueError as error:
                        if not proof["allowed"]:
                            proof["reason"] = str(error)
                delivery_admissions.append(proof)
        status = "RECEIVER_DESTINATION_AMBIGUOUS" if "RECEIVER_DESTINATION_AMBIGUOUS" in statuses else "RECEIVER_EVIDENCE_AVAILABLE" if evidence else "RECEIVER_EVIDENCE_UNAVAILABLE"
        result = {"batch":json.loads(row["document"]),"revision":row["revision"],"budgetUsage":image_batch_usage(jobs),
                  "receiverEvidence":status,"deliveries":evidence}
        if command == "image-batch-inspect":
            result["jobs"] = [image_contract("result", {"record":job}) for job in jobs]
        else:
            # Actual controlled receiver evidence only; never caller/producer receipts.
            result["decision"] = image_contract("decision", {"batch":result["batch"],
                "snapshots":{"jobs":jobs,"receipts":[e["receipt"] for e in evidence if e["receipt"] and e["classification"] == "ordinary"],
                             "lateReceipts":[e["receipt"] for e in evidence if e["receipt"] and e["classification"] == "late"],
                             "admissions":admissions,"deliveryAdmissions":delivery_admissions,"at":now}}, "batch.js")
        return result
    finally:
        db.close()


def image_local_read(config, state, command, payload):
    occupancy = command == "image-session-occupancy"
    recovery = command == "image-output-io-admission"
    delivery = command in {"image-delivery-io-admission", "image-delivery-receipt"}
    payload = image_contract("delivery-query" if delivery else "recovery-query" if recovery else "occupancy-query" if occupancy else "key", payload)
    session, key = (payload["session"], payload.get("key")) if occupancy else (None, None if recovery or delivery else payload)
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if occupancy and origin and origin != session["accountId"]:
        raise ValueError("IMAGE_ACCESS_DENIED")
    if not origin and os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
        raise ValueError("IMAGE_ORIGIN_UNVERIFIED")
    empty = {"occupied": False, "reservedByJob": False}
    path = state / "bridge.sqlite3"
    if not path.exists():
        if key or recovery or delivery:
            raise ValueError("IMAGE_ACCESS_DENIED")
        return empty
    # Same query-only WAL read pattern as state-store.py peek. mode=rw cannot
    # create a missing store; no schema initialization or JSON projection repair.
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=2)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        if recovery:
            return image_recovery_admission(db, payload)
        if delivery:
            authority = image_delivery_query(db, payload, current=command == "image-delivery-io-admission")
            if command == "image-delivery-io-admission":
                return authority
            record = image_output_job(db, {k:payload[k] for k in ("grantId","callerRef","jobId","scope")}, "IMAGE_DELIVERY_BINDING")[3]
            return image_receiver_read(db, state, record, delivery_id=payload["deliveryGrantId"])
        if key:
            if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_grants'").fetchone():
                raise ValueError("IMAGE_ACCESS_DENIED")
            saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (key["grantId"],)).fetchone()
            if not saved:
                raise ValueError("IMAGE_ACCESS_DENIED")
            grant = json.loads(saved["payload"])
            operation = image_access(db, grant, key)
            route = grant["request"]["route"]
            if occupancy and any(session[field] != route[field] for field in session):
                raise ValueError("IMAGE_ACCESS_DENIED")
            if not occupancy:
                row = db.execute("SELECT document FROM image_jobs WHERE caller_ref=? AND job_id=?", (key["callerRef"],key["jobId"])).fetchone()
                if not row:
                    raise ValueError("IMAGE_JOB_NOT_FOUND")
                record = json.loads(row["document"])
                if (record["grantId"] != key["grantId"] or record["requestDigest"] != grant["request"]["requestDigest"]
                        or record["controllerOperationId"] != grant["controllerOperationId"] or record["scope"] != key["scope"]):
                    raise ValueError("IMAGE_ACCESS_DENIED")
                return image_io_admission(db, saved, record)
        rows = image_session_reservations(db, session)
        owned = False
        if key and len(rows) == 1 and (rows[0]["caller_ref"],rows[0]["job_id"]) == (key["callerRef"],key["jobId"]):
            record = json.loads(rows[0]["document"])
            owned = (record["grantId"] == key["grantId"] and record["requestDigest"] == grant["request"]["requestDigest"]
                     and record["controllerOperationId"] == grant["controllerOperationId"] and record["scope"] == key["scope"])
        return {"occupied": bool(rows), "reservedByJob": owned}
    finally:
        db.close()


def image_api(db, command, payload):
    image_tables(db)
    begin_immediate(db)
    try:
        now = stamp()
        if command == "image-authorize":
            kind = payload["grant"].get("kind")
            output_grant = kind in {"OUTPUT_RECOVERY", "OUTPUT_DELIVERY"}
            grant = image_contract("recovery-grant" if kind == "OUTPUT_RECOVERY" else "delivery-grant" if kind == "OUTPUT_DELIVERY" else "grant", {"grant": payload["grant"], "at": now})
            operation = image_operation(db, grant)
            image_owner(db, operation, payload.get("issuerRef"))
            if kind == "OUTPUT_RECOVERY":
                image_recovery_binding(db, grant)
            elif kind == "OUTPUT_DELIVERY":
                image_delivery_binding(db, grant, current=True)
                image_delivery_destination(db, grant)
            else:
                image_route(db, operation, grant["request"])
            encoded = json.dumps(grant, sort_keys=True, ensure_ascii=False)
            prior = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (grant["grantId"],)).fetchone()
            if prior and prior["payload"] != encoded:
                raise ValueError("IMAGE_GRANT_CONFLICT")
            if not prior:
                db.execute("INSERT INTO image_grants(grant_id,controller_operation_id,payload,created_at) VALUES (?,?,?,?)",
                           (grant["grantId"], grant["controllerOperationId"], encoded, now))
            value = {"grantId": grant["grantId"], "requestDigest": grant["requestDigest"] if output_grant else grant["request"]["requestDigest"],
                     "idempotent": bool(prior), "revoked": bool(prior and prior["revoked_at"])}
        else:
            saved = db.execute("SELECT * FROM image_grants WHERE grant_id=?", (payload.get("grantId"),)).fetchone()
            if not saved:
                raise ValueError("IMAGE_ACCESS_DENIED")
            grant = json.loads(saved["payload"])
            if command == "image-revoke":
                image_owner(db, image_operation(db, grant), payload.get("issuerRef"))
                db.execute("UPDATE image_grants SET revoked_at=COALESCE(revoked_at,?) WHERE grant_id=?", (now, grant["grantId"]))
                value = {"grantId": grant["grantId"], "revoked": True}
            else:
                image_reject_output_grant(grant)
                if payload.get("deliveryGrantId"):
                    raise ValueError("IMAGE_DELIVERY_EFFECT_FORBIDDEN")
                request = grant["request"]
                if command == "image-submit":
                    request = image_contract("normalize", {"request": payload["request"]})
                    key = {"callerRef": request["caller"]["ref"], "jobId": request["jobId"], "scope": request["scope"]}
                else:
                    key = payload
                operation = image_access(db, grant, key)
                identity = (request["caller"]["ref"], request["jobId"])
                prior = db.execute("SELECT * FROM image_jobs WHERE caller_ref=? AND job_id=?", identity).fetchone()
                active = not saved["revoked_at"] and datetime.fromisoformat(grant["expiresAt"].replace("Z", "+00:00")) > datetime.now(timezone.utc)
                if command == "image-submit":
                    if request["requestDigest"] != grant["request"]["requestDigest"]:
                        raise ValueError("IMAGE_REQUEST_NOT_GRANTED")
                    if prior:
                        old = json.loads(prior["document"])
                        if (old["scope"] != request["scope"] or old["route"] != request["route"]
                                or old["controllerOperationId"] != grant["controllerOperationId"]):
                            raise ValueError("IMAGE_ACCESS_DENIED")
                        if prior["request_digest"] != request["requestDigest"]:
                            raise ValueError("IMAGE_IDEMPOTENCY_CONFLICT")
                        value = old
                    else:
                        if not active:
                            raise ValueError("IMAGE_GRANT_EXPIRED_OR_REVOKED")
                        sources = image_admission(db, operation, request, grant)
                        value = image_contract("initial", {"grant": grant, "at": now})
                        value["sourceTurnId"] = sources["sourceTurnId"]
                        db.execute("""INSERT INTO image_jobs(caller_ref,job_id,controller_operation_id,request_digest,
                            revision,status,document,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)""",
                            (*identity, grant["controllerOperationId"], request["requestDigest"], 1, value["status"], json.dumps(value), now, now))
                else:
                    if not prior:
                        raise ValueError("IMAGE_JOB_NOT_FOUND")
                    record = json.loads(prior["document"])
                    if (record["requestDigest"] != grant["request"]["requestDigest"]
                            or record["controllerOperationId"] != grant["controllerOperationId"]):
                        raise ValueError("IMAGE_ACCESS_DENIED")
                    if command in {"image-inspect", "image-result"}:
                        value = record if command == "image-inspect" else image_contract("result", {"record": record})
                    elif command == "image-apply":
                        event = payload["event"]
                        if payload.get("recovery"):
                            if event.get("type") not in {"observation", "export"} or (event.get("type") == "observation" and event.get("status") != "GENERATED"):
                                raise ValueError("IMAGE_RECOVERY_EFFECT_FORBIDDEN")
                            query = {**{k:payload[k] for k in ("grantId", "callerRef", "jobId", "scope")},
                                     **payload["recovery"], "action":"observe" if event["type"] == "observation" else "verify"}
                            image_recovery_admission(db, query)
                            if (event.get("attemptId") != query["attemptId"] or event.get("route") != query["route"]
                                    or (event["type"] == "observation" and (event.get("userMessageId") != query["userMessageId"] or event.get("turnId") != query["turnId"]))):
                                raise ValueError("IMAGE_RECOVERY_TURN_BINDING")
                        event_id = event.get("eventId")
                        digest = hashlib.sha256(json.dumps(event, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                        previous = db.execute("SELECT * FROM image_events WHERE caller_ref=? AND job_id=? AND event_id=?", (*identity,event_id)).fetchone()
                        if previous:
                            if previous["payload_hash"] != digest:
                                raise ValueError("IMAGE_EVENT_CONFLICT")
                            value = json.loads(previous["document"])
                            if event.get("type") == "beginAttempt":
                                value["effectAdmission"] = "RECONCILE_ONLY"
                        else:
                            if event.get("type") == "beginAttempt":
                                image_admission(db, operation, request, grant)
                                image_batch_reserve(db, record, payload, now)
                                if any((r["caller_ref"],r["job_id"]) != identity for r in image_session_reservations(db, request["route"])):
                                    raise ValueError("IMAGE_SESSION_BUSY")
                            value = image_contract("apply", {"record": record, "event": event, "grant": grant, "at": now, "grantActive": active})
                            encoded = json.dumps(value)
                            changed = db.execute("""UPDATE image_jobs SET revision=?,status=?,document=?,updated_at=?
                                WHERE caller_ref=? AND job_id=? AND revision=?""",
                                (value["revision"],value["status"],encoded,now,*identity,event["expectedRevision"]))
                            if changed.rowcount != 1:
                                raise ValueError("IMAGE_REVISION_CONFLICT")
                            db.execute("INSERT INTO image_events VALUES (?,?,?,?,?,?,?)", (*identity,event_id,digest,value["revision"],encoded,now))
                            if event.get("type") == "beginAttempt":
                                value["effectAdmission"] = "READ_ONLY_EXPORT" if request["operation"] == "export" else "NEWLY_RESERVED"
                    else:
                        raise ValueError("UNKNOWN_IMAGE_COMMAND")
        db.commit()
        return value
    except Exception:
        db.rollback()
        raise


def main():
    command, config_name, state_name, *args = sys.argv[1:]
    config, state = pathlib.Path(config_name), pathlib.Path(state_name)
    if command in {"image-batch-inspect", "image-batch-decision"}:
        print(json.dumps(image_batch_read(config, state, command, json.load(sys.stdin))))
        return
    if command in {"image-session-occupancy", "image-io-admission", "image-output-io-admission", "image-delivery-io-admission", "image-delivery-receipt"}:
        print(json.dumps(image_local_read(config, state, command, json.load(sys.stdin))))
        return
    if command == "control" and args and args[0] == "rotation-quarantine":
        db = connection(config, state, initialize=False)
        if "--confirm" not in args:
            db.execute("PRAGMA query_only=ON")
            db.execute("BEGIN")
    elif command in {"observe", "observation-context", "controller-placement-context", "delivery-attempts", "delivery-admission"}:
        db = connection(config, state, initialize=False)
        db.execute("PRAGMA query_only=ON")
    elif command in {"admission-check", "local-owner-contract"} and (state / "bridge.sqlite3").exists():
        db = connection(config, state, initialize=False)
        db.execute("PRAGMA query_only=ON")
        table = "control_state" if command == "admission-check" else "operations"
        # Legacy documents-only stores still need the first queue/control bootstrap.
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            db.close()
            db = connection(config, state)
    else:
        db = connection(config, state, initialize=command not in {"native-admission", "controller-placement-commit"})
    try:
        if command == "image-batch-create":
            value = image_batch_create(db, json.load(sys.stdin))
        elif command in {"image-authorize", "image-revoke", "image-submit", "image-inspect", "image-result", "image-apply"}:
            value = image_api(db, command, json.load(sys.stdin))
        elif command == "native-admission":
            row = db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone()
            if not row or not row["native_target"] or row["status"] != "DISPATCHING":
                raise ValueError("NATIVE_OPERATION_NOT_CLAIMED")
            if native_reservation(db, row["session_ref"], row["id"]):
                raise ValueError("TARGET_SESSION_BUSY")
            mode = management_mode(db, row["project"], row["workgroup_id"])
            if mode["mode"] != "RUNNING":
                raise ValueError("ADMISSION_" + mode["mode"])
            value = {"ok": True}
        elif command == "submit":
            if args:
                names = {"--request-id": "requestId", "--caller-ref": "callerRef", "--project": "project",
                         "--role": "role", "--session-ref": "sessionRef", "--message": "message", "--account": "account",
                         "--task": "taskId", "--model": "model", "--effort": "effort",
                         "--resource-policy-version": "resourcePolicyVersion", "--workgroup": "workgroup",
                         "--affinity-key": "affinityKey", "--runtime": "runtime",
                         "--native-host": "nativeHost", "--native-thread": "nativeThread",
                         "--native-cwd": "nativeCwd", "--native-socket": "nativeSocket",
                         "--routing-advice": "routingAdvicePath"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("submit options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = submit(db, payload)
        elif command == "native-create":
            if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
                raise ValueError("NATIVE_CREATE_HOST_LOCAL_REQUIRED")
            names = {"--native-host": "nativeHost", "--native-cwd": "nativeCwd", "--native-socket": "nativeSocket", "--model": "model", "--effort": "effort"}
            if "--confirm" not in args:
                raise ValueError("native-create requires --confirm")
            args = [item for item in args if item != "--confirm"]
            if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                raise ValueError("native-create options must be name/value pairs")
            payload = {names[args[i]]: args[i+1] for i in range(0, len(args), 2)}
            value = native_call({"action": "create", "nativeTarget": native_target(payload, creating=True),
                                 "model": payload.get("model") or "gpt-6-astra", "effort": payload.get("effort") or "xhigh"})
        elif command in {"native-read", "native-cancel"}:
            if os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID") or os.environ.get("CHAT_BRIDGE_FROM_SPACE"):
                raise ValueError("NATIVE_OPERATION_HOST_LOCAL_REQUIRED")
            row = db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone()
            if not row or not row["native_target"]:
                raise ValueError("NATIVE_OPERATION_REQUIRED")
            if command == "native-cancel":
                if "--confirm" not in args:
                    raise ValueError("native-cancel requires --confirm")
                authorize_control(db, project=row["project"])
                if row["local_owner"]:
                    local_caller(row["caller_ref"], json.loads(row["local_owner"]))
            diagnostic = {}
            value = native_call(native_operation_payload(row, "cancel" if command == "native-cancel" else "read"), diagnostic)
            if command == "native-cancel":
                if value.get("ok") and not value.get("cancelled"):
                    observed = native_call(native_operation_payload(row, "read"), diagnostic)
                    value["cancelled"] = bool(observed.get("ok") and observed.get("turnStatus") == "interrupted" and observed.get("turnId") == value.get("turnId"))
                prior = json.loads(row["result"]) if row["result"] else {}
                prior["cancelReceipt"] = {**value, **diagnostic}
                db.execute("UPDATE operations SET result=?,updated_at=? WHERE id=?", (json.dumps(prior), stamp(), row["id"]))
                if value.get("cancelled"):
                    db.execute("UPDATE operations SET status='CANCELLED',reason='NATIVE_TURN_INTERRUPTED' WHERE id=?", (row["id"],))
                db.commit()
        elif command == "checkpoint":
            if args:
                names={"--task":"taskId","--project":"project","--role":"role","--workgroup":"workgroupId","--session-ref":"sessionRef",
                       "--version":"version","--summary":"summary","--github":"github",
                       "--decisions":"decisions","--next":"next"}
                if len(args)%2 or any(args[i] not in names for i in range(0,len(args),2)):
                    raise ValueError("checkpoint options must be name/value pairs")
                payload={names[args[i]]:args[i+1] for i in range(0,len(args),2)}
            else:
                payload=json.load(sys.stdin)
            value=checkpoint(db,payload)
        elif command == "callback":
            value = callback(db, json.load(sys.stdin))
        elif command == "local-owner-contract":
            value = local_owner_contract(db, json.load(sys.stdin))
        elif command == "receive":
            if args:
                names = {"--task": "taskId", "--caller-ref": "callerRef", "--wait-seconds": "waitSeconds"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("receive options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = receive_local_result(db, payload)
        elif command == "result":
            if args:
                names = {"--task": "taskId", "--status": "status", "--summary": "summary",
                         "--github": "github", "--next": "next", "--result-version": "resultVersion"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("result options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = result(db, payload)
        elif command == "ack":
            if args:
                names = {"--task": "taskId", "--result-version": "resultVersion", "--caller-ref": "callerRef",
                         "--status": "status", "--message": "message"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("ack options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = result_ack(db, payload)
        elif command == "observation-context":
            payload = json.load(sys.stdin)
            value = observation_context(db, payload.get("operationId"), payload.get("candidate"))
        elif command == "observe":
            opts = dict(zip(args[::2], args[1::2]))
            if len(args) % 2 or set(opts) - {"--operation", "--candidate"} or not opts.get("--operation"):
                raise ValueError("observe requires --operation ID [--candidate CID]")
            value = observe_operation(db, opts["--operation"], opts.get("--candidate"))
        elif command == "controller-placement-context":
            value = controller_placement_context(db, json.load(sys.stdin)["sessionId"])
        elif command == "controller-placement-commit":
            value = controller_placement_commit(db, json.load(sys.stdin))
        elif command == "reattach-commit":
            value = reattach_commit(db, json.load(sys.stdin))
        elif command == "configure":
            value = configure(config, state, json.loads(args[0]) if args else json.load(sys.stdin))
        elif command == "migration-check":
            payload=json.load(sys.stdin)
            alias=str(payload.get("account") or "").strip()
            reg=registry(db); rt=runtime(db)
            identity=((reg.get("accounts") or {}).get(alias) or {}).get("identity")
            if not identity: raise ValueError("TARGET_IDENTITY_UNVERIFIED")
            stable=account_id(identity)
            aliases=[name for name,record in (reg.get("accounts") or {}).items() if record.get("identity")==identity]
            projects=[name for name,cfg in (reg.get("projects") or {}).items()
                      if any(a in (cfg.get("bindings") or {}) for a in aliases)]
            live=[task.get("taskId") for task in (rt.get("tasks") or {}).values()
                  if str(task.get("status") or "").upper() not in TERMINAL
                  and ((reg.get("accounts") or {}).get(task.get("account")) or {}).get("identity")==identity]
            pending=db.execute("""SELECT count(*) FROM operations WHERE account_id=?
                                  AND status IN ('QUEUED','DISPATCHING')""",(stable,)).fetchone()[0]
            unknown=[row[0] for row in db.execute("""SELECT id FROM operations WHERE account_id=?
                                  AND status='DELIVERY_UNKNOWN' ORDER BY created_at""",(stable,))]
            unacked=[row[0] for row in db.execute("""SELECT r.event_id FROM task_results r
                                  JOIN operations o ON o.id=r.callback_operation_id
                                  WHERE o.account_id=? AND r.callback_status='DELIVERED'
                                  AND r.acceptance_status IS NULL""",(stable,))]
            if projects:
                unacked.extend(row[0] for row in db.execute("""SELECT event_id FROM task_results
                                      WHERE callback_status='WAITING_ROUTE' AND owner_project IN (%s)
                                      AND acceptance_status IS NULL""" % ",".join("?" for _ in projects), projects).fetchall())
            invalid_bindings=[]
            for name in projects:
                for bound_alias in aliases:
                    binding=((reg.get("projects") or {}).get(name) or {}).get("bindings",{}).get(bound_alias)
                    if binding and (not binding.get("projectUrl") or not binding_observed(reg,bound_alias,binding)):
                        invalid_bindings.append({"project":name,"account":bound_alias})
            controls={name:management_mode(db,name) for name in projects}
            runnable=[name for name,value in controls.items() if value["mode"]=="RUNNING"]
            value={"account":alias,"aliases":aliases,"projects":projects,"liveTasks":live,
                   "pendingOperations":pending,"unknownOperations":unknown,"unacknowledgedCallbacks":unacked,
                   "invalidBindings":invalid_bindings,"controls":controls,
                   "safe":not live and not pending and not unknown and not unacked and not invalid_bindings and not runnable}
        elif command == "admission-check":
            project = (args[0] if args and not args[0].startswith("--") else "") or (registry(db).get("defaultProject") or "")
            workgroup = args[args.index("--workgroup") + 1] if "--workgroup" in args and args.index("--workgroup") + 1 < len(args) else None
            if not project:
                raise ValueError("project required")
            mode = management_mode(db, project, workgroup)
            if mode["mode"] in {"PAUSED", "DRAINING"}:
                raise ValueError("ADMISSION_" + mode["mode"])
            value = {"ok": True, "project": project, "control": mode}
        elif command == "control":
            sub = args[0] if args else "status"
            raw = args[1:]
            flags = {item for item in raw if item in {"--all", "--confirm", "--dry-run"}}
            pairs = [item for item in raw if item not in flags]
            if len(pairs) % 2:
                raise ValueError("control options must be name/value pairs")
            opts = {pairs[i]: pairs[i+1] for i in range(0,len(pairs),2)}
            project = opts.get("--project")
            workgroup = opts.get("--workgroup")
            caller_ref = opts.get("--caller-ref")
            global_scope = "--all" in flags
            if sub == "status":
                value = control_status(db, project, workgroup)
            elif sub in {"admin-list","admin-add","admin-remove"}:
                admin_sub = {"admin-list":"list","admin-add":"add","admin-remove":"remove"}[sub]
                value = configure_admin(config,state,db,admin_sub,opts.get("--target-ref"),"--confirm" in flags)
            elif sub in {"pause","drain","resume"}:
                if "--confirm" not in flags:
                    raise ValueError("control mutation requires --confirm")
                if not project and not global_scope:
                    raise ValueError("provide --project or --all")
                authorize_control(db,caller_ref,project,global_scope,workgroup)
                mode = {"pause":"PAUSED","drain":"DRAINING","resume":"RUNNING"}[sub]
                value = set_control_mode(db, None if global_scope else project, mode, opts.get("--reason"), workgroup)
            elif sub == "broadcast":
                if "--confirm" in flags:
                    authorize_control(db,caller_ref,project,not bool(project))
                value = broadcast_management(db,{
                    "project": project,
                    "kind": opts.get("--kind") or "NOTICE",
                    "message": opts.get("--message") or "",
                    "eventId": opts.get("--event"),
                    "confirm": "--confirm" in flags,
                })
            elif sub == "ack":
                value = acknowledge_management(db,{
                    "eventId": opts.get("--event"),
                    "callerRef": opts.get("--caller-ref"),
                    "status": opts.get("--status") or "ACKNOWLEDGED",
                    "message": opts.get("--message") or "",
                })
            elif sub == "workgroup":
                if "--confirm" not in flags:
                    raise ValueError("workgroup mutation requires --confirm")
                if not project:
                    raise ValueError("workgroup requires --project")
                authorize_control(db,caller_ref,project,False)
                try:
                    expected_revision = int(opts.get("--expected-revision") or 0)
                except ValueError:
                    raise ValueError("INVALID_WORKGROUP_REVISION")
                value = configure(config, state, {
                    "type": "workgroup", "project": project,
                    "workgroupId": opts.get("--workgroup-id"), "name": opts.get("--name"),
                    "controllerSessionRef": opts.get("--controller-session-ref"),
                    "parentWorkgroupId": opts.get("--parent-workgroup"),
                    "charterIssue": opts.get("--charter-issue"), "expectedRevision": expected_revision,
                    "dryRun": "--dry-run" in flags,
                })
            elif sub == "requirements":
                if "--confirm" not in flags:
                    raise ValueError("requirements requires --confirm")
                if not project:
                    raise ValueError("requirements requires --project")
                authorize_control(db,caller_ref,project,False)
                tools=[item for item in str(opts.get("--tools") or "").split(",") if item.strip()]
                value=configure_project_requirements(config,state,db,project,opts.get("--context-version"),tools)
            elif sub == "attest-location":
                if "--confirm" not in flags:
                    raise ValueError("attest-location requires --confirm")
                if not project or not opts.get("--account"):
                    raise ValueError("attest-location requires --project and --account")
                authorize_control(db,caller_ref,project,False)
                tools=[item for item in str(opts.get("--tools") or "").split(",") if item.strip()]
                value=attest_project_binding(config,state,db,project,opts.get("--account"),opts.get("--context-version"),tools,caller_ref)
            elif sub == "stop":
                if "--confirm" not in flags:
                    raise ValueError("stop requires --confirm")
                if not project and not global_scope:
                    raise ValueError("provide --project or --all")
                authorize_control(db,caller_ref,project,global_scope)
                value = enqueue_stop_requests(db,None if global_scope else project,opts.get("--task"))
            elif sub == "rotation-quarantine":
                if global_scope:
                    raise ValueError("ROTATION_QUARANTINE_EXACT_SCOPE_REQUIRED")
                value = rotation_quarantine(db, {"operationId": opts.get("--operation"), "callerRef": caller_ref,
                    "reason": opts.get("--reason"), "expected": opts.get("--expected"), "confirm": "--confirm" in flags})
            elif sub == "rotation-prepare":
                if "--confirm" not in flags:
                    raise ValueError("rotation prepare requires --confirm")
                authorize_control(db,caller_ref,project,False,opts.get("--workgroup"))
                value = rotation_prepare(db,{
                    "project": project,
                    "role": opts.get("--role"),
                    "workgroupId": opts.get("--workgroup"),
                    "logicalRef": opts.get("--logical-ref"),
                    "callerRef": caller_ref,
                    "quarantineEvent": opts.get("--quarantine-event"),
                    "handoff": opts.get("--handoff"),
                    "model": opts.get("--model"),
                    "effort": opts.get("--effort"),
                })
            elif sub == "rotation-recover":
                value = rotation_recover(db, {"operationId":opts.get("--operation"), "candidate":opts.get("--candidate"),
                    "expected":opts.get("--expected"), "confirm":"--confirm" in flags})
            elif sub == "rotation-ack":
                value = rotation_ack(db,{
                    "rotationId": opts.get("--rotation"),
                    "callerRef": opts.get("--caller-ref"),
                    "message": opts.get("--message") or "",
                },config,state)
            else:
                raise ValueError("UNKNOWN_CONTROL_COMMAND")
        elif command == "delivery-admission":
            context = json.load(sys.stdin)
            row = delivery_attempt_module().verify_current(state, db, context)
            identity = ((registry(db).get("accounts") or {}).get(row["account_alias"]) or {}).get("identity")
            if not identity or account_id(identity) != row["account_id"]:
                raise ValueError("DELIVERY_ACCOUNT_IDENTITY_CHANGED")
            origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
            if origin and origin != row["account_id"]:
                raise ValueError("DELIVERY_EVIDENCE_ORIGIN_MISMATCH")
            if row["kind"] in {"dispatch", "rotation"}:
                mode = management_mode(db, row["project"], row["workgroup_id"])
                if mode["mode"] in {"PAUSED", "DRAINING"} or mode.get("scope") != row["control_scope"] or int(mode.get("epoch") or 0) != int(row["control_epoch"] or 0):
                    raise ValueError("DELIVERY_ADMISSION_CHANGED")
            value = {"ok": True, "operationId": row["id"], "claimOrdinal": row["attempts"]}
        elif command == "delivery-attempts":
            if len(args) != 2 or args[0] != "--operation":
                raise ValueError("delivery-attempts requires --operation ID")
            row = db.execute("SELECT * FROM operations WHERE id=?", (args[1],)).fetchone()
            if not row:
                raise ValueError("OPERATION_NOT_FOUND")
            origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
            if origin and origin != row["account_id"]:
                raise ValueError("DELIVERY_EVIDENCE_ORIGIN_MISMATCH")
            value = delivery_attempt_module().inspect(state, row["id"])
            value["operationStatus"] = row["status"]
        elif command == "status":
            value = observed_response(db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone(), {**(runtime(db).get("tasks") or {}), **native_tasks(db)})
        elif command == "reconcile":
            if len(args)!=2 or args[0]!="--operation":
                raise ValueError("reconcile requires --operation ID")
            with bridge_cancellation():
                value = reconcile_delivery(db,args[1])
        elif command == "retry":
            if len(args)!=2 or args[0]!="--operation":
                raise ValueError("retry requires --operation ID")
            begin_immediate(db)
            prior = db.execute("SELECT * FROM operations WHERE id=? AND status='FAILED_PRE_SEND'", (args[1],)).fetchone()
            if prior and prior["native_target"] and native_reservation(db, prior["session_ref"], prior["id"]):
                raise ValueError("TARGET_SESSION_BUSY")
            changed = db.execute("UPDATE operations SET status='QUEUED',pre_send_failures=0,not_before=?,updated_at=? WHERE id=? AND status='FAILED_PRE_SEND'",
                                 (time.time(),stamp(),args[1]))
            if changed.rowcount != 1:
                raise ValueError("RETRY_REQUIRES_PROVEN_PRE_SEND_FAILURE")
            if prior["kind"] == "callback":
                db.execute("UPDATE task_results SET callback_status='QUEUED' WHERE callback_operation_id=?", (args[1],))
            if prior["kind"] == "management":
                db.execute("UPDATE management_deliveries SET status='QUEUED',updated_at=? WHERE operation_id=?", (stamp(),args[1]))
            db.commit()
            value = response(db.execute("SELECT * FROM operations WHERE id=?", (args[1],)).fetchone())
        elif command == "cancel":
            now = stamp()
            row = db.execute("SELECT kind,event_id FROM operations WHERE id=? AND status='QUEUED'", (args[0],)).fetchone()
            db.execute("UPDATE operations SET status='CANCELLED',updated_at=? WHERE id=? AND status='QUEUED'", (now, args[0]))
            if row:
                if row["kind"] == "management" and row["event_id"]:
                    db.execute("UPDATE management_deliveries SET status='CANCELLED',updated_at=? WHERE operation_id=?", (now,args[0]))
                if row["kind"] == "callback" and row["event_id"] and str(row["event_id"]).startswith("result:"):
                    db.execute("UPDATE task_results SET callback_status='CANCELLED' WHERE event_id=?", (row["event_id"],))
            db.commit()
            value = response(db.execute("SELECT * FROM operations WHERE id=?", (args[0],)).fetchone())
        elif command == "work-one":
            with bridge_cancellation():
                value = work_one(db)
        elif command == "recover":
            db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_INTERRUPTED',updated_at=? WHERE status='DISPATCHING' AND claimed_at<?",
                       (stamp(), time.time() - interrupted_claim_timeout()))
            db.commit()
            value = {"recoveredUnknown": db.total_changes}
        elif command == "list":
            tasks = {**(runtime(db).get("tasks") or {}), **native_tasks(db)}
            value = {"operations": [observed_response(row, tasks) for row in db.execute("SELECT * FROM operations ORDER BY created_at DESC LIMIT 100")]}
        elif command == "serve":
            db.close()
            serve(config, state)
            return
        else:
            raise ValueError("UNKNOWN_COORDINATOR_COMMAND")
        print(json.dumps(value, ensure_ascii=False))
        if command in {"native-create", "native-read", "native-cancel"} and value.get("ok") is False:
            raise SystemExit(2)
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except OperationObservationError as error:
        print(json.dumps(error.detail, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(error.exit_code)
    except (ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
