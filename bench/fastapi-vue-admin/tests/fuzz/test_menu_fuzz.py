"""TC-MENUS-FUZZ-001: schema-based fuzz on GET /api/v1/menu/list.

Plan: qa/changes/eval-sample-003/plans/fuzz-plan.md
Case: qa/changes/eval-sample-003/cases/menus/case.yaml (TC-MENUS-FUZZ-001)

Endpoint chosen per fact-baseline.json#facts.module_route_prefix.menus = "/api/v1/menu"
(documentation drift FACT-WARN-001 — actual mounted prefix is singular /menu).

Auth: raw `token` header (no Bearer scheme) per fact-baseline.json#facts.token_header
and FACT-WARN-002.

Schemathesis is configured to fail the test when:
  - the endpoint returns a 5xx for any schema-conformant fuzz input, OR
  - the response payload does not conform to its declared OpenAPI schema.
"""
from __future__ import annotations

import os

import pytest
import schemathesis

from tests.api.helpers.auth import login_admin

pytestmark = pytest.mark.fuzz


BASE_URL = os.getenv("BASE_URL") or os.getenv("API_BASE_URL") or "http://localhost:9999"
OPENAPI_URL = os.getenv("OPENAPI_URL", f"{BASE_URL}/openapi.json")


schema = (
    schemathesis.openapi.from_url(
        OPENAPI_URL,
        config=schemathesis.Config(
            projects=schemathesis.config.ProjectsConfig(
                default=schemathesis.config.ProjectConfig(base_url=BASE_URL),
            ),
        ),
    )
    .include(path="/api/v1/menu/list", method="GET")
)


@pytest.fixture(scope="session")
def admin_token() -> str:
    return login_admin(BASE_URL)


@pytest.mark.case_id("TC-MENUS-FUZZ-001")
@schema.parametrize()
def test_menus_list_fuzz(case: schemathesis.Case, admin_token: str) -> None:
    response = case.call(headers={"token": admin_token})
    case.validate_response(response)
