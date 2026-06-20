# E2E Plan — Role Management (`20260615-role-mgmt`)

## Source

- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (cases TC-ROLE-100, TC-ROLE-101, TC-ROLE-102)
- `qa/changes/20260615-role-mgmt/facts/fact-baseline.json`
- Existing E2E precedent: `tests/e2e/test_menu_e2e.py`, `tests/e2e/test_users_e2e.py`, `tests/e2e/conftest.py`
- Frontend page: `web/src/views/system/role/index.vue`

## Scope

3 E2E cases:

| Case ID | Title | Priority |
|---|---|---|
| TC-ROLE-100 | 角色管理页 - 管理员登录后列表正常加载 | P0 |
| TC-ROLE-101 | 角色管理页 - 新建角色成功并出现在列表 | P0 |
| TC-ROLE-102 | 角色管理页 - 在权限弹窗为角色勾选菜单并保存回显 | P1 |

## Framework

- **`pytest-playwright`** (Python Playwright, NOT TypeScript). Confirmed via existing `tests/e2e/test_menu_e2e.py` + AGENTS.md execution command `uv run pytest tests/e2e/ -v --headed`.
- Test files MUST be named `test_*_e2e.py`.
- Sync API (`playwright.sync_api.Page, expect`).

## Routes

| Page | Route | Source |
|---|---|---|
| Login | `${FRONTEND_BASE_URL}/login` | precedent: `conftest.py:61` |
| Role management | `${FRONTEND_BASE_URL}/system/role` | naming pattern: `/system/{module}` (cf. menu, user) |

`FRONTEND_BASE_URL` defaults to `http://localhost:3100` per `tests/e2e/conftest.py:20`.

## Selectors (UI Locators)

Read from `web/src/views/system/role/index.vue` (lines verified above):

| Element | Locator | Source line |
|---|---|---|
| Search input "角色名" | `page.get_by_placeholder("请输入角色名")` | 265 |
| New role button | `page.get_by_role("button", name="新建角色")` | 249 (text) |
| Form name input | `dialog.get_by_placeholder("请输入角色名称")` | 295 |
| Form desc input | `dialog.get_by_placeholder("请输入角色描述")` | 298 |
| Form submit/save button | `dialog.get_by_role("button", name="保存")` (consistent with menu modal) | precedent |
| Search submit button | text `"查询"` (NaiveUI standard search bar; verify at runtime if not present) | precedent (`web/src/views/system/menu/index.vue` uses identical pattern) |
| Edit row button | `row.get_by_role("button", name="编辑")` | 140 |
| Delete row button | `row.get_by_role("button", name="删除")` | 163 |
| Delete confirm popconfirm | text `"确定删除该角色吗?"` then `"确定"` button | 169 |
| Authorize button (设置权限) | `row.get_by_role("button", name="设置权限")` | 204 |
| Authorize dialog header | text `"设置权限"` | 358 |
| Menu tab | `dialog.get_by_role("tab", name="菜单权限")` | 324 |
| Resource tab | `dialog.get_by_role("tab", name="接口权限")` | 340 |
| Tree node "部门管理" | `dialog.get_by_text("部门管理")` (Naive NTree leaf) | menu_id=6 from fact baseline |
| Authorize dialog save | `dialog.get_by_role("button", name="保存")` (or "确定" — verify at runtime; menu page uses "保存") | precedent |
| Success toast | `page.get_by_text("新增成功")` / `page.get_by_text("保存成功")` | precedent (Naive Message component) |

> **Locator stability note**: NaiveUI sometimes wraps tree checkbox labels in nested DOM. If `get_by_text("部门管理")` proves flaky, fallback to `dialog.locator(".n-tree-node-content__text", has_text="部门管理")`. Codegen MUST include this fallback.

## Data Setup

| Case | Approach |
|---|---|
| TC-ROLE-100 | Read-only against default admin role. No setup beyond login. |
| TC-ROLE-101 | UI creates `e2e-role-new`. Post-test cleanup: delete via API by name lookup. Pre-test cleanup: idempotent delete of any leftover. |
| TC-ROLE-102 | API pre-seeds `e2e-role-auth` with empty bindings. UI checks menu `部门管理` (id=6) and saves. API verifies binding. Post-test cleanup: delete role via API. |

Use deterministic role names suffixed with `secrets.token_hex(4)` to avoid cross-run collision (mirrors `unique_menu_token` fixture, conftest.py:82).

## Auth

Reuse `logged_in_page` fixture from `tests/e2e/conftest.py:58-68`. Admin credentials sourced from `get_admin_credentials()` (env vars `ADMIN_USERNAME`/`ADMIN_PASSWORD` with defaults `admin`/`123456`).

## Asserts (per case)

### TC-ROLE-100
- After navigating to `/system/role`:
  - URL contains `/system/role`
  - "新建角色" button visible
  - Table has at least 1 row
  - Table headers contain "角色名称" and "角色描述" (verify via column text)

### TC-ROLE-101
- "新增成功" toast appears after submit
- Search by `e2e-role-new-{token}` returns exactly 1 row
- Row name cell text equals the new role name
- API readback (cleanup phase): `find_role_by_name` returns non-None

### TC-ROLE-102
- "保存成功" toast appears after save (or "更新成功" — verify at runtime; menu uses "保存成功")
- Reopen authorize dialog → "部门管理" tree node has checked state
- API readback: `GET /api/v1/role/authorized?id={role_id}` → `data.menus` contains `{id: 6}`
- Cleanup: role deleted via API

## Cleanup

| Case | Cleanup Mechanism |
|---|---|
| TC-ROLE-100 | None (read-only) |
| TC-ROLE-101 | `cleanup_roles` fixture (NEW — mirrors `cleanup_users` / `cleanup_menus`) appends role_id; teardown deletes via API |
| TC-ROLE-102 | Same `cleanup_roles` fixture |

## Dependencies on Phase 4A

- The 6 helpers added in API codegen (`update_role`, `get_role_authorized`, etc.) are scoped to `tests/api/helpers/`. E2E tests use `tests/e2e/scripts/role_data_setup.py` instead. **No cross-import.** New E2E helpers below.

## E2E Helpers to Add

Append to `tests/e2e/scripts/role_data_setup.py`:

| Function | Signature | Purpose |
|---|---|---|
| `create_role_via_api` | `(token: str, *, name: str, desc: str = "") -> int` | seed role for TC-ROLE-102; raise `RuntimeError` on non-200 (mirror `create_menu_via_api`) |
| `delete_role` | `(role_id: int, token: str) -> None` | teardown (idempotent — ignore 404) |
| `get_role_authorized` | `(role_id: int, token: str) -> dict[str, Any]` | API readback for TC-ROLE-102 menu binding assertion |

## Conftest Additions

Append to `tests/e2e/conftest.py`:

```python
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


@pytest.fixture
def unique_role_token() -> str:
    return secrets.token_hex(4)
```

Add import: `from tests.e2e.scripts.role_data_setup import delete_role`.

## Output File Layout

| File | Action | Path |
|---|---|---|
| Test module | **CREATE** | `tests/e2e/test_role_e2e.py` |
| Helpers | **EXTEND** | `tests/e2e/scripts/role_data_setup.py` (currently 25 lines, append `create_role_via_api`, `delete_role`, `get_role_authorized`) |
| Conftest | **EXTEND** | `tests/e2e/conftest.py` (3 fixtures + 1 import) |

## Mock Strategy

**None.** E2E runs against the live frontend (`http://localhost:3100`) and live backend (`http://localhost:9999`). All cleanup is real DB writes.

## Needs Review

| ID | Severity | Item |
|---|---|---|
| NR-E2E-01 | medium | Authorize dialog save button text not directly observable from grep — code shows "设置权限" header but save button label needs runtime verification. Plan defaults to "保存" (consistent with menu modal); fallback to "确定" if mismatch detected. |
| NR-E2E-02 | low | NaiveUI tree-node checkbox click target is non-trivial. Codegen MUST use the locator fallback chain documented above. Initial flake risk acknowledged. |
| NR-E2E-03 | low | Search button text — code does not show explicit "查询" button in role page grep (it's a NaiveUI search-bar pattern). If absent, fallback to direct query param URL: navigate to `/system/role?role_name=X`. |
| NR-E2E-04 | low | Success toast wording for the authorize dialog: menu page uses "保存成功"; codegen should accept either "保存成功" or "更新成功" via `or` chain. |

## Blockers

**None.** All 3 E2E cases have concrete UI selectors (or documented fallbacks) and concrete data setup paths.

---

**Plan Readiness preview**: `ready_with_warnings` (4 non-blocking Needs Review).
**Codegen Readiness preview**: `ready_with_warnings`.
