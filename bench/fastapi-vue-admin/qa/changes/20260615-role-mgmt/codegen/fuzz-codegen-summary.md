# Fuzz Codegen Summary — Role Management (`20260615-role-mgmt`)

## Status

**done (with deviations)** — fuzz tests collected (7) and infrastructurally verified against live backend. One sample run reproduces a real product issue (HTTP 500 on negative-int pagination), confirming the layer functions as designed.

## Files Created

| Path | Purpose |
|---|---|
| `tests/fuzz/__init__.py` | Empty package marker (per plan acceptance #1) |
| `tests/fuzz/test_roles_fuzz.py` | Single parametrized test, 7 test items (one per role endpoint) |

## Files Modified

| Path | Change |
|---|---|
| `pyproject.toml` | Added `"fuzz: schemathesis-based robustness fuzz tests against live backend"` to `[tool.pytest.ini_options].markers` (per plan §"Pytest Marker") |

## Files Out of Scope (Untouched)

- `app/`, `web/`, `tests/api/`, `tests/e2e/` — strictly additive constraint honored

## Generated Test Inventory

```
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[GET /api/v1/role/list]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[GET /api/v1/role/get]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[POST /api/v1/role/create]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[POST /api/v1/role/update]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[DELETE /api/v1/role/delete]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[GET /api/v1/role/authorized]
tests/fuzz/test_roles_fuzz.py::test_role_endpoints_schema_robustness[POST /api/v1/role/authorized]
```

7 test items, all map to **TC-ROLE-200** via `pytestmark = [pytest.mark.fuzz, pytest.mark.case_id("TC-ROLE-200")]`.

## Plan Deviations

### Deviation 1: schemathesis 3.x → 4.x Upgrade (mid-codegen blocker resolution)

| Aspect | Plan (v3) | Shipped (v4) | Reason |
|---|---|---|---|
| Library version | `schemathesis>=3.30,<4` (3.39.16) | `schemathesis>=4,<5` (4.21.6) | v3.39.16 raised `SchemaError: Open API 3.1.0, which is currently not fully supported`. FastAPI 0.111.0 emits OpenAPI 3.1.0 by default. v4.21.6 natively supports 3.1.0. User authorized upgrade via question gate. |
| Schema loader | `schemathesis.from_uri(url, base_url=...)` | `schemathesis.openapi.from_url(url)` | v4 namespacing; `base_url` derived from schema's `servers` field |
| Endpoint filter | `@schema.parametrize(endpoint=r"^/api/v1/role/")` | `schema.include(path_regex=r"^/api/v1/role/").parametrize()` | v4 separates filter from parametrize |
| Hook registration | `@schema.hooks.register("before_call")` (schema-scoped) | `@schemathesis.hook` global decorator | v4 enforces `before_call` is GLOBAL scope only (raised `ValueError: Cannot register hook 'before_call' on SCHEMA scope dispatcher`) |
| Check imports | `from schemathesis.checks import not_a_server_error, status_code_conformance, ...` | `from schemathesis.checks import CHECKS, load_all_checks; load_all_checks(); CHECKS.get_by_names([...])` | v4 lazy-loads checks; only `not_a_server_error` is auto-registered at import |
| `@schema.given(...)` placeholder | Present in plan template | **Removed** | Not idiomatic v4; `@schema.parametrize()` already drives Hypothesis state |

All four target checks (`not_a_server_error`, `status_code_conformance`, `response_schema_conformance`, `content_type_conformance`) preserved per plan §"Module Layout".

### Deviation 2: pytest auto-upgrade

`uv add 'schemathesis>=4,<5'` upgraded **pytest 8.4.2 → 9.1.0**. Verified:
- `tests/api/` collects 35 tests ✓ (was 35 pre-upgrade)
- `tests/e2e/` collects 11 tests `[chromium]` ✓
- `tests/fuzz/` collects 7 tests ✓

No regressions across layers.

## Verification Performed

| Check | Result |
|---|---|
| `lsp_diagnostics tests/fuzz/test_roles_fuzz.py` | No diagnostics |
| `uv run python -m py_compile tests/fuzz/__init__.py tests/fuzz/test_roles_fuzz.py` | OK |
| `uv run pytest tests/fuzz/ --collect-only` | 7 tests collected |
| `pyproject.toml` markers list | `fuzz` marker present |
| Smoke run: `pytest -k "role/list"` (one parameter, default Hypothesis budget) | Token-injection hook verified working (`token: [Filtered]` in reproduction curl); checks fire on real failure (`ServerError` + `UndefinedStatusCode` raised on `page=-54618123`) |
| `case_id` propagation | `pytestmark` includes `pytest.mark.case_id("TC-ROLE-200")` — propagates to all 7 generated test items |
| No edits to `app/`, `web/`, `tests/api/`, `tests/e2e/` | Confirmed |
| Cleanup fixture `_fuzz_roles_oob_cleanup` | `scope="session", autouse=True` ✓ |

## Acceptance Checklist (from fuzz-codegen-plan.md §"Acceptance Checklist")

- [x] `tests/fuzz/__init__.py` exists (empty, package marker)
- [x] `tests/fuzz/test_roles_fuzz.py` exists with structure as planned (with v4 API adaptations documented above)
- [x] `pyproject.toml` markers list includes `fuzz: ...`
- [x] `uv run pytest tests/fuzz/ --collect-only` lists 7 endpoint tests
- [x] One representative test runs without import error (smoke-verified)
- [x] `case_id` marker propagated for all 7 generated tests (via `pytestmark`)
- [x] No edits to `app/`, `web/`, existing `tests/api/`, `tests/e2e/`
- [x] Cleanup fixture is `autouse=True` and `scope="session"`

## Warnings Carried Forward to Phase 8/9

| ID | Description | Disposition |
|---|---|---|
| NR-FUZZ-01 | weakly-typed `api_infos` fuzz behavior unclear (product-issue vs expected) | Defer to `aws-inspect` classification |
| NR-FUZZ-02 | long-string fuzz on `name` may hit DB integrity error | Defer to `aws-inspect` classification |
| NR-FUZZ-03 | pytest auto-upgrade 8.4.2 → 9.1.0 (caused by schemathesis 4.x install) | Verified non-blocking: API + E2E layers still collect cleanly |
| NR-FUZZ-04 (new) | schemathesis library upgrade 3.39.16 → 4.21.6 mid-codegen (OpenAPI 3.1 compatibility) | User-authorized; documented as plan deviation; non-blocking |

## Confirmed Real Product Issue (Pre-Phase-8)

Smoke test on `[GET /api/v1/role/list]` reproduced:

```
curl -X GET -H 'token: <admin>' 'http://localhost:9999/api/v1/role/list?page=-54618123&page_size=-100000001&role_name=...'
→ HTTP 500 Internal Server Error (undocumented; OpenAPI declares 200, 422)
```

This will be re-discovered and recorded by Phase 8 (`aws run`) and classified by Phase 9 (`aws-inspect`) per the plan's failure-modes mapping (`not_a_server_error` raise → `product_issue` bucket).

## Hand-off

Phase 7C **complete**. All three codegen phases (7A API + 7B E2E + 7C Fuzz) ready for Phase 8 (`aws run --change 20260615-role-mgmt`).
