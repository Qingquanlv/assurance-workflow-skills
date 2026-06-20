# E2E Codegen Plan - Menu Management

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Target File**: tests/e2e/test_menu_e2e.py
**Generated**: 2026-06-14

## File Layout

```
tests/e2e/test_menu_e2e.py          # NEW - 2 test functions
tests/e2e/conftest.py                # MODIFY - add 3 fixtures (cleanup_menus, unique_menu_token, menu_management_page)
tests/e2e/scripts/menu_data_setup.py # NEW - API helpers for menu data setup/teardown
```

## Module Header

```python
from __future__ import annotations

import secrets

import httpx
import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.menu_data_setup import (
    create_menu_via_api,
    delete_menu,
    find_menu_by_name,
    get_backend_base_url,
)

pytestmark = pytest.mark.e2e

ACTION_TIMEOUT_MS = 10_000
```

## Helper Functions (test-file-local)

```python
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


def _fill_basic_menu_fields(page: Page, name: str, path: str, component: str | None = None) -> None:
    dialog = page.get_by_role("dialog")
    dialog.get_by_placeholder("请输入唯一菜单名称").fill(name)
    dialog.get_by_placeholder("请输入访问路径").fill(path)
    if component is not None:
        dialog.get_by_placeholder("请输入组件路径，例如：/system/user").fill(component)
```

## Test Functions

### TC-MENU-E2E-001: test_create_top_level_catalog_via_modal

```python
def test_create_top_level_catalog_via_modal(
    menu_management_page: Page,
    admin_token: str,
    cleanup_menus: list[int],
    unique_menu_token: str,
):
    page = menu_management_page
    name = f"qa-test-cat-{unique_menu_token}"
    path = f"/qa-test-cat-{unique_menu_token}"

    _open_top_level_add_modal(page)
    # Default radio should be "目录" per initForm.menu_type='catalog'
    expect(page.get_by_role("dialog").get_by_role("radio", name="目录")).to_be_checked()
    _fill_basic_menu_fields(page, name, path)
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(page.get_by_role("dialog")).not_to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # API verification
    menu = find_menu_by_name(name, admin_token)
    assert menu is not None, f"Menu {name} not found via API after UI create"
    assert menu["parent_id"] == 0, f"Expected parent_id=0, got {menu['parent_id']}"
    assert menu["menu_type"] == "catalog"
    assert menu["path"] == path
    cleanup_menus.append(int(menu["id"]))
```

### TC-MENU-E2E-002: test_add_child_menu_under_catalog

```python
def test_add_child_menu_under_catalog(
    menu_management_page: Page,
    admin_token: str,
    cleanup_menus: list[int],
    unique_menu_token: str,
):
    page = menu_management_page

    # Seed catalog via API for isolation (do NOT use seeded 系统管理)
    catalog_name = f"qa-test-cat-{unique_menu_token}"
    catalog_path = f"/qa-test-cat-{unique_menu_token}"
    catalog_id = create_menu_via_api(
        token=admin_token,
        name=catalog_name,
        path=catalog_path,
        menu_type="catalog",
        parent_id=0,
    )

    child_name = f"qa-test-child-{unique_menu_token}"
    child_path = f"qa-test-child-{unique_menu_token}"
    child_component = "/qa-test/child"

    # Reload page so newly created catalog appears in tree
    page.reload(wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建根菜单")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    _open_child_add_modal(page, catalog_name)
    _fill_basic_menu_fields(page, child_name, child_path, component=child_component)
    _save_modal(page)

    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # API verification: refetch tree, assert child under catalog
    catalog = find_menu_by_name(catalog_name, admin_token)
    assert catalog is not None
    children_names = [c["name"] for c in catalog.get("children", []) or []]
    assert child_name in children_names, (
        f"Child {child_name} not found under catalog {catalog_name}; "
        f"existing children: {children_names}"
    )

    # Cleanup order: child first, then catalog (backend rejects deleting parent with children)
    child = next((c for c in catalog["children"] if c["name"] == child_name), None)
    assert child is not None
    cleanup_menus.append(int(child["id"]))
    cleanup_menus.append(int(catalog_id))
```

## conftest.py Additions

```python
# Top of file - extend existing imports:
from tests.e2e.scripts.menu_data_setup import (
    delete_menu,
)

# Below cleanup_users fixture, add:

@pytest.fixture
def unique_menu_token() -> str:
    return secrets.token_hex(4)


@pytest.fixture
def cleanup_menus(admin_token: str) -> Generator[list[int], None, None]:
    """Idempotent menu cleanup. Tests append IDs in deletion order
    (children before parents)."""
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
```

## scripts/menu_data_setup.py (Full Skeleton)

```python
"""Menu data setup helpers for E2E tests.

Mapped to .aws/data-knowledge.yaml capability: menu_data_setup.
Used by tests/e2e/test_menu_e2e.py.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_BACKEND_URL = "http://localhost:9999"


def get_backend_base_url() -> str:
    return (
        os.environ.get("BASE_URL")
        or os.environ.get("API_BASE_URL")
        or DEFAULT_BACKEND_URL
    )


def _flatten_tree(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    for node in nodes or []:
        flat.append(node)
        if node.get("children"):
            flat.extend(_flatten_tree(node["children"]))
    return flat


def list_menus_tree(token: str) -> list[dict[str, Any]]:
    base_url = get_backend_base_url()
    resp = httpx.get(
        f"{base_url}/api/v1/menus/list",
        params={"page": 1, "page_size": 1000},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    return body.get("data", []) or []


def find_menu_by_name(name: str, token: str) -> dict[str, Any] | None:
    tree = list_menus_tree(token)
    for node in _flatten_tree(tree):
        if node.get("name") == name:
            return node
    return None


def create_menu_via_api(
    token: str,
    name: str,
    path: str,
    menu_type: str = "catalog",
    parent_id: int = 0,
    component: str = "Layout",
    order: int = 100,
    icon: str = "",
    is_hidden: bool = False,
    keepalive: bool = True,
    redirect: str = "",
) -> int:
    """Create a menu via API and return its DB ID resolved through /menus/list."""
    base_url = get_backend_base_url()
    resp = httpx.post(
        f"{base_url}/api/v1/menus/create",
        json={
            "name": name,
            "path": path,
            "menu_type": menu_type,
            "parent_id": parent_id,
            "component": component,
            "order": order,
            "icon": icon,
            "is_hidden": is_hidden,
            "keepalive": keepalive,
            "redirect": redirect,
        },
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(f"create_menu_via_api failed: {body}")
    found = find_menu_by_name(name, token)
    if not found:
        raise RuntimeError(
            f"create_menu_via_api: created menu {name!r} not found via /menus/list"
        )
    return int(found["id"])


def delete_menu(menu_id: int, token: str) -> None:
    """Idempotent best-effort cleanup. Swallows 404 / network failures and
    non-200 business codes (e.g. 'menu has children')."""
    base_url = get_backend_base_url()
    try:
        resp = httpx.delete(
            f"{base_url}/api/v1/menus/delete",
            params={"id": menu_id},
            headers={"token": token},
            timeout=30,
        )
        if resp.status_code in (200, 404):
            return
    except Exception:
        return
```

## Verification Order (Codegen Phase 7B)

1. Write `tests/e2e/scripts/menu_data_setup.py`
2. Add fixtures to `tests/e2e/conftest.py` (verify imports)
3. Write `tests/e2e/test_menu_e2e.py`
4. Run `python -m pytest tests/e2e/test_menu_e2e.py --collect-only` to confirm collection
5. (Phase 8) Full headed run with `uv run pytest tests/e2e/ -v --headed`

## Known Risks Carried to Codegen

- `delete /api/v1/menus/delete` parameter shape unverified (id vs menu_id) — codegen MUST cross-check with `app/api/v1/menus/menus.py` before pinning. Plan currently uses `params={"id": menu_id}` per backend convention check.
- Tree-row visibility after creation may require explicit expand. Codegen falls back to page reload (deterministic, demonstrated in TC-MENU-E2E-002).

## Out of Scope

- Edit menu via UI (covered indirectly via API tests)
- Delete menu via UI (covered indirectly; backend convention test in API plan)
- Drag-reorder (not implemented in product UI)

## Codegen Readiness

**Status**: not_ready
**Reason**: Phase 6.5 prerequisites pending
**Unblocks at**: Phase 6.5 completion + Phase 5B reviewer pass
