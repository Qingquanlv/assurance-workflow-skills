# M3 Stage 2 Review Summary - E2E Plan

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Stage**: M3 Stage 2 (E2E Planning)
**Generated**: 2026-06-14
**Status**: PLAN_DRAFTED - awaits aws-e2e-plan-reviewer (Phase 5B)

## Plan Files Produced

- plans/e2e-plan.md
- plans/e2e-codegen-plan.md
- plans/m3-stage2-review-summary.md (this file)

## Case Coverage Snapshot

Total E2E cases planned: 2 (TC-MENU-E2E-001, TC-MENU-E2E-002)

| Case ID | Title | Plan Status | Codegen Ready |
|---|---|---|---|
| TC-MENU-E2E-001 | Create top-level catalog via UI | drafted | no - blocked on Phase 6.5 |
| TC-MENU-E2E-002 | Add child menu under catalog via UI | drafted | no - blocked on Phase 6.5 |

Plan-ready: 2 / 2
Codegen-ready: 0 / 2

## Page-Object Verification

UI source verified: `web/src/views/system/menu/index.vue` (read end-to-end).

Key product invariants confirmed against source:
- Top-level add button text: `新建根菜单` (line 263)
- Per-row child button text: `子菜单` (line 166)
- Modal action buttons: `保存` (CrudModal default), `确认` (NPopconfirm)
- Toast text via useCRUD: `新增成功`, `编辑成功`, `删除成功`
- Component path field is conditional on menu_type=="menu" (line 330)
- No pagination, no search box on menu list (line 271)

## Codegen Readiness

**Status**: not_ready

Reasons:
1. Phase 6.5 prerequisites still missing:
   - tests/e2e/scripts/menu_data_setup.py (NEW)
   - menu fixtures in tests/e2e/conftest.py (cleanup_menus, unique_menu_token, menu_management_page)
2. .aws/data-knowledge.yaml entries claim these exist (ANOMALY-001) and must be refreshed.

## Non-Risks (NR)

- NR-E2E-001: Login flow already proven by test_users_e2e.py (logged_in_page fixture). No change needed.
- NR-E2E-002: Backend base URL resolution reuses get_backend_base_url() (proven pattern).
- NR-E2E-003: `id` query param confirmed in app/api/v1/menus/menus.py:57 for delete.
- NR-E2E-004: Auth header literal `token: <jwt>` reused from existing user E2E.
- NR-E2E-005: ACTION_TIMEOUT_MS / NAV_TIMEOUT_MS constants reused unchanged.

## Blockers (BL)

- BL-E2E-001: data-knowledge.yaml stale (ANOMALY-001) - inherits BL-API-001 from stage 1.
- BL-E2E-002: NaiveUI tree-table row visibility after create may require expand or page reload. Codegen plan documents page.reload() fallback for TC-MENU-E2E-002.

## Open Decisions for Reviewer

- Confirm page.reload() approach is acceptable (alternative: programmatic NTreeSelect expand)
- Confirm autouse session-cleanup fixture for stray qa-test-* menus is acceptable
- Confirm `子菜单` button visibility precondition (catalog must have a children list, even empty) — verified by reading index.vue:158

## Cross-Phase Consistency Check

- E2E plan reuses prefix convention (`qa-test-*`) consistent with API plan
- E2E plan reuses unique_token strategy via `secrets.token_hex(4)` consistent with `unique_username` fixture
- Cleanup ordering (children-first) consistent with backend "Cannot delete a menu with child menus" (verified at app/api/v1/menus/menus.py:61)
- Helper file location `tests/e2e/scripts/menu_data_setup.py` consistent with `user_data_setup.py` / `role_data_setup.py`

## Next Phase

Phase 5A — aws-api-plan-reviewer inline review → review/api-plan-review.json
Phase 5B — aws-e2e-plan-reviewer inline review → review/plan-review.json
