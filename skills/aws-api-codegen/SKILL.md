---
name: aws-api-codegen
description: Use only after api-plan-review.json has decision == "pass" and codegen_readiness in ["ready", "ready_with_warnings"]. Triggers on: "generate test code from plan", "continue API codegen", "implement api-codegen-plan", "generate /tests/api". User request may trigger this skill but never replaces the JSON gate. Reads Stage 1 plan files and generates pytest code, fixtures, and helpers. Does NOT execute pytest — test execution is Phase 8 aws-run. Never runs before planning is complete.
---

## Per-Skill Memory

Before producing output, check whether `.aws/memory/aws-api-codegen.md` exists in the project root. If it exists, read it before producing output and apply only entries that are not marked `deprecated:`. Treat the file as read-only runtime guidance; do not create, edit, or delete `.aws/memory/**`.

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.api_plan_review.status == pass` (gate must be cleared).
3. Read input files from disk: `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `plans/m3-review-summary.md`, `review/api-plan-review.json`, `.aws/data-knowledge.yaml`, `cases/**/case.yaml`.
4. Verify `review/api-plan-review.json` gate fields in order — **STOP** on first failure:
   - valid JSON
   - `review_type == "api-plan"`
   - `change_id == <change-id>`
   - `decision == "pass"`
   - `codegen_readiness in ["ready", "ready_with_warnings"]`
   - `blockers` is empty
   - no `needs_review` item has `blocking == true`
   - `.aws/data-knowledge.yaml` exists on disk
5. Use files as the sole source of truth.

**After completing work:**

1. Write generated test files per `api-codegen-plan.md` Target Files and **Generated File Policy**:
   - `tests/api/test_<module>_api.py` — required when mapped in plan
   - `tests/api/helpers/<module>_api.py` — only if helper mapping is non-empty
   - `tests/factories/test_<module>_<library>.py` — required before any fixture wrapper that creates or cleans up domain data
   - `tests/fixtures/<module>_fixtures.py` — only pytest wrapper around `make_*`; never business data creation directly
   - `tests/api/conftest.py` — only if plan explicitly requires it (see conftest rules)
   - `qa/changes/<change-id>/known-product-issues.md` — append implementation notes only when file already exists and reviewer acknowledged the issue (never first writer for coverage gaps)
   - `qa/changes/<change-id>/codegen/api-codegen-summary.md` (create `codegen/` directory if missing)
2. Report the `workflow-state.yaml` state delta (inline mode: apply it directly; dispatched subagent: never write `workflow-state.yaml` — report the values in your final message and the orchestrator applies them):
   - `phases.api_codegen.status = done`
   - `phases.api_codegen.review_gate_file = review/api-plan-review.json`
   - `phases.api_codegen.codegen_readiness` = value from review JSON
   - `phases.api_codegen.generated_tests.files` = list of generated files
   - `phases.api_codegen.warnings_carried` = warning IDs or summaries from review JSON
   - `phases.api_codegen.known_product_issues.present` = true|false
   - `phases.api_codegen.known_product_issues.file` = `qa/changes/<change-id>/known-product-issues.md` (if present)

Example `workflow-state.yaml` fragment (as applied by the state owner):

```yaml
phases:
  api_codegen:
    status: done
    review_gate_file: review/api-plan-review.json
    codegen_readiness: ready_with_warnings
    generated_tests:
      files:
        - tests/api/test_<module>_api.py
    warnings_carried:
      - API-PLAN-FINDING-COV-001
    known_product_issues:
      present: true
      file: qa/changes/<change-id>/known-product-issues.md
```

---

# API Codegen for QA

Name: API Test Code Generation

Description: "QA superpower: use ONLY after API plan review. Generates pytest test code, domain factories, fixture wrappers, and helpers from api-plan.md, api-test-data-plan.md, and api-codegen-plan.md. **Does NOT run pytest or write execution results** — test execution is Phase 8 aws-run. Does NOT generate new cases or redesign test scope."

Converts a reviewed API test plan into executable pytest test code.

This skill is AWS M3 Stage 2. It MUST read Stage 1 plan files and generate `tests/api/`, `tests/factories/`, optional `tests/fixtures/` wrappers, and `tests/api/helpers/`. **Does NOT run pytest or produce execution results** — execution is Phase 8 `aws-run`.

## When to Use

Use when the user explicitly asks to:

- Generate test code from plan
- Continue API codegen
- Implement api-codegen-plan.md
- Generate `/tests/api` from M3 plan

**Not for:** running tests (use aws-run) or viewing execution results (use aws-inspect).

## Do Not Use When

Do NOT use this skill when:

- api-plan.md has not been generated
- api-test-data-plan.md has not been generated
- api-codegen-plan.md has not been generated
- m3-review-summary.md has not been generated
- User has not confirmed to continue codegen
- User asks to redesign test scope
- User asks to generate E2E test code

## Inputs

Must read:

- `qa/changes/<change-id>/plans/api-plan.md`
- `qa/changes/<change-id>/plans/api-test-data-plan.md`
- `qa/changes/<change-id>/plans/api-codegen-plan.md`
- `qa/changes/<change-id>/plans/m3-review-summary.md`
- `qa/changes/<change-id>/cases/**/case.yaml`
- `.aws/data-knowledge.yaml` ← **must exist. Missing is BLOCKER.**
- `qa/changes/<change-id>/review/api-plan-review.json`

Optional (required when `codegen_readiness == "ready_with_warnings"` due to endpoint coverage gap):

- `qa/changes/<change-id>/known-product-issues.md` — must exist before codegen if workaround / coverage gap is in scope

> **data-knowledge tier rules:**
> - `aws-api-plan` stage: missing `.aws/data-knowledge.yaml` does not block; generates `data-knowledge.proposal.yaml`.
> - `aws-api-codegen` stage: `.aws/data-knowledge.yaml` **must exist**. `data-knowledge.proposal.yaml` is reference only and cannot substitute.
> - If `.aws/data-knowledge.yaml` does not exist, **STOP** — tell user to create or promote `data-knowledge.proposal.yaml` first.

If any plan file is missing, stop and prompt to run `aws-api-plan` first.

## Mandatory Review JSON Gate

Same checks as Context Contract step 4. In summary:

- `qa/changes/<change-id>/review/api-plan-review.json` must exist and be valid JSON
- `review_type == "api-plan"` and `change_id == <change-id>`
- `decision == "pass"`
- `codegen_readiness in ["ready", "ready_with_warnings"]`
- `blockers` is empty
- no blocking `needs_review` items
- `.aws/data-knowledge.yaml` exists

If any condition fails, **STOP** — do not generate code.

User saying "approved" / "looks good" in chat cannot substitute this JSON gate. If user verbally approves, `aws-api-plan-reviewer` must write `api-plan-review.json` before continuing.

### ready_with_warnings — Coverage Gap Hard Rules

If `codegen_readiness == "ready_with_warnings"` due to endpoint workaround / coverage gap:

- `qa/changes/<change-id>/known-product-issues.md` **MUST** already exist and document the gap (reviewer pass prerequisite)
- Codegen **MUST** include test docstring / comment referencing the known issue ID (e.g. `KPI-001`)
- Codegen **MUST NOT** claim direct endpoint coverage
- Codegen **MUST NOT** create a workaround if the warning is not already documented in `known-product-issues.md`
- Codegen **MUST NOT** be the first writer of `known-product-issues.md` for coverage gaps

For other non-blocking warnings (not coverage gaps):

- Carry warnings in test comments only when no guessing is required
- If any warning requires guessing endpoint, auth, fixture, schema, cleanup, or product behavior → **STOP**

## Outputs

May generate (paths relative to project root; per `api-codegen-plan.md` Target Files):

- `tests/api/test_<module>_api.py` — test functions (required when mapped)
- `tests/api/helpers/<module>_api.py` — **only if** helper mapping in plan is non-empty
- `tests/factories/test_<module>_<library>.py` — **required** when new domain data setup/cleanup is needed
- `tests/fixtures/<module>_fixtures.py` — **only** pytest injection wrappers around domain factories; no business data creation directly
- `tests/api/conftest.py` — **only if** plan explicitly requires conftest changes (see below)
- `qa/changes/<change-id>/codegen/api-codegen-summary.md` — always

**known-product-issues.md:** Codegen may **append** implementation notes only when the file already exists and `aws-api-plan-reviewer` has acknowledged the issue. Codegen **MUST NOT** create the file for endpoint coverage gaps.

**Does NOT run pytest or write execution result files** — execution is fully handled by `aws-run` (Phase 8). After this skill completes, run `aws-run` to execute tests.

Must NOT generate or modify:

- `proposal.md`
- `case.yaml`
- `api-plan.md`
- `api-test-data-plan.md`
- `api-codegen-plan.md`

Unless the user explicitly asks to revise the plan.

## Generated File Policy

- Only create or modify files listed in `api-codegen-plan.md` **Target Files**.
- If a plan needs a new pytest fixture that creates or cleans up domain data, `api-codegen-plan.md` Target Files **must** include the corresponding `tests/factories/test_<module>_<library>.py` file. If missing → **STOP** and report blocker; do not generate only `tests/fixtures/<module>_fixtures.py`.
- If a target test file already exists, **append** new test functions only — do not overwrite unrelated tests.
- Do not delete existing tests.
- Preserve existing imports, fixtures, and project style.
- Do not generate empty helper or fixture files "just in case".

## conftest.py Policy

Update `tests/api/conftest.py` **only if** `api-codegen-plan.md` explicitly requires it.

- Prefer existing pytest fixture discovery (conftest hierarchy, `pytest_plugins`) over manual imports.
- If `tests/api/conftest.py` exists:
  - append only the minimal import or `pytest_plugins` entry required by the plan
  - never rewrite existing content
  - never duplicate existing imports
- If not required by the plan, do **not** create or modify `conftest.py`.

## Workflow

1. Read `api-plan.md`.
2. Read `api-test-data-plan.md`.
3. Read `api-codegen-plan.md`.
4. Read `m3-review-summary.md`.
5. Read `case.yaml`.
6. Read `.aws/data-knowledge.yaml`.
7. Check Codegen Preconditions: all plan files exist with no gaps.
8. Check Mandatory Review JSON Gate (Context Contract step 4 + **ready_with_warnings — Coverage Gap Hard Rules**).
9. Validate endpoint, assertion, fixture, auth, cleanup mapping completeness.
10. Generate or append `tests/api/test_<module>_api.py` per `api-codegen-plan.md` **Target Files**.
11. If domain data setup/cleanup is needed, generate or reuse `tests/factories/test_<module>_<library>.py` first; if the required factory target is missing from Target Files → **STOP** and report blocker.
11b. If plan + `.aws/data-knowledge.yaml` authorize a new pytest fixture wrapper, generate `tests/fixtures/<module>_fixtures.py` only as a thin wrapper around `make_*`; if capability exists, reuse existing fixture, do not create new file.
12. If helper mapping is non-empty, generate `tests/api/helpers/<module>_api.py`.
12b. Update `tests/api/conftest.py` per **conftest.py Policy** only when plan explicitly requires it.
13. **Do NOT run pytest** — execution is `aws-run` (Phase 8).
14. Create `qa/changes/<change-id>/codegen/` (if missing), write `codegen/api-codegen-summary.md`.
15. Output Codegen Summary (file list + next-step hint).

## Checklist

Complete in order:

- [ ] Confirm user asked to continue codegen
- [ ] Read `api-plan.md`
- [ ] Read `api-test-data-plan.md`
- [ ] Read `api-codegen-plan.md`
- [ ] Read `m3-review-summary.md`
- [ ] Read `case.yaml`
- [ ] Read `.aws/data-knowledge.yaml`
- [ ] Check Codegen Preconditions
- [ ] Check Mandatory Review JSON Gate (full gate + coverage gap rules)
- [ ] Validate test data capabilities (reuse existing factory/fixture or create only when authorized)
- [ ] Generate or append `tests/api/test_<module>_api.py`
- [ ] **Mechanical naming verification (mandatory, evidence required):** run `uv run pytest --collect-only -q <generated test files>` and confirm EVERY collected test id matches `test_<case_id lowercase>__<description>` and covers all case_ids in Case → Test Function Mapping (case-insensitive). Paste the collect-only output into the **Traceability Verification** section of `api-codegen-summary.md`. If the plan's Test Function Mapping itself lacks the case_id prefix, do NOT copy it verbatim — the naming rule in this skill overrides the plan; rename and note the correction in the summary.
- [ ] Verify all config values reference `tests.config.settings`; no hardcoded URL / credentials / prefixes
- [ ] Verify entities with M2M / closure / hash invariants use `make_*` from `tests/factories/` modules; no raw ORM `create()`
- [ ] Verify every domain-data fixture has a corresponding `tests/factories/test_<module>_<library>.py` Target File; if missing, STOP instead of generating wrapper-only setup
- [ ] Verify all `tests/fixtures/` files are wrapper-only and call `make_*`; no HTTP `POST .../create` or direct business data creation except create-focused cases in test bodies
- [ ] Verify each happy-path test ends with `assert_matches_schema(body, "METHOD /path")`
- [ ] Generate `tests/factories/test_<module>_<library>.py` before any domain-data fixture wrapper
- [ ] Generate `tests/fixtures/<module>_fixtures.py` only as a wrapper around `make_*` (only when plan + data-knowledge authorize)
- [ ] Generate `tests/api/helpers/<module>_api.py` (when helper mapping non-empty)
- [ ] Update `tests/api/conftest.py` (only when plan explicitly requires)
- [ ] Report the `phases.api_codegen` state delta (review_gate_file, codegen_readiness, warnings_carried, known_product_issues) — applied to `workflow-state.yaml` by the state owner per the Context Contract
- [ ] Create `codegen/` directory (if missing), write `api-codegen-summary.md`
- [ ] If any endpoint is not registered in `_LOCAL_SCHEMAS`, write **Schema Registration Required** section in `api-codegen-summary.md`
- [ ] Output Codegen Summary (file list + next step)

## Output Contract

### tests/api/test_<module>_api.py

Must satisfy:

- Use pytest.
- **Test function name MUST use normalized case_id as prefix**, separated from description by **double underscore** `__`: `test_<case_id lowercase>__<description>`. Normalization = lowercase case.yaml case_id (case_id already uses underscores, no hyphens). Example: case_id `TC_ROLE_API_001` → `def test_tc_role_api_001__role_list_happy_path(...)`. This is the **only mandatory traceability marker**, not comments/docstrings; `aws run` result parser backfills case_id from function name (case-insensitive match). When one case splits into multiple functions, all share the same case_id prefix.
- Every assertion must come from `case.yaml` or `api-codegen-plan.md`; do not extend on your own.
- Do not hardcode production accounts, passwords, or tokens.
- Valid token must come from fixture or auth capability in `.aws/data-knowledge.yaml`.
- No-token cases must explicitly omit Authorization header.
- Invalid-token cases may use a local fixed invalid string (e.g. `invalid-token`).
- Do not generate E2E code.
- Do not generate POM (Page Object Model).

**`tests/config.py` write / update gate (mandatory Q&A before touching this file):**

If any generated code would require creating or modifying `tests/config.py` (e.g. adding a new field, changing a default value, adding a new prefix):

1. **STOP** before writing.
2. **Ask the user** to confirm each runtime fact that would become a default value. Required questions:

   | Field | Question to ask |
   |-------|-----------------|
   | `base_url` | "What is the backend base URL? (e.g. `http://127.0.0.1:9999`) — please confirm from `run.py` or your start command." |
   | `frontend_url` | "What is the frontend dev server URL? (e.g. `http://127.0.0.1:3100`) — please confirm from `package.json` scripts or `vite.config.ts`." |
   | `admin_username` | "What is the admin username for QA? — please confirm from seed config or README." |
   | `admin_password` | "What is the admin password for QA? — please confirm from seed config or README." |
   | new `*_prefix` | "What prefix should be used for `<entity>` test data? Must be a string production data will never use." |

3. Do **not** write `tests/config.py` until the user confirms all relevant values.
4. After confirmation, record the fact source in a comment:

   ```python
   base_url: str = os.environ.get("BASE_URL", "http://127.0.0.1:9999")  # confirmed: run.py --port 9999
   ```

5. If `tests/config.py` already exists and the required field is present, **do not modify it** — reuse the existing value.

**SUT readiness (code-enforced):** connectivity and admin login are validated by session autouse fixture `_verify_sut_ready` in `tests/conftest.py` at pytest startup. Do not duplicate curl/login probes in generated tests or skill steps.

**Unified Configuration (mandatory):**

- All URLs, admin credentials, test data prefixes, etc. **must** be read from `tests.config.settings`; **must not** use `os.environ.get(...)` or inline literals.
- Module-level constants like `BASE_URL` / `FRONTEND_URL`: **must** be `from tests.config import settings; BASE_URL = settings.base_url`, or use `settings.base_url` directly.
- Test data prefixes (role / user / dept, etc.): **must** use `settings.role_prefix` / `settings.user_prefix` / `settings.dept_prefix`.

```python
# Required import skeleton
from tests.config import settings
from tests.factories.test_role_admin import make_role
from tests.factories.test_user_admin import make_user
from tests.factories.test_dept_admin import make_dept
from tests.schema_validation import assert_matches_schema
```

**Required test function naming skeleton:**

```python
# tests/api/test_role_api.py — case_id TC_ROLE_API_001
def test_tc_role_api_001__role_list_happy_path(api_client, auth_headers):
    ...
```

### tests/factories/test_<module>_<library>.py

Generate **whenever** the plan requires new domain data setup or invariant-preserving cleanup.

This is the only place where business data creation logic belongs.

Must satisfy:

- Export `make_*` functions for setup and explicit cleanup helpers when cleanup is non-trivial.
- Call app service/controller code internally to maintain invariants.
- Return plain data snapshots, or ensure fixture wrappers convert ORM objects to snapshots before exposing them to tests.
- May use `run_orm()` only for live-server mode; in-process async tests call `await make_*()` directly.
- Must read prefixes and runtime config from `tests.config.settings`.
- Must not call HTTP APIs for setup/cleanup except when explicitly documenting create/delete API behavior in a test body.
- Must not be placed under `qa/changes/`; generated reusable test support code belongs under `tests/factories/`.

### tests/fixtures/<module>_fixtures.py

Generate **only** as pytest injection wrappers around `tests/factories/test_<module>_<library>.py`.

Hard boundary:

- `tests/fixtures/` may contain `@pytest.fixture`, lifecycle/yield cleanup orchestration, and calls to `make_*`.
- `tests/fixtures/` must not contain business data creation logic directly.
- `tests/fixtures/` must not call HTTP `POST .../create` for setup when a `make_*` factory is required or available.
- If a required domain factory target is missing, **STOP** and report blocker instead of generating wrapper-only setup.

#### Test Data Strategy — DDD Three-Ring Boundary Rules

**pytest `fixture` vs factory pattern — do not confuse them:**

- **pytest `fixture`** is the *injection mechanism* (`@pytest.fixture` decorator). Mandatory pytest convention. The `tests/fixtures/` directory name refers to this mechanism — do NOT rename or remove it.
- **factory pattern** refers to how data is generated *inside* a fixture: return a callable factory (dynamic creation) rather than a static dict (hard-coded values).

**Three-ring seeding rules (hard rules; aligned with api-test-data-plan.md):**

**Factory module naming convention:** factory capabilities live under `tests/factories/`. Each module is named `test_<module>_<library>.py` (for example, `tests/factories/test_menu_admin.py`), and exported factory function names are always `make_*` (for example, `make_menu()`).

**Factory usage contract (hard rules):**

1. Setup uses factory; test body uses HTTP.
2. Factory modules call service/controller code; do not copy controller code into tests.
3. Factories must not leak ORM objects to test functions; return plain data snapshots or convert ORM objects to snapshots inside fixtures.
4. `run_orm()` is only for live-server mode; in-process async tests must call `await make_*()` directly.
5. Create API cases must exercise HTTP create; do not replace create behavior assertions with the same create factory path.
6. Cleanup must maintain the same invariants; do not raw-delete M2M, closure, or soft-delete entities.
7. Factory modules live under `tests/factories/test_<module>_<library>.py`; exported function names are always `make_*`.

| Ring | Seeding method | Why mandatory |
|------|----------------|---------------|
| **Within domain** | `make_*` exported by `tests/factories/test_<module>_<library>.py` modules; implementation calls service/controller code internally | Maintains invariants; default for ALL entities under test |
| **Cross domain** | Seed valid entity in other domain first, pass id as parameter | Ensures cross-aggregate references are valid |
| **External domain** | mock / contract stub | Avoids real external system dependencies |

**HTTP setup ban (fixtures / conftest):**

- **Do NOT** seed data in fixtures via `POST /.../create` + list lookup unless the mapped case **primarily tests the create endpoint** (called out in `api-codegen-plan.md` **Data Setup Mapping**).
- **Do** use `await make_<entity>(...)` / `run_orm(make_<entity>)` for `tmp_<entity>` fixtures when `make_<entity>` exists in the relevant `tests/factories/test_<module>_<library>.py` module.
- Cleanup must maintain the same invariants; do not raw-delete M2M, closure, or soft-delete entities. Use factory/service cleanup or documented invariant-preserving cleanup; HTTP DELETE is only required when the case tests delete behavior.

**Per-entity mandatory decisions:**

- `Role` (menus/apis M2M): **must** `asyncio.run(make_role(...))` or `await make_role(...)` in async fixture; **must not** raw `Role.create()`; **must not** HTTP-create in fixtures.
- `User` (roles M2M + password hash): **must** `await make_user(...)`; **must not** raw `User.create()`; **must not** HTTP-create in fixtures.
- `Dept` (DeptClosure closure table): **must** `await make_dept(...)`; **must not** raw `Dept.create()`; **must not** HTTP-create in fixtures.
- `Menu`: **must** `await make_menu(...)` / `run_orm(make_menu)` when `make_menu` exists in a `tests/factories/test_menu_<library>.py` module; **must not** HTTP-create in fixtures except create-focused cases; respect `settings.menu_prefix` and name `max_length=20`.
- `AuditLog` (no derived constraints): `make_audit_log()` or `AuditLog.create(...)` direct insert allowed.

**Recommended fixture skeleton (factory-first):**

```python
import asyncio
import pytest
from tests.config import settings
from tests.factories.runtime import run_orm
from tests.factories.test_menu_admin import make_menu  # exact module name comes from data-knowledge / scan

@pytest.fixture
def tmp_menu():
    """Independent menu per test; factory encapsulates create + id resolve."""
    menu = run_orm(lambda: make_menu())  # or asyncio.run(make_menu()) per project convention
    try:
        yield {"id": menu.id, "name": menu.name, "path": menu.path, ...}
    finally:
        run_orm(lambda: cleanup_menu(menu.id))  # invariant-preserving cleanup helper
```

**Forbidden patterns:**

```python
# Forbidden: HTTP create in fixture for non-create cases
@pytest.fixture
def tmp_menu(api_client, auth_headers):
    api_client.post("/api/v1/menu/create", json={...}, headers=auth_headers)  # use make_menu()

# Forbidden: raw insert for entities with M2M / closure
from app.models import Role
Role.create(name="test-role")  # does not maintain menus/apis M2M

# Forbidden: raw delete for entities with M2M / closure / soft-delete invariants
Role.filter(id=role_id).delete()  # use invariant-preserving cleanup

# Forbidden: hardcoded config
BASE_URL = "http://127.0.0.1:9999"  # use settings.base_url
ROLE_PREFIX = "tmp_role_"           # use settings.role_prefix
```

#### ORM field length (dept / menu / role names)

When `.aws/data-knowledge.yaml` or `facts/fact-baseline.json` documents `CharField max_length` enforced at ORM/DB only (Pydantic may not validate):

- **Never** build test entity names longer than the ORM limit — overflow often surfaces as HTTP 500, not 422.
- **Dept.name** (`max_length=20`): use `tests/api/helpers/dept_api.py` → `unique_dept_name(prefix, hex_chars=8)` where `len(prefix) + 1 + 8 ≤ 20` (prefix ≤ 11 chars). Do **not** append long suffixes like `-updated` on update cases — generate a second `unique_dept_name()` instead.
- **Menu.name** (`max_length=20`): follow conftest comments (`qa-cat-` + hex ≤ 19 chars).
- Document **known product issues** (e.g. duplicate key → HTTP 500) in `known-product-issues.md` + `facts/fact-baseline.json` anomalies — separate from test-data length bugs.

Generate **only when** `api-codegen-plan.md` and `.aws/data-knowledge.yaml` explicitly authorize new fixture wrappers or factories.

If required capability already exists in the project or data-knowledge file, **reuse it** — do not generate a new fixture file.

Must satisfy:

- Fixture source must map to a capability defined in `.aws/data-knowledge.yaml`.
- Do not invent business states or new business data factories unless data-knowledge defines the capability.
- Do not hardcode real accounts, passwords, or tokens.
- All config values must be read from `tests.config.settings`.
- Must retain cleanup entry or document that cleanup is handled by existing fixture.

### tests/api/helpers/<module>_api.py

Generate **only when** helper mapping in `api-codegen-plan.md` is non-empty. Do not create empty helper files.

Must satisfy:

- Helpers wrap repeated API calls or client initialization only.
- Helpers must not change assertion semantics.
- Helpers must not hide business failures.

### Codegen Output Summary

After codegen, write (create `qa/changes/<change-id>/codegen/` if it does not exist):

```text
qa/changes/<change-id>/codegen/api-codegen-summary.md
```

Must include:

- **Generated Files** — list of actually generated or modified files (optional files not generated marked N/A)
- **Case → Test Function Mapping** — table: Case ID \| Test Function \| File
- **Traceability Verification** — pasted `pytest --collect-only -q` output proving every collected test name carries its `test_<case_id lowercase>__` prefix (mandatory; a summary without this section is incomplete)
- **Fixtures Generated** — fixture names and sources (or "Reused existing — no new file")
- **Helpers Generated** — helper files and purpose (None if none)
- **Schema Assertion Coverage** — table: Test Function \| Endpoint Key \| Registered in \_LOCAL\_SCHEMAS (✓/✗)
- **Schema Registration Required** — unregistered endpoint list (None if all registered)
- **Warnings Carried from Review** — warnings from `api-plan-review.json` (e.g. `codegen_readiness == "ready_with_warnings"`)
- **Known Product Issues** — pointer to `qa/changes/<change-id>/known-product-issues.md` (if present; note if append-only)
- **Next Step** — `aws run --change <change-id>`

Also output summary in chat, but disk file is the sole trusted source for aws-run and aws-inspect — do not rely on chat context.

## Schema Assertion Rules (P1 — response body OpenAPI validation)

Each happy-path test function **must** append schema validation after business assertions:

```python
from tests.schema_validation import assert_matches_schema

def test_tc_role_api_001__role_list_happy_path(api_client, auth_headers):
    resp = api_client.get("/api/v1/role/list", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["code"] == 200
    # ... business assertions ...

    # P1: response body schema validation (last line)
    assert_matches_schema(body, "GET /api/v1/role/list")
```

**`assert_matches_schema` call rules:**

- **Must** be called at the end of each happy-path test function, immediately after business assertions.
- Parameter format: `"METHOD /api/path"`, matching keys in `tests/schema_validation._LOCAL_SCHEMAS`.
- If target endpoint is not yet registered in `_LOCAL_SCHEMAS`: list it in **Schema Registration Required** section of `api-codegen-summary.md` for human or follow-up PR.
- Not applicable to error / negative cases (4xx / 5xx) — those only assert `status_code` and `code`/`msg`; no schema validation.

**Schema registration guidance (append to codegen-summary.md):**

```markdown
## Schema Registration Required

Happy-path tests below call `assert_matches_schema` but schema is not yet
registered in `tests/schema_validation._LOCAL_SCHEMAS`.
Add entries in `tests/schema_validation.py` → `_LOCAL_SCHEMAS`:

| Endpoint | Suggested Schema Key | Notes |
|---|---|---|
| GET /api/v1/xxx/list | `"GET /api/v1/xxx/list"` | see _SUCCESS_EXTRA_WRAPPER |
```

**`assert_schema` fixture (optional):**

`tests/conftest.py` registers `assert_schema` fixture for injection:

```python
def test_tc_xxx__happy_path(api_client, auth_headers, assert_schema):
    ...
    assert_schema(body, "GET /api/v1/xxx/list")
```

Both call styles are equivalent; prefer direct `import` (clearer), no extra fixture param required.

---

## Hard Rules

- This Skill must only run after API planning.
- Do not generate or modify Case YAML.
- Do not generate or modify `proposal.md`.
- Do not redesign scope.
- Do not change assertions unless the plan explicitly says so.
- Do not generate E2E tests.
- Do not generate POM.
- Do not hardcode real credentials, tokens, secrets, or environment-specific URLs.
- Do not hardcode configuration values; always use `tests.config.settings`.
- Do not invent fixtures, factories, auth helpers, or cleanup helpers.
- Do not bypass `api-codegen-plan.md`.
- Do not execute pytest. Test execution belongs to aws-run (Phase 8).
- Do not write any execution result files (api-result.json, summary.md, etc.).
- Do not create `known-product-issues.md` as the first acknowledgment of an endpoint coverage gap — that belongs to human + `aws-api-plan-reviewer` before pass.
- Do not insert raw `Role.create()` / `User.create()` / `Dept.create()` for entities with M2M / closure / hash invariants — use `make_*` from `tests/factories/test_<module>_<library>.py` instead.
- Do not use HTTP `POST .../create` in fixtures or conftest for setup/teardown when `make_*` exists — except cases whose primary assertion is the create endpoint.
- Cleanup must maintain the same invariants; do not raw-delete M2M, closure, or soft-delete entities.
- If `make_<entity>()` is missing but required by plan, **STOP** and report Blocker (add factory first, or get reviewer-approved degradation documented in plan).

### Test Failure Integrity

Generated tests MUST fail for the right reason.

Rules:
- Every assertion MUST map to a case assertion or plan assertion.
- Do not use `assert True`, placeholder assertions, or empty expectations.
- Do not swallow failures with empty `try/except` or `except Exception: pass`.
- Do not add fallback logic that hides product failures.
- Do not use `skip`, `xfail`, or conditional early return to make generated tests green.
  - **Only exception for `xfail`:** a known product issue that was explicitly decided at intake/case-design (e.g. `assert_ideal` on a documented product bug) AND is documented in `qa/changes/<change-id>/known-product-issues.md`. The xfail `reason` MUST reference the issue ID from that file (e.g. `KPI-001` / `PH-001`). An xfail whose issue is not recorded in `known-product-issues.md` is a violation — record the issue first (human/reviewer acknowledged), then mark xfail.
- Do not loosen expected values after observing failures.
- Do not mock the behavior under test unless the plan explicitly authorizes it.
- Setup may be flexible; assertions must be strict.

Self-check before finishing codegen:
1. Would this test fail if the product behavior is wrong?
2. Does every assertion trace back to the case or plan?
3. Are setup failures reported instead of hidden?
4. Do all fixtures use `make_*` (not HTTP create) for entities under test?
5. Does cleanup preserve M2M / closure / soft-delete invariants instead of raw-deleting?

## Workaround Policy

Do not silently change tests to avoid product bugs.

If tests use an alternate endpoint because the target endpoint has a known product bug (coverage gap):

**Prerequisites (all required before codegen):**

- `api-plan-review.json` `decision == "pass"`
- `codegen_readiness == "ready_with_warnings"`
- `qa/changes/<change-id>/known-product-issues.md` **already exists** and documents the gap
- The issue was acknowledged by `aws-api-plan-reviewer` (not deferred to codegen)

**Codegen MUST NOT** be the first writer of `known-product-issues.md` for endpoint coverage gaps. If workaround is required but `known-product-issues.md` is missing → **STOP**.

**During codegen, the skill must:**

1. Add an explicit test docstring referencing the known issue ID (e.g. `KPI-001`) and explaining the workaround.
2. Add a local comment in the test function body explaining why the alternate endpoint is used.
3. **May append** implementation-only notes to existing `known-product-issues.md` (e.g. test function name, alternate call path) — **must not** create the file or add undocumented coverage gaps.
4. Mark the direct endpoint as a coverage gap in test comments — never claim direct coverage.
5. Do **not** set execution status — that is `aws-run`'s responsibility. Existing `known-product-issues.md` enables `aws-run` to record `PASS_WITH_WARNINGS`.
6. Never claim the original endpoint is directly covered if it is not exercised successfully.

> `known-product-issues.md` is a **change-level risk record**, not an execution result. `aws-run` reads it from `qa/changes/<change-id>/known-product-issues.md` and snapshots to `execution/`.

### known-product-issues.md Template

Reference format (typically created by human + acknowledged by reviewer **before** codegen pass). Codegen may append implementation notes only — do not use this template to create the file for the first time during codegen.

```markdown
# Known Product Issues

## KPI-001 — <short description>

- Category: known_product_issue
- Severity: major | minor | critical
- Module: <module-name>
- Endpoint: `<METHOD /api/v1/path>`
- Affected cases:
  - `<case-id>`
- Symptom:
  - <What happens when the endpoint is called>
- Root cause:
  - <Why it happens, if known>
- Workaround:
  - Tests verify <what> through `<alternate endpoint>`.
- Coverage gap:
  - Direct `<endpoint>` coverage remains open.
- Status: open
- Required fix:
  - <What must be done to resolve>
```

### Example

```
GET /api/v1/menu/get returns 500 because it returns a raw ORM object through
Success(data=result) without serialization. Tests verify detail/update through
GET /api/v1/menu/list as a temporary workaround. Direct GET /api/v1/menu/get
endpoint coverage remains open.
```

If the product bug should block release, do not workaround silently. Stop and report a blocker instead.

## Stop Conditions

Must stop and ask the user when:

- Missing `api-plan.md`
- Missing `api-test-data-plan.md`
- Missing `api-codegen-plan.md`
- Missing `m3-review-summary.md`
- Missing `.aws/data-knowledge.yaml`
- `api-plan-review.json` missing, invalid JSON, `decision != pass`, or `codegen_readiness == not_ready`
- Codegen Preconditions not met
- Data capability missing
- Endpoint path still in needs_review or coverage gap not recorded in `known-product-issues.md`
- Workaround required but `known-product-issues.md` missing (codegen must not create it first)
- `blockers` non-empty or any `needs_review` item has `blocking == true`

## Anti-patterns

Forbidden:

- "Plan is incomplete, but I'll generate code anyway"
- "I'll add a fixture name for you"
- "Generate a roughly runnable test first"
- "Wrote workaround but didn't reference existing known-product-issues.md"
- "Codegen creates known-product-issues.md first to acknowledge coverage gap"
- "Generate empty helper / fixture files"
- "Change conftest.py without plan authorization"
- "Modify case.yaml while at it"
- "Add extra assertions while at it"
- "Extend API tests into E2E"
- `BASE_URL = "http://127.0.0.1:9999"` — use `settings.base_url`
- `ROLE_PREFIX = "tmp_role_"` — use `settings.role_prefix`
- `Role.create(name="test")` — use `await make_role(...)` for M2M entities
- `User.create(username=..., password="plain")` — use `await make_user(...)`
- `Dept.create(name=...)` — use `await make_dept(...)` for closure table
- `tmp_menu` fixture calling `POST /menu/create` — use `make_menu()` when factory exists
- HTTP fixture seeding for update/get/delete cases — factory-first violation
- happy-path test missing `assert_matches_schema(body, "METHOD /path")` at end

## Next Workflow

After completion, next step is:

**Phase 8 — run `aws-run`** to execute tests:

```bash
aws run --change <change-id>
```

If tests fail, use `aws-inspect` to analyze; do not auto-modify assertions or merge fixes within this skill.
