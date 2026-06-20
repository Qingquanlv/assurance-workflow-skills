"""User data setup helpers for E2E tests.

Mapped to .aws/data-knowledge.yaml capability: user_data_setup.
Used by tests/e2e/test_users_e2e.py.
"""
from __future__ import annotations

import os

import httpx

DEFAULT_BACKEND_URL = "http://localhost:9999"
DEFAULT_ADMIN_USERNAME = "admin"
DEFAULT_ADMIN_PASSWORD = "123456"


def get_backend_base_url() -> str:
    return (
        os.environ.get("BASE_URL")
        or os.environ.get("API_BASE_URL")
        or DEFAULT_BACKEND_URL
    )


def get_admin_credentials() -> tuple[str, str]:
    return (DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD)


def get_admin_token() -> str:
    base_url = get_backend_base_url()
    username, password = get_admin_credentials()
    resp = httpx.post(
        f"{base_url}/api/v1/base/access_token",
        json={"username": username, "password": password},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["data"]["access_token"]


def delete_user(user_id: int, token: str) -> None:
    """Idempotent best-effort cleanup. Swallows 404 / network failures."""
    base_url = get_backend_base_url()
    try:
        resp = httpx.delete(
            f"{base_url}/api/v1/user/delete",
            params={"user_id": user_id},
            headers={"token": token},
            timeout=30,
        )
        if resp.status_code in (200, 404):
            return
        try:
            body = resp.json()
            if body.get("code") in (200, 404):
                return
        except Exception:
            pass
    except Exception:
        return


def create_user_via_api(
    token: str,
    username: str,
    email: str,
    password: str = "Test@1234",
    role_ids: list[int] | None = None,
    is_active: bool = True,
    is_superuser: bool = False,
) -> int:
    """Create a user via API and return its DB ID resolved through /user/list."""
    base_url = get_backend_base_url()
    role_ids = role_ids or []
    create_resp = httpx.post(
        f"{base_url}/api/v1/user/create",
        json={
            "username": username,
            "email": email,
            "password": password,
            "role_ids": role_ids,
            "is_active": is_active,
            "is_superuser": is_superuser,
        },
        headers={"token": token},
        timeout=30,
    )
    create_resp.raise_for_status()
    list_resp = httpx.get(
        f"{base_url}/api/v1/user/list",
        params={"username": username, "page": 1, "page_size": 10},
        headers={"token": token},
        timeout=30,
    )
    list_resp.raise_for_status()
    rows = list_resp.json().get("data", []) or []
    for row in rows:
        if row.get("username") == username:
            return int(row["id"])
    raise RuntimeError(
        f"create_user_via_api: created user {username!r} not found via /user/list"
    )
