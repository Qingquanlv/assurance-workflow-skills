from __future__ import annotations

import httpx


def create_role(client: httpx.Client, name: str, desc: str = "") -> httpx.Response:
    return client.post("/api/v1/role/create", json={"name": name, "desc": desc})


def find_role_id_by_name(client: httpx.Client, name: str) -> int | None:
    response = client.get(
        "/api/v1/role/list",
        params={"role_name": name, "page": 1, "page_size": 100},
    )
    if response.status_code != 200:
        return None
    body = response.json()
    if body.get("code") != 200:
        return None
    for item in body.get("data") or []:
        if item.get("name") == name:
            role_id = item.get("id")
            if isinstance(role_id, int):
                return role_id
    return None


def safe_delete_role(client: httpx.Client, role_id: int) -> None:
    """Idempotent role delete — swallows 404."""
    client.delete("/api/v1/role/delete", params={"role_id": role_id})


def update_role(
    client: httpx.Client, role_id: int, name: str, desc: str = ""
) -> httpx.Response:
    return client.post(
        "/api/v1/role/update",
        json={"id": role_id, "name": name, "desc": desc},
    )


def delete_role(client: httpx.Client, role_id: int) -> httpx.Response:
    return client.delete("/api/v1/role/delete", params={"role_id": role_id})


def get_role_detail(client: httpx.Client, role_id: int) -> httpx.Response:
    return client.get("/api/v1/role/get", params={"role_id": role_id})


def list_roles(client: httpx.Client, **params: object) -> httpx.Response:
    return client.get("/api/v1/role/list", params=params)


def get_role_authorized(client: httpx.Client, role_id: int) -> httpx.Response:
    return client.get("/api/v1/role/authorized", params={"id": role_id})


def update_role_authorized(
    client: httpx.Client,
    role_id: int,
    menu_ids: list[int],
    api_infos: list[dict],
) -> httpx.Response:
    return client.post(
        "/api/v1/role/authorized",
        json={"id": role_id, "menu_ids": menu_ids, "api_infos": api_infos},
    )


def safe_delete_role_by_name(client: httpx.Client, name: str) -> None:
    """Idempotent precondition: lookup role by name and delete if present."""
    role_id = find_role_id_by_name(client, name)
    if role_id is not None:
        safe_delete_role(client, role_id)
