# Archive Summary — 20260612-user-mgmt

**Archive status**: `archived_with_warnings`
**Archived at**: 2026-06-13T01:25:00Z
**Target case file**: `qa/cases/users/case.yaml`

---

## Cases

| Action | Count | IDs |
|---|---|---|
| ADDED | 21 | TC-USER-001, 002, 003, 010, 011, 020, 021, 022, 030, 031, 040, 041, 050, 051, 052, 100, 101, 102, 103, 104, 105 |
| MODIFIED | 0 | — |
| REMOVED | 0 | — |

`qa/cases/users/case.yaml` did not exist before this change; created from the case delta.

## Test Code

| File | Status |
|---|---|
| `tests/api/test_users_api.py` | confirmed (15 tests) |
| `tests/e2e/test_users_e2e.py` | confirmed (6 tests, chromium) |

## Review Gates

| Gate | Decision | Risk Level |
|---|---|---|
| `review/case-review.json` | pass | medium |
| `review/api-plan-review.json` | pass | low |
| `review/plan-review.json` (E2E) | pass | medium |

All review gates pass.

## Execution Status

| Suite | Status | Counts |
|---|---|---|
| API | PASS | 15 passed / 0 failed / 15 total |
| E2E | PASS | 6 passed / 0 failed / 6 total |
| **Workflow** | **PASS** | latest batch `20260613-004711` |

### Execution History

| Batch | API (p/f/t) | E2E (p/f/t) | Note |
|---|---|---|---|
| `20260613-001752` | 6/9/15 | 0/6/6 | initial run; setup + selectors broken |
| `20260613-002644` | 14/1/15 | 3/3/6 | after healing iteration 1 (FIX-001..004) |
| `20260613-003915` | 15/0/15 | 6/6/6 | after manual intervention MI-001 + iter2 fixes |
| `20260613-004711` | 15/0/15 | 6/6/6 | final confirmation run |

## Healing Trail

- **Iteration 1**: 4 fixes applied (FIX-001 unique-username collision, FIX-002 list-search waits, FIX-003 wait-for-toast strategy, FIX-004 update-payload required fields). API 6→14, E2E 0→3.
- **Iteration 2**: 2 fixes applied (FIX-005 seed_username length ≤20, FIX-006 Popconfirm `确定`→`确认`). API 14, E2E 3→6.
- **Manual intervention MI-001**: User-approved test relaxation for TC-USER-003 — assertion now accepts `{401, 422}` because FastAPI's `Header(...)` dependency yields 422 on missing token. Out of healing loop.

Healing status: `resolved`.

## Known Product Issues

```yaml
archive_status: archived_with_warnings
known_product_issues:
  - id: KPI-001
    endpoint: POST /api/v1/user/create
    severity: major
    status: open
    evidence: "tortoise.exceptions.ValidationError on User.username max_length=20 surfaces as HTTP 500 instead of 422 (uncaught)"
    workaround: "Test code constrains seed_username to ≤20 chars (FIX-005)"
    coverage_gap: "Direct verification of 'long username should return 422' not exercised by current cases"
    follow_up: "Add a global tortoise.exceptions.ValidationError handler in app/core/exceptions.py returning 422, OR mirror DB max_length on app/schemas/users.py UserCreate.username"
  - id: AUTH-422-VS-401
    endpoint: GET /api/v1/user/list (and any auth-protected route)
    severity: minor
    status: open
    evidence: "FastAPI Header(...) dependency raises 422 on missing token; project README implies 401 is expected"
    workaround: "Test asserts response.status_code in {401, 422} (MI-001)"
    coverage_gap: "Spec ambiguity on authentication failure status code"
    follow_up: "Decide product contract — either implement custom auth dependency to raise HTTPException(401) globally, or document 422 as the official rejected-status."
```

## Archive Contents (qa/archive/20260612-user-mgmt/)

- `.qa.yaml`
- `proposal.md`
- `cases/users/case.yaml` (delta snapshot)
- `plans/` (api-plan.md, api-codegen-plan.md, e2e-plan.md, e2e-codegen-plan.md)
- `review/` (case, api-plan, e2e-plan reviews)
- `execution/` (manifest, api/e2e results, summary, runs/{4 batches})
- `inspect/` (failure-analysis.json, failure-summary.md from iter2)
- `healing/` (fix-proposal iter1+iter2 + apply summaries iter1+iter2)
- `scripts/` (data setup utilities)
- `workflow-state.yaml`

The source `qa/changes/20260612-user-mgmt/` is preserved (not deleted).
