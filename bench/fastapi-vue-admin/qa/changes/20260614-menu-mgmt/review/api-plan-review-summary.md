# API Plan Review Summary

## Decision

- Decision: pass
- Risk: medium
- Codegen Readiness: ready_with_warnings
- Auto Fix Allowed: false
- Human Review Required: false

## Summary

API plan for the menu module is complete and codegen-ready. All 8 cases (TC-MENU-001..008) map to concrete test functions targeting real backend endpoints (`/api/v1/menus/{create,list,get,update,delete}`) with concrete HTTP methods, the project's `token: <jwt>` auth header convention, request bodies, and per-case assertions. The test-data plan enumerates 4 factories (`top_level_menu_factory`, `child_menu_factory`, `menu_with_children_factory`, `menu_move_scenario_factory`) plus a session-scoped OOB cleanup; **all helpers and fixtures referenced by the plan are now present on disk per Phase 6.5**, and `.aws/data-knowledge.yaml` is fresh (workflow-state.yaml gate `data_knowledge=fresh`).

TC-MENU-008 is intentionally designed as a product-behavior probe of ANOMALY-002 (recursive `parent_id` cycle bug). The plan exercises the **target** `/menus/update` endpoint directly (no alternate-endpoint substitution), so this is **not** an endpoint coverage_gap by the skill's definition and `known-product-issues.md` is not required by this gate. The expected execution-time failure is by design and will be classified as a product issue at the inspect phase, not as a test defect.

## Coverage

All 8 API cases from `cases/menu/case.yaml` are mapped to test functions in `api-codegen-plan.md`:

| Case ID | Test Function | Endpoints exercised |
|---|---|---|
| TC-MENU-001 | `test_create_top_level_catalog_menu_succeeds` | POST /menus/create + GET /menus/list |
| TC-MENU-002 | `test_create_child_menu_under_existing_parent` | POST /menus/create + GET /menus/list |
| TC-MENU-003 | `test_list_returns_tree_with_siblings_ordered_asc` | GET /menus/list |
| TC-MENU-004 | `test_update_menu_basic_fields` | POST /menus/update + GET /menus/get |
| TC-MENU-005 | `test_update_parent_id_moves_menu_to_new_parent` | POST /menus/update + GET /menus/list |
| TC-MENU-006 | `test_delete_menu_with_children_returns_business_failure` | DELETE /menus/delete + GET /menus/list |
| TC-MENU-007 | `test_delete_leaf_menu_succeeds` | DELETE /menus/delete + GET /menus/get |
| TC-MENU-008 | `test_update_parent_id_to_self_or_descendant_is_rejected` (parametrized A/B) | POST /menus/update + GET /menus/list + GET /menus/get |

No case is unmapped. No plan scenario is unlinked from a case. Critical assertions (response code, business code, persistence verification, parent_id invariants, ordering invariants) are present for every case.

## Codegen Readiness

`ready_with_warnings`. Justification:

- `.aws/data-knowledge.yaml` exists and is fresh (gate verified: workflow-state.yaml `gates.data_knowledge=fresh`).
- All 11 helpers listed in `api-codegen-plan.md` Helper Mapping exist in `tests/api/helpers/menu_api.py` (verified during Phase 6.5; LSP clean).
- All 4 factories + OOB cleanup exist in `tests/api/conftest.py` (verified: pytest collection passes 21 tests).
- Endpoints, methods, request bodies, and auth strategy are concrete (no `TBD` in API Targets).
- Assertion strategy is documented per case, including the explicit deferred decision for TC-MENU-007.
- Cleanup strategy is mapped per case with idempotent `safe_delete_menu` semantics.

The two `ready_with_warnings`-class warnings (kept as documented assumptions, not blockers):

1. **TC-MENU-007 deferred assertion shape** — disjunctive assertion (status 404 OR code != 200) is acceptable; codegen is instructed to capture the actual response shape and tighten in next iteration.
2. **TC-MENU-008 expected execution-time failure** — by design; aspirational + hard assertions both implemented per the plan's Assertion Strategy.

## Blockers

None.

The plan's `Blockers` section (BL-API-001/002/003) reflected pre-Phase-6.5 state. All three blockers have been resolved:

- BL-API-001: `tests/api/helpers/menu_api.py` exists with all required helpers.
- BL-API-002: 4 menu factories + OOB cleanup added to `tests/api/conftest.py`.
- BL-API-003: `.aws/data-knowledge.yaml` refreshed; workflow-state gate `data_knowledge=fresh`.

Reviewer treats these as historical and does NOT reproduce them as gate blockers.

## Needs Review

None blocking.

`m3-review-summary.md` lists three "Open Decisions for Reviewer":

1. **5s timeout on /menus/list for TC-MENU-008** — acceptable. httpx default timeout is 5s; using an explicit per-call `timeout=5.0` makes the failure mode (timeout vs hang) explicit and pytest-friendly.
2. **read-then-update round-trip as canonical update path** — acceptable. `MenuUpdate.component` has no Pydantic default (verified in `app/schemas/menus.py`). Round-trip helper `read_then_update` is implemented in `tests/api/helpers/menu_api.py` per Phase 6.5.
3. **OOB session cleanup (autouse session fixture) for stray qa-test-* menus** — acceptable. The `qa-test-*` prefix is reserved exclusively for QA-created data (verified against `app/core/init_app.py:81-176`); session-scoped autouse cleanup matches the project convention used by `_qa_test_user_oob_cleanup` and `_qa_test_role_oob_cleanup`.

## Findings

| ID | Severity | Category | Summary |
|---|---|---|---|
| API-PLAN-FINDING-001 | medium | assertion | TC-MENU-007 disjunctive assertion (status 404 OR code != 200) deferred until first run; documented and acceptable. |
| API-PLAN-FINDING-002 | medium | assertion | TC-MENU-008 expected-fail product probe; aspirational + hard assertions both required by the plan. |
| API-PLAN-FINDING-003 | low | execution | Run guidance correct; no pytest markers needed (matches existing project convention). |
| API-PLAN-FINDING-004 | low | knowledge | Plan's Blockers section is historical; all three resolved by Phase 6.5. |

None of these findings block the gate. None are auto-fixable (they are informational acknowledgments of accepted assumptions or post-Phase-6.5 state, not plan defects). Therefore `auto_fix_allowed=false` and `auto_fix_plan=[]`.

## Auto Fix Plan

Empty. No plan-file edits required.

## Next Action

`continue` — proceed to Phase 5B (aws-e2e-plan-reviewer for the E2E plan), then Phase 7A (aws-api-codegen) once the E2E gate also passes.

Codegen MUST observe:

- TC-MENU-007: implement disjunctive assertion `status == 404 OR code != 200`; capture actual response shape in a comment for next-iteration tightening.
- TC-MENU-008: use per-call httpx timeout=5.0 on /menus/list; assert hard invariants `data.parent_id != self/descendant` on /menus/get; document expected-fail behavior in a docstring (no `xfail` marker, matching project style).
- TC-MENU-006: assertion uses `code != 200` (not a hardcoded 4000), with msg substring "Cannot delete a menu with child menus".
- All update calls: use `read_then_update` round-trip helper (already shipped in `tests/api/helpers/menu_api.py`).
