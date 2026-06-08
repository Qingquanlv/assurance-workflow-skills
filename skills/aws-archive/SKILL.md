---
name: aws-archive
description: Use after aws-case-reviewer passes (decision=pass). Merges case delta into qa/cases/<module>/case.yaml, confirms test code exists in tests/, archives process artifacts to qa/archive/<change-id>/. Requires decision=pass in case-review.json.
---

## Purpose

Complete the change cycle: merge primary assets and archive process artifacts.

## When to Use

- After `aws-case-reviewer` writes `case-review.json` with `decision: pass`
- User says "archive change `<change-id>`"
- User says "merge and close this change"

## Pre-condition

ALL of these must be true before archiving:

- `qa/changes/<change-id>/review/case-review.json` exists and `decision: pass`
- If `qa/changes/<change-id>/plans/api-plan.md` exists → `review/api-plan-review.json` must also exist and `decision: pass`
- If `qa/changes/<change-id>/plans/e2e-plan.md` exists → `review/plan-review.json` must also exist and `decision: pass`
- `qa/changes/<change-id>/cases/<module>/case.yaml` exists (the case delta)
- `qa/cases/<module>/case.yaml` is writable (the stable main asset)

If any required review JSON is missing, is invalid JSON, or `decision` is not `pass`: **STOP**. Do not archive.

**Pragmatic archive without review JSON is forbidden.** Never archive based on natural language approval, an agent's judgment, or "the tests look done". The only authority to archive is a present, valid review JSON with `decision == "pass"` for every applicable gate (case, and API/E2E plan when the corresponding plan file exists).

## Output

After archiving:

```
qa/cases/<module>/case.yaml       ← merged with case delta (ADDED / MODIFIED / REMOVED)
tests/api/**                      ← retained as-is (primary asset)
tests/e2e/**                      ← retained as-is (primary asset)
qa/archive/<change-id>/           ← all process artifacts
qa/archive/<change-id>/archive-summary.md
```

## Process

### Step 1: Check Review Gate

**1a. Check case-review.json**

Read `qa/changes/<change-id>/review/case-review.json`.

If missing or invalid JSON → **STOP**.

If `decision != "pass"` → **STOP** immediately. Do not proceed.

**1b. Check API plan review (if API plan exists)**

If `qa/changes/<change-id>/plans/api-plan.md` exists:

- Read `qa/changes/<change-id>/review/api-plan-review.json`.
- If missing or invalid → **STOP**.
- If `decision != "pass"` → **STOP**. API plan review must pass before archiving.

**1c. Check E2E plan review (if E2E plan exists)**

If `qa/changes/<change-id>/plans/e2e-plan.md` exists:

- Read `qa/changes/<change-id>/review/plan-review.json`.
- If missing or invalid → **STOP**.
- If `decision != "pass"` → **STOP**. E2E plan review must pass before archiving.

### Step 2: Merge Case Delta

Source delta file:

```
qa/changes/<change-id>/cases/<module>/case.yaml
```

Target stable file:

```
qa/cases/<module>/case.yaml
```

For each case in the delta:

- **ADDED**: append new case to target file. Verify `case_id` does NOT already exist.
- **MODIFIED**: find matching `case_id` in target and replace the entire case block.
- **REMOVED**: find matching `case_id` in target and delete the entire case block.

After merge: verify no duplicate `case_id` values, no orphaned `related_cases` references.

If `qa/cases/<module>/case.yaml` does not exist yet, create it with the added cases.

### Step 3: Confirm Test Code

Verify that test files referenced in `api-codegen-plan.md` and `e2e-codegen-plan.md` exist under `tests/api/` and `tests/e2e/`.

- For each `tests/api/test_*.py` referenced in `api-codegen-plan.md`: verify the file exists.
- For each `tests/e2e/test_*.py` referenced in `e2e-codegen-plan.md`: verify the file exists.

If required test files are missing: **STOP**. Test code must exist before archiving.

### Step 3a: Check Known Product Issues

Before writing the archive summary, check for known product issue files:

```text
qa/changes/<change-id>/execution/known-product-issues.md
qa/changes/<change-id>/inspect/known-product-issues.md
qa/changes/<change-id>/inspect/failure-analysis.json
```

If any of these files exist:

- Archive is still allowed, provided all review gates pass and tests pass or pass_with_known_issues.
- Archive summary **must** use `archive_status: archived_with_known_issues`.
- Do **not** write `clean`, `no risk`, or `fully passed without issues` anywhere in the archive summary.

### Step 3b: Record Execution Status

Check whether execution summaries exist:

- `qa/changes/<change-id>/execution/api-summary.md` (if API tests were generated)
- `qa/changes/<change-id>/execution/e2e-summary.md` (if E2E tests were generated)
- `qa/changes/<change-id>/execution/api-result.json`
- `qa/changes/<change-id>/execution/e2e-result.json`

**Do not block the archive if execution failed** — tests may have been skipped or failed due to environment issues. Instead, record the execution status in `archive-summary.md` (see Step 5).

If execution result files exist: copy them into the archive (already covered by Step 4).
If execution result files are missing: note that execution was not performed.

### Step 4: Archive Process Artifacts

Copy (do not move) the following to `qa/archive/<change-id>/`:

| Source | Destination |
|--------|-------------|
| `qa/changes/<change-id>/plans/` | `qa/archive/<change-id>/plans/` |
| `qa/changes/<change-id>/review/` | `qa/archive/<change-id>/review/` |
| `qa/changes/<change-id>/execution/` | `qa/archive/<change-id>/execution/` |
| `qa/changes/<change-id>/execution/` | `qa/archive/<change-id>/execution/` |
| `qa/changes/<change-id>/trace/` | `qa/archive/<change-id>/trace/` |
| `qa/changes/<change-id>/proposal.md` | `qa/archive/<change-id>/proposal.md` |
| `qa/changes/<change-id>/.qa.yaml` | `qa/archive/<change-id>/.qa.yaml` |

Do **not** delete `qa/changes/<change-id>/` after archiving. The change directory is preserved as a reference. Deletion, if desired, must be performed manually by a human.

### Step 5: Write Archive Summary

Write to: `qa/archive/<change-id>/archive-summary.md`

Must include:

- `change_id`
- Cases added / modified / removed (count + IDs)
- Target case file: `qa/cases/<module>/case.yaml`
- Test files created or updated
- `case-review.json` decision and risk level
- API plan review decision and risk level (if applicable, from `api-plan-review.json`)
- E2E plan review decision and risk level (if applicable, from `plan-review.json`)
- Execution status section:
  - API execution: `passed | passed_with_known_issues | failed | skipped | not_run` + counts
  - E2E execution: `passed | passed_with_known_issues | failed | skipped | not_run` + counts
  - Note: execution failures do not block archive but must be recorded here
- Archive status: `archived` | `archived_with_known_issues`
- Known product issues section (if applicable):

```yaml
archive_status: archived_with_known_issues
known_product_issues:
  - id: KPI-001
    endpoint: GET /api/v1/menu/get
    severity: major
    status: open
    workaround: validated through GET /api/v1/menu/list
    coverage_gap: direct GET /api/v1/menu/get remains open
    follow_up: fix backend serialization in get_menu
```

## What NEVER Gets Merged Into qa/cases/

- Plan files (`plans/*.md`) — process artifacts
- Review files (`review/*.json`, `review/*.md`) — process artifacts
- Execution results (`execution/*.json`) — historical records
- `proposal.md` — process asset

## File Path Reference

| Old (do not use) | Correct |
|---|---|
| `qa/changes/<id>/case-delta/` | `qa/changes/<id>/cases/<module>/case.yaml` |
| `qa/cases/<module>.md` | `qa/cases/<module>/case.yaml` |
| `case.review.yaml` | `review/case-review.json` |
| `code.review.yaml` | `review/plan-review.json` |
| `execution.review.yaml` | `execution/e2e-result.json` or `execution/api-result.json` |

## Red Flags

| Thought | Reality |
|---------|---------|
| "I'll merge plan files into qa/cases/" | Plans are NEVER merged into cases. |
| "I'll archive without checking case-review.json" | Case review gate is mandatory — must be `decision: pass`. |
| "User approved in chat, I'll archive without the JSON" | Pragmatic archive without review JSON is forbidden. Only a valid `decision: pass` JSON releases the gate. |
| "Tests failed so I'll skip archiving" | Execution failures do not block archive. Record status in archive-summary.md and proceed. |
| "API plan review is not pass but I'll archive anyway" | API/E2E plan reviews must also pass if the corresponding plan files exist. |
| "The test code is already there, skip step 3" | Confirm explicitly — step 3 is a safety check. |
| "I'll skip the archive summary" | Archive summary is the audit trail. |
| "Tests passed so archive is clean" | If `known-product-issues.md` exists, archive must use `archived_with_known_issues`. Clean archive with unresolved known product issues is forbidden. |
| "I'll write to qa/cases/<module>.md" | Cases are YAML, not Markdown: `qa/cases/<module>/case.yaml`. |

## Post-Archive State

Change cycle is complete:

- `qa/cases/<module>/case.yaml` reflects new/modified/removed cases
- `tests/` contains test code (primary assets)
- `qa/archive/<change-id>/` holds all process artifacts for audit
- `qa/changes/<change-id>/` is preserved (not deleted — manual cleanup only)
