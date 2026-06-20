# E2E Test Data Plan - Menu Management

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Generated**: 2026-06-14
**Note**: This file consolidates the E2E test-data sections that were originally inlined in `e2e-plan.md` and `e2e-codegen-plan.md`. It exists to satisfy the aws-e2e-plan-reviewer Context Contract, which expects a dedicated `e2e-test-data-plan.md` artifact. No new factual content is introduced here — this is a structural pointer/extract.

## 1. Data Strategy

- All E2E test menus prefixed with `qa-test-` (consistent with API plan).
- Unique suffix via `secrets.token_hex(4)` (consistent with `unique_username` fixture pattern in test_users_e2e.py).
- Backend seed (`系统管理`, `一级菜单`, etc., from `app/core/init_app.py:81-176`) MUST NOT be modified, renamed, or deleted.
- TC-MENU-E2E-002 creates its own catalog via API helper to avoid coupling to seeded `系统管理` IDs (which vary by env).
- Cleanup ordering: children before parents (backend rejects deleting catalog with children at `app/api/v1/menus/menus.py:61`).
- Stale `qa-test-*` menus from prior failed runs are removed by an autouse session-scope cleanup hook (already shipped in Phase 6.5: `_qa_test_menu_oob_cleanup` in `tests/api/conftest.py`; E2E runs share the same backend so this also benefits E2E).

## 2. Data Sources

| Source | Role | Notes |
|---|---|---|
| `tests/e2e/scripts/menu_data_setup.py` | Authoritative API helper for E2E setup/teardown | Phase 6.5 — shipped |
| `tests/e2e/conftest.py` fixtures | `cleanup_menus`, `unique_menu_token`, `menu_management_page` | Phase 6.5 — shipped |
| `admin_token` fixture | Reused from existing E2E conftest | Auth header literal `token: <jwt>` |
| `logged_in_page` fixture | Reused from existing E2E conftest | Login flow proven by `test_users_e2e.py` |
| Backend `/api/v1/menus/{create,delete,list}` | Used directly for seeding & verification | Auth header `token: <jwt>` (NOT Bearer) |

## 3. Per-Test Data Requirements

### TC-MENU-E2E-001 (Create top-level catalog via UI)

- Inputs:
  - `name = f"qa-test-cat-{unique_menu_token}"`
  - `path = f"/qa-test-cat-{unique_menu_token}"`
  - parent_id default (`根目录` = 0)
  - menu_type default (`目录` / `catalog`)
- Setup: none beyond admin login (handled by `menu_management_page` fixture).
- Cleanup: `cleanup_menus.append(menu_id)` after API verification.

### TC-MENU-E2E-002 (Add child menu under existing catalog via UI)

- Pre-seeded data (created via API helper for isolation):
  - Catalog: `name = f"qa-test-cat-{unique_menu_token}"`, `path = f"/qa-test-cat-{unique_menu_token}"`, `menu_type="catalog"`, `parent_id=0`
- UI inputs (entered via modal):
  - `name = f"qa-test-child-{unique_menu_token}"`
  - `path = f"qa-test-child-{unique_menu_token}"` (relative path under catalog)
  - `component = "/qa-test/child"` (required when menu_type=menu)
- Setup ordering:
  1. API: create catalog
  2. UI: `page.reload(...)` to refresh tree state
  3. UI: click 子菜单 button on catalog row
  4. UI: fill child fields, save
- Cleanup ordering: child first (`cleanup_menus.append(child_id)`), then catalog (`cleanup_menus.append(catalog_id)`). Backend rejects deleting catalog while it has children.

## 4. Helper API Surface (already shipped in Phase 6.5)

From `tests/e2e/scripts/menu_data_setup.py`:

- `get_backend_base_url() -> str` — resolves BASE_URL / API_BASE_URL / default `http://localhost:9999`.
- `list_menus_tree(token: str) -> list[dict]` — GET `/api/v1/menus/list?page=1&page_size=1000`, header `token: <jwt>`.
- `_flatten_tree(nodes) -> list[dict]` — internal recursive flattener.
- `find_menu_by_name(name, token) -> dict | None` — searches flattened tree.
- `create_menu_via_api(token, name, path, menu_type="catalog", parent_id=0, component="Layout", order=100, icon="", is_hidden=False, keepalive=True, redirect="") -> int` — returns DB id resolved through `/menus/list`.
- `delete_menu(menu_id: int, token: str) -> None` — idempotent; swallows 404 / non-200 biz code (e.g. "menu has children").

All helpers send `headers={"token": token}` and use `httpx` synchronously (consistent with `user_data_setup.py`, `role_data_setup.py`).

## 5. Fixtures (already shipped in Phase 6.5)

In `tests/e2e/conftest.py`:

- `unique_menu_token` — `secrets.token_hex(4)`.
- `cleanup_menus` — generator fixture returning `list[int]`; iterates IDs in append order on teardown (children first, parents last).
- `menu_management_page` — navigates `logged_in_page` to `/system/menu`, asserts `新建根菜单` visible within `NAV_TIMEOUT_MS`.

## 6. Constants

- `ACTION_TIMEOUT_MS = 10_000` (matches `test_users_e2e.py`).
- `NAV_TIMEOUT_MS = 15_000` (matches existing E2E conftest).

## 7. Out of Scope

- Drag-and-drop reorder (UI doesn't support).
- Permission-button hiding (covered by other modules).
- TC-MENU-008 cycle protection (API-only; not safely runnable through UI without risking browser hang).
- Bulk operations (UI doesn't support).

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| NaiveUI tree row not visible because parent collapsed | `page.reload(wait_until="domcontentloaded")` after API seeding (deterministic). |
| `子菜单` button hidden if catalog has no `children` field | Catalog created via API first; backend returns `children: []`. Index.vue:158 confirms button visibility check. |
| Stale `qa-test-*` menus from prior failed runs | Phase 6.5 shipped session-autouse cleanup `_qa_test_menu_oob_cleanup` covering this prefix. |
| Modal title text differs from expectation | useCRUD `name="菜单"` produces `新增菜单` / `编辑菜单`; verified against `web/src/views/system/menu/index.vue`. |

## 9. Cross-Reference

- API counterpart: `qa/changes/20260614-menu-mgmt/plans/api-test-data-plan.md`.
- Source plan: `qa/changes/20260614-menu-mgmt/plans/e2e-plan.md` (sections "Data Strategy", "Fixtures Required", "Helper Module", "Constants", "Risks & Mitigations").
- Codegen plan: `qa/changes/20260614-menu-mgmt/plans/e2e-codegen-plan.md` (sections "scripts/menu_data_setup.py", "conftest.py Additions").
- Data knowledge: `.aws/data-knowledge.yaml` — `menu_data_setup` capability (refreshed Phase 6.5).
