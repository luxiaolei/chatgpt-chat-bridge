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


EFFORTS = {"Instant", "Medium", "High", "Extra High", "Pro"}
TERMINAL = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "RESULT_RECORDED"}


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


def management_mode(db, project):
    scopes = ("global", "project:" + project)
    rows = db.execute(
        "SELECT scope,mode,epoch,reason,updated_at FROM control_state WHERE scope IN (?,?)",
        scopes,
    ).fetchall()
    priority = {"RUNNING": 0, "DRAINING": 1, "PAUSED": 2}
    selected = {"mode": "RUNNING", "epoch": 0, "reason": None, "scope": None, "updatedAt": None}
    for row in rows:
        if priority.get(row["mode"], 0) >= priority.get(selected["mode"], 0):
            selected = {"mode": row["mode"], "epoch": row["epoch"], "reason": row["reason"],
                        "scope": row["scope"], "updatedAt": row["updated_at"]}
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
    db.execute("""CREATE TABLE IF NOT EXISTS logical_sessions (
        logical_ref TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT NOT NULL,
        current_session_ref TEXT, epoch INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'ACTIVE',
        pending_session_ref TEXT, handoff_hash TEXT, rotation_id TEXT, updated_at TEXT NOT NULL
    )""")
    ensure_column(db, "logical_sessions", "rotation_id", "TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS session_successors (
        old_session_ref TEXT PRIMARY KEY, logical_ref TEXT NOT NULL, successor_ref TEXT NOT NULL,
        epoch INTEGER NOT NULL, committed_at TEXT NOT NULL
    )""")
    db.execute("""CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT NOT NULL, result_version TEXT NOT NULL, event_id TEXT NOT NULL,
        status TEXT NOT NULL, summary TEXT NOT NULL, github TEXT, next_text TEXT,
        payload_hash TEXT NOT NULL, callback_operation_id TEXT, callback_status TEXT,
        callback_delivered_at TEXT, acceptance_status TEXT, acceptance_message TEXT,
        recorded_at TEXT NOT NULL, accepted_at TEXT,
        PRIMARY KEY(task_id,result_version)
    )""")
    ensure_column(db, "task_results", "callback_status", "TEXT")
    ensure_column(db, "task_results", "callback_delivered_at", "TEXT")
    db.execute("""CREATE TABLE IF NOT EXISTS session_checkpoints (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, role TEXT NOT NULL, session_ref TEXT,
        task_id TEXT, version TEXT NOT NULL, summary TEXT NOT NULL, github TEXT,
        decisions TEXT, next_text TEXT, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(project,role,version)
    )""")
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


def public(row):
    if row is None:
        raise ValueError("UNKNOWN_OPERATION")
    item = {key: row[key] for key in ("id", "kind", "status", "project", "account_alias", "account_id",
                                      "caller_ref", "session_ref", "role", "task_id", "created_at", "updated_at",
                                      "not_before", "attempts", "reason")}
    keys = set(row.keys())
    for key in ("requested_model", "requested_effort", "resource_policy_version", "workgroup_id",
                "affinity_key", "placement_key", "event_id"):
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
    }
    for source, target in aliases.items():
        if source in result:
            result[target] = result.pop(source)
    return result


def observed_response(row, tasks):
    value = response(row)
    task = tasks.get(row["task_id"]) if row["kind"] == "dispatch" else None
    if task:
        value["taskStatus"] = task.get("status")
    return value


def control_footer(task_id, caller_ref, role, model, effort, policy_version):
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
    return "\n".join(lines)


def submit(db, payload):
    caller = str(payload.get("callerRef") or "").strip()
    request_id = str(payload.get("requestId") or "").strip()
    original_message = str(payload.get("message") or "")
    if not caller or not request_id or not original_message or len(request_id) > 128 or len(original_message) > 100000:
        raise ValueError("callerRef, requestId and nonempty message are required")
    requested_model = str(payload.get("model") or "").strip() or None
    if requested_model and len(requested_model) > 80:
        raise ValueError("INVALID_MODEL")
    requested_effort = normalize_effort(payload.get("effort"))
    policy_version = str(payload.get("resourcePolicyVersion") or "v1").strip() or "v1"
    workgroup = str(payload.get("workgroup") or "").strip() or None
    affinity = str(payload.get("affinityKey") or "").strip() or None
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
        mode = management_mode(db, project)
        if mode["mode"] in {"PAUSED", "DRAINING"}:
            raise ValueError("ADMISSION_" + mode["mode"])

        target = str(payload.get("sessionRef") or "").strip() or None
        role = str(payload.get("role") or "").strip()
        target_chat = (reg.get("chats") or {}).get(target) if target else None
        if target and (not target_chat or target_chat.get("project") != project or target_chat.get("status", "active") != "active"):
            raise ValueError("TARGET_SESSION_NOT_REGISTERED")
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
                       and (not workgroup or chat.get("workgroupId") in (None, workgroup))]
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

        operation_id = str(uuid.uuid4())
        task_id = str(payload.get("taskId") or "Q-" + operation_id)
        if not task_id or len(task_id) > 128 or not all(ch.isalnum() or ch in "._:-" for ch in task_id):
            raise ValueError("INVALID_TASK_ID")
        prior_unknown=db.execute("""SELECT id FROM operations WHERE kind='dispatch' AND task_id=? AND status='DELIVERY_UNKNOWN'
                                    ORDER BY created_at DESC LIMIT 1""",(task_id,)).fetchone()
        if prior_unknown:
            raise ValueError("TASK_DELIVERY_UNKNOWN_RECONCILE_REQUIRED:"+prior_unknown["id"])
        message = original_message + control_footer(task_id, caller, role, requested_model, requested_effort, policy_version)
        now = stamp()
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,requested_model,requested_effort,
            resource_policy_version,workgroup_id,affinity_key,placement_key,original_message)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,digest,"QUEUED",project,alias,stable,caller,target,role,message,task_id,now,now,time.time(),
             requested_model,requested_effort,policy_version,workgroup,affinity,placement_key,original_message))
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
    if task:
        return task
    row = db.execute("""SELECT project,account_alias,caller_ref,session_ref,role,workgroup_id
                        FROM operations WHERE kind='dispatch' AND task_id=?
                        ORDER BY created_at DESC LIMIT 1""", (task_id,)).fetchone()
    if not row:
        return None
    return {
        "taskId": task_id,
        "project": row["project"],
        "account": row["account_alias"],
        "controllerSessionRef": row["caller_ref"],
        "replyToSessionRef": row["caller_ref"],
        "sessionId": row["session_ref"],
        "role": row["role"],
        "workgroupId": row["workgroup_id"],
    }


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
    target_ref = resolve_callback_target(db, reg, task, requested_target)
    target = (reg.get("chats") or {}).get(target_ref)
    if not target or target.get("status", "active") != "active":
        raise ValueError("CALLBACK_TARGET_NOT_REGISTERED")
    if target.get("project") != task.get("project"):
        raise ValueError("CALLBACK_PROJECT_MISMATCH")
    alias = target.get("account")
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    if not identity:
        raise ValueError("CALLBACK_ACCOUNT_UNVERIFIED")
    digest = hashlib.sha256(message.encode()).hexdigest()
    stable_event = event_id or digest
    key = "callback:" + task_id + ":" + target_ref + ":" + stable_event
    db.execute("BEGIN IMMEDIATE")
    try:
        prior = db.execute("SELECT * FROM operations WHERE request_key=?", (key,)).fetchone()
        if prior:
            db.commit()
            return response(prior)
        operation_id, now = str(uuid.uuid4()), stamp()
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,event_id,original_message)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,digest,"QUEUED",target["project"],alias,account_id(identity),target_ref,target_ref,
             target.get("role") or target_ref,message,task_id,now,now,time.time(),"callback",event_id,message))
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
    if task_id:
        task=task_contract(db,task_id)
        if not task: raise ValueError("CHECKPOINT_TASK_NOT_REGISTERED")
        project=project or task.get("project")
        role=role or task.get("role")
        session_ref=session_ref or task.get("sessionId")
    summary=str(payload.get("summary") or "").strip()
    github=str(payload.get("github") or "").strip()
    decisions=str(payload.get("decisions") or "").strip()
    next_text=str(payload.get("next") or "").strip()
    if not project or not role or not summary:
        raise ValueError("checkpoint requires project, role and summary")
    raw={"project":project,"role":role,"sessionRef":session_ref,"taskId":task_id,"summary":summary,
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
    prior=db.execute("SELECT * FROM session_checkpoints WHERE project=? AND role=? AND version=?",
                     (project,role,version)).fetchone()
    if prior:
        if prior["payload_hash"]!=digest: raise ValueError("CHECKPOINT_VERSION_CONFLICT")
        return dict(prior)
    checkpoint_id=str(uuid.uuid4()); now=stamp()
    db.execute("""INSERT INTO session_checkpoints(
        id,project,role,session_ref,task_id,version,summary,github,decisions,next_text,payload_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (checkpoint_id,project,role,session_ref,task_id,version,summary,github or None,decisions or None,next_text or None,digest,now))
    db.commit()
    return {"checkpointId":checkpoint_id,"project":project,"role":role,"sessionRef":session_ref,
            "taskId":task_id,"version":version,"summary":summary,"github":github or None,
            "decisions":decisions or None,"next":next_text or None,"createdAt":now}


def latest_checkpoint(db, project, role):
    row=db.execute("""SELECT * FROM session_checkpoints WHERE project=? AND role=?
                      ORDER BY created_at DESC,id DESC LIMIT 1""",(project,role)).fetchone()
    return dict(row) if row else None


def checkpoint_handoff(row):
    if not row: return None
    lines=[f"Checkpoint version: {row['version']}",f"Summary: {row['summary']}"]
    if row.get("github"): lines.append("GitHub/durable evidence: "+row["github"])
    if row.get("decisions"): lines.append("Decisions/constraints: "+row["decisions"])
    if row.get("next_text"): lines.append("Next: "+row["next_text"])
    if row.get("task_id"): lines.append("Task: "+row["task_id"])
    return "\n".join(lines)


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
        callback_row = db.execute("SELECT * FROM operations WHERE id=?", (prior["callback_operation_id"],)).fetchone()
        return {"resultRecorded":True,"taskId":task_id,"resultVersion":version,"eventId":prior["event_id"],
                "callback":response(callback_row) if callback_row else None,
                "acceptanceStatus":prior["acceptance_status"]}

    reg = registry(db)
    target_ref = resolve_callback_target(db, reg, task, None)
    target = (reg.get("chats") or {}).get(target_ref)
    if not target or target.get("status", "active") != "active":
        raise ValueError("CALLBACK_TARGET_NOT_REGISTERED")
    alias = target.get("account")
    identity = ((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    if not identity:
        raise ValueError("CALLBACK_ACCOUNT_UNVERIFIED")
    lines = ["[RESULT]",f"task_id: {task_id}",f"status: {status}",f"result_version: {version}"]
    if github: lines.append("github: "+github)
    lines.append("summary: "+summary)
    if next_text: lines.append("next: "+next_text)
    lines += ["",f"Controller acknowledgement: chat-bridge queue ack --task {task_id} --result-version {version} --caller-ref YOUR_SESSION_REF --status ACCEPTED --message <review>"]
    message="\n".join(lines)
    operation_id, now = str(uuid.uuid4()), stamp()
    request_key="callback:"+task_id+":"+target_ref+":"+event_id
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,event_id,original_message)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,request_key,hashlib.sha256(message.encode()).hexdigest(),"QUEUED",target["project"],alias,
             account_id(identity),target_ref,target_ref,target.get("role") or target_ref,message,task_id,
             now,now,time.time(),"callback",event_id,message))
        db.execute("""INSERT INTO task_results(
            task_id,result_version,event_id,status,summary,github,next_text,payload_hash,
            callback_operation_id,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (task_id,version,event_id,status,summary,github or None,next_text or None,digest,operation_id,now))
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
            if github: live["github"]=github
            live["externalResponsePending"]=False
            live["updatedAt"]=now
            db.execute("UPDATE documents SET payload=? WHERE kind=?",(json.dumps(rt,ensure_ascii=False),"runtime"))
        db.commit()
    except Exception:
        db.rollback()
        raise
    callback_row=db.execute("SELECT * FROM operations WHERE id=?",(operation_id,)).fetchone()
    return {"resultRecorded":True,"taskId":task_id,"resultVersion":version,"eventId":event_id,
            "reportedStatus":status,"callback":response(callback_row),"acceptanceStatus":None}


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
    reg=registry(db)
    expected=resolve_callback_target(db,reg,task,None)
    if caller!=expected:
        raise ValueError("RESULT_ACK_TARGET_MISMATCH")
    chat=(reg.get("chats") or {}).get(expected)
    identity=((reg.get("accounts") or {}).get(chat.get("account")) or {}).get("identity") if chat else None
    origin=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin and (not identity or account_id(identity)!=origin):
        raise ValueError("RESULT_ACK_ORIGIN_ACCOUNT_MISMATCH")
    now=stamp()
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("""UPDATE task_results SET acceptance_status=?,acceptance_message=?,accepted_at=?
                      WHERE task_id=? AND result_version=?""",(status,message,now,task_id,version))
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


def put_registry_projection(config, state, base, next_value):
    store = str(pathlib.Path(__file__).with_name("state-store.py"))
    completed = subprocess.run(
        [sys.executable, store, "put", str(config), str(state), "registry"],
        input=json.dumps({"base": base, "next": next_value}),
        capture_output=True, text=True, timeout=20,
    )
    if completed.returncode:
        raise ValueError(completed.stderr.strip() or "REGISTRY_WRITE_FAILED")


def authorize_control(db, caller_ref=None, project=None, global_scope=False):
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


def set_control_mode(db, project, mode, reason=None):
    mode = str(mode or "").upper()
    if mode not in {"RUNNING", "PAUSED", "DRAINING"}:
        raise ValueError("INVALID_CONTROL_MODE")
    scope = "global" if not project else "project:" + project
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


def current_controller_ref(db, reg, project, role):
    row = db.execute("""SELECT current_session_ref FROM logical_sessions
                        WHERE project=? AND role=? AND state='ACTIVE'
                        ORDER BY epoch DESC LIMIT 1""", (project, role)).fetchone()
    if row and row["current_session_ref"]:
        chat = (reg.get("chats") or {}).get(row["current_session_ref"])
        if chat and chat.get("status", "active") == "active":
            return row["current_session_ref"]
    matches = [chat["id"] for chat in (reg.get("chats") or {}).values()
               if chat.get("project") == project and chat.get("role") == role
               and chat.get("status", "active") == "active"]
    if len(matches) == 1:
        return matches[0]
    return None


def control_status(db, project=None):
    reg, rt = registry(db), runtime(db)
    projects = []
    for name, cfg in (reg.get("projects") or {}).items():
        if project and name != project:
            continue
        tasks = [task for task in (rt.get("tasks") or {}).values() if task.get("project") == name]
        task_counts = {}
        for task in tasks:
            key = str(task.get("status") or "UNKNOWN").upper()
            task_counts[key] = task_counts.get(key, 0) + 1
        operation_rows = db.execute(
            "SELECT status,kind,count(*) AS n FROM operations WHERE project=? GROUP BY status,kind", (name,)
        ).fetchall()
        operation_counts = {(row["kind"], row["status"]): row["n"] for row in operation_rows}
        result_rows = db.execute("""SELECT tr.* FROM task_results tr
            JOIN operations op ON op.task_id=tr.task_id AND op.kind='dispatch'
            WHERE op.project=? GROUP BY tr.task_id,tr.result_version""", (name,)).fetchall()
        results = {
            "recorded": len(result_rows),
            "callbackPending": sum(1 for row in result_rows if not row["callback_status"]
                                   or row["callback_status"] in {"QUEUED","DISPATCHING"}),
            "callbackUnknown": sum(1 for row in result_rows if row["callback_status"]=="DELIVERY_UNKNOWN"),
            "awaitingControllerAck": sum(1 for row in result_rows
                                         if row["callback_status"]=="DELIVERED" and not row["acceptance_status"]),
            "accepted": sum(1 for row in result_rows if row["acceptance_status"]=="ACCEPTED"),
            "rejectedOrBlocked": sum(1 for row in result_rows if row["acceptance_status"] in {"REJECTED","BLOCKED"}),
        }
        mgmt = db.execute("""SELECT
              sum(CASE WHEN d.status='ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged,
              sum(CASE WHEN d.status NOT IN ('ACKNOWLEDGED') THEN 1 ELSE 0 END) AS pending
            FROM management_deliveries d JOIN management_events e ON e.id=d.event_id
            WHERE e.scope IN ('global',?)""", ("project:"+name,)).fetchone()
        pending_business_ops = sum(n for (kind,status),n in operation_counts.items()
                                   if kind in {"dispatch","rotation","stop"} and status in {"QUEUED","DISPATCHING"})
        pending_callback_ops = sum(n for (kind,status),n in operation_counts.items()
                                   if kind=="callback" and status in {"QUEUED","DISPATCHING"})
        unknown_ops = sum(n for (kind,status),n in operation_counts.items() if status=="DELIVERY_UNKNOWN")
        active_tasks = sum(count for status,count in task_counts.items() if status not in TERMINAL)
        blocked = task_counts.get("BLOCKED",0)
        failed = task_counts.get("FAILED",0)
        cancelled = task_counts.get("CANCELLED",0)
        awaiting_durable = task_counts.get("AWAITING_DURABLE_UPDATE",0)
        awaiting_ack = task_counts.get("RESULT_RECORDED",0)
        pending_management = int((mgmt["pending"] if mgmt and mgmt["pending"] is not None else 0) or 0)

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
        projects.append({
            "project": name,
            "control": management_mode(db, name),
            "rootRole": root_role,
            "rootControllerSessionRef": controller,
            "tasks": {
                "total": len(tasks),
                "active": active_tasks,
                "blocked": blocked,
                "failed": failed,
                "cancelled": cancelled,
                "awaitingDurable": awaiting_durable,
                "resultRecorded": awaiting_ack,
                "complete": task_counts.get("COMPLETE",0),
                "byStatus": task_counts,
            },
            "results": results,
            "operations": [{"status": row["status"], "kind": row["kind"], "count": row["n"]} for row in operation_rows],
            "operationSummary": {"pendingBusiness": pending_business_ops, "pendingCallbacks": pending_callback_ops, "unknown": unknown_ops},
            "management": {
                "acknowledged": int((mgmt["acknowledged"] if mgmt and mgmt["acknowledged"] is not None else 0) or 0),
                "pending": pending_management,
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
    db.execute("BEGIN IMMEDIATE")
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


def rotation_prepare(db, payload):
    project = str(payload.get("project") or "").strip()
    role = str(payload.get("role") or "").strip()
    handoff = str(payload.get("handoff") or "").strip()
    if not project or not role:
        raise ValueError("project and role are required")
    if not handoff:
        handoff=checkpoint_handoff(latest_checkpoint(db,project,role)) or ""
    if not handoff:
        raise ValueError("handoff required when no checkpoint exists")
    reg = registry(db)
    cfg = (reg.get("projects") or {}).get(project)
    if not cfg:
        raise ValueError("PROJECT_NOT_REGISTERED")
    logical_ref = str(payload.get("logicalRef") or f"project:{project}:role:{role}")
    current = current_controller_ref(db, reg, project, role)
    if not current:
        raise ValueError("CURRENT_ROLE_SESSION_NOT_UNIQUE")
    old_chat = (reg.get("chats") or {}).get(current)
    if not old_chat:
        raise ValueError("CURRENT_ROLE_SESSION_NOT_REGISTERED")
    existing = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (logical_ref,)).fetchone()
    if existing and existing["state"] == "ROTATING":
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
        f"chat-bridge control rotation-ack --rotation {rotation_id} --message <verification-summary>",
        "Do not replay completed work before acknowledgement.",
        "[/CHATBRIDGE ROLE HANDOFF]",
    ])
    identity = ((reg.get("accounts") or {}).get(old_chat.get("account")) or {}).get("identity")
    if not identity:
        raise ValueError("ROTATION_ACCOUNT_UNVERIFIED")
    operation_id, now = str(uuid.uuid4()), stamp()
    task_id = "ROT-" + rotation_id
    key = "rotation:" + rotation_id
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("""INSERT INTO logical_sessions(
            logical_ref,project,role,current_session_ref,epoch,state,pending_session_ref,handoff_hash,rotation_id,updated_at)
            VALUES (?,?,?,?,?,'ROTATING',NULL,?,?,?)
            ON CONFLICT(logical_ref) DO UPDATE SET project=excluded.project,role=excluded.role,
              current_session_ref=excluded.current_session_ref,state='ROTATING',pending_session_ref=NULL,
              handoff_hash=excluded.handoff_hash,rotation_id=excluded.rotation_id,updated_at=excluded.updated_at""",
            (logical_ref,project,role,current,epoch,handoff_hash,rotation_id,now))
        db.execute("""INSERT INTO operations(
            id,request_key,payload_hash,status,project,account_alias,account_id,caller_ref,session_ref,
            role,message,task_id,created_at,updated_at,not_before,kind,requested_model,requested_effort,
            resource_policy_version,placement_key,original_message,force_new,rotation_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (operation_id,key,handoff_hash,"QUEUED",project,old_chat["account"],account_id(identity),
             current,None,role,message,task_id,now,now,time.time(),"rotation",requested_model,requested_effort,
             "rotation-v1",logical_placement_key(project,None,role,rotation_id),handoff,1,rotation_id))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {"rotationId": rotation_id, "logicalRef": logical_ref, "project": project, "role": role,
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
    identity = ((reg.get("accounts") or {}).get(successor_chat.get("account")) or {}).get("identity")
    origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
    if origin and (not identity or account_id(identity) != origin):
        raise ValueError("ROTATION_ACK_ORIGIN_MISMATCH")
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
    db.execute("BEGIN IMMEDIATE")
    try:
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


def claim(db):
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("UPDATE operations SET status='DELIVERY_UNKNOWN',reason='WORKER_INTERRUPTED',updated_at=? WHERE status='DISPATCHING' AND claimed_at<?",
                   (stamp(), time.time() - 300))
        row = db.execute("""SELECT * FROM operations AS candidate WHERE status='QUEUED' AND not_before<=?
            AND NOT EXISTS (SELECT 1 FROM operations AS active WHERE active.status='DISPATCHING' AND active.account_id=candidate.account_id)
            ORDER BY CASE candidate.kind WHEN 'management' THEN 0 WHEN 'callback' THEN 1 WHEN 'rotation' THEN 2 ELSE 3 END,
                     created_at,id LIMIT 1""", (time.time(),)).fetchone()
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
    for stream in (completed.stdout or "", completed.stderr or ""):
        text = stream.strip()
        if not text:
            continue
        candidates = [text, *reversed([line.strip() for line in text.splitlines() if line.strip()])]
        for candidate in candidates:
            try:
                value = json.loads(candidate)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def work_one(db):
    row = claim(db)
    if row is None:
        return {"status": "IDLE"}
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
        completed = subprocess.run(args, capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as error:
        return finish(db, row, "DELIVERY_UNKNOWN", type(error).__name__)
    receipt = parse_worker_receipt(completed)
    if completed.returncode == 75:
        detail = receipt or {}
        if detail.get("code") in {"PACING_DEFERRED", "WEB_COOLDOWN_ACTIVE"}:
            return finish(db, row, "QUEUED", detail.get("reason"), max(1, float(detail.get("retryAfterSec", 10))))
    combined = (completed.stderr or "") + "\n" + (completed.stdout or "")
    if completed.returncode and any(token in combined for token in ("CHAT_BUSY", "USER_DRAFT_PRESENT", "SPACE_IN_USER_CONTROL")):
        reason = "TARGET_USER_CONTROLLED" if "SPACE_IN_USER_CONTROL" in combined else "TARGET_BUSY_OR_DRAFT"
        return finish(db, row, "QUEUED", reason, 30)
    if completed.returncode:
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_EXIT_" + str(completed.returncode))
    if receipt is None:
        return finish(db, row, "DELIVERY_UNKNOWN", "WORKER_RECEIPT_UNREADABLE")
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
        recorded = subprocess.run(record_args, capture_output=True, text=True, timeout=30)
        if recorded.returncode:
            return finish(db, row, "DELIVERY_UNKNOWN", "TASK_RECORD_NOT_CONFIRMED", session_ref=target)
    result_payload = {"delivered": True, "modelSelection": receipt.get("modelSelection")}
    return finish(db, row, "SENT", result=result_payload, session_ref=target)


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
                         "--role": "role", "--session-ref": "sessionRef", "--message": "message", "--account": "account",
                         "--task": "taskId", "--model": "model", "--effort": "effort",
                         "--resource-policy-version": "resourcePolicyVersion", "--workgroup": "workgroup",
                         "--affinity-key": "affinityKey"}
                if len(args) % 2 or any(args[i] not in names for i in range(0, len(args), 2)):
                    raise ValueError("submit options must be name/value pairs")
                payload = {names[args[i]]: args[i + 1] for i in range(0, len(args), 2)}
            else:
                payload = json.load(sys.stdin)
            value = submit(db, payload)
        elif command == "checkpoint":
            if args:
                names={"--task":"taskId","--project":"project","--role":"role","--session-ref":"sessionRef",
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
            controls={name:management_mode(db,name) for name in projects}
            runnable=[name for name,value in controls.items() if value["mode"]=="RUNNING"]
            value={"account":alias,"aliases":aliases,"projects":projects,"liveTasks":live,
                   "pendingOperations":pending,"controls":controls,"safe":not live and not pending and not runnable}
        elif command == "admission-check":
            project = (args[0] if args else "") or (registry(db).get("defaultProject") or "")
            if not project:
                raise ValueError("project required")
            mode = management_mode(db, project)
            if mode["mode"] in {"PAUSED", "DRAINING"}:
                raise ValueError("ADMISSION_" + mode["mode"])
            value = {"ok": True, "project": project, "control": mode}
        elif command == "control":
            sub = args[0] if args else "status"
            raw = args[1:]
            flags = {item for item in raw if item in {"--all", "--confirm"}}
            pairs = [item for item in raw if item not in flags]
            if len(pairs) % 2:
                raise ValueError("control options must be name/value pairs")
            opts = {pairs[i]: pairs[i+1] for i in range(0,len(pairs),2)}
            project = opts.get("--project")
            caller_ref = opts.get("--caller-ref")
            global_scope = "--all" in flags
            if sub == "status":
                value = control_status(db, project)
            elif sub in {"admin-list","admin-add","admin-remove"}:
                admin_sub = {"admin-list":"list","admin-add":"add","admin-remove":"remove"}[sub]
                value = configure_admin(config,state,db,admin_sub,opts.get("--target-ref"),"--confirm" in flags)
            elif sub in {"pause","drain","resume"}:
                if "--confirm" not in flags:
                    raise ValueError("control mutation requires --confirm")
                if not project and not global_scope:
                    raise ValueError("provide --project or --all")
                authorize_control(db,caller_ref,project,global_scope)
                mode = {"pause":"PAUSED","drain":"DRAINING","resume":"RUNNING"}[sub]
                value = set_control_mode(db, None if global_scope else project, mode, opts.get("--reason"))
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
            elif sub == "rotation-prepare":
                if "--confirm" not in flags:
                    raise ValueError("rotation prepare requires --confirm")
                authorize_control(db,caller_ref,project,False)
                value = rotation_prepare(db,{
                    "project": project,
                    "role": opts.get("--role"),
                    "logicalRef": opts.get("--logical-ref"),
                    "handoff": opts.get("--handoff"),
                    "model": opts.get("--model"),
                    "effort": opts.get("--effort"),
                })
            elif sub == "rotation-ack":
                value = rotation_ack(db,{
                    "rotationId": opts.get("--rotation"),
                    "message": opts.get("--message") or "",
                },config,state)
            else:
                raise ValueError("UNKNOWN_CONTROL_COMMAND")
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
