---
name: aws-plan-fixer
description: "Apply safe, automatic fixes to AWS E2E plan artifacts based on plan-review.json. Use after aws-plan-reviewer returns decision=needs_fix with auto_fix_allowed=true and human_review_required=false. Never invents routes, selectors, auth, or data factories."
---

# AWS Plan Fixer

## Purpose

Apply safe, automatic fixes to AWS E2E plan artifacts based on `plan-review.json`.

Use this skill after `aws-plan-reviewer` returns:

```text
decision = needs_fix
auto_fix_allowed = true
human_review_required = false
```

This skill must only apply safe, mechanical plan fixes. It must not invent unknown product behavior, routes, auth, selectors, or data factories.

---

## When to Use

Use this skill when:

- `plan-review.json` exists.
- The plan reviewer found auto-fixable issues.
- No human review is required.
- The orchestrator wants to re-run plan review after applying fixes.

---

## Inputs

Required:

```text
qa/changes/<change-id>/review/plan-review.json
qa/changes/<change-id>/plans/e2e-plan.md
qa/changes/<change-id>/plans/e2e-test-data-plan.md
qa/changes/<change-id>/plans/e2e-codegen-plan.md
qa/changes/<change-id>/plans/m4-review-summary.md
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

Update only allowed plan files:

```text
qa/changes/<change-id>/plans/*.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml
```

Write:

```text
qa/changes/<change-id>/review/plan-review-apply-summary.md
```

Do not edit:

```text
qa/changes/<change-id>/review/plan-review.json
qa/changes/<change-id>/review/plan-review-summary.md
tests/**
qa/changes/<change-id>/cases/**
qa/changes/<change-id>/proposal.md
.aws/data-knowledge.yaml
```

Do not directly update `.aws/data-knowledge.yaml`. Only propose updates in `data-knowledge.proposal.yaml`.

---

## Allowed Fixes

You may apply fixes for findings where:

- `auto_fix_allowed = true`
- `human_review_required = false`
- `severity` in `["low", "medium"]`

Allowed operations:

- Add missing case references already present in case YAML
- Normalize headings and section structure
- Move misplaced content into the correct plan file
- Add known assertions from case YAML
- Add known preconditions from case YAML
- Add known execution command
- Add TODO markers for unknown route/auth/selector/data
- Add missing cleanup note if cleanup method is already known
- Clarify fixture reuse if present in `.aws/data-knowledge.yaml`
- Add codegen constraints such as "append only, do not overwrite existing tests"

---

## Forbidden Fixes

Do not invent:

- Route path
- UI selector
- `data-testid`
- Button text
- Page title
- Auth mechanism
- Test credential
- Fixture name
- Factory name
- API endpoint
- Request/response schema
- Business state transition
- Cleanup endpoint
- Product behavior

Do not change:

- `codegen_readiness`
- Review decision fields
- Reviewer JSON
- Approved case content
- Source requirement interpretation

Do not hide unknowns. If something is unknown, make it explicit in the plan as a TODO or human review item.

---

## Fix Strategy

1. Read `plan-review.json`.
2. Validate it is for `review_type = plan`.
3. Check gate fields:
   - If `decision = reject`, stop.
   - If `human_review_required = true`, stop.
   - If `auto_fix_allowed = false`, stop.
4. Collect fixable findings.
5. Apply minimal edits to target plan files.
6. Preserve existing style and ordering.
7. Add unknowns to the appropriate "Open Questions", "TODO", or `data-knowledge.proposal.yaml` section.
8. Write `plan-review-apply-summary.md`.
9. Tell the orchestrator to re-run `aws-plan-reviewer`.

---

## File-Specific Rules

### `e2e-plan.md`

May update:

- Scenario mapping
- Step clarity
- Assertion mapping
- Flow ordering
- Known route notes
- Explicit TODOs for unknown route/selector/auth

Do not invent executable details.

### `e2e-test-data-plan.md`

May update:

- Entity list
- Known states from case YAML
- Known fixture reuse
- Cleanup notes
- TODOs for unknown factories/states

Do not invent factories or cleanup endpoints.

### `e2e-codegen-plan.md`

May update:

- File target
- Append-only rule
- Existing test style notes
- Required command
- Codegen constraints
- TODOs that codegen must not guess

### `m4-review-summary.md`

May update:

- Summary of remaining risks
- Codegen readiness notes
- Human review notes

### `data-knowledge.proposal.yaml`

May append proposed knowledge entries.

Do not promote proposals into `.aws/data-knowledge.yaml`.

---

## Apply Summary Format

Write:

```text
qa/changes/<change-id>/review/plan-review-apply-summary.md
```

Use this structure:

```markdown
# Plan Review Apply Summary

## Change ID

<change-id>

## Applied Fixes

| Finding ID | File | Operation | Summary |
|---|---|---|---|

## Skipped Findings

| Finding ID | Reason |
|---|---|

## Files Modified

- ...

## Remaining Unknowns

- ...

## Next Step

Re-run `aws-plan-reviewer`.
```

---

## Final Response

After applying fixes, respond with:

```
Plan review fixes applied.

Modified files:
- ...

Skipped findings:
- ...

Remaining unknowns:
- ...

Next step:
Re-run aws-plan-reviewer.
```

If no fixes were applied, say so clearly and explain why.

Do not claim the plan review passed. Only the reviewer can pass the gate.
