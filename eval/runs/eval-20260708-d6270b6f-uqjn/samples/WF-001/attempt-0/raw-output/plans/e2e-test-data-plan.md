# E2E Test Data Plan — users module

**Change:** `eval-sample-001`

## Fixtures (reuse)

- `admin_token` — session-scoped admin JWT via API login
- `user_management_page` — navigates to `/system/user` after admin login

## Data setup

No new scripts required for smoke case TC-USER-E2E-001 (read-only page load).
