"""Local-only account cooldown gate. Must run before ego-browser starts."""
import hashlib
import json
import math
import os
import pathlib
import re
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


def reconcile_pending(reg, runtime, project, now=None):
    cfg = reg.get("projects", {}).get(project, {})
    if runtime.get("projects", {}).get(project, {}).get("watchdogPausedForUserControl"):
        return False
    policy = cfg.get("lifecycle", {}) or {}
    if policy.get("autoReconcile") is not True:
        return False
    root = str(policy.get("reconcileRole") or cfg.get("rootController") or "conductor").strip()
    terminal = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "RESULT_RECORDED"}
    tasks = [t for t in runtime.get("tasks", {}).values() if t.get("project") == project]
    for task in tasks:
        status = str(task.get("status") or "").upper()
        is_root = str(task.get("role") or "").strip() == root and str(task.get("controller") or root).strip() == root
        if status not in terminal and not is_root:
            return False
    durable = [t for t in tasks if str(t.get("status") or "").upper() == "COMPLETE"
               and t.get("github") and t.get("updatedAt")]
    if not durable:
        return False
    latest = max(durable, key=lambda t: str(t.get("updatedAt")))
    rp = runtime.get("projects", {}).get(project, {})
    progress = str(latest.get("updatedAt"))
    if rp.get("lastReconcileProgressAt") and progress <= str(rp.get("lastReconcileProgressAt")):
        return False
    raw_gap = policy.get("minGapSec")
    gap = max(0, float(300 if raw_gap is None else raw_gap))
    last = rp.get("lastReconcileNotifiedAt")
    if last:
        try:
            last_dt = datetime.fromisoformat(str(last).replace("Z", "+00:00"))
            if ((now or datetime.now(timezone.utc)) - last_dt).total_seconds() < gap:
                return False
        except ValueError:
            pass
    return True


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
    if action == "origin-account":
        identity = os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID", "")
        if not identity or not re.fullmatch(r"[0-9a-f]{64}", identity):
            raise ValueError("ORIGIN_ACCOUNT_NOT_VERIFIED")
        aliases = [alias for alias, record in reg.get("accounts", {}).items() if record.get("identity") and scope(reg, alias) == identity]
        if not aliases:
            raise ValueError("ORIGIN_ACCOUNT_NOT_VERIFIED")
        project = option(args, "--project", reg.get("defaultProject"))
        bindings = reg.get("projects", {}).get(project, {}).get("bindings", {}) if project else {}
        bound = [alias for alias in aliases if bindings.get(alias, {}).get("projectUrl")]
        if project and not bound:
            raise ValueError("PROJECT_NOT_BOUND_FOR_ORIGIN_ACCOUNT: " + str(project))
        print((bound or aliases)[0])
        return
    if action == "origin":
        space_name = os.environ.get("CHAT_BRIDGE_FROM_SPACE", "")
        space = reg.get("spaces", {}).get(space_name, {})
        identity = space.get("identity")
        if not identity or reg.get("accounts", {}).get(space.get("account"), {}).get("identity") != identity:
            raise ValueError("ORIGIN_SPACE_NOT_VERIFIED: " + space_name)
        account = space["account"]
        project = option(args, "--project", reg.get("defaultProject"))
        if project and not reg.get("projects", {}).get(project, {}).get("bindings", {}).get(account, {}).get("projectUrl"):
            raise ValueError("PROJECT_NOT_BOUND_FOR_ORIGIN_ACCOUNT: " + project + " / " + account)
        print(account)
        return
    if action == "unambiguous":
        project = option(args, "--project", reg.get("defaultProject"))
        chat = reg.get("chats", {}).get(args[1]) if len(args) > 1 else None
        if chat and chat.get("project") == project:
            return
        bindings = reg.get("projects", {}).get(project, {}).get("bindings", {})
        scopes = {scope(reg, account) for account, binding in bindings.items() if binding.get("projectUrl")}
        if len(scopes) > 1:
            raise ValueError("AMBIGUOUS_PROJECT_ACCOUNT: " + str(project) + "; provide a verified origin Space or --account")
        return
    if action == "watch-all":
        script, *command = args
        project = option(command, "--project")
        runtime = read_json(state / "runtime.json")
        terminal = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "RESULT_RECORDED"}
        task_rows = []
        for task_key, task in runtime.get("tasks", {}).items():
            if project and task.get("project") != project:
                continue
            if task.get("watchdogPausedForUserControl"):
                continue
            status = str(task.get("status") or "").upper()
            pending = status == "BLOCKED" and task.get("watchdogPendingNotification")
            if status not in terminal or pending:
                task_rows.append((str(task.get("taskId") or task_key), task_account(reg, task)))
        lifecycle_rows = []
        for name in ([project] if project else reg.get("projects", {})):
            if name and reconcile_pending(reg, runtime, name):
                lifecycle_rows.append((name, project_account(reg, name)))

        def wait_for_lane(account):
            stamp_path = state / ("ui-pacing-" + scope(reg, account) + ".last")
            try:
                wait = max(0, max(10, float(os.environ.get("CHAT_BRIDGE_UI_MIN_INTERVAL_SEC", "10"))) -
                           (time.time() - float(stamp_path.read_text().strip())))
            except (FileNotFoundError, ValueError):
                wait = 0
            if wait:
                time.sleep(wait)

        result = 0
        for task_id, account in task_rows:
            if not task_id or cooldown(reg, state, account)["active"]:
                continue
            wait_for_lane(account)
            completed = subprocess.run([script, *command, "--account", account,
                                        "--task-id", task_id, "--skip-lifecycle"], check=False)
            if completed.returncode and not result:
                result = completed.returncode
        for name, account in lifecycle_rows:
            if cooldown(reg, state, account)["active"]:
                continue
            wait_for_lane(account)
            extra = ["--account", account, "--skip-tasks"]
            if not project:
                extra += ["--project", name]
            completed = subprocess.run([script, *command, *extra], check=False)
            if completed.returncode and not result:
                result = completed.returncode
        raise SystemExit(result)
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
        terminal = {"COMPLETE", "FAILED", "CANCELLED", "BLOCKED", "RESULT_RECORDED"}
        task_filter = option(args, "--task-id")
        if "--skip-tasks" not in args:
            for task_key, task in runtime.get("tasks", {}).items():
                if task_filter and str(task.get("taskId") or task_key) != task_filter:
                    continue
                a = task_account(reg, task)
                if project and task.get("project") != project:
                    continue
                if explicit and a != explicit:
                    continue
                if task.get("watchdogPausedForUserControl"):
                    continue
                status = str(task.get("status") or "").upper()
                pending = status == "BLOCKED" and task.get("watchdogPendingNotification")
                if (status not in terminal or pending) and not cooldown(reg, state, a)["active"]:
                    print("1")
                    return
        if "--skip-lifecycle" not in args:
            projects = [project] if project else list(reg.get("projects", {}).keys())
            for p in projects:
                if not p:
                    continue
                a = project_account(reg, p)
                if explicit and a != explicit:
                    continue
                if reconcile_pending(reg, runtime, p) and not cooldown(reg, state, a)["active"]:
                    print("1")
                    return
        print("0")
        return
    if action == "scope":
        print(scope(reg, account))
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
