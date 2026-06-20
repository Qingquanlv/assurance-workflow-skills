# Failure Analysis Summary: 20260612-user-mgmt

## Result

Status: **analyzed**

## Failure Table

| Case ID | Target | Category | Fix Eligible | Evidence | Summary |
|---------|--------|----------|:------------:|----------|---------|
| test_list_users_unauthenticated_rejected | api | assertion_failure | ✗ | — | Assertion mismatch — expected value differs from actual. unauthenticated_clie... |

## Category Distribution

| Category | Count |
|----------|------:|
| assertion_failure | 1 |

## Hard Fail Cases

| Case ID | Reason |
|---------|--------|
| test_list_users_unauthenticated_rejected | Assertion mismatch — expected value differs from actual. unauthenticated_client = <httpx.Client o... |

## Needs Review

_None._

## Evidence

- Raw logs: `qa/changes/20260612-user-mgmt/execution/raw/`
- Trace files: `qa/changes/20260612-user-mgmt/execution/traces/`
- Screenshots: `qa/changes/20260612-user-mgmt/execution/screenshots/`
- Videos: `qa/changes/20260612-user-mgmt/execution/videos/`
- Test files: `tests/api/`, `tests/e2e/`

## Next Step

Hard failures detected. Investigate product issue, assertion mismatch, or environment before proceeding.
