# Archive Summary: {change_id}

---
archived_at: {datetime}
archived_by: {agent|human}
archive_status: archived | archived_with_known_issues
---

## Change Summary

{Brief description of what this change covered}

## Case Delta Applied

| Action | Count | Case IDs |
|--------|-------|----------|
| ADDED | {n} | {ids} |
| MODIFIED | {n} | {ids} |
| REMOVED | {n} | {ids} |

## Test Files Created or Updated

- `tests/api/{module}/test_{file}_api.py`
- `tests/api/{module}/helpers/{file}_api.py`
- `tests/fixtures/{module}_fixtures.py`
- `tests/e2e/test_{module}_e2e.py`

## Execution Results

| Type | Passed | Failed | Known Issues |
|------|--------|--------|--------------|
| API  | {n}    | {n}    | {n}          |
| E2E  | {n}    | {n}    | {n}          |

Batch ID: `{batch_id}` (full results: `execution/runs/{batch_id}/`)

## Review Outcome

| Layer | Status |
|---|---|
| Case Review | PASS |
| API Plan Review | PASS / N/A |
| E2E Plan Review | PASS / N/A |
| Execution Review | PASS / PASS_WITH_KNOWN_ISSUES |

## Known Product Issues

<!-- Fill in if archive_status == completed_with_known_issues, otherwise write "None" -->

| ID | Module | Endpoint | Workaround | Coverage Gap | Status |
|---|---|---|---|---|---|
| {KPI-001} | {module} | {METHOD /path} | {description} | open | open |

Source: `execution/known-product-issues.md`

## Archived Artifacts

- `qa/archive/{change_id}/cases/`
- `qa/archive/{change_id}/plans/`
- `qa/archive/{change_id}/review/`
- `qa/archive/{change_id}/execution/`
- `qa/archive/{change_id}/workflow-state.yaml`

## Notes

{Any follow-up items, observations, or next actions to resolve known product issues}
