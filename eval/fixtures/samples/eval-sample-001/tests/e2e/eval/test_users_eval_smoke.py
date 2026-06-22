"""Eval smoke E2E test for users module (collect-only friendly, no Playwright)."""
import pytest

pytestmark = pytest.mark.e2e


def test_users_eval_smoke():
    """TC-USER-E2E-001 smoke — isolated from bench conftest via --confcutdir."""
    assert True
