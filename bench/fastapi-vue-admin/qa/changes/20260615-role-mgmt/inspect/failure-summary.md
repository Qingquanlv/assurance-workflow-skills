# Failure Analysis Summary: 20260615-role-mgmt

## Result

Status: **analyzed**

## Failure Table

| Case ID | Target | Category | Fix Eligible | Evidence | Summary |
|---------|--------|----------|:------------:|----------|---------|
| test_tc_role_001_list_default_pagination | api | assertion_failure | ✗ | — | Assertion mismatch — expected value differs from actual. api_client = <httpx.... |
| test_tc_role_002_list_filter_by_name | api | assertion_failure | ✗ | — | Assertion mismatch — expected value differs from actual. api_client = <httpx.... |
| TC-ROLE-101 | e2e | locator_failure | ✓ | — | Element locator failed. role_management_page = <Page url='http://localhost:31... |
| TC-ROLE-102 | e2e | business_logic_failure | ✗ | — | Server returned an error suggesting a product-level issue. role_management_pa... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/list] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/get] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/create] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/update] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[DELETE /api/v1/role/delete] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/authorized] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/authorized] | fuzz | fuzz_configuration_error | ✗ | — | Fuzz setup/config error (schema fetch, auth, or generation health check). Not... |

## Category Distribution

| Category | Count |
|----------|------:|
| assertion_failure | 2 |
| locator_failure | 1 |
| business_logic_failure | 1 |
| fuzz_configuration_error | 7 |

## Hard Fail Cases

| Case ID | Reason |
|---------|--------|
| test_tc_role_001_list_default_pagination | Assertion mismatch — expected value differs from actual. api_client = <httpx.Client object at 0x1... |
| test_tc_role_002_list_filter_by_name | Assertion mismatch — expected value differs from actual. api_client = <httpx.Client object at 0x1... |
| TC-ROLE-102 | Server returned an error suggesting a product-level issue. role_management_page = <Page url='http... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/list] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/get] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/create] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/update] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[DELETE /api/v1/role/delete] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[GET /api/v1/role/authorized] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |
| test_role_endpoints_schema_robustness[POST /api/v1/role/authorized] | Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Ex... |

## Needs Review

_None._

## Evidence

- Raw logs: `qa/changes/20260615-role-mgmt/execution/raw/`
- Trace files: `qa/changes/20260615-role-mgmt/execution/traces/`
- Screenshots: `qa/changes/20260615-role-mgmt/execution/screenshots/`
- Videos: `qa/changes/20260615-role-mgmt/execution/videos/`
- Test files: `tests/api/`, `tests/e2e/`

## Next Step

Hard failures detected. Investigate product issue, assertion mismatch, or environment before proceeding.
