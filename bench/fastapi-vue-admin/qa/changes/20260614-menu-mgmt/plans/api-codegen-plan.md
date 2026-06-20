# API Codegen Plan — Menu Management

## Target Files

| File | Purpose |
|---|---|
| `tests/api/test_menu_api.py` | All 8 menu API test functions (TC-MENU-001..008) |
| `tests/api/helpers/menu_api.py` | Menu API helper functions (CREATE in Phase 6.5) |
| `tests/api/conftest.py` (modification) | Add menu factory fixtures + session OOB cleanup (MODIFY in Phase 6.5) |

## Test Function Mapping

| Case ID | Test Function | Target File |
|---|---|---|
| TC-MENU-001 | `test_create_top_level_catalog_menu_succeeds` | `tests/api/test_menu_api.py` |
| TC-MENU-002 | `test_create_child_menu_under_existing_parent` | `tests/api/test_menu_api.py` |
| TC-MENU-003 | `test_list_returns_tree_with_siblings_ordered_asc` | `tests/api/test_menu_api.py` |
| TC-MENU-004 | `test_update_menu_basic_fields` | `tests/api/test_menu_api.py` |
| TC-MENU-005 | `test_update_parent_id_moves_menu_to_new_parent` | `tests/api/test_menu_api.py` |
| TC-MENU-006 | `test_delete_menu_with_children_returns_business_failure` | `tests/api/test_menu_api.py` |
| TC-MENU-007 | `test_delete_leaf_menu_succeeds` | `tests/api/test_menu_api.py` |
| TC-MENU-008 | `test_update_parent_id_to_self_or_descendant_is_rejected` | `tests/api/test_menu_api.py` (parametrized: sub-case A self, sub-case B descendant) |

## Fixture Mapping

| Fixture | Source | Required By |
|---|---|---|
| `api_client` | `tests/api/conftest.py:34-41` (existing) | ALL TC-MENU-* |
| `admin_token` | `tests/api/conftest.py:30-31` (existing) | implicit via api_client |
| `base_url` | `tests/api/conftest.py:25-27` (existing) | implicit |
| `top_level_menu_factory` | `tests/api/conftest.py` (NEW — Phase 6.5) | TC-MENU-002, 003, 004, 005, 006, 007, 008 |
| `child_menu_factory` | `tests/api/conftest.py` (NEW — Phase 6.5) | TC-MENU-002, 003, 005, 006, 008 |
| `menu_with_children_factory` | `tests/api/conftest.py` (NEW — Phase 6.5) | TC-MENU-006, 008 (convenience) |
| `menu_move_scenario_factory` | `tests/api/conftest.py` (NEW — Phase 6.5) | TC-MENU-005 |
| `_qa_test_menu_oob_cleanup` | `tests/api/conftest.py` (NEW — Phase 6.5) | session-scope safety net |

## Helper Mapping

All helpers live in `tests/api/helpers/menu_api.py` (NEW — Phase 6.5):

| Helper | Used By | Notes |
|---|---|---|
| `create_menu(client, *, name, path, ...)` | factories, TC-MENU-001 | Returns `httpx.Response`; raises nothing |
| `get_menu(client, menu_id)` | TC-MENU-004, TC-MENU-007, TC-MENU-008 | Returns httpx.Response; do not raise on 404 |
| `list_menus(client)` | TC-MENU-001, 002, 003, 005, 006, 008; OOB cleanup | Returns httpx.Response |
| `update_menu(client, body: dict)` | TC-MENU-004, 005, 008 | Body must already be round-tripped (caller's responsibility) |
| `delete_menu(client, menu_id)` | factories teardown, tests | Returns httpx.Response |
| `safe_delete_menu(client, menu_id)` | factories teardown, OOB cleanup | Swallows 404; on "child menus" error, recursively deletes children first |
| `find_menu_by_name(client, name)` | factories, TC-MENU-001..008 | Walks /list tree DFS, returns first match dict or None |
| `flatten_menu_tree(tree)` | OOB cleanup | DFS flattener with depth annotation |
| `read_then_update(client, menu_id, **patch)` | TC-MENU-004, 005, 008 | Helper that GETs the menu, applies patch, POSTs full body. Encapsulates the `component`-required round-trip. |

## Import Strategy

`tests/api/test_menu_api.py`:
```python
from __future__ import annotations
import time
import secrets

import httpx
import pytest

from tests.api.helpers.menu_api import (
    create_menu,
    get_menu,
    list_menus,
    update_menu,
    delete_menu,
    safe_delete_menu,
    find_menu_by_name,
    read_then_update,
)
```

`tests/api/conftest.py` additions:
```python
from tests.api.helpers.menu_api import (
    create_menu,
    safe_delete_menu,
    find_menu_by_name,
    flatten_menu_tree,
    list_menus,
)
```

`tests/api/helpers/menu_api.py`:
```python
from __future__ import annotations
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)
```

## Assertion Mapping

| Case ID | Assertions (codegen MUST implement all of these) |
|---|---|
| TC-MENU-001 | `create.status_code == 200`; `create.json()["code"] == 200`; "Created" in `create.json()["msg"]`; node found in /list with `parent_id==0`, `children==[]` |
| TC-MENU-002 | `create.status_code == 200`; `code == 200`; child found in parent's `children`; `child["parent_id"] == parent["id"]` |
| TC-MENU-003 | list 200; parent located; parent's children contains both seeds; `index(C2) < index(C1)`; each child's `parent_id == parent.id` |
| TC-MENU-004 | update 200/200; `msg` contains "Updated"; subsequent get returns new name/order/icon |
| TC-MENU-005 | update 200/200; subsequent /list: P1.children does NOT contain C; P2.children DOES contain C; C.parent_id == P2.id |
| TC-MENU-006 | delete 200; `code != 200`; `"Cannot delete a menu with child menus" in msg`; /list still has parent and child intact |
| TC-MENU-007 | delete 200/200; subsequent /get either status 404 OR `code != 200`; /list does not contain leaf name anymore |
| TC-MENU-008 sub-case A | (aspirational) update `code != 200`; (hard) /list returns within 5s; (hard) `get(P).data.parent_id != P.id` |
| TC-MENU-008 sub-case B | (aspirational) update `code != 200`; (hard) /list returns within 5s; (hard) `get(P).data.parent_id != C.id` |

For TC-MENU-008, the test function MUST use `httpx` per-call timeout `5.0` for the post-attempt /list call so a hung request raises `httpx.ReadTimeout` rather than blocking pytest indefinitely.

## Data Setup Mapping

| Case ID | Setup steps (codegen) |
|---|---|
| TC-MENU-001 | None — test calls `create_menu` directly |
| TC-MENU-002 | `parent = top_level_menu_factory()` |
| TC-MENU-003 | `parent, [c1, c2] = menu_with_children_factory(child_count=2, child_orders=[20, 10])` |
| TC-MENU-004 | `menu = top_level_menu_factory()` |
| TC-MENU-005 | `p1, p2, c = menu_move_scenario_factory()` |
| TC-MENU-006 | `parent, [child] = menu_with_children_factory(child_count=1)` |
| TC-MENU-007 | `leaf = top_level_menu_factory()` |
| TC-MENU-008 | `parent, [child] = menu_with_children_factory(child_count=1)` |

## Cleanup Mapping

| Case ID | Cleanup |
|---|---|
| TC-MENU-001 | Test function captures created menu's id, registers `safe_delete_menu` via `request.addfinalizer` (or use try/finally) |
| TC-MENU-002 → TC-MENU-008 | Factory fixture finalizer handles cleanup automatically |
| Session end | `_qa_test_menu_oob_cleanup` sweeps any leftover `qa-test-*` menus |

## Run Guidance (input to Phase 8 / aws-run)

- Command: `uv run pytest tests/api/test_menu_api.py -v`
- Required env: `BASE_URL` (or `API_BASE_URL`) set to running backend, default `http://localhost:9999`
- Backend MUST be running (start with `python run.py`) before invoking
- Expected outcome: 7 tests pass, 1 test (TC-MENU-008) likely fails — failure is classified as product issue per ANOMALY-002
- Pytest markers: optional `pytest.mark.regression` / `pytest.mark.smoke` if existing test suite uses them; codegen should add markers ONLY if existing test files do
- No special envvars beyond `BASE_URL`/`API_BASE_URL`
- Recommended: run with `-x` disabled (allow TC-MENU-008 to fail without halting other cases)

## Codegen Preconditions

Codegen (Phase 7A) MAY proceed only when ALL of the following are true:

| # | Condition | Status as of plan write |
|---|---|---|
| 1 | `qa/changes/20260614-menu-mgmt/review/api-plan-review.json` exists | **NOT YET** (Phase 5A pending) |
| 2 | `api-plan-review.json` `decision == "pass"` | NOT YET |
| 3 | `codegen_readiness in ["ready", "ready_with_warnings"]` | will be `not_ready` until Phase 6.5 helpers exist |
| 4 | `.aws/data-knowledge.yaml` exists | **PRESENT but stale** (lines 64, 126, 144 reference non-existent files; must be updated in Phase 6.5) |
| 5 | `tests/api/helpers/menu_api.py` exists with all helpers listed in Helper Mapping | **MISSING** (Phase 6.5 must create) |
| 6 | Menu factory fixtures exist in `tests/api/conftest.py` | **MISSING** (Phase 6.5 must create) |
| 7 | Backend (`python run.py`) running and reachable on configured BASE_URL | runtime check |

**Hard rule**: Conditions 5 and 6 dictate `Codegen Readiness = not_ready` at this plan stage, even though the plan content itself is complete. The reviewer should report `decision = pass` on plan quality but `codegen_readiness = not_ready` until Phase 6.5 closes the gap.
