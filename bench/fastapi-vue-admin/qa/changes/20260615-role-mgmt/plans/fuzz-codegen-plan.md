# Fuzz Codegen Plan — Role Management (`20260615-role-mgmt`)

## Source

- `qa/changes/20260615-role-mgmt/plans/fuzz-plan.md` (paired plan)
- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (TC-ROLE-200)
- `tests/e2e/scripts/user_data_setup.py` (existing `get_admin_token` helper — reusable)

## Output Files

| Action | Path |
|---|---|
| **CREATE** | `tests/fuzz/__init__.py` (empty) |
| **CREATE** | `tests/fuzz/test_roles_fuzz.py` |

No modifications to `app/`, `web/`, `tests/api/`, `tests/e2e/`. Strictly additive.

## Module Layout

```python
"""Schema-based robustness fuzz tests for role module endpoints.

Covers TC-ROLE-200. Reads OpenAPI schema from the live backend and
generates randomized payloads that conform to the schema's parameter
constraints, asserting no 5xx responses and full schema conformance
of returned bodies.
"""
import os
import warnings
from typing import Generator, Set

import pytest
import schemathesis
from schemathesis.checks import (
    not_a_server_error,
    status_code_conformance,
    response_schema_conformance,
    content_type_conformance,
)

from tests.e2e.scripts.user_data_setup import get_admin_token

pytestmark = pytest.mark.fuzz  # NOTE: marker registration in pyproject.toml — see "Pytest Marker" below

OPENAPI_URL = os.getenv("OPENAPI_URL", "http://localhost:9999/openapi.json")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:9999")
ROLE_PATH_PREFIX = "/api/v1/role"

# Module-level token cache (avoid per-test login storms)
AUTH_TOKEN: str = ""


def _load_token() -> str:
    global AUTH_TOKEN
    if not AUTH_TOKEN:
        AUTH_TOKEN = get_admin_token()
    return AUTH_TOKEN


# Load schema once per session
schema = schemathesis.from_uri(OPENAPI_URL, base_url=BACKEND_BASE_URL)


# ---- Auth injection ---------------------------------------------------------
@schema.hooks.register("before_call")
def _inject_admin_token(context, case):
    """Attach project-specific `token` header (NOT Authorization: Bearer)."""
    case.headers = case.headers or {}
    case.headers["token"] = _load_token()


# ---- Cleanup snapshot -------------------------------------------------------
def _list_role_ids(token: str) -> Set[int]:
    import httpx

    with httpx.Client(base_url=BACKEND_BASE_URL, timeout=10.0) as client:
        r = client.get(
            "/api/v1/role/list",
            params={"page": 1, "page_size": 1000},
            headers={"token": token},
        )
        r.raise_for_status()
        body = r.json()
        return {int(item["id"]) for item in (body.get("data") or [])}


def _delete_role_silent(role_id: int, token: str) -> None:
    import httpx

    with httpx.Client(base_url=BACKEND_BASE_URL, timeout=10.0) as client:
        client.delete(
            "/api/v1/role/delete",
            params={"role_id": role_id},
            headers={"token": token},
        )


@pytest.fixture(scope="session", autouse=True)
def _fuzz_roles_oob_cleanup() -> Generator[None, None, None]:
    """Sweep any roles created during the fuzz session (id-set diff)."""
    token = _load_token()
    pre = _list_role_ids(token)
    yield
    try:
        post = _list_role_ids(token)
    except Exception as exc:
        warnings.warn(f"[fuzz-roles] post-snapshot failed: {exc}")
        return
    leaked = post - pre
    for role_id in leaked:
        try:
            _delete_role_silent(role_id, token)
        except Exception as exc:
            warnings.warn(f"[fuzz-roles] cleanup failed for role_id={role_id}: {exc}")


# ---- Test cases -------------------------------------------------------------
@pytest.mark.case_id("TC-ROLE-200")
@schema.parametrize(endpoint=r"^/api/v1/role/")
@schema.given(...)  # let hypothesis manage state
def test_role_endpoints_schema_robustness(case):
    """Schemathesis runs all checks per generated example.

    Hard assertions (case.call_and_validate() raises on any failed check):
      - not_a_server_error: HTTP < 500
      - status_code_conformance: status in OpenAPI spec
      - response_schema_conformance: body matches schema
      - content_type_conformance: Content-Type matches schema
    """
    case.call_and_validate(
        checks=(
            not_a_server_error,
            status_code_conformance,
            response_schema_conformance,
            content_type_conformance,
        ),
    )
```

## Test Function Plan

Single parameterized test driven by `@schema.parametrize(endpoint=r"^/api/v1/role/")`. Schemathesis will generate:

- 1 pytest test per `(method, path)` from the OpenAPI schema = 7 tests for role endpoints
- Each test runs Hypothesis with `--hypothesis-max-examples=25` (configured at run time, NOT hard-coded)
- Total: ~175 generated examples

## Pytest Marker

`pyproject.toml` `[tool.pytest.ini_options].markers` currently has:
```toml
markers = [
    "api: API-level tests against running FastAPI backend",
    "e2e: End-to-end browser tests via Playwright",
    "case_id(id): Test case identifier written to JUnit XML for result mapping",
]
```

**Codegen MUST add** the `fuzz` marker:
```toml
"fuzz: schemathesis-based robustness fuzz tests against live backend",
```

This is a small, additive edit to the existing markers list. Documented separately so the reviewer sees it.

## Hypothesis Settings (Run-time)

`aws run` invokes pytest as:
```
uv run pytest tests/fuzz/ -v -m fuzz \
    --hypothesis-max-examples=25 \
    --hypothesis-seed=20260615 \
    --hypothesis-deadline=5000
```

Determinism via fixed seed; max-examples and deadline are CLI-tunable.

## Failure Modes & Mapping

| Schemathesis failure | Maps to | Action |
|---|---|---|
| `not_a_server_error` raised | TC-ROLE-200 assertion "0 server_error" | test FAILS → `aws-inspect` classifies as `product_issue` per case spec |
| `response_schema_conformance` raised | TC-ROLE-200 assertion "0 schema_violation" | test FAILS → `product_issue` |
| `status_code_conformance` raised | (same bucket as above) | test FAILS → `product_issue` |
| `Hypothesis Flaky / DeadlineExceeded` | (not in case assertions) | test FAILS → inspect category `flaky_or_perf`; healing rules: bump deadline up to 10s once, then leave |

## Reusable Helpers

- `tests/e2e/scripts/user_data_setup.get_admin_token` — confirmed importable from `tests/fuzz/`. No new helper required.
- `httpx.Client` is already a transitive dep (FastAPI), no new installs.

## Risks / Mitigations Codegen Must Encode

1. **Schema fetch timing**: backend must be running at codegen-execution time. Add a session-scoped fixture that retries `httpx.get(OPENAPI_URL)` 3× before giving up — implemented inline in `schema = schemathesis.from_uri(...)` retry-on-import? **No** — use a module-level guarded import: catch `httpx.ConnectError` at import and emit a clean `pytest.fail("backend not running on " + OPENAPI_URL)` from each test rather than crashing collection.
2. **Token expiry during long runs**: token has expiry; for the small budget (175 examples, ~3 min) we trust it. If the run exceeds 30 min, healing should re-acquire token mid-run; out of scope for v1.
3. **Hypothesis cache**: emit `.hypothesis/` to `.gitignore` if not already excluded. **Plan: do not modify .gitignore from codegen — manual fix later if needed.**

## Acceptance Checklist

- [ ] `tests/fuzz/__init__.py` exists (empty, package marker)
- [ ] `tests/fuzz/test_roles_fuzz.py` exists with structure as above
- [ ] `pyproject.toml` markers list includes `fuzz: ...`
- [ ] `uv run pytest tests/fuzz/ --collect-only` lists 7 endpoint tests
- [ ] `uv run pytest tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness -m fuzz --hypothesis-max-examples=2` runs locally without import error
- [ ] `case_id` marker propagated for all 7 generated tests (verify via JUnit XML)
- [ ] No edits to `app/`, `web/`, existing `tests/api/`, `tests/e2e/`
- [ ] Cleanup fixture is `autouse=True` and `scope="session"`

## Codegen Readiness

`ready_with_warnings` (was `not_ready` until B-FUZZ-01 resolved by user installing schemathesis 3.39.16). Warnings:

- NR-FUZZ-01: weakly-typed `api_infos` fuzz behavior unclear (product issue vs. expected) — escalates to inspect classification
- NR-FUZZ-02: long-string fuzz on `name` may hit DB integrity error — same escalation
- NR-FUZZ-03: pytest downgraded 9.0.3 → 8.4.2 by `uv add schemathesis` — verified existing tests still collect; non-blocking but **the user should be aware**
