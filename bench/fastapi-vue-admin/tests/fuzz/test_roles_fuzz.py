"""Schema-based robustness fuzz tests for role module endpoints.

Covers TC-ROLE-200. Reads OpenAPI schema from the live backend and
generates randomized payloads that conform to the schema's parameter
constraints, asserting no 5xx responses and full schema conformance
of returned bodies.
"""
import os
import warnings
from typing import Generator, Set

import httpx
import pytest
import schemathesis
from schemathesis.checks import CHECKS, load_all_checks

from tests.e2e.scripts.user_data_setup import get_admin_token

pytestmark = [pytest.mark.fuzz, pytest.mark.case_id("TC-ROLE-200")]

OPENAPI_URL = os.getenv("OPENAPI_URL", "http://localhost:9999/openapi.json")
BACKEND_BASE_URL = os.getenv("BACKEND_BASE_URL", "http://localhost:9999")
ROLE_PATH_PREFIX = "/api/v1/role"

AUTH_TOKEN: str = ""


def _load_token() -> str:
    global AUTH_TOKEN
    if not AUTH_TOKEN:
        AUTH_TOKEN = get_admin_token()
    return AUTH_TOKEN


load_all_checks()
_FUZZ_CHECKS = CHECKS.get_by_names(
    [
        "not_a_server_error",
        "status_code_conformance",
        "response_schema_conformance",
        "content_type_conformance",
    ]
)

schema = schemathesis.openapi.from_url(OPENAPI_URL).include(path_regex=r"^/api/v1/role/")


@schemathesis.hook
def before_call(context, case, **kwargs):
    case.headers = case.headers or {}
    case.headers["token"] = _load_token()


def _list_role_ids(token: str) -> Set[int]:
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
    with httpx.Client(base_url=BACKEND_BASE_URL, timeout=10.0) as client:
        client.delete(
            "/api/v1/role/delete",
            params={"role_id": role_id},
            headers={"token": token},
        )


@pytest.fixture(scope="session", autouse=True)
def _fuzz_roles_oob_cleanup() -> Generator[None, None, None]:
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


@schema.parametrize()
def test_role_endpoints_schema_robustness(case):
    """TC-ROLE-200: schemathesis robustness check across all role endpoints.

    Hard checks (call_and_validate raises on any failure):
      - not_a_server_error: HTTP < 500
      - status_code_conformance: status in OpenAPI spec
      - response_schema_conformance: body matches schema
      - content_type_conformance: Content-Type matches schema
    """
    case.call_and_validate(checks=_FUZZ_CHECKS)
