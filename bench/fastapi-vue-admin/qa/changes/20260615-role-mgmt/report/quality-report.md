# Quality Report — 20260615-role-mgmt

- **Batch**: 20260617-090841
- **Final Status**: FAIL
- **Quality Score**: 66 / 100
- **Risk Level**: HIGH

## Score Breakdown

| Dimension | Points |
|-----------|--------|
| Functional | 66.3 |
| Coverage | N/A |
| Fuzz | 0 |
| Performance | N/A |

## Scope

- Cases: 1
- Requirements: REQ-ROLE-AUTH-GET, REQ-ROLE-AUTH-REWRITE-APIS, REQ-ROLE-AUTH-REWRITE-MENUS, REQ-ROLE-CREATE-DUPLICATE, REQ-ROLE-CREATE-OK, REQ-ROLE-DELETE-OK, REQ-ROLE-FUZZ, REQ-ROLE-GET-MISSING, REQ-ROLE-GET-OK, REQ-ROLE-LIST-DEFAULT, REQ-ROLE-LIST-SEARCH, REQ-ROLE-PAGE-AUTHORIZE, REQ-ROLE-PAGE-CREATE, REQ-ROLE-PAGE-LOAD, REQ-ROLE-UPDATE-OK

## Functional

- API: total=26 passed=24 failed=2
- E2E: total=3 passed=1 failed=2
- Fuzz: total=7 passed=0 failed=7

## Coverage

- Not collected (pytest-cov unavailable or disabled). Treated as a warning, not a failure.

## Non-Functional (Performance)

- Status: SKIPPED
- No performance scenarios recorded.

## Defects

- Product: 1
- Test: 10
- Environment: 0

### Product Defects

- `TC-ROLE-102` (business_logic_failure): Server returned an error suggesting a product-level issue. role_management_page = <Page url='http://localhost:3100/system/role'>

### Test Defects

- `test_tc_role_001_list_default_pagination` (assertion_failure): Assertion mismatch — expected value differs from actual. api_client = <httpx.Client object at 0x10ad13310>
- `test_tc_role_002_list_filter_by_name` (assertion_failure): Assertion mismatch — expected value differs from actual. api_client = <httpx.Client object at 0x10ad13310>
- `TC-ROLE-101` (locator_failure): Element locator failed. role_management_page = <Page url='http://localhost:3100/system/role'>
- `test_role_endpoints_schema_robustness[GET /api/v1/role/list]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[GET /api/v1/role/get]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[POST /api/v1/role/create]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[POST /api/v1/role/update]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[DELETE /api/v1/role/delete]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[GET /api/v1/role/authorized]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):
- `test_role_endpoints_schema_robustness[POST /api/v1/role/authorized]` (fuzz_configuration_error): Fuzz setup/config error (schema fetch, auth, or generation health check). Not a product bug. + Exception Group Traceback (most recent call last):

## Risk & Recommendation

- **Risk Level**: HIGH
- **Rationale**: Detected 1 product-level defect(s); product behaviour is incorrect.
- **Recommendation**: Do not release: failing tests or hard blockers must be resolved first.
