#!/usr/bin/env python3
"""GitHub Projects v2 integration for ChatBridge logical projects.

This module is intentionally separate from ChatGPT Web routing.  It uses the
host-local `gh` login and the Bridge registry to bind a logical ChatBridge
project to one GitHub Project.  GitHub Project state is a management/read
surface; source Issues/PRs and Bridge result/ACK state remain authoritative for
their own semantics.

Remote writes are conservative:
- bind/unbind only mutate the local Bridge registry through state-store.py CAS;
- refresh is read-only unless --apply is explicit;
- additions come only from configured, explicit open-source search queries;
- Project Status writes are opt-in, single-select only, source-version guarded,
  and terminal/acceptance-like target values are refused;
- source Issues/PRs are never edited, closed, merged, dispatched, retried, or
  accepted by this module.
"""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable, Iterable

DEFAULT_STATUS_FIELD = "Status"
MAX_SEARCH_RESULTS = 1000
MAX_PAGES = 100
TERMINAL_WORDS = {
    "done",
    "closed",
    "complete",
    "completed",
    "accepted",
    "merged",
    "deployed",
    "released",
    "production",
    "passed",
    "approved",
}
DANGEROUS_WORKFLOW_NAMES = {"auto-close issue"}

COMMON_SOURCE = """
  id url number title state updatedAt repository { nameWithOwner }
  labels(first:100) { totalCount nodes { name } }
"""
SOURCE_FRAGMENT = (
    "fragment SourceFields on ProjectV2ItemContent {\n"
    + "... on Issue { "
    + COMMON_SOURCE
    + " stateReason }\n"
    + "... on DraftIssue { id title }\n... on PullRequest { "
    + COMMON_SOURCE
    + " isDraft headRefOid baseRefName reviewDecision }\n}"
)
ITEM_FRAGMENT = """
fragment ItemFields on ProjectV2Item {
  id isArchived
  content { __typename ...SourceFields }
  fieldValues(first:100) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { id name } } }
      ... on ProjectV2ItemFieldIterationValue {
        title iterationId startDate duration
        field { ... on ProjectV2IterationField { id name } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        name optionId
        field { ... on ProjectV2SingleSelectField { id name } }
      }
    }
  }
}
""" + SOURCE_FRAGMENT


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectError(RuntimeError):
    code = "PROJECT_ERROR"
    status = "ERROR"


class InvalidConfig(ProjectError):
    code = "INVALID_CONFIG"
    status = "INVALID_CONFIG"


class Unavailable(ProjectError):
    code = "GITHUB_PROJECT_UNAVAILABLE"
    status = "UNAVAILABLE"


class IncompleteRead(ProjectError):
    code = "GITHUB_PROJECT_INCOMPLETE_READ"
    status = "UNAVAILABLE"


class Conflict(ProjectError):
    code = "GITHUB_PROJECT_CONFLICT"
    status = "CONFLICT"


class SafetyRefusal(ProjectError):
    code = "GITHUB_PROJECT_WRITE_REFUSED"
    status = "REFUSED"


def json_print(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def normalize_terminal(value: str) -> set[str]:
    return {part for part in re.split(r"[^a-z0-9]+", value.lower()) if part}


def terminal_like(value: str) -> bool:
    return bool(normalize_terminal(value) & TERMINAL_WORDS)


def normalize_status_mapping(values: Iterable[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in values:
        if "=" not in raw:
            raise InvalidConfig("--map-status must be SOURCE_LABEL=PROJECT_STATUS")
        label, target = [part.strip() for part in raw.split("=", 1)]
        if not label or not target:
            raise InvalidConfig("--map-status requires non-empty label and target")
        if terminal_like(label) or terminal_like(target):
            raise SafetyRefusal(
                f"terminal/acceptance-like status mappings are not allowed: {label}={target}"
            )
        previous = result.get(label)
        if previous is not None and previous != target:
            raise InvalidConfig(f"conflicting mapping for {label}: {previous} vs {target}")
        result[label] = target
    return result


def validate_source_query(query: str) -> str:
    query = " ".join(str(query).split())
    if not query:
        raise InvalidConfig("empty --source-query")
    tokens = query.split()
    if "is:open" not in tokens:
        raise InvalidConfig("each --source-query must explicitly contain is:open")
    for token in tokens:
        if token in ("is:open", "is:issue", "is:pr"):
            continue
        if re.fullmatch(r"repo:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", token):
            continue
        if re.fullmatch(r"label:[A-Za-z0-9_:.+-]+", token):
            continue
        raise InvalidConfig(f"unsupported source-query qualifier: {token}")
    if not any(token.startswith("repo:") for token in tokens):
        raise InvalidConfig("each --source-query must positively scope at least one repo:")
    return query


def query_repositories(query: str) -> set[str]:
    return {token[5:].lower() for token in validate_source_query(query).split()
            if token.startswith("repo:")}


class Gh:
    def __init__(self, executable: str | None = None) -> None:
        self.executable = (
            executable
            or os.environ.get("CHAT_BRIDGE_GH_BIN")
            or "/opt/homebrew/bin/gh"
        )

    def run(self, args: list[str], *, input_value: dict[str, Any] | None = None) -> str:
        try:
            result = subprocess.run(
                [self.executable, *args],
                input=json.dumps(input_value) if input_value is not None else None,
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Unavailable(f"gh execution failed: {error}") from error
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "unknown gh failure").strip()
            raise Unavailable(detail[:1200])
        return result.stdout

    def project_view(self, owner: str, number: int) -> dict[str, Any]:
        raw = self.run(
            [
                "project",
                "view",
                str(number),
                "--owner",
                owner,
                "--format",
                "json",
            ]
        )
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise IncompleteRead("invalid gh project view response") from error
        if not isinstance(value, dict) or not value.get("id") or not value.get("url"):
            raise IncompleteRead("project view did not return id/url")
        return value

    def graphql(self, query: str, **variables: Any) -> dict[str, Any]:
        payload = {"query": query, "variables": variables}
        raw = self.run(
            ["api", "--hostname", "github.com", "graphql", "--input", "-"],
            input_value=payload,
        )
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise IncompleteRead("invalid GraphQL response") from error
        if value.get("errors"):
            raise Unavailable(json.dumps(value["errors"], ensure_ascii=False)[:1200])
        data = value.get("data")
        if not isinstance(data, dict):
            raise IncompleteRead("GraphQL response missing data")
        return data

    def rest(self, endpoint: str, **params: Any) -> dict[str, Any]:
        args = ["api", "-X", "GET", endpoint]
        for key, value in params.items():
            args += ["-f", f"{key}={value}"]
        raw = self.run(args)
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise IncompleteRead(f"invalid REST response for {endpoint}") from error
        if not isinstance(value, dict):
            raise IncompleteRead(f"REST response for {endpoint} was not an object")
        return value


class RegistryStore:
    def __init__(self, config_dir: str, state_dir: str, state_store: str) -> None:
        self.config_dir = config_dir
        self.state_dir = state_dir
        self.state_store = state_store

    def _call(
        self, command: str, *, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    self.state_store,
                    command,
                    self.config_dir,
                    self.state_dir,
                    "registry",
                ],
                input=json.dumps(payload) if payload is not None else None,
                text=True,
                capture_output=True,
                timeout=20,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Unavailable(f"registry state unavailable: {error}") from error
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or "state-store failure").strip()
            if "STATE_CONFLICT" in detail:
                raise Conflict(detail[:1200])
            raise Unavailable(detail[:1200])
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise IncompleteRead("invalid state-store response") from error
        if not isinstance(value, dict):
            raise IncompleteRead("registry state was not an object")
        return value

    def peek(self) -> dict[str, Any]:
        return self._call("peek")

    def put(self, base: dict[str, Any], next_value: dict[str, Any]) -> dict[str, Any]:
        return self._call("put", payload={"base": base, "next": next_value})


def logical_project(registry: dict[str, Any], name: str) -> dict[str, Any]:
    projects = registry.get("projects")
    if not isinstance(projects, dict) or name not in projects:
        raise InvalidConfig(
            f'logical ChatBridge project "{name}" is not initialized; run chat-bridge init first'
        )
    project = projects[name]
    if not isinstance(project, dict):
        raise InvalidConfig(f'logical project "{name}" registry record is invalid')
    return project


def binding_from(registry: dict[str, Any], project: str) -> dict[str, Any] | None:
    value = logical_project(registry, project).get("githubProject")
    if value is None:
        return None
    if not isinstance(value, dict):
        raise InvalidConfig(f'logical project "{project}" has invalid githubProject metadata')
    return value


def require_binding(registry: dict[str, Any], project: str) -> dict[str, Any]:
    value = binding_from(registry, project)
    if value is None:
        raise InvalidConfig(f'logical project "{project}" has no GitHub Project binding')
    required = ("owner", "number", "id", "url")
    missing = [key for key in required if not value.get(key)]
    if missing:
        raise InvalidConfig(
            f'logical project "{project}" GitHub Project binding missing: {", ".join(missing)}'
        )
    return value


def label_names(source: dict[str, Any]) -> list[str]:
    labels = source.get("labels") or {}
    nodes = labels.get("nodes") or []
    total = labels.get("totalCount")
    if total is None or int(total) != len(nodes):
        raise IncompleteRead(f'labels truncated for {source.get("url") or source.get("id")}')
    return sorted(str(node.get("name")) for node in nodes if node and node.get("name"))


def source_version(source: dict[str, Any]) -> tuple[Any, ...]:
    repository = (source.get("repository") or {}).get("nameWithOwner")
    return (
        source.get("__typename"),
        source.get("id"),
        repository,
        source.get("state"),
        source.get("updatedAt"),
        source.get("headRefOid"),
        tuple(label_names(source)),
    )


def item_values(item: dict[str, Any]) -> dict[str, str]:
    field_values = item.get("fieldValues") or {}
    page_info = field_values.get("pageInfo") or {}
    if page_info.get("hasNextPage"):
        raise IncompleteRead(f'Project item fields truncated for item {item.get("id")}')
    result: dict[str, str] = {}
    for node in field_values.get("nodes") or []:
        if not node:
            continue
        field = node.get("field") or {}
        name = field.get("name")
        if name and node.get("name") is not None:
            result[str(name)] = str(node["name"])
    return result


def paginate(connection_page: Callable[[str | None], dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    cursor: str | None = None
    seen: set[str] = set()
    for _ in range(MAX_PAGES):
        connection = connection_page(cursor)
        if not isinstance(connection, dict):
            raise IncompleteRead("connection page missing")
        nodes = connection.get("nodes")
        page_info = connection.get("pageInfo")
        if not isinstance(nodes, list) or not isinstance(page_info, dict):
            raise IncompleteRead("connection page incomplete")
        if any(node is None for node in nodes):
            raise IncompleteRead("connection contained null node")
        rows.extend(nodes)
        if not page_info.get("hasNextPage"):
            return rows
        cursor = page_info.get("endCursor")
        if not cursor or cursor in seen:
            raise IncompleteRead("pagination cursor missing or repeated")
        seen.add(cursor)
    raise IncompleteRead("pagination budget exceeded")


def project_snapshot(gh: Gh, binding: dict[str, Any]) -> dict[str, Any]:
    observed = gh.project_view(str(binding["owner"]), int(binding["number"]))
    if observed.get("id") != binding.get("id"):
        raise Conflict(
            f'GitHub Project identity changed: expected {binding.get("id")} observed {observed.get("id")}'
        )
    project_id = str(binding["id"])

    config_query = """
query($id:ID!) {
  node(id:$id) {
    ... on ProjectV2 {
      id title url closed public
      workflows(first:100) {
        pageInfo { hasNextPage endCursor }
        nodes { id name enabled number createdAt updatedAt }
      }
      fields(first:100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ... on ProjectV2SingleSelectField {
            __typename id name options { id name }
          }
          ... on ProjectV2Field {
            __typename id name dataType
          }
          ... on ProjectV2IterationField {
            __typename id name dataType
          }
        }
      }
    }
  }
}
"""
    node = gh.graphql(config_query, id=project_id).get("node")
    if not isinstance(node, dict) or node.get("id") != project_id:
        raise Unavailable("bound GitHub Project node is inaccessible")
    for key in ("workflows", "fields"):
        connection = node.get(key) or {}
        if (connection.get("pageInfo") or {}).get("hasNextPage"):
            raise IncompleteRead(f"Project {key} exceeded first 100 entries")
    if node.get("closed"):
        raise Conflict("bound GitHub Project is closed")

    items_query = (
        """query($id:ID!,$cursor:String) {
          node(id:$id) {
            ... on ProjectV2 {
              items(first:100,after:$cursor,archivedStates:[ARCHIVED,NOT_ARCHIVED]) {
                pageInfo { hasNextPage endCursor }
                nodes { ...ItemFields }
              }
            }
          }
        }
        """
        + ITEM_FRAGMENT
    )

    def item_page(cursor: str | None) -> dict[str, Any]:
        data = gh.graphql(items_query, id=project_id, cursor=cursor)
        owner = data.get("node")
        if not isinstance(owner, dict):
            raise IncompleteRead("Project items node unavailable")
        return owner.get("items") or {}

    items = paginate(item_page)
    return {
        "project": {
            "id": project_id,
            "number": int(binding["number"]),
            "owner": binding["owner"],
            "title": node.get("title"),
            "url": node.get("url"),
            "public": node.get("public"),
            "closed": node.get("closed"),
        },
        "fields": [value for value in (node.get("fields") or {}).get("nodes") or [] if value],
        "workflows": [
            value for value in (node.get("workflows") or {}).get("nodes") or [] if value
        ],
        "items": items,
    }


def workflow_risks(snapshot: dict[str, Any]) -> list[str]:
    result = []
    for workflow in snapshot.get("workflows") or []:
        if (
            workflow.get("enabled")
            and str(workflow.get("name") or "").strip().lower() in DANGEROUS_WORKFLOW_NAMES
        ):
            result.append("AUTO_CLOSE_ISSUE_ENABLED")
    return sorted(set(result))


def search_sources(gh: Gh, queries: list[str]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for query in queries:
        allowed_repositories = query_repositories(query)
        page = 1
        seen = 0
        total_count: int | None = None
        while page <= MAX_PAGES:
            payload = gh.rest(
                "search/issues", q=query, per_page=100, page=page
            )
            if payload.get("incomplete_results") is True:
                raise IncompleteRead(f"GitHub search incomplete for query: {query}")
            current_total = int(payload.get("total_count", 0))
            if total_count is None:
                total_count = current_total
                if total_count > MAX_SEARCH_RESULTS:
                    raise IncompleteRead(
                        f"source query exceeds {MAX_SEARCH_RESULTS} result safety limit: {query}"
                    )
            elif total_count != current_total:
                raise Conflict(f"source query changed while paginating: {query}")
            items = payload.get("items")
            if not isinstance(items, list):
                raise IncompleteRead(f"source query missing items: {query}")
            for item in items:
                node_id = item.get("node_id")
                if not node_id:
                    raise IncompleteRead(f"source query item missing node_id: {query}")
                state = str(item.get("state") or "").upper()
                if state != "OPEN":
                    raise Conflict(f"source query returned non-open item: {item.get('html_url')}")
                repository_url = str(item.get("repository_url") or "")
                repository = repository_url.removeprefix("https://api.github.com/repos/")
                if (not repository_url.startswith("https://api.github.com/repos/")
                        or repository.lower() not in allowed_repositories):
                    raise Conflict(f"source query returned repository outside scope: {repository_url}")
                candidate = {
                    "id": node_id,
                    "url": item.get("html_url"),
                    "number": item.get("number"),
                    "updatedAt": item.get("updated_at"),
                    "state": state,
                    "__typename": "PullRequest" if item.get("pull_request") else "Issue",
                    "query": query,
                }
                previous = by_id.get(node_id)
                if previous and previous["url"] != candidate["url"]:
                    raise Conflict(f"source node identity collision: {node_id}")
                by_id[node_id] = candidate
            seen += len(items)
            if seen >= (total_count or 0):
                break
            if not items:
                raise IncompleteRead(f"source query ended before total_count: {query}")
            page += 1
        if total_count is not None and seen != total_count:
            raise IncompleteRead(
                f"source query pagination mismatch: expected {total_count}, read {seen}: {query}"
            )
    return sorted(by_id.values(), key=lambda item: (item["url"] or "", item["id"]))


def get_source(gh: Gh, node_id: str) -> dict[str, Any] | None:
    query = (
        """query($id:ID!) {
          node(id:$id) {
            __typename
            ...SourceFields
          }
        }
        """
        + SOURCE_FRAGMENT
    )
    value = gh.graphql(query, id=node_id).get("node")
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("__typename") not in ("Issue", "PullRequest"):
        raise Conflict(f"source node is not Issue/PR: {node_id}")
    return value


def candidate_guard(gh: Gh, candidate: dict[str, Any]) -> dict[str, Any]:
    latest = get_source(gh, str(candidate["id"]))
    if latest is None:
        raise Conflict(f"source disappeared before add: {candidate.get('url')}")
    repository = str((latest.get("repository") or {}).get("nameWithOwner") or "")
    if repository.lower() not in query_repositories(str(candidate.get("query") or "")):
        raise Conflict("source repository outside configured scope before add")
    if latest.get("state") != "OPEN":
        raise Conflict(f"source closed before add: {candidate.get('url')}")
    if latest.get("id") != candidate.get("id"):
        raise Conflict(f"source id changed before add: {candidate.get('url')}")
    if candidate.get("url") and latest.get("url") != candidate.get("url"):
        raise Conflict(f"source URL changed before add: {candidate.get('url')}")
    return latest


def add_project_item(gh: Gh, project_id: str, source_id: str) -> str:
    mutation = """
mutation($project:ID!,$source:ID!) {
  addProjectV2ItemById(input:{projectId:$project,contentId:$source}) {
    item { id }
  }
}
"""
    data = gh.graphql(mutation, project=project_id, source=source_id)
    item = ((data.get("addProjectV2ItemById") or {}).get("item") or {}).get("id")
    if not item:
        raise IncompleteRead("addProjectV2ItemById returned no item id")
    return str(item)


def status_field(snapshot: dict[str, Any], name: str) -> dict[str, Any]:
    candidates = [
        field
        for field in snapshot.get("fields") or []
        if field.get("__typename") == "ProjectV2SingleSelectField"
        and field.get("name") == name
    ]
    if len(candidates) != 1:
        raise InvalidConfig(f'expected exactly one single-select Project field named "{name}"')
    return candidates[0]


def status_plan(
    snapshot: dict[str, Any], binding: dict[str, Any]
) -> list[dict[str, Any]]:
    mapping = binding.get("statusFromLabels") or {}
    if not mapping:
        return []
    if not isinstance(mapping, dict):
        raise InvalidConfig("statusFromLabels must be an object")
    for source_label, target in mapping.items():
        if terminal_like(str(source_label)) or terminal_like(str(target)):
            raise SafetyRefusal(
                f"terminal/acceptance-like status mapping stored in registry: {source_label}={target}"
            )

    field_name = str(binding.get("statusField") or DEFAULT_STATUS_FIELD)
    field = status_field(snapshot, field_name)
    options = {
        str(option.get("name")): str(option.get("id"))
        for option in field.get("options") or []
        if option and option.get("name") and option.get("id")
    }
    result: list[dict[str, Any]] = []

    for item in snapshot.get("items") or []:
        if item.get("isArchived"):
            continue
        source = item.get("content")
        if not isinstance(source, dict) or source.get("__typename") != "Issue":
            continue
        if source.get("state") != "OPEN":
            continue
        labels = label_names(source)
        targets = sorted({str(mapping[label]) for label in labels if label in mapping})
        if not targets:
            continue
        if len(targets) != 1:
            raise Conflict(
                f"multiple mapped Project statuses for {source.get('url')}: {targets}"
            )
        target = targets[0]
        if terminal_like(target):
            raise SafetyRefusal(f"refusing terminal Project Status target: {target}")
        option_id = options.get(target)
        if not option_id:
            raise InvalidConfig(
                f'Project status option "{target}" not found in field "{field_name}"'
            )
        old = item_values(item).get(field_name)
        if old not in (None, ""):
            continue
        result.append(
            {
                "itemId": item["id"],
                "source": source,
                "field": field_name,
                "fieldId": field["id"],
                "old": old,
                "new": target,
                "optionId": option_id,
            }
        )
    return result


def guarded_status_write(
    gh: Gh, binding: dict[str, Any], change: dict[str, Any]
) -> bool:
    if terminal_like(str(change["new"])):
        raise SafetyRefusal("terminal Project status writes are prohibited")
    latest_source = get_source(gh, str(change["source"]["id"]))
    if latest_source is None:
        raise Conflict(f"source disappeared before status write: {change['source'].get('url')}")
    if source_version(latest_source) != source_version(change["source"]):
        raise Conflict(f"source changed before status write: {change['source'].get('url')}")

    fresh_snapshot = project_snapshot(gh, binding)
    matches = [item for item in fresh_snapshot["items"] if item.get("id") == change["itemId"]]
    if len(matches) != 1:
        raise Conflict("Project item identity missing or duplicated before status write")
    item = matches[0]
    if item.get("isArchived") or not isinstance(item.get("content"), dict):
        raise Conflict("Project item archived or inaccessible before status write")
    if source_version(item["content"]) != source_version(change["source"]):
        raise Conflict("Project item source changed before status write")
    current = item_values(item).get(change["field"])
    if current == change["new"]:
        return False
    if current != change["old"] or current not in (None, ""):
        raise Conflict("Project Status changed concurrently; refusing overwrite")

    field = status_field(fresh_snapshot, change["field"])
    if field.get("id") != change["fieldId"]:
        raise Conflict("Project Status field identity changed before write")
    options = {
        str(option.get("name")): str(option.get("id"))
        for option in field.get("options") or []
        if option and option.get("name") and option.get("id")
    }
    if options.get(change["new"]) != change["optionId"]:
        raise Conflict("Project Status option identity changed before write")

    mutation = """
mutation($project:ID!,$item:ID!,$field:ID!,$option:String!) {
  updateProjectV2ItemFieldValue(
    input:{
      projectId:$project,itemId:$item,fieldId:$field,
      value:{singleSelectOptionId:$option}
    }
  ) { projectV2Item { id } }
}
"""
    data = gh.graphql(
        mutation,
        project=binding["id"],
        item=change["itemId"],
        field=change["fieldId"],
        option=change["optionId"],
    )
    if not ((data.get("updateProjectV2ItemFieldValue") or {}).get("projectV2Item") or {}).get(
        "id"
    ):
        raise IncompleteRead("Project status update returned no item id")
    return True


def snapshot_summary(
    snapshot: dict[str, Any],
    binding: dict[str, Any],
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    items = snapshot.get("items") or []
    all_ids = {
        item["content"]["id"]
        for item in items
        if isinstance(item.get("content"), dict) and item["content"].get("id")
    }
    archived_ids = {
        item["content"]["id"]
        for item in items
        if item.get("isArchived")
        and isinstance(item.get("content"), dict)
        and item["content"].get("id")
    }
    result: dict[str, Any] = {
        "project": snapshot["project"],
        "items": [
            {"id": item["id"], "isArchived": bool(item.get("isArchived")),
             "source": item.get("content"),
             "status": item_values(item).get(binding.get("statusField") or DEFAULT_STATUS_FIELD),
             "fieldValues": (item.get("fieldValues") or {}).get("nodes") or []}
            for item in items
        ],
        "fields": snapshot.get("fields") or [],
        "itemCount": len(items),
        "activeItemCount": sum(not item.get("isArchived") for item in items),
        "archivedItemCount": sum(bool(item.get("isArchived")) for item in items),
        "workflowRisks": workflow_risks(snapshot),
        "sourceQueries": list(binding.get("sourceQueries") or []),
        "statusField": binding.get("statusField") or DEFAULT_STATUS_FIELD,
        "statusFromLabels": dict(binding.get("statusFromLabels") or {}),
        "writesAreOptIn": True,
        "sourceIssuesOrPullRequestsAreNeverMutated": True,
        "projectStatusIsNotAcceptance": True,
    }
    if candidates is not None:
        missing = [candidate for candidate in candidates if candidate["id"] not in all_ids]
        archived = [
            candidate for candidate in candidates if candidate["id"] in archived_ids
        ]
        result["sourceCandidateCount"] = len(candidates)
        result["missingSourceUrls"] = [candidate.get("url") for candidate in missing]
        result["intentionallyArchivedSourceUrls"] = [
            candidate.get("url") for candidate in archived
        ]
    return result


def command_bind(
    args: argparse.Namespace, store: RegistryStore, gh: Gh
) -> dict[str, Any]:
    registry = store.peek()
    logical_project(registry, args.project)
    owner = args.owner.strip()
    number = int(args.number)
    observed = gh.project_view(owner, number)
    mapping = normalize_status_mapping(args.map_status or [])
    queries = [validate_source_query(value) for value in (args.source_query or [])]

    proposed_binding = {
        "owner": owner,
        "number": number,
        "id": observed["id"],
        "url": observed["url"],
        "title": observed.get("title"),
        "sourceQueries": queries,
        "statusField": args.status_field or DEFAULT_STATUS_FIELD,
        "statusFromLabels": mapping,
        "boundAt": utc_now(),
    }
    # Validate the remote board, field identity and any configured status
    # options before persisting the local binding.  A failed bind must not
    # poison subsequent controller startup.
    snapshot = project_snapshot(gh, proposed_binding)
    status_plan(snapshot, proposed_binding)

    next_registry = copy.deepcopy(registry)
    project = logical_project(next_registry, args.project)
    project["githubProject"] = proposed_binding
    saved = store.put(registry, next_registry)
    binding = require_binding(saved, args.project)
    return {
        "ok": True,
        "status": "BOUND",
        "project": args.project,
        "binding": binding,
        "observed": snapshot_summary(snapshot, binding),
    }


def command_show(args: argparse.Namespace, store: RegistryStore) -> dict[str, Any]:
    registry = store.peek()
    value = binding_from(registry, args.project)
    return {
        "ok": True,
        "status": "BOUND" if value else "UNBOUND",
        "project": args.project,
        "binding": value,
    }


def command_unbind(args: argparse.Namespace, store: RegistryStore) -> dict[str, Any]:
    registry = store.peek()
    current = binding_from(registry, args.project)
    if current is None:
        return {"ok": True, "status": "UNBOUND", "project": args.project, "changed": False}
    next_registry = copy.deepcopy(registry)
    logical_project(next_registry, args.project).pop("githubProject", None)
    store.put(registry, next_registry)
    return {"ok": True, "status": "UNBOUND", "project": args.project, "changed": True}


def command_inspect(
    args: argparse.Namespace, store: RegistryStore, gh: Gh
) -> dict[str, Any]:
    registry = store.peek()
    binding = require_binding(registry, args.project)
    snapshot = project_snapshot(gh, binding)
    candidates = (
        search_sources(gh, list(binding.get("sourceQueries") or []))
        if binding.get("sourceQueries")
        else None
    )
    result = snapshot_summary(snapshot, binding, candidates)
    result.update({"ok": True, "status": "READ_COMPLETE", "project": args.project})
    result["plannedStatusChanges"] = [
        {
            "sourceUrl": change["source"].get("url"),
            "field": change["field"],
            "old": change["old"],
            "new": change["new"],
        }
        for change in status_plan(snapshot, binding)
    ]
    return result


def command_refresh(
    args: argparse.Namespace, store: RegistryStore, gh: Gh
) -> dict[str, Any]:
    registry = store.peek()
    binding = require_binding(registry, args.project)
    queries = list(binding.get("sourceQueries") or [])
    snapshot = project_snapshot(gh, binding)
    candidates = search_sources(gh, queries) if queries else []

    present_ids = {
        item["content"]["id"]
        for item in snapshot["items"]
        if isinstance(item.get("content"), dict) and item["content"].get("id")
    }
    additions = [candidate for candidate in candidates if candidate["id"] not in present_ids]
    status_changes = status_plan(snapshot, binding)
    preview = {
        "additions": [
            {"url": item.get("url"), "id": item["id"], "query": item["query"]}
            for item in additions
        ],
        "statusChanges": [
            {
                "sourceUrl": change["source"].get("url"),
                "field": change["field"],
                "old": change["old"],
                "new": change["new"],
            }
            for change in status_changes
        ],
    }

    writes = 0
    if args.apply:
        for candidate in additions:
            if writes >= args.max_writes:
                raise Conflict("write budget reached before refresh completed")
            candidate_guard(gh, candidate)
            # Read board membership again immediately before each add.  This
            # makes duplicate concurrent auto-adds idempotent without assuming
            # the earlier snapshot is still current.
            current = project_snapshot(gh, binding)
            current_ids = {
                item["content"]["id"]
                for item in current["items"]
                if isinstance(item.get("content"), dict) and item["content"].get("id")
            }
            if candidate["id"] in current_ids:
                continue
            add_project_item(gh, binding["id"], candidate["id"])
            writes += 1

        snapshot = project_snapshot(gh, binding)
        for change in status_plan(snapshot, binding):
            if writes >= args.max_writes:
                raise Conflict("write budget reached before refresh completed")
            if guarded_status_write(gh, binding, change):
                writes += 1

        snapshot = project_snapshot(gh, binding)
        candidates = search_sources(gh, queries) if queries else []

    summary = snapshot_summary(snapshot, binding, candidates if queries else None)
    remaining_status = status_plan(snapshot, binding)
    remaining_missing: list[str] = []
    if queries:
        present_ids = {
            item["content"]["id"]
            for item in snapshot["items"]
            if isinstance(item.get("content"), dict) and item["content"].get("id")
        }
        remaining_missing = [
            candidate.get("url")
            for candidate in candidates
            if candidate["id"] not in present_ids
        ]
    summary.update(
        {
            "ok": True,
            "status": "REFRESHED" if args.apply else "PREVIEW",
            "project": args.project,
            "apply": bool(args.apply),
            "writes": writes,
            "preview": preview,
            "remainingMissingSourceUrls": remaining_missing,
            "remainingStatusChanges": [
                {
                    "sourceUrl": change["source"].get("url"),
                    "field": change["field"],
                    "old": change["old"],
                    "new": change["new"],
                }
                for change in remaining_status
            ],
            "coverageAndConfiguredProjectionMatch": (
                not remaining_missing and not remaining_status
                if queries or (binding.get("statusFromLabels") or {})
                else None
            ),
        }
    )
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("bind", "show", "unbind", "inspect", "refresh"))
    parser.add_argument("config_dir")
    parser.add_argument("state_dir")
    parser.add_argument("--project", required=True)
    parser.add_argument(
        "--state-store",
        default=str(Path(__file__).with_name("state-store.py")),
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--gh-bin", default=None, help=argparse.SUPPRESS)

    parser.add_argument("--owner")
    parser.add_argument("--number", type=int)
    parser.add_argument("--source-query", action="append", default=[])
    parser.add_argument("--status-field", default=DEFAULT_STATUS_FIELD)
    parser.add_argument("--map-status", action="append", default=[])

    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--max-writes", type=int, default=40)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if args.max_writes < 1 or args.max_writes > 100:
        parser.error("--max-writes must be 1..100")
    if args.command == "bind" and (not args.owner or args.number is None):
        parser.error("bind requires --owner and --number")
    if args.command != "bind" and (
        args.owner
        or args.number is not None
        or args.source_query
        or args.map_status
        or args.status_field != DEFAULT_STATUS_FIELD
    ):
        parser.error(
            "--owner/--number/--source-query/--status-field/--map-status are bind-only"
        )
    if args.command != "refresh" and (args.apply or args.max_writes != 40):
        parser.error("--apply/--max-writes are refresh-only")

    store = RegistryStore(args.config_dir, args.state_dir, args.state_store)
    gh = Gh(args.gh_bin)
    try:
        if args.command == "bind":
            result = command_bind(args, store, gh)
        elif args.command == "show":
            result = command_show(args, store)
        elif args.command == "unbind":
            result = command_unbind(args, store)
        elif args.command == "inspect":
            result = command_inspect(args, store, gh)
        elif args.command == "refresh":
            result = command_refresh(args, store, gh)
        else:
            raise AssertionError(args.command)
        json_print(result)
        return 0
    except ProjectError as error:
        json_print(
            {
                "ok": False,
                "status": error.status,
                "code": error.code,
                "reason": str(error),
                "project": args.project,
                "remoteBusinessActionAttempted": False,
            }
        )
        if isinstance(error, InvalidConfig):
            return 2
        if isinstance(error, SafetyRefusal):
            return 3
        if isinstance(error, Conflict):
            return 4
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
