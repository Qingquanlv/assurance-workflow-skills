from __future__ import annotations

import secrets

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.role_data_setup import find_role_by_name
from tests.e2e.scripts.user_data_setup import create_user_via_api

pytestmark = pytest.mark.e2e

ACTION_TIMEOUT_MS = 10_000


def _row_for_username(page: Page, username: str):
    return page.get_by_role("row").filter(has_text=username).first


def _open_add_modal(page: Page) -> None:
    page.get_by_role("button", name="新建用户").click()
    expect(page.get_by_role("dialog")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(page.get_by_role("dialog")).to_contain_text("新增用户")


def _fill_required_user_fields(
    page: Page, username: str, email: str, password: str = "Test@1234"
) -> None:
    dialog = page.get_by_role("dialog")
    dialog.get_by_placeholder("请输入用户名称").fill(username)
    dialog.get_by_placeholder("请输入邮箱").fill(email)
    dialog.get_by_placeholder("请输入密码").fill(password)
    dialog.get_by_placeholder("请确认密码").fill(password)


def _save_modal(page: Page) -> None:
    page.get_by_role("dialog").get_by_role("button", name="保存").click()


def test_create_user_via_modal_success(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    email = f"{unique_username}@example.com"

    _open_add_modal(page)
    _fill_required_user_fields(page, unique_username, email)
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(page.get_by_role("dialog")).not_to_be_visible(timeout=ACTION_TIMEOUT_MS)

    search = page.get_by_placeholder("请输入用户名称").first
    search.fill(unique_username)
    search.press("Enter")
    expect(_row_for_username(page, unique_username)).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )

    expect(_row_for_username(page, unique_username)).to_contain_text(email)

    from tests.e2e.scripts.user_data_setup import (
        get_backend_base_url,
    )
    import httpx

    resp = httpx.get(
        f"{get_backend_base_url()}/api/v1/user/list",
        params={"username": unique_username, "page": 1, "page_size": 10},
        headers={"token": admin_token},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json().get("data", []) or []
    assert rows, f"User {unique_username} not found via API after UI create"
    cleanup_users.append(int(rows[0]["id"]))


def test_create_user_duplicate_email_shows_error(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    email = f"{unique_username}@example.com"

    seed_username = f"s_{unique_username[2:]}"[:20]
    seed_id = create_user_via_api(
        token=admin_token,
        username=seed_username,
        email=email,
    )
    cleanup_users.append(seed_id)

    _open_add_modal(page)
    _fill_required_user_fields(page, unique_username, email)
    _save_modal(page)

    expect(page.get_by_role("dialog")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(page.get_by_text("新增成功")).not_to_be_visible(timeout=2_000)


def test_edit_user_updates_email(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    original_email = f"{unique_username}@example.com"
    new_email = f"{unique_username}_edited@example.com"

    user_id = create_user_via_api(
        token=admin_token,
        username=unique_username,
        email=original_email,
    )
    cleanup_users.append(user_id)

    search = page.get_by_placeholder("请输入用户名称").first
    search.fill(unique_username)
    search.press("Enter")
    row = _row_for_username(page, unique_username)
    expect(row).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    row.get_by_role("button", name="编辑").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(dialog).to_contain_text("编辑用户")

    email_input = dialog.get_by_placeholder("请输入邮箱")
    email_input.fill(new_email)
    _save_modal(page)

    expect(page.get_by_text("编辑成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    import httpx
    from tests.e2e.scripts.user_data_setup import get_backend_base_url

    resp = httpx.get(
        f"{get_backend_base_url()}/api/v1/user/list",
        params={"username": unique_username, "page": 1, "page_size": 10},
        headers={"token": admin_token},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json().get("data", []) or []
    assert rows and rows[0]["email"] == new_email, (
        f"Expected email {new_email}, got {rows[0]['email'] if rows else 'no row'}"
    )


def test_delete_user_removes_row(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    email = f"{unique_username}@example.com"

    user_id = create_user_via_api(
        token=admin_token,
        username=unique_username,
        email=email,
    )

    search = page.get_by_placeholder("请输入用户名称").first
    search.fill(unique_username)
    search.press("Enter")
    row = _row_for_username(page, unique_username)
    expect(row).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    row.get_by_role("button", name="删除").click()
    page.get_by_role("button", name="确认").click()

    expect(page.get_by_text("删除成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    import httpx
    from tests.e2e.scripts.user_data_setup import get_backend_base_url

    resp = httpx.get(
        f"{get_backend_base_url()}/api/v1/user/list",
        params={"username": unique_username, "page": 1, "page_size": 10},
        headers={"token": admin_token},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json().get("data", []) or []
    assert not rows, f"User {unique_username} still present after UI delete"

    if rows:
        cleanup_users.append(user_id)


def test_reset_password_normal_user(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    email = f"{unique_username}@example.com"

    user_id = create_user_via_api(
        token=admin_token,
        username=unique_username,
        email=email,
        password="Initial@1234",
    )
    cleanup_users.append(user_id)

    search = page.get_by_placeholder("请输入用户名称").first
    search.fill(unique_username)
    search.press("Enter")
    row = _row_for_username(page, unique_username)
    expect(row).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    row.get_by_role("button", name="重置密码").click()
    page.get_by_role("button", name="确认").click()

    expect(page.get_by_text("密码已成功重置为123456")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )

    import httpx
    from tests.e2e.scripts.user_data_setup import get_backend_base_url

    login_resp = httpx.post(
        f"{get_backend_base_url()}/api/v1/base/access_token",
        json={"username": unique_username, "password": "123456"},
        timeout=30,
    )
    assert login_resp.status_code == 200, login_resp.text
    body = login_resp.json()
    assert body.get("data", {}).get("access_token"), (
        f"Reset password did not authorize user; body={body}"
    )


def test_assign_role_to_new_user(
    user_list_page: Page,
    admin_token: str,
    cleanup_users: list[int],
    unique_username: str,
):
    page = user_list_page
    email = f"{unique_username}@example.com"

    role_name = "管理员"
    role_id = find_role_by_name(role_name, admin_token)
    if role_id is None:
        pytest.skip(f"Seeded role {role_name!r} not found; cannot test role binding")

    _open_add_modal(page)
    _fill_required_user_fields(page, unique_username, email)
    dialog = page.get_by_role("dialog")
    dialog.get_by_role("checkbox", name=role_name).check()
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    import httpx
    from tests.e2e.scripts.user_data_setup import get_backend_base_url

    resp = httpx.get(
        f"{get_backend_base_url()}/api/v1/user/list",
        params={"username": unique_username, "page": 1, "page_size": 10},
        headers={"token": admin_token},
        timeout=30,
    )
    resp.raise_for_status()
    rows = resp.json().get("data", []) or []
    assert rows, f"User {unique_username} not found after UI create"
    user_row = rows[0]
    cleanup_users.append(int(user_row["id"]))

    role_ids = [r["id"] for r in user_row.get("roles", [])]
    assert role_id in role_ids, (
        f"Expected role {role_id} in user roles, got {role_ids}"
    )
