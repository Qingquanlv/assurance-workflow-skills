# Execution Summary: 20260612-user-mgmt

- **Batch ID:** `20260613-001752`
- **Archived at:** `qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/`

## Result

| Target | Status | Total | Passed | Failed | Skipped |
|--------|--------|------:|-------:|-------:|--------:|
| API    | failed | 15 | 6 | 9 | 0 |
| E2E    | failed | 6 | 0 | 6 | 0 |

## Commands

```bash
uv run pytest tests/api/test_users_api.py tests/api/helpers/user_api.py --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/pytest-report.xml
uv run pytest tests/e2e/test_users_e2e.py -v --headed --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/e2e-junit.xml
```

## Raw Reports

### API

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/api.log`
- JUnit XML: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/pytest-report.xml`
- JSON Report: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/pytest-report.json`

### E2E

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/raw/e2e.log`
- Playwright JSON: ``
- Playwright HTML Report: ``

## E2E Artifacts

- Traces: `qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/traces/`
- Screenshots: `qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/screenshots/`
- Videos: `qa/changes/20260612-user-mgmt/execution/runs/20260613-001752/videos/`

## Failed Cases

_None_

## Skipped Cases

_None_

## Unmapped Tests

List of tests that executed but could not be mapped to a Case ID.

| Test Name | Message |
|-----------|---------|
| test_list_users_default_pagination |  |
| test_list_users_filter_by_username | api_client = <httpx.Client object at 0x109f22590> non_admin_user_factory = <f... |
| test_list_users_unauthenticated_rejected | unauthenticated_client = <httpx.Client object at 0x10a0f9590>      @pytest.ma... |
| test_get_user_detail_success | api_client = <httpx.Client object at 0x109f22590> non_admin_user_factory = <f... |
| test_get_user_detail_not_found |  |
| test_create_user_with_role_success | api_client = <httpx.Client object at 0x109f22590> seeded_role = (75, 'qa_role... |
| test_create_user_duplicate_email_rejected | api_client = <httpx.Client object at 0x109f22590> non_admin_user_factory = <f... |
| test_create_user_missing_email_validation_error |  |
| test_update_user_rewrites_roles | api_client = <httpx.Client object at 0x109f22590> seeded_two_roles = ((76, 'q... |
| test_update_user_not_found | api_client = <httpx.Client object at 0x109f22590>      @pytest.mark.api     d... |
| test_delete_user_success | api_client = <httpx.Client object at 0x109f22590>      @pytest.mark.api     d... |
| test_delete_user_not_found |  |
| test_reset_password_normal_user_success | api_client = <httpx.Client object at 0x109f22590> base_url = 'http://localhos... |
| test_reset_password_superuser_rejected |  |
| test_reset_password_user_not_found |  |
| test_create_user_via_modal_success[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |
| test_create_user_duplicate_email_shows_error[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |
| test_edit_user_updates_email[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |
| test_delete_user_removes_row[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |
| test_reset_password_normal_user[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |
| test_assign_role_to_new_user[chromium] | page = <Page url='http://localhost:3100/workbench'> frontend_base_url = 'http... |

## Next Step

Run `aws report inspect --change 20260612-user-mgmt` to analyse failures.
