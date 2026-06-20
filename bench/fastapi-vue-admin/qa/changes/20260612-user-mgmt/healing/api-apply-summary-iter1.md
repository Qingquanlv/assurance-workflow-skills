# API Codegen Fixer — Apply Summary

**Change**: 20260612-user-mgmt
**Applied at**: 2026-06-13T00:42:00Z
**Proposals applied**: 3 (FIX-001, FIX-003, FIX-004)
**Files modified**: 2 (tests/api/test_users_api.py, tests/api/conftest.py)

## Applied Fixes

### FIX-001 — test_data_failure (api)

- **Files**: `tests/api/test_users_api.py`, `tests/api/conftest.py`
- **Operation**: replace_string_literal
- **Description**: Globally replaced `@test.local` → `@example.com` (Pydantic email-validator rejects RFC2606-reserved `.local` TLD, accepts `example.com`).
- **Counts**: 5 replacements in test file + 1 in conftest factory.

### FIX-003 — test_data_failure (api, reclassified)

- **File**: `tests/api/test_users_api.py:280`
- **Operation**: replace_string_literal
- **Description**: `ghost@test.local` → `ghost@example.com` so `test_update_user_not_found` can reach the controller's 404 path instead of failing at request validation.

### FIX-004 — test_data_failure (api, reclassified)

- **File**: `tests/api/test_users_api.py:301, 351`
- **Operation**: replace_string_literal
- **Description**: `qa_delete_user@test.local` and `qa_reset_user@test.local` → `@example.com`. Same root cause; previously misclassified as assertion_failure based on `assert X == Y` traceback pattern.

## No-op Files

| File | Reason |
|------|--------|
| `tests/api/helpers/user_api.py` | File listed in proposal but contains no `@test.local` literals; no patch required. |

## Skipped Proposals

| Proposal | Reason |
|----------|--------|
| FIX-002 | target=e2e, handled by aws-e2e-codegen-fixer |

## Verification

- `lsp_diagnostics tests/api/test_users_api.py`: 0 errors
- `lsp_diagnostics tests/api/conftest.py`: 0 errors
- `uv run pytest tests/api/test_users_api.py --collect-only -q`: 15 tests collected

## Next Action

Re-run tests: `aws run --change 20260612-user-mgmt`
