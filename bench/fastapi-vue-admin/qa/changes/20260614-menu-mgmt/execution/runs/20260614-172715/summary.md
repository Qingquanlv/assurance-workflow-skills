# Execution Summary: 20260614-menu-mgmt

- **Batch ID:** `20260614-172715`
- **Archived at:** `qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/`

## Result

| Target | Status | Total | Passed | Failed | Skipped |
|--------|--------|------:|-------:|-------:|--------:|
| API    | failed | 9 | 7 | 2 | 0 |
| E2E    | passed | 2 | 2 | 0 | 0 |

## Commands

```bash
uv run pytest tests/api/test_menu_api.py tests/api/helpers/menu_api.py --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/pytest-report.xml
uv run pytest tests/e2e/test_menu_e2e.py -v --headed --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/e2e-junit.xml
```

## Raw Reports

### API

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/api.log`
- JUnit XML: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/pytest-report.xml`
- JSON Report: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/pytest-report.json`

### E2E

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/raw/e2e.log`
- Playwright JSON: ``
- Playwright HTML Report: ``

## E2E Artifacts

- Traces: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/traces/`
- Screenshots: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/screenshots/`
- Videos: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-172715/videos/`

## Failed Cases

_None_

## Skipped Cases

_None_

## Unmapped Tests

List of tests that executed but could not be mapped to a Case ID.

| Test Name | Message |
|-----------|---------|
| test_create_top_level_catalog_menu_succeeds |  |
| test_create_child_menu_under_existing_parent |  |
| test_list_returns_tree_with_siblings_ordered_asc |  |
| test_update_menu_basic_fields |  |
| test_update_parent_id_moves_menu_to_new_parent |  |
| test_delete_menu_with_children_returns_business_failure |  |
| test_delete_leaf_menu_succeeds |  |
| test_update_parent_id_to_self_or_descendant_is_rejected[self] | api_client = <httpx.Client object at 0x10bd93310> base_url = 'http://localhos... |
| test_update_parent_id_to_self_or_descendant_is_rejected[descendant] | api_client = <httpx.Client object at 0x10bd93310> base_url = 'http://localhos... |
| test_create_top_level_catalog_via_modal[chromium] |  |
| test_add_child_menu_under_catalog[chromium] |  |

## Next Step

Run `aws report inspect --change 20260614-menu-mgmt` to analyse failures.
