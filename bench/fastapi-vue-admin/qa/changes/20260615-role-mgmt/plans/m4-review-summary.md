# M4 Review Summary — E2E Plan (`20260615-role-mgmt`)

**Stage**: aws-e2e-plan (Phase 4B) → handoff to aws-e2e-plan-reviewer (Phase 5B)

> **Note**: M3 = API plan summary (handoff to api-plan-reviewer). M4 = E2E plan summary (this file). Both use the same review summary format; the M3/M4 numbering matches the milestone phasing in the AWS QA workflow spec.

## Plan Readiness

**`ready_with_warnings`**

## Codegen Readiness

**`ready_with_warnings`**

## Files Produced

- `plans/e2e-plan.md`
- `plans/e2e-test-data-plan.md`
- `plans/e2e-codegen-plan.md`
- `plans/m4-review-summary.md` (this file)

## Test Inventory

| # | Case | Page Action |
|---|---|---|
| 1 | TC-ROLE-100 | navigate to `/system/role`, assert table + headers |
| 2 | TC-ROLE-101 | open create modal, fill form, submit, verify success + visibility |
| 3 | TC-ROLE-102 | API pre-seed role, open authorize dialog, check menu, save, verify via API + reopen |

## Auth & Routes

- Login: `${FRONTEND_BASE_URL}/login` via `logged_in_page` fixture (existing).
- Role page: `${FRONTEND_BASE_URL}/system/role` via NEW `role_management_page` fixture.
- API helpers reuse `admin_token` (existing) + `token` header convention.

## Selectors Source

All selectors were grep-derived from `web/src/views/system/role/index.vue` (verified line numbers in e2e-plan.md). Fallback locators documented for known fragile points (NaiveUI tree, save button text).

## Test Data Strategy

- `unique_role_token` (NEW fixture) for `secrets.token_hex(4)` suffix.
- TC-ROLE-101: UI-driven create, API-driven cleanup via `cleanup_roles` fixture.
- TC-ROLE-102: API-driven pre-seed (`create_role_via_api`), UI-driven authorize, API-driven verify.

## Needs Review (4 items, all non-blocking)

| ID | Severity | Item |
|---|---|---|
| NR-E2E-01 | medium | Authorize dialog save button text — code provides fallback chain |
| NR-E2E-02 | low | NaiveUI tree-node click pattern may flake — fallback locators documented |
| NR-E2E-03 | low | Search button text "查询" not directly observable — code falls back to keyboard Enter |
| NR-E2E-04 | low | Authorize success toast wording variance — code accepts regex pattern |

## Blockers

**None.**

## Reviewer Hand-off

aws-e2e-plan-reviewer should evaluate:

- Are selector fallback chains acceptable, or should one be removed in favor of a single canonical locator?
- Is the API readback strategy in TC-ROLE-102 acceptable as the source-of-truth assertion (instead of relying on UI tree-node checked state)?
- Recommendation: accept all NR-E2E-* as informational; emit `decision=pass`, `codegen_readiness=ready_with_warnings`, no findings.

## Workflow State Update

After this file is written:

- `phases.e2e_plan.status = done`
- `phases.e2e_plan.outputs = [e2e-plan.md, e2e-test-data-plan.md, e2e-codegen-plan.md, m3-review-summary-e2e.md]`
- `phases.e2e_plan.readiness.plan = ready_with_warnings`
- `phases.e2e_plan.readiness.codegen = ready_with_warnings`
