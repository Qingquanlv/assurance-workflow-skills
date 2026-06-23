"""TC-ROLES-FUZZ-001: schema-based fuzz on GET /api/v1/role/list.

Plan: qa/changes/eval-sample-002/plans/fuzz-plan.md
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
    .include(path="/api/v1/role/list", method="GET")
)


@pytest.fixture(scope="session")
def admin_token() -> str:
    return login_admin(BASE_URL)


@pytest.mark.case_id("TC-ROLES-FUZZ-001")
@schema.parametrize()
def test_roles_list_fuzz(case: schemathesis.Case, admin_token: str) -> None:
    response = case.call(headers={"token": admin_token})
    case.validate_response(response)
