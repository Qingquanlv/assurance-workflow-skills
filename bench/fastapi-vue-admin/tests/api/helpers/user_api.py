from __future__ import annotations

from typing import Any

import httpx


def create_user(
    client: httpx.Client,
    *,
    username: str,
    email: str,
    password: str,
    role_ids: list[int] | None = None,
    is_active: bool = True,
    is_superuser: bool = False,
    dept_id: int = 0,
) -> httpx.Response:
    payload: dict[str, Any] = {
        "email": email,
        "username": username,
        "password": password,
        "is_active": is_active,
        "is_superuser": is_superuser,
        "role_ids": role_ids if role_ids is not None else [],
        "dept_id": dept_id,
    }
    return client.post("/api/v1/user/create", json=payload)


def find_user_id_by_username(client: httpx.Client, username: str) -> int | None:
    """Look up a user id via GET /api/v1/user/list.

    Backend list filter is icontains, so we exact-match on the result set.
    Returns None if no user with this exact username exists.
    """
    response = client.get(
        "/api/v1/user/list",
        params={"username": username, "page": 1, "page_size": 100},
    )
    if response.status_code != 200:
        return None
    body = response.json()
    if body.get("code") != 200:
        return None
    for item in body.get("data") or []:
        if item.get("username") == username:
            user_id = item.get("id")
            if isinstance(user_id, int):
                return user_id
    return None


def get_user(client: httpx.Client, user_id: int) -> httpx.Response:
    return client.get("/api/v1/user/get", params={"user_id": user_id})


def safe_delete_user(client: httpx.Client, user_id: int) -> None:
    """Delete user by id; idempotent — swallows 404."""
    response = client.delete("/api/v1/user/delete", params={"user_id": user_id})
    if response.status_code == 404:
        return
    if response.status_code == 200:
        return
    return


def safe_delete_user_by_username(client: httpx.Client, username: str) -> None:
    """Delete user by username if present. Idempotent."""
    user_id = find_user_id_by_username(client, username)
    if user_id is not None:
        safe_delete_user(client, user_id)
