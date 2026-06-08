---
name: aws-api-plan-reviewer
description: "Review AWS API planning artifacts before API code generation. Use after aws-api-plan has generated API plan files. Read-only: writes api-plan-review.json and api-plan-review-summary.md, never modifies plan files."
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

Recommended:

```text
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
.aws/data-knowledge.yaml
tests/api/**
```

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
- If the user said "approved" / "looks good", you must still encode that as a JSON review with `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]`. Approval in chat does not release the gate; the JSON does.
- If you cannot write the JSON file for any reason, treat the review as **failed** — the workflow must treat a missing or invalid `api-plan-review.json` as a STOP condition.

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

- HTTP method and path
- Auth header strategy
- Request body structure
- Expected status code
- Expected response fields

Do not accept plans that depend on vague steps such as:

- "call the appropriate endpoint"
- "verify it works"

### 3. Test Data Plan

Check:

- Required entities are listed
- Entity states are clear
- Fixture or factory strategy is defined
- Setup order is correct
- Cleanup strategy exists
- Data does not depend on production-like hardcoded IDs

### 4. Codegen Readiness

Return one of: `ready` / `ready_with_warnings` / `not_ready`

**Use `ready` when:**
- Endpoint, method, auth, request body, and assertions are all clear.
- Data setup is feasible.
- Codegen can proceed without guessing.

**Use `ready_with_warnings` when:**
- Minor assumptions exist.
- Warnings are documented.
- Codegen can still proceed safely.

**Use `not_ready` when:**
- Endpoint or auth is unknown.
- Required fixture/factory is missing.
- Plan requires product decisions.
- Codegen would likely hallucinate implementation details.

### 5. Auth Handling

Acceptable:

- Auth fixture is known and mapped in `.aws/data-knowledge.yaml`.
- Invalid token cases use a clearly defined invalid string.
- No-auth cases explicitly pass no Authorization header.

Not acceptable:

- Hardcoded real tokens
- Undefined auth mechanism
- Auth guessed from endpoint path

### 6. Existing Test Style

If `tests/api/**` exists, check whether the plan respects existing style:

- File naming
- Fixture naming
- pytest conftest conventions
- Incremental append instead of overwrite

---

## Decision Rules

Return one of: `pass` / `needs_fix` / `needs_human_review` / `reject`

**Use `pass` when:**
- `codegen_readiness` is `ready` or `ready_with_warnings`.
- No blocker exists.
- Codegen can continue safely.

**Use `needs_fix` when:**
- Plan issues are fixable without product decisions.
- Auto-fix can make the plan codegen-ready.

**Use `needs_human_review` when:**
- Endpoint, auth, or fixture is unknown.
- Test scope must be confirmed.
- Codegen would require guessing.

**Use `reject` when:**
- Plan is for the wrong feature.
- Required plan files are missing.
- Plan contradicts case files.

---

## Risk Level Rules

Use: `low` / `medium` / `high` / `critical`

- **low**: Minor wording or formatting issues.
- **medium**: Some missing details, but codegen may continue with warnings.
- **high**: Missing endpoint/auth/data/fixture strategy. Codegen likely to hallucinate.
- **critical**: Wrong feature. Required files missing. Plan contradicts approved case.

---

## Auto Fix Rules

Set `auto_fix_allowed = true` only if all required fixes are safe and mechanical.

Auto-fixable examples:

- Add missing case reference
- Normalize headings
- Add known assertions from case YAML
- Add known execution command
- Add TODO markers for unknowns

Not auto-fixable:

- Unknown endpoint or method
- Unknown auth mechanism
- Unknown fixture or factory
- Unknown expected response body
- Product behavior ambiguity

---

## Required JSON Format

Write valid JSON to:

```text
qa/changes/<change-id>/review/api-plan-review.json
```

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

Each finding must use:

```json
{
  "id": "API-PLAN-FINDING-001",
  "severity": "low|medium|high|critical",
  "category": "coverage|endpoint|auth|data|assertion|fixture|codegen|execution|knowledge",
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

---

## Summary Markdown Format

Write:

```text
qa/changes/<change-id>/review/api-plan-review-summary.md
```

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

## Findings

...

## Auto Fix Plan

...

## Next Action

...
```

---

## Endpoint Coverage Integrity

If a case targets a specific endpoint, the implementation plan should exercise that endpoint directly.

If the plan uses a different endpoint because the target endpoint is broken or unavailable, the reviewer must:

1. Mark the finding as a `coverage_gap`.
2. Require `known-product-issues.md` documentation before codegen proceeds.
3. Set `risk_level` at least `medium`.
4. Set `decision` to `needs_fix` (or `needs_human_review` if the scope cannot be safely adjusted).
5. Ensure final `decision` is **not** `pass` without explicit acknowledgment of the gap.
6. Never claim the direct endpoint is fully covered if it is not directly exercised.

### Example

Target endpoint from case:

```text
GET /api/v1/menu/get
```

Planned implementation uses alternate endpoint:

```text
GET /api/v1/menu/list
```

This is **not** equivalent direct endpoint coverage.

The review finding must include:

```json
{
  "id": "API-PLAN-FINDING-COV-001",
  "severity": "high",
  "category": "coverage",
  "file": "qa/changes/<change-id>/plans/api-codegen-plan.md",
  "message": "Target endpoint GET /api/v1/menu/get is replaced by GET /api/v1/menu/list due to a product bug. Direct endpoint coverage remains open.",
  "suggestion": "Document the coverage gap in known-product-issues.md. Do not claim GET /api/v1/menu/get is covered.",
  "auto_fix_allowed": false,
  "human_review_required": true
}
```

If this finding is accepted and documented, set:
- `codegen_readiness: ready_with_warnings` (not `ready`)
- `risk_level: medium` (minimum)
- Confirm `known-product-issues.md` will be written by codegen

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
