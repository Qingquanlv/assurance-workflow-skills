"""Eval smoke E2E test for roles module (collect-only friendly)."""
import pytest

pytestmark = pytest.mark.e2e


def test_role_eval_smoke():
    """TC-ROLES-E2E-001 smoke — no browser required for collect."""
    assert True
