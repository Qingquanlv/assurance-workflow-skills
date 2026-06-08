---
name: aws-api-plan-fixer
description: "Apply safe, automatic fixes to AWS API plan artifacts based on api-plan-review.json. Use after aws-api-plan-reviewer returns decision=needs_fix with auto_fix_allowed=true and human_review_required=false. Never invents endpoints, auth, fixtures, or expected response schema."
---

# AWS API Plan Fixer

## Purpose

Apply safe, automatic fixes to AWS API plan artifacts based on `api-plan-review.json`.

Use this skill after `aws-api-plan-reviewer` returns:

```text
decision = needs_fix
auto_fix_allowed = true
human_review_required = false
```

This skill must only apply safe, mechanical plan fixes. It must not invent unknown endpoints, auth mechanisms, request/response schema, or data factories.

---

## When to Use

Use this skill when:

- `api-plan-review.json` exists.
- The API plan reviewer found auto-fixable issues.
- No human review is required.
- The orchestrator wants to re-run API plan review after applying fixes.

---

## Inputs

Required:

```text
qa/changes/<change-id>/review/api-plan-review.json
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

Update only allowed plan files:

```text
qa/changes/<change-id>/plans/api-plan.md
qa/changes/<change-id>/plans/api-test-data-plan.md
qa/changes/<change-id>/plans/api-codegen-plan.md
qa/changes/<change-id>/plans/m3-review-summary.md
qa/changes/<change-id>/plans/data-knowledge.proposal.yaml
```

Write:

```text
qa/changes/<change-id>/review/api-plan-review-apply-summary.md
```

Do not edit:

```text
qa/changes/<change-id>/review/api-plan-review.json
qa/changes/<change-id>/review/api-plan-review-summary.md
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
- Add TODO markers for unknown endpoint/auth/data
- Add missing cleanup note if cleanup method is already known
- Clarify fixture reuse if present in `.aws/data-knowledge.yaml`
- Add codegen constraints such as "append only, do not overwrite existing tests"

---

## Forbidden Fixes

Do not invent:

- HTTP method or endpoint path
- Auth mechanism or token format
- Request body schema
- Expected response body or status code
- Fixture or factory name
- Data setup or cleanup endpoint
- Business state transition
- Product behavior

Do not hide unknowns. If something is unknown, make it explicit in the plan as a TODO or human review item.

---

## Fix Strategy

1. Read `api-plan-review.json`.
2. Validate it is for `review_type = api-plan`.
3. Check gate fields:
   - If `decision = reject`, stop.
   - If `human_review_required = true`, stop.
   - If `auto_fix_allowed = false`, stop.
4. Collect fixable findings.
5. Apply minimal edits to target plan files.
6. Preserve existing style and ordering.
7. Add unknowns to the appropriate "Open Questions", "TODO", or `data-knowledge.proposal.yaml` section.
8. Write `api-plan-review-apply-summary.md`.
9. Tell the orchestrator to re-run `aws-api-plan-reviewer`.

---

## Apply Summary Format

Write:

```text
qa/changes/<change-id>/review/api-plan-review-apply-summary.md
```

```markdown
# API Plan Review Apply Summary

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

Re-run `aws-api-plan-reviewer`.
```

---

## Final Response

After applying fixes, respond with:

```
API plan review fixes applied.

Modified files:
- ...

Skipped findings:
- ...

Remaining unknowns:
- ...

Next step:
Re-run aws-api-plan-reviewer.
```

If no fixes were applied, say so clearly and explain why.

Do not claim the API plan review passed. Only the reviewer can pass the gate.
