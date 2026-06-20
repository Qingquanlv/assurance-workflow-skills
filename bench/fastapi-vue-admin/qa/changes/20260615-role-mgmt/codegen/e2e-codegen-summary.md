# E2E Codegen Summary — `20260615-role-mgmt`

- **Phase**: 7B (e2e-codegen)
- **Decision**: pass
- **Codegen readiness consumed**: ready_with_warnings (from `review/plan-review.json`)
- **Source plan**: `plans/e2e-codegen-plan.md`

## Files Written

| File | Action | Verified |
|---|---|---|
| `tests/e2e/test_role_e2e.py` | CREATE | py_compile ✅, collect-only=3 ✅, lsp clean ✅ |
| `tests/e2e/scripts/role_data_setup.py` | EXTEND (added 3 helpers; preserved `find_role_by_name`) | py_compile ✅, lsp clean ✅ |
| `tests/e2e/conftest.py` | EXTEND (added 3 fixtures + `delete_role` import) | py_compile ✅, lsp clean ✅ |

## Helpers Added (`role_data_setup.py`)

`create_role_via_api(*, token, name, desc="")` → returns `int role_id`
`delete_role(role_id, token)` → idempotent (404 → success)
`get_role_authorized(role_id, token)` → returns `dict[str, Any]`

Plus `from typing import Any` import added per plan.

## Fixtures Added (`conftest.py`)

`unique_role_token`, `cleanup_roles`, `role_management_page` — exact spec match per plan §"Conftest Additions".

## Test Inventory (collected by pytest, parametrized by playwright on chromium)

```
test_role_management_page_loads[chromium]      → @pytest.mark.case_id("TC-ROLE-100")
test_create_role_via_ui[chromium]              → @pytest.mark.case_id("TC-ROLE-101")
test_authorize_role_menu_via_ui[chromium]      → @pytest.mark.case_id("TC-ROLE-102")
```

## Plan Adherence Notes

- **Locator-fallback strategy** (TC-ROLE-101 search button, TC-ROLE-102 save button + menu node) implemented exactly per plan to handle Naive UI variability.
- **TARGET_MENU_ID = 6** (`部门管理`) sourced from plan / fact-baseline.
- Module-level constants `ACTION_TIMEOUT_MS = 10_000`, `NAV_TIMEOUT_MS = 15_000`, `TARGET_MENU_NAME = "部门管理"`, `TARGET_MENU_ID = 6` match plan exactly.

## Acceptance Checklist

- [x] `tests/e2e/test_role_e2e.py` exists with exactly 3 test functions
- [x] Each test marked with `@pytest.mark.case_id("TC-ROLE-XXX")`
- [x] Module marker `pytestmark = pytest.mark.e2e`
- [x] No `pytest.mark.skip` / `pytest.mark.xfail`
- [x] 3 helpers appended to `role_data_setup.py` without altering `find_role_by_name`
- [x] 3 fixtures appended to `conftest.py` (`unique_role_token`, `cleanup_roles`, `role_management_page`)
- [x] `python -m py_compile tests/e2e/test_role_e2e.py tests/e2e/scripts/role_data_setup.py tests/e2e/conftest.py` exits 0
- [x] `python -m pytest tests/e2e/test_role_e2e.py --collect-only -q` lists exactly 3 tests

## Warnings Carried Forward

4 NRs from E2E plan review (deferred to inspect-time, none blocking):
- NR-E2E-01: Naive UI tab/dialog locator fallbacks may need adjustment if Naive UI version drifts
- NR-E2E-02: TC-ROLE-102 best-effort UI re-open verify is supplementary to the API source-of-truth check
- NR-E2E-03..04: see `review/plan-review.json`

## Out of Scope (Confirmed)

- No `app/` modifications
- No `web/` modifications
- API tests (Phase 7A) and Fuzz tests (Phase 7C)
