---
name: aws-case-reviewer
description: "Review AWS QA case design artifacts and produce a structured review result. Use after aws-case-design has generated or updated QA case artifacts. Read-only: writes case-review.json and case-review-summary.md, never modifies case files."
---

# AWS Case Reviewer

## Purpose

Review AWS QA case design artifacts and produce a structured review result.

Use this skill after `aws-case-design` has generated or updated QA case artifacts.

This skill is **read-mostly**. It should review the case proposal and case YAML files, then write review outputs under the change review directory.

It must not modify `proposal.md` or case YAML files.

---

## When to Use

Use this skill when:

- A new QA case delta has been generated.
- Existing case files were modified.
- You need to verify whether case artifacts are complete, testable, and ready for API/E2E planning.
- You need a machine-readable review gate before moving to planning.

---

## Inputs

The user or orchestrator should provide:

- `change_id`

Expected input files:

```text
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
qa/changes/<change-id>/.qa.yaml
```

Optional reference files:

```text
qa/cases/**/*.yaml
.aws/data-knowledge.yaml
docs/**/*.md
```

## Outputs

Write the following files:

```text
qa/changes/<change-id>/review/case-review.json
qa/changes/<change-id>/review/case-review-summary.md
```

Create the review directory if it does not exist.

---

## Mandatory Output Contract

This skill is a **gate producer**. The workflow cannot advance past case review without the JSON file this skill writes.

- You **must** write `qa/changes/<change-id>/review/case-review.json` as valid JSON with all required fields.
- You **must** write `qa/changes/<change-id>/review/case-review-summary.md`.
- A natural language conclusion in chat is **not** a substitute for the JSON file. Never end with only a textual verdict.
- If the user said "approved" / "looks good", you must still encode that as a JSON review with `decision == "pass"` (and appropriate fields). Approval in chat does not release the gate; the JSON does.
- If you cannot write the JSON file for any reason, treat the review as **failed** and report it — the workflow must treat a missing or invalid `case-review.json` as a STOP condition.

---

## Review Scope

Review the generated case artifacts for:

- Requirement coverage
- Case clarity
- Case YAML schema consistency
- Testability
- API/E2E automation readiness
- Preconditions and test data
- Assertions
- Traceability
- Risk and ambiguity
- Duplicate or conflicting cases

---

## Review Criteria

### 1. Requirement Coverage

Check whether the cases cover the intended requirement.

Look for:

- Missing core business scenarios
- Missing positive path
- Missing negative path when relevant
- Missing permission / role scenarios when relevant
- Missing boundary conditions
- Missing regression impact
- Out-of-scope scenarios mixed into the case

If a requirement is ambiguous, do not invent product behavior. Mark it as human review required.

### 2. Case Clarity

Each case should have clear:

- `case_id`
- `title`
- `summary`
- `module`
- `requirement_id`
- `feature_name`
- `priority`
- `severity`
- `type`
- `status`
- `preconditions`
- `test_data`
- `steps`
- `assertions`
- `automation` block (see YAML structure below)

The case should be understandable by a QA engineer without reading hidden context.

### 3. YAML Structure

Check that case files are valid YAML and follow the project convention.

Cases produced by `aws-case-design` use an `automation:` block (not a flat `automation_targets:` field). Accept either form for legacy compatibility, but prefer the block form:

```yaml
schema_version: "1.0"
case_id: "TC-..."
title: "..."
status: "draft"
priority: "P1"
severity: "major"
type: "e2e"
module: "..."
requirement_id: "..."
feature_name: "..."
tags: []
summary: "..."
preconditions: []
test_data: []
steps: []
assertions: []
automation:
  required: true
  type: "e2e"
  notes: ""
trace: []
```

Do not require every project to use exactly the same fields if the existing project convention differs. Prefer consistency with nearby case files.

### 4. Testability

Flag cases that cannot be implemented because:

- Steps are too vague
- Assertions are not observable
- Preconditions are missing
- Required data state is undefined
- Auth state is unknown
- Page route is unknown
- API endpoint is unknown
- Selector or UI behavior is unknown
- Expected result is subjective or not verifiable

### 5. Automation Readiness

For E2E cases, check:

- Natural language steps are executable
- Page entry point is clear
- User role is clear
- Test data is available or constructible
- Assertions can be checked with Playwright or pytest
- No hidden manual-only step is required

For API cases, check:

- The case describes the scenario clearly (not necessarily the exact endpoint — endpoint detail belongs in the API plan, not the case)
- Preconditions and auth requirements are stated at a conceptual level
- Expected behaviour / response outcome is clear
- Test data requirements are described
- Do **not** flag a case as not automation-ready just because it omits method/path — that detail is added during API planning, not case design

### 6. Data and Preconditions

Check whether `test_data` and `preconditions` are enough.

Flag:

- Unknown fixture
- Unknown factory
- Missing cleanup strategy
- Conflicting data state
- Environment-specific assumptions
- Hardcoded production-like IDs
- Data dependencies that require manual preparation

### 7. Assertions

Assertions should be specific and observable.

Good assertions:

- Response status equals expected value
- Response body contains expected field/value
- UI displays expected text/state
- Database or state transition is verifiable if project supports it

Bad assertions:

- "System works correctly"
- "Page should be normal"
- "User experience is good"
- "No bug appears"

### 8. Traceability

Check whether the case links back to:

- Requirement ID
- Feature name
- Module
- Source document or user request if available
- Related existing case if modified

---

## Decision Rules

Return one of these decisions:

- `pass`
- `needs_fix`
- `needs_human_review`
- `reject`

**Use `pass` when:**

- Case artifacts are complete enough.
- No blocker exists.
- Planning/codegen can continue safely.

**Use `needs_fix` when:**

- Issues are clear and can be automatically fixed.
- No product decision is required.
- No high-risk ambiguity exists.

**Use `needs_human_review` when:**

- Product behavior is ambiguous.
- Test scope needs confirmation.
- Auth/role/data behavior is unknown.
- A missing requirement cannot be inferred from files.
- Risk level is high or critical.

**Use `reject` when:**

- Case artifacts are fundamentally wrong.
- The cases test the wrong feature.
- Required files are missing.
- YAML is invalid and cannot be safely repaired.
- Generated cases conflict with explicit requirement.

---

## Risk Level Rules

Use: `low` / `medium` / `high` / `critical`

- **low**: Minor clarity or formatting issues.
- **medium**: Missing optional edge case. Some assertions could be stronger. Minor data setup uncertainty.
- **high**: Missing core scenario. Product behavior ambiguous. Auth/role/data setup unknown. Codegen likely to generate invalid tests.
- **critical**: Wrong feature. Invalid or missing required files. Case contradicts requirement. Dangerous destructive behavior is proposed.

---

## Auto Fix Rules

Set `auto_fix_allowed = true` only when all fixable findings can be applied mechanically.

Examples of auto-fixable findings:

- Missing tag
- Inconsistent status value
- Weak but obvious wording improvement
- Missing trace field when source is known
- YAML formatting issue
- Duplicate title that can be renamed safely
- Missing assertion that is directly implied by a step

Set `human_review_required = true` when:

- Product behavior must be decided
- Unknown route/auth/role/data must be confirmed
- Test scope is disputed
- A requirement interpretation is uncertain
- The fix would require inventing business behavior

---

## Required JSON Format

Write valid JSON to:

```text
qa/changes/<change-id>/review/case-review.json
```

Use this exact top-level structure:

```json
{
  "schema_version": "1.0",
  "review_type": "case",
  "change_id": "<change-id>",
  "decision": "pass",
  "risk_level": "low",
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
  "id": "CASE-FINDING-001",
  "severity": "low|medium|high|critical",
  "category": "coverage|schema|clarity|testability|data|assertion|traceability|scope|duplication",
  "file": "qa/changes/<change-id>/cases/...",
  "message": "What is wrong.",
  "suggestion": "How to fix it.",
  "auto_fix_allowed": true,
  "human_review_required": false
}
```

Each blocker must use:

```json
{
  "id": "CASE-BLOCKER-001",
  "severity": "high|critical",
  "file": "qa/changes/<change-id>/...",
  "message": "Why the workflow cannot continue.",
  "required_action": "What a human or previous step must do."
}
```

Each `auto_fix_plan` item must use:

```json
{
  "finding_id": "CASE-FINDING-001",
  "target_file": "qa/changes/<change-id>/...",
  "operation": "edit|append|normalize|rename",
  "description": "What the fixer should do."
}
```

---

## Summary Markdown Format

Write a human-readable summary to:

```text
qa/changes/<change-id>/review/case-review-summary.md
```

Use this structure:

```markdown
# Case Review Summary

## Decision

- Decision:
- Risk:
- Auto Fix Allowed:
- Human Review Required:

## Summary

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
Case review completed.

Decision: <decision>
Risk: <risk_level>
Human review required: <true|false>
Auto fix allowed: <true|false>

Files:
- qa/changes/<change-id>/review/case-review.json
- qa/changes/<change-id>/review/case-review-summary.md
```

Do not claim the review passed unless `decision = pass`.

Do not modify case files in this skill.
