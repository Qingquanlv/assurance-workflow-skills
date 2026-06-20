# Failure Analysis Summary: 20260614-menu-mgmt

## Result

Status: **analyzed**

## Failure Table

| Case ID | Target | Category | Fix Eligible | Evidence | Summary |
|---------|--------|----------|:------------:|----------|---------|
| test_update_parent_id_to_self_or_descendant_is_rejected[self] | api | test_data_failure | ✓ | — | Test data or fixture not available. api_client = <httpx.Client object at 0x10... |
| test_update_parent_id_to_self_or_descendant_is_rejected[descendant] | api | test_data_failure | ✓ | — | Test data or fixture not available. api_client = <httpx.Client object at 0x10... |

## Category Distribution

| Category | Count |
|----------|------:|
| test_data_failure | 2 |

## Hard Fail Cases

_None._

## Needs Review

_None._

## Evidence

- Raw logs: `qa/changes/20260614-menu-mgmt/execution/raw/`
- Trace files: `qa/changes/20260614-menu-mgmt/execution/traces/`
- Screenshots: `qa/changes/20260614-menu-mgmt/execution/screenshots/`
- Videos: `qa/changes/20260614-menu-mgmt/execution/videos/`
- Test files: `tests/api/`, `tests/e2e/`

## Next Step

Some failures have fix proposals allowed. Proceed to `fix-proposal-for-qa`.
