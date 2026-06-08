---
name: aws-plan-reviewer
description: "Review AWS E2E planning artifacts before code generation. Use after aws-e2e-plan has generated test planning files. Read-only: writes plan-review.json and plan-review-summary.md, never modifies plan files."
---

# AWS Plan Reviewer

## Purpose

Review AWS E2E planning artifacts before code generation.

Use this skill after `aws-e2e-plan` has generated test planning files.

This skill is **read-mostly**. It reviews plan files and writes structured review outputs. It must not modify plan files.

---

## When to Use

Use this skill when:

- E2E plan files have been generated.
- You need to verify whether the plan is ready for code generation.
- You need a machine-readable review gate before `aws-e2e-codegen`.

---

## Inputs

Required:

```text
qa/changes/<change-id>/plans/e2e-plan.md
qa/changes/<change-id>/plans/e2e-test-data-plan.md
qa/changes/<change-id>/plans/e2e-codegen-plan.md
qa/changes/<change-id>/plans/m4-review-summary.md
```

Optional (only present when `.aws/data-knowledge.yaml` was missing during planning):

```text
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml
```

Recommended:

```text
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
.aws/data-knowledge.yaml
tests/e2e/**
```

## Outputs

Write:

```text
qa/changes/<change-id>/review/plan-review.json
qa/changes/<change-id>/review/plan-review-summary.md
```

Create the review directory if it does not exist.

---

## Mandatory Output Contract

This skill is a **gate producer**. The workflow cannot advance to `aws-e2e-codegen` without the JSON file this skill writes.

- You **must** write `qa/changes/<change-id>/review/plan-review.json` as valid JSON with all required fields, including `codegen_readiness`.
- You **must** write `qa/changes/<change-id>/review/plan-review-summary.md`.
- A natural language conclusion in chat is **not** a substitute for the JSON file. Never end with only a textual verdict.
- If the user said "approved" / "looks good", you must still encode that as a JSON review with `decision == "pass"` and `codegen_readiness in ["ready","ready_with_warnings"]`. Approval in chat does not release the gate; the JSON does.
- If you cannot write the JSON file for any reason, treat the review as **failed** — the workflow must treat a missing or invalid `plan-review.json` as a STOP condition.

---

## Review Scope

Review the plan for:

- Case-to-plan coverage
- E2E flow correctness
- Test data setup feasibility
- Codegen readiness
- Selector and route confidence
- Auth and role handling
- Fixture reuse
- Incremental codegen safety
- Execution command correctness
- Missing knowledge and unknowns

---

## Review Criteria

### 1. Case-to-Plan Coverage

Every E2E case should be mapped to one or more planned test scenarios.

Flag:

- Case missing from plan
- Plan scenario not linked to any case
- Critical assertion missing from plan
- Manual-only step included without automation strategy

### 2. E2E Flow Correctness

Check whether each flow has:

- Start route or navigation strategy
- User role
- Authentication state
- Preconditions
- Test data
- Steps
- Expected assertions
- Cleanup strategy if data is mutated

Do not accept plans that depend on vague steps such as:

- "go to the correct page"
- "click the proper button"
- "verify it works"

### 3. Test Data Plan

Check:

- Required entities are listed
- Entity states are clear
- Fixture or factory strategy is defined
- Setup order is correct
- Cleanup strategy exists
- Shared data does not create flaky tests
- Data does not depend on production-like hardcoded IDs

Flag unknown factories, unknown states, and missing cleanup.

### 4. Codegen Readiness

Return one of: `ready` / `ready_with_warnings` / `not_ready`

**Use `ready` when:**

- Test flows are clear.
- Data setup is feasible.
- Assertions are observable.
- Codegen can proceed without guessing.

**Use `ready_with_warnings` when:**

- Minor assumptions exist.
- Warnings are documented.
- Codegen can still proceed safely.

**Use `not_ready` when:**

- Route/auth/data/selector behavior is unknown.
- Required case mapping is missing.
- Plan requires product decisions.
- Codegen would likely hallucinate implementation details.

### 5. Selector and Route Confidence

Check whether the plan avoids unsupported assumptions.

Acceptable:

- Route is known from existing project files.
- Selector strategy uses accessible role/text/testid when available.
- Unknown selectors are marked as TODO and not guessed.

Not acceptable:

- Inventing `data-testid`
- Inventing route path
- Inventing button text
- Inventing auth storage state
- Inventing API setup endpoints

### 6. Existing Test Style

If `tests/e2e/**` exists, check whether the plan respects existing style:

- File naming
- Fixture naming
- Auth setup
- Page helper conventions
- pytest or Playwright style
- Incremental append instead of overwrite

### 7. Execution Requirements

If the project requires headed execution, verify the plan includes:

```bash
uv run pytest tests/e2e/ -v --headed
```

If the project uses another runner, verify the command matches the project convention.

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

- Product behavior is unclear.
- Route/auth/selector/data state is unknown.
- Test scope must be confirmed.
- Codegen would require guessing.

**Use `reject` when:**

- Plan is for the wrong feature.
- Required plan files are missing.
- Plan contradicts case files.
- Codegen would be unsafe or misleading.

---

## Risk Level Rules

Use: `low` / `medium` / `high` / `critical`

- **low**: Minor wording or formatting issues.
- **medium**: Some missing details, but codegen may continue with warnings.
- **high**: Missing route/auth/data/selector strategy. Missing core case coverage. Codegen likely to hallucinate.
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
- Add TODO markers for unknowns
- Clarify fixture reuse if known from `.aws/data-knowledge.yaml`

Not auto-fixable:

- Unknown route
- Unknown selector
- Unknown auth state
- Unknown fixture/factory
- Unknown expected UI copy
- Product behavior ambiguity
- Missing requirement scope

---

## Required JSON Format

Write valid JSON to:

```text
qa/changes/<change-id>/review/plan-review.json
```

Use this exact top-level structure:

```json
{
  "schema_version": "1.0",
  "review_type": "e2e-plan",
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
  "id": "PLAN-FINDING-001",
  "severity": "low|medium|high|critical",
  "category": "coverage|flow|data|auth|route|selector|assertion|fixture|codegen|execution|knowledge",
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
  "id": "PLAN-BLOCKER-001",
  "severity": "high|critical",
  "file": "qa/changes/<change-id>/plans/...",
  "message": "Why codegen cannot continue.",
  "required_action": "What must be clarified or fixed."
}
```

Each `auto_fix_plan` item must use:

```json
{
  "finding_id": "PLAN-FINDING-001",
  "target_file": "qa/changes/<change-id>/plans/...",
  "operation": "edit|append|normalize|add_todo|move_section",
  "description": "What the fixer should do."
}
```

---

## Summary Markdown Format

Write:

```text
qa/changes/<change-id>/review/plan-review-summary.md
```

Use this structure:

```markdown
# Plan Review Summary

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

## Final Response

After writing the files, respond with:

```
Plan review completed.

Decision: <decision>
Risk: <risk_level>
Codegen readiness: <ready|ready_with_warnings|not_ready>
Human review required: <true|false>
Auto fix allowed: <true|false>

Files:
- qa/changes/<change-id>/review/plan-review.json
- qa/changes/<change-id>/review/plan-review-summary.md
```

Do not claim the plan is ready unless `codegen_readiness` is `ready` or `ready_with_warnings`.

Do not modify plan files in this skill.
