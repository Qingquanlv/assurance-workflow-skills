# E2E Test Data Plan — roles module

**Change:** `eval-sample-002`

## Fixtures (reuse)

- `admin_token` — session-scoped admin JWT via API login (see bench `tests/e2e/conftest.py` when present)
- `role_management_page` — navigates to `/system/role` after admin login

## Data setup

No new scripts required for smoke case TC-ROLES-E2E-001 (read-only page load).
