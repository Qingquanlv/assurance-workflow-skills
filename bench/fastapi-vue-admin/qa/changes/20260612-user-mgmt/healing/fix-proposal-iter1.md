# Fix Proposal — 20260612-user-mgmt

**Generated**: 2026-06-13T00:35:00Z
**Source**: inspect/failure-analysis.json
**Eligible fixes**: 4 proposals covering 14 failures
**Not eligible**: 1 failure + 1 classification-drift note

---

## Summary

Of the 15 test failures (9 API + 6 E2E), **14 are auto-fixable** by purely test-side changes:

- **13 failures (API + E2E)** share root cause: email literal `@test.local` is rejected by Pydantic `email-validator` as a reserved TLD (RFC2606), producing HTTP 422 before any business logic runs. Fix: replace `@test.local` → `@example.com` (also reserved but accepted by `email-validator`).
- **6 E2E failures** additionally fail in the login fixture because of an invalid `expect(page).not_to_have_url(lambda)` call. Playwright's `not_to_have_url` does not accept lambdas; the preceding `wait_for_url(lambda)` already enforces the same condition, so the redundant assertion can be removed.
- **1 failure** (`test_list_users_unauthenticated_rejected`) is a genuine product-vs-spec mismatch: SUT returns 422 (missing required Header) instead of 401. This is NOT auto-fixable — would require changing the asserted expected value or updating the SUT.

The aws-inspect classifier mis-categorized 3 failures as `assertion_failure` (because the surface-level traceback contained `assert X == Y`) when log evidence shows they are actually `test_data_failure` (the assertion fired on the 422 status code, not on a product-behavior mismatch). Reclassifying these as eligible.

---

## Eligible Fixes

### FIX-001 — test_data_failure (api)

**Risk**: low
**Failures addressed**: test_list_users_filter_by_username, test_get_user_detail_success, test_create_user_with_role_success, test_create_user_duplicate_email_rejected, test_update_user_rewrites_roles
**Files to modify**:
- `tests/api/test_users_api.py`
- `tests/api/conftest.py`
- `tests/api/helpers/user_api.py`

**Patch plan**:
1. In `tests/api/test_users_api.py`, replace every `@test.local` literal with `@example.com` (preserves username portion).
2. In `tests/api/conftest.py`, update `non_admin_user_factory` default email to `f'{username}@example.com'`.
3. In `tests/api/helpers/user_api.py`, update any hardcoded `@test.local` defaults.

**Verification**: Re-run `aws run --change 20260612-user-mgmt`.

---

### FIX-002 — wait_strategy_failure (e2e)

**Risk**: low
**Failures addressed**: All 6 E2E tests (setup error in `logged_in_page` fixture)
**Files to modify**:
- `tests/e2e/conftest.py`

**Patch plan**:
1. Remove the line `expect(page).not_to_have_url(lambda url: '/login' in url)` in the `logged_in_page` fixture. The preceding `page.wait_for_url(lambda url: '/login' not in url, timeout=ADMIN_LOGIN_TIMEOUT_MS)` already provides identical guarantees and supports lambdas (which `expect.not_to_have_url` does NOT).

**Verification**: Re-run `aws run --change 20260612-user-mgmt`.

---

### FIX-003 — test_data_failure (api, reclassified from assertion_failure)

**Risk**: low
**Failures addressed**: test_update_user_not_found
**Files to modify**:
- `tests/api/test_users_api.py`

**Patch plan**:
1. In `test_update_user_not_found`, change `"ghost@test.local"` → `"ghost@example.com"` inside the POST body.

**Verification**: Re-run `aws run --change 20260612-user-mgmt`. Test should now reach the controller's 404 path.

---

### FIX-004 — test_data_failure (api, reclassified from assertion_failure)

**Risk**: low
**Failures addressed**: test_delete_user_success, test_reset_password_normal_user_success
**Files to modify**:
- `tests/api/test_users_api.py`

**Patch plan**:
1. In `test_delete_user_success`: change `qa_delete_user@test.local` → `qa_delete_user@example.com`.
2. In `test_reset_password_normal_user_success`: change `qa_reset_user@test.local` → `qa_reset_user@example.com`.

**Verification**: Re-run `aws run --change 20260612-user-mgmt`.

---

## Not Eligible Failures

| Failure ID | Category | Reason | Next Action |
|------------|----------|--------|-------------|
| test_list_users_unauthenticated_rejected | assertion_failure | Genuine product-vs-spec mismatch. SUT uses `Header(...)` (required), so missing token → 422 not 401. Test asserts 401 per case TC-USER-003. Cannot auto-fix without (a) changing test expected value, or (b) modifying product code. | manual_investigation |
| FAIL-INSPECT-CLASSIFICATION-001 | inspect_classification_drift | aws-inspect mis-classified 3 failures (test_update_user_not_found, test_delete_user_success, test_reset_password_normal_user_success) as assertion_failure based on `assert X == Y` pattern. Manual log review shows root cause is `@test.local` validation error. Reclassified in FIX-003 and FIX-004 based on log evidence. Documenting drift for classifier improvement. | separate_change_required |

---

## Files Allowed to Modify

- `tests/api/test_users_api.py`
- `tests/api/conftest.py`
- `tests/api/helpers/user_api.py`
- `tests/e2e/conftest.py`

## Files Forbidden to Modify

- `app/**` — product code (FastAPI backend)
- `web/**` — product code (Vue frontend)
- `src/**` — product code (alt name)
- `qa/changes/20260612-user-mgmt/cases/**` — case spec
- `qa/changes/20260612-user-mgmt/plans/**` — plan files

---

## Verification Plan

Every applied fix must be verified by re-running:

```bash
aws run --change 20260612-user-mgmt
```

Then re-inspecting:

```bash
aws report inspect --change 20260612-user-mgmt
```

Expected outcome after applying all 4 proposals: 14/15 tests pass; only `test_list_users_unauthenticated_rejected` remains failing (manual decision required: amend case spec to expect 422, OR file SUT bug).
