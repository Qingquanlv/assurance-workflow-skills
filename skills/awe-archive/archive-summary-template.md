# Archive Summary: {change_id}

archived_at: {datetime}
archived_by: {agent|human}

## Change Summary

{Brief description of what this change covered}

## Case Delta Applied

| Action | Count | Case IDs |
|--------|-------|----------|
| ADDED | {n} | {ids} |
| MODIFIED | {n} | {ids} |
| REMOVED | {n} | {ids} |

## Test Files Created or Updated

- `tests/api/{module}/test_{file}.py`
- `tests/e2e/{module}/{file}.spec.ts`

## Execution Results

| Type | Passed | Failed | Waived |
|------|--------|--------|--------|
| API  | {n}    | {n}    | {n}    |
| E2E  | {n}    | {n}    | {n}    |

## Review Outcome

| Layer | Status |
|---|---|
| Case Review | PASS |
| Code Review | PASS |
| Execution Review | PASS |

## Archived Artifacts

- `qa/archive/{change_id}/subplans/`
- `qa/archive/{change_id}/review/`
- `qa/archive/{change_id}/execution/`
- `qa/archive/{change_id}/trace/`

## Notes

{Any follow-up items, known issues, or observations}
