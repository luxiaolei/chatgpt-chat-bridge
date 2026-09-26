#!/usr/bin/env python3
"""Pure-local read paths for ChatBridge status commands. Never starts Ego."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys


def load_store(config, state, kind):
    script = pathlib.Path(__file__).with_name("state-store.py")
    completed = subprocess.run(
        [sys.executable, str(script), "get", str(config), str(state), kind],
        check=True, capture_output=True, text=True, timeout=20,
    )
    return json.loads(completed.stdout)


def safe_segment(value, fallback="default"):
    text = str(value or "").strip()
    if not text:
        return fallback
    text = re.sub(r"[^A-Za-z0-9._-]+", "_", text)
    return text.strip("_")[:96] or fallback


def option(args, name, default=None):
    if name not in args:
        return default
    i = args.index(name)
    if i + 1 >= len(args):
        raise ValueError(name + " requires a value")
    return args[i + 1]


def topology(reg, runtime):
    accounts = {}
    by_alias = {}
    for alias, record in (reg.get("accounts") or {}).items():
        key = "identity:" + record["identity"] if record.get("identity") else "unverified:" + alias
        current = accounts.setdefault(key, {
            "accountId": hashlib.sha256(key.encode()).hexdigest() if record.get("identity") else None,
            "name": record.get("label") or alias,
            "aliases": [],
            "verified": bool(record.get("identity")),
        })
        current["aliases"].append(alias)
        by_alias[alias] = key
    for space in (reg.get("spaces") or {}).values():
        key = "identity:" + space["identity"] if space.get("identity") else None
        if key in accounts and space.get("accountName"):
            accounts[key]["name"] = space["accountName"]
    projects = []
    for project_key, record in (reg.get("projects") or {}).items():
        locations = {}
        for alias, binding in (record.get("bindings") or {}).items():
            account_key = by_alias.get(alias) or "unverified:" + alias
            location_key = account_key + ":" + str(binding.get("projectId") or binding.get("projectUrl") or alias)
            location = locations.setdefault(location_key, {
                "accountAliases": [],
                "accountName": accounts.get(account_key, {}).get("name") or alias,
                "projectId": binding.get("projectId"),
                "projectUrl": binding.get("projectUrl"),
                "spaces": [],
            })
            location["accountAliases"].append(alias)
            if binding.get("spaceName") and binding["spaceName"] not in location["spaces"]:
                location["spaces"].append(binding["spaceName"])
        projects.append({
            "businessProjectId": record.get("businessProjectId") or project_key,
            "name": record.get("name") or project_key,
            "allowedAccounts": record.get("allowedAccounts") or list((record.get("bindings") or {}).keys()),
            "workgroups": [
                {"id": key, "name": group.get("name") or key, "controllerSessionRef": group.get("controllerSessionRef")}
                for key, group in (record.get("workgroups") or {}).items()
            ],
            "locations": list(locations.values()),
            "sessions": [
                {"sessionRef": chat.get("id"), "accountAlias": chat.get("account"),
                 "role": chat.get("role"), "status": chat.get("status") or "active"}
                for chat in (reg.get("chats") or {}).values() if chat.get("project") == project_key
            ],
        })
    return {
        "accounts": list(accounts.values()),
        "projects": projects,
        "taskCount": len(runtime.get("tasks") or {}),
        "unresolvedSpaces": [space.get("name") for space in (reg.get("spaces") or {}).values() if not space.get("ownership")],
    }


def account_scope(reg, alias):
    identity=((reg.get("accounts") or {}).get(alias) or {}).get("identity")
    raw=("identity:"+identity) if identity else ("alias:"+str(alias))
    return hashlib.sha256(raw.encode()).hexdigest()


def origin_account(reg, project, explicit=None):
    if explicit:
        return explicit
    stable=os.environ.get("CHAT_BRIDGE_FROM_ACCOUNT_ID","").strip()
    if stable:
        aliases=[alias for alias in (reg.get("accounts") or {}) if account_scope(reg,alias)==stable]
        if not aliases:
            raise ValueError("ORIGIN_ACCOUNT_NOT_VERIFIED")
        if project:
            bound=[alias for alias in aliases if ((reg.get("projects") or {}).get(project) or {}).get("bindings",{}).get(alias,{}).get("projectUrl")]
            if not bound:
                raise ValueError("PROJECT_NOT_BOUND_FOR_ORIGIN_ACCOUNT: "+str(project))
            return bound[0]
        return aliases[0]
    space_name=os.environ.get("CHAT_BRIDGE_FROM_SPACE","").strip()
    if space_name:
        space=(reg.get("spaces") or {}).get(space_name) or {}
        identity=space.get("identity")
        alias=space.get("account")
        if not identity or not alias or ((reg.get("accounts") or {}).get(alias) or {}).get("identity")!=identity:
            raise ValueError("ORIGIN_SPACE_NOT_VERIFIED: "+space_name)
        if project and not (((reg.get("projects") or {}).get(project) or {}).get("bindings",{}).get(alias) or {}).get("projectUrl"):
            raise ValueError("PROJECT_NOT_BOUND_FOR_ORIGIN_ACCOUNT: "+str(project))
        return alias
    return None


def active_account(reg, project, explicit=None):
    routed=origin_account(reg,project,explicit)
    if routed:
        return routed
    return ((reg.get("projects") or {}).get(project) or {}).get("activeAccount") or reg.get("defaultAccount") or "default"


def list_events(reg, state, args):
    project = option(args, "--project") or reg.get("defaultProject")
    account = active_account(reg, project, option(args, "--account")) if project else option(args, "--account")
    if not project or not account:
        raise ValueError("event list requires a project/account")
    path = state / "events" / safe_segment(project) / (safe_segment(account) + ".jsonl")
    try:
        lines = [line for line in path.read_text().splitlines() if line]
    except FileNotFoundError:
        lines = []
    rows = [json.loads(line) for line in lines]
    after = option(args, "--after")
    if after:
        idx = next((i for i, row in enumerate(rows) if row.get("cursor") == after), -1)
        if idx >= 0:
            rows = rows[idx + 1:]
    event_type = option(args, "--type")
    if event_type:
        rows = [row for row in rows if row.get("type") == event_type]
    limit = max(1, min(1000, int(option(args, "--limit", "100"))))
    rows = rows[:limit]
    return {"project":project,"account":account,"events":rows,
            "nextCursor":rows[-1].get("cursor") if rows else after}


def chat_list(reg,args):
    project=option(args,"--project") or reg.get("defaultProject")
    account=option(args,"--account")
    if project and not account:
        account=active_account(reg,project)
    include_all="--all" in args
    return [chat for chat in (reg.get("chats") or {}).values()
            if (not project or chat.get("project")==project)
            and (not account or chat.get("account")==account)
            and (include_all or chat.get("status","active")=="active")]


def main():
    action, config_name, state_name, *args = sys.argv[1:]
    config, state = pathlib.Path(config_name), pathlib.Path(state_name)
    reg = load_store(config, state, "registry")
    runtime = load_store(config, state, "runtime")
    if action == "topology":
        value = topology(reg, runtime)
    elif action == "runtime":
        value = runtime
    elif action == "task-list":
        project = option(args, "--project") or reg.get("defaultProject")
        value = [task for task in (runtime.get("tasks") or {}).values()
                 if not project or task.get("project") == project]
    elif action == "event-list":
        value = list_events(reg, state, args)
    elif action == "chat-list":
        value = chat_list(reg,args)
    else:
        raise ValueError("unknown local query")
    print(json.dumps(value, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
