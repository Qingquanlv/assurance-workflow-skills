# API Plan — Role Management (`20260615-role-mgmt`)

## Source

- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (15 cases total: 11 API, 3 E2E, 1 Fuzz)
- `qa/changes/20260615-role-mgmt/proposal.md`
- `qa/changes/20260615-role-mgmt/.qa.yaml`
- `qa/changes/20260615-role-mgmt/facts/fact-baseline.json` (Phase 3.5 placeholder resolution)
- `.aws/data-knowledge.yaml` (verified present)

## Scope

Selected (`type: API` + `automation.required: true` from `added`):

| Case ID | Title |
|---|---|
| TC-ROLE-001 | 角色列表 - 默认分页加载 |
| TC-ROLE-002 | 角色列表 - 按角色名模糊搜索 |
| TC-ROLE-003 | 角色详情 - 按 ID 查询正常返回 |
| TC-ROLE-004 | 角色详情 - 不存在的 ID 返回错误 |
| TC-ROLE-005 | 创建角色 - 唯一名称创建成功 |
| TC-ROLE-006 | 创建角色 - 名称重复返回业务错误 |
| TC-ROLE-007 | 更新角色 - 修改 desc 字段持久化 |
| TC-ROLE-008 | 删除角色 - 按 ID 删除成功 |
| TC-ROLE-009 | 查看角色权限 - 接口返回 menus 与 apis |
| TC-ROLE-010 | 更新角色权限 - 重写 menu_ids 旧绑定不再保留 |
| TC-ROLE-011 | 更新角色权限 - 重写 api_infos 旧绑定不再保留 |

Out of scope for this plan: TC-ROLE-100/101/102 (E2E — see `e2e-plan.md`), TC-ROLE-200 (Fuzz — see `fuzz-plan.md`).

`modified` and `removed` lists are empty.

## API Targets

| Case ID | Scenario | Method | Path | Expected |
|---|---|---|---|---|
| TC-ROLE-001 | List with default pagination | GET | `/api/v1/role/list` | HTTP 200; `code=200`; `data` array len ≥ 1 (admin role present); `page=1`, `page_size=10`, `total ≥ 1` |
| TC-ROLE-002 | List filter by role_name | GET | `/api/v1/role/list?role_name=qa-role-search` | HTTP 200; `code=200`; `data` contains exactly one record where `name == 'qa-role-search'` |
| TC-ROLE-003 | Get detail by id | GET | `/api/v1/role/get?role_id={id}` | HTTP 200; `code=200`; `data.id == role_id`; `data.name == 'qa-role-detail'` |
| TC-ROLE-004 | Get detail with non-existent id | GET | `/api/v1/role/get?role_id=999999` | HTTP 404; `code=404`; `msg` starts with `Object has not found` |
| TC-ROLE-005 | Create role with unique name | POST | `/api/v1/role/create` | HTTP 200; `code=200`; `msg=='Created Successfully'`; ORM lookup confirms row exists with `desc='QA 测试角色'` |
| TC-ROLE-006 | Create role with duplicate name | POST | `/api/v1/role/create` | HTTP 400; `code=400`; `msg` contains `already exists`; ORM lookup confirms exactly 1 row with that name |
| TC-ROLE-007 | Update role desc | POST | `/api/v1/role/update` | HTTP 200; `code=200`; `msg=='Updated Successfully'`; ORM lookup confirms `desc=='updated-by-qa'` |
| TC-ROLE-008 | Delete role by id | DELETE | `/api/v1/role/delete?role_id={id}` | HTTP 200; `code=200`; subsequent GET returns 404 |
| TC-ROLE-009 | Get authorized — menus + apis | GET | `/api/v1/role/authorized?id={id}` | HTTP 200; `code=200`; `data.menus` contains menu with `id == 1`; `data.apis` contains tuple `(GET, /api/v1/dept/list)` |
| TC-ROLE-010 | Rewrite menu_ids | POST | `/api/v1/role/authorized` | HTTP 200 on POST; subsequent GET returns `menus` containing `id=7` and not containing `id=6` |
| TC-ROLE-011 | Rewrite api_infos | POST | `/api/v1/role/authorized` | HTTP 200 on POST; subsequent GET returns `apis` containing `(POST, /api/v1/dept/create)` and not containing `(GET, /api/v1/dept/list)` |

> **Path notes**
> - All endpoints sit under FastAPI app prefix `/api` → v1 sub-router `/v1` → roles sub-router `/role`. Confirmed via `app/api/__init__.py:6` and `app/api/v1/__init__.py:17`.
> - `authorized` GET uses query param **`id`** (not `role_id`) per `data-knowledge.yaml:462`.
> - `delete` uses query param **`role_id`** per `data-knowledge.yaml:454`.

## Auth Strategy

All 11 API cases require admin authentication.

| Mechanism | Detail |
|---|---|
| Login endpoint | `POST /api/v1/base/access_token` |
| Body | `{"username": "admin", "password": "123456"}` |
| Header name | **`token`** (literal lowercase, **NOT** `Authorization: Bearer`) |
| Header value | `{jwt}` (raw JWT, no scheme prefix) |
| Source of truth | `app/core/dependency.py`, encoded in `data-knowledge.yaml:138-144` |

Reuse session-scoped `admin_token` + `api_client` fixtures from `tests/api/conftest.py:30-43`.

No Case requires unauthenticated or invalid-token clients (those are out of scope per case-design).

## Request Strategy

> ⚠️ This section feeds codegen only. It MUST NOT be written back into `case.yaml`.

| Case ID | HTTP Method | Path | Headers | Body / Params |
|---|---|---|---|---|
| TC-ROLE-001 | GET | `/api/v1/role/list` | `token: {jwt}` | none (rely on server defaults `page=1`, `page_size=10`) — **OR** explicit `?page=1&page_size=10` to assert echo |
| TC-ROLE-002 | GET | `/api/v1/role/list` | `token: {jwt}` | `?role_name=qa-role-search&page=1&page_size=10` |
| TC-ROLE-003 | GET | `/api/v1/role/get` | `token: {jwt}` | `?role_id={seeded_role_id}` |
| TC-ROLE-004 | GET | `/api/v1/role/get` | `token: {jwt}` | `?role_id=999999` |
| TC-ROLE-005 | POST | `/api/v1/role/create` | `token: {jwt}`, `Content-Type: application/json` | `{"name": "qa-role-create-001", "desc": "QA 测试角色"}` |
| TC-ROLE-006 | POST | `/api/v1/role/create` | `token: {jwt}`, `Content-Type: application/json` | `{"name": "qa-role-dup", "desc": "second"}` (after pre-seed of same name) |
| TC-ROLE-007 | POST | `/api/v1/role/update` | `token: {jwt}`, `Content-Type: application/json` | `{"id": role_id, "name": "qa-role-update", "desc": "updated-by-qa"}` |
| TC-ROLE-008 | DELETE | `/api/v1/role/delete` | `token: {jwt}` | `?role_id={seeded_role_id}` |
| TC-ROLE-009 | POST → GET | `/api/v1/role/authorized` (POST setup) then GET | `token: {jwt}`, `Content-Type: application/json` for POST | POST: `{"id": role_id, "menu_ids": [1], "api_infos": [{"path": "/api/v1/dept/list", "method": "GET"}]}`; GET: `?id={role_id}` |
| TC-ROLE-010 | POST → POST → GET | `/api/v1/role/authorized` × 3 | as above | seed POST `{"id": role_id, "menu_ids": [6], "api_infos": []}`; rewrite POST `{"id": role_id, "menu_ids": [7], "api_infos": []}`; readback GET `?id={role_id}` |
| TC-ROLE-011 | POST → POST → GET | `/api/v1/role/authorized` × 3 | as above | seed POST `{"id": role_id, "menu_ids": [], "api_infos": [{"path": "/api/v1/dept/list", "method": "GET"}]}`; rewrite POST `{"id": role_id, "menu_ids": [], "api_infos": [{"path": "/api/v1/dept/create", "method": "POST"}]}`; readback GET `?id={role_id}` |

## Assertion Strategy

| Case ID | Assertions (verbatim mapping to `case.yaml:assertions`) |
|---|---|
| TC-ROLE-001 | `response.status_code == 200`; `body["code"] == 200`; `len(body["data"]) >= 1`; `any(r["name"] == "admin" for r in body["data"])`; `body["page"] == 1`; `body["page_size"] == 10`; `body["total"] >= 1` |
| TC-ROLE-002 | `response.status_code == 200`; `body["code"] == 200`; `len(body["data"]) == 1`; `body["data"][0]["name"] == "qa-role-search"` |
| TC-ROLE-003 | `response.status_code == 200`; `body["code"] == 200`; `body["data"]["id"] == role_id`; `body["data"]["name"] == "qa-role-detail"` |
| TC-ROLE-004 | `response.status_code == 404`; `body["code"] == 404`; `body["msg"].startswith("Object has not found")` |
| TC-ROLE-005 | `response.status_code == 200`; `body["code"] == 200`; `body["msg"] == "Created Successfully"`; ORM `await Role.filter(name="qa-role-create-001").first()` is not None and `desc == "QA 测试角色"` |
| TC-ROLE-006 | `response.status_code == 400`; `body["code"] == 400`; `"already exists" in body["msg"].lower()`; ORM `await Role.filter(name="qa-role-dup").count() == 1` |
| TC-ROLE-007 | `response.status_code == 200`; `body["code"] == 200`; `body["msg"] == "Updated Successfully"`; ORM `(await Role.get(id=role_id)).desc == "updated-by-qa"` |
| TC-ROLE-008 | `response.status_code == 200`; `body["code"] == 200`; subsequent `GET /api/v1/role/get?role_id={id}` returns 404 |
| TC-ROLE-009 | `response.status_code == 200`; `body["code"] == 200`; `any(m["id"] == 1 for m in body["data"]["menus"])`; `any(a["path"] == "/api/v1/dept/list" and a["method"] == "GET" for a in body["data"]["apis"])` |
| TC-ROLE-010 | seed/rewrite POSTs both return `code == 200`; final GET `body["data"]["menus"]` contains `id == 7`; final GET `body["data"]["menus"]` does NOT contain `id == 6` |
| TC-ROLE-011 | seed/rewrite POSTs both return `code == 200`; final GET `body["data"]["apis"]` contains `(path="/api/v1/dept/create", method="POST")`; final GET `body["data"]["apis"]` does NOT contain `(path="/api/v1/dept/list", method="GET")` |

## Mock Strategy

**None.** All 11 cases run against the live FastAPI app with real Tortoise ORM and SQLite (or whatever DB the running backend is configured for). Test data and cleanup are real DB writes wrapped in fixture lifecycle.

Rationale:
- Backend is in-process (`run.py`), no third-party HTTP dependencies in role flow.
- The product behaviour under test (`update_roles` clear+add) is precisely what we want to exercise — mocking would defeat the purpose.
- Existing `tests/api/test_users_api.py` follows the same no-mock pattern.

## Cleanup Strategy

Per-case (function-scoped fixtures handle cleanup automatically):

- **TC-ROLE-001**: read-only on default admin role, no cleanup needed.
- **TC-ROLE-002, 003, 005, 006, 007, 008, 009, 010, 011**: every test that creates a role uses `seeded_role` fixture (or inline create) and cleans via `safe_delete_role` from `tests/api/helpers/role_api.py`.
- **TC-ROLE-004**: read-only with non-existent id, no cleanup needed.

Out-of-band session-scoped sweep already exists for menus (`_qa_test_menu_oob_cleanup`). For roles, **propose adding a parallel session sweep** that deletes any leftover role whose name starts with `qa-role-` or `qa_role_`. See **Needs Review** below.

## Output File Candidates

Single file: `tests/api/test_role_api.py` (mirrors `tests/api/test_users_api.py` and `tests/api/test_menu_api.py` layout).

Helper additions in `tests/api/helpers/role_api.py` (extend existing module, do not replace):

- `update_role(client, role_id, name, desc) -> httpx.Response`
- `get_role_detail(client, role_id) -> httpx.Response`
- `list_roles(client, **params) -> httpx.Response`
- `delete_role(client, role_id) -> httpx.Response`
- `get_role_authorized(client, role_id) -> httpx.Response`
- `update_role_authorized(client, role_id, menu_ids, api_infos) -> httpx.Response`

Fixture additions in `tests/api/conftest.py` (extend, do not replace):

- None required for API. The existing `seeded_role` fixture covers TC-ROLE-002/003/007/008/009/010/011. TC-ROLE-005 needs an inline create with a deterministic name. TC-ROLE-006 needs an inline pre-seed of the duplicate name. TC-ROLE-001/004 are read-only.

## Needs Review

| ID | Item | Severity | Resolution Path |
|---|---|---|---|
| NR-API-01 | `data-knowledge.yaml` claims helpers `update_role`, `get_role_detail`, `list_roles`, `delete_role`, `get_role_authorized`, `update_role_authorized`, `list_menus_for_authorize`, `list_apis_for_authorize`, `flatten_menu_tree` exist in `tests/api/helpers/role_api.py`, but disk only contains `create_role`, `find_role_id_by_name`, `safe_delete_role`. | medium | Codegen phase MUST add the missing helpers; alternatively the data-knowledge.yaml needs a follow-up correction. Plan readiness still `ready_with_warnings`. |
| NR-API-02 | TC-ROLE-006 expected error message: case asserts `detail` contains `already exists`. Backend returns lowercase message via `Fail()` wrapper. Confirm by reading backend response body when test runs. | low | Use case-insensitive substring `"already exists" in body["msg"].lower()`. |
| NR-API-03 | TC-ROLE-007 update payload: `RoleUpdate` requires `id`, `name`, `desc` (extends `RoleCreate`). Schema does not currently enforce uniqueness on update path (no `is_exist` call) — out of scope for this case but document so reviewer confirms expectation `Updated Successfully` is the only success signal. | low | Plan only asserts success message + ORM read-back; no uniqueness assertion needed. |
| NR-API-04 | Session-scoped role sweep (mirroring `_qa_test_menu_oob_cleanup`) is not currently in conftest. Test reliability is fine for one-shot run, but accumulating leftover `qa-role-*` rows across local runs would bloat the DB. | low | Either add a parallel autouse session fixture, or document that codegen output uses fully-deterministic role names (token_hex suffix) so leftovers are negligible. Recommend the latter for plan readiness. |
| NR-API-05 | TC-ROLE-009 binding setup: the assertion expects exact `id == 1` for menu and `(GET, /api/v1/dept/list)` for api. Both depend on init_app deterministic insert order (menu) and route discovery stability (api). Fact baseline confirms low-risk warnings; if route discovery order ever drifts, test would fail until baseline updated. | low | Bind to `id == 1` because it is the most stable menu (first in init_app insert sequence). For api, query by `(path, method)` tuple, not row ID. Plan readiness unaffected. |

## Blockers

**None.** All endpoints, methods, paths, headers, payload schemas, and fact baseline placeholders are concretely resolved. No `TBD` entries.

---

**Plan Readiness preview**: `ready_with_warnings` (5 non-blocking Needs Review).
**Codegen Readiness preview**: `ready_with_warnings` (`.aws/data-knowledge.yaml` exists; selected cases have all data capabilities resolved; helper gap NR-API-01 is the only material warning and is codegen-resolvable inline).
