"""Immutable, private per-claim evidence. Never grants resend or delivery authority."""
import hashlib
import json
import os
import pathlib
import re
import stat
from datetime import datetime, timezone

FORMAT = "chat-bridge-delivery-attempt-v1"
MAX_READ_BYTES = 16 * 1024 * 1024


def quarantine_operation_matches(original, expected):
    row = dict(original)
    digest = lambda value: hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if digest(row) == expected:
        return True
    # PR159 added a NULL column; legacy audits still cover every original field.
    if "reclaim_route" in row and row["reclaim_route"] is None:
        del row["reclaim_route"]
        return digest(row) == expected
    return False


def route_snapshot(reg, row):
    """Capture before the first child; never backfill an uncertain old send."""
    identity = (reg.get("accounts", {}).get(row["account_alias"]) or {}).get("identity")
    binding = (reg.get("projects", {}).get(row["project"]) or {}).get("bindings", {}).get(row["account_alias"]) or {}
    match = re.fullmatch(r"https://chatgpt\.com/g/(g-p-[0-9a-f]{32})(?:-[^/?#]+)?/project/?", binding.get("projectUrl") or "", re.I)
    if not isinstance(identity, str) or not identity or hashlib.sha256(("identity:" + identity).encode()).hexdigest() != row["account_id"] or not match or not isinstance(binding.get("profileId"), str) or not binding["profileId"]:
        return {}
    return {"projectId": match[1].lower(), "accountId": row["account_id"],
            "identityHash": hashlib.sha256(identity.encode()).hexdigest(), "profileId": binding["profileId"]}


def original_reclaim_route(row, account_id, identity):
    try:
        route = json.loads(row["reclaim_route"] or "null") if "reclaim_route" in row.keys() else None
        if (isinstance(route, dict) and route.get("accountId") == account_id and
                route.get("identityHash") == hashlib.sha256(identity.encode()).hexdigest() and
                isinstance(route.get("profileId"), str) and route["profileId"] and
                re.fullmatch(r"g-p-[0-9a-f]{32}", route.get("projectId") or "")):
            return route
    except (ValueError, TypeError):
        pass
    return None  # A current binding cannot supply missing historical route proof.


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def private_directory(path, create=False, exclusive=False):
    if create:
        path.mkdir(mode=0o700, exist_ok=not exclusive)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("DELIVERY_EVIDENCE_DIRECTORY_UNSAFE")
    return path


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def create_private_file(path):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    return os.fdopen(fd, "wb", buffering=0)


def write_once(path, value):
    raw = encoded(value)
    with create_private_file(path) as out:
        out.write(raw)
        os.fsync(out.fileno())
    sync_directory(path.parent)
    return {"path": str(path), "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def prepare(state, row):
    """Create before Popen; an existing claim directory is never armed twice."""
    operation, ordinal = row["id"], row["attempts"]
    if not re.fullmatch(r"[0-9a-f-]{36}", operation) or type(ordinal) is not int or ordinal < 1:
        raise ValueError("DELIVERY_ATTEMPT_ID_INVALID")
    state = pathlib.Path(state).resolve()
    root = private_directory(state / "delivery-attempts", create=True)
    owner = private_directory(root / operation, create=True)
    directory = private_directory(owner / str(ordinal), create=True, exclusive=True)
    sync_directory(owner)
    manifest = {"format": FORMAT, "operationId": operation, "claimOrdinal": ordinal,
                "claimedAt": row["claimed_at"], "recordedAt": datetime.now(timezone.utc).isoformat(),
                "messageSha256": hashlib.sha256(row["message"].encode()).hexdigest(),
                "taskId": row["task_id"], "account": row["account_alias"], "accountId": row["account_id"],
                "project": row["project"], "sessionRef": row["session_ref"], "kind": row["kind"],
                "payloadHash": row["payload_hash"], "callerRef": row["caller_ref"],
                "workgroupId": row["workgroup_id"] if "workgroup_id" in row.keys() else None,
                "controlScope": row["control_scope"] if "control_scope" in row.keys() else None,
                "controlEpoch": row["control_epoch"] if "control_epoch" in row.keys() else None,
                "requestedModel": row["requested_model"], "requestedEffort": row["requested_effort"],
                "claimIsNotSendCount": True, "retryAuthorized": False}
    if "reclaim_route" in row.keys() and row["reclaim_route"] is not None:
        manifest["route"] = json.loads(row["reclaim_route"])
    reference = write_once(directory / "manifest.json", manifest)
    return {"format": FORMAT, "operationId": operation, "claimOrdinal": ordinal,
            "manifestSha256": reference["sha256"], "directory": str(directory)}


def record(context, phase, data):
    if phase not in {"worker-starting", "worker-started", "worker-ended"}:
        raise ValueError("DELIVERY_HOST_PHASE_INVALID")
    directory = private_directory(pathlib.Path(context["directory"]))
    return write_once(directory / ("host-" + phase + ".json"), {
        "format": FORMAT, "operationId": context["operationId"], "claimOrdinal": context["claimOrdinal"],
        "manifestSha256": context["manifestSha256"], "recordedAt": datetime.now(timezone.utc).isoformat(),
        "phase": phase, **data})


def read_capture(path):
    """Keep bytes on disk even if the in-memory receipt budget is exceeded."""
    path = pathlib.Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("DELIVERY_CAPTURE_UNSAFE")
    digest, chunks, remaining, count = hashlib.sha256(), [], info.st_size, 0
    with path.open("rb") as stream:
        while remaining:
            block = stream.read(min(1024 * 1024, remaining))
            if not block:
                break
            remaining -= len(block)
            count += len(block)
            digest.update(block)
            if info.st_size <= MAX_READ_BYTES:
                chunks.append(block)
        after = os.fstat(stream.fileno())
    stable = count == info.st_size == after.st_size and info.st_mtime_ns == after.st_mtime_ns
    ref = {"path": str(path), "bytes": count, "sha256": digest.hexdigest(),
           "retained": True, "captureStable": stable, "parseBudgetExceeded": info.st_size > MAX_READ_BYTES}
    return (b"".join(chunks).decode("utf-8", errors="replace") if stable and chunks else ""), ref


def inspect(state, operation):
    """Local read-only index; a missing record is never negative delivery proof."""
    if not re.fullmatch(r"[0-9a-f-]{36}", operation):
        raise ValueError("DELIVERY_ATTEMPT_ID_INVALID")
    base = pathlib.Path(state).resolve() / "delivery-attempts"
    result = {"operationId": operation, "format": FORMAT, "attempts": [], "truncated": False,
              "readOnly": True, "retryAuthorized": False, "deliveryProven": False}
    if not base.exists():
        return result
    private_directory(base)
    owner = base / operation
    if not owner.exists():
        return result
    private_directory(owner)
    directories = sorted((p for p in owner.iterdir() if p.name.isdigit()), key=lambda p: int(p.name))
    result["truncated"] = len(directories) > 128
    for directory in directories[-128:]:
        private_directory(directory)
        item = {"claimOrdinal": int(directory.name), "files": []}
        for path in sorted(directory.iterdir()):
            if path.suffix not in {".json", ".bin"} or path.name.startswith("."):
                continue
            _, ref = read_capture(path)
            item["files"].append({"name": path.name, **ref})
        result["attempts"].append(item)
    return result


def verify_current(state, db, context):
    """Read-only fence immediately before Send; no expired/unknown claim admission."""
    if not isinstance(context, dict) or context.get("format") != FORMAT:
        raise ValueError("DELIVERY_ATTEMPT_DESCRIPTOR_INVALID")
    operation, ordinal = context.get("operationId"), context.get("claimOrdinal")
    if not isinstance(operation, str) or not re.fullmatch(r"[0-9a-f-]{36}", operation) or type(ordinal) is not int or ordinal < 1:
        raise ValueError("DELIVERY_ATTEMPT_ID_INVALID")
    root = pathlib.Path(state).resolve() / "delivery-attempts"
    owner, directory = root / operation, root / operation / str(ordinal)
    if context.get("directory") != str(directory):
        raise ValueError("DELIVERY_ATTEMPT_PATH_MISMATCH")
    for path in (root, owner, directory):
        private_directory(path)
    text, reference = read_capture(directory / "manifest.json")
    if not reference["captureStable"] or reference["sha256"] != context.get("manifestSha256"):
        raise ValueError("DELIVERY_MANIFEST_CHANGED")
    manifest = json.loads(text)
    row = db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
    mapping = {"operationId": "id", "claimOrdinal": "attempts", "claimedAt": "claimed_at",
               "taskId": "task_id", "account": "account_alias", "accountId": "account_id",
               "project": "project", "sessionRef": "session_ref", "kind": "kind", "payloadHash": "payload_hash",
               "callerRef": "caller_ref", "workgroupId": "workgroup_id", "controlScope": "control_scope", "controlEpoch": "control_epoch"}
    if (not row or row["status"] != "DISPATCHING" or manifest.get("format") != FORMAT
            or any(manifest.get(key) != row[column] for key, column in mapping.items())
            or hashlib.sha256(row["message"].encode()).hexdigest() != manifest.get("messageSha256")):
        raise ValueError("DELIVERY_ATTEMPT_NO_LONGER_CURRENT")
    if "reclaim_route" in row.keys() and row["reclaim_route"] is not None:
        route = json.loads(row["reclaim_route"])
        reg = json.loads(db.execute("SELECT payload FROM documents WHERE kind='registry'").fetchone()[0])
        if not route or manifest.get("route") != route or route_snapshot(reg, row) != route:
            raise ValueError("DELIVERY_ROUTE_CHANGED")
    return row
