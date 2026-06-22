"""Helpers for the depts module API.

Endpoint quirks captured from .aws/data-knowledge.yaml:
- list:   GET /api/v1/dept/list (optional `name` query param, fuzzy match)
- get:    GET /api/v1/dept/get?id={id}
- create: POST /api/v1/dept/create  body: name, desc, order, parent_id
- update: POST /api/v1/dept/update  body: id, name, desc, order, parent_id
- delete: DELETE /api/v1/dept/delete?dept_id={id}   (param is `dept_id`, NOT `id`)
"""
from __future__ import annotations

from typing import Any

import httpx


def get_dept_tree(client: httpx.Client, name: str | None = None) -> httpx.Response:
    params: dict[str, Any] = {}
    if name is not None:
        params["name"] = name
    return client.get("/api/v1/dept/list", params=params)


def get_dept_detail(client: httpx.Client, dept_id: int) -> httpx.Response:
    return client.get("/api/v1/dept/get", params={"id": dept_id})


def create_dept(
    client: httpx.Client,
    name: str,
    desc: str = "",
    order: int = 0,
    parent_id: int = 0,
) -> httpx.Response:
    return client.post(
        "/api/v1/dept/create",
        json={"name": name, "desc": desc, "order": order, "parent_id": parent_id},
    )


def update_dept(
    client: httpx.Client,
    dept_id: int,
    name: str,
    desc: str = "",
    order: int = 0,
    parent_id: int = 0,
) -> httpx.Response:
    return client.post(
        "/api/v1/dept/update",
        json={
            "id": dept_id,
            "name": name,
            "desc": desc,
            "order": order,
            "parent_id": parent_id,
        },
    )


def delete_dept(client: httpx.Client, dept_id: int) -> httpx.Response:
    return client.delete("/api/v1/dept/delete", params={"dept_id": dept_id})


def safe_delete_dept(client: httpx.Client, dept_id: int) -> None:
    try:
        client.delete("/api/v1/dept/delete", params={"dept_id": dept_id})
    except Exception:
        pass


def _walk(nodes: list[dict] | None) -> list[dict]:
    flat: list[dict] = []
    for n in nodes or []:
        flat.append(n)
        if n.get("children"):
            flat.extend(_walk(n["children"]))
    return flat


def list_dept_flat(client: httpx.Client, name: str | None = None) -> list[dict]:
    response = get_dept_tree(client, name=name)
    if response.status_code != 200:
        return []
    body = response.json()
    if body.get("code") != 200:
        return []
    return _walk(body.get("data") or [])


def find_dept_in_tree(client: httpx.Client, dept_id: int) -> dict | None:
    for node in list_dept_flat(client):
        if node.get("id") == dept_id:
            return node
    return None


def find_dept_in_tree_by_name(client: httpx.Client, name: str) -> dict | None:
    for node in list_dept_flat(client):
        if node.get("name") == name:
            return node
    return None


def find_dept_id_by_name(client: httpx.Client, name: str) -> int | None:
    node = find_dept_in_tree_by_name(client, name)
    if node is None:
        return None
    dept_id = node.get("id")
    return dept_id if isinstance(dept_id, int) else None


def top_level_ids(client: httpx.Client) -> list[int]:
    response = get_dept_tree(client)
    if response.status_code != 200:
        return []
    body = response.json()
    if body.get("code") != 200:
        return []
    return [int(n["id"]) for n in (body.get("data") or []) if "id" in n]
