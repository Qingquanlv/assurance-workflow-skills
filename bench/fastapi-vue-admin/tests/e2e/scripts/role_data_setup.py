"""Role lookup helpers for E2E tests (read-only).

Mapped to .aws/data-knowledge.yaml capability: role_data_setup.
Used by tests/e2e/test_users_e2e.py for TC-USER-103 seeded-role discovery.
"""
from __future__ import annotations

from typing import Any

import httpx

from tests.e2e.scripts.user_data_setup import get_backend_base_url


def find_role_by_name(name: str, token: str) -> int | None:
    base_url = get_backend_base_url()
    resp = httpx.get(
        f"{base_url}/api/v1/role/list",
        params={"role_name": name, "page": 1, "page_size": 50},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    for row in resp.json().get("data", []) or []:
        if row.get("name") == name:
            return int(row["id"])
    return None


def create_role_via_api(*, token: str, name: str, desc: str = "") -> int:
    base_url = get_backend_base_url()
    resp = httpx.post(
        f"{base_url}/api/v1/role/create",
        json={"name": name, "desc": desc},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(
            f"create_role_via_api: code={body.get('code')} msg={body.get('msg')!r}"
        )
    role_id = find_role_by_name(name, token)
    if role_id is None:
        raise RuntimeError(
            f"create_role_via_api: row not visible after create for name={name!r}"
        )
    return role_id


def delete_role(role_id: int, token: str) -> None:
    base_url = get_backend_base_url()
    resp = httpx.delete(
        f"{base_url}/api/v1/role/delete",
        params={"role_id": role_id},
        headers={"token": token},
        timeout=30,
    )
    if resp.status_code == 404:
        return
    resp.raise_for_status()


def get_role_authorized(role_id: int, token: str) -> dict[str, Any]:
    base_url = get_backend_base_url()
    resp = httpx.get(
        f"{base_url}/api/v1/role/authorized",
        params={"id": role_id},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(
            f"get_role_authorized: code={body.get('code')} msg={body.get('msg')!r}"
        )
    return body["data"]
