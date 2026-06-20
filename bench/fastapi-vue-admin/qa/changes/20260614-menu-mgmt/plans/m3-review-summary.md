# M3 Stage 1 Review Summary - API Plan

**Change ID**: 20260614-menu-mgmt
**Module**: menu
**Stage**: M3 Stage 1 (API Planning)
**Generated**: 2026-06-14
**Status**: PLAN_DRAFTED - awaits aws-api-plan-reviewer (Phase 5A)

## Plan Files Produced

- plans/api-plan.md
- plans/api-test-data-plan.md
- plans/api-codegen-plan.md
- plans/m3-review-summary.md (this file)

## Case Coverage Snapshot

Total API cases planned: 8 (TC-MENU-001..008)

| Case ID | Title | Plan Status | Codegen Ready |
|---|---|---|---|
| TC-MENU-001 | List menus baseline | drafted | no - blocked on Phase 6.5 |
| TC-MENU-002 | Create top-level catalog menu | drafted | no - blocked on Phase 6.5 |
| TC-MENU-003 | Create child menu under catalog | drafted | no - blocked on Phase 6.5 |
| TC-MENU-004 | Update menu order | drafted | no - blocked on Phase 6.5 |
| TC-MENU-005 | Move menu between parents | drafted | no - blocked on Phase 6.5 |
| TC-MENU-006 | Delete leaf menu | drafted | no - blocked on Phase 6.5 |
| TC-MENU-007 | Get deleted menu returns failure | drafted | no - blocked on Phase 6.5; assertion variant pinned at first run |
| TC-MENU-008 | Cycle protection (parent_id self-loop) | drafted | no - blocked on Phase 6.5; expected to FAIL (product bug) |

Plan-ready: 8 / 8
Codegen-ready: 0 / 8

## Codegen Readiness

**Status**: not_ready
**Reason**: Phase 6.5 helper/fixture creation outstanding (per fact-baseline ANOMALY-001)

Required artifacts (all NEW):
- tests/api/helpers/menu_api.py
- menu factories in tests/api/conftest.py
- (E2E) tests/e2e/scripts/menu_data_setup.py
- (E2E) cleanup_menus + menu_management_page in tests/e2e/conftest.py
- refresh .aws/data-knowledge.yaml after creation

## Non-Risks (NR)

- NR-API-001: Auth header convention is project-specific (literal "token: <jwt>", not Bearer) - confirmed in app/api/v1/menus
- NR-API-002: Business failures use Fail() returning HTTP 200 + body code 4000 - confirmed in app/schemas/base.py
- NR-API-003: MenuUpdate.component has no Pydantic default - all updates use read-then-update round-trip
- NR-API-004: Seed menus identified in app/core/init_app.py:81-176 by name lookup (IDs auto-assigned)
- NR-API-005: qa-test-* prefix reserved exclusively for QA-created menus; out-of-band session cleanup planned

## Blockers (BL)

- BL-API-001: data-knowledge.yaml stale (ANOMALY-001) - menu_api helpers and fixtures referenced but absent on disk. Blocks codegen until Phase 6.5.
- BL-API-002: TC-MENU-008 will infinite-recurse the live backend without timeout protection. Plan specifies 5s hard timeout on /menus/list as failure signal.
- BL-API-003: TC-MENU-007 assertion shape (HTTP 404 vs HTTP 200 + code != 200) deferred until first execution; codegen documents both variants.

## Data Knowledge Gate

- Status: WARNING - present_but_stale
- Action: extend during Phase 6.5; refresh .aws/data-knowledge.yaml post-creation
- Decision: needs_extension_before_codegen (gate documented in workflow-state.yaml)

## Open Decisions for Reviewer

- Confirm 5s timeout choice on /menus/list for TC-MENU-008
- Confirm read-then-update round-trip helper as the canonical update path
- Confirm OOB session cleanup (autouse session fixture) acceptable for stray qa-test-* menus

## Next Phase

Phase 4B - E2E Plan drafting (e2e-plan.md, e2e-codegen-plan.md, m3-stage2-review-summary.md)
Phase 5A - aws-api-plan-reviewer inline review
