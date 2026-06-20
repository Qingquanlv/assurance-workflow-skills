# M3 Review Summary — API Plan (`20260615-role-mgmt`)

**Stage**: aws-api-plan (Phase 4A) → handoff to aws-api-plan-reviewer (Phase 5A)

## Plan Readiness

**`ready_with_warnings`**

All 11 API cases have concrete endpoints, methods, payloads, headers, fixtures, helpers, and assertions. 5 non-blocking Needs Review items are tracked. No blockers.

## Codegen Readiness

**`ready_with_warnings`**

Hard gate signals:

| Gate | Status |
|---|---|
| `.aws/data-knowledge.yaml` exists | ✅ pass (verified Phase 0) |
| All selected cases have data capabilities resolved | ✅ pass (see api-test-data-plan.md → Capability Mapping) |
| Helper functions exist on disk | ⚠️ partial — 3 of 9 helpers exist; codegen will add the 6 missing helpers + `safe_delete_role_by_name` |
| Fact baseline placeholders resolved | ✅ pass (Phase 3.5) |
| Auth strategy concrete | ✅ pass |
| Cleanup strategy concrete | ✅ pass |

Material warning: helper gap is codegen-resolvable inline; pattern is well-established (extend existing `tests/api/helpers/role_api.py` mirroring style of `create_role`, `find_role_id_by_name`, `safe_delete_role`).

## Files Produced

| File | Purpose |
|---|---|
| `plans/api-plan.md` | Targets table, auth strategy, request/assertion strategy per case, mock/cleanup strategy |
| `plans/api-test-data-plan.md` | Required data, capability mapping, setup/cleanup strategy, runtime verify |
| `plans/api-codegen-plan.md` | Concrete file layout, helper signatures, test function templates, acceptance checklist |
| `plans/m3-review-summary.md` | This file |

## Test Inventory

11 cases → 11 pytest functions in `tests/api/test_role_api.py`:

| # | Case | Endpoint | Method |
|---|---|---|---|
| 1 | TC-ROLE-001 | `/api/v1/role/list` | GET |
| 2 | TC-ROLE-002 | `/api/v1/role/list?role_name=...` | GET |
| 3 | TC-ROLE-003 | `/api/v1/role/get?role_id=...` | GET |
| 4 | TC-ROLE-004 | `/api/v1/role/get?role_id=999999` | GET |
| 5 | TC-ROLE-005 | `/api/v1/role/create` | POST |
| 6 | TC-ROLE-006 | `/api/v1/role/create` (dup) | POST |
| 7 | TC-ROLE-007 | `/api/v1/role/update` | POST |
| 8 | TC-ROLE-008 | `/api/v1/role/delete?role_id=...` | DELETE |
| 9 | TC-ROLE-009 | `/api/v1/role/authorized?id=...` | GET |
| 10 | TC-ROLE-010 | `/api/v1/role/authorized` (rewrite menus) | POST |
| 11 | TC-ROLE-011 | `/api/v1/role/authorized` (rewrite apis) | POST |

## Auth & Headers

- Login: `POST /api/v1/base/access_token` body `{username, password}`.
- Header: literal lowercase `token: {jwt}` (NOT `Authorization: Bearer`). Confirmed via `app/core/dependency.py` and data-knowledge.yaml.
- Reuse session-scoped `admin_token` + `api_client` fixtures.

## Test Data Strategy

- Function-scoped fixtures (`seeded_role`) handle cleanup automatically.
- Deterministic role names with `qa-role-*` prefix to ease debugging and out-of-band cleanup.
- Pre-clean precondition step using `safe_delete_role_by_name` to absorb leftover rows from aborted prior runs.
- HTTP read-back substitutes for "ORM 查询" assertions in case.yaml — functionally equivalent because controller is the only DB writer.

## Assumptions

1. Backend is reachable at `http://localhost:9999` (or `BASE_URL` env override) at run time.
2. Default admin role exists at session start (init_app guarantees).
3. Menu id=1 (`系统管理`) is stable; api `(GET /api/v1/dept/list)` and `(POST /api/v1/dept/create)` are stable by `(method, path)` tuple.
4. Backend currently running points to a DB where these QA test rows can be safely created and deleted (i.e. not production).

## Needs Review (5 items, all non-blocking)

| ID | Severity | Summary |
|---|---|---|
| NR-API-01 | medium | Helper functions missing on disk — codegen must add them |
| NR-API-02 | low | Duplicate-name error message case-insensitive substring assertion |
| NR-API-03 | low | TC-ROLE-007 update success path: only assert success message + read-back |
| NR-API-04 | low | OOB session sweep deferred — function-scoped cleanup is sufficient |
| NR-API-05 | low | Bind-and-readback uses `(method, path)` tuple for api stability |

Full text: see `plans/api-plan.md` → Needs Review section.

## Blockers

**None.**

## Reviewer Hand-off

aws-api-plan-reviewer should evaluate:

- Are the 5 Needs Review items genuinely non-blocking, or is at least one severe enough to demote codegen_readiness to `not_ready`?
- Is HTTP read-back acceptable substitution for "ORM 查询" assertions (Setup Strategy step 5 in api-test-data-plan.md)?
- Are deterministic role names safe enough without OOB session sweep?
- Are the 6 helper additions in scope for codegen, or should aws-api-plan-fixer handle them in a Phase 6A pre-codegen pass instead? (Recommendation: codegen can absorb them — they are direct mechanical translations of HTTP calls.)

If reviewer agrees with all of the above, expected outcome:

- `plan_review.decision = pass`
- `plan_review.codegen_readiness = ready_with_warnings`
- `plan_review.blockers = []`
- `plan_review.findings = []` (Needs Review converted to informational, not findings)

## Workflow State Update

After this file is written:

- `phases.api_plan.status = done`
- `phases.api_plan.timestamp = 2026-06-15`
- `phases.api_plan.outputs = [api-plan.md, api-test-data-plan.md, api-codegen-plan.md, m3-review-summary.md]`
- `phases.api_plan.readiness.plan = ready_with_warnings`
- `phases.api_plan.readiness.codegen = ready_with_warnings`
