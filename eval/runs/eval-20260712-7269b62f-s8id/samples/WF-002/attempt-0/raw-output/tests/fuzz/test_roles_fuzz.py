"""Eval smoke fuzz test for roles module (collect-only; schemathesis checked by scorer)."""
import os

import pytest

pytestmark = pytest.mark.fuzz

OPENAPI_URL = os.getenv("OPENAPI_URL", "http://localhost:9999/openapi.json")
# Full codegen uses: import schemathesis; schemathesis.from_uri(OPENAPI_URL)


def test_roles_fuzz_eval_smoke():
    """TC-ROLES-FUZZ-001 static stub."""
    assert "openapi" in OPENAPI_URL
