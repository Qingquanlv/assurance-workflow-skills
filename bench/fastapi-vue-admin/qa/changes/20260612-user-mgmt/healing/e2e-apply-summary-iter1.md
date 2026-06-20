# E2E Codegen Fixer — Apply Summary

**Change**: 20260612-user-mgmt
**Applied at**: 2026-06-13T00:42:30Z
**Proposals applied**: 1 (FIX-002)
**Files modified**: 2 (tests/e2e/conftest.py, tests/e2e/test_users_e2e.py)

## Applied Fixes

### FIX-002 — wait_strategy_failure + test_data_failure (e2e)

**Operation 1 — remove_invalid_assertion**
- **File**: `tests/e2e/conftest.py:65`
- **Change**: Removed `expect(page).not_to_have_url(lambda url: "/login" in url)`.
- **Justification**: Playwright Python sync API's `expect(page).not_to_have_url()` does NOT accept lambdas (only str/regex). The preceding `page.wait_for_url(lambda url: "/login" not in url, timeout=ADMIN_LOGIN_TIMEOUT_MS)` already enforces identical guarantees and supports lambdas. Removal restores fixture functionality without weakening any assertion.

**Operation 2 — fix_test_data**
- **File**: `tests/e2e/test_users_e2e.py` (7 occurrences across lines 47, 89, 114, 115, 164, 207, 252)
- **Change**: `@test.local` → `@example.com` globally.
- **Justification**: When E2E tests submit the user-create form with `@test.local`, the backend Pydantic schema rejects the email as RFC2606-reserved, surfacing an error toast and breaking the test path. `example.com` is also reserved but accepted by `email-validator`.

## Skipped Proposals

| Proposal | Reason |
|----------|--------|
| FIX-001 | target=api, handled by aws-api-codegen-fixer |
| FIX-003 | target=api, handled by aws-api-codegen-fixer |
| FIX-004 | target=api, handled by aws-api-codegen-fixer |

## Verification

- `lsp_diagnostics tests/e2e/conftest.py`: 0 errors
- `uv run pytest tests/e2e/ --collect-only -q`: 6 tests collected

## Next Action

Re-run tests: `aws run --change 20260612-user-mgmt`
