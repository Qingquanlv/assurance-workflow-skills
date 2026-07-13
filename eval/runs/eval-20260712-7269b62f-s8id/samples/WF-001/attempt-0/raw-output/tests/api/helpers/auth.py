"""Authentication helpers for API tests.

Backend uses literal `token` header (not a standard Authorization Bearer scheme).
Login endpoint: POST /api/v1/base/access_token with JSON body
{"username": ..., "password": ...} → response.data.access_token.
"""
from __future__ import annotations

import httpx


def login(base_url: str, username: str, password: str, timeout: float = 10.0) -> str:
    """Acquire a JWT for the given credentials.

    Returns the raw access_token string. Raises AssertionError on non-200
    or missing token to fail fast in fixtures.
    """
    response = httpx.post(
        f"{base_url}/api/v1/base/access_token",
        json={"username": username, "password": password},
        timeout=timeout,
    )
    assert response.status_code == 200, (
        f"Login failed for {username!r}: HTTP {response.status_code}, body={response.text}"
    )
    body = response.json()
    assert body.get("code") == 200, f"Login body code != 200: {body}"
    token = body.get("data", {}).get("access_token")
    assert isinstance(token, str) and token, f"Missing access_token in response: {body}"
    return token


def login_admin(base_url: str, timeout: float = 10.0) -> str:
    """Acquire a JWT as the seeded default admin (admin/123456)."""
    return login(base_url, "admin", "123456", timeout=timeout)
