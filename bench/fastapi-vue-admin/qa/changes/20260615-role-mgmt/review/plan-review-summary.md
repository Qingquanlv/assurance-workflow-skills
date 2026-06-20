# E2E Plan Review Summary

## Decision

- Decision: **pass**
- Risk: **low**
- Codegen Readiness: **ready_with_warnings**
- Auto Fix Allowed: false
- Human Review Required: false

## Summary

E2E plan covers all 3 E2E cases (TC-ROLE-100/101/102) against the role management page at `/system/role`. Selectors are grep-derived from `web/src/views/system/role/index.vue` with fallback chains documented for known fragile NaiveUI interaction patterns. Auth (`logged_in_page` fixture), data setup (3 new API helpers: `create_role_via_api`, `delete_role`, `get_role_authorized` + 3 new fixtures), and API-driven verification strategy are concrete and traceable.

Four Needs Review items are documented as non-blocking — all related to acceptable UI-string variability that cannot be resolved without a running frontend. No blockers.

## Coverage

| Case | Page Action | Verification |
|---|---|---|
| TC-ROLE-100 | Navigate to `/system/role` | Table column headers + ≥ 2 rows |
| TC-ROLE-101 | UI create role via modal | Toast "新增成功" + API readback + row visibility in table |
| TC-ROLE-102 | Authorize menu via dialog | Save button → API readback + reopen verify checkbox state |

3 of 3 cases mapped — 100% case-to-plan coverage.

## Codegen Readiness

`ready_with_warnings`. `.aws/data-knowledge.yaml` exists. All Ready-With-Warnings boundary criteria met:
- Route confirmed (`/system/role`)
- Auth strategy confirmed (`logged_in_page` fixture, admin login)
- Required selectors documented with fallbacks
- Fixtures either exist or are explicitly scoped as additive codegen changes
- Data setup via API helpers (reusing existing `admin_token` from conftest)
- Cleanup via `cleanup_roles` fixture (API-based delete for any created role)
- No blockers

## Blockers

None.

## Needs Review

4 items, all non-blocking:

| ID | Severity | Question |
|---|---|---|
| E2E-PLAN-REVIEW-001 | medium | Authorize dialog save button: "保存" vs "确定" fallback chain acceptable? |
| E2E-PLAN-REVIEW-002 | low | NaiveUI tree node click: `get_by_text` + `.n-tree-node-content__text` fallback acceptable? |
| E2E-PLAN-REVIEW-003 | low | Search button may be absent; Enter key fallback acceptable? |
| E2E-PLAN-REVIEW-004 | low | Authorize success toast regex: `保存成功\|更新成功\|设置成功` acceptable? |

## Findings

None.

## Auto Fix Plan

None.

## Next Action

`continue` → proceed to Phase 7B (aws-e2e-codegen).