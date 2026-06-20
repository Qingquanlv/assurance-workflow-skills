# Case Review Summary

## Decision

- Decision: **pass**
- Risk: low
- Auto Fix Allowed: false
- Human Review Required: false

## Summary

Case design for change `20260614-menu-mgmt` (menu module) is complete, testable, and ready for downstream API/E2E planning. Ten cases were generated under `added`:

| Case ID | Type | Priority | Risk | Tier |
|---|---|---|---|---|
| TC-MENU-001 | API | P0 | high | smoke |
| TC-MENU-002 | API | P0 | high | smoke |
| TC-MENU-003 | API | P0 | high | smoke |
| TC-MENU-004 | API | P1 | medium | regression |
| TC-MENU-005 | API | P1 | high | regression |
| TC-MENU-006 | API | P0 | high | smoke |
| TC-MENU-007 | API | P1 | medium | regression |
| TC-MENU-008 | API | P0 | **critical** | smoke |
| TC-MENU-E2E-001 | E2E | P0 | high | smoke |
| TC-MENU-E2E-002 | E2E | P1 | medium | regression |

### What was reviewed

- Coverage: ✅ Tree structure (parent_id nesting), ordering (`order` ascending), full CRUD, business rule (delete-with-children rejection), circular-dependency protection.
- Layer assignment: ✅ Matches proposal `## Layer Rationale`. No same-assertion duplication between API and E2E.
- Schema/structure: ✅ Delta format compliant; all 10 cases under `added`; target `qa/cases/menu/case.yaml` does not exist yet, so `modified=[]` / `removed=[]` is correct.
- Forbidden content: ✅ No HTTP method/path mappings, no auth tokens, no Playwright/pytest code, no selectors/XPath, no real credentials.
- Traceability: ✅ Each case maps `requirement_id` → `test_condition_id` → `case_id`; conditions table present in proposal.md.
- Risk consistency: ✅ P0 cases all high/critical; `automation.required = true` for all high/critical risk; rationales meaningful.

### Notable design choice

`TC-MENU-008` is a deliberate negative-path probe of suspected recursive infinite loop in `/api/v1/menus/list` when `parent_id` is set to self or descendant via `/menus/update`. If this case fails at execution time, the workflow will treat it as a **product issue** (recorded in `inspect/known-product-issues.md`) rather than a test bug. The case does not assert a specific error response shape; it asserts only that (a) the request must be rejected, (b) the list endpoint must return in bounded time, (c) the parent_id must remain unchanged.

## Blockers

None.

## Findings

- **CASE-FINDING-001 (low / assertion)** — `TC-MENU-007` and `TC-MENU-008` defer the concrete error-response shape to implementation. Acceptable at case-design time; downstream `aws-api-plan` must pin this down before codegen.
- **CASE-FINDING-002 (low / data)** — Test fixtures (`top_level_menu_factory`, `child_menu_factory`, `menu_with_children_factory`, `qa-test-*` cleanup) are referenced as needs; the fact-baseline phase must confirm `.aws/data-knowledge.yaml` registration or plan an extension.

Both are informational; neither blocks moving to planning.

## Auto Fix Plan

Empty. No findings are eligible for auto-fix; both findings are deferred to downstream phases.

## Next Action

`continue` — proceed to fact-baseline (Phase 3.5), then `aws-api-plan` (Phase 4A) and `aws-e2e-plan` (Phase 4B) in parallel.
