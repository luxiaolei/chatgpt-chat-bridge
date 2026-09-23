"""Local-only account cooldown gate. Must run before ego-browser starts."""
import hashlib
import json
import math
import pathlib
import sys
import subprocess
import time
from datetime import datetime, timezone


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {}


def scope(reg, account):
    identity = reg.get("accounts", {}).get(account, {}).get("identity")
    key = "identity:" + identity if identity else "alias:" + account
    return hashlib.sha256(key.encode()).hexdigest()


def cooldown_paths(reg, state, account):
    paths = [state / "web-cooldowns" / (scope(reg, account) + ".json")]
    # The pre-account release only knew the default login. Retain its protection.
    if scope(reg, account) == scope(reg, reg.get("defaultAccount") or "default"):
        paths.append(state / "web-cooldown.json")
    return paths


def cooldown(reg, state, account):
    records = [read_json(p) for p in cooldown_paths(reg, state, account)]
    data = max(records, key=lambda row: row.get("until") or "", default={})
    remaining = 0
    if data.get("until"):
        until = datetime.fromisoformat(data["until"].replace("Z", "+00:00"))
        remaining = max(0, (until - datetime.now(timezone.utc)).total_seconds())
    return {"account": account, "scope": scope(reg, account),
            "identityVerified": bool(reg.get("accounts", {}).get(account, {}).get("identity")),
            "active": remaining > 0, "remainingSec": remaining, "cooldown": data or None}


def option(args, name, default=None):
    if name not in args:
        return default
    i = args.index(name)
    if i + 1 >= len(args) or args[i + 1].startswith("--"):
        raise ValueError(name + " requires a value")
    return args[i + 1]


def task_account(reg, task):
    chat = reg.get("chats", {}).get(task.get("sessionId"), {})
    return chat.get("account") or task.get("account") or project_account(reg, task.get("project"))


def project_account(reg, project):
    return reg.get("projects", {}).get(project, {}).get("activeAccount") or reg.get("defaultAccount") or "default"


def run(action, config, state, args):
    if action == "loop":
        script, *args = args
        interval = max(30, float(option(args, "--interval", "60")))
        iterations = int(option(args, "--iterations", "0"))
        if not math.isfinite(interval) or iterations < 0:
            raise ValueError("invalid watch interval/iterations")
        once = [arg for arg in args if arg != "--loop"]
        count = 0
        while True:
            subprocess.run([script, *once], check=True)
            count += 1
            if iterations and count >= iterations:
                return
            time.sleep(interval)
    reg = read_json(config / "registry.json")
    cmd = args[0] if args else "help"
    project = option(args, "--project", None if cmd in ("watch", "projects") else reg.get("defaultProject"))
    explicit = option(args, "--account")
    account = explicit or project_account(reg, project)
    session_commands = {"read", "status", "send", "ask", "model", "effort", "stop", "retry", "recover", "resend", "archive", "retire", "delete"}
    if cmd in session_commands and len(args) > 1:
        key = args[1].split("/c/")[-1].split("?")[0]
        chats = list(reg.get("chats", {}).values())
        direct = reg.get("chats", {}).get(key)
        include_inactive = cmd in {"archive", "retire", "delete"}
        chats = [c for c in chats if c.get("status", "active") != "deleted"
                 and (include_inactive or c.get("status", "active") == "active")]
        if direct in chats:
            chats = [direct]
        else:
            selected = explicit or (project_account(reg, project) if project else None)
            chats = [c for c in chats if not selected or (c.get("account") or project_account(reg, c.get("project"))) == selected]
        matches = [c for c in chats if key in [c.get(k) for k in ("id", "name", "role", "alias", "title", "url")]
                   and (not project or c.get("project") == project)
                   and (not explicit or c.get("account") == explicit)]
        if len(matches) == 1:
            account = matches[0].get("account") or account
    if action == "watch":
        runtime = read_json(state / "runtime.json")
        terminal = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED"}
        for task in runtime.get("tasks", {}).values():
            a = task_account(reg, task)
            if project and task.get("project") != project:
                continue
            if explicit and a != explicit:
                continue
            status = str(task.get("status") or "").upper()
            pending = status == "BLOCKED" and task.get("watchdogPendingNotification")
            if (status not in terminal or pending) and not cooldown(reg, state, a)["active"]:
                print("1")
                return
        print("0")
        return
    data = cooldown(reg, state, account)
    if action == "gate":
        print(f'{data["remainingSec"]:.3f}|{(data["cooldown"] or {}).get("until", "")}|{account}')
    elif action == "clear":
        if "--confirm" not in args:
            raise ValueError("cooldown clear requires --confirm")
        for p in cooldown_paths(reg, state, account):
            p.unlink(missing_ok=True)
        print(json.dumps({"ok": True, "account": account, "cleared": True}))
    else:
        data["retryAfterSec"] = math.ceil(data["remainingSec"])
        print(json.dumps(data, indent=2))


if __name__ == "__main__":
    try:
        run(sys.argv[1], pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), sys.argv[4:])
    except (ValueError, TypeError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(json.dumps({"ok": False, "status": "LOCAL_STATE_ERROR", "error": str(error)}), file=sys.stderr)
        sys.exit(2)
