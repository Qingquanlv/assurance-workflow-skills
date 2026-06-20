"""Menu data setup helpers for E2E tests.

Mapped to .aws/data-knowledge.yaml capability: menu_data_setup.
Used by tests/e2e/test_menu_e2e.py.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_BACKEND_URL = "http://localhost:9999"


def get_backend_base_url() -> str:
    return (
        os.environ.get("BASE_URL")
        or os.environ.get("API_BASE_URL")
        or DEFAULT_BACKEND_URL
    )


def _flatten_tree(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for node in nodes or []:
        flat.append(node)
        if node.get("children"):
            flat.extend(_flatten_tree(node["children"]))
    return flat


def list_menus_tree(token: str) -> list[dict[str, Any]]:
    base_url = get_backend_base_url()
    resp = httpx.get(
        f"{base_url}/api/v1/menu/list",
        params={"page": 1, "page_size": 1000},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return body.get("data", []) or []


def find_menu_by_name(name: str, token: str) -> dict[str, Any] | None:
    tree = list_menus_tree(token)
    for node in _flatten_tree(tree):
        if node.get("name") == name:
            return node
    return None


def create_menu_via_api(
    token: str,
    name: str,
    path: str,
    menu_type: str = "catalog",
    parent_id: int = 0,
    component: str = "Layout",
    order: int = 100,
    icon: str = "",
    is_hidden: bool = False,
    keepalive: bool = True,
    redirect: str = "",
) -> int:
    """Create a menu via API and return its DB ID resolved through /menus/list."""
    base_url = get_backend_base_url()
    resp = httpx.post(
        f"{base_url}/api/v1/menu/create",
        json={
            "name": name,
            "path": path,
            "menu_type": menu_type,
            "parent_id": parent_id,
            "component": component,
            "order": order,
            "icon": icon,
            "is_hidden": is_hidden,
            "keepalive": keepalive,
            "redirect": redirect,
        },
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(f"create_menu_via_api failed: {body}")
    found = find_menu_by_name(name, token)
    if not found:
        raise RuntimeError(
            f"create_menu_via_api: created menu {name!r} not found via /menus/list"
        )
    return int(found["id"])


def delete_menu(menu_id: int, token: str) -> None:
    """Idempotent best-effort cleanup. Swallows 404 / network failures and
    non-200 business codes (e.g. 'menu has children')."""
    base_url = get_backend_base_url()
    try:
        resp = httpx.delete(
            f"{base_url}/api/v1/menu/delete",
            params={"id": menu_id},
            headers={"token": token},
            timeout=30,
        )
        if resp.status_code in (200, 404):
            return
    except Exception:
        return
