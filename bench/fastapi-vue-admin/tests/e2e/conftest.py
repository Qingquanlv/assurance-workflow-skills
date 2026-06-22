from __future__ import annotations

import os
import secrets
from collections.abc import Generator

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.menu_data_setup import (
    delete_menu,
)
from tests.e2e.scripts.role_data_setup import (
    delete_role,
)
from tests.e2e.scripts.user_data_setup import (
    delete_user,
    get_admin_credentials,
    get_admin_token,
    get_backend_base_url,
)

DEFAULT_FRONTEND_URL = "http://localhost:3100"
ADMIN_LOGIN_TIMEOUT_MS = 15_000
NAV_TIMEOUT_MS = 15_000


def _frontend_base_url() -> str:
    return os.environ.get("FRONTEND_BASE_URL") or DEFAULT_FRONTEND_URL


@pytest.fixture(scope="session")
def backend_base_url() -> str:
    return get_backend_base_url()


@pytest.fixture(scope="session")
def frontend_base_url() -> str:
    return _frontend_base_url()


@pytest.fixture(scope="session")
def admin_token() -> str:
    return get_admin_token()


@pytest.fixture
def unique_username() -> str:
    return f"qa_e2e_user_{secrets.token_hex(4)}"


@pytest.fixture
def cleanup_users(admin_token: str) -> Generator[list[int], None, None]:
    created: list[int] = []
    yield created
    for user_id in created:
        delete_user(user_id, admin_token)


@pytest.fixture
def logged_in_page(page: Page, frontend_base_url: str) -> Page:
    username, password = get_admin_credentials()
    page.set_default_timeout(NAV_TIMEOUT_MS)
    page.goto(f"{frontend_base_url}/login", wait_until="domcontentloaded")
    page.get_by_placeholder("admin").fill(username)
    page.get_by_placeholder("123456").fill(password)
    page.get_by_role("button", name="登录").click()
    page.wait_for_url(
        lambda url: "/login" not in url, timeout=ADMIN_LOGIN_TIMEOUT_MS
    )
    return page


@pytest.fixture
def user_list_page(logged_in_page: Page, frontend_base_url: str) -> Page:
    page = logged_in_page
    page.goto(f"{frontend_base_url}/system/user", wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建用户")).to_be_visible(
        timeout=NAV_TIMEOUT_MS
    )
    return page


@pytest.fixture
def unique_menu_token() -> str:
    return secrets.token_hex(4)


@pytest.fixture
def cleanup_menus(admin_token: str) -> Generator[list[int], None, None]:
    created: list[int] = []
    yield created
    for menu_id in created:
        delete_menu(menu_id, admin_token)


@pytest.fixture
def menu_management_page(logged_in_page: Page, frontend_base_url: str) -> Page:
    page = logged_in_page
    page.goto(f"{frontend_base_url}/system/menu", wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建根菜单")).to_be_visible(
        timeout=NAV_TIMEOUT_MS
    )
    return page


@pytest.fixture
def unique_role_token() -> str:
    return secrets.token_hex(4)


@pytest.fixture
def cleanup_roles(admin_token: str) -> Generator[list[int], None, None]:
    created: list[int] = []
    yield created
    for role_id in created:
        delete_role(role_id, admin_token)


@pytest.fixture
def role_management_page(logged_in_page: Page, frontend_base_url: str) -> Page:
    page = logged_in_page
    page.goto(f"{frontend_base_url}/system/role", wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建角色")).to_be_visible(
        timeout=NAV_TIMEOUT_MS
    )
    return page


@pytest.fixture(autouse=True)
def _record_case_id(request: pytest.FixtureRequest) -> None:
    """Write @pytest.mark.case_id value to JUnit XML <properties> for result mapping."""
    marker = request.node.get_closest_marker("case_id")
    if marker and marker.args:
        request.node.user_properties.append(("case_id", marker.args[0]))
