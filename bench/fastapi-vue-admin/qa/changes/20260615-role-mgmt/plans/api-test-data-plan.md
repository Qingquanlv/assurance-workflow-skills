# API Test Data Plan — Role Management (`20260615-role-mgmt`)

## Scope

Cases requiring data preparation: **9 of 11** (all except TC-ROLE-001 and TC-ROLE-004).

| Case ID | Needs Data |
|---|---|
| TC-ROLE-001 | ❌ relies on default admin role only |
| TC-ROLE-002 | ✅ create role `qa-role-search` |
| TC-ROLE-003 | ✅ create role `qa-role-detail` and capture id |
| TC-ROLE-004 | ❌ negative path with literal id `999999` |
| TC-ROLE-005 | ✅ ensure no row with name `qa-role-create-001` exists pre-test |
| TC-ROLE-006 | ✅ pre-seed role `qa-role-dup` to trigger duplicate path |
| TC-ROLE-007 | ✅ create role `qa-role-update` and capture id |
| TC-ROLE-008 | ✅ create role and capture id (deterministic name from `seeded_role` fixture) |
| TC-ROLE-009 | ✅ create role + bind menu_id=1 + api `(GET, /api/v1/dept/list)` (via `/role/authorized` POST) |
| TC-ROLE-010 | ✅ create role + initial bind to menu_id=6 |
| TC-ROLE-011 | ✅ create role + initial bind to api `(GET, /api/v1/dept/list)` |

## Required Data

| Entity | State | Capability |
|---|---|---|
| Default admin role | exists pre-test | `init_app` seeded — confirmed via Phase 3.5 fact baseline |
| Default seeded menu (id=1, `系统管理`) | exists pre-test | `init_app` seeded |
| Seeded apis (`GET /api/v1/dept/list`, `POST /api/v1/dept/create`) | exists pre-test | `refresh_api()` route scan; confirmed stable by `(method, path)` tuple |
| `qa-role-search` role | created in test | `create_role` helper + `safe_delete_role` cleanup |
| `qa-role-detail` role | created in test, id captured | `create_role` + `find_role_id_by_name` + cleanup |
| `qa-role-create-001` row | absent before test, asserted to exist after | `safe_delete_role` precondition + ORM read-back |
| `qa-role-dup` role | pre-seeded once, asserted unique | `create_role` + `safe_delete_role` cleanup |
| `qa-role-update` role | created in test, id captured | `create_role` helper |
| `qa_role_<hex>` role for binding cases | created via `seeded_role` fixture | `seeded_role` fixture (function-scoped, auto-cleanup) |

## Preconditions

(verbatim from `case.yaml:preconditions`)

- 后端服务已启动并可访问（统一前置）
- 数据库存在默认 admin 角色 (init_app 阶段写入)
- 管理员已通过登录获得有效访问凭证 → satisfied by session `admin_token` fixture
- 数据库存在至少 1 个 menu 与 1 个 api（init_app 阶段已写入；fact baseline 阶段确认其稳定 ID/path/method）
- 数据库中存在两个不同 menu：`menu_A_id=6`, `menu_B_id=7`（fact baseline 阶段确认稳定 ID）
- 数据库中存在两个不同 api：`api_A=(GET, /api/v1/dept/list)`, `api_B=(POST, /api/v1/dept/create)`
- 数据库中不存在 ID = 999999 的角色（TC-ROLE-004）

## Capability Mapping

| Need | Capability | Source | Status |
|---|---|---|---|
| Authenticated httpx client | `api_client` fixture | `tests/api/conftest.py:35-43` | ✅ found |
| Admin token | `admin_token` fixture | `tests/api/conftest.py:30-33` | ✅ found |
| Single role with cleanup | `seeded_role` fixture | `tests/api/conftest.py:62-72` | ✅ found |
| Two distinct roles with cleanup | `seeded_two_roles` fixture | `tests/api/conftest.py:75-91` | ✅ found (not strictly needed for these cases — kept as fallback) |
| Create role helper | `create_role` | `tests/api/helpers/role_api.py` | ✅ found |
| Find role id by name | `find_role_id_by_name` | `tests/api/helpers/role_api.py` | ✅ found |
| Idempotent role delete | `safe_delete_role` | `tests/api/helpers/role_api.py` | ✅ found |
| Update role helper | `update_role` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add (data-knowledge.yaml claims it but disk lacks it) |
| Get role detail helper | `get_role_detail` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add |
| List roles helper | `list_roles` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add |
| Delete role helper | `delete_role` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add |
| Get role authorized helper | `get_role_authorized` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add |
| Update role authorized helper | `update_role_authorized` | `tests/api/helpers/role_api.py` | ⚠️ **missing** — codegen must add |
| ORM access for assertions | `app.models.admin.Role` (via `tortoise.contrib.test` or async db init) | `tortoise.connections` | ⚠️ **needs review** — see Setup Strategy step 5 |

## Setup Strategy

Ordered execution flow per case:

1. **Session start (autouse)**: acquire admin token via `login_admin`, build `api_client` with `token` header.
2. **Per-test pre-clean** (function-scoped): for cases with deterministic role names, call `safe_delete_role` by name first to wipe any leftover rows from prior aborted runs.
3. **Per-test create**: invoke `create_role` (HTTP 200 expected). For binding cases (009/010/011), follow with `update_role_authorized` to seed initial bindings.
4. **Per-test capture id**: call `find_role_id_by_name` to resolve `role_id` for downstream calls.
5. **ORM access for assertions**:
   - **Decision**: instead of activating Tortoise ORM in tests (would require `Tortoise.init` + same DB connection as the running backend, which is fragile), **assert through HTTP**: re-call `GET /api/v1/role/list?role_name=...` or `GET /api/v1/role/get?role_id=...` to confirm persistence. This is what `tests/api/test_users_api.py` already does (e.g. `test_create_user_with_role_success` at line 137 uses `/api/v1/user/list` for read-back).
   - This translates `case.yaml` "ORM 查询" assertions into HTTP read-back assertions. **Functionally equivalent** because the controller path is the only DB writer in the system under test.
6. **Per-test action**: execute the case's primary HTTP request and capture response.
7. **Per-test assertions**: per-case mapping in `api-plan.md`.
8. **Per-test cleanup** (function-scoped, finally block): `safe_delete_role` by id.

## Runtime Verify Strategy

Pre-call (where applicable):

- TC-ROLE-005: assert `find_role_id_by_name(api_client, "qa-role-create-001") is None` before POST.
- TC-ROLE-006: after pre-seed POST, assert pre-seed succeeded (`HTTP 200`, `code 200`) before issuing the duplicate POST.
- TC-ROLE-009/010/011: after seed binding POST, optionally assert via GET that initial state is what we expect, then perform the rewrite POST.

Post-call (where applicable):

- TC-ROLE-005: GET back via `find_role_id_by_name` and confirm row exists with `desc == "QA 测试角色"`.
- TC-ROLE-007: GET back via list/get with `role_name=qa-role-update` and confirm `desc == "updated-by-qa"`.
- TC-ROLE-008: GET via `/role/get` and assert HTTP 404.
- TC-ROLE-010/011: GET via `/role/authorized` and assert membership flips correctly.

## Cleanup Strategy

Per-test (function fixture finally block):

```python
finally:
    if role_id is not None:
        safe_delete_role(api_client, role_id)
```

Idempotent: `safe_delete_role` swallows 404 per data-knowledge.yaml:166-169.

For TC-ROLE-006, two cleanup operations are needed: delete pre-seeded role and (idempotently) any duplicate that may have leaked.

For TC-ROLE-009/010/011, deleting the role automatically clears its m2m binding rows (Tortoise cascade); no separate menu/api cleanup needed.

**Out-of-band session sweep**: not currently in conftest. Recommended addition (deferred to codegen) — autouse session fixture mirroring `_qa_test_menu_oob_cleanup`:

```python
@pytest.fixture(scope="session", autouse=True)
def _qa_test_role_oob_cleanup(...):
    yield
    # walk /api/v1/role/list, delete rows whose name starts with "qa-role-" or "qa_role_"
```

This is **NOT** a blocker — function-scoped cleanups already cover the happy path.

## No Data Required Cases

- TC-ROLE-001: read-only against default admin role.
- TC-ROLE-004: negative read against literal id `999999` (asserted absent in preconditions).

## Blockers / Assumptions

**Blockers**: None.

**Assumptions**:

1. Backend runs at `http://localhost:9999` (or honors `BASE_URL` / `API_BASE_URL` env). Codegen + run will fail fast if backend is unreachable.
2. Default admin role exists at session start (init_app guarantees this).
3. Menu id=1 (`系统管理`) and apis `(GET /api/v1/dept/list)` + `(POST /api/v1/dept/create)` exist at session start. Confirmed stable in `facts/fact-baseline.json`.
4. No concurrent QA run holds locks on the same `qa-role-*` rows. Safe for serial pytest execution.

## Review Checklist

- [ ] Confirm helper additions to `tests/api/helpers/role_api.py` are acceptable (vs. moving them to a new file).
- [ ] Confirm HTTP read-back is acceptable substitution for "ORM 查询" assertions in case.yaml.
- [ ] Confirm session out-of-band role sweep can be deferred to a follow-up (not part of this codegen).
- [ ] Confirm fact baseline placeholder values (menu id=1, dept apis) survive Phase 5 reviewer scrutiny.
- [ ] Confirm `qa-role-dup` and `qa-role-create-001` deterministic names won't collide across CI parallelism (current run is serial — confirm).
