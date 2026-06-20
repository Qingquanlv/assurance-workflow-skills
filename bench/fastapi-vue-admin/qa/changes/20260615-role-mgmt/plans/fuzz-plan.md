# Fuzz Plan — Role Management (`20260615-role-mgmt`)

## Source

- `qa/changes/20260615-role-mgmt/cases/roles/case.yaml` (TC-ROLE-200)
- `qa/changes/20260615-role-mgmt/facts/fact-baseline.json`
- Backend: `app/api/v1/roles/roles.py` (7 endpoints)
- OpenAPI schema source: `http://localhost:9999/openapi.json` (confirmed via `app/__init__.py`)

## Scope

1 Fuzz case:

| Case ID | Title | Priority |
|---|---|---|
| TC-ROLE-200 | 角色接口 schema-based 健壮性扫描 | P1 |

## Framework

- **schemathesis** (Python). Schema-based property test generation against live FastAPI OpenAPI schema.
- Driver: pytest (`tests/fuzz/test_roles_fuzz.py`).
- Execution model: pytest collects schemathesis-generated tests via `@schema.parametrize()` and runs against live backend.

## Target Endpoints (7)

Filtered from OpenAPI schema by path prefix `/api/v1/role`:

| ID | Method | Path |
|---|---|---|
| role-list | GET | `/api/v1/role/list` |
| role-get | GET | `/api/v1/role/get` |
| role-create | POST | `/api/v1/role/create` |
| role-update | POST | `/api/v1/role/update` |
| role-delete | DELETE | `/api/v1/role/delete` |
| role-authorized-get | GET | `/api/v1/role/authorized` |
| role-authorized-post | POST | `/api/v1/role/authorized` |

## Schema Loading

```python
import schemathesis

OPENAPI_URL = "http://localhost:9999/openapi.json"
schema = schemathesis.from_uri(OPENAPI_URL)
```

Endpoint filter via `schema.get_all_operations()` then by path prefix, OR via `@schema.parametrize(endpoint=r"^/api/v1/role")` regex selector.

## Auth Strategy

Schemathesis must inject the admin `token` header on every generated request.

```python
@pytest.fixture(scope="session")
def fuzz_admin_token() -> str:
    return get_admin_token()  # reuses tests/e2e/scripts/user_data_setup.get_admin_token


# Per-test hook to inject the token header
@schema.hooks.register("before_call")
def add_auth_header(context, case):
    case.headers = case.headers or {}
    case.headers["token"] = AUTH_TOKEN  # module-level cached token
```

Cache the token at module load time (via `get_admin_token()`) — schemathesis fixture wiring is awkward across versions, so module-level cache is the most portable.

## Execution Budget

| Parameter | Value | Rationale |
|---|---|---|
| `--hypothesis-max-examples` | 25 per endpoint | balance between coverage and runtime; 7 endpoints × 25 = ~175 examples total |
| `--hypothesis-deadline` | 5000 ms | per-example deadline; product endpoints should respond in well under 1s |
| `--hypothesis-derandomize` | enabled | deterministic seed for reproducibility |
| Total wall time budget | ≤ 3 minutes | allows comfortable run within `aws run` timeout |

## Checks Enabled (Schemathesis built-in)

| Check | Purpose |
|---|---|
| `not_a_server_error` | catches HTTP 5xx |
| `status_code_conformance` | response status_code is in OpenAPI schema |
| `response_schema_conformance` | response body matches schema |
| `content_type_conformance` | response Content-Type matches schema |

These map directly to TC-ROLE-200 assertions:
- "0 个 server_error" → `not_a_server_error`
- "0 个 schema_violation" → `response_schema_conformance` + `status_code_conformance` + `content_type_conformance`

## Coverage Assertion

> "schemathesis 报告中本批次每个端点都至少被命中 1 次"

Schemathesis emits one `pytest` test per `(method, path)` operation by default — pytest collection itself proves "covered". Codegen will emit a post-run sanity check (single pytest test) that asserts collection includes 7 operations.

## Test Data Cleanup

Fuzz creates roles with random names. Most names will fail validation (e.g. empty string, missing required field), but some will succeed for `POST /role/create`. Cleanup strategy:

1. Use a name prefix marker via schema example pre-processing? **Too complex; skip.**
2. **Selected approach**: session-scoped autouse fixture sweeps any role whose name does NOT match the pre-existing seeded set (admin / 普通用户) and was created during this session window.
   - Implementation: snapshot role-id-set at session start, snapshot at session end, delete the diff.
   - Simple, robust, idempotent.

```python
@pytest.fixture(scope="session", autouse=True)
def _fuzz_roles_oob_cleanup(fuzz_admin_token: str) -> Generator[None, None, None]:
    pre = _snapshot_role_ids(fuzz_admin_token)
    yield
    post = _snapshot_role_ids(fuzz_admin_token)
    leaked = post - pre
    for role_id in leaked:
        try:
            _delete_role_silent(role_id, fuzz_admin_token)
        except Exception:
            warnings.warn(f"[fuzz-roles] cleanup failed for role_id={role_id}")
```

## Output Files

| File | Action | Path |
|---|---|---|
| Fuzz test module | **CREATE** | `tests/fuzz/test_roles_fuzz.py` |
| `tests/fuzz/__init__.py` | **CREATE** (empty) | `tests/fuzz/__init__.py` |

## Dependency Installation

✅ **RESOLVED.** `schemathesis==3.39.16` installed via `uv add 'schemathesis>=3.30,<4'` in this change session. Verified:
- `uv run python -c "import schemathesis; print(schemathesis.__version__)"` → `3.39.16`
- `uv run pytest --version` → `8.4.2` (downgraded from 9.0.3 by uv resolver — see NR-FUZZ-03)
- `uv run pytest tests/api/test_users_api.py --collect-only` → 12 tests collect cleanly under new pytest version

## OpenAPI Schema Stability

The schema is generated at FastAPI startup from route declarations. Stable for any given backend revision. The `force_continue=false` policy means we do NOT re-run schema fetch on schema drift; if schema changes between cases and codegen, plan is invalidated.

## Mock Strategy

**None.** Fuzz runs against the live backend. The whole point is exercising real DB and validation paths.

## Needs Review

| ID | Severity | Item |
|---|---|---|
| NR-FUZZ-01 | medium | `RoleUpdateMenusApis.api_infos: list[dict]` is weakly typed in the OpenAPI schema. Schemathesis will generate `[{"path": <random>, "method": <random>}]` tuples. Backend `update_roles` calls `Api.filter(method=method, path=path).first()` and binds the result via `add()`; if `.first()` returns None, this is the most likely 5xx vector. **Reviewer must decide**: is a 5xx here a product bug (controller should defensive-check None) or expected behavior (schema validation should catch first)? This decision affects whether a 5xx is `failure` or `expected_baseline`. |
| NR-FUZZ-02 | medium | `RoleCreate.name` has no max-length constraint in the schema; schemathesis will generate very long strings. SQLite/MySQL may raise integrity errors. Same question: is "long name → integrity error → 500" a product bug? |
| NR-FUZZ-03 | low | `not_a_server_error` excludes 4xx by definition; we get unauthorized request floods if auth header injection fails. Confirm hook fires before each call. |
| NR-FUZZ-04 | low | Some endpoints (delete) have side effects. With 25 examples × 7 endpoints, cleanup snapshot diff is the right strategy; bounded by examples count. |
| NR-FUZZ-03b | low | Renamed: see NR-FUZZ-03 below. |
| NR-FUZZ-03 | low | `uv add schemathesis` downgraded `pytest` from 9.0.3 → 8.4.2. Existing tests collect cleanly under 8.4.2; non-blocking but explicitly noted because pytest 8 vs 9 differ in deprecation handling. Reviewer to confirm acceptable. |

## Blockers

**None.** B-FUZZ-01 (schemathesis missing) was resolved by user instruction: `uv add 'schemathesis>=3.30,<4'` installed `schemathesis==3.39.16` and supporting deps. As a side-effect `pytest` was downgraded from 9.0.3 → 8.4.2; existing test suites (`tests/api/test_users_api.py`) still collect cleanly under 8.4.2, so this is non-blocking but recorded in NR-FUZZ-03.

---

**Plan Readiness**: `ready_with_warnings`.
**Codegen Readiness**: `ready_with_warnings` (3 NRs documented; 0 blockers).
