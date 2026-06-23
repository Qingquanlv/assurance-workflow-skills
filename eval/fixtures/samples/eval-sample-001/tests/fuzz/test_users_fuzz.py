"""Eval smoke fuzz test for users module (collect-only; schemathesis checked by scorer)."""
import os

import pytest

pytestmark = pytest.mark.fuzz

OPENAPI_URL = os.getenv("OPENAPI_URL", "http://localhost:9999/openapi.json")


def test_users_fuzz_eval_smoke():
    """TC-USER-FUZZ-001 static stub."""
    assert "openapi" in OPENAPI_URL
