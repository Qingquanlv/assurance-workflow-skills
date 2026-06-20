# Execution Summary: 20260612-user-mgmt

- **Batch ID:** `20260613-004711`
- **Archived at:** `qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/`

## Result

| Target | Status | Total | Passed | Failed | Skipped |
|--------|--------|------:|-------:|-------:|--------:|
| API    | passed | 15 | 15 | 0 | 0 |
| E2E    | passed | 6 | 6 | 0 | 0 |

## Commands

```bash
uv run pytest tests/api/test_users_api.py tests/api/helpers/user_api.py --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/pytest-report.xml
uv run pytest tests/e2e/test_users_e2e.py -v --headed --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/e2e-junit.xml
```

## Raw Reports

### API

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/api.log`
- JUnit XML: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/pytest-report.xml`
- JSON Report: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/pytest-report.json`

### E2E

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/raw/e2e.log`
- Playwright JSON: ``
- Playwright HTML Report: ``

## E2E Artifacts

- Traces: `qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/traces/`
- Screenshots: `qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/screenshots/`
- Videos: `qa/changes/20260612-user-mgmt/execution/runs/20260613-004711/videos/`

## Failed Cases

_None_

## Skipped Cases

_None_

## Unmapped Tests

List of tests that executed but could not be mapped to a Case ID.

| Test Name | Message |
|-----------|---------|
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
| test_create_user_via_modal_success[chromium] |  |
| test_create_user_duplicate_email_shows_error[chromium] |  |
| test_edit_user_updates_email[chromium] |  |
| test_delete_user_removes_row[chromium] |  |
| test_reset_password_normal_user[chromium] |  |
| test_assign_role_to_new_user[chromium] |  |

## Next Step

All tests passed. Proceed to `archive-for-qa`.
