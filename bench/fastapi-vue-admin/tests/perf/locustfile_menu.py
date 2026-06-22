"""Locust load test for the menus module — menu list query.

Drives sustained load against `GET /api/v1/menu/list` so the runner can
measure p95 / error_rate against the thresholds declared in the case
TC-MENUS-PERF-001 (capability `menu-list-query`).

Contract:
- The Locust `name=` label MUST equal `case.performance.capability`
  (`menu-list-query`); the runner uses it to map measured stats back to
  the scenario thresholds.
- Absolute thresholds (`p95_ms`, `error_rate_max`) live in the case YAML
  and are enforced by the runner against Locust stats — intentionally
  not encoded in this file.
- Endpoint path uses the singular `/menu/` prefix per
  facts/fact-baseline.json (FACT-WARN-001). Auth uses the raw `token`
  header, not `Authorization: Bearer` (FACT-WARN-002).
"""

from __future__ import annotations

import os

from locust import HttpUser, between, events, task


_ADMIN_TOKEN: str | None = None


def _resolve_admin_credentials() -> tuple[str, str]:
    username = os.environ.get("AWS_PERF_ADMIN_USERNAME", "admin")
    password = os.environ.get("AWS_PERF_ADMIN_PASSWORD", "123456")
    return username, password


def _fetch_admin_token(host: str) -> str:
    import requests

    username, password = _resolve_admin_credentials()
    url = f"{host.rstrip('/')}/api/v1/base/access_token"
    resp = requests.post(
        url,
        data={"username": username, "password": password},
        timeout=10,
    )
    resp.raise_for_status()
    body = resp.json()
    data = body.get("data") or {}
    token = data.get("access_token")
    if not isinstance(token, str) or not token:
        raise RuntimeError(
            "Failed to acquire admin token: unexpected response shape "
            f"(code={body.get('code')}, msg={body.get('msg')!r})"
        )
    return token


@events.test_start.add_listener
def _on_test_start(environment, **_kwargs) -> None:
    global _ADMIN_TOKEN
    host = environment.host or os.environ.get(
        "AWS_PERF_HOST", "http://localhost:9999"
    )
    _ADMIN_TOKEN = _fetch_admin_token(host)


class MenuListUser(HttpUser):
    wait_time = between(1, 2)

    def on_start(self) -> None:
        if not _ADMIN_TOKEN:
            raise RuntimeError(
                "Admin token was not initialised; _on_test_start did not run."
            )
        # Raw `token` header — project-specific scheme; see app/core/dependency.py.
        self.client.headers.update({"token": _ADMIN_TOKEN})

    @task
    def menu_list(self) -> None:
        # name= MUST equal case.performance.capability so the runner can map
        # measured p95 / error_rate to the case thresholds.
        with self.client.get(
            "/api/v1/menu/list",
            name="menu-list-query",
            params={"page": 1, "page_size": 10},
            catch_response=True,
        ) as response:
            if response.status_code != 200:
                response.failure(
                    f"HTTP {response.status_code}: {response.text[:200]}"
                )
                return
            try:
                payload = response.json()
            except ValueError:
                response.failure("Response body was not valid JSON")
                return
            # FastAPI returns HTTP 200 with business code != 200 on errors;
            # those must count toward error_rate, not be silently swallowed.
            if payload.get("code") != 200:
                response.failure(
                    f"Business code {payload.get('code')}: "
                    f"{payload.get('msg')!r}"
                )
                return
            response.success()
