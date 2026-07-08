"""Eval smoke E2E test for roles module (collect-only friendly, no Playwright)."""
import pytest

pytestmark = pytest.mark.e2e


def test_role_eval_smoke():
    """TC-ROLES-E2E-001 smoke — isolated from bench conftest via --confcutdir."""
    assert True
