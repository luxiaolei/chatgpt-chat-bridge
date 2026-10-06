#!/usr/bin/env python3
"""Private disk/loaded-code receipts. No browser access or database writes."""
import hashlib
import json
import types
import os
import pathlib
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

_EXECUTING_CODE = sys._getframe().f_code


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    try:
        return digest(pathlib.Path(path).read_bytes())
    except OSError:
        return None


def read_json(path):
    try:
        return json.loads(pathlib.Path(path).read_text())
    except (OSError, ValueError):
        return None


def atomic_json(path, value):
    path = pathlib.Path(path)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def process_identity(pid):
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart=", "-o", "command="],
                                capture_output=True, text=True, timeout=2)
        return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def code_hash(code):
    def value(item):
        if isinstance(item, types.CodeType):
            fields = ("co_argcount", "co_posonlyargcount", "co_kwonlyargcount", "co_nlocals",
                      "co_stacksize", "co_flags", "co_code", "co_consts", "co_names", "co_varnames",
                      "co_filename", "co_name", "co_qualname", "co_firstlineno", "co_linetable",
                      "co_lnotab", "co_exceptiontable", "co_freevars", "co_cellvars")
            return {name: value(getattr(item, name)) for name in fields if hasattr(item, name)}
        if isinstance(item, tuple):
            return ["tuple", [value(part) for part in item]]
        if isinstance(item, frozenset):
            return ["frozenset", sorted((value(part) for part in item), key=lambda part: json.dumps(part, sort_keys=True))]
        if isinstance(item, bytes):
            return ["bytes", item.hex()]
        if item is None or isinstance(item, (bool, int, str)):
            return [type(item).__name__, item]
        return [type(item).__name__, repr(item)]
    # Canonical values avoid marshal's process-local string interning/reference flags.
    return digest(json.dumps(value(code), sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode())


def compiled_hash(path):
    try:
        return code_hash(compile(pathlib.Path(path).read_bytes(), str(path), "exec",
                                 dont_inherit=True, optimize=sys.flags.optimize))
    except (OSError, SyntaxError):
        return None


def disk_release(directory):
    directory = pathlib.Path(directory)
    manifest_path = directory / "release-manifest.json"
    try:
        manifest_bytes = manifest_path.read_bytes()
        manifest = json.loads(manifest_bytes)
    except (OSError, ValueError):
        return {"manifestSha256": file_hash(manifest_path), "verified": False, "reason": "MANIFEST_UNAVAILABLE"}
    if (not isinstance(manifest, dict) or not isinstance(manifest.get("files"), list) or not manifest["files"]
            or any(not isinstance(entry, dict) or not isinstance(entry.get("destination"), str)
                   or not isinstance(entry.get("sha256"), str) for entry in manifest["files"])):
        return {"manifestSha256": digest(manifest_bytes), "verified": False, "reason": "MANIFEST_INVALID"}
    observed = [{"destination": entry["destination"], "sha256": file_hash(entry["destination"]),
                 "expectedSha256": entry["sha256"]} for entry in manifest["files"]]
    return {"manifestSha256": digest(manifest_bytes), "source": manifest.get("source"),
            "sourceIdentityAdmissible": admissible_source(manifest.get("source")),
            "verified": admissible_source(manifest.get("source")) and all(entry["sha256"] == entry["expectedSha256"] for entry in observed),
            "files": observed}


def startup_receipt(state, coordinator_path, executing_code):
    modules = {str(coordinator_path): executing_code, str(pathlib.Path(__file__)): _EXECUTING_CODE}
    value = {"schema": "chat-bridge.coordinator-startup.v1", "pid": os.getpid(),
             "startedAt": datetime.now(timezone.utc).isoformat(),
             "processIdentity": process_identity(os.getpid()), "executable": sys.executable,
             "coordinatorPath": str(coordinator_path), "pythonVersion": sys.version,
             "optimize": sys.flags.optimize, "codeFingerprintFormat": "python-code-structure-v1", "startupDisk": disk_release(pathlib.Path(coordinator_path).parent),
             "executingCode": [{"path": path, "loadedSha256": code_hash(code),
                                "startupCompiledSha256": compiled_hash(path)} for path, code in modules.items()],
             "codeScope": "Resident coordinator and release helper only; fresh CLI/native child and late imports are separate processes/loads."}
    atomic_json(pathlib.Path(state) / "coordinator-startup.json", value)
    return value


def health(state, directory):
    current = disk_release(directory)
    startup = read_json(pathlib.Path(state) / "coordinator-startup.json")
    if not isinstance(startup, dict):
        return {"currentDisk": current, "resident": {"alive": None, "reason": "STARTUP_RECEIPT_UNAVAILABLE"},
                "freshChildren": {"executionObserved": False}}
    identity = process_identity(startup.get("pid"))
    alive = identity is not None and identity == startup.get("processIdentity")
    compatible = (startup.get("pythonVersion") == sys.version and startup.get("optimize") == sys.flags.optimize
                  and startup.get("codeFingerprintFormat") == "python-code-structure-v1")
    differences = [{"path": entry["path"], "loadedSha256": entry["loadedSha256"],
                    "startupCompiledSha256": entry["startupCompiledSha256"],
                    "currentCompiledSha256": compiled_hash(entry["path"]) if compatible else None}
                   for entry in startup.get("executingCode", [])]
    for entry in differences:
        entry["loadedMatchesCurrent"] = entry["currentCompiledSha256"] == entry["loadedSha256"] if compatible else None
    return {"currentDisk": current,
            "resident": {"alive": alive, "pid": startup.get("pid"), "identityMatches": alive,
                         "startedAt": startup.get("startedAt"), "executable": startup.get("executable"),
                         "coordinatorPath": startup.get("coordinatorPath"),
                         "startupDisk": startup.get("startupDisk"), "executingCode": differences,
                         "codeScope": startup.get("codeScope"),
                         "startupManifestMatchesCurrent": (startup.get("startupDisk") or {}).get("manifestSha256") == current.get("manifestSha256")},
            "freshChildren": {"executionObserved": False, "source": "currentDisk", "note": "A new CLI/native child loads independently; this resident receipt does not attest its execution."}}


def admissible_source(source):
    return (isinstance(source, dict) and source.get("clean") is True
            and isinstance(source.get("root"), str) and pathlib.Path(source["root"]).is_absolute()
            and all(isinstance(source.get(key), str) and len(source[key]) in (40, 64)
                    and all(letter in "0123456789abcdef" for letter in source[key]) for key in ("commit", "tree")))


def source_release(root):
    root = pathlib.Path(root).resolve()
    def git(*args):
        try:
            return subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                                  text=True, check=True).stdout.strip()
        except subprocess.CalledProcessError as error:
            raise ValueError("INSTALL_SOURCE_UNRESOLVED") from error
    commit = git("rev-parse", "--verify", "HEAD^{commit}")
    source = {"root": str(root), "commit": commit,
              "tree": git("rev-parse", "--verify", commit + "^{tree}"),
              "clean": not bool(git("status", "--porcelain", "--untracked-files=all"))}
    if not admissible_source(source):
        raise ValueError("INSTALL_SOURCE_DIRTY_OR_UNRESOLVED")
    return source


def install_manifest(root, mapping, destination, expected):
    source_identity = source_release(root)
    if source_identity != json.loads(expected):
        raise ValueError("INSTALL_SOURCE_CHANGED")
    files = []
    for line in pathlib.Path(mapping).read_text().splitlines():
        source, target = line.split("\t")
        expected = digest(b'{"type":"module"}\n') if source == "@generated:image-package" else file_hash(source)
        actual = file_hash(target)
        if not expected or expected != actual:
            raise ValueError("INSTALL_READBACK_MISMATCH:" + target)
        files.append({"source": None if source.startswith("@generated:") else source,
                      "generated": source if source.startswith("@generated:") else None,
                      "destination": target, "sha256": actual})
    if not files or len({entry["destination"] for entry in files}) != len(files):
        raise ValueError("INSTALL_MAPPING_INVALID")
    manifest = {"schema": "chat-bridge.release.v1", "installedAt": datetime.now(timezone.utc).isoformat(),
                "source": source_identity,
                "files": files}
    if source_release(root) != source_identity:
        raise ValueError("INSTALL_SOURCE_CHANGED")
    atomic_json(destination, manifest)


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "install":
        install_manifest(*sys.argv[2:])
    elif len(sys.argv) == 3 and sys.argv[1] == "preflight":
        print(json.dumps(source_release(sys.argv[2]), sort_keys=True))
    else:
        raise SystemExit("release-version.py preflight ROOT | install ROOT COPY_MAP MANIFEST SOURCE_RELEASE")
