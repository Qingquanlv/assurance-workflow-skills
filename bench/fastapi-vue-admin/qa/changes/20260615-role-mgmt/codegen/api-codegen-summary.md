# API Codegen Summary — `20260615-role-mgmt`

- **Phase**: 7A (api-codegen)
- **Decision**: pass
- **Codegen readiness consumed**: ready_with_warnings (from `review/api-plan-review.json`)
- **Source plan**: `plans/api-codegen-plan.md`

## Files Written

| File | Action | Verified |
|---|---|---|
| `tests/api/test_role_api.py` | CREATE | py_compile ✅, collect-only=11 ✅, lsp clean ✅ |
| `tests/api/helpers/role_api.py` | EXTEND (added 7 helpers; preserved 3 originals) | py_compile ✅, lsp clean ✅ |

## Helpers Added

`update_role`, `delete_role`, `get_role_detail`, `list_roles`, `get_role_authorized`, `update_role_authorized`, `safe_delete_role_by_name` — 7 total, signatures match plan §"Helpers to Add".

## Test Inventory (collected by pytest)

11 tests, one per case ID:

```
test_tc_role_001_list_default_pagination
test_tc_role_002_list_filter_by_name
test_tc_role_003_get_detail_by_id
test_tc_role_004_get_detail_not_found
test_tc_role_005_create_unique_name
test_tc_role_006_create_duplicate_rejected
test_tc_role_007_update_desc_persisted
test_tc_role_008_delete_by_id
test_tc_role_009_get_authorized_returns_bindings
test_tc_role_010_rewrite_menu_ids
test_tc_role_011_rewrite_api_infos
```

## Plan Adherence Notes

- **`seeded_role` fixture**: existing conftest fixture returns `tuple[int, str]`, not `int` as plan template suggested. Adapted call sites with `role_id, role_name = seeded_role` (TC-ROLE-003/007/008/009/010/011). No conftest change required.
- **TC-ROLE-008 double-cleanup**: deletes the seeded role; conftest teardown calls `safe_delete_role` which is idempotent (swallows 404). Safe.
- **Random suffixes**: TC-ROLE-002/005/006 append `secrets.token_hex(3)` to base name to avoid collision across reruns.

## Acceptance Checklist

- [x] `tests/api/test_role_api.py` exists with exactly 11 test functions
- [x] Each docstring begins with `TC-ROLE-XXX:`
- [x] Module marker `pytestmark = pytest.mark.api` present
- [x] No `pytest.mark.skip` / `pytest.mark.xfail`
- [x] 6 new helpers + `safe_delete_role_by_name` appended to `helpers/role_api.py`
- [x] `python -m py_compile tests/api/test_role_api.py tests/api/helpers/role_api.py` exits 0
- [x] `python -m pytest tests/api/test_role_api.py --collect-only -q` → 11 tests
- [x] No imports from `app/` in test file

## Warnings Carried Forward

5 NRs from API plan review (deferred to inspect-time, none blocking):
- NR-API-01: TC-ROLE-006 duplicate-error message string match (`"already exists"`) is implementation-coupled
- NR-API-02: TC-ROLE-004 not-found business code (`code != 200`) is loose; could tighten to `code == 404` post-execution
- NR-API-03..05: see `review/api-plan-review.json`

## Out of Scope (Confirmed)

- E2E (Phase 7B), Fuzz (Phase 7C)
- No `app/` modifications
- No conftest modifications
