#!/usr/bin/env python3
"""Transactional Bridge state; JSON files are compatibility projections."""
import json
import hashlib
import re
import uuid
from datetime import datetime
import os
import pathlib
import sqlite3
import sys
import tempfile
import time

MISSING = object()
KINDS = {"registry", "runtime"}


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def differences(before, after, path=()):
    if isinstance(before, dict) and isinstance(after, dict):
        for key in before.keys() | after.keys():
            old = before.get(key, MISSING)
            new = after.get(key, MISSING)
            if old is MISSING and isinstance(new, dict) and new:
                yield from differences({}, new, path + (key,))
            elif old is MISSING or new is MISSING:
                yield path + (key,), old, new
            else:
                yield from differences(old, new, path + (key,))
    elif before != after:
        yield path, before, after


def value_at(document, path):
    value = document
    for key in path:
        if not isinstance(value, dict) or key not in value:
            return MISSING
        value = value[key]
    return value


def merge_runtime_volatile(kind, path, current, new):
    """Merge only reconstructable monotonic runtime metadata.

    Project updatedAt is a heartbeat/cache timestamp, not business state. Two
    legitimate writers may touch it while independently updating tasks or
    capacity. Keep the later valid ISO timestamp. Every other path retains
    strict compare-and-swap conflict semantics.
    """
    if kind != "runtime" or len(path) != 3 or path[0] != "projects" or path[2] != "updatedAt":
        return MISSING
    if not isinstance(current, str) or not isinstance(new, str):
        return MISSING
    try:
        current_time = datetime.fromisoformat(current.replace("Z", "+00:00"))
        new_time = datetime.fromisoformat(new.replace("Z", "+00:00"))
    except ValueError:
        return MISSING
    if current_time.tzinfo is None or new_time.tzinfo is None:
        return MISSING
    return new if new_time >= current_time else current


def apply(document, base, next_value, kind=None, read_paths=()):
    if not isinstance(read_paths, (list, tuple)):
        raise ValueError("readPaths must be paths")
    for path in read_paths:
        if (kind != "registry" or not isinstance(path, list) or not path
                or any(not isinstance(key, str) or not key for key in path)):
            raise ValueError("invalid registry read path")
        if value_at(document, path) != value_at(base, path):
            raise ValueError("STATE_CONFLICT: " + "/".join(path))
    for path, old, new in differences(base, next_value):
        current = value_at(document, path)
        if current != old and current != new:
            merged = merge_runtime_volatile(kind, path, current, new)
            if merged is MISSING:
                raise ValueError("STATE_CONFLICT: " + "/".join(map(str, path)))
            new = merged
        parent = document
        for key in path[:-1]:
            parent = parent.setdefault(key, {})
        if not path:
            if not isinstance(new, dict):
                raise ValueError("state root must be an object")
            document = new
        elif new is MISSING:
            parent.pop(path[-1], None)
        else:
            parent[path[-1]] = new
    return document


def project(path, document):
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(handle, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(document, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_authoritative(path, kind, deadline=None):
    """Read an initialized store without joining the writer queue."""
    if not path.exists():
        return None
    deadline = min(deadline if deadline is not None else float("inf"), time.monotonic() + 8)
    # A URI read-only handle cannot establish SQLite's WAL shared-memory
    # index while a writer is rotating it. A normal handle with query_only
    # keeps this read non-mutating and follows the same WAL path as writers.
    for attempt in range(4):
        db = None
        try:
            # mode=rw never creates a missing DB; query_only permits no writes.
            # One total read deadline, including retries, stays below the 20s caller limit.
            db = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True, timeout=0, factory=DeadlineConnection)
            db.deadline, db.phase = deadline, "READ"
            db.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
            db.execute("PRAGMA query_only=ON")
            row = db.execute("SELECT payload FROM documents WHERE kind=?", (kind,)).fetchone()
            return json.loads(row[0]) if row is not None else None
        except sqlite3.OperationalError as error:
            message = str(error).lower()
            if "no such table" in message:
                return None
            transient = "unable to open database file" in message or "database is locked" in message
            if not transient or attempt == 3:
                raise
            if time.monotonic() >= deadline:
                raise ValueError("STATE_STORE_WAIT_EXHAUSTED:READ") from error
            time.sleep(min(0.05 * (2 ** attempt), deadline - time.monotonic()))
        finally:
            if db is not None:
                db.close()


def peek_document(config, state, kind):
    """Read authoritative state, without initializing or repairing projections."""
    if kind not in KINDS:
        raise ValueError("invalid document kind")
    config, state = pathlib.Path(config), pathlib.Path(state)
    current = read_authoritative(state / "bridge.sqlite3", kind)
    if current is not None:
        return current
    # Legacy/bootstrap input only. SQLite read errors propagate, never fall back.
    return read_json((config if kind == "registry" else state) / (kind + ".json"))


def locked_call(call, deadline, on_lock=None):
    attempt = 0
    while True:
        try:
            return call()
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower():
                raise
            if on_lock:
                on_lock()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise
            time.sleep(min(0.05 * (2 ** min(attempt, 4)), remaining))
            if time.monotonic() >= deadline:
                raise
            attempt += 1


def begin_immediate(db, timeout=15):
    deadline = time.monotonic() + timeout
    # Restore the busy handler even after a store deadline expires.
    execute = db.execute if not isinstance(db, DeadlineConnection) else lambda sql: sqlite3.Connection.execute(db, sql)
    original = execute("PRAGMA busy_timeout").fetchone()[0]
    try:
        # Native busy handlers can overshoot their millisecond budget on this host.
        execute("PRAGMA busy_timeout=0")
        return locked_call(lambda: db.execute("BEGIN IMMEDIATE"), deadline, db.rollback)
    finally:
        execute(f"PRAGMA busy_timeout={original}")


class DeadlineConnection(sqlite3.Connection):
    """One total store deadline across bootstrap, transaction, fence and commit."""
    deadline = None
    phase = "BOOTSTRAP"

    def remaining(self):
        value = self.deadline - time.monotonic()
        if value <= 0:
            raise ValueError("STATE_STORE_WAIT_EXHAUSTED:" + self.phase)
        return value

    def bounded(self, call):
        self.remaining()
        super().execute("PRAGMA busy_timeout=0")
        try:
            return locked_call(call, self.deadline)
        except sqlite3.OperationalError as error:
            if ("locked" in str(error).lower() or str(error) == "interrupted") and time.monotonic() >= self.deadline:
                raise ValueError("STATE_STORE_WAIT_EXHAUSTED:" + self.phase) from error
            raise

    def execute(self, sql, parameters=()):
        if sql == "BEGIN IMMEDIATE":
            # The shared helper owns rollback before retrying a stale read snapshot.
            self.remaining()
            super().execute("PRAGMA busy_timeout=0")
            return super().execute(sql, parameters)
        return self.bounded(lambda: super(DeadlineConnection, self).execute(sql, parameters))

    def commit(self):
        return self.bounded(super().commit)


class RegistrationFenced(ValueError):
    def __init__(self, reason, event, chat, registration):
        self.event, self.chat, self.registration, self.reason = event, chat, registration, reason
        super().__init__(json.dumps({"ok": False, "code": "ROTATION_REGISTRATION_FENCED", "reason": reason,
                                   "candidate": str(chat.get("id") or "")[:160], "url": str(chat.get("url") or "")[:1000]}, ensure_ascii=False))


def fence_rotation_registration(db, state, before, after, registration):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='management_events'").fetchone():
        return
    import importlib.util
    spec = importlib.util.spec_from_file_location("registration_delivery_attempt", pathlib.Path(__file__).with_name("delivery_attempt.py"))
    evidence = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(evidence)
    scopes = {}
    db.row_factory = sqlite3.Row
    for event in db.execute("SELECT id,payload,scope FROM management_events WHERE kind='ROTATION_QUARANTINE' ORDER BY created_at DESC,id DESC"):
        body = json.loads(event[1])
        scope = (body.get("project"), body.get("role"), body.get("workgroupId") or None)
        original = db.execute("SELECT * FROM operations WHERE id=?", (body.get("operationId"),)).fetchone()
        logical = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (body.get("logicalRef"),)).fetchone()
        if (not all(scope[:2]) or event["scope"] != "project:" + scope[0] or not original or not logical
                or (logical["project"], logical["role"], logical["workgroup_id"]) != scope
                or not evidence.quarantine_operation_matches(original, body.get("operationSha256"))
                or body.get("rotationId") != original["rotation_id"]):
            raise ValueError("ROTATION_QUARANTINE_AUDIT_INVALID")
        scopes.setdefault(scope, {"id": event[0], "body": body})
    for cid, chat in (after.get("chats") or {}).items():
        scope = (chat.get("project"), chat.get("role"), chat.get("workgroupId") or None)
        event = scopes.get(scope)
        if not event or chat.get("status", "active") not in {"active", "pending-rotation"}:
            continue
        def reject(reason):
            raise RegistrationFenced(reason, event, chat, registration)
        if chat.get("id") != cid:
            reject("REGISTRATION_CID_CHANGED")
        old = (before.get("chats") or {}).get(cid)
        routing = lambda c: (c.get("project"), c.get("role"), c.get("workgroupId") or None, c.get("account"), c.get("status", "active"))
        if old and routing(old) == routing(chat) and old.get("url") == chat.get("url"):
            continue
        if old:
            reject("REGISTRATION_CANDIDATE_ALREADY_REGISTERED")
        if chat.get("id") != cid or chat.get("status") != "pending-rotation":
            reject("PROTECTED_ROLE_ACTIVATION_REQUIRES_ACK")
        if not isinstance(registration, dict) or registration.get("sessionId") != cid:
            reject("REGISTRATION_CLAIM_REQUIRED")
        # Load the verifier from this release, not a caller-supplied module path.
        db.row_factory = sqlite3.Row
        try:
            row = evidence.verify_current(state, db, registration.get("attempt"))
        except (ValueError, OSError, TypeError, json.JSONDecodeError) as error:
            fenced = RegistrationFenced(str(error), event, chat, registration)
            if str(error) == "DELIVERY_ATTEMPT_NO_LONGER_CURRENT":
                # The verifier reached the current-row check only after validating the owned manifest.
                try:
                    descriptor = registration["attempt"]
                    raw, capture = evidence.read_capture(pathlib.Path(descriptor["directory"]) / "manifest.json")
                    manifest = json.loads(raw)
                    historical = db.execute("SELECT * FROM operations WHERE id=?", (descriptor["operationId"],)).fetchone()
                    if (capture["captureStable"] and capture["sha256"] == descriptor["manifestSha256"] and historical
                            and manifest.get("operationId") == historical["id"]
                            and type(manifest.get("claimOrdinal")) is int and manifest["claimOrdinal"] == descriptor["claimOrdinal"]
                            and all(manifest.get(key) == historical[column] for key, column in
                                    (("project", "project"), ("accountId", "account_id"), ("callerRef", "caller_ref"), ("kind", "kind")))
                            and manifest.get("messageSha256") == hashlib.sha256(historical["message"].encode()).hexdigest()):
                        fenced.claim_reference = {"operationId": historical["id"], "claimOrdinal": manifest["claimOrdinal"],
                                                  "claimedAt": str(manifest.get("claimedAt") or "")[:100],
                                                  "currentStatus": historical["status"], "expired": True}
                except (OSError, ValueError, KeyError, TypeError):
                    pass  # A changed capture cannot upgrade the declared rejection evidence.
            raise fenced
        logical = db.execute("SELECT * FROM logical_sessions WHERE logical_ref=?", (event["body"]["logicalRef"],)).fetchone()
        identity = after.get("accounts", {}).get(chat.get("account"), {}).get("identity")
        origin = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID")
        if (not logical or logical["state"] != "ROTATING" or row["kind"] != "rotation" or not row["force_new"]
                or row["session_ref"] or row["event_id"] != event["id"] or row["rotation_id"] != logical["rotation_id"]
                or row["caller_ref"] != logical["current_session_ref"]
                or any(row[k] != logical[k] for k in ("project", "role", "workgroup_id"))
                or (chat.get("project"), chat.get("role"), chat.get("workgroupId") or None) != scope
                or chat.get("account") != row["account_alias"] or not identity
                or hashlib.sha256(("identity:" + identity).encode()).hexdigest() != row["account_id"]
                or registration.get("messageSha256") != hashlib.sha256(row["message"].encode()).hexdigest()
                or origin and origin != row["account_id"]
                or os.environ.get("CHAT_BRIDGE_FROM_SPACE") and not origin):
            reject("REGISTRATION_ROTATION_OR_IDENTITY_CHANGED")
        header = "\n".join(["[CHATBRIDGE ROLE HANDOFF v1]", "rotation_id: " + row["rotation_id"],
                            "logical_ref: " + logical["logical_ref"], "role: " + row["role"],
                            "next_epoch: " + str(logical["epoch"] + 1), ""])
        if (not row["message"].startswith(header) or row["payload_hash"] != logical["handoff_hash"]
                or hashlib.sha256((row["original_message"] or "").encode()).hexdigest() != row["payload_hash"]
                or chat.get("logicalRef", logical["logical_ref"]) != logical["logical_ref"]
                or chat.get("generation", logical["epoch"] + 1) != logical["epoch"] + 1
                or db.execute("SELECT count(*) FROM operations WHERE rotation_id=?", (row["rotation_id"],)).fetchone()[0] != 1):
            reject("REGISTRATION_CURRENT_EPOCH_OR_BODY_CHANGED")
        binding = after.get("projects", {}).get(row["project"], {}).get("bindings", {}).get(row["account_alias"], {})
        project_id = re.search(r"g-p-[0-9a-f]{32}", binding.get("projectUrl") or "")
        url = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/c/([0-9a-f-]{36})/?", str(chat.get("url") or ""))
        owner = after.get("chats", {}).get(logical["current_session_ref"])
        peers = [key for key, c in after.get("chats", {}).items() if
                 (c.get("project"), c.get("role"), c.get("workgroupId") or None) == scope
                 and c.get("status", "active") in {"active", "pending-rotation"}]
        if (not project_id or not url or url[1] != project_id[0] or url[2] != cid or cid == logical["current_session_ref"]
                or logical["pending_session_ref"] not in (None, cid) or not owner or owner.get("status", "active") != "active"
                or (owner.get("project"), owner.get("role"), owner.get("workgroupId") or None, owner.get("account")) != (row["project"], row["role"], row["workgroup_id"], row["account_alias"])
                or any(key not in {logical["current_session_ref"], cid} for key in peers)
                or db.execute("SELECT 1 FROM operations WHERE session_ref=? AND id<>?", (cid, row["id"])).fetchone()
                or db.execute("SELECT 1 FROM logical_sessions WHERE current_session_ref=? OR (pending_session_ref=? AND logical_ref<>?)",
                              (cid, cid, logical["logical_ref"])).fetchone()):
            reject("REGISTRATION_TARGET_OR_OWNER_CHANGED")


def record_registration_fence(db, error):
    chat, registration = error.chat, error.registration
    supplied = registration.get("attempt") if isinstance(registration, dict) else None
    descriptor = None
    if isinstance(supplied, dict):
        descriptor = {key: str(supplied[key])[:limit] for key, limit in
                      (("format", 80), ("operationId", 160), ("manifestSha256", 64), ("directory", 1000)) if key in supplied}
        if type(supplied.get("claimOrdinal")) is int and 0 < supplied["claimOrdinal"] < 2**63:
            descriptor["claimOrdinal"] = supplied["claimOrdinal"]
    body = {"quarantineEvent": error.event["id"], "candidate": str(chat.get("id") or "")[:160],
            "url": str(chat.get("url") or "")[:1000], "reason": error.reason[:300],
            "registrationTrust": "UNAUTHENTICATED_REGISTRATION_PROPOSAL", "nativeDeliveryProof": False,
            "descriptor": descriptor, "verifiedExpiredClaim": getattr(error, "claim_reference", None)}
    # The scope anchor is not an assertion that this old operation created the CID.
    db.execute("INSERT INTO reconciliation_attempts(id,operation_id,outcome,reason,evidence,created_at) VALUES (?,?,?,?,?,?)",
               (str(uuid.uuid4()), error.event["body"]["operationId"], "REGISTRATION_FENCED", error.reason[:300],
                json.dumps(body, ensure_ascii=False), datetime.now().astimezone().isoformat()))


def main():
    command, config_name, state_name, kind = sys.argv[1:]
    if command not in {"get", "put", "peek"} or kind not in KINDS:
        raise ValueError("usage: state-store.py get|put|peek CONFIG_DIR STATE_DIR registry|runtime")
    config, state = pathlib.Path(config_name), pathlib.Path(state_name)
    if command == "peek":
        print(json.dumps(peek_document(config, state, kind), ensure_ascii=False))
        return
    state.mkdir(parents=True, exist_ok=True)
    destination = (config if kind == "registry" else state) / (kind + ".json")
    payload = None
    if command == "put":
        payload = json.load(sys.stdin)
        if not isinstance(payload.get("base"), dict) or not isinstance(payload.get("next"), dict):
            raise ValueError("base and next must be objects")
    deadline = time.monotonic() + 15
    old_umask = os.umask(0o077)
    try:
        if command == "get":
            current = read_authoritative(state / "bridge.sqlite3", kind, deadline=deadline)
            if current is not None:
                # The compatibility projection is outside the SQLite read handle.
                project(destination, current)
                print(json.dumps(current, ensure_ascii=False))
                return
        db = sqlite3.connect(state / "bridge.sqlite3", timeout=5, factory=DeadlineConnection)
        db.deadline = deadline
        db.set_progress_handler(lambda: time.monotonic() >= deadline, 1000)
    finally:
        os.umask(old_umask)
    try:
        db.execute("PRAGMA busy_timeout=5000")
        mode = str(db.execute("PRAGMA journal_mode").fetchone()[0]).lower()
        if mode != "wal":
            db.execute("PRAGMA journal_mode=WAL")
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").fetchone():
            db.execute("CREATE TABLE documents (kind TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            db.commit()
        for name in KINDS:
            if db.execute("SELECT 1 FROM documents WHERE kind=?", (name,)).fetchone():
                continue
            target = (config if name == "registry" else state) / (name + ".json")
            db.execute("INSERT OR IGNORE INTO documents(kind,payload) VALUES (?,?)",
                       (name, json.dumps(read_json(target), ensure_ascii=False)))
            db.commit()

        if command == "get":
            current = json.loads(db.execute("SELECT payload FROM documents WHERE kind=?", (kind,)).fetchone()[0])
            # SQLite is authoritative. Repair compatibility projection opportunistically.
            project(destination, current)
        else:
            db.phase = "WRITE_TRANSACTION"
            begin_immediate(db, timeout=max(0, deadline - time.monotonic()))
            current = json.loads(db.execute("SELECT payload FROM documents WHERE kind=?", (kind,)).fetchone()[0])
            before = json.loads(json.dumps(current))
            current = apply(current, payload["base"], payload["next"], kind=kind,
                            read_paths=payload.get("readPaths", ()))
            if kind == "registry":
                try:
                    db.phase = "REGISTRATION_FENCE"
                    fence_rotation_registration(db, state, before, current, payload.get("registration"))
                except RegistrationFenced as error:
                    record_registration_fence(db, error)
                    db.commit()
                    raise
            db.phase = "DOCUMENT_WRITE"
            db.execute("UPDATE documents SET payload=? WHERE kind=?", (json.dumps(current, ensure_ascii=False), kind))
            db.commit()
            # Project only after the authoritative transaction commits. If a crash occurs
            # before this write, the next get repairs the JSON projection from SQLite.
            project(destination, current)
        print(json.dumps(current, ensure_ascii=False))
    except Exception:
        if db.in_transaction:
            db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(3 if str(error).startswith("STATE_CONFLICT") else 2)
