# Execution Summary: 20260615-role-mgmt

- **Batch ID:** `20260615-190106`
- **Archived at:** `qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/`

## Result

| Target | Status | Total | Passed | Failed | Skipped |
|--------|--------|------:|-------:|-------:|--------:|
| API    | failed | 26 | 24 | 2 | 0 |
| E2E    | failed | 3 | 1 | 2 | 0 |

## Commands

```bash
uv run pytest tests/api/test_role_api.py tests/api/helpers/role_api.py tests/api/test_users_api.py --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/pytest-report.xml
uv run pytest tests/e2e/test_role_e2e.py -v --headed --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/e2e-junit.xml
```

## Raw Reports

### API

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/api.log`
- JUnit XML: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/pytest-report.xml`
- JSON Report: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/pytest-report.json`

### E2E

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/raw/e2e.log`
- Playwright JSON: ``
- Playwright HTML Report: ``

## E2E Artifacts

- Traces: `qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/traces/`
- Screenshots: `qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/screenshots/`
- Videos: `qa/changes/20260615-role-mgmt/execution/runs/20260615-190106/videos/`

## Failed Cases

| Case ID | Target | Test | Message | Evidence |
|---------|--------|------|---------|----------|
| TC-ROLE-101 | E2E | test_create_role_via_ui[chromium] | role_management_page = <Page url='http://localhost:3100/system/role'> admin_t... | — |
| TC-ROLE-102 | E2E | test_authorize_role_menu_via_ui[chromium] | role_management_page = <Page url='http://localhost:3100/system/role'> admin_t... | — |

## Skipped Cases

_None_

## Unmapped Tests

List of tests that executed but could not be mapped to a Case ID.

| Test Name | Message |
|-----------|---------|
| test_tc_role_001_list_default_pagination | api_client = <httpx.Client object at 0x11282bad0>      def test_tc_role_001_l... |
| test_tc_role_002_list_filter_by_name | api_client = <httpx.Client object at 0x11282bad0>      def test_tc_role_002_l... |
| test_tc_role_003_get_detail_by_id |  |
| test_tc_role_004_get_detail_not_found |  |
| test_tc_role_005_create_unique_name |  |
| test_tc_role_006_create_duplicate_rejected |  |
| test_tc_role_007_update_desc_persisted |  |
| test_tc_role_008_delete_by_id |  |
| test_tc_role_009_get_authorized_returns_bindings |  |
| test_tc_role_010_rewrite_menu_ids |  |
| test_tc_role_011_rewrite_api_infos |  |
| test_list_users_default_pagination |  |
| test_list_users_filter_by_username |  |
| test_list_users_unauthenticated_rejected |  |
| test_get_user_detail_success |  |
| test_get_user_detail_not_found |  |
| test_create_user_with_role_success |  |
| test_create_user_duplicate_email_rejected |  |
| test_create_user_missing_email_validation_error |  |
| test_update_user_rewrites_roles |  |
| test_update_user_not_found |  |
| test_delete_user_success |  |
| test_delete_user_not_found |  |
| test_reset_password_normal_user_success |  |
| test_reset_password_superuser_rejected |  |
| test_reset_password_user_not_found |  |

## Next Step

Run `aws report inspect --change 20260615-role-mgmt` to analyse failures.
