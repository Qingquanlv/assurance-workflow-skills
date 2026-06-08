---
name: aws-case-fixer
description: "Apply safe, automatic fixes to AWS case artifacts based on case-review.json. Use after aws-case-reviewer returns decision=needs_fix with auto_fix_allowed=true and human_review_required=false. Never invents product behavior."
---

# AWS Case Fixer

## Purpose

Apply safe, automatic fixes to AWS case artifacts based on `case-review.json`.

Use this skill after `aws-case-reviewer` returns:

```text
decision = needs_fix
auto_fix_allowed = true
human_review_required = false
```

This skill must only apply safe, mechanical fixes. It must not invent product behavior.

---

## When to Use

Use this skill when:

- `case-review.json` exists.
- Review findings are auto-fixable.
- No human review is required.
- The orchestrator wants to apply case review suggestions before re-running case review.

---

## Inputs

Required:

```text
qa/changes/<change-id>/review/case-review.json
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
```

Optional:

```text
qa/changes/<change-id>/.qa.yaml
qa/cases/**/*.yaml
.aws/data-knowledge.yaml
```

## Outputs

Update only the allowed files:

```text
qa/changes/<change-id>/proposal.md
qa/changes/<change-id>/cases/**/*.yaml
```

Write an apply summary:

```text
qa/changes/<change-id>/review/case-review-apply-summary.md
```

Do not edit:

```text
qa/changes/<change-id>/review/case-review.json
qa/changes/<change-id>/review/case-review-summary.md
qa/changes/<change-id>/plans/**
tests/**
```

The orchestrator may delete or regenerate `case-review.json` after this skill completes.

---

## Gate Boundaries

This fixer must never bypass the reviewer. It is **not** a gate producer.

- Only apply findings where `auto_fix_allowed == true` and `human_review_required == false`.
- **Never** write or modify `case-review.json` or any review JSON file.
- **Never** set or change `decision` to `pass` — the fixer has no authority to pass the gate.
- After applying fixes, you **must** request a fresh run of `aws-case-reviewer`. The workflow only continues when a **new** `case-review.json` has `decision == "pass"`.
- A fixer's claim that it "fixed everything" does not release the gate. Only the reviewer's new JSON does.

---

## Allowed Fixes

You may apply fixes for findings where:

- `auto_fix_allowed = true`
- `human_review_required = false`
- `severity` in `["low", "medium"]`

You may also apply `high` severity findings only if the review explicitly marks them as mechanical and safe.

Allowed operations:

- Normalize YAML formatting
- Add missing non-controversial metadata
- Add or normalize tags
- Normalize `status` / `priority` / `severity` values
- Improve wording clarity
- Remove duplicate wording
- Add trace fields when source is explicit
- Split overly long steps into clear smaller steps
- Strengthen assertions when the expected result is explicitly stated
- Add missing cleanup note if the cleanup method is already known

---

## Forbidden Fixes

Do not apply fixes that require guessing:

- Product behavior
- User role permission
- API endpoint
- Page route
- UI selector
- Auth mechanism
- Data factory
- Business state transition
- Expected response body
- Database side effects
- Error message text
- Internationalization copy
- Environment-specific values

Do not create new scenarios that were not requested.

Do not delete cases unless the review explicitly marks them as duplicate and auto-fixable.

Do not overwrite existing case files wholesale. Prefer minimal diffs.

---

## Fix Strategy

1. Read `case-review.json`.
2. Validate it is for `review_type = case`.
3. Check gate fields:
   - If `decision = reject`, stop.
   - If `human_review_required = true`, stop.
   - If `auto_fix_allowed = false`, stop.
4. Collect fixable findings.
5. Apply minimal edits to target files.
6. Preserve existing style and ordering where possible.
7. Write `case-review-apply-summary.md`.
8. Tell the orchestrator to re-run `aws-case-reviewer`.

---

## Apply Summary Format

Write:

```text
qa/changes/<change-id>/review/case-review-apply-summary.md
```

Use this structure:

```markdown
# Case Review Apply Summary

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

## Next Step

Re-run `aws-case-reviewer`.
```

---

## Final Response

After applying fixes, respond with:

```
Case review fixes applied.

Modified files:
- ...

Skipped findings:
- ...

Next step:
Re-run aws-case-reviewer.
```

If no fixes were applied, say so clearly and explain why.

Do not claim the case review passed. Only the reviewer can pass the gate.
