# Fix Proposal — 20260612-user-mgmt (Iteration 2)

**Generated**: 2026-06-13T01:05:00Z
**Source**: inspect/failure-analysis.json (batch 20260613-002644)
**Eligible fixes**: 3  **Not eligible**: 1  **Known product issues**: 1

---

## Summary

After healing iteration 1 reduced failures from 21 to 4 (API 14/15, E2E 3/6), root-cause analysis of remaining failures via backend log + Naive UI locale source identified two distinct test-code issues plus one persistent product-spec mismatch:

1. **FIX-005** (test_data_failure): seed username `qa_e2e_user_<8hex>_seed` is 25 chars but `User.username` field has `max_length=20`. Backend returns **500 Internal Server Error** from a tortoise `ValidationError` (uncaught) → test fails on `raise_for_status()`.
2. **FIX-006** (locator_failure): Two tests click Popconfirm buttons via `name="确定"`. Naive UI zhCN locale defaults `Popconfirm.positiveText='确认'` (verified in `web/node_modules/naive-ui/es/locales/common/zhCN.mjs`). The inline `<NPopconfirm>` in `web/src/views/system/user/index.vue` (lines 182, 208) does not override this, so the actual button text is `确认`.
3. **NOT ELIGIBLE** — `test_list_users_unauthenticated_rejected`: persistent assertion mismatch (test expects 401, FastAPI Header(...) yields 422). Needs a developer decision on auth-spec alignment.
4. **KPI-001** (known product issue): Tortoise `ValidationError` is not caught by FastAPI exception handler; surfaces as 500 instead of 422. Documented but out of scope (test code is being adjusted instead).

---

## Eligible Fixes

### FIX-005 — test_data_failure (e2e)

**Risk**: low
**Failures addressed**: `test_create_user_duplicate_email_shows_error[chromium]`
**Files to modify**:
- `tests/e2e/test_users_e2e.py`

**Patch plan**:
1. Replace `seed_username = f"{unique_username}_seed"` (line ~91) with:
   ```python
   seed_username = f"s_{unique_username[2:]}"[:20]
   ```
   This keeps the unique 8-hex suffix, drops the redundant `qa_` prefix to make room, and clamps to ≤ 20 chars to satisfy `User.username` max_length.

**Constraints**:
- Email stays `f"{unique_username}@example.com"` (this is what triggers the duplicate-email assertion).
- seed_username remains distinct from unique_username (different prefix).

**Verification**: Re-run `aws run --change 20260612-user-mgmt`. Expected: seed creation returns 200, modal "新增" submit returns 400, dialog stays visible, assertion passes.

---

### FIX-006 — locator_failure (e2e)

**Risk**: low
**Failures addressed**:
- `test_delete_user_removes_row[chromium]`
- `test_reset_password_normal_user[chromium]`

**Files to modify**:
- `tests/e2e/test_users_e2e.py`

**Patch plan**:
1. Replace `page.get_by_role("button", name="确定")` with `page.get_by_role("button", name="确认")` in:
   - `test_delete_user_removes_row` (line ~179, after click on row 删除 button)
   - `test_reset_password_normal_user` (line ~224, after click on row 重置密码 button)

**Constraints**:
- Scope is strictly the Popconfirm confirmation button. Modal save button uses `保存` (per `selector_overrides_applied.G1`); no other `确定` exists.
- Do not modify product code (`web/src/views/system/user/index.vue`).

**Verification**: Re-run `aws run --change 20260612-user-mgmt`. Expected: Popconfirm `确认` button found instantly; delete shows `删除成功` toast and removes row; reset_password shows `密码已成功重置为123456`.

---

## Not Eligible Failures

| Failure ID | Category | Reason | Next Action |
|---|---|---|---|
| `test_list_users_unauthenticated_rejected` | assertion_failure | Test expects 401, FastAPI `Header(...)` returns 422 on missing token. Persisted across iterations 1 + 2. Fixing requires either weakening the test assertion to 422 or modifying `AuthControl.is_authed` (product code). | developer_fix_required |

---

## Known Product Issues

### KPI-001 — Tortoise ValidationError surfaces as HTTP 500

**Evidence**: Backend log line `2026-06-13 00:26:51 - 127.0.0.1:64943 - POST /api/v1/user/create HTTP/1.1 500 Internal Server Error`, with traceback ending in `tortoise.exceptions.ValidationError: username: Length of 'qa_e2e_user_dbcf62e6_seed' 25 > 20`.

**Expected**: 422 with `{"detail": [{"loc": ["body", "username"], "msg": "..."}]}`.

**Actual**: 500 with raw stack trace.

**Scope**: Any create/update endpoint where Pydantic schema accepts a string but the underlying tortoise CharField has a tighter `max_length`. Currently `app/schemas/users.py UserCreate.username` is a bare `str` while `app.models.admin.User.username` declares `max_length=20`.

**Recommended next action**: Out of scope for this change. File a follow-up to either:
- Add a global `tortoise.exceptions.ValidationError` handler in `app/core/exceptions.py` returning 422, OR
- Mirror DB constraints in Pydantic schemas (`Field(..., max_length=20)`).

For this iteration we work around it in the test code.

---

## Files Allowed to Modify

- `tests/e2e/test_users_e2e.py`

## Files Forbidden to Modify

- `app/**` — product code
- `web/**` — product code
- `src/**` — product code
- `qa/changes/20260612-user-mgmt/cases/**`
- `qa/changes/20260612-user-mgmt/plans/**`

---

## Verification Plan

After applying both fixes:

```bash
aws run --change 20260612-user-mgmt
aws report inspect --change 20260612-user-mgmt
```

Expected post-fix state:
- API: 14/15 (unchanged; the 1 remaining is `test_list_users_unauthenticated_rejected`, not eligible).
- E2E: 6/6 (all three remaining fixed).
- Final status: PASS_WITH_WARNINGS (one developer-review failure carried forward).
