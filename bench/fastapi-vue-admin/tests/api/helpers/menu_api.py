from __future__ import annotations

from typing import Any

import httpx


def list_menus(client: httpx.Client) -> httpx.Response:
    return client.get(
        "/api/v1/menu/list",
        params={"page": 1, "page_size": 1000},
    )


def get_menu(client: httpx.Client, menu_id: int) -> httpx.Response:
    return client.get("/api/v1/menu/get", params={"menu_id": menu_id})


def create_menu(
    client: httpx.Client,
    *,
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
) -> httpx.Response:
    return client.post(
        "/api/v1/menu/create",
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
    )


def update_menu(
    client: httpx.Client,
    *,
    menu_id: int,
    name: str,
    path: str,
    menu_type: str,
    parent_id: int,
    component: str,
    order: int,
    icon: str = "",
    is_hidden: bool = False,
    keepalive: bool = True,
    redirect: str = "",
) -> httpx.Response:
    return client.post(
        "/api/v1/menu/update",
        json={
            "id": menu_id,
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
    )


def delete_menu(client: httpx.Client, menu_id: int) -> httpx.Response:
    return client.delete("/api/v1/menu/delete", params={"id": menu_id})


def _flatten_tree(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for node in nodes or []:
        flat.append(node)
        children = node.get("children")
        if children:
            flat.extend(_flatten_tree(children))
    return flat


def list_menus_flat(client: httpx.Client) -> list[dict[str, Any]]:
    response = list_menus(client)
    if response.status_code != 200:
        return []
    body = response.json()
    if body.get("code") != 200:
        return []
    return _flatten_tree(body.get("data") or [])


def find_menu_by_name(client: httpx.Client, name: str) -> dict[str, Any] | None:
    for node in list_menus_flat(client):
        if node.get("name") == name:
            return node
    return None


def find_menu_id_by_name(client: httpx.Client, name: str) -> int | None:
    found = find_menu_by_name(client, name)
    if found is None:
        return None
    menu_id = found.get("id")
    return int(menu_id) if isinstance(menu_id, int) else None


def find_menu_by_id(client: httpx.Client, menu_id: int) -> dict[str, Any] | None:
    for node in list_menus_flat(client):
        if int(node.get("id", -1)) == int(menu_id):
            return node
    return None


def read_then_update(
    client: httpx.Client,
    menu_id: int,
    **changes: Any,
) -> httpx.Response:
    """Required because MenuUpdate.component has no Pydantic default; every
    update must echo the full object."""
    current = find_menu_by_id(client, menu_id)
    if current is None:
        raise RuntimeError(f"read_then_update: menu id={menu_id} not found")

    payload: dict[str, Any] = {
        "menu_id": menu_id,
        "name": current.get("name"),
        "path": current.get("path"),
        "menu_type": current.get("menu_type"),
        "parent_id": current.get("parent_id", 0),
        "component": current.get("component", "Layout"),
        "order": current.get("order", 100),
        "icon": current.get("icon", ""),
        "is_hidden": current.get("is_hidden", False),
        "keepalive": current.get("keepalive", True),
        "redirect": current.get("redirect", ""),
    }
    payload.update(changes)
    return update_menu(client, **payload)


def safe_delete_menu(client: httpx.Client, menu_id: int) -> None:
    """Idempotent; swallows 404 and non-200 business codes (e.g. 'has children')."""
    try:
        delete_menu(client, menu_id)
    except Exception:
        return


def safe_delete_menu_by_name(client: httpx.Client, name: str) -> None:
    menu_id = find_menu_id_by_name(client, name)
    if menu_id is None:
        return
    safe_delete_menu(client, menu_id)
