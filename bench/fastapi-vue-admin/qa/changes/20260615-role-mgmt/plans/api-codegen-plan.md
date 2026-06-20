# API Codegen Plan — Role Management (`20260615-role-mgmt`)

> **Codegen contract.** This file fully specifies what `aws-api-codegen` will write. No ambiguity. No TBD.

## Source

- `qa/changes/20260615-role-mgmt/plans/api-plan.md`
- `qa/changes/20260615-role-mgmt/plans/api-test-data-plan.md`
- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (POST-FIX, decision=pass)
- `qa/changes/20260615-role-mgmt/facts/fact-baseline.json`
- `.aws/data-knowledge.yaml`

## Scope

11 API cases (`type: API` from `case.yaml`):

TC-ROLE-001..011 (full list in `api-plan.md` → API Targets table).

## File Layout

| File | Action | Path |
|---|---|---|
| Test module | **CREATE** | `tests/api/test_role_api.py` |
| Helper module | **EXTEND** (do not replace) | `tests/api/helpers/role_api.py` |
| Conftest | **NO CHANGE** | `tests/api/conftest.py` (existing `seeded_role` + `api_client` are sufficient) |

## Helpers to Add

Append to `tests/api/helpers/role_api.py`. Match style of existing 3 helpers (snake_case, raw `httpx.Response` return, no business assertions).

| Function | Signature | Endpoint |
|---|---|---|
| `update_role` | `(client: httpx.Client, role_id: int, name: str, desc: str = "") -> httpx.Response` | POST `/api/v1/role/update` |
| `delete_role` | `(client: httpx.Client, role_id: int) -> httpx.Response` | DELETE `/api/v1/role/delete?role_id={id}` |
| `get_role_detail` | `(client: httpx.Client, role_id: int) -> httpx.Response` | GET `/api/v1/role/get?role_id={id}` |
| `list_roles` | `(client: httpx.Client, **params) -> httpx.Response` | GET `/api/v1/role/list` |
| `get_role_authorized` | `(client: httpx.Client, role_id: int) -> httpx.Response` | GET `/api/v1/role/authorized?id={id}` |
| `update_role_authorized` | `(client: httpx.Client, role_id: int, menu_ids: list[int], api_infos: list[dict]) -> httpx.Response` | POST `/api/v1/role/authorized` body `{"id", "menu_ids", "api_infos"}` |

> ⚠️ Keep `find_role_id_by_name` and `safe_delete_role` untouched. Do not introduce business assertions inside helpers — assertions belong in the test module.

## Test Module Structure

`tests/api/test_role_api.py` follows the convention of `tests/api/test_users_api.py` exactly:

- Module docstring stating purpose + change id.
- Imports: `pytest`, `httpx`, `secrets` (or `uuid` — pick `secrets.token_hex(4)` to match `seeded_role` style); helpers from `tests.api.helpers.role_api` and `tests.api.helpers.menu_api` (only if needed for fact-baseline read-back; actually not needed because we use static menu/api ids); from `tests.api.helpers` import `auth` only if needed (it isn't — `api_client` fixture already authenticates).
- Module-level marker: `pytestmark = pytest.mark.api`.
- One test function per case ID, named `test_<case_id_lowercase_underscored>`. Example: `test_tc_role_001_list_default_pagination`.
- Each test must include the **case id in the docstring** for traceability: `"""TC-ROLE-001: 角色列表 - 默认分页加载"""`.

## Test Function Template

Pattern for read-only cases:

```python
def test_tc_role_001_list_default_pagination(api_client: httpx.Client) -> None:
    """TC-ROLE-001: 角色列表 - 默认分页加载."""
    response = list_roles(api_client, page=1, page_size=10)

    assert response.status_code == 200
    body = response.json()
    assert body["code"] == 200
    assert isinstance(body["data"], list)
    assert len(body["data"]) >= 1
    assert any(r["name"] == "admin" for r in body["data"])
    assert body["page"] == 1
    assert body["page_size"] == 10
    assert body["total"] >= 1
```

Pattern for cases requiring create + cleanup:

```python
def test_tc_role_002_list_filter_by_name(api_client: httpx.Client) -> None:
    """TC-ROLE-002: 角色列表 - 按角色名模糊搜索."""
    role_name = "qa-role-search"
    safe_delete_role_by_name(api_client, role_name)  # idempotent precondition
    role_id: int | None = None
    try:
        create_response = create_role(api_client, name=role_name, desc="QA 搜索测试")
        assert create_response.status_code == 200
        role_id = find_role_id_by_name(api_client, role_name)
        assert role_id is not None

        response = list_roles(api_client, role_name=role_name, page=1, page_size=10)
        assert response.status_code == 200
        body = response.json()
        assert body["code"] == 200
        assert len(body["data"]) == 1
        assert body["data"][0]["name"] == role_name
    finally:
        if role_id is not None:
            safe_delete_role(api_client, role_id)
```

> `safe_delete_role_by_name` is a **NEW** thin wrapper: lookup id then `safe_delete_role`. Add to `helpers/role_api.py` to keep the precondition idiomatic.

Pattern for cases needing duplicate pre-seed (TC-ROLE-006):

```python
def test_tc_role_006_create_duplicate_rejected(api_client: httpx.Client) -> None:
    """TC-ROLE-006: 创建角色 - 名称重复返回业务错误."""
    role_name = "qa-role-dup"
    safe_delete_role_by_name(api_client, role_name)
    role_id: int | None = None
    try:
        first = create_role(api_client, name=role_name, desc="first")
        assert first.status_code == 200
        assert first.json()["code"] == 200
        role_id = find_role_id_by_name(api_client, role_name)
        assert role_id is not None

        second = create_role(api_client, name=role_name, desc="second")
        assert second.status_code == 400
        body = second.json()
        assert body["code"] == 400
        assert "already exists" in body["msg"].lower()

        # confirm only one row exists with this name
        listing = list_roles(api_client, role_name=role_name, page=1, page_size=10)
        assert listing.status_code == 200
        assert listing.json()["total"] == 1
    finally:
        if role_id is not None:
            safe_delete_role(api_client, role_id)
```

Pattern for binding rewrite cases (TC-ROLE-010, TC-ROLE-011):

```python
def test_tc_role_010_rewrite_menu_ids(api_client: httpx.Client, seeded_role: int) -> None:
    """TC-ROLE-010: 更新角色权限 - 重写 menu_ids 旧绑定不再保留."""
    role_id = seeded_role

    # seed
    seed = update_role_authorized(api_client, role_id, menu_ids=[6], api_infos=[])
    assert seed.status_code == 200
    assert seed.json()["code"] == 200

    # rewrite
    rewrite = update_role_authorized(api_client, role_id, menu_ids=[7], api_infos=[])
    assert rewrite.status_code == 200
    assert rewrite.json()["code"] == 200

    # readback
    readback = get_role_authorized(api_client, role_id)
    assert readback.status_code == 200
    body = readback.json()
    assert body["code"] == 200
    menu_ids = {m["id"] for m in body["data"]["menus"]}
    assert 7 in menu_ids
    assert 6 not in menu_ids
```

## Fixtures Used

| Fixture | Source | Purpose |
|---|---|---|
| `api_client` | `tests/api/conftest.py` (existing) | session-scoped authenticated httpx client |
| `seeded_role` | `tests/api/conftest.py` (existing) | function-scoped role with auto-cleanup; used for TC-ROLE-008/010/011 (and optionally 003/007/009) |

No new fixtures.

## Markers

- All tests get `pytestmark = pytest.mark.api` at module level.
- No skip/xfail markers anywhere.

## Imports (full list, in order)

```python
from __future__ import annotations

import pytest
import httpx

from tests.api.helpers.role_api import (
    create_role,
    delete_role,
    find_role_id_by_name,
    get_role_authorized,
    get_role_detail,
    list_roles,
    safe_delete_role,
    safe_delete_role_by_name,  # new helper
    update_role,
    update_role_authorized,
)
```

## Test Inventory (final)

| Test Function Name | Case |
|---|---|
| `test_tc_role_001_list_default_pagination` | TC-ROLE-001 |
| `test_tc_role_002_list_filter_by_name` | TC-ROLE-002 |
| `test_tc_role_003_get_detail_by_id` | TC-ROLE-003 |
| `test_tc_role_004_get_detail_not_found` | TC-ROLE-004 |
| `test_tc_role_005_create_unique_name` | TC-ROLE-005 |
| `test_tc_role_006_create_duplicate_rejected` | TC-ROLE-006 |
| `test_tc_role_007_update_desc_persisted` | TC-ROLE-007 |
| `test_tc_role_008_delete_by_id` | TC-ROLE-008 |
| `test_tc_role_009_get_authorized_returns_bindings` | TC-ROLE-009 |
| `test_tc_role_010_rewrite_menu_ids` | TC-ROLE-010 |
| `test_tc_role_011_rewrite_api_infos` | TC-ROLE-011 |

## Coverage Strategy

Run with `pytest --cov=app.api.v1.roles --cov=app.controllers.role` to satisfy the M5 coverage gate. The aws-run skill enforces coverage capture when `pytest-cov` is available; codegen does not need to add the flag — it lives in the run invocation.

## Out of Scope for This Codegen

- E2E tests (TC-ROLE-100/101/102) → see `e2e-codegen-plan.md`.
- Fuzz tests (TC-ROLE-200) → see `fuzz-codegen-plan.md`.
- Modifications to `tests/api/conftest.py` beyond what already exists.
- Modifications to backend source (`app/`) — strictly forbidden in QA codegen.

## Codegen Acceptance Checklist

After codegen completes, before exiting Phase 7A:

- [ ] `tests/api/test_role_api.py` exists and contains exactly 11 test functions.
- [ ] Each test function has a docstring beginning with `TC-ROLE-XXX:`.
- [ ] Module marker `pytestmark = pytest.mark.api` is present.
- [ ] No `pytest.mark.skip` / `pytest.mark.xfail` anywhere in the file.
- [ ] All 6 new helpers + `safe_delete_role_by_name` are appended to `tests/api/helpers/role_api.py`.
- [ ] `python -m py_compile tests/api/test_role_api.py tests/api/helpers/role_api.py` exits 0.
- [ ] `python -m pytest tests/api/test_role_api.py --collect-only -q` lists exactly 11 tests.
- [ ] No imports from `app/` in the test file (test should be black-box; the only allowed cross-import is `tests.api.helpers.*`).

## Codegen Hard Gates (must all be true at start of Phase 7A)

- `phases.api_plan_review.decision == pass` (Phase 5A output)
- `phases.api_plan_review.codegen_readiness in [ready, ready_with_warnings]`
- `blockers` empty
- `.aws/data-knowledge.yaml` exists ✅ (verified in Phase 0)

If any gate fails, do NOT begin codegen. `force_continue=false` MUST NOT bypass.
