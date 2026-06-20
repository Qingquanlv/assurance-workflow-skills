# M3 Review Summary — Fuzz Plan (`20260615-role-mgmt`)

**Stage**: aws-fuzz-plan (Phase 4C) → handoff to aws-fuzz-plan-reviewer (Phase 5C)

## Plan Readiness

**`ready_with_warnings`**

## Codegen Readiness

**`ready_with_warnings`**

## Files Produced

- `plans/fuzz-plan.md`
- `plans/fuzz-codegen-plan.md`
- `plans/fuzz-review-summary.md` (this file)

## Test Inventory

| # | Case | Test |
|---|---|---|
| 1 | TC-ROLE-200 | `test_role_endpoints_schema_robustness` parameterized via `@schema.parametrize(endpoint=r"^/api/v1/role/")` — yields 7 collected tests, one per `(method, path)` |

## Framework

- **schemathesis 3.39.16** (installed in this session)
- pytest driver via `@schema.parametrize`
- Hypothesis backend with fixed seed `20260615`, `--hypothesis-max-examples=25`, `--hypothesis-deadline=5000`

## Target Endpoints (7)

```
GET    /api/v1/role/list
GET    /api/v1/role/get
POST   /api/v1/role/create
POST   /api/v1/role/update
DELETE /api/v1/role/delete
GET    /api/v1/role/authorized
POST   /api/v1/role/authorized
```

## Auth & Headers

- Reuses existing `get_admin_token()` from `tests/e2e/scripts/user_data_setup.py`.
- Module-level token cache; `before_call` hook injects `token: <jwt>` header (matching project convention; NOT `Authorization: Bearer`).

## Cleanup Strategy

Session-scoped autouse fixture takes role-id snapshots pre/post fuzz session and deletes the diff. Robust to randomized creates that succeed validation.

## Schema Source

`http://localhost:9999/openapi.json` (FastAPI auto-generated; verified via `app/__init__.py`). Configurable via `OPENAPI_URL` env var.

## Marker Addition

Codegen MUST add `"fuzz: ..."` marker to `pyproject.toml` `[tool.pytest.ini_options].markers`. This is a strictly additive 1-line edit to existing markers list.

## Needs Review (4 items, all non-blocking)

| ID | Severity | Item |
|---|---|---|
| NR-FUZZ-01 | medium | `RoleUpdateMenusApis.api_infos` is `list[dict]` weakly typed — fuzz may trigger 5xx if controller hits `Api.filter(...).first() == None` path. Reviewer to decide whether 5xx in this case is `product_issue` (controller should defend) or `expected_baseline` (caller's fault). Affects how inspect classifies failures. |
| NR-FUZZ-02 | medium | `RoleCreate.name` has no max-length in schema; long-string fuzz may hit DB integrity errors → 5xx. Same classification question as NR-FUZZ-01. |
| NR-FUZZ-03 | low | `uv add schemathesis` downgraded pytest 9.0.3 → 8.4.2. Verified existing tests collect cleanly. Confirm acceptable. |
| NR-FUZZ-04 | low | Cleanup is id-set diff (not name-prefix) — captures all leaked roles regardless of name. Reviewer to confirm acceptable robustness. |

## Blockers

**None.** B-FUZZ-01 resolved by user choice "Install schemathesis, then continue" → `uv add 'schemathesis>=3.30,<4'` succeeded.

## Reviewer Hand-off

aws-fuzz-plan-reviewer should evaluate:

- Are NR-FUZZ-01 and NR-FUZZ-02 acceptable risks at planning stage, or should case TC-ROLE-200 specify expected baseline behavior more tightly?
- Is the `before_call` hook auth injection pattern stable in schemathesis 3.39.x? (consider switching to `schema.given()` or wrapping the schema)
- Is module-level `schema = schemathesis.from_uri(OPENAPI_URL)` acceptable for collection-time backend dependency? Recommended fallback: try/except wrapping with `pytest.fail("backend not running on " + OPENAPI_URL)` so test collection still works.
- Recommendation: accept all NR-FUZZ-* as informational; emit `decision=pass`, `codegen_readiness=ready_with_warnings`, no findings.

## Workflow State Update

After this file is written:

- `phases.fuzz_plan.status = done`
- `phases.fuzz_plan.outputs = [fuzz-plan.md, fuzz-codegen-plan.md, fuzz-review-summary.md]`
- `phases.fuzz_plan.readiness.plan = ready_with_warnings`
- `phases.fuzz_plan.readiness.codegen = ready_with_warnings`
- `phases.fuzz_plan.notes = "schemathesis 3.39.16 installed in-session; pytest auto-downgraded to 8.4.2 (NR-FUZZ-03)"`
