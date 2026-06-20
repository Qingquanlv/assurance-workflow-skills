# E2E Codegen Fix Apply Summary

**Change**: `20260615-role-mgmt`
**Module**: `roles`
**Healing Attempt**: 1 of 2
**Apply Timestamp**: 2026-06-15T18:55:00+08:00
**Source Proposal**: [`healing/fix-proposal.json`](./fix-proposal.json)
**Source Run Batch**: `20260615-182414`

---

## Summary

| Fix ID  | Case        | Status         | Outcome                                                                 |
|---------|-------------|----------------|-------------------------------------------------------------------------|
| FIX-001 | TC-ROLE-100 | applied        | line 30 columnheader `角色名称` → `角色名` (matches UI)                    |
| FIX-002 | TC-ROLE-101 | not_applicable | proposed pattern absent; real cause = backend HTTP 500 on /role/create |
| FIX-003 | TC-ROLE-102 | not_applicable | real cause = `httpx.HTTPStatusError 500` in fixture `create_role_via_api` |

**Net result**: 1 applied, 2 not_applicable (skipped with evidence). Single low-risk locator change. No product code touched. No timeouts extended.

---

## Applied Fix Detail

### FIX-001 — TC-ROLE-100 (locator_failure, applied)

**File**: `tests/e2e/test_role_e2e.py`
**Line**: 30
**Operation**: `replace_locator`

```diff
- expect(page.get_by_role("columnheader", name="角色名称")).to_be_visible(
+ expect(page.get_by_role("columnheader", name="角色名")).to_be_visible(
```

**Reasoning**: Codegen used spec'd label `角色名称` (4 chars) but UI renders `角色名` (3 chars).
**UI Evidence**: `web/src/views/system/role/index.vue:96` → `title: '角色名'`
**Verification**:
- `python -m py_compile tests/e2e/test_role_e2e.py` → exit 0
- `pytest tests/e2e/test_role_e2e.py --collect-only -q` → 3 tests collected (unchanged)
- File untracked in git (new from codegen); single-line change verified by `grep`

**Risk**: low — single AST-level locator change, deterministic UI source-of-truth.

---

## Skipped Fixes (Documented)

### FIX-002 — TC-ROLE-101 (CLI: locator_failure → actual: backend HTTP 500)

**Status**: `not_applicable`

**Why CLI was wrong**:
- CLI classified TC-ROLE-101 as `locator_failure` with `fix_proposal_eligible=true`
- Raw `e2e.log:299–300, 553` shows actual failure: `expect(page.get_by_text("新增成功")).to_be_visible` AssertionError at `tests/e2e/test_role_e2e.py:61`
- The success toast `新增成功` never appears because the `保存` click → `POST /role/create` → backend returns HTTP 500 → no success notification
- Function body of `test_create_role_via_ui` (lines 40–79) contains NO `角色名称` columnheader locator. The proposed `replace_locator` pattern simply does not exist in this test.

**Audit of all `角色名称` references in test file**:
- Line 30: columnheader in TC-ROLE-100 (patched by FIX-001)
- Line 56: `dialog.get_by_placeholder("请输入角色名称")` — IS correct (matches UI modal at `index.vue:295`)
- No other occurrences

**Real root cause**: same backend bug as Phase 9 API findings (TC-ROLE-001, TC-ROLE-002).

**Recommended action**: `developer_fix_required` — investigate `POST /role/create` HTTP 500 in `app/api/v1/role.py` and `app/controllers/role.py`.

---

### FIX-003 — TC-ROLE-102 (CLI: wait_strategy_failure → actual: backend HTTP 500)

**Status**: `not_applicable`

**Why CLI was wrong**:
- CLI classified TC-ROLE-102 as `wait_strategy_failure` with `fix_proposal_eligible=true`
- Raw `e2e.log:618` shows actual failure: `httpx.HTTPStatusError: Server error '500 Internal Server Error' for url 'http://localhost:9999/api/v1/role/create'`
- This error is raised inside the **fixture call chain**, not during UI interaction:
  ```
  test_authorize_role_menu_via_ui (line 93)
    └─ create_role_via_api(token=admin_token, name=role_name, desc="e2e auth test")
        └─ POST /api/v1/role/create  →  HTTP 500
  ```
- A wait_strategy change cannot fix a backend HTTP 500. The test never reaches a UI element to wait on.

**Real root cause**: same as FIX-002 — backend bug on `POST /role/create`.

**Recommended action**: `developer_fix_required` — resolution of the backend 500 unblocks both TC-ROLE-101 and TC-ROLE-102 simultaneously.

---

## Safety Gate

| Check                              | Verdict   |
|------------------------------------|-----------|
| Only allowed files modified        | ✅ pass    |
| No product code touched            | ✅ pass    |
| No timeout extensions              | ✅ pass    |
| No test disabling/skipping         | ✅ pass    |
| Single root cause per applied fix  | ✅ pass    |
| **Overall**                        | **passed** |

**Files modified**: `tests/e2e/test_role_e2e.py` (1 line)
**Files excluded**: `app/**`, `web/**`, `tests/api/**`, `tests/fuzz/**`, `tests/e2e/conftest.py`, `tests/e2e/scripts/role_data_setup.py`

---

## Agent Warning

### AGENT-WARN-HEAL-01 (high severity)

**Summary**: CLI failure-analysis.json over-classified 2 of 3 E2E failures as test-code defects when raw log evidence proves they are caused by the same backend HTTP 500 on `POST /role/create` already documented in Phase 9 API findings.

**Skill compliance**: The agent did NOT override CLI's `fix_proposal_eligible` classification. No edits were made to `failure-analysis.json` or `fix-proposal.json`. Instead, the agent declined to apply two of the three proposals and documented the evidence here. User confirmed this approach (option: "Apply FIX-001 only, mark FIX-002/003 not_applicable").

**Recommended downstream action**:
- Phase 10 quality report should reflect that TC-ROLE-100 is healable but TC-ROLE-101/102 require backend fix
- Surface this warning in `executive-summary.md` as an integrity note
- Consider filing a CLI improvement ticket: classifier should detect `httpx.HTTPStatusError` in fixture stack-frames and route to `environment_failure` or `product_bug` instead of `wait_strategy_failure`

---

## Expected Re-Run Outcomes (Healing Attempt 1)

| Layer              | Before               | Expected After       |
|--------------------|----------------------|----------------------|
| TC-ROLE-100 (E2E)  | FAIL (locator)       | **PASS**             |
| TC-ROLE-101 (E2E)  | FAIL (backend 500)   | FAIL (unchanged)     |
| TC-ROLE-102 (E2E)  | FAIL (backend 500)   | FAIL (unchanged)     |
| API (24/26 fail)   | FAIL                 | FAIL (no API fixes)  |
| Fuzz (7/7 fail)    | FAIL (config error)  | FAIL (not eligible)  |
| Coverage           | SKIPPED              | SKIPPED              |

**Final status after re-run**: still `FAIL` (product bugs remain). Phase 10 will produce the final quality report.
