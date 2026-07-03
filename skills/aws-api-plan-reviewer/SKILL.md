---
name: aws-api-plan-reviewer
description: "Review AWS API planning artifacts before API code generation. Use after aws-api-plan has generated API plan files. Read-only: writes api-plan-review.json and api-plan-review-summary.md, never modifies plan files."
---

## Context Contract

Do not rely on prior conversation context.

**Before doing any work:**

1. Read `qa/changes/<change-id>/workflow-state.yaml`.
2. Verify `phases.api_plan.status == done`.
3. Read input files from disk: `plans/api-plan.md`, `plans/api-test-data-plan.md`, `plans/api-codegen-plan.md`, `plans/m3-review-summary.md`.
4. If any required file is missing, stop and report.
5. Use files as the sole source of truth.

**After completing work:**

1. Write output files:
   - `qa/changes/<change-id>/review/api-plan-review.json`
   - `qa/changes/<change-id>/review/api-plan-review-summary.md`
2. Report the `workflow-state.yaml` state delta (inline mode: apply it directly; dispatched subagent: never write `workflow-state.yaml` — report the values in your final message and the orchestrator applies them):
   - `phases.api_plan_review.status` = `pass | needs_fix | needs_human_review | reject`
   - `phases.api_plan_review.gate_file` = `review/api-plan-review.json`

---

# AWS API Plan Reviewer

## Purpose

Review AWS API planning artifacts before code generation.

Use this skill after `aws-api-plan` has generated API test plan files.

This skill is **read-mostly**. It reviews API plan files and writes structured review outputs. It must not modify plan files.

---

## When to Use

Use this skill when:

- API plan files have been generated.
- You need to verify whether the API plan is ready for code generation.
- You need a machine-readable review gate before `aws-api-codegen`.

---

## Inputs

Required:

```text
qa/changes/<change-id>/plans/api-plan.md
qa/changes/<change-id>/plans/api-test-data-plan.md
qa/changes/<change-id>/plans/api-codegen-plan.md
qa/changes/<change-id>/plans/m3-review-summary.md
```

Optional (only present when `.aws/data-knowledge.yaml` was missing during planning):

```text
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml
```

Optional (required for endpoint coverage-gap acknowledgment before `decision == pass`):

```text
qa/changes/<change-id>/known-product-issues.md
```

Recommended:

```text
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
.aws/data-knowledge.yaml
tests/api/**
```

**Known product issues input rule:**

- If an endpoint coverage gap is detected and `known-product-issues.md` is missing → do **not** write `decision == pass`.
- Require the gap to be documented at `qa/changes/<change-id>/known-product-issues.md` before codegen may proceed.
- Do **not** defer documentation to `aws-api-codegen` — codegen is not the first place where a known product issue is acknowledged.

## Outputs

Write:

```text
qa/changes/<change-id>/review/api-plan-review.json
qa/changes/<change-id>/review/api-plan-review-summary.md
```

Create the review directory if it does not exist.

---

## Mandatory Output Contract

This skill is a **gate producer**. The workflow cannot advance to `aws-api-codegen` without the JSON file this skill writes.

- You **must** write `qa/changes/<change-id>/review/api-plan-review.json` as valid JSON with all required fields, including `codegen_readiness`.
- You **must** write `qa/changes/<change-id>/review/api-plan-review-summary.md`.
- A natural language conclusion in chat is **not** a substitute for the JSON file. Never end with only a textual verdict.
- User approval in chat does not release the gate; only a valid `api-plan-review.json` does. See **User Approval Handling**.
- If you cannot write the JSON file for any reason, treat the review as **failed** — the workflow must treat a missing or invalid `api-plan-review.json` as a STOP condition.

---

## User Approval Handling

User approval is not a substitute for review.

If the user says "approved", "looks good", or "continue":

- Treat it only as review context.
- Still validate every review criterion independently.
- Cross-check `m3-review-summary.md` **Plan Readiness**, **Codegen Readiness**, **Blockers**, and **Needs Review** — do not contradict plan self-assessment without explicit findings.
- Only write `decision == "pass"` when the plan satisfies all review criteria.
- If blockers or unresolved product decisions remain, write `needs_fix`, `needs_human_review`, or `reject`.

---

## Review Scope

Review the API plan for:

- Case-to-plan coverage
- API endpoint and method correctness
- Request/response assertion completeness
- Test data setup and cleanup feasibility
- Auth and fixture handling
- Codegen readiness
- Missing knowledge and unknowns

---

## Review Criteria

### 1. Case-to-Plan Coverage

Every API case with `automation.required = true` should be mapped to one or more planned test scenarios.

Flag:

- Case missing from plan
- Plan scenario not linked to any case
- Critical assertion missing from plan

### 2. API Endpoint and Method

Check whether each scenario has:

- HTTP method and path (or explicit `TBD` with Needs Review / Blockers per api-plan rules)
- Auth header strategy
- Request body structure
- Expected status code
- Expected response fields

Do not accept plans that depend on vague steps such as:

- "call the appropriate endpoint"
- "verify it works"

If Method or Path is `TBD` in **API Targets**, verify it appears in **Needs Review** or **Blockers** — not silently omitted.

### 3. Test Data Plan

Check:

- Required entities are listed
- Entity states are clear
- Fixture or factory strategy is defined
- Setup order is correct
- Cleanup strategy exists
- Data does not depend on production-like hardcoded IDs

Flag unknown factories, unknown states, and missing cleanup.

**Domain Boundary Checks:**

- **Factory-first default:** for every entity listed in **Required Data**, plan must specify Ring + method in **Factory / Boundary Strategy** → else `severity: medium` (`auto_fix_allowed: true`).
- If `tests/factories/` contains a `test_<module>_<library>.py` factory module defining `make_<entity>()` for an entity under test, plan/fixtures **must** use it for setup/teardown → else `severity: high`.
- If `api-codegen-plan.md` Target Files includes `tests/fixtures/<module>_fixtures.py` for a fixture that creates or cleans up domain data but does **not** include the corresponding `tests/factories/test_<module>_<library>.py` target → `severity: high`, `codegen_readiness = not_ready`.
- `tests/fixtures/` must be wrapper-only: `@pytest.fixture`, yield/lifecycle orchestration, and calls to `make_*`. Any direct business data creation in `tests/fixtures/` plan text → `severity: high`.
- **HTTP setup ban:** fixture or setup step uses `POST /.../create` (or helper wrapping create) for cases **not** primarily testing create → `severity: high` (`auto_fix_allowed: false`). Exception: create-focused case IDs explicitly mapped in **Data Setup Mapping** with reason.
- Anti-pattern: `tmp_<entity>` fixture = POST create + GET list resolve id → flag when `make_<entity>` exists or should exist per degradation ladder step 1.
- Cleanup must maintain the same invariants as setup; raw-delete cleanup for M2M, closure, or soft-delete entities → `severity: high` (`auto_fix_allowed: false` unless plan only needs wording clarification).
- Entities with M2M tables (Role↔menus/apis / User↔roles): plan must use `make_*` from `tests/factories/` modules; must not plan raw single-table insert or HTTP fixture seeding → else `severity: high`.
- Entities with closure derived tables (Dept↔DeptClosure): plan must use `make_dept()` → else `severity: high`.
- Entities with password hashing (User): plan must use `make_user()` → else `severity: high`.
- Menu / single-table domain entities: plan must use `make_menu()` when factory exists; HTTP fixture seeding forbidden except create cases → else `severity: high` (or `medium` if factory missing but step 1 documented in Blockers).
- Test config (BASE_URL / admin credentials / prefixes): plan must reference `tests.config.settings`; must not hardcode → else `severity: medium`.
- If `tests/factories/` is in `discovered_candidates` or `.aws/data-knowledge.yaml`, capabilities must map to the correct `test_<module>_<library>.py` module and exported `make_*` functions (including `make_menu` when present).
- If `api-test-data-plan.md` lacks **Factory / Boundary Strategy** section → `severity: medium` (`auto_fix_allowed: true`).

### 4. Codegen Readiness

Return one of: `ready` / `ready_with_warnings` / `not_ready`

**Hard rule — missing `.aws/data-knowledge.yaml`:**

If `.aws/data-knowledge.yaml` does not exist (including when `data-knowledge.proposal.yaml` was generated):

- `codegen_readiness` **MUST** be `not_ready`.
- Reason: `aws-api-codegen` requires formal `.aws/data-knowledge.yaml` regardless of whether selected API cases have minimal data needs.
- `decision` **cannot** be `pass` until the formal knowledge file exists and capabilities resolve (orchestrator also checks file existence before codegen).

**Use `ready` when:**

- `.aws/data-knowledge.yaml` exists.
- Endpoint, method, auth, request body, and assertions are all clear.
- Data setup is feasible.
- Required capabilities resolve.
- Codegen can proceed without guessing.

**Use `ready_with_warnings` when:**

- `.aws/data-knowledge.yaml` exists.
- All conditions in **Ready With Warnings Boundary** are met.
- Minor, non-blocking assumptions exist.
- Warnings are explicitly documented.
- Codegen can proceed without guessing product behavior.

**Use `not_ready` when:**

- `.aws/data-knowledge.yaml` is missing (hard rule above).
- Endpoint, method, or auth is unknown without documented TBD handling.
- Required fixture/factory is missing.
- Plan requires product decisions.
- Codegen would likely hallucinate implementation details.
- Any condition in **Ready With Warnings Boundary** is not met.
- `m3-review-summary.md` **Codegen Readiness** is `not_ready` and plan blockers remain unresolved.

### Ready With Warnings Boundary

`ready_with_warnings` is allowed only when:

- `.aws/data-knowledge.yaml` exists.
- HTTP method and path are confirmed (not `TBD`), or workaround is explicitly documented with coverage gap **and** `known-product-issues.md` already exists.
- Auth strategy is confirmed.
- Required fixtures / factories are available or safely optional.
- Request body and expected assertions do not require guessing schema.
- Cleanup strategy is confirmed or explicitly unnecessary.
- No blocker exists.
- Warnings are explicitly documented.
- Codegen can proceed without guessing product behavior.

If codegen would need to guess endpoint, method, auth mechanism, fixture, request schema, expected response schema, cleanup behavior, or product semantics, use `not_ready`.

### 5. Auth Handling

Acceptable:

- Auth fixture is known and mapped in `.aws/data-knowledge.yaml`.
- Invalid token cases use a clearly defined invalid string.
- No-auth cases explicitly pass no Authorization header.

Not acceptable:

- Hardcoded real tokens
- Undefined auth mechanism
- Auth guessed from endpoint path
- Marking unknown auth as TODO-only instead of blocker / needs review

### 6. Existing Test Style

If `tests/api/**` exists, check whether the plan respects existing style:

- File naming
- Fixture naming
- pytest conftest conventions
- Incremental append instead of overwrite

### 7. Missing Knowledge and Unknowns

Check that the plan does not silently depend on unknown capabilities:

- Any unknown endpoint, method, auth mechanism, or factory **must** be recorded as a blocker or needs review — not silently assumed, and not downgraded to TODO-only warnings.
- If `data-knowledge.proposal.yaml` was generated by `aws-api-plan` and `.aws/data-knowledge.yaml` is still missing, set `codegen_readiness = not_ready` and do not write `decision = pass`.
- If `data-knowledge.proposal.yaml` was generated by `aws-api-plan`, verify all proposed capabilities are either confirmed from `.aws/data-knowledge.yaml` or flagged as blockers.
- Unresolved capabilities must appear in `m3-review-summary.md` under Blockers or Needs Review.
- If the plan references fixtures or factories not present in `.aws/data-knowledge.yaml`, flag as `high` severity finding.
- Unknowns that are silently omitted from the plan are a `high` finding.

---

## Decision Rules

Return one of: `pass` / `needs_fix` / `needs_human_review` / `reject`

**Use `pass` when:**

- `codegen_readiness` is `ready` or `ready_with_warnings`.
- `.aws/data-knowledge.yaml` exists.
- No blocker exists.
- Codegen can continue safely.

**Use `needs_fix` when:**

- Plan issues are fixable without product decisions.
- Auto-fix can make the plan codegen-ready.
- `auto_fix_plan` is non-empty and every entry maps to a finding with `severity in ["low", "medium"]`.

**Use `needs_human_review` when:**

- Endpoint, auth, or fixture is unknown.
- Test scope must be confirmed.
- Codegen would require guessing.
- Endpoint coverage gap exists and `known-product-issues.md` is missing or scope is not yet accepted.

**Use `reject` when:**

- Plan is for the wrong feature.
- Required plan files are missing.
- Plan contradicts case files.
- Codegen would be unsafe or misleading.

### Decision ↔ JSON Field Constraints

| decision | human_review_required | auto_fix_allowed |
|---|---|---|
| `pass` | `false` | `false` |
| `needs_fix` | `false` | `true` (only low/medium severity findings) |
| `needs_human_review` | `true` | `false` |
| `reject` | `true` | `false` |

**Never** set `human_review_required = false` when `decision = needs_human_review`.
**Never** set `auto_fix_allowed = true` when `decision = pass` or `decision = reject`.
**Never** set `decision = needs_fix` with an empty `auto_fix_plan`.

### next_action Mapping

| decision | next_action |
|---|---|
| `pass` | `continue` |
| `needs_fix` | `run_api_plan_fixer` |
| `needs_human_review` | `human_review` |
| `reject` | `stop` |

### Gate Consistency Rules

These combinations are **invalid** and must never appear in `api-plan-review.json`:

**Blockers**

If `blockers` is non-empty:

- `decision` **MUST NOT** be `pass`
- `codegen_readiness` **MUST** be `not_ready`
- `next_action` **MUST NOT** be `continue`
- `auto_fix_allowed` **MUST** be `false`

**Codegen readiness**

If `codegen_readiness == "not_ready"`:

- `decision` **MUST NOT** be `pass`
- `next_action` **MUST NOT** be `continue`

If `decision == "pass"`:

- `codegen_readiness` **MUST** be `ready` or `ready_with_warnings`
- `.aws/data-knowledge.yaml` **MUST** exist
- `blockers` **MUST** be empty
- No `needs_review` item with `blocking == true`
- `human_review_required` **MUST** be `false`
- `auto_fix_allowed` **MUST** be `false`
- `next_action` **MUST** be `continue`

**Blocking needs_review items**

If `needs_review` contains any item with `blocking == true`:

- `decision` **MUST** be `needs_human_review`
- `human_review_required` **MUST** be `true`
- `auto_fix_allowed` **MUST** be `false`
- `next_action` **MUST** be `human_review`

**needs_fix severity**

If `decision == "needs_fix"`:

- `auto_fix_allowed` **MUST** be `true`
- `auto_fix_plan` **MUST** be non-empty
- Every referenced finding **MUST** have `severity in ["low", "medium"]`
- Every referenced finding **MUST** have `human_review_required == false`
- `aws-api-plan-fixer` **cannot** write `known-product-issues.md` — missing coverage-gap documentation **cannot** be resolved via `needs_fix`

---

## Risk Level Rules

Use: `low` / `medium` / `high` / `critical`

- **low**: Minor wording or formatting issues.
- **medium**: Some missing details, but codegen may continue with warnings.
- **high**: Missing endpoint/auth/data/fixture strategy. Missing core case coverage. Codegen likely to hallucinate.
- **critical**: Wrong feature. Required files missing. Plan contradicts approved case. Destructive or unsafe test behavior.

---

## Auto Fix Rules

Set `auto_fix_allowed = true` only if all required fixes are safe and mechanical.

Auto-fixable examples:

- Add missing case reference
- Normalize headings
- Move content into correct plan section
- Add explicit assertion already present in case YAML
- Add known execution command
- Add TODO markers only for already documented non-blocking warnings
- Clarify fixture reuse if known from `.aws/data-knowledge.yaml`
- Add missing **Factory / Boundary Strategy** section skeleton (entities already listed in plan; include per-entity Ring + method table)
- Replace hardcoded `BASE_URL` / credential string in plan with reference to `tests.config.settings`
- Add note in **Fixture Mapping** that HTTP create must not be used for non-create cases (wording only when reviewer flagged HTTP setup)

Do not downgrade blockers into TODO-only warnings.

Unknown endpoint, unknown method, unknown auth mechanism, missing required fixture/factory, unknown expected response schema, unsafe cleanup, or **inventing `make_*` factory implementations** must remain blockers or `needs_human_review`.

Not auto-fixable:

- Unknown endpoint or method
- Unknown auth mechanism
- Unknown fixture or factory
- Unknown expected response body
- Product behavior ambiguity
- Missing requirement scope
- Endpoint coverage gap documentation (`known-product-issues.md` — outside fixer allowlist; requires human action)

---

## Required JSON Format

Write valid JSON to:

```text
qa/changes/<change-id>/review/api-plan-review.json
```

Use this exact top-level structure (no comments in the actual file):

```json
{
  "schema_version": "1.0",
  "review_type": "api-plan",
  "change_id": "<change-id>",
  "decision": "pass",
  "risk_level": "low",
  "codegen_readiness": "ready",
  "auto_fix_allowed": false,
  "human_review_required": false,
  "summary": "Short review summary.",
  "reviewed_files": [],
  "blockers": [],
  "findings": [],
  "needs_review": [],
  "auto_fix_plan": [],
  "next_action": "continue",
  "created_at": "YYYY-MM-DDTHH:mm:ssZ"
}
```

`reviewed_files` **MUST** be non-empty and include every file actually read:

- `qa/changes/<change-id>/plans/api-plan.md`
- `qa/changes/<change-id>/plans/api-test-data-plan.md`
- `qa/changes/<change-id>/plans/api-codegen-plan.md`
- `qa/changes/<change-id>/plans/m3-review-summary.md`
- `qa/changes/<change-id>/plans/data-knowledge.proposal.yaml` (if present)
- `qa/changes/<change-id>/known-product-issues.md` (if read for coverage-gap acknowledgment)

Each finding must use:

```json
{
  "id": "API-PLAN-FINDING-001",
  "severity": "low|medium|high|critical",
  "category": "coverage|coverage_gap|endpoint|auth|data|assertion|fixture|codegen|execution|knowledge",
  "file": "qa/changes/<change-id>/plans/...",
  "message": "What is wrong.",
  "suggestion": "How to fix it.",
  "auto_fix_allowed": true,
  "human_review_required": false
}
```

Each blocker must use:

```json
{
  "id": "API-PLAN-BLOCKER-001",
  "severity": "high|critical",
  "file": "qa/changes/<change-id>/plans/...",
  "message": "Why codegen cannot continue.",
  "required_action": "What must be clarified or fixed."
}
```

Each `auto_fix_plan` item must use:

```json
{
  "finding_id": "API-PLAN-FINDING-001",
  "target_file": "qa/changes/<change-id>/plans/...",
  "operation": "edit|append|normalize|add_todo|move_section",
  "description": "What the fixer should do."
}
```

Each `needs_review` item must use:

```json
{
  "id": "API-PLAN-REVIEW-001",
  "severity": "medium|high|critical",
  "category": "endpoint|auth|data|fixture|scope|coverage|coverage_gap|knowledge",
  "file": "qa/changes/<change-id>/plans/...",
  "question": "What needs human clarification?",
  "reason": "Why this cannot be decided from files.",
  "blocking": true
}
```

Set `blocking: true` when product behavior, scope, endpoint coverage gap, or auth strategy must be confirmed before codegen. Set `blocking: false` only for non-blocking clarifications that do not affect gate safety.

---

## Summary Markdown Format

Write:

```text
qa/changes/<change-id>/review/api-plan-review-summary.md
```

Use this structure:

```markdown
# API Plan Review Summary

## Decision

- Decision:
- Risk:
- Codegen Readiness:
- Auto Fix Allowed:
- Human Review Required:

## Summary

...

## Coverage

...

## Codegen Readiness

...

## Blockers

...

## Needs Review

...

## Findings

...

## Auto Fix Plan

...

## Next Action

...
```

The **Needs Review** section must mirror `needs_review` from `api-plan-review.json` — especially when `decision == needs_human_review`. Do not leave it empty when blocking `needs_review` items exist.

---

## Endpoint Coverage Integrity

If a case targets a specific endpoint, the implementation plan should exercise that endpoint directly.

If the plan uses a different endpoint because the target endpoint is broken or unavailable, this is a **coverage gap** — not equivalent direct endpoint coverage. Mark the finding with `category: coverage_gap`.

### Hard Rules

**If an endpoint coverage gap exists and `qa/changes/<change-id>/known-product-issues.md` does NOT exist:**

- `decision` **MUST** be `needs_human_review` (scope / workaround acknowledgment required; fixer cannot write this file)
- `codegen_readiness` **MUST** be `not_ready`
- `human_review_required` **MUST** be `true`
- `auto_fix_allowed` **MUST** be `false`
- `next_action` **MUST** be `human_review` — **MUST NOT** be `continue`
- Add a blocking `needs_review` item documenting the required documentation action
- Do **not** write `decision == needs_fix` for missing `known-product-issues.md` — `aws-api-plan-fixer` cannot create that file

**If coverage gap requires product / scope acknowledgment** (workaround not yet accepted):

- `decision` **MUST** be `needs_human_review`
- `codegen_readiness` **MUST** be `not_ready`
- High-severity coverage findings **MUST** have `human_review_required: true` and **cannot** enter `needs_fix`

**If `known-product-issues.md` exists and explicitly documents the gap** (workaround accepted, coverage gap recorded):

- `decision` **MAY** be `pass`
- `codegen_readiness` **MUST** be `ready_with_warnings` (never `ready`)
- `risk_level` **MUST** be at least `medium`
- `blockers` **MUST** be empty
- Downstream execution / archive **MUST NOT** be treated as clean PASS
- Reviewer **MUST** read and verify the file before writing `decision == pass` — do **not** defer to "will be written by codegen"

### Example — gap not yet documented

Target endpoint from case:

```text
GET /api/v1/menu/get
```

Planned implementation uses alternate endpoint:

```text
GET /api/v1/menu/list
```

The review finding must include:

```json
{
  "id": "API-PLAN-FINDING-COV-001",
  "severity": "high",
  "category": "coverage_gap",
  "file": "qa/changes/<change-id>/plans/api-codegen-plan.md",
  "message": "Target endpoint GET /api/v1/menu/get is replaced by GET /api/v1/menu/list due to a product bug. Direct endpoint coverage remains open.",
  "suggestion": "Human must create qa/changes/<change-id>/known-product-issues.md documenting the coverage gap before pass.",
  "auto_fix_allowed": false,
  "human_review_required": true
}
```

Required review output when `known-product-issues.md` is missing:

```json
{
  "decision": "needs_human_review",
  "codegen_readiness": "not_ready",
  "human_review_required": true,
  "auto_fix_allowed": false,
  "next_action": "human_review",
  "risk_level": "medium"
}
```

### Example — gap documented, pass allowed

After human creates `qa/changes/<change-id>/known-product-issues.md` with explicit coverage gap entry:

- `decision: pass`
- `codegen_readiness: ready_with_warnings`
- `risk_level: medium` (minimum)
- `blockers: []`
- Include `known-product-issues.md` in `reviewed_files`

---

## Final Response

After writing the files, respond with:

```
API plan review completed.

Decision: <decision>
Risk: <risk_level>
Codegen readiness: <ready|ready_with_warnings|not_ready>
Human review required: <true|false>
Auto fix allowed: <true|false>

Files:
- qa/changes/<change-id>/review/api-plan-review.json
- qa/changes/<change-id>/review/api-plan-review-summary.md
```

Do not claim the plan is ready unless `codegen_readiness` is `ready` or `ready_with_warnings`.

Do not modify plan files in this skill.
