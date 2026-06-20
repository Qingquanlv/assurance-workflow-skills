"""E2E tests for role management (TC-ROLE-100, TC-ROLE-101, TC-ROLE-102).

Plan: qa/changes/20260615-role-mgmt/plans/e2e-plan.md
Codegen plan: qa/changes/20260615-role-mgmt/plans/e2e-codegen-plan.md
"""
from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.role_data_setup import (
    create_role_via_api,
    find_role_by_name,
    get_role_authorized,
)

pytestmark = pytest.mark.e2e

ACTION_TIMEOUT_MS = 10_000
NAV_TIMEOUT_MS = 15_000
TARGET_MENU_NAME = "部门管理"
TARGET_MENU_ID = 6


@pytest.mark.case_id("TC-ROLE-100")
def test_role_management_page_loads(role_management_page: Page) -> None:
    """TC-ROLE-100: 角色管理页 - 管理员登录后列表正常加载."""
    page = role_management_page
    assert "/system/role" in page.url
    expect(page.get_by_role("columnheader", name="角色名")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )
    expect(page.get_by_role("columnheader", name="角色描述")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )
    rows = page.get_by_role("row")
    assert rows.count() >= 2, "Expected at least one data row in role table"


@pytest.mark.case_id("TC-ROLE-101")
def test_create_role_via_ui(
    role_management_page: Page,
    admin_token: str,
    cleanup_roles: list[int],
    unique_role_token: str,
) -> None:
    """TC-ROLE-101: 角色管理页 - 新建角色成功并出现在列表."""
    page = role_management_page
    role_name = f"e2e-role-new-{unique_role_token}"
    role_desc = "e2e create"

    page.get_by_role("button", name="新建角色").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    dialog.get_by_placeholder("请输入角色名称").fill(role_name)
    dialog.get_by_placeholder("请输入角色描述").fill(role_desc)

    dialog.get_by_role("button", name="保存").click()

    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(dialog).not_to_be_visible(timeout=ACTION_TIMEOUT_MS)

    role_id = find_role_by_name(role_name, admin_token)
    assert role_id is not None, (
        f"Role {role_name!r} not found via API after UI create"
    )
    cleanup_roles.append(role_id)

    search_input = page.get_by_placeholder("请输入角色名")
    search_input.fill(role_name)
    search_button = page.get_by_role("button", name="查询")
    if search_button.count() > 0:
        search_button.first.click()
    else:
        search_input.press("Enter")

    matching_row = page.get_by_role("row").filter(has_text=role_name).first
    expect(matching_row).to_be_visible(timeout=ACTION_TIMEOUT_MS)


@pytest.mark.case_id("TC-ROLE-102")
def test_authorize_role_menu_via_ui(
    role_management_page: Page,
    admin_token: str,
    cleanup_roles: list[int],
    unique_role_token: str,
) -> None:
    """TC-ROLE-102: 角色管理页 - 在权限弹窗为角色勾选菜单并保存回显."""
    page = role_management_page
    role_name = f"e2e-role-auth-{unique_role_token}"

    role_id = create_role_via_api(token=admin_token, name=role_name, desc="e2e auth test")
    cleanup_roles.append(role_id)

    page.reload(wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建角色")).to_be_visible(
        timeout=NAV_TIMEOUT_MS
    )

    search_input = page.get_by_placeholder("请输入角色名")
    search_input.fill(role_name)
    search_button = page.get_by_role("button", name="查询")
    if search_button.count() > 0:
        search_button.first.click()
    else:
        search_input.press("Enter")

    target_row = page.get_by_role("row").filter(has_text=role_name).first
    expect(target_row).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    target_row.get_by_role("button", name="设置权限").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(dialog.get_by_text("设置权限")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    dialog.get_by_role("tab", name="菜单权限").click()

    target_node = dialog.get_by_text(TARGET_MENU_NAME, exact=True).first
    if target_node.count() == 0:
        target_node = dialog.locator(
            ".n-tree-node-content__text", has_text=TARGET_MENU_NAME
        ).first
    expect(target_node).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    target_node.click()

    save_button = dialog.get_by_role("button", name="保存")
    if save_button.count() == 0:
        save_button = dialog.get_by_role("button", name="确定")
    save_button.first.click()

    success_locator = page.locator("text=/保存成功|更新成功|设置成功/").first
    expect(success_locator).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    data = get_role_authorized(role_id, admin_token)
    menu_ids = {m["id"] for m in data.get("menus", [])}
    assert TARGET_MENU_ID in menu_ids, (
        f"Expected menu_id={TARGET_MENU_ID} in role bindings, got {menu_ids}"
    )

    page.keyboard.press("Escape")
    target_row = page.get_by_role("row").filter(has_text=role_name).first
    target_row.get_by_role("button", name="设置权限").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    dialog.get_by_role("tab", name="菜单权限").click()
    checked_target = dialog.locator(
        ".n-tree-node:has-text('部门管理') .n-tree-node-checkbox--checked"
    ).first
    expect(checked_target).to_be_visible(timeout=ACTION_TIMEOUT_MS)
