# Fix Proposal — 20260615-role-mgmt

**Generated**: 2026-06-15T10:30:43Z
**Source**: inspect/failure-analysis.json
**Eligible fixes**: 3  **Not eligible**: 9
**Healing attempt**: 1 of 2

---

## Summary

Phase 8 produced 12 failures across 3 layers (2 API assertion, 3 E2E, 7 Fuzz). All 3 E2E
failures share a single root cause: the generated test code locates the role-name column header
by Chinese label `角色名称`, but the actual UI (web/src/views/system/role/index.vue) renders it
as `角色名`. This causes both `locator_failure` (TC-ROLE-100, TC-ROLE-101) and `wait_strategy_failure`
(TC-ROLE-102) symptoms — the latter being a downstream timeout from the same broken locator.

The 2 API failures and 7 Fuzz failures are flagged not-eligible by the CLI: API assertion mismatches
indicate either real product bugs (HTTP 500 on POST /role/create) or seed-data assumption issues, and
fuzz failures expose either real product 500s or OpenAPI spec gaps — none of which are auto-fixable
test-code issues.

Applying FIX-001 / FIX-002 / FIX-003 should flip all 3 E2E tests to pass on rerun. API/Fuzz hard fails
remain for human investigation.

---

## Eligible Fixes

### FIX-001 — locator_failure (e2e)

**Risk**: low
**Failures addressed**: TC-ROLE-100
**Files to modify**:
- `tests/e2e/test_role_e2e.py`

**Patch plan**:
1. In `test_role_management_page_loads` (TC-ROLE-100), replace `page.get_by_role("columnheader", name="角色名称")` with `page.get_by_role("columnheader", name="角色名")`.
2. Preserve `to_be_visible(timeout=ACTION_TIMEOUT_MS)` and surrounding test logic exactly.

**Constraints**:
- Must not weaken assertion or extend timeout
- Must not delete test
- Must not modify product code

**Verification**: Re-run `aws run --change 20260615-role-mgmt`.

---

### FIX-002 — locator_failure (e2e)

**Risk**: low
**Failures addressed**: TC-ROLE-101
**Files to modify**:
- `tests/e2e/test_role_e2e.py`

**Patch plan**:
1. In `test_create_role_via_ui` (TC-ROLE-101), replace any `columnheader` locator with `name="角色名称"` to `name="角色名"` at every occurrence within this test function only.
2. Preserve all create-flow assertions (form fill, submit, result verification).

**Constraints**:
- Must not weaken create-flow assertions
- Must not delete test
- Must not modify product code

**Verification**: Re-run `aws run --change 20260615-role-mgmt`.

---

### FIX-003 — wait_strategy_failure (e2e)

**Risk**: low
**Failures addressed**: TC-ROLE-102
**Files to modify**:
- `tests/e2e/test_role_e2e.py`

**Patch plan**:
1. In `test_authorize_role_menu_via_ui` (TC-ROLE-102), replace any `columnheader` locator with `name="角色名称"` to `name="角色名"`.
2. Do NOT extend timeout values — original timeout is correct once locator matches.

**Constraints**:
- Must not extend timeouts to mask other issues
- Must not weaken authorize-flow assertions
- Must not delete test
- Must not modify product code

**Verification**: Re-run `aws run --change 20260615-role-mgmt`.

---

## Not Eligible Failures

| Failure ID | Category | Reason | Next Action |
|------------|----------|--------|-------------|
| test_tc_role_001_list_default_pagination | assertion_failure | Expected 'admin' role on page 1 but missing — may reflect data pollution from concurrent test creates or real product behaviour | manual_investigation |
| test_tc_role_002_list_filter_by_name | assertion_failure | POST /role/create returned HTTP 500 on valid input — likely real backend bug | developer_fix_required |
| fuzz[GET /api/v1/role/list] | fuzz_configuration_error | HTTP 500 + undocumented 500 — root cause undetermined per CLI heuristic | manual_investigation |
| fuzz[GET /api/v1/role/get] | fuzz_configuration_error | Undocumented 404 — OpenAPI spec gap | developer_fix_required |
| fuzz[POST /api/v1/role/create] | fuzz_configuration_error | Undocumented 400 — OpenAPI spec gap or product bug | developer_fix_required |
| fuzz[POST /api/v1/role/update] | fuzz_configuration_error | HTTP 500 server error — likely product bug | developer_fix_required |
| fuzz[DELETE /api/v1/role/delete] | fuzz_configuration_error | Undocumented 404 — OpenAPI spec gap | developer_fix_required |
| fuzz[GET /api/v1/role/authorized] | fuzz_configuration_error | Undocumented 404 — OpenAPI spec gap | developer_fix_required |
| fuzz[POST /api/v1/role/authorized] | fuzz_configuration_error | Undocumented 404 — OpenAPI spec gap | developer_fix_required |

---

## Files Allowed to Modify

- `tests/e2e/test_role_e2e.py`

## Files Forbidden to Modify

- `app/**` — product code
- `web/**` — product code
- `src/**` — product code
- `qa/changes/20260615-role-mgmt/cases/**`
- `qa/changes/20260615-role-mgmt/plans/**`
- `tests/api/**` — no API fixes proposed
- `tests/fuzz/**` — no fuzz fixes proposed

---

## Verification Plan

Every applied fix must be verified by re-running:

```bash
aws run --change 20260615-role-mgmt
```

Then re-inspecting:

```bash
aws report inspect --change 20260615-role-mgmt
```

Expected outcome after FIX-001/002/003 applied:
- E2E layer: 0 failures (3/3 pass)
- API layer: 2 failures remain (no auto-fix proposed)
- Fuzz layer: 7 failures remain (no auto-fix proposed)
- Final status: still FAIL (due to API + Fuzz hard fails)
