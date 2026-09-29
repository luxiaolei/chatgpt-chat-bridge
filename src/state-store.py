#!/usr/bin/env python3
"""Transactional Bridge state; JSON files are compatibility projections."""
import json
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
            if old is MISSING and isinstance(new, dict):
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


def apply(document, base, next_value):
    for path, old, new in differences(base, next_value):
        current = value_at(document, path)
        if current != old and current != new:
            raise ValueError("STATE_CONFLICT: " + "/".join(map(str, path)))
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


def read_authoritative(path, kind):
    """Read an initialized store without joining the writer queue."""
    if not path.exists():
        return None
    # A URI read-only handle cannot establish SQLite's WAL shared-memory
    # index while a writer is rotating it. A normal handle with query_only
    # keeps this read non-mutating and follows the same WAL path as writers.
    for attempt in range(4):
        db = None
        try:
            db = sqlite3.connect(path, timeout=5)
            db.execute("PRAGMA busy_timeout=5000")
            db.execute("PRAGMA query_only=ON")
            rows = dict(db.execute("SELECT kind,payload FROM documents").fetchall())
            if not KINDS.issubset(rows):
                return None
            return json.loads(rows[kind])
        except sqlite3.OperationalError as error:
            message = str(error).lower()
            if "no such table" in message:
                return None
            transient = "unable to open database file" in message or "database is locked" in message
            if not transient or attempt == 3:
                raise
            time.sleep(0.05 * (2 ** attempt))
        finally:
            if db is not None:
                db.close()


def begin_immediate(db):
    # Keep the total wait below the Node caller's 20 second child timeout.
    for attempt in range(3):
        try:
            db.execute("BEGIN IMMEDIATE")
            return
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() or attempt == 2:
                raise
            # A failed upgrade can leave a stale read snapshot on this handle.
            db.rollback()
            time.sleep(0.05 * (2 ** attempt))


def main():
    command, config_name, state_name, kind = sys.argv[1:]
    if command not in {"get", "put"} or kind not in KINDS:
        raise ValueError("usage: state-store.py get|put CONFIG_DIR STATE_DIR registry|runtime")
    config, state = pathlib.Path(config_name), pathlib.Path(state_name)
    state.mkdir(parents=True, exist_ok=True)
    destination = (config if kind == "registry" else state) / (kind + ".json")
    payload = None
    if command == "put":
        payload = json.load(sys.stdin)
        if not isinstance(payload.get("base"), dict) or not isinstance(payload.get("next"), dict):
            raise ValueError("base and next must be objects")
    old_umask = os.umask(0o077)
    try:
        if command == "get":
            current = read_authoritative(state / "bridge.sqlite3", kind)
            if current is not None:
                # The compatibility projection is outside the SQLite read handle.
                project(destination, current)
                print(json.dumps(current, ensure_ascii=False))
                return
        db = sqlite3.connect(state / "bridge.sqlite3", timeout=5)
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
            begin_immediate(db)
            current = json.loads(db.execute("SELECT payload FROM documents WHERE kind=?", (kind,)).fetchone()[0])
            current = apply(current, payload["base"], payload["next"])
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
