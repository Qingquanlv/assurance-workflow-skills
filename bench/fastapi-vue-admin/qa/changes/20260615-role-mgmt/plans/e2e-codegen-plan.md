# E2E Codegen Plan — Role Management (`20260615-role-mgmt`)

> **Codegen contract.** This file fully specifies what `aws-e2e-codegen` will write.

## Source

- `qa/changes/20260615-role-mgmt/plans/e2e-plan.md`
- `qa/changes/20260615-role-mgmt/plans/e2e-test-data-plan.md`
- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (TC-ROLE-100/101/102)

## Scope

3 E2E cases. One pytest module: `tests/e2e/test_role_e2e.py`.

## File Layout

| File | Action | Path |
|---|---|---|
| Test module | **CREATE** | `tests/e2e/test_role_e2e.py` |
| Setup helpers | **EXTEND** | `tests/e2e/scripts/role_data_setup.py` |
| Conftest | **EXTEND** | `tests/e2e/conftest.py` |

## Helpers to Add

Append to `tests/e2e/scripts/role_data_setup.py`:

```python
def create_role_via_api(*, token: str, name: str, desc: str = "") -> int:
    """Create role via API, return new role_id. Raise RuntimeError on non-200."""
    base_url = get_backend_base_url()
    resp = httpx.post(
        f"{base_url}/api/v1/role/create",
        json={"name": name, "desc": desc},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(
            f"create_role_via_api: code={body.get('code')} msg={body.get('msg')!r}"
        )
    role_id = find_role_by_name(name, token)
    if role_id is None:
        raise RuntimeError(
            f"create_role_via_api: row not visible after create for name={name!r}"
        )
    return role_id


def delete_role(role_id: int, token: str) -> None:
    """Delete role by id. Idempotent: 404 is treated as success."""
    base_url = get_backend_base_url()
    resp = httpx.delete(
        f"{base_url}/api/v1/role/delete",
        params={"role_id": role_id},
        headers={"token": token},
        timeout=30,
    )
    if resp.status_code == 404:
        return
    resp.raise_for_status()


def get_role_authorized(role_id: int, token: str) -> dict[str, Any]:
    """Fetch role's authorized menus + apis via API."""
    base_url = get_backend_base_url()
    resp = httpx.get(
        f"{base_url}/api/v1/role/authorized",
        params={"id": role_id},
        headers={"token": token},
        timeout=30,
    )
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 200:
        raise RuntimeError(
            f"get_role_authorized: code={body.get('code')} msg={body.get('msg')!r}"
        )
    return body["data"]
```

Add `from typing import Any` to imports.

## Conftest Additions

Append to `tests/e2e/conftest.py`:

```python
# (add to existing imports)
from tests.e2e.scripts.role_data_setup import delete_role


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
```

## Test Module Structure

```python
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
TARGET_MENU_ID = 6  # deterministic per init_app (fact baseline)
```

## Test Functions

### TC-ROLE-100 — page load + table visible

```python
@pytest.mark.case_id("TC-ROLE-100")
def test_role_management_page_loads(role_management_page: Page) -> None:
    """TC-ROLE-100: 角色管理页 - 管理员登录后列表正常加载."""
    page = role_management_page
    # URL check
    assert "/system/role" in page.url
    # Header column check (角色名称 column header)
    expect(page.get_by_role("columnheader", name="角色名称")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )
    expect(page.get_by_role("columnheader", name="角色描述")).to_be_visible(
        timeout=ACTION_TIMEOUT_MS
    )
    # Table has at least one row (admin role)
    rows = page.get_by_role("row")
    # rows includes header row; data rows count ≥ 1 → total rows ≥ 2
    assert rows.count() >= 2, "Expected at least one data row in role table"
```

### TC-ROLE-101 — create role via UI

```python
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

    # Open modal
    page.get_by_role("button", name="新建角色").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # Fill form
    dialog.get_by_placeholder("请输入角色名称").fill(role_name)
    dialog.get_by_placeholder("请输入角色描述").fill(role_desc)

    # Submit
    dialog.get_by_role("button", name="保存").click()

    # Success toast
    expect(page.get_by_text("新增成功")).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(dialog).not_to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # API verify (also captures role_id for cleanup)
    role_id = find_role_by_name(role_name, admin_token)
    assert role_id is not None, (
        f"Role {role_name!r} not found via API after UI create"
    )
    cleanup_roles.append(role_id)

    # UI verify: search and confirm row presence
    search_input = page.get_by_placeholder("请输入角色名")
    search_input.fill(role_name)
    # NaiveUI search bars commonly auto-trigger on enter or button click;
    # try button first, fallback to keyboard Enter
    search_button = page.get_by_role("button", name="查询")
    if search_button.count() > 0:
        search_button.first.click()
    else:
        search_input.press("Enter")

    matching_row = page.get_by_role("row").filter(has_text=role_name).first
    expect(matching_row).to_be_visible(timeout=ACTION_TIMEOUT_MS)
```

### TC-ROLE-102 — authorize via UI

```python
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

    # API pre-seed
    role_id = create_role_via_api(token=admin_token, name=role_name, desc="e2e auth test")
    cleanup_roles.append(role_id)

    # Reload table so seeded role is visible
    page.reload(wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建角色")).to_be_visible(
        timeout=NAV_TIMEOUT_MS
    )

    # Search role
    search_input = page.get_by_placeholder("请输入角色名")
    search_input.fill(role_name)
    search_button = page.get_by_role("button", name="查询")
    if search_button.count() > 0:
        search_button.first.click()
    else:
        search_input.press("Enter")

    target_row = page.get_by_role("row").filter(has_text=role_name).first
    expect(target_row).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # Open authorize dialog
    target_row.get_by_role("button", name="设置权限").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    expect(dialog.get_by_text("设置权限")).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # Click menu tab (default but explicit for safety)
    dialog.get_by_role("tab", name="菜单权限").click()

    # Check the target menu node — primary then fallback locator
    target_node = dialog.get_by_text(TARGET_MENU_NAME, exact=True).first
    if target_node.count() == 0:
        target_node = dialog.locator(
            ".n-tree-node-content__text", has_text=TARGET_MENU_NAME
        ).first
    expect(target_node).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    target_node.click()

    # Save — try "保存" then fallback "确定"
    save_button = dialog.get_by_role("button", name="保存")
    if save_button.count() == 0:
        save_button = dialog.get_by_role("button", name="确定")
    save_button.first.click()

    # Success toast (accept either wording)
    success_locator = page.locator(
        "text=/保存成功|更新成功|设置成功/"
    ).first
    expect(success_locator).to_be_visible(timeout=ACTION_TIMEOUT_MS)

    # API verify: menu binding persisted
    data = get_role_authorized(role_id, admin_token)
    menu_ids = {m["id"] for m in data.get("menus", [])}
    assert TARGET_MENU_ID in menu_ids, (
        f"Expected menu_id={TARGET_MENU_ID} in role bindings, got {menu_ids}"
    )

    # UI re-open verify (best-effort; API verify above is the source of truth)
    page.keyboard.press("Escape")  # close dialog
    target_row = page.get_by_role("row").filter(has_text=role_name).first
    target_row.get_by_role("button", name="设置权限").click()
    dialog = page.get_by_role("dialog")
    expect(dialog).to_be_visible(timeout=ACTION_TIMEOUT_MS)
    dialog.get_by_role("tab", name="菜单权限").click()
    # The reopened tree should show the previously-checked node still checked.
    # NaiveUI marks checked tree nodes via .n-tree-node-checkbox--checked class.
    checked_target = dialog.locator(
        ".n-tree-node:has-text('部门管理') .n-tree-node-checkbox--checked"
    ).first
    expect(checked_target).to_be_visible(timeout=ACTION_TIMEOUT_MS)
```

## Imports (full list)

```python
from __future__ import annotations

import pytest
from playwright.sync_api import Page, expect

from tests.e2e.scripts.role_data_setup import (
    create_role_via_api,
    find_role_by_name,
    get_role_authorized,
)
```

## Markers

- Module-level: `pytestmark = pytest.mark.e2e`
- Per-test: `@pytest.mark.case_id("TC-ROLE-XXX")` (consumed by `_record_case_id` autouse fixture)

## Acceptance Checklist

- [ ] `tests/e2e/test_role_e2e.py` exists with exactly 3 test functions.
- [ ] Each test marked with `@pytest.mark.case_id("TC-ROLE-XXX")`.
- [ ] Module marker `pytestmark = pytest.mark.e2e`.
- [ ] No `pytest.mark.skip` / `pytest.mark.xfail`.
- [ ] 3 helpers appended to `tests/e2e/scripts/role_data_setup.py` without altering `find_role_by_name`.
- [ ] 3 fixtures appended to `tests/e2e/conftest.py` (`unique_role_token`, `cleanup_roles`, `role_management_page`).
- [ ] `python -m py_compile tests/e2e/test_role_e2e.py tests/e2e/scripts/role_data_setup.py tests/e2e/conftest.py` exits 0.
- [ ] `python -m pytest tests/e2e/test_role_e2e.py --collect-only -q` lists exactly 3 tests.

## Codegen Hard Gates (must all be true at start of Phase 7B)

- `phases.e2e_plan_review.decision == pass`
- `phases.e2e_plan_review.codegen_readiness in [ready, ready_with_warnings]`
- `blockers == []`
- `.aws/data-knowledge.yaml` exists ✅

## Out of Scope

- Backend modifications (`app/`) — forbidden.
- Frontend modifications (`web/`) — forbidden.
- API tests (handled by Phase 7A).
- Fuzz tests (handled by Phase 7C).
