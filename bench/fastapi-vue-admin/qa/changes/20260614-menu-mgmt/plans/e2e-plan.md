# E2E Test Plan - Menu Management

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Framework**: pytest + Python Playwright (sync API)
**Target File**: tests/e2e/test_menu_e2e.py
**Frontend**: http://localhost:3100/system/menu
**Generated**: 2026-06-14

## Scope

2 E2E cases (TC-MENU-E2E-001 create top-level catalog via UI; TC-MENU-E2E-002 add child under existing catalog via UI). Both verify UI-to-API contract end to end and assert backend state via direct API calls (mirrors test_users_e2e.py convention).

## Page Reference (web/src/views/system/menu/index.vue)

### Locators (preferred role/text selectors)

| Element | Locator Strategy | Notes |
|---|---|---|
| Page header | `page.get_by_role("button", name="新建根菜单")` | top-right action button (line 263) |
| Add top-level button | `page.get_by_role("button", name="新建根菜单")` | opens modal with menu_type RadioGroup visible |
| Per-row "子菜单" button | `row.get_by_role("button", name="子菜单")` | only visible when row has children AND menu_type != "menu" (line 158) |
| Per-row "编辑" button | `row.get_by_role("button", name="编辑")` | always visible per row |
| Per-row "删除" button | `row.get_by_role("button", name="删除")` | hidden when row has children (line 203) |
| Delete confirm | `page.get_by_role("button", name="确认")` | NPopconfirm "确定" |
| Modal dialog | `page.get_by_role("dialog")` | CrudModal |
| Modal title (add) | dialog contains "新增菜单" | from useCRUD name="菜单" |
| Modal title (edit) | dialog contains "编辑菜单" | |
| Modal "保存" button | `dialog.get_by_role("button", name="保存")` | |
| menu_type catalog radio | `dialog.get_by_role("radio", name="目录")` | only shown for top-level add (showMenuType=true) |
| menu_type menu radio | `dialog.get_by_role("radio", name="菜单")` | |
| parent_id NTreeSelect | dialog tree-select for parent (key=id, label=name) | "根目录" option = id 0 |
| Name input | `dialog.get_by_placeholder("请输入唯一菜单名称")` | required |
| Path input | `dialog.get_by_placeholder("请输入访问路径")` | required |
| Component input | `dialog.get_by_placeholder("请输入组件路径，例如：/system/user")` | only when menu_type="menu" |
| Redirect input | `dialog.get_by_placeholder("请输入跳转路径")` | only enabled when parent_id == 0 |
| Order input | NInputNumber inside dialog FormItem labeled 显示排序 | min=1 |
| is_hidden switch | NSwitch under FormItem 是否隐藏 | |
| keepalive switch | NSwitch under FormItem KeepAlive | |
| Success toast (create) | `page.get_by_text("新增成功")` | useCRUD message |
| Success toast (edit) | `page.get_by_text("编辑成功")` | |
| Success toast (delete) | `page.get_by_text("删除成功")` | |
| Tree rows | `page.get_by_role("row").filter(has_text=name)` | NaiveUI table renders tree via row indentation |

### Notable UI Constraints (asserted in plan)

- Menu list has NO pagination, NO search box (line 271 `:is-pagination="false"`). Locate rows by text filter, not by search.
- Top-level add only allows `菜单类型` selection on top-level button (showMenuType.value=true). Per-row 子菜单 hides type and forces menu_type="menu" (line 162).
- Components path field only appears when menu_type="menu" (v-if line 330).
- Redirect field disabled when parent_id != 0 (line 339).
- Delete button is HIDDEN when row.children.length > 0 (line 203) — tested in TC-MENU-E2E-002 indirectly via cleanup order.

## Test Cases

### TC-MENU-E2E-001: Create top-level catalog menu via UI

**Precondition**: admin logged in; navigated to /system/menu.

**Steps**:
1. Click "新建根菜单"
2. Modal "新增菜单" appears with menu_type RadioGroup visible
3. Verify "目录" radio is selected by default (initForm.menu_type='catalog' line 242)
4. Fill name = `qa-test-cat-<token_hex(4)>`
5. Fill path = `/qa-test-cat-<same-token>`
6. Leave parent_id default (根目录 = 0)
7. Click "保存"

**Expected (UI)**:
- Toast `新增成功` appears within ACTION_TIMEOUT_MS
- Modal closes
- New row visible in table with the menu name

**Expected (API verification)**:
- GET /api/v1/menus/list with header `token: <admin_token>` returns the new menu
- Returned menu has `parent_id == 0`, `menu_type == "catalog"`, `name` matches

**Cleanup**: cleanup_menus fixture deletes menu by ID via API.

### TC-MENU-E2E-002: Add child menu under existing catalog

**Precondition**:
- admin logged in; on /system/menu
- A test catalog `qa-test-cat-<seed>` was created via API helper (NOT seeded `系统管理`) to keep test isolated

**Steps**:
1. Locate row for `qa-test-cat-<seed>`
2. Click that row's `子菜单` button (visible because catalog has children list rendered)
3. Modal `新增菜单` appears with menu_type RadioGroup HIDDEN (showMenuType=false)
4. Fill name = `qa-test-child-<token_hex(4)>`
5. Fill path = `qa-test-child-<same-token>` (relative path under catalog)
6. Fill component = `/qa-test/child` (required when menu_type=menu)
7. Click "保存"

**Expected (UI)**:
- Toast `新增成功` appears
- Tree refreshes; new child row visible (may need expand action depending on NaiveUI default)

**Expected (API verification)**:
- GET /api/v1/menus/list returns full tree
- Find catalog by seeded name → assert one of its `children` has matching name and `parent_id == catalog.id`

**Cleanup**: cleanup_menus deletes child first then catalog (delete-leaf-first per BL from product behavior: backend may reject deleting catalog with children).

## Data Strategy

- ALL test menus prefixed with `qa-test-` (consistent with API plan).
- Unique suffix via `secrets.token_hex(4)`.
- Backend seed (`系统管理`, `一级菜单` etc. from app/core/init_app.py) MUST NOT be modified.
- TC-MENU-E2E-002 creates its own catalog via API helper to avoid coupling to seeded `系统管理` IDs (which vary by env).

## Fixtures Required (Phase 6.5)

Located in `tests/e2e/conftest.py` (extend existing file):

```python
from tests.e2e.scripts.menu_data_setup import (
    create_menu_via_api,
    delete_menu,
    find_menu_by_name,
)

@pytest.fixture
def cleanup_menus(admin_token: str) -> Generator[list[int], None, None]:
    """Idempotent best-effort cleanup. Tests append menu IDs in deletion order
    (children before parents)."""
    created: list[int] = []
    yield created
    for menu_id in created:
        delete_menu(menu_id, admin_token)


@pytest.fixture
def unique_menu_token() -> str:
    return secrets.token_hex(4)


@pytest.fixture
def menu_management_page(logged_in_page: Page, frontend_base_url: str) -> Page:
    page = logged_in_page
    page.goto(f"{frontend_base_url}/system/menu", wait_until="domcontentloaded")
    expect(page.get_by_role("button", name="新建根菜单")).to_be_visible(timeout=NAV_TIMEOUT_MS)
    return page
```

## Helper Module (Phase 6.5)

`tests/e2e/scripts/menu_data_setup.py` — mirrors user_data_setup.py shape:

- `create_menu_via_api(token, name, path, menu_type="catalog", parent_id=0, component=None, order=100, icon="", is_hidden=False, keepalive=True, redirect="") -> int`
- `delete_menu(menu_id: int, token: str) -> None` (idempotent, swallows 404 + non-200 biz code)
- `find_menu_by_name(name: str, token: str) -> dict | None` (walks /menus/list tree)
- `flatten_menu_tree(tree: list) -> list` (helper)
- Reuses `get_backend_base_url`, `get_admin_token` from user_data_setup (or factor to a shared module — keep duplication for consistency with role_data_setup.py)

## Constants

- `ACTION_TIMEOUT_MS = 10_000` (matches test_users_e2e.py)
- `NAV_TIMEOUT_MS = 15_000` (matches conftest)

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| NaiveUI tree row not visible because parent collapsed | After create, call `getTreeSelect` reload via UI search trigger or rely on auto-expand. Fall back to API verification only. |
| `子菜单` button hidden if catalog has no `children` field set | Plan requires creating catalog FIRST via API so backend returns `children: []`. If button still hidden, fall back to creating child via API and asserting via UI list refresh (B-grade fallback documented in codegen plan). |
| Stale qa-test-* menus from prior failed runs | Document OOB session cleanup (autouse session fixture) — implement in Phase 6.5 |
| Radio group default not "目录" | TC-MENU-E2E-001 step 3 explicitly verifies; otherwise click "目录" radio explicitly |
| Modal title text differs from "新增菜单" | useCRUD uses `name="菜单"` so title is `新增菜单` / `编辑菜单`; verified by reading useCRUD source if needed |

## Out of Scope (E2E)

- Drag-and-drop reorder (UI doesn't expose this; order is via NInputNumber in modal)
- Permission-button hiding (covered by other modules)
- TC-MENU-008 cycle protection (API-only; not safely runnable through UI without risking browser hang)
- Bulk operations (UI doesn't support)

## Codegen Readiness

**Status**: not_ready (blocked on Phase 6.5)
**Blocked artifacts**:
- tests/e2e/scripts/menu_data_setup.py
- cleanup_menus, menu_management_page, unique_menu_token fixtures in tests/e2e/conftest.py

## Next Phase

Phase 5B — aws-e2e-plan-reviewer inline review → review/plan-review.json
