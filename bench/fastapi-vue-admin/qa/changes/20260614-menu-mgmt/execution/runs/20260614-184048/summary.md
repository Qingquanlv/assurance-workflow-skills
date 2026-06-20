# Execution Summary: 20260614-menu-mgmt

- **Batch ID:** `20260614-184048`
- **Archived at:** `qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/`

## Result

| Target | Status | Total | Passed | Failed | Skipped |
|--------|--------|------:|-------:|-------:|--------:|
| API    | failed | 9 | 7 | 2 | 0 |
| E2E    | passed | 2 | 2 | 0 | 0 |

## Commands

```bash
uv run pytest tests/api/test_menu_api.py tests/api/helpers/menu_api.py --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/pytest-report.xml
uv run pytest tests/e2e/test_menu_e2e.py -v --headed --junitxml=/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/e2e-junit.xml
```

## Raw Reports

### API

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/api.log`
- JUnit XML: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/pytest-report.xml`
- JSON Report: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/pytest-report.json`

### E2E

- Log: `/Users/lvqingquan/pycharmProject/vue-fastapi-admin/qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/raw/e2e.log`
- Playwright JSON: ``
- Playwright HTML Report: ``

## E2E Artifacts

- Traces: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/traces/`
- Screenshots: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/screenshots/`
- Videos: `qa/changes/20260614-menu-mgmt/execution/runs/20260614-184048/videos/`

## Failed Cases

| Case ID | Target | Test | Message | Evidence |
|---------|--------|------|---------|----------|
| TC-MENU-008 | API | test_update_parent_id_to_self_or_descendant_is_rejected[self] | api_client = <httpx.Client object at 0x102a915d0> base_url = 'http://localhos... | — |
| TC-MENU-008 | API | test_update_parent_id_to_self_or_descendant_is_rejected[descendant] | api_client = <httpx.Client object at 0x102a915d0> base_url = 'http://localhos... | — |

## Skipped Cases

_None_

## Unmapped Tests

List of tests that executed but could not be mapped to a Case ID.

_None_

## Next Step

Run `aws report inspect --change 20260614-menu-mgmt` to analyse failures.
