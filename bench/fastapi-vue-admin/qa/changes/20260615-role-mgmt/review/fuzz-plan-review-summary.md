# Fuzz Plan Review Summary

## Decision

- Decision: **pass**
- Risk: **medium**
- Codegen Readiness: **ready_with_warnings**
- Auto Fix Allowed: false
- Human Review Required: false

## Summary

Fuzz plan covers TC-ROLE-200 against all 7 role endpoints via schemathesis schema-based property testing. The plan resolves all hard prerequisites:

- **Schema source**: `http://localhost:9999/openapi.json` (live FastAPI OpenAPI; same backend `aws run` boots)
- **Auth strategy**: token header injection via schemathesis `before_call` hook reusing existing `get_admin_token` from `tests/e2e/scripts/user_data_setup.py`
- **Cleanup**: session-scoped role-id-set diff (snapshot pre/post) via API delete
- **Related cases**: TC-ROLE-005/006/010/011 mapped (each fuzzed endpoint has a functional case)
- **Tooling**: schemathesis 3.39.16 installed in-session (resolves prior blocker B-FUZZ-01)

No blockers. Four Needs Review items, all non-blocking, capture (a) product-behavior questions for the inspect classifier and (b) tooling/fixture acceptance questions.

## Coverage

| Endpoint | Method | Functional Sibling |
|---|---|---|
| `/api/v1/role/list` | GET | TC-ROLE-005 (search) |
| `/api/v1/role/get` | GET | TC-ROLE-005 (search) |
| `/api/v1/role/create` | POST | TC-ROLE-006 (create) |
| `/api/v1/role/update` | POST | TC-ROLE-010 (update) |
| `/api/v1/role/delete` | DELETE | TC-ROLE-011 (delete) |
| `/api/v1/role/authorized` | GET | TC-ROLE-007 / 008 |
| `/api/v1/role/authorized` | POST | TC-ROLE-009 (assign menus/apis) |

7 of 7 role endpoints covered. Property: `not_a_server_error` (no 5xx for any schema-conforming or schema-deviating-but-properly-typed input).

## Codegen Readiness

`ready_with_warnings`. All boundary criteria met:

- Schema URL resolved
- Auth hook resolved with concrete token-acquisition path
- Cleanup strategy concrete and idempotent
- `schemathesis>=3.30,<4` installed (3.39.16); pytest auto-downgraded to 8.4.2 — verified existing E2E/API test suites still collect cleanly
- Failure classification policy documented in plan (NR-FUZZ-01/02 deferred to inspect-time)

## Blockers

None. (Prior blocker B-FUZZ-01 resolved by user-approved `uv add schemathesis>=3.30,<4`.)

## Needs Review

4 items, all non-blocking:

| ID | Severity | Category | Question |
|---|---|---|---|
| FUZZ-PLAN-REVIEW-001 | medium | product | `api_infos` non-existent (path,method) → likely 5xx. Classify as product_issue or expected_baseline? |
| FUZZ-PLAN-REVIEW-002 | medium | product | `name` unbounded length → DB integrity error → 5xx. Classify as product_issue or expected_baseline? |
| FUZZ-PLAN-REVIEW-003 | low | tooling | pytest 9.0.3 → 8.4.2 downgrade acceptable? (Verified: yes.) |
| FUZZ-PLAN-REVIEW-004 | low | fixture | Role-id-set diff cleanup (vs name-prefix sweep) acceptable? |

NR-FUZZ-01 and NR-FUZZ-02 are *classification* questions — they don't block code generation; they're handed off to `aws-inspect` as `known-product-issues.md` entries when fuzz failures appear.

## Findings

None.

## Auto Fix Plan

None.

## Next Action

`continue` → proceed to Phase 7C (aws-fuzz-codegen).
