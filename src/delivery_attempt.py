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


def page_release_directory(state, target, create=False):
    """One physical target gets one close intent; a lost ACK never arms a second."""
    scope = {key: target[key] for key in ("accountId", "profileId", "spaceId", "targetId")}
    root = private_directory(pathlib.Path(state).resolve() / "page-releases", create=create)
    return private_directory(root / hashlib.sha256(encoded(scope)).hexdigest(), create=create)


def page_release_latest(state, target):
    try:
        directory = page_release_directory(state, target)
    except FileNotFoundError:
        return None
    intents = sorted(directory.glob("*-INTENT.json"))
    if not intents:
        return None
    raw, reference = read_capture(intents[-1])
    value = json.loads(raw)
    ordinal = value["releaseOrdinal"]
    if not reference["captureStable"] or value.get("format") != "chat-bridge-page-release-v1" or value.get("phase") != "INTENT" or type(ordinal) is not int:
        raise ValueError("PAGE_RELEASE_EVIDENCE_INVALID")
    value["reference"], value["outcome"] = reference, None
    for phase in ("RELEASED", "UNKNOWN", "REFUSED"):
        path = directory / f"{ordinal:03d}-{phase}.json"
        if not path.exists():
            continue
        raw, saved = read_capture(path)
        outcome = json.loads(raw)
        if (value["outcome"] or not saved["captureStable"] or outcome.get("target") != value["target"] or
                outcome.get("format") != "chat-bridge-page-release-v1" or outcome.get("phase") != phase or outcome.get("releaseOrdinal") != ordinal or
                phase == "REFUSED" and (outcome.get("data", {}).get("closeAttempted") is not False or outcome.get("data", {}).get("reloadAttempted") is True)):
            raise ValueError("PAGE_RELEASE_EVIDENCE_INVALID")
        value["outcome"] = phase
    return value


def page_release_record(state, target, phase, data, intent=None):
    if phase not in {"INTENT", "RELEASED", "UNKNOWN", "REFUSED"}:
        raise ValueError("PAGE_RELEASE_PHASE_INVALID")
    if phase == "REFUSED" and (data.get("closeAttempted") is not False or data.get("reloadAttempted") is True) or phase == "RELEASED" and any(data.get(k) is not True for k in ("closeAttempted", "closeAcknowledged", "targetAbsent")):
        raise ValueError("PAGE_RELEASE_OUTCOME_INVALID")
    directory = page_release_directory(state, target, create=True)
    latest = page_release_latest(state, target)
    if phase == "INTENT":
        if latest and latest["outcome"] != "REFUSED":
            raise ValueError("PAGE_RELEASE_ALREADY_ATTEMPTED")
        ordinal = latest["releaseOrdinal"] + 1 if latest else 1
        if ordinal > 128:
            raise ValueError("PAGE_RELEASE_ATTEMPT_BUDGET")
    else:
        if (not latest or latest["target"] != target or latest["outcome"] is not None or
                not isinstance(intent, dict) or any(intent.get(key) != latest["reference"][key] for key in ("path", "sha256", "bytes"))):
            raise ValueError("PAGE_RELEASE_INTENT_CHANGED")
        ordinal = latest["releaseOrdinal"]
    return write_once(directory / f"{ordinal:03d}-{phase}.json", {
        "format": "chat-bridge-page-release-v1", "phase": phase, "target": target,
        "releaseOrdinal": ordinal,
        "recordedAt": datetime.now(timezone.utc).isoformat(), "data": data,
        "deliveryProven": False, "remoteExecutionStopped": False, "retryAuthorized": False})


def direct_allocation_scope(state, data, create=False):
    scope = {key: data[key] for key in ("accountId", "profileId", "spaceId")}
    root = private_directory(pathlib.Path(state).resolve() / "page-allocations", create=create)
    return private_directory(root / hashlib.sha256(encoded(scope)).hexdigest(), create=create)


def direct_allocation_guard(state, data):
    try:
        directory = direct_allocation_scope(state, data)
    except FileNotFoundError:
        return
    # shortcut: scan receipts in this physical scope; index if admission becomes slow.
    for request in directory.iterdir():
        private_directory(request)
        for intent in request.glob("01-ALLOCATION_INTENT-*.json"):
            raw, ref = read_capture(intent)
            record = json.loads(raw)
            ordinal = record["data"]["allocationOrdinal"]
            if (not ref["captureStable"] or record.get("format") != "chat-bridge-page-allocation-v1" or
                    record.get("requestId") != request.name or record.get("phase") != "ALLOCATION_INTENT" or
                    type(ordinal) is not int or not 1 <= ordinal <= 128 or intent.name != f"01-ALLOCATION_INTENT-{ordinal:03d}.json"):
                raise ValueError("PAGE_ALLOCATION_EVIDENCE_INVALID")
            finished = False
            for phase, number in (("ALLOCATION_REFUSED", "02"), ("PAGE_RELEASED", "81"), ("PAGE_HANDED_OFF", "05")):
                path = request / f"{number}-{phase}-{ordinal:03d}.json"
                if path.exists():
                    raw, saved = read_capture(path)
                    value = json.loads(raw)
                    if (not saved["captureStable"] or value.get("format") != record["format"] or value.get("requestId") != record["requestId"] or value.get("phase") != phase or
                            any(value.get("data", {}).get(k) != record["data"].get(k) for k in ("accountId", "profileId", "spaceId", "allocationOrdinal"))):
                        raise ValueError("PAGE_ALLOCATION_EVIDENCE_INVALID")
                    finished = True
            if not finished:
                allocated = request / f"03-PAGE_ALLOCATED-{ordinal:03d}.json"
                if allocated.exists():
                    raw, saved = read_capture(allocated)
                    target = json.loads(raw).get("data") or {}
                    latest = page_release_latest(state, target) if saved["captureStable"] and target.get("targetId") else None
                    finished = latest and latest["outcome"] == "RELEASED"
                if not finished:
                    raise ValueError("PAGE_ALLOCATION_UNRESOLVED: " + record["requestId"])


def direct_allocation_record(state, request, phase, data):
    if not isinstance(request, str) or request in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", request):
        raise ValueError("PAGE_ALLOCATION_REQUEST_INVALID")
    phases = {"ALLOCATION_INTENT": "01", "ALLOCATION_REFUSED": "02", "PAGE_ALLOCATED": "03", "ALLOCATION_UNKNOWN": "04", "PAGE_HANDED_OFF": "05", "PAGE_RELEASE_INTENT": "80", "PAGE_RELEASED": "81", "PAGE_RELEASE_UNKNOWN": "82"}
    ordinal = data.get("allocationOrdinal")
    if phase not in phases or type(ordinal) is not int or not 1 <= ordinal <= 128:
        raise ValueError("PAGE_ALLOCATION_PHASE_INVALID")
    if phase == "ALLOCATION_INTENT":
        direct_allocation_guard(state, data)
    root = direct_allocation_scope(state, data, create=True)
    directory = private_directory(root / request, create=True)
    if phase != "ALLOCATION_INTENT":
        raw, saved = read_capture(directory / f"01-ALLOCATION_INTENT-{ordinal:03d}.json")
        intent = json.loads(raw)
        if (not saved["captureStable"] or intent.get("requestId") != request or
                any(intent.get("data", {}).get(k) != data.get(k) for k in ("allocationOrdinal", "project", "account", "accountId", "spaceId", "spaceName", "profileId", "projectUrl"))):
            raise ValueError("PAGE_ALLOCATION_INTENT_CHANGED")
        if phase == "PAGE_HANDED_OFF" or phase.startswith("PAGE_RELEASE"):
            raw, saved = read_capture(directory / f"03-PAGE_ALLOCATED-{ordinal:03d}.json")
            allocated = json.loads(raw)
            if not saved["captureStable"] or any(allocated.get("data", {}).get(k) != data.get(k) for k in ("page", "targetId")):
                raise ValueError("PAGE_ALLOCATION_TARGET_CHANGED")
    return write_once(directory / f"{phases[phase]}-{phase}-{ordinal:03d}.json", {
        "format": "chat-bridge-page-allocation-v1", "requestId": request, "phase": phase,
        "recordedAt": datetime.now(timezone.utc).isoformat(), "data": data})


def owns_direct_allocation(state, target):
    try:
        request, ordinal = target["requestId"], target["allocationOrdinal"]
        if not isinstance(request, str) or request in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", request) or type(ordinal) is not int or not 1 <= ordinal <= 128:
            return False
        root = direct_allocation_scope(state, target)
        directory = private_directory(root / request)
        raw, saved = read_capture(directory / f"03-PAGE_ALLOCATED-{ordinal:03d}.json")
        record = json.loads(raw)
        return saved["captureStable"] and record.get("format") == "chat-bridge-page-allocation-v1" and record.get("requestId") == request and record.get("phase") == "PAGE_ALLOCATED" and all(record.get("data", {}).get(k) == target[k] for k in ("project", "account", "accountId", "spaceId", "spaceName", "profileId", "page", "targetId", "projectUrl"))
    except (OSError, ValueError, KeyError, TypeError):
        return False


def owns_allocated_page(state, row, target, current=False):
    """Physical allocation provenance, never a historical first-message exclusion."""
    try:
        root = pathlib.Path(state).resolve() / "delivery-attempts"
        directory = root / row["id"] / str(row["attempts"])
        for entry in (root, directory.parent, directory):
            private_directory(entry)
        raw, reference = read_capture(directory / "manifest.json")
        manifest = json.loads(raw)
        if (not reference["captureStable"] or manifest.get("format") != FORMAT or manifest.get("operationId") != row["id"] or
                manifest.get("claimOrdinal") != row["attempts"] or
                (manifest.get("claimedAt") != row["claimed_at"] if current else type(manifest.get("claimedAt")) not in {int, float}) or
                manifest.get("payloadHash") != row["payload_hash"] or
                manifest.get("accountId") != row["account_id"] or manifest.get("accountId") != target["accountId"] or
                manifest.get("account") != row["account_alias"] or manifest.get("project") != target["project"] or
                manifest.get("messageSha256") != hashlib.sha256(row["message"].encode()).hexdigest()):
            return False
        if not current:
            finished, finished_ref = read_capture(directory / "75-SCRIPT_FINISHED.json")
            ended, ended_ref = read_capture(directory / "host-worker-ended.json")
            finished, ended = json.loads(finished), json.loads(ended)
            if (not finished_ref["captureStable"] or not ended_ref["captureStable"] or finished.get("manifestSha256") != reference["sha256"] or
                    finished.get("operationId") != row["id"] or finished.get("claimOrdinal") != row["attempts"] or finished.get("phase") != "SCRIPT_FINISHED" or
                    ended.get("manifestSha256") != reference["sha256"] or ended.get("operationId") != row["id"] or ended.get("claimOrdinal") != row["attempts"] or ended.get("phase") != "worker-ended" or
                    finished.get("data", {}).get("succeeded") is not True or ended.get("cleanup") or
                    ended.get("timedOut") or ended.get("interrupted") or ended.get("leaderReturnCode") != 0):
                return False
        for path in directory.glob("03-PAGE_ALLOCATED-*.json"):
            raw, saved = read_capture(path)
            record = json.loads(raw)
            if (saved["captureStable"] and record.get("manifestSha256") == reference["sha256"] and
                    record.get("operationId") == row["id"] and record.get("claimOrdinal") == row["attempts"] and
                    record.get("phase") == "PAGE_ALLOCATED" and
                    all(record.get("data", {}).get(key) == target[key] for key in ("project", "account", "spaceId", "spaceName", "profileId", "page", "targetId"))):
                return True
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return False
